const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'D.C.',
};

function buildInsights(topStates, total, topZip, stateCount) {
  const lines = [];
  if (topStates.length > 0) {
    const { state, count } = topStates[0];
    const pct = Math.round((count / total) * 100);
    lines.push(`${STATE_NAMES[state] ?? state} leads with ${pct}% of orders.`);
  }
  if (topZip) {
    const { zip, city, count } = topZip;
    const place = city ? `${zip} (${city})` : zip;
    lines.push(`Top ZIP: ${place} · ${count.toLocaleString()} orders.`);
  }
  if (stateCount > 0) {
    lines.push(`Orders span ${stateCount} state${stateCount !== 1 ? 's' : ''}.`);
  }
  return lines;
}

export default function TopStatesPanel({ topStates, total, topZip, stateCount }) {
  if (!topStates.length) return null;
  const insights = buildInsights(topStates, total, topZip, stateCount);

  return (
    <div className="absolute bottom-6 right-4 w-52 max-h-[calc(100%-3rem)] overflow-y-auto bg-slate-900/90 backdrop-blur rounded-xl border border-slate-700 shadow-xl text-sm z-[1100]">
      <div className="px-3 pt-3 pb-1.5">
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Top States</p>
      </div>

      <div className="px-3 pb-2 flex flex-col gap-1.5">
        {topStates.map(({ state, count }, i) => {
          const pct = Math.round((count / total) * 100);
          return (
            <div key={state} className="flex items-center gap-2">
              <span className="text-slate-600 text-xs w-4 text-right shrink-0">{i + 1}</span>
              <span className="flex-1 text-slate-200 text-xs truncate">{STATE_NAMES[state] ?? state}</span>
              <span className="text-slate-400 tabular-nums text-xs">{pct}%</span>
            </div>
          );
        })}
      </div>

      <div className="border-t border-slate-700/80 px-3 pt-2 pb-3 flex flex-col gap-1">
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-0.5">Insights</p>
        {insights.map((line, i) => (
          <p key={i} className="text-xs text-slate-400 leading-relaxed">{line}</p>
        ))}
      </div>
    </div>
  );
}
