/**
 * Floating popup showing per-ZIP detail when the user clicks a map marker.
 * Displays: location, KPIs, top customers, top SKUs, recent orders.
 *
 * Props:
 *   detail — entry from aggregateZipDetails(), or null to hide
 *   onClose — called when the user dismisses
 */

const STATE_NAMES = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',
  CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',
  IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',
  ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',
  MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',
  NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',
  NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',
  PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',
  TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',
  WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',DC:'District of Columbia',
};

const fmtMoney = (v) => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v ?? 0);
  } catch {
    return `$${Math.round(v ?? 0).toLocaleString()}`;
  }
};

export default function ZipDetailPopup({ detail, onClose }) {
  if (!detail) return null;

  const stateName = STATE_NAMES[detail.state] ?? detail.state;
  const orderCount = detail.orders.length;
  const avgValue   = orderCount > 0 ? detail.totalValue / orderCount : 0;

  // Pre-sort top customers / SKUs by frequency in orders
  const customerCount = new Map();
  const skuCount      = new Map();
  for (const o of detail.orders) {
    if (o.customer && o.customer !== '—') customerCount.set(o.customer, (customerCount.get(o.customer) ?? 0) + 1);
    if (o.sku)      skuCount.set(o.sku, (skuCount.get(o.sku) ?? 0) + (o.items || 1));
  }
  const topCustomers = [...customerCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const topSkus      = [...skuCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  return (
    <div className="absolute top-4 left-4 z-[1200] w-80 max-h-[calc(100%-2rem)] bg-slate-900/95 backdrop-blur border border-slate-700 rounded-lg shadow-2xl flex flex-col overflow-hidden">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-2 px-4 py-3 border-b border-slate-700">
        <div className="min-w-0">
          <div className="text-base font-bold text-white tabular-nums">{detail.zip}</div>
          <div className="text-xs text-slate-400 truncate">
            {[detail.city, stateName].filter(Boolean).join(', ') || '—'}
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-slate-500 hover:text-white transition-colors text-xl leading-none flex-shrink-0 w-5 h-5 flex items-center justify-center"
          aria-label="Close"
        >×</button>
      </div>

      {/* ── KPIs ── */}
      <div className="grid grid-cols-3 gap-px bg-slate-700">
        <Kpi label="Orders"   value={orderCount.toLocaleString()} accent="text-blue-400" />
        <Kpi label="Revenue"  value={fmtMoney(detail.totalValue)} accent="text-emerald-400" />
        <Kpi label="Items"    value={detail.totalItems.toLocaleString()} accent="text-violet-400" />
      </div>
      {orderCount > 1 && (
        <div className="px-4 py-2 text-[11px] text-slate-500 border-b border-slate-800 bg-slate-900">
          Avg order {fmtMoney(avgValue)} · {detail.customers.size} unique buyer{detail.customers.size !== 1 ? 's' : ''}
        </div>
      )}

      {/* ── Scrollable body ── */}
      <div className="flex-1 overflow-y-auto">
        {topCustomers.length > 0 && (
          <Section title="Top Customers">
            {topCustomers.map(([name, n]) => (
              <Row key={name} left={name} right={`${n} order${n !== 1 ? 's' : ''}`} />
            ))}
          </Section>
        )}

        {topSkus.length > 0 && (
          <Section title="Top Products">
            {topSkus.map(([prod, qty]) => (
              <Row key={prod} left={prod} right={`${qty}×`} />
            ))}
          </Section>
        )}

        <Section title={`Recent Orders (${orderCount})`}>
          {detail.orders.slice(0, 8).map((o, i) => (
            <div key={i} className="text-xs flex items-center gap-2 py-1">
              <span className="text-slate-500 tabular-nums w-20 flex-shrink-0">{o.date ?? '—'}</span>
              <span className="text-slate-200 truncate flex-1" title={o.customer}>{o.customer}</span>
              <span className="text-emerald-400 tabular-nums flex-shrink-0">{fmtMoney(o.total)}</span>
            </div>
          ))}
          {orderCount > 8 && (
            <p className="text-[10px] text-slate-500 pt-1 italic">…and {orderCount - 8} more</p>
          )}
        </Section>
      </div>
    </div>
  );
}

function Kpi({ label, value, accent }) {
  return (
    <div className="bg-slate-900 px-2 py-2 text-center">
      <div className={`text-sm font-bold tabular-nums ${accent}`}>{value}</div>
      <div className="text-[10px] text-slate-500 uppercase tracking-wider">{label}</div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="border-b border-slate-800 px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 mb-2">{title}</div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function Row({ left, right }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-slate-200 truncate flex-1" title={left}>{left}</span>
      <span className="text-slate-500 tabular-nums flex-shrink-0">{right}</span>
    </div>
  );
}
