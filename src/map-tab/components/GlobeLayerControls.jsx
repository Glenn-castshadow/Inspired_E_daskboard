import { heatGradients } from '../mapStyles/heatGradients.js';

export default function GlobeLayerControls({
  showSpikes,   onSpikes,
  showArcs,     onArcs,
  showOrigin,   onOrigin,
  arcsAnimated, onArcsAnimated,
  hasOrigin,
  gradientId,   onGradient,
}) {
  return (
    <div className="flex flex-col gap-3">
      {/* ── Layer toggles ── */}
      <div className="flex flex-col gap-2">
        <div className="flex gap-1.5">
          <Toggle label="Spikes" active={showSpikes} onClick={() => onSpikes(!showSpikes)} />
          <Toggle
            label="Arcs"
            active={showArcs}
            onClick={() => onArcs(!showArcs)}
            disabled={!hasOrigin}
            title={!hasOrigin ? 'Enter a shop ZIP to enable arcs' : undefined}
          />
          <Toggle
            label="Origin"
            active={showOrigin}
            onClick={() => onOrigin(!showOrigin)}
            disabled={!hasOrigin}
            title={!hasOrigin ? 'Enter a shop ZIP to enable origin ring' : undefined}
          />
        </div>
        {showArcs && hasOrigin && (
          <div className="flex gap-1.5">
            <Toggle label="Animated" active={arcsAnimated}  onClick={() => onArcsAnimated(true)}  />
            <Toggle label="Solid"    active={!arcsAnimated} onClick={() => onArcsAnimated(false)} />
          </div>
        )}
      </div>

      {/* ── Gradient picker — always visible ── */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold uppercase tracking-widest text-slate-500">
          Color Scheme
        </span>
        <div className="grid grid-cols-2 gap-1.5">
          {heatGradients.map(g => {
            const isActive = g.id === gradientId;
            const gradient = `linear-gradient(to right, ${g.swatch.join(', ')})`;
            return (
              <button
                key={g.id}
                onClick={() => onGradient(g.id)}
                title={g.label}
                className={[
                  'rounded overflow-hidden text-left transition-all',
                  isActive
                    ? 'ring-2 ring-blue-400 ring-offset-1 ring-offset-[#061526]'
                    : 'opacity-70 hover:opacity-100',
                ].join(' ')}
              >
                <div className="h-4 w-full" style={{ background: gradient }} />
                <div className={[
                  'px-1 py-0.5 text-[10px] leading-tight truncate',
                  isActive ? 'text-white bg-slate-700' : 'text-slate-400 bg-slate-800',
                ].join(' ')}>
                  {g.label}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Toggle({ label, active, onClick, disabled, title }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        'flex-1 rounded px-2 py-1.5 text-xs font-medium transition-colors',
        disabled
          ? 'bg-slate-800 text-slate-600 cursor-not-allowed'
          : active
            ? 'bg-blue-600 text-white'
            : 'bg-slate-700 text-slate-300 hover:bg-slate-600',
      ].join(' ')}
    >
      {label}
    </button>
  );
}
