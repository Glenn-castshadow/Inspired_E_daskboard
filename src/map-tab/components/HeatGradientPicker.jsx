import { heatGradients } from '../mapStyles/heatGradients.js';

export default function HeatGradientPicker({ active, onChange }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-1.5">
        {heatGradients.map(g => {
          const isActive = g.id === active;
          const gradient = `linear-gradient(to right, ${g.swatch.join(', ')})`;
          return (
            <button
              key={g.id}
              onClick={() => onChange(g.id)}
              title={g.label}
              className={[
                'rounded overflow-hidden text-left transition-all',
                isActive
                  ? 'ring-2 ring-blue-400 ring-offset-1 ring-offset-[#061526]'
                  : 'opacity-70 hover:opacity-100',
              ].join(' ')}
            >
              <div
                className="h-4 w-full"
                style={{ background: gradient }}
              />
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
  );
}
