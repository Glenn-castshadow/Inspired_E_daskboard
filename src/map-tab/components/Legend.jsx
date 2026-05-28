export default function Legend({ unmatched }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div
          className="h-2.5 w-full rounded"
          style={{ background: 'linear-gradient(to right, #0000ff, #00ffff, #ffff00, #ff0000)' }}
        />
        <div className="flex justify-between text-xs text-slate-500">
          <span>Low</span>
          <span>High</span>
        </div>
      </div>
      {unmatched > 0 && (
        <p className="text-xs text-slate-500">
          {unmatched.toLocaleString()} unrecognized ZIP{unmatched !== 1 ? 's' : ''} skipped
        </p>
      )}
    </div>
  );
}
