import { compileEquation } from './math';
import type { EquationItem, GraphConfig, Theme, Viewport } from './types';

interface DrawOptions {
  canvas: HTMLCanvasElement;
  equations: EquationItem[];
  viewport: Viewport;
  config: GraphConfig;
  theme: Theme;
}

interface Colors {
  bg: string;
  majorGrid: string;
  minorGrid: string;
  axis: string;
  axisText: string;
  legendBg: string;
}

interface CompiledEquation {
  item: EquationItem;
  evaluate: (x: number) => number;
}

export interface CurveIntersection {
  x: number;
  y: number;
  label: string;
}

const themeColors: Record<Theme, Colors> = {
  light: {
    bg: '#f7fafc',
    majorGrid: '#cbd5e1',
    minorGrid: '#e2e8f0',
    axis: '#0f172a',
    axisText: '#1e293b',
    legendBg: 'rgba(255,255,255,0.82)'
  },
  dark: {
    bg: '#020617',
    majorGrid: '#334155',
    minorGrid: '#1e293b',
    axis: '#e2e8f0',
    axisText: '#e2e8f0',
    legendBg: 'rgba(15,23,42,0.8)'
  }
};

function worldToScreenX(x: number, width: number, view: Viewport): number {
  return ((x - view.xMin) / (view.xMax - view.xMin)) * width;
}

function worldToScreenY(y: number, height: number, view: Viewport): number {
  return ((view.yMax - y) / (view.yMax - view.yMin)) * height;
}

export function screenToWorld(
  canvas: HTMLCanvasElement,
  sx: number,
  sy: number,
  viewport: Viewport
): { x: number; y: number } {
  return {
    x: viewport.xMin + (sx / canvas.clientWidth) * (viewport.xMax - viewport.xMin),
    y: viewport.yMax - (sy / canvas.clientHeight) * (viewport.yMax - viewport.yMin)
  };
}

function computeLabelStride(pixelsPerStep: number, minLabelSpacingPx: number): number {
  if (!Number.isFinite(pixelsPerStep) || pixelsPerStep <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(minLabelSpacingPx / pixelsPerStep));
}

function formatTickValue(value: number, step: number): string {
  const safeStep = Math.max(Math.abs(step), 1e-9);
  const decimals = Math.max(0, Math.min(6, Math.ceil(-Math.log10(safeStep))));
  const normalized = Math.abs(value) < 1e-10 ? 0 : value;
  return normalized.toFixed(decimals);
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  viewport: Viewport,
  config: GraphConfig,
  colors: Colors
): void {
  if (!config.showGrid) {
    return;
  }

  const xRange = Math.max(1e-9, viewport.xMax - viewport.xMin);
  const yRange = Math.max(1e-9, viewport.yMax - viewport.yMin);
  const majorStep = Math.max(1e-9, config.majorStep);
  const pixelsPerMajorX = (majorStep / xRange) * width;
  const pixelsPerMajorY = (majorStep / yRange) * height;
  const majorStrideX = computeLabelStride(pixelsPerMajorX, 56);
  const majorStrideY = computeLabelStride(pixelsPerMajorY, 40);

  const drawLines = (
    step: number,
    color: string,
    lineWidth: number,
    strideX: number,
    strideY: number
  ) => {
    if (step <= 0) {
      return;
    }

    const xStart = Math.ceil(viewport.xMin / step) * step;
    const yStart = Math.ceil(viewport.yMin / step) * step;

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;

    for (let x = xStart; x <= viewport.xMax; x += step) {
      const tickIndex = Math.round(x / step);
      if (tickIndex % strideX !== 0) {
        continue;
      }
      const sx = worldToScreenX(x, width, viewport);
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, height);
    }

    for (let y = yStart; y <= viewport.yMax; y += step) {
      const tickIndex = Math.round(y / step);
      if (tickIndex % strideY !== 0) {
        continue;
      }
      const sy = worldToScreenY(y, height, viewport);
      ctx.moveTo(0, sy);
      ctx.lineTo(width, sy);
    }

    ctx.stroke();
  };

  if (config.showMinorGrid) {
    const minorStep = Math.max(1e-9, config.minorStep);
    const pixelsPerMinorX = (minorStep / xRange) * width;
    const pixelsPerMinorY = (minorStep / yRange) * height;
    const minorStrideX = computeLabelStride(pixelsPerMinorX, 18);
    const minorStrideY = computeLabelStride(pixelsPerMinorY, 18);
    drawLines(minorStep, colors.minorGrid, 0.7, minorStrideX, minorStrideY);
  }

  drawLines(majorStep, colors.majorGrid, 1, majorStrideX, majorStrideY);
}

function drawAxes(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  viewport: Viewport,
  config: GraphConfig,
  colors: Colors
): void {
  if (!config.showAxes) {
    return;
  }

  const x0 = worldToScreenX(0, width, viewport);
  const y0 = worldToScreenY(0, height, viewport);

  ctx.beginPath();
  ctx.strokeStyle = colors.axis;
  ctx.lineWidth = 1.6;

  if (x0 >= 0 && x0 <= width) {
    ctx.moveTo(x0, 0);
    ctx.lineTo(x0, height);
  }

  if (y0 >= 0 && y0 <= height) {
    ctx.moveTo(0, y0);
    ctx.lineTo(width, y0);
  }

  ctx.stroke();

  const tickStep = config.majorStep;
  if (tickStep <= 0) {
    return;
  }
  const xRange = Math.max(1e-9, viewport.xMax - viewport.xMin);
  const yRange = Math.max(1e-9, viewport.yMax - viewport.yMin);
  const pixelsPerStepX = (tickStep / xRange) * width;
  const pixelsPerStepY = (tickStep / yRange) * height;
  const xLabelStride = computeLabelStride(pixelsPerStepX, 56);
  const yLabelStride = computeLabelStride(pixelsPerStepY, 40);
  const xLabelStep = tickStep * xLabelStride;
  const yLabelStep = tickStep * yLabelStride;

  ctx.fillStyle = colors.axisText;
  ctx.font = '12px ui-sans-serif, system-ui';

  const xStart = Math.ceil(viewport.xMin / tickStep) * tickStep;
  for (let x = xStart; x <= viewport.xMax; x += tickStep) {
    const tickIndex = Math.round(x / tickStep);
    const sx = worldToScreenX(x, width, viewport);
    if (sx < 16 || sx > width - 16) {
      continue;
    }
    if (y0 >= 0 && y0 <= height) {
      ctx.beginPath();
      ctx.moveTo(sx, y0 - 4);
      ctx.lineTo(sx, y0 + 4);
      ctx.stroke();
      if (Math.abs(x) > Number.EPSILON && tickIndex % xLabelStride === 0) {
        ctx.fillText(formatTickValue(x, xLabelStep), sx - 9, y0 + 17);
      }
    }
  }

  const yStart = Math.ceil(viewport.yMin / tickStep) * tickStep;
  for (let y = yStart; y <= viewport.yMax; y += tickStep) {
    const tickIndex = Math.round(y / tickStep);
    const sy = worldToScreenY(y, height, viewport);
    if (sy < 12 || sy > height - 12) {
      continue;
    }
    if (x0 >= 0 && x0 <= width) {
      ctx.beginPath();
      ctx.moveTo(x0 - 4, sy);
      ctx.lineTo(x0 + 4, sy);
      ctx.stroke();
      if (Math.abs(y) > Number.EPSILON && tickIndex % yLabelStride === 0) {
        ctx.fillText(formatTickValue(y, yLabelStep), x0 + 7, sy - 5);
      }
    }
  }

  if (config.xLabel) {
    ctx.font = 'bold 14px ui-sans-serif, system-ui';
    ctx.fillText(config.xLabel, width - 36, y0 >= 0 && y0 <= height ? y0 - 8 : height - 12);
  }

  if (config.yLabel) {
    ctx.save();
    ctx.translate(x0 >= 0 && x0 <= width ? x0 + 12 : 20, 20);
    ctx.rotate(-Math.PI / 2);
    ctx.font = 'bold 14px ui-sans-serif, system-ui';
    ctx.fillText(config.yLabel, 0, 0);
    ctx.restore();
  }
}

function drawLegend(
  ctx: CanvasRenderingContext2D,
  width: number,
  equations: EquationItem[],
  config: GraphConfig,
  colors: Colors
): void {
  if (!config.showLegend) {
    return;
  }

  const visibleItems = equations.filter((item) => item.visible && item.expression.trim());
  if (!visibleItems.length) {
    return;
  }

  const lineHeight = 22;
  const legendWidth = 240;
  const legendHeight = visibleItems.length * lineHeight + 14;
  const x = width - legendWidth - 12;
  const y = 12;

  ctx.fillStyle = colors.legendBg;
  ctx.fillRect(x, y, legendWidth, legendHeight);

  ctx.font = '13px ui-sans-serif, system-ui';
  visibleItems.forEach((item, index) => {
    const rowY = y + 22 + index * lineHeight;
    ctx.strokeStyle = item.color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x + 12, rowY - 5);
    ctx.lineTo(x + 32, rowY - 5);
    ctx.stroke();

    ctx.fillStyle = colors.axisText;
    const text = item.label || item.expression;
    ctx.fillText(text.slice(0, 32), x + 38, rowY);
  });
}

function drawFunction(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  viewport: Viewport,
  expression: string,
  color: string
): void {
  const fn = compileEquation(expression);

  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2;

  let hasStarted = false;

  for (let pixelX = 0; pixelX <= width; pixelX += 1) {
    const x = viewport.xMin + (pixelX / width) * (viewport.xMax - viewport.xMin);
    const y = fn(x);

    if (!Number.isFinite(y)) {
      hasStarted = false;
      continue;
    }

    const screenY = worldToScreenY(y, height, viewport);

    if (screenY < -8000 || screenY > height + 8000) {
      hasStarted = false;
      continue;
    }

    if (!hasStarted) {
      ctx.moveTo(pixelX, screenY);
      hasStarted = true;
    } else {
      ctx.lineTo(pixelX, screenY);
    }
  }

  ctx.stroke();
}

function bisectRoot(
  fn: (x: number) => number,
  left: number,
  right: number,
  maxIterations: number
): number | null {
  let a = left;
  let b = right;
  let fa = fn(a);
  const fb = fn(b);

  if (!Number.isFinite(fa) || !Number.isFinite(fb) || fa * fb > 0) {
    return null;
  }

  for (let i = 0; i < maxIterations; i += 1) {
    const mid = (a + b) / 2;
    const fm = fn(mid);
    if (!Number.isFinite(fm)) {
      return null;
    }
    if (Math.abs(fm) < 1e-8) {
      return mid;
    }
    if (fa * fm <= 0) {
      b = mid;
    } else {
      a = mid;
      fa = fm;
    }
  }

  return (a + b) / 2;
}

export function findCurveIntersections(
  equations: EquationItem[],
  viewport: Viewport,
  sampleCount = 1400
): CurveIntersection[] {
  const compiled: CompiledEquation[] = equations
    .filter((item) => item.visible && item.expression.trim())
    .flatMap((item) => {
      try {
        return [{ item, evaluate: compileEquation(item.expression) }];
      } catch {
        return [];
      }
    });

  const intersections: CurveIntersection[] = [];
  if (compiled.length < 2) {
    return intersections;
  }

  const xMin = viewport.xMin;
  const xMax = viewport.xMax;
  const span = Math.max(1e-9, xMax - xMin);
  const steps = Math.max(120, sampleCount);
  const xStep = span / steps;
  const epsilonX = xStep * 1.5;

  for (let i = 0; i < compiled.length; i += 1) {
    for (let j = i + 1; j < compiled.length; j += 1) {
      const eqA = compiled[i];
      const eqB = compiled[j];
      const delta = (x: number) => eqA.evaluate(x) - eqB.evaluate(x);

      for (let k = 0; k < steps; k += 1) {
        const left = xMin + k * xStep;
        const right = xMin + (k + 1) * xStep;
        const fLeft = delta(left);
        const fRight = delta(right);

        if (!Number.isFinite(fLeft) || !Number.isFinite(fRight)) {
          continue;
        }

        let rootX: number | null = null;
        if (Math.abs(fLeft) < 1e-8) {
          rootX = left;
        } else if (fLeft * fRight < 0) {
          rootX = bisectRoot(delta, left, right, 24);
        }

        if (rootX === null) {
          continue;
        }

        const rootY = eqA.evaluate(rootX);
        if (!Number.isFinite(rootY)) {
          continue;
        }

        const alreadyExists = intersections.some(
          (item) => Math.abs(item.x - rootX) < epsilonX && Math.abs(item.y - rootY) < epsilonX
        );
        if (alreadyExists) {
          continue;
        }

        intersections.push({
          x: rootX,
          y: rootY,
          label: `${eqA.item.label || eqA.item.expression} ∩ ${eqB.item.label || eqB.item.expression}`
        });
      }
    }
  }

  return intersections;
}

export function drawGraph(options: DrawOptions): string[] {
  const { canvas, equations, viewport, config, theme } = options;
  const colors = themeColors[theme];
  const ctx = canvas.getContext('2d');
  const errors: string[] = [];

  if (!ctx) {
    return ['Canvas context not available.'];
  }

  const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;

  if (!cssWidth || !cssHeight) {
    return [];
  }

  const scaledWidth = Math.floor(cssWidth * devicePixelRatio);
  const scaledHeight = Math.floor(cssHeight * devicePixelRatio);

  if (canvas.width !== scaledWidth || canvas.height !== scaledHeight) {
    canvas.width = scaledWidth;
    canvas.height = scaledHeight;
  }

  ctx.resetTransform();
  ctx.scale(devicePixelRatio, devicePixelRatio);

  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  drawGrid(ctx, cssWidth, cssHeight, viewport, config, colors);
  drawAxes(ctx, cssWidth, cssHeight, viewport, config, colors);

  equations
    .filter((item) => item.visible && item.expression.trim())
    .forEach((item) => {
      try {
        drawFunction(ctx, cssWidth, cssHeight, viewport, item.expression, item.color);
      } catch {
        errors.push(`Could not parse: ${item.expression}`);
      }
    });

  drawLegend(ctx, cssWidth, equations, config, colors);

  return errors;
}
