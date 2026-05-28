import { useMemo, useState } from 'react';
import { useMap, useMapEvents } from 'react-leaflet';

/**
 * Zoom-reactive LOD filter for marker layers.
 *
 * Sorts data by weight descending so the highest-count ZIPs are always
 * rendered first. The visible fraction grows linearly with zoom:
 *
 *   zoom 4  → 60 %   (national overview)
 *   zoom 5  → 70 %
 *   zoom 6  → 80 %
 *   zoom 7  → 90 %
 *   zoom 8+ → 100 %  (metro / local)
 *
 * Always shows at least min(5, data.length) markers so the map is never
 * completely empty on low-data datasets.
 *
 * @param   {Array<{lat, lng, weight}>} data
 * @returns {{ lodData, zoom, lodFraction, total }}
 */
export function useLodData(data) {
  const map  = useMap();
  const [zoom, setZoom] = useState(() => map.getZoom());

  useMapEvents({ zoomend: e => setZoom(e.target.getZoom()) });

  // Re-sort only when the underlying data array changes
  const sorted = useMemo(
    () => [...data].sort((a, b) => b.weight - a.weight),
    [data],
  );

  // 60 % at zoom 4, +10 % per zoom step, capped at 100 % from zoom 8 up
  const lodFraction = Math.min(1, 0.60 + Math.max(0, zoom - 4) * 0.10);
  const count       = Math.max(Math.min(5, sorted.length), Math.ceil(sorted.length * lodFraction));

  return {
    lodData:     sorted.slice(0, count),
    sorted,          // full weight-sorted array — stable for global timing
    zoom,
    lodFraction,
    total:       sorted.length,
  };
}
