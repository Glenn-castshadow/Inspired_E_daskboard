export default function OriginInput({ value, onChange, isValid }) {
  const filled = value.length === 5;

  return (
    <div className="flex flex-col gap-2">
      <input
        type="text"
        inputMode="numeric"
        maxLength={5}
        value={value}
        placeholder="Your shop ZIP"
        onChange={e => onChange(e.target.value.replace(/\D/g, ''))}
        className={[
          'bg-slate-800 border rounded px-3 py-1.5 text-sm text-slate-200',
          'focus:outline-none focus:ring-1',
          filled
            ? isValid
              ? 'border-emerald-600 focus:ring-emerald-500'
              : 'border-red-600 focus:ring-red-500'
            : 'border-slate-600 focus:ring-blue-500',
        ].join(' ')}
      />
      {filled && !isValid && (
        <p className="text-xs text-red-400">ZIP not found</p>
      )}
    </div>
  );
}
