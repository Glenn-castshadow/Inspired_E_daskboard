import { useEffect, useMemo, useRef, useState } from 'react';
import Globe from 'react-globe.gl';
import { heatGradients, defaultGradient } from '../mapStyles/heatGradients.js';

const EARTH_TEX = '//unpkg.com/three-globe/example/img/earth-night.jpg';
const SKY_TEX   = '//unpkg.com/three-globe/example/img/night-sky.png';

// Replace the alpha in an hsla() string — used to set arc fade colours
function withAlpha(hslaStr, alpha) {
  return hslaStr.replace(/,[\d.]+\)$/, `,${alpha})`);
}

export default function GlobeView({ data, origin, showSpikes = true, showArcs = true, showOrigin = true, arcsAnimated = true, gradientId = 'spectrum', onZipClick }) {
  const globeRef     = useRef(null);
  const containerRef = useRef(null);
  const initRef      = useRef(false);          // guard: configure controls only ONCE
  const [dims, setDims] = useState({ w: 0, h: 0 });

  const gradient = heatGradients.find(g => g.id === gradientId) ?? defaultGradient;

  // Track container size so the canvas fills the flex area.
  // CRITICAL: we IGNORE zero-size events — otherwise layout reflows would push
  // dims to {0,0}, which (via the `dims.w > 0` gate below) unmounted the entire
  // <Globe>.  Every remount created a fresh Three.js scene and re-fired
  // onGlobeReady, which flew the camera back to USA — that was the "constantly
  // recentered" behaviour.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const w = Math.round(width);
      const h = Math.round(height);
      if (w === 0 || h === 0) return; // don't propagate transient zeros
      setDims(prev => (prev.w === w && prev.h === h ? prev : { w, h }));
    });
    ro.observe(el);
    const w0 = el.clientWidth, h0 = el.clientHeight;
    if (w0 > 0 && h0 > 0) setDims({ w: w0, h: h0 });
    return () => ro.disconnect();
  }, []);

  // Fires once when the globe texture has loaded.  Guarded against repeat
  // firings (which would re-fly the camera back to centre — the "recentering"
  // the user was seeing).
  function handleGlobeReady() {
    if (initRef.current) return;
    initRef.current = true;

    const g = globeRef.current;
    if (!g) return;

    // One-time fly to USA
    g.pointOfView({ lat: 38, lng: -96, altitude: 2.1 }, 1200);

    // Configure the OrbitControls (controlType="orbit" set on <Globe> below)
    const ctrl = g.controls();
    if (!ctrl) return;

    // CRITICAL: damping off.  With damping, OrbitControls applies a decaying
    // velocity each frame — this was the source of the "constantly recentered"
    // behaviour because pan deltas got smoothed back toward equilibrium.
    ctrl.enableDamping = false;

    // No auto-rotate — was also fighting manual positioning
    ctrl.autoRotate = false;

    ctrl.rotateSpeed        = 0.5;
    ctrl.zoomSpeed          = 0.7;
    ctrl.enablePan          = true;
    ctrl.panSpeed           = 1.5;
    ctrl.screenSpacePanning = true;

    // Explicit mouse buttons (OrbitControls defaults are already these, but
    // be defensive in case three-globe touched them)
    if (ctrl.mouseButtons) {
      ctrl.mouseButtons.LEFT   = 0; // ROTATE
      ctrl.mouseButtons.MIDDLE = 1; // DOLLY
      ctrl.mouseButtons.RIGHT  = 2; // PAN
    }
    if (ctrl.touches) {
      ctrl.touches.ONE = 0; // ROTATE
      ctrl.touches.TWO = 2; // PAN
    }

    // ── PAN FIX ───────────────────────────────────────────────────────────
    // three-globe registers an internal 'change' listener on the controls
    // that calls `controls.target.setScalar(0)` on every change event,
    // forcibly re-centering the target at the origin.  That is what makes
    // right-click pan feel like it "doesn't work" / "snaps back" — pan moves
    // the target, then three-globe immediately slams it back to (0,0,0).
    //
    // We neuter that one line by stubbing `target.setScalar` on this Vector3
    // instance.  The rest of three-globe's change listener (altitude-based
    // rotate/zoom speed, layer pointOfView updates, onZoom callback) is
    // untouched — only the target reset is disabled, allowing real pan.
    //
    // We also raise maxTargetRadius (default null → causes clampLength to
    // collapse the target to zero length) so the target can move freely.
    ctrl.maxTargetRadius = Infinity;

    // Apply the setScalar stub after pointOfView's 1200ms fly-to animation
    // completes — during the animation three-globe may swap or reset target,
    // wiping any patch we install synchronously.
    const installPanFix = () => {
      // Find and remove three-globe's change listener that resets target
      const changeListeners = ctrl._listeners && ctrl._listeners.change;
      if (changeListeners) {
        const offenderIdx = changeListeners.findIndex(fn =>
          fn.toString().includes('target.setScalar(0)')
        );
        if (offenderIdx >= 0) {
          const offender = changeListeners[offenderIdx];
          // Wrap it: run the original body but suppress target.setScalar(0)
          changeListeners[offenderIdx] = function wrapped() {
            const orig = ctrl.target.setScalar;
            ctrl.target.setScalar = function () { /* swallow */ };
            try { offender.call(this); } finally { ctrl.target.setScalar = orig; }
          };
        }
      }
    };
    setTimeout(installPanFix, 1500);
  }

  const rings = useMemo(
    () => (showOrigin && origin ? [{ lat: origin.lat, lng: origin.lng }] : []),
    [showOrigin, origin?.lat, origin?.lng],
  );

  // Ring color: pull from the active gradient's hot end so the pulsing
  // halo matches the heat scheme.  Returning a function gives a t-parameter
  // (0..1) propagation fade so the ring smoothly disappears at its edge.
  const ringHotColor = gradient.center(0.95);
  const ringColorFn = useMemo(
    () => () => (t) => withAlpha(ringHotColor, (1 - t) * 0.85),
    [ringHotColor],
  );

  // Arcs: origin → each customer ZIP (hidden when showArcs is off or no origin).
  // Memoized so we don't hand react-globe.gl a brand-new array on every render,
  // which would force it to rebuild arc meshes (potential camera-state side effects).
  const arcs = useMemo(() => {
    if (!showArcs || !origin) return [];
    return data
      .filter(d =>
        Math.abs(d.lat - origin.lat) > 0.05 ||
        Math.abs(d.lng - origin.lng) > 0.05
      )
      .map(d => {
        const baseColor = gradient.center(d.weight);
        return {
          startLat: origin.lat,
          startLng: origin.lng,
          endLat:   d.lat,
          endLng:   d.lng,
          weight:   d.weight,
          color:    [withAlpha(baseColor, 0.12), withAlpha(baseColor, 0.88)],
        };
      });
  }, [data, origin?.lat, origin?.lng, showArcs, gradient]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full bg-slate-950"
      onContextMenu={e => e.preventDefault()}
    >
      {dims.w > 0 && dims.h > 0 && (
        <Globe
          ref={globeRef}
          width={dims.w}
          height={dims.h}
          onGlobeReady={handleGlobeReady}
          controlType="orbit"

          // ── Globe surface ───────────────────────────────────────────────
          globeImageUrl={EARTH_TEX}
          backgroundImageUrl={SKY_TEX}
          atmosphereColor="rgba(63,120,255,0.28)"
          atmosphereAltitude={0.14}

          // ── Data points — coloured spikes per ZIP ───────────────────────
          pointsData={showSpikes ? data : []}
          pointLat="lat"
          pointLng="lng"
          pointAltitude={d => 0.005 + d.weight * 0.09}
          pointRadius={d => 0.18 + d.weight * 0.52}
          pointColor={d => gradient.center(d.weight)}
          pointsMerge={false}
          pointResolution={6}
          onPointClick={onZipClick ? (d => d?.zip && onZipClick(d.zip)) : undefined}

          // ── Origin ring — pulsing gold halo at shop ZIP ─────────────────
          ringsData={rings}
          ringLat="lat"
          ringLng="lng"
          ringMaxRadius={4.5}
          ringPropagationSpeed={2.5}
          ringRepeatPeriod={900}
          ringColor={ringColorFn}
          ringAltitude={0.003}

          // ── Shipping arcs — origin → each customer ZIP ───────────────────
          arcsData={arcs}
          arcStartLat="startLat"
          arcStartLng="startLng"
          arcEndLat="endLat"
          arcEndLng="endLng"
          arcColor="color"
          arcAltitudeAutoScale={0.35}
          arcStroke={d => 0.2 + d.weight * 0.7}
          arcDashLength={arcsAnimated ? 0.45 : 1}
          arcDashGap={arcsAnimated ? 0.2 : 0}
          arcDashAnimateTime={arcsAnimated ? 2200 : 0}
        />
      )}
    </div>
  );
}
