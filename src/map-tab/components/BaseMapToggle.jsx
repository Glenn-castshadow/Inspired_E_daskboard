export default function BaseMapToggle({ active, onChange }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1.5">
        <Btn label="Flat" active={active === 'flat'} onClick={() => onChange('flat')} />
        <Btn label="🌐 Globe" active={active === 'globe'} onClick={() => onChange('globe')} />
      </div>
    </div>
  );
}

function Btn({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={[
        'flex-1 rounded px-2 py-1.5 text-xs font-medium transition-colors',
        active
          ? 'bg-blue-600 text-white'
          : 'bg-slate-700 text-slate-300 hover:bg-slate-600',
      ].join(' ')}
    >
      {label}
    </button>
  );
}
