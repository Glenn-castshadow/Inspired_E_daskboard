const SCALES = [
  { id: 'linear', label: 'Linear' },
  { id: 'log',    label: 'Log'    },
  { id: 'rank',   label: 'Rank'   },
];

const HINTS = {
  linear: 'Proportional to order count.',
  log:    'Spreads low counts across the gradient.',
  rank:   'Percentile — always fills the full color range.',
};

export default function ScaleSwitcher({ active, onChange }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1.5">
        {SCALES.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => onChange(id)}
            className={[
              'flex-1 rounded px-2 py-1.5 text-xs font-medium transition-colors',
              active === id
                ? 'bg-blue-600 text-white'
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600',
            ].join(' ')}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="text-xs text-slate-500 leading-relaxed">{HINTS[active]}</p>
    </div>
  );
}
