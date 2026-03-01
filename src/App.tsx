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
  majorStep: 1,
  minorStep: 0.5
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

interface CompiledEquation {
  item: EquationItem;
  evaluate: (x: number) => number;
}

const SNAP_DISTANCE_PX = 14;
const INTERSECTION_SNAP_DISTANCE_PX = 24;
const ROOT_SEARCH_RADIUS_PX = 18;

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

function findNearbyXAxisIntersection(
  evaluate: (x: number) => number,
  cursorX: number,
  viewport: Viewport,
  canvas: HTMLCanvasElement
): number | null {
  const worldPerPixel = (viewport.xMax - viewport.xMin) / Math.max(1, canvas.clientWidth);
  const worldYPerPixel = (viewport.yMax - viewport.yMin) / Math.max(1, canvas.clientHeight);
  const yTolWorld = worldYPerPixel * INTERSECTION_SNAP_DISTANCE_PX;
  const searchRadiusWorld = worldPerPixel * ROOT_SEARCH_RADIUS_PX;
  const centerY = evaluate(cursorX);

  if (Number.isFinite(centerY) && Math.abs(centerY) <= yTolWorld) {
    return cursorX;
  }

  const left = Math.max(viewport.xMin, cursorX - searchRadiusWorld);
  const right = Math.min(viewport.xMax, cursorX + searchRadiusWorld);
  if (left >= right) {
    return null;
  }

  return findRootByBisection(evaluate, left, right);
}

function findNearbyCurveIntersection(
  evaluateA: (x: number) => number,
  evaluateB: (x: number) => number,
  cursorX: number,
  viewport: Viewport,
  canvas: HTMLCanvasElement
): number | null {
  const worldPerPixel = (viewport.xMax - viewport.xMin) / Math.max(1, canvas.clientWidth);
  const worldYPerPixel = (viewport.yMax - viewport.yMin) / Math.max(1, canvas.clientHeight);
  const yTolWorld = worldYPerPixel * INTERSECTION_SNAP_DISTANCE_PX;
  const searchRadiusWorld = worldPerPixel * ROOT_SEARCH_RADIUS_PX;
  const deltaAtCursor = evaluateA(cursorX) - evaluateB(cursorX);

  if (Number.isFinite(deltaAtCursor) && Math.abs(deltaAtCursor) <= yTolWorld) {
    return cursorX;
  }

  const left = Math.max(viewport.xMin, cursorX - searchRadiusWorld);
  const right = Math.min(viewport.xMax, cursorX + searchRadiusWorld);
  if (left >= right) {
    return null;
  }

  return findRootByBisection((x) => evaluateA(x) - evaluateB(x), left, right);
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
      majorStep: Math.max(0.05, toNumber(parsedConfig.majorStep, defaultConfig.majorStep)),
      minorStep: Math.max(0.01, toNumber(parsedConfig.minorStep, defaultConfig.minorStep))
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

  const resetView = () => setViewport(defaultViewport);

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
      const cursorWorld = screenToWorld(canvas, screenX, screenY, viewport);
      const normalCandidates: Array<{ point: HoverPoint; distance: number }> = [];
      const intersectionCandidates: Array<{ point: HoverPoint; distance: number }> = [];

      compiledEquations.forEach(({ item, evaluate }) => {
        const y = evaluate(cursorWorld.x);
        if (!Number.isFinite(y)) {
          return;
        }

        const candidateScreenY = worldToScreenY(canvas, y, viewport);
        const distance = Math.hypot(screenX - screenX, candidateScreenY - screenY);
        normalCandidates.push({
          point: {
            screenX,
            screenY: candidateScreenY,
            worldX: cursorWorld.x,
            worldY: y,
            source: item.label || item.expression
          },
          distance
        });

        if (config.showAxes) {
          const xAxisIntersectionX = findNearbyXAxisIntersection(evaluate, cursorWorld.x, viewport, canvas);
          if (xAxisIntersectionX !== null) {
            const intersectionScreenX = worldToScreenX(canvas, xAxisIntersectionX, viewport);
            const intersectionScreenY = worldToScreenY(canvas, 0, viewport);
            intersectionCandidates.push({
              point: {
                screenX: intersectionScreenX,
                screenY: intersectionScreenY,
                worldX: xAxisIntersectionX,
                worldY: 0,
                source: `${item.label || item.expression} ∩ x-axis`
              },
              distance: Math.hypot(intersectionScreenX - screenX, intersectionScreenY - screenY)
            });
          }

          const yAxisIntersectionY = evaluate(0);
          if (Number.isFinite(yAxisIntersectionY)) {
            const intersectionScreenX = worldToScreenX(canvas, 0, viewport);
            const intersectionScreenY = worldToScreenY(canvas, yAxisIntersectionY, viewport);
            intersectionCandidates.push({
              point: {
                screenX: intersectionScreenX,
                screenY: intersectionScreenY,
                worldX: 0,
                worldY: yAxisIntersectionY,
                source: `${item.label || item.expression} ∩ y-axis`
              },
              distance: Math.hypot(intersectionScreenX - screenX, intersectionScreenY - screenY)
            });
          }
        }
      });

      for (let i = 0; i < compiledEquations.length; i += 1) {
        for (let j = i + 1; j < compiledEquations.length; j += 1) {
          const first = compiledEquations[i];
          const second = compiledEquations[j];
          const intersectionX = findNearbyCurveIntersection(
            first.evaluate,
            second.evaluate,
            cursorWorld.x,
            viewport,
            canvas
          );
          if (intersectionX === null) {
            continue;
          }

          const intersectionY = first.evaluate(intersectionX);
          if (!Number.isFinite(intersectionY)) {
            continue;
          }

          const intersectionScreenX = worldToScreenX(canvas, intersectionX, viewport);
          const intersectionScreenY = worldToScreenY(canvas, intersectionY, viewport);
          intersectionCandidates.push({
            point: {
              screenX: intersectionScreenX,
              screenY: intersectionScreenY,
              worldX: intersectionX,
              worldY: intersectionY,
              source: `${first.item.label || first.item.expression} ∩ ${second.item.label || second.item.expression}`
            },
            distance: Math.hypot(intersectionScreenX - screenX, intersectionScreenY - screenY)
          });
        }
      }

      if (config.showAxes) {
        const xAxisScreenY = worldToScreenY(canvas, 0, viewport);
        const xAxisDistance = Math.abs(xAxisScreenY - screenY);
        normalCandidates.push({
          point: {
            screenX,
            screenY: xAxisScreenY,
            worldX: cursorWorld.x,
            worldY: 0,
            source: 'x-axis'
          },
          distance: xAxisDistance
        });

        const yAxisScreenX = worldToScreenX(canvas, 0, viewport);
        const yAxisDistance = Math.abs(yAxisScreenX - screenX);
        normalCandidates.push({
          point: {
            screenX: yAxisScreenX,
            screenY,
            worldX: 0,
            worldY: cursorWorld.y,
            source: 'y-axis'
          },
          distance: yAxisDistance
        });
      }

      const bestIntersection = intersectionCandidates.reduce<{ point: HoverPoint; distance: number } | null>(
        (best, current) => (!best || current.distance < best.distance ? current : best),
        null
      );
      const bestNormal = normalCandidates.reduce<{ point: HoverPoint; distance: number } | null>(
        (best, current) => (!best || current.distance < best.distance ? current : best),
        null
      );

      if (bestIntersection && bestIntersection.distance <= INTERSECTION_SNAP_DISTANCE_PX) {
        setHoverPoint(bestIntersection.point);
      } else if (bestNormal && bestNormal.distance <= SNAP_DISTANCE_PX) {
        setHoverPoint(bestNormal.point);
      } else {
        setHoverPoint({
          screenX,
          screenY,
          worldX: cursorWorld.x,
          worldY: cursorWorld.y,
          source: 'cursor'
        });
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
                Major Step
                <input
                  type="number"
                  value={config.majorStep}
                  min="0.05"
                  step="0.1"
                  onChange={(event) =>
                    setConfig((current) => ({ ...current, majorStep: Math.max(0.05, Number(event.target.value)) }))
                  }
                />
              </label>
              <label>
                Minor Step
                <input
                  type="number"
                  value={config.minorStep}
                  min="0.01"
                  step="0.05"
                  onChange={(event) =>
                    setConfig((current) => ({ ...current, minorStep: Math.max(0.01, Number(event.target.value)) }))
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
