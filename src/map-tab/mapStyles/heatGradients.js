// Each gradient defines:
//   swatch  — 4 hex stops for the sidebar preview bar (low → high density)
//   center(w) — hsla string for radial gradient center at weight w
//   mid(w)    — hsla string for radial gradient mid-ring at weight w
//   (edge is always transparent)

export const heatGradients = [
  {
    id:     'spectrum',
    label:  'Spectrum',
    swatch: ['#1a1aff', '#00e5ff', '#ffee00', '#ff2200'],
    center: w => `hsla(${Math.round((1-w)*240)},90%,65%,${(0.72+w*0.28).toFixed(2)})`,
    mid:    w => `hsla(${Math.round((1-w)*240)},85%,55%,${(0.30+w*0.20).toFixed(2)})`,
  },
  {
    id:     'blue-white',
    label:  'Blue → White',
    swatch: ['#1a3aff', '#4d72ff', '#99b3ff', '#e6ecff'],
    center: w => `hsla(225,${Math.round(90-w*75)}%,${Math.round(48+w*46)}%,${(0.72+w*0.28).toFixed(2)})`,
    mid:    w => `hsla(225,${Math.round(85-w*70)}%,${Math.round(42+w*40)}%,${(0.30+w*0.20).toFixed(2)})`,
  },
  {
    id:     'blue-green',
    label:  'Blue → Green',
    swatch: ['#2040e0', '#0d90c0', '#08b860', '#18e030'],
    center: w => `hsla(${Math.round(240-w*120)},88%,60%,${(0.72+w*0.28).toFixed(2)})`,
    mid:    w => `hsla(${Math.round(240-w*120)},83%,50%,${(0.30+w*0.20).toFixed(2)})`,
  },
  {
    id:     'fire',
    label:  'Fire',
    swatch: ['#7a0000', '#cc3300', '#ff8800', '#ffee00'],
    center: w => `hsla(${Math.round(w*58)},${Math.round(88+w*8)}%,${Math.round(28+w*57)}%,${(0.72+w*0.28).toFixed(2)})`,
    mid:    w => `hsla(${Math.round(w*58)},88%,${Math.round(22+w*48)}%,${(0.30+w*0.20).toFixed(2)})`,
  },
  {
    id:     'plasma',
    label:  'Plasma',
    swatch: ['#6600cc', '#b8006e', '#e83020', '#ffbe00'],
    center: w => `hsla(${Math.round(270-w*220)},90%,${Math.round(38+w*36)}%,${(0.72+w*0.28).toFixed(2)})`,
    mid:    w => `hsla(${Math.round(270-w*220)},85%,${Math.round(32+w*30)}%,${(0.30+w*0.20).toFixed(2)})`,
  },
  {
    id:     'ice',
    label:  'Ice',
    swatch: ['#04152e', '#0a3f6e', '#0891b2', '#a8ecf8'],
    center: w => `hsla(198,${Math.round(92-w*28)}%,${Math.round(22+w*66)}%,${(0.72+w*0.28).toFixed(2)})`,
    mid:    w => `hsla(198,${Math.round(88-w*24)}%,${Math.round(18+w*56)}%,${(0.30+w*0.20).toFixed(2)})`,
  },
];

export const defaultGradient = heatGradients[0];
