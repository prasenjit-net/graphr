import { useEffect, useMemo, useRef, useState } from 'react';
import { drawGraph, screenToWorld } from './graph';
import type { EquationItem, GraphConfig, Theme, Viewport } from './types';

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
  xLabel: 'x',
  yLabel: 'y',
  majorStep: 1,
  minorStep: 0.5
};

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

export default function App() {
  const [theme, setTheme] = useState<Theme>('dark');
  const [equations, setEquations] = useState<EquationItem[]>([makeEquation(0)]);
  const [viewport, setViewport] = useState<Viewport>(defaultViewport);
  const [config, setConfig] = useState<GraphConfig>(defaultConfig);
  const [errors, setErrors] = useState<string[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);

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

  useEffect(() => {
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

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

    const link = document.createElement('a');
    const date = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    link.download = `graphr-${date}.png`;
    link.href = canvas.toDataURL('image/png');
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
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
          />
        </section>
      </main>
    </div>
  );
}
