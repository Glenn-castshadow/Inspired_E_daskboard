import { Fragment } from 'react';
import { Polyline, CircleMarker } from 'react-leaflet';

const STEPS = 80; // points per arc

/**
 * Quadratic bezier interpolation.
 * Returns an array of [lat, lng] pairs from p1 → ctrl → p2.
 */
function bezier(p1, ctrl, p2) {
  const pts = [];
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const u = 1 - t;
    pts.push([
      u * u * p1[0] + 2 * u * t * ctrl[0] + t * t * p2[0],
      u * u * p1[1] + 2 * u * t * ctrl[1] + t * t * p2[1],
    ]);
  }
  return pts;
}

/**
 * Compute the bezier control point for an arc.
 * The control point sits above the geographic midpoint, offset northward
 * by a fraction of the angular span — this approximates great-circle
 * curvature on a Mercator map for US domestic routes.
 */
function controlPoint(from, to) {
  const midLat = (from[0] + to[0]) / 2;
  const midLng = (from[1] + to[1]) / 2;
  const span   = Math.sqrt(
    Math.pow(to[0] - from[0], 2) + Math.pow(to[1] - from[1], 2)
  );
  return [midLat + span * 0.35, midLng];
}

function ArcLayer({ data, origin, onZipClick }) {
  if (!origin) return null;

  const from = [origin.lat, origin.lng];

  return data.map(({ zip, lat, lng, weight }, i) => {
    // Skip destinations that are at (or extremely close to) the origin
    if (Math.abs(lat - origin.lat) < 0.05 && Math.abs(lng - origin.lng) < 0.05)
      return null;

    const to   = [lat, lng];
    const ctrl = controlPoint(from, to);

    // Blue (low) → red (high), matches heatmap + bubbles gradient
    const hue   = Math.round((1 - weight) * 240);
    const color = `hsl(${hue}, 90%, 55%)`;

    const clickHandlers = onZipClick && zip ? { click: () => onZipClick(zip) } : undefined;

    return (
      <Fragment key={`arc-${lat}-${lng}-${i}`}>
        <Polyline
          positions={bezier(from, ctrl, to)}
          eventHandlers={clickHandlers}
          pathOptions={{
            color,
            weight:  1 + weight * 3,
            opacity: 0.35 + weight * 0.55,
          }}
        />
        {/* Destination dot — small white pip with subtle dark border */}
        <CircleMarker
          center={to}
          radius={2.5 + weight * 1.5}
          eventHandlers={clickHandlers}
          pathOptions={{
            color:       'rgba(15,23,42,0.85)',
            fillColor:   '#ffffff',
            fillOpacity: 0.95,
            weight:      1,
            opacity:     0.85,
          }}
        />
      </Fragment>
    );
  });
}

export default {
  id: 'arcs',
  label: 'Arcs',
  component: ArcLayer,
};
