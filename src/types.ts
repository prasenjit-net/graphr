export type Theme = 'light' | 'dark';

export interface EquationItem {
  id: string;
  expression: string;
  label: string;
  color: string;
  visible: boolean;
}

export interface Viewport {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface GraphConfig {
  showGrid: boolean;
  showMinorGrid: boolean;
  showAxes: boolean;
  showLegend: boolean;
  exportIntersectionLabels: boolean;
  xLabel: string;
  yLabel: string;
  majorStep: number;
  minorStep: number;
}
