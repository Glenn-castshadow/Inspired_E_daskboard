export default function StyleSwitcher({ styles, active, onChange }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {styles.map(s => (
          <button
            key={s.id}
            onClick={() => onChange(s.id)}
            className={[
              'flex-1 rounded px-3 py-1.5 text-sm font-medium transition-colors',
              active === s.id
                ? 'bg-blue-600 text-white'
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600',
            ].join(' ')}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
