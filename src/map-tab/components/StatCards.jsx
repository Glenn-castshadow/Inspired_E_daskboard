export default function StatCards({ total, matched, stateCount }) {
  return (
    <div className="flex gap-2 px-4 py-2.5 bg-slate-800/95 border-b border-slate-700/80 shrink-0">
      <Card label="Total Orders" value={total.toLocaleString()} accent="text-blue-400" />
      <Card label="Unique ZIPs" value={matched.toLocaleString()} accent="text-emerald-400" />
      <Card label="States Reached" value={stateCount > 0 ? stateCount : '—'} accent="text-violet-400" />
    </div>
  );
}

function Card({ label, value, accent }) {
  return (
    <div className="flex-1 rounded-lg bg-slate-700/50 px-3 py-2 flex flex-col">
      <span className="text-xs text-slate-400 leading-none">{label}</span>
      <span className={`text-2xl font-bold tabular-nums mt-1 ${accent}`}>{value}</span>
    </div>
  );
}
