import { useEffect, useMemo, useRef, useState } from 'react';
import { drawGraph, findCurveIntersections, screenToWorld } from './graph';
import { compileEquation } from './math';
import type { EquationItem, GraphConfig, Theme, Viewport } from './types';

const STORAGE_KEY = 'graphr.state.v1';
const lineColors = ['#3b82f6', '#ef4444', '#f59e0b', '#22c55e', '#a855f7', '#14b8a6'];

const defaultViewport: Viewport = {
  xMin: -10,
  xMax: 10,
  yMin: -10,
  yMax: 10
};

const defaultConfig: GraphConfig = {
  showGrid: true,
  showMinorGrid: true,
  showAxes: true,
  showLegend: true,
  exportIntersectionLabels: false,
  xLabel: 'x',
  yLabel: 'y',
  xMajorStep: 1,
  xMinorStep: 0.5,
  yMajorStep: 1,
  yMinorStep: 0.5
};

interface PersistedState {
  theme: Theme;
  equations: EquationItem[];
  viewport: Viewport;
  config: GraphConfig;
}

interface HoverPoint {
  screenX: number;
  screenY: number;
  worldX: number;
  worldY: number;
  source: string;
}

interface IntersectionPoint {
  x: number;
  y: number;
  source: string;
}

interface CompiledEquation {
  item: EquationItem;
  evaluate: (x: number) => number;
}

const INTERSECTION_SNAP_DISTANCE_PX = 24;

function makeEquation(index: number): EquationItem {
  return {
    id: crypto.randomUUID(),
    expression: index === 0 ? 'sin(x)' : '',
    label: index === 0 ? 'Sine' : '',
    color: lineColors[index % lineColors.length],
    visible: true
  };
}

function clampViewport(viewport: Viewport): Viewport {
  const minSpan = 0.05;
  const xSpan = Math.max(minSpan, viewport.xMax - viewport.xMin);
  const ySpan = Math.max(minSpan, viewport.yMax - viewport.yMin);

  const xCenter = (viewport.xMax + viewport.xMin) / 2;
  const yCenter = (viewport.yMax + viewport.yMin) / 2;

  return {
    xMin: xCenter - xSpan / 2,
    xMax: xCenter + xSpan / 2,
    yMin: yCenter - ySpan / 2,
    yMax: yCenter + ySpan / 2
  };
}

function worldToScreenX(canvas: HTMLCanvasElement, x: number, viewport: Viewport): number {
  const spanX = Math.max(1e-9, viewport.xMax - viewport.xMin);
  return ((x - viewport.xMin) / spanX) * canvas.clientWidth;
}

function worldToScreenY(canvas: HTMLCanvasElement, y: number, viewport: Viewport): number {
  const spanY = Math.max(1e-9, viewport.yMax - viewport.yMin);
  return ((viewport.yMax - y) / spanY) * canvas.clientHeight;
}

function findRootByBisection(
  evaluate: (x: number) => number,
  left: number,
  right: number
): number | null {
  let a = left;
  let b = right;
  let fa = evaluate(a);
  let fb = evaluate(b);

  if (!Number.isFinite(fa) || !Number.isFinite(fb) || fa * fb > 0) {
    return null;
  }

  for (let i = 0; i < 20; i += 1) {
    const mid = (a + b) / 2;
    const fm = evaluate(mid);
    if (!Number.isFinite(fm)) {
      return null;
    }
    if (Math.abs(fm) < 1e-8) {
      return mid;
    }
    if (fa * fm <= 0) {
      b = mid;
      fb = fm;
    } else {
      a = mid;
      fa = fm;
    }
  }

  return (a + b) / 2;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function toString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function getNiceStep(range: number, targetTicks: number): number {
  const safeRange = Math.max(1e-9, range);
  const roughStep = safeRange / Math.max(2, targetTicks);
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  let nice = 10;
  if (normalized <= 1) {
    nice = 1;
  } else if (normalized <= 2) {
    nice = 2;
  } else if (normalized <= 5) {
    nice = 5;
  }
  return nice * magnitude;
}

function findRootsInRange(
  evaluate: (x: number) => number,
  xMin: number,
  xMax: number,
  segments: number
): number[] {
  const roots: number[] = [];
  const count = Math.max(24, segments);
  const step = (xMax - xMin) / count;
  const tolerance = Math.max(1e-6, step * 0.5);

  for (let i = 0; i < count; i += 1) {
    const left = xMin + i * step;
    const right = xMin + (i + 1) * step;
    const fLeft = evaluate(left);
    const fRight = evaluate(right);

    if (!Number.isFinite(fLeft) || !Number.isFinite(fRight)) {
      continue;
    }

    let root: number | null = null;
    if (Math.abs(fLeft) < 1e-8) {
      root = left;
    } else if (fLeft * fRight < 0) {
      root = findRootByBisection(evaluate, left, right);
    }

    if (root === null || !Number.isFinite(root)) {
      continue;
    }

    const exists = roots.some((value) => Math.abs(value - root) < tolerance);
    if (!exists) {
      roots.push(root);
    }
  }

  return roots;
}

function pickClosestToZero(values: number[], limit: number): number[] {
  return [...values]
    .sort((a, b) => Math.abs(a) - Math.abs(b))
    .slice(0, Math.max(0, limit))
    .sort((a, b) => a - b);
}

function roundToNearestStep(value: number, step: number): number {
  const safeStep = Math.max(1e-9, step);
  return Math.round(value / safeStep) * safeStep;
}

function loadPersistedState(): PersistedState | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return null;
    }

    const theme: Theme = parsed.theme === 'light' ? 'light' : 'dark';

    const parsedViewport = isRecord(parsed.viewport) ? parsed.viewport : {};
    const viewport: Viewport = clampViewport({
      xMin: toNumber(parsedViewport.xMin, defaultViewport.xMin),
      xMax: toNumber(parsedViewport.xMax, defaultViewport.xMax),
      yMin: toNumber(parsedViewport.yMin, defaultViewport.yMin),
      yMax: toNumber(parsedViewport.yMax, defaultViewport.yMax)
    });

    const parsedConfig = isRecord(parsed.config) ? parsed.config : {};
    const legacyMajor = Math.max(0.05, toNumber(parsedConfig.majorStep, defaultConfig.xMajorStep));
    const legacyMinor = Math.max(0.01, toNumber(parsedConfig.minorStep, defaultConfig.xMinorStep));
    const config: GraphConfig = {
      showGrid: toBoolean(parsedConfig.showGrid, defaultConfig.showGrid),
      showMinorGrid: toBoolean(parsedConfig.showMinorGrid, defaultConfig.showMinorGrid),
      showAxes: toBoolean(parsedConfig.showAxes, defaultConfig.showAxes),
      showLegend: toBoolean(parsedConfig.showLegend, defaultConfig.showLegend),
      exportIntersectionLabels: toBoolean(
        parsedConfig.exportIntersectionLabels,
        defaultConfig.exportIntersectionLabels
      ),
      xLabel: toString(parsedConfig.xLabel, defaultConfig.xLabel),
      yLabel: toString(parsedConfig.yLabel, defaultConfig.yLabel),
      xMajorStep: Math.max(0.05, toNumber(parsedConfig.xMajorStep, legacyMajor)),
      xMinorStep: Math.max(0.01, toNumber(parsedConfig.xMinorStep, legacyMinor)),
      yMajorStep: Math.max(0.05, toNumber(parsedConfig.yMajorStep, legacyMajor)),
      yMinorStep: Math.max(0.01, toNumber(parsedConfig.yMinorStep, legacyMinor))
    };

    const equations = Array.isArray(parsed.equations)
      ? parsed.equations
          .filter(isRecord)
          .map((item, index): EquationItem => {
            const fallback = makeEquation(index);
            return {
              id: toString(item.id, fallback.id),
              expression: toString(item.expression, fallback.expression),
              label: toString(item.label, fallback.label),
              color: toString(item.color, fallback.color),
              visible: toBoolean(item.visible, fallback.visible)
            };
          })
      : [];

    return {
      theme,
      equations: equations.length > 0 ? equations : [makeEquation(0)],
      viewport,
      config
    };
  } catch {
    return null;
  }
}

export default function App() {
  const [initialState] = useState(() => loadPersistedState());
  const [theme, setTheme] = useState<Theme>(() => initialState?.theme ?? 'dark');
  const [equations, setEquations] = useState<EquationItem[]>(() => initialState?.equations ?? [makeEquation(0)]);
  const [viewport, setViewport] = useState<Viewport>(() => initialState?.viewport ?? defaultViewport);
  const [config, setConfig] = useState<GraphConfig>(() => initialState?.config ?? defaultConfig);
  const [errors, setErrors] = useState<string[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [hoverPoint, setHoverPoint] = useState<HoverPoint | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<null | { x: number; y: number; viewport: Viewport }>(null);
  const pinchRef = useRef<
    | null
    | {
        distance: number;
        centerX: number;
        centerY: number;
        viewport: Viewport;
      }
  >(null);

  const rootClass = useMemo(() => `app theme-${theme}`, [theme]);
  const compiledEquations = useMemo<CompiledEquation[]>(
    () =>
      equations
        .filter((item) => item.visible && item.expression.trim())
        .flatMap((item) => {
          try {
            return [{ item, evaluate: compileEquation(item.expression) }];
          } catch {
            return [];
          }
        }),
    [equations]
  );
  const hoverIntersections = useMemo<IntersectionPoint[]>(() => {
    const points: IntersectionPoint[] = [];
    const xTol = Math.max(1e-8, (viewport.xMax - viewport.xMin) / 500);
    const yTol = Math.max(1e-8, (viewport.yMax - viewport.yMin) / 500);

    const addPoint = (x: number, y: number, source: string) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return;
      }
      if (x < viewport.xMin || x > viewport.xMax || y < viewport.yMin || y > viewport.yMax) {
        return;
      }
      const exists = points.some((item) => Math.abs(item.x - x) <= xTol && Math.abs(item.y - y) <= yTol);
      if (!exists) {
        points.push({ x, y, source });
      }
    };

    findCurveIntersections(equations, viewport, 1800).forEach((item) => {
      addPoint(item.x, item.y, item.label);
    });

    const rootSegments = Math.max(500, Math.floor(Math.abs(viewport.xMax - viewport.xMin) * 80));
    compiledEquations.forEach(({ item, evaluate }) => {
      const curveName = item.label || item.expression;
      const xRoots = findRootsInRange(evaluate, viewport.xMin, viewport.xMax, rootSegments);
      xRoots.forEach((x) => addPoint(x, 0, `${curveName} ∩ x-axis`));

      const yIntercept = evaluate(0);
      if (Number.isFinite(yIntercept)) {
        addPoint(0, yIntercept, `${curveName} ∩ y-axis`);
      }
    });

    return points;
  }, [equations, compiledEquations, viewport]);

  useEffect(() => {
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  useEffect(() => {
    const payload: PersistedState = {
      theme,
      equations,
      viewport,
      config
    };

    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore persistence failures (private mode/storage limits).
    }
  }, [theme, equations, viewport, config]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const render = () => {
      const nextErrors = drawGraph({
        canvas,
        equations,
        viewport,
        config,
        theme
      });
      setErrors(nextErrors);
    };

    render();

    const observer = new ResizeObserver(render);
    observer.observe(canvas);

    return () => observer.disconnect();
  }, [equations, viewport, config, theme]);

  const addEquation = () => {
    setEquations((current) => [...current, makeEquation(current.length)]);
  };

  const updateEquation = (id: string, patch: Partial<EquationItem>) => {
    setEquations((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const removeEquation = (id: string) => {
    setEquations((current) => current.filter((item) => item.id !== id));
  };

  const resetView = () => {
    if (!compiledEquations.length) {
      setViewport(defaultViewport);
      setConfig((current) => ({
        ...current,
        xMajorStep: defaultConfig.xMajorStep,
        xMinorStep: defaultConfig.xMinorStep,
        yMajorStep: defaultConfig.yMajorStep,
        yMinorStep: defaultConfig.yMinorStep
      }));
      return;
    }

    const currentSpanX = Math.max(10, Math.abs(viewport.xMax - viewport.xMin));
    const searchSpanX = Math.min(80, Math.max(24, currentSpanX * 2));
    const searchViewport: Viewport = {
      xMin: -searchSpanX / 2,
      xMax: searchSpanX / 2,
      yMin: -searchSpanX / 2,
      yMax: searchSpanX / 2
    };

    const points: Array<{ x: number; y: number }> = [];
    const intersections = findCurveIntersections(equations, searchViewport, 2200)
      .sort((a, b) => Math.abs(a.x) - Math.abs(b.x))
      .slice(0, 24);
    intersections.forEach((point) => {
      points.push({ x: point.x, y: point.y });
    });

    const rootSegments = 1200;
    compiledEquations.forEach(({ evaluate }) => {
      const yAtZero = evaluate(0);
      if (Number.isFinite(yAtZero)) {
        points.push({ x: 0, y: yAtZero });
      }
      const roots = pickClosestToZero(
        findRootsInRange(evaluate, searchViewport.xMin, searchViewport.xMax, rootSegments),
        8
      );
      roots.forEach((x) => {
        points.push({ x, y: 0 });
      });
    });

    if (!points.length) {
      points.push({ x: -10, y: 0 }, { x: 10, y: 0 }, { x: 0, y: -10 }, { x: 0, y: 10 });
    }

    let xMinData = Number.POSITIVE_INFINITY;
    let xMaxData = Number.NEGATIVE_INFINITY;
    let yMinData = Number.POSITIVE_INFINITY;
    let yMaxData = Number.NEGATIVE_INFINITY;
    const xCandidates: number[] = [];

    points.forEach((point) => {
      xCandidates.push(point.x);
      xMinData = Math.min(xMinData, point.x);
      xMaxData = Math.max(xMaxData, point.x);
      yMinData = Math.min(yMinData, point.y);
      yMaxData = Math.max(yMaxData, point.y);
    });

    const nearestXs = pickClosestToZero(xCandidates, 18);
    const xExtentFromPoints = nearestXs.length
      ? Math.max(Math.abs(nearestXs[0]), Math.abs(nearestXs[nearestXs.length - 1]))
      : 10;
    const sampleHalfSpan = Math.min(40, Math.max(10, xExtentFromPoints * 1.35));
    const sampleXMin = -sampleHalfSpan;
    const sampleXMax = sampleHalfSpan;
    const sampleCount = 700;

    for (let i = 0; i <= sampleCount; i += 1) {
      const x = sampleXMin + (i / sampleCount) * (sampleXMax - sampleXMin);
      compiledEquations.forEach(({ evaluate }) => {
        const y = evaluate(x);
        if (!Number.isFinite(y) || Math.abs(y) > 1e6) {
          return;
        }
        xMinData = Math.min(xMinData, x);
        xMaxData = Math.max(xMaxData, x);
        yMinData = Math.min(yMinData, y);
        yMaxData = Math.max(yMaxData, y);
      });
    }

    if (
      !Number.isFinite(xMinData) ||
      !Number.isFinite(xMaxData) ||
      !Number.isFinite(yMinData) ||
      !Number.isFinite(yMaxData)
    ) {
      setViewport(defaultViewport);
      return;
    }

    const minSpan = 2;
    const spanX = Math.max(minSpan, xMaxData - xMinData);
    const spanY = Math.max(minSpan, yMaxData - yMinData);
    const bufferX = Math.max(spanX * 0.16, getNiceStep(spanX, 20));
    const bufferY = Math.max(spanY * 0.16, getNiceStep(spanY, 20));
    const centerX = (xMinData + xMaxData) / 2;
    const centerY = (yMinData + yMaxData) / 2;
    const rawXSpan = spanX + 2 * bufferX;
    const rawYSpan = spanY + 2 * bufferY;
    const xMajorStep = getNiceStep(rawXSpan, 10);
    const yMajorStep = getNiceStep(rawYSpan, 8);
    let xTicks = Math.max(4, Math.ceil(rawXSpan / xMajorStep));
    let yTicks = Math.max(4, Math.ceil(rawYSpan / yMajorStep));
    if (xTicks % 2 !== 0) {
      xTicks += 1;
    }
    if (yTicks % 2 !== 0) {
      yTicks += 1;
    }
    const snappedCenterX = roundToNearestStep(centerX, xMajorStep);
    const snappedCenterY = roundToNearestStep(centerY, yMajorStep);

    const nextViewport = clampViewport({
      xMin: snappedCenterX - (xTicks / 2) * xMajorStep,
      xMax: snappedCenterX + (xTicks / 2) * xMajorStep,
      yMin: snappedCenterY - (yTicks / 2) * yMajorStep,
      yMax: snappedCenterY + (yTicks / 2) * yMajorStep
    });

    setViewport(nextViewport);

    setConfig((current) => ({
      ...current,
      xMajorStep,
      xMinorStep: Math.max(0.01, xMajorStep / 5),
      yMajorStep,
      yMinorStep: Math.max(0.01, yMajorStep / 5)
    }));
  };

  const exportPng = () => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    let dataUrl = canvas.toDataURL('image/png');
    if (config.exportIntersectionLabels) {
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = canvas.width;
      exportCanvas.height = canvas.height;
      const ctx = exportCanvas.getContext('2d');

      if (ctx) {
        ctx.drawImage(canvas, 0, 0);
        const intersections = findCurveIntersections(
          equations,
          viewport,
          Math.max(1200, Math.floor(canvas.clientWidth * 2))
        );
        const ratioX = canvas.width / Math.max(1, canvas.clientWidth);
        const ratioY = canvas.height / Math.max(1, canvas.clientHeight);
        const xSpan = Math.max(1e-9, viewport.xMax - viewport.xMin);
        const ySpan = Math.max(1e-9, viewport.yMax - viewport.yMin);
        const textColor = theme === 'dark' ? '#e2e8f0' : '#0f172a';
        const outline = theme === 'dark' ? 'rgba(2, 6, 23, 0.85)' : 'rgba(248, 250, 252, 0.95)';
        const fontSize = Math.max(11, Math.round(12 * Math.min(ratioX, ratioY)));

        ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui`;
        ctx.fillStyle = textColor;
        ctx.strokeStyle = outline;
        ctx.lineWidth = Math.max(2, Math.round(2 * Math.min(ratioX, ratioY)));
        ctx.lineJoin = 'round';

        intersections.forEach((item) => {
          const sx = ((item.x - viewport.xMin) / xSpan) * canvas.clientWidth * ratioX;
          const sy = ((viewport.yMax - item.y) / ySpan) * canvas.clientHeight * ratioY;
          const tx = Math.min(sx + 8 * ratioX, exportCanvas.width - 12 * ratioX);
          const ty = Math.max(16 * ratioY, sy - 8 * ratioY);
          const pointText = `${item.label} (${item.x.toFixed(4)}, ${item.y.toFixed(4)})`;
          ctx.strokeText(pointText, tx, ty);
          ctx.fillText(pointText, tx, ty);
        });

        dataUrl = exportCanvas.toDataURL('image/png');
      }
    }

    const link = document.createElement('a');
    const date = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    link.download = `graphr-${date}.png`;
    link.href = dataUrl;
    link.click();
  };

  const zoomAt = (screenX: number, screenY: number, scale: number) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const world = screenToWorld(canvas, screenX, screenY, viewport);

    const next: Viewport = {
      xMin: world.x + (viewport.xMin - world.x) * scale,
      xMax: world.x + (viewport.xMax - world.x) * scale,
      yMin: world.y + (viewport.yMin - world.y) * scale,
      yMax: world.y + (viewport.yMax - world.y) * scale
    };

    setViewport(clampViewport(next));
  };

  const onWheel: React.WheelEventHandler<HTMLCanvasElement> = (event) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = event.deltaY > 0 ? 1.08 : 0.92;
    zoomAt(event.clientX - rect.left, event.clientY - rect.top, scale);
  };

  const onPointerDown: React.PointerEventHandler<HTMLCanvasElement> = (event) => {
    event.currentTarget.setPointerCapture(event.pointerId);

    draggingRef.current = {
      x: event.clientX,
      y: event.clientY,
      viewport
    };
  };

  const onPointerMove: React.PointerEventHandler<HTMLCanvasElement> = (event) => {
    const canvas = canvasRef.current;
    const dragState = draggingRef.current;
    if (!canvas) {
      return;
    }

    if (!dragState || pinchRef.current) {
      if (event.pointerType !== 'mouse') {
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;
      const bestIntersection = hoverIntersections
        .map((point) => {
          const intersectionScreenX = worldToScreenX(canvas, point.x, viewport);
          const intersectionScreenY = worldToScreenY(canvas, point.y, viewport);
          return {
            point: {
              screenX: intersectionScreenX,
              screenY: intersectionScreenY,
              worldX: point.x,
              worldY: point.y,
              source: point.source
            },
            distance: Math.hypot(intersectionScreenX - screenX, intersectionScreenY - screenY)
          };
        })
        .reduce<{ point: HoverPoint; distance: number } | null>(
        (best, current) => (!best || current.distance < best.distance ? current : best),
        null
      );

      if (bestIntersection && bestIntersection.distance <= INTERSECTION_SNAP_DISTANCE_PX) {
        setHoverPoint(bestIntersection.point);
      } else {
        setHoverPoint(null);
      }
      return;
    }

    const dx = event.clientX - dragState.x;
    const dy = event.clientY - dragState.y;
    const spanX = dragState.viewport.xMax - dragState.viewport.xMin;
    const spanY = dragState.viewport.yMax - dragState.viewport.yMin;

    const next: Viewport = {
      xMin: dragState.viewport.xMin - (dx / canvas.clientWidth) * spanX,
      xMax: dragState.viewport.xMax - (dx / canvas.clientWidth) * spanX,
      yMin: dragState.viewport.yMin + (dy / canvas.clientHeight) * spanY,
      yMax: dragState.viewport.yMax + (dy / canvas.clientHeight) * spanY
    };

    setViewport(next);
    setHoverPoint(null);
  };

  const onPointerUp: React.PointerEventHandler<HTMLCanvasElement> = () => {
    draggingRef.current = null;
  };

  const onTouchStart: React.TouchEventHandler<HTMLCanvasElement> = (event) => {
    if (event.touches.length !== 2) {
      pinchRef.current = null;
      return;
    }
    draggingRef.current = null;

    const [touchA, touchB] = [event.touches[0], event.touches[1]];
    const dx = touchB.clientX - touchA.clientX;
    const dy = touchB.clientY - touchA.clientY;
    pinchRef.current = {
      distance: Math.hypot(dx, dy),
      centerX: (touchA.clientX + touchB.clientX) / 2,
      centerY: (touchA.clientY + touchB.clientY) / 2,
      viewport
    };
  };

  const onTouchMove: React.TouchEventHandler<HTMLCanvasElement> = (event) => {
    const pinchState = pinchRef.current;
    const canvas = canvasRef.current;

    if (!pinchState || !canvas || event.touches.length !== 2) {
      return;
    }

    event.preventDefault();
    const [touchA, touchB] = [event.touches[0], event.touches[1]];
    const dx = touchB.clientX - touchA.clientX;
    const dy = touchB.clientY - touchA.clientY;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const scale = pinchState.distance / distance;

    const rect = canvas.getBoundingClientRect();
    const centerScreenX = pinchState.centerX - rect.left;
    const centerScreenY = pinchState.centerY - rect.top;

    const world = screenToWorld(canvas, centerScreenX, centerScreenY, pinchState.viewport);
    const base = pinchState.viewport;

    setViewport(
      clampViewport({
        xMin: world.x + (base.xMin - world.x) * scale,
        xMax: world.x + (base.xMax - world.x) * scale,
        yMin: world.y + (base.yMin - world.y) * scale,
        yMax: world.y + (base.yMax - world.y) * scale
      })
    );
  };

  const onTouchEnd: React.TouchEventHandler<HTMLCanvasElement> = (event) => {
    if (event.touches.length < 2) {
      pinchRef.current = null;
    }
  };

  const onPointerLeave: React.PointerEventHandler<HTMLCanvasElement> = () => {
    setHoverPoint(null);
  };

  return (
    <div className={rootClass}>
      <header className="topbar">
        <div className="brand">Graphr</div>
        <div className="topbar-actions">
          <button onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}>
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
          <button onClick={resetView}>Reset View</button>
          <button onClick={exportPng}>Export PNG</button>
          <button className="mobile-only" onClick={() => setDrawerOpen((open) => !open)}>
            {drawerOpen ? 'Close' : 'Config'}
          </button>
        </div>
      </header>

      <main className="layout">
        <aside ref={panelRef} className={`sidebar ${drawerOpen ? 'open' : ''}`}>
          <section className="panel-block">
            <h2>Equations</h2>
            <div className="equations">
              {equations.map((item) => (
                <div className="equation-item" key={item.id}>
                  <input
                    className="expr-input"
                    type="text"
                    placeholder="ex: x^2, sin(x), 2*x+1"
                    value={item.expression}
                    onChange={(event) => updateEquation(item.id, { expression: event.target.value })}
                  />
                  <input
                    type="text"
                    placeholder="Label"
                    value={item.label}
                    onChange={(event) => updateEquation(item.id, { label: event.target.value })}
                  />
                  <div className="row">
                    <label>
                      <span>Color</span>
                      <input
                        type="color"
                        value={item.color}
                        onChange={(event) => updateEquation(item.id, { color: event.target.value })}
                      />
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={item.visible}
                        onChange={(event) => updateEquation(item.id, { visible: event.target.checked })}
                      />
                      Visible
                    </label>
                    <button onClick={() => removeEquation(item.id)} disabled={equations.length <= 1}>
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button onClick={addEquation}>Add Equation</button>
          </section>

          <section className="panel-block">
            <h2>Viewport</h2>
            <div className="grid-2">
              <label>
                X Min
                <input
                  type="number"
                  value={viewport.xMin}
                  step="0.5"
                  onChange={(event) =>
                    setViewport((current) => ({ ...current, xMin: Number(event.target.value) }))
                  }
                />
              </label>
              <label>
                X Max
                <input
                  type="number"
                  value={viewport.xMax}
                  step="0.5"
                  onChange={(event) =>
                    setViewport((current) => ({ ...current, xMax: Number(event.target.value) }))
                  }
                />
              </label>
              <label>
                Y Min
                <input
                  type="number"
                  value={viewport.yMin}
                  step="0.5"
                  onChange={(event) =>
                    setViewport((current) => ({ ...current, yMin: Number(event.target.value) }))
                  }
                />
              </label>
              <label>
                Y Max
                <input
                  type="number"
                  value={viewport.yMax}
                  step="0.5"
                  onChange={(event) =>
                    setViewport((current) => ({ ...current, yMax: Number(event.target.value) }))
                  }
                />
              </label>
            </div>
          </section>

          <section className="panel-block">
            <h2>Graph Config</h2>
            <div className="grid-2">
              <label>
                X Label
                <input
                  type="text"
                  value={config.xLabel}
                  onChange={(event) => setConfig((current) => ({ ...current, xLabel: event.target.value }))}
                />
              </label>
              <label>
                Y Label
                <input
                  type="text"
                  value={config.yLabel}
                  onChange={(event) => setConfig((current) => ({ ...current, yLabel: event.target.value }))}
                />
              </label>
              <label>
                X Major Step
                <input
                  type="number"
                  value={config.xMajorStep}
                  min="0.05"
                  step="0.1"
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      xMajorStep: Math.max(0.05, Number(event.target.value))
                    }))
                  }
                />
              </label>
              <label>
                Y Major Step
                <input
                  type="number"
                  value={config.yMajorStep}
                  min="0.05"
                  step="0.1"
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      yMajorStep: Math.max(0.05, Number(event.target.value))
                    }))
                  }
                />
              </label>
              <label>
                X Minor Step
                <input
                  type="number"
                  value={config.xMinorStep}
                  min="0.01"
                  step="0.05"
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      xMinorStep: Math.max(0.01, Number(event.target.value))
                    }))
                  }
                />
              </label>
              <label>
                Y Minor Step
                <input
                  type="number"
                  value={config.yMinorStep}
                  min="0.01"
                  step="0.05"
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      yMinorStep: Math.max(0.01, Number(event.target.value))
                    }))
                  }
                />
              </label>
            </div>
            <div className="row checkboxes">
              <label>
                <input
                  type="checkbox"
                  checked={config.showGrid}
                  onChange={(event) => setConfig((current) => ({ ...current, showGrid: event.target.checked }))}
                />
                Grid
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={config.showMinorGrid}
                  onChange={(event) =>
                    setConfig((current) => ({ ...current, showMinorGrid: event.target.checked }))
                  }
                />
                Minor Grid
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={config.showAxes}
                  onChange={(event) => setConfig((current) => ({ ...current, showAxes: event.target.checked }))}
                />
                Axes
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={config.showLegend}
                  onChange={(event) => setConfig((current) => ({ ...current, showLegend: event.target.checked }))}
                />
                Legend
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={config.exportIntersectionLabels}
                  onChange={(event) =>
                    setConfig((current) => ({ ...current, exportIntersectionLabels: event.target.checked }))
                  }
                />
                Export Intersections
              </label>
            </div>
          </section>

          {errors.length > 0 && (
            <section className="panel-block error">
              {errors.map((error, index) => (
                <div key={`${error}-${index}`}>{error}</div>
              ))}
            </section>
          )}
        </aside>

        <section className="graph-area">
          <canvas
            ref={canvasRef}
            className="graph-canvas"
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={onPointerLeave}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
          />
          {hoverPoint && (
            <div className="hover-overlay">
              <div className="hover-line-x" style={{ top: `${hoverPoint.screenY}px` }} />
              <div className="hover-line-y" style={{ left: `${hoverPoint.screenX}px` }} />
              <div
                className="hover-point"
                style={{
                  left: `${hoverPoint.screenX}px`,
                  top: `${hoverPoint.screenY}px`
                }}
              />
              <div
                className="hover-card"
                style={{
                  left: `${Math.min(hoverPoint.screenX + 10, (canvasRef.current?.clientWidth ?? 0) - 160)}px`,
                  top: `${Math.max(8, hoverPoint.screenY - 54)}px`
                }}
              >
                <div>{hoverPoint.source}</div>
                <div>
                  ({hoverPoint.worldX.toFixed(4)}, {hoverPoint.worldY.toFixed(4)})
                </div>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
