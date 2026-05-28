import { CircleMarker } from 'react-leaflet';

const MIN_R = 4;
const MAX_R = 28;

function BubbleLayer({ data, onZipClick }) {
  return data.map(({ zip, lat, lng, weight }, i) => {
    const radius = MIN_R + weight * (MAX_R - MIN_R);
    // Blue (low) → cyan → yellow → red (high) — matches heatmap gradient
    const hue = Math.round((1 - weight) * 240);
    const color = `hsl(${hue}, 90%, 55%)`;

    return (
      <CircleMarker
        key={`${lat}-${lng}-${i}`}
        center={[lat, lng]}
        radius={radius}
        eventHandlers={onZipClick && zip ? { click: () => onZipClick(zip) } : undefined}
        pathOptions={{
          color,
          fillColor: color,
          fillOpacity: 0.55,
          weight: 1,
          opacity: 0.85,
          className: onZipClick ? 'cursor-pointer' : undefined,
        }}
      />
    );
  });
}

export default {
  id: 'bubbles',
  label: 'Bubbles',
  component: BubbleLayer,
};
