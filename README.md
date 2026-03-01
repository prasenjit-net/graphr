# Graphr

Single-page React + Vite + TypeScript PWA for plotting math equations.

## Features

- Equation parsing and plotting in the frontend (TypeScript only)
- Multiple equations with color coding, custom labels, and visibility toggles
- Configurable viewport (scale/range), grid, minor grid, axes, labels, and legend
- Light and dark themes
- Export current graph as PNG
- Mobile drawer for controls
- Mouse wheel zoom + drag pan on desktop
- Pinch zoom on mobile/touch devices
- PWA setup via `vite-plugin-pwa`

## Run

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## Equation examples

- `sin(x)`
- `x^2`
- `2*x + 1`
- `sqrt(abs(x))`
- `log(x)`
