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

  const drawLines = (step: number, color: string, lineWidth: number) => {
    if (step <= 0) {
      return;
    }

    const xStart = Math.ceil(viewport.xMin / step) * step;
    const yStart = Math.ceil(viewport.yMin / step) * step;

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;

    for (let x = xStart; x <= viewport.xMax; x += step) {
      const sx = worldToScreenX(x, width, viewport);
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, height);
    }

    for (let y = yStart; y <= viewport.yMax; y += step) {
      const sy = worldToScreenY(y, height, viewport);
      ctx.moveTo(0, sy);
      ctx.lineTo(width, sy);
    }

    ctx.stroke();
  };

  if (config.showMinorGrid) {
    drawLines(config.minorStep, colors.minorGrid, 0.7);
  }

  drawLines(config.majorStep, colors.majorGrid, 1);
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

  ctx.fillStyle = colors.axisText;
  ctx.font = '12px ui-sans-serif, system-ui';

  const xStart = Math.ceil(viewport.xMin / tickStep) * tickStep;
  for (let x = xStart; x <= viewport.xMax; x += tickStep) {
    const sx = worldToScreenX(x, width, viewport);
    if (sx < 16 || sx > width - 16) {
      continue;
    }
    if (y0 >= 0 && y0 <= height) {
      ctx.beginPath();
      ctx.moveTo(sx, y0 - 4);
      ctx.lineTo(sx, y0 + 4);
      ctx.stroke();
      if (Math.abs(x) > Number.EPSILON) {
        ctx.fillText(x.toFixed(1), sx - 9, y0 + 17);
      }
    }
  }

  const yStart = Math.ceil(viewport.yMin / tickStep) * tickStep;
  for (let y = yStart; y <= viewport.yMax; y += tickStep) {
    const sy = worldToScreenY(y, height, viewport);
    if (sy < 12 || sy > height - 12) {
      continue;
    }
    if (x0 >= 0 && x0 <= width) {
      ctx.beginPath();
      ctx.moveTo(x0 - 4, sy);
      ctx.lineTo(x0 + 4, sy);
      ctx.stroke();
      if (Math.abs(y) > Number.EPSILON) {
        ctx.fillText(y.toFixed(1), x0 + 7, sy - 5);
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
