import { Marker } from 'react-leaflet';
import L from 'leaflet';
import { useLodData } from '../utils/useLodData.js';

const MIN_COINS = 5;
const MAX_COINS = 18;
const COIN_PX   = 10.4; // 8px × 1.30

function frac(x) { return x - Math.floor(x); }

function stableJitter(lat, lng) {
  const u = Math.sin(lat * 92.3  + lng * 187.6) * 43758.5453;
  const v = Math.sin(lat * 47.9  + lng * 283.1) * 43758.5453;
  return {
    dLat: (frac(u) - 0.5) * 0.30,
    dLng: (frac(v) - 0.5) * 0.40,
  };
}

function makeTreasureIcon(weight) {
  const count = Math.round(MIN_COINS + weight * (MAX_COINS - MIN_COINS));

  // Pile footprint scales with weight
  const pileW = Math.round(COIN_PX * (3 + weight * 4.5));  // 24–60px wide
  const pileH = Math.round(pileW * 0.30);                   // flat mound, ~1:3 aspect
  const w     = pileW + COIN_PX * 2;                        // padding for edge coins
  const h     = pileH + COIN_PX;

  const coins = Array.from({ length: count }, (_, i) => {
    const u = frac(Math.sin(i * 73.1  + 17.3) * 43758.5453);
    const v = frac(Math.sin(i * 47.9  + 31.7) * 43758.5453);
    const s = frac(Math.sin(i * 131.7 + 53.1) * 43758.5453);

    // yNorm 0=apex, 1=base — bias toward base so pile looks full at bottom
    const yNorm = Math.pow(v, 0.60);
    const top   = Math.round(yNorm * pileH);

    // x range widens toward the base
    const xRange = pileW * (0.15 + 0.85 * yNorm);
    const left   = Math.round(w / 2 + (u - 0.5) * xRange - COIN_PX / 2);

    // slight per-coin size variation for depth illusion
    const sz  = Math.round(COIN_PX * (0.80 + s * 0.40));

    // coins lower on screen render in front
    const z = top + 1;

    return `<span style="position:absolute;top:${top}px;left:${left}px;font-size:${sz}px;line-height:1;z-index:${z};filter:drop-shadow(0 1px 1px rgba(0,0,0,0.7));">🪙</span>`;
  }).join('');

  return L.divIcon({
    html:       `<div style="position:relative;width:${w}px;height:${h}px;overflow:visible;">${coins}</div>`,
    className:  '',
    iconSize:   [w, h],
    iconAnchor: [w / 2, h],
  });
}

function TreasureLayer({ data, onZipClick }) {
  const { lodData } = useLodData(data);

  return lodData.map(({ zip, lat, lng, weight }) => {
    const { dLat, dLng } = stableJitter(lat, lng);
    return (
      <Marker
        key={`treasure-${lat}-${lng}`}
        position={[lat + dLat, lng + dLng]}
        icon={makeTreasureIcon(weight)}
        eventHandlers={onZipClick && zip ? { click: () => onZipClick(zip) } : undefined}
      />
    );
  });
}

export default {
  id:        'treasure',
  label:     'Treasure',
  component: TreasureLayer,
};
