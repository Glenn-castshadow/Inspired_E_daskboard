import { useEffect, useMemo } from 'react';
import { Marker } from 'react-leaflet';
import L from 'leaflet';
import pinUrl from '../images/Asset 1.png';
import { useLodData } from '../utils/useLodData.js';

// ── Pin sizing ────────────────────────────────────────────────────────────────
const PIN_W_MIN = 11;   // px, lowest-weight pin
const PIN_W_MAX = 19;   // px, highest-weight pin
const ASPECT    = 1.35; // h / w ratio of the pushpin_01 image

// ── Animation timing ─────────────────────────────────────────────────────────
const DROP_DUR   = 0.45; // seconds for the fall + bounce
const MAX_STAGGER = 2.0; // max cascade delay across the full distance range

// ── CSS injected once into <head> ─────────────────────────────────────────────
const STYLE_ID = 'zipmap-pin-drop-style';
const CSS = `
  @keyframes pin-drop {
    0%   { opacity: 0; transform: translateY(-72px); }
    65%  { opacity: 1; transform: translateY(7px);  }
    82%  { transform: translateY(-3px); }
    100% { opacity: 1; transform: translateY(0);    }
  }
  @keyframes pin-ripple {
    0%   { transform: translateX(-50%) scale(0.3); opacity: 0.65; }
    100% { transform: translateX(-50%) scale(2.8); opacity: 0;    }
  }
`;

function injectStyle() {
  if (!document.getElementById(STYLE_ID)) {
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
  }
}
function removeStyle() {
  document.getElementById(STYLE_ID)?.remove();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function latLngDist(a, b) {
  const dLat = a[0] - b[0];
  const dLng = a[1] - b[1];
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

function makePinIcon(weight, delay) {
  const w  = Math.round(PIN_W_MIN + weight * (PIN_W_MAX - PIN_W_MIN));
  const h  = Math.round(w * ASPECT);

  // Anchor at the needle tip — roughly 30 % from left, very bottom of image
  const anchorX = Math.round(w * 0.30);
  const anchorY = h;

  const html = `
    <div style="
      position: relative;
      width: ${w}px;
      height: ${h}px;
      animation: pin-drop ${DROP_DUR}s cubic-bezier(0.22,1,0.36,1) ${delay.toFixed(3)}s both;
      transform-origin: ${anchorX}px ${anchorY}px;
    ">
      <img
        src="${pinUrl}"
        width="${w}"
        height="${h}"
        style="display:block;filter:drop-shadow(1px 3px 4px rgba(0,0,0,0.55));"
        draggable="false"
      />
      <div style="
        position: absolute;
        bottom: -3px;
        left: ${anchorX}px;
        width: ${Math.round(w * 0.55)}px;
        height: ${Math.round(w * 0.22)}px;
        border-radius: 50%;
        background: rgba(80,30,30,0.4);
        animation: pin-ripple 0.55s ease-out ${(delay + DROP_DUR * 0.65).toFixed(3)}s both;
      "></div>
    </div>
  `;

  return L.divIcon({
    html,
    className:  '',
    iconSize:   [w, h],
    iconAnchor: [anchorX, anchorY],
  });
}

// ── Component ─────────────────────────────────────────────────────────────────
function PushpinLayer({ data, origin, onZipClick }) {
  useEffect(() => {
    injectStyle();
    return removeStyle;
  }, []);

  const { lodData, sorted } = useLodData(data);
  const originPt = origin ? [origin.lat, origin.lng] : null;

  // Derive the global max-distance from the FULL sorted set so the delay
  // for every pin is fixed at load time and never changes as LOD adds pins
  // on zoom-in.  Without this, maxDist shifts on every zoom step and every
  // existing pin gets a new delay → icon rebuild → animation restart (stutter).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const globalMaxDist = useMemo(() => {
    if (!originPt) return 1;
    return Math.max(...sorted.map(({ lat, lng }) => latLngDist([lat, lng], originPt)), 1);
  }, [sorted, origin?.lat, origin?.lng]);

  return lodData.map(({ zip, lat, lng, weight }, i) => {
    const delay = originPt
      ? (latLngDist([lat, lng], originPt) / globalMaxDist) * MAX_STAGGER
      : (i / Math.max(sorted.length - 1, 1)) * MAX_STAGGER;

    return (
      <Marker
        key={`pin-${lat}-${lng}`}
        position={[lat, lng]}
        icon={makePinIcon(weight, delay)}
        zIndexOffset={Math.round(weight * 1000)}
        eventHandlers={onZipClick && zip ? { click: () => onZipClick(zip) } : undefined}
      />
    );
  });
}

export default {
  id:        'pushpins',
  label:     'Pushpins',
  component: PushpinLayer,
};
