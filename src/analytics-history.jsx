// src/analytics-history.jsx
//
// Historical analytics view — ported from the zipmap project's PaymentsView,
// adapted to consume live Etsy orders instead of CSV payment exports. Renders
// underneath the current-month section in the Analytics tab and shows all-time
// monthly revenue, top buyers, top products, and orders-by-weekday breakdowns.
//
// Etsy's getShopReceipts response carries gross totals but not fees / net /
// refunds (those live in the Payments report), so the financial-breakdown KPIs
// are hidden in this mode. The component keeps zipmap's CSV/deposits modes
// intact for any future code that wants to pass parsed CSV data — they're
// driven by the `kind` prop.

import { useMemo } from 'react';

// ── Formatters ────────────────────────────────────────────────────────────────
const fmtMoney = (v, currency = 'USD') => {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency, maximumFractionDigits: 0,
    }).format(v ?? 0);
  } catch {
    return `$${Math.round(v ?? 0).toLocaleString()}`;
  }
};

const fmtMoneyPrecise = (v, currency = 'USD') => {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency, maximumFractionDigits: 2,
    }).format(v ?? 0);
  } catch {
    return `$${(v ?? 0).toFixed(2)}`;
  }
};

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmtMonth = (ym) => {
  const [y, m] = ym.split('-');
  return `${MONTH_LABELS[+m - 1]} ${y.slice(2)}`;
};

// Decode HTML entities for Etsy product titles ("&quot;" etc.)
const decodeHtml = (() => {
  const ta = typeof document !== 'undefined' ? document.createElement('textarea') : null;
  return (s) => {
    if (!s || !ta) return s ?? '';
    ta.innerHTML = s;
    return ta.value;
  };
})();

// ── Aggregator: live orders → PaymentsView shape ─────────────────────────────
//
// Returns a `payments` object compatible with PaymentsView. Live orders have no
// fee/refund breakdown, so net === gross and fees/refund stay at 0; the
// PaymentsView hides those KPIs when kind === 'live-orders'.
export function buildPaymentsFromOrders(orders) {
  const totals  = { gross: 0, net: 0, fees: 0, refund: 0, orderCount: 0, avgOrder: 0 };
  const monthMap   = new Map();
  const buyerMap   = new Map();
  const productMap = new Map();
  const weekday    = Array.from({ length: 7 }, () => ({ count: 0, revenue: 0 }));

  for (const o of orders) {
    const value = Number(o.total_price ?? 0);
    if (!Number.isFinite(value)) continue;

    totals.gross      += value;
    totals.net        += value;
    totals.orderCount += 1;

    // Monthly bucket — keyed YYYY-MM. received_date is "YYYY-MM-DD" so the
    // 7-char slice is the bucket key.
    if (typeof o.received_date === 'string' && o.received_date.length >= 7) {
      const ym = o.received_date.slice(0, 7);
      let m = monthMap.get(ym);
      if (!m) { m = { month: ym, gross: 0, net: 0, count: 0 }; monthMap.set(ym, m); }
      m.gross += value;
      m.net   += value;
      m.count += 1;
    }

    // Weekday breakdown — Sun=0..Sat=6
    if (typeof o.received_date === 'string') {
      // Etsy gives us local Y-M-D; build a Date in UTC so server-vs-local-tz
      // doesn't shift the weekday near midnight.
      const [y, m, d] = o.received_date.split('-').map(Number);
      if (y && m && d) {
        const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
        weekday[dow].count   += 1;
        weekday[dow].revenue += value;
      }
    }

    // Top buyers
    const buyer = (o.buyer ?? '').trim() || '—';
    if (buyer !== '—') {
      let b = buyerMap.get(buyer);
      if (!b) { b = { buyer, gross: 0, count: 0 }; buyerMap.set(buyer, b); }
      b.gross += value;
      b.count += 1;
    }

    // Top products
    const productName = decodeHtml(o.product_name ?? '').trim() || '—';
    const key = String(o.listing_id ?? productName);
    let p = productMap.get(key);
    if (!p) {
      p = { name: productName, sku: '', listingId: o.listing_id ?? null,
            quantity: 0, revenue: 0, orderCount: 0 };
      productMap.set(key, p);
    }
    p.quantity   += 1;
    p.revenue    += value;
    p.orderCount += 1;
  }

  totals.avgOrder = totals.orderCount > 0 ? totals.gross / totals.orderCount : 0;

  const months = [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month));
  const topBuyers   = [...buyerMap.values()].sort((a, b) => b.gross - a.gross).slice(0, 10);
  const topProducts = [...productMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10);

  return {
    totals,
    months,
    topBuyers,
    topProducts,
    weekdayBreakdown: weekday,
    currency: 'USD',
  };
}

// ── Main view ────────────────────────────────────────────────────────────────
//
// Accepts either:
//   - `orders` (array)  — aggregates internally; runs in live-orders mode.
//   - `payments` (precomputed shape) + `kind`  — passthrough mode for any
//     future CSV-import integration.

export default function AnalyticsHistory({ orders, payments: precomputed, kind: kindProp }) {
  const payments = useMemo(
    () => precomputed ?? buildPaymentsFromOrders(orders ?? []),
    [precomputed, orders],
  );
  const kind = kindProp ?? (precomputed ? 'orders' : 'live-orders');
  return <PaymentsView payments={payments} kind={kind} />;
}

// ── PaymentsView (verbatim port of zipmap's component, plus live-orders mode) ─

function PaymentsView({ payments, kind = 'orders' }) {
  const { totals, months, topBuyers, topProducts = [], weekdayBreakdown = [], currency } = payments;
  const isDeposits = kind === 'etsy-deposits';
  const isLive     = kind === 'live-orders';
  // Hide net / fees / refunds when the data source doesn't carry them.
  const hideFinancials = isDeposits || isLive;
  const feeRate    = totals.gross > 0 ? (totals.fees   / totals.gross) * 100 : 0;
  const refundRate = totals.gross > 0 ? (totals.refund / totals.gross) * 100 : 0;

  if (totals.orderCount === 0) {
    return (
      <div className="rounded-xl bg-slate-900/70 border border-slate-700/60 p-6 text-center text-sm text-slate-500">
        No orders yet — connect a shop in Fulfillment, then come back.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 text-white">

      {/* KPIs */}
      <div className={`grid gap-3 ${hideFinancials ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-2 md:grid-cols-3 lg:grid-cols-6'}`}>
        <Kpi
          label={isDeposits ? 'Total Deposited' : 'Gross Revenue'}
          value={fmtMoney(totals.gross, currency)}
          accent="text-emerald-400"
        />
        {!hideFinancials && (
          <Kpi label="Net Revenue" value={fmtMoney(totals.net, currency)} accent="text-blue-400" />
        )}
        {!hideFinancials && (
          <Kpi label="Total Fees" value={fmtMoney(totals.fees, currency)} accent="text-amber-400"
               sub={`${feeRate.toFixed(1)}% of gross`} />
        )}
        <Kpi
          label={isDeposits ? 'Deposits' : 'Orders'}
          value={totals.orderCount.toLocaleString()}
          accent="text-violet-400"
        />
        <Kpi
          label={isDeposits ? 'Avg Deposit' : 'Avg Order'}
          value={fmtMoneyPrecise(totals.avgOrder, currency)}
          accent="text-cyan-400"
        />
        {!hideFinancials && (
          <Kpi label="Refunds" value={fmtMoney(totals.refund, currency)} accent="text-rose-400"
               sub={refundRate > 0 ? `${refundRate.toFixed(1)}% of gross` : 'none'} />
        )}
        {isDeposits && months.length > 0 && (
          <Kpi label="Months Covered" value={months.length.toLocaleString()} accent="text-fuchsia-400" />
        )}
        {isLive && months.length > 0 && (
          <Kpi label="Months Covered" value={months.length.toLocaleString()} accent="text-fuchsia-400" />
        )}
      </div>

      {/* Monthly chart */}
      <Panel title={isDeposits ? 'Monthly Deposits' : 'Monthly Revenue'}>
        {months.length > 0
          ? <MonthlyChart months={months} currency={currency} showNet={!isLive && !isDeposits} />
          : <Empty>No dated orders.</Empty>}
      </Panel>

      {/* Top buyers + weekday donut */}
      {(topBuyers.length > 0 || weekdayBreakdown.some(d => d.count > 0)) && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {topBuyers.length > 0 && (
            <div className="lg:col-span-2">
              <Panel title="Top Buyers">
                <TopBuyersTable buyers={topBuyers} currency={currency} />
              </Panel>
            </div>
          )}
          {weekdayBreakdown.some(d => d.count > 0) && (
            <div className={topBuyers.length > 0 ? '' : 'lg:col-span-3'}>
              <Panel title={isDeposits ? 'Deposits by Weekday' : 'Orders by Weekday'}>
                <WeekdayChart days={weekdayBreakdown} currency={currency} />
              </Panel>
            </div>
          )}
        </div>
      )}

      {/* Top products */}
      {topProducts.length > 0 && (
        <Panel title="Top 10 Products">
          <TopProductsTable products={topProducts} currency={currency} />
        </Panel>
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function Kpi({ label, value, accent, sub }) {
  return (
    <div className="rounded-lg bg-slate-800/80 border border-slate-700/60 px-3 py-2.5 flex flex-col">
      <span className="text-xs uppercase tracking-wide text-slate-400 leading-none">{label}</span>
      <span className={`text-2xl font-bold tabular-nums mt-1.5 ${accent}`}>{value}</span>
      {sub && <span className="text-[10px] text-slate-500 mt-0.5">{sub}</span>}
    </div>
  );
}

function Panel({ title, children }) {
  return (
    <section className="rounded-xl bg-slate-900/70 border border-slate-700/60 p-4 flex flex-col gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ children }) {
  return <p className="text-sm text-slate-500 py-4 text-center">{children}</p>;
}

function MonthlyChart({ months, currency, showNet = true }) {
  const W = 720, H = 240;
  const padL = 56, padR = 16, padT = 12, padB = 32;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const maxGross = Math.max(1, ...months.map(m => m.gross));
  const barGap = 4;
  const barW = Math.max(6, (innerW / months.length) - barGap);

  const ticks = [0, 0.25, 0.5, 0.75, 1].map(t => ({
    y: padT + innerH - innerH * t,
    label: fmtMoney(maxGross * t, currency),
  }));

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" preserveAspectRatio="xMidYMid meet">
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={t.y} y2={t.y}
                  stroke="rgba(148,163,184,0.15)" strokeDasharray="2 3" />
            <text x={padL - 8} y={t.y + 4} textAnchor="end"
                  className="fill-slate-500" style={{ fontSize: 10 }}>
              {t.label}
            </text>
          </g>
        ))}

        {months.map((m, i) => {
          const x = padL + i * (barW + barGap);
          const grossH = (m.gross / maxGross) * innerH;
          const netH   = (m.net   / maxGross) * innerH;
          return (
            <g key={m.month}>
              <rect x={x} y={padT + innerH - grossH}
                    width={barW} height={grossH}
                    fill={showNet ? 'rgba(52,211,153,0.22)' : 'rgb(52,211,153)'} rx="2" />
              {showNet && (
                <rect x={x} y={padT + innerH - netH}
                      width={barW} height={netH}
                      fill="rgb(96,165,250)" rx="2" />
              )}
              <title>
                {showNet
                  ? `${fmtMonth(m.month)}\nGross: ${fmtMoneyPrecise(m.gross, currency)}\nNet: ${fmtMoneyPrecise(m.net, currency)}\nOrders: ${m.count}`
                  : `${fmtMonth(m.month)}\nRevenue: ${fmtMoneyPrecise(m.gross, currency)}\nOrders: ${m.count}`}
              </title>
            </g>
          );
        })}

        {months.map((m, i) => {
          if (months.length > 18 && i % 2 !== 0) return null;
          const x = padL + i * (barW + barGap) + barW / 2;
          return (
            <text key={m.month} x={x} y={H - padB + 14} textAnchor="middle"
                  className="fill-slate-500" style={{ fontSize: 10 }}>
              {fmtMonth(m.month)}
            </text>
          );
        })}
      </svg>

      {showNet && (
        <div className="flex gap-4 mt-2 px-2 text-xs">
          <LegendChip color="rgba(52,211,153,0.6)" label="Gross" />
          <LegendChip color="rgb(96,165,250)"      label="Net" />
        </div>
      )}
    </div>
  );
}

function LegendChip({ color, label }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="inline-block w-3 h-3 rounded-sm" style={{ background: color }} />
      <span className="text-slate-400">{label}</span>
    </div>
  );
}

function TopBuyersTable({ buyers, currency }) {
  const maxGross = Math.max(...buyers.map(b => b.gross));
  return (
    <div className="flex flex-col gap-1">
      {buyers.map((b, i) => {
        const pct = (b.gross / maxGross) * 100;
        return (
          <div key={b.buyer + i} className="flex items-center gap-3 text-xs">
            <span className="text-slate-600 w-5 text-right tabular-nums">{i + 1}</span>
            <span className="w-44 truncate text-slate-200" title={b.buyer}>{b.buyer}</span>
            <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
              <div className="h-full bg-gradient-to-r from-blue-500 to-emerald-400" style={{ width: `${pct}%` }} />
            </div>
            <span className="w-20 text-right tabular-nums text-slate-200">{fmtMoneyPrecise(b.gross, currency)}</span>
            <span className="w-12 text-right tabular-nums text-slate-500">{b.count}×</span>
          </div>
        );
      })}
    </div>
  );
}

function TopProductsTable({ products, currency }) {
  const maxRevenue = Math.max(...products.map(p => p.revenue), 1);
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3 text-[10px] uppercase tracking-widest text-slate-500 pb-2 border-b border-slate-800 mb-1">
        <span className="w-5 text-right">#</span>
        <span className="flex-1">Product</span>
        <span className="w-16 text-right">Units</span>
        <span className="w-20 text-right">Revenue</span>
        <span className="w-14 text-right">Orders</span>
      </div>
      {products.map((p, i) => {
        const pct = (p.revenue / maxRevenue) * 100;
        return (
          <div key={(p.listingId || p.sku || '') + p.name + i} className="flex items-center gap-3 text-xs py-1.5 border-b border-slate-800/60 last:border-0">
            <span className="text-slate-600 w-5 text-right tabular-nums">{i + 1}</span>
            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
              <span className="truncate text-slate-200" title={p.name}>{p.name}</span>
              <div className="h-1 bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-violet-500 to-amber-400" style={{ width: `${pct}%` }} />
              </div>
            </div>
            <span className="w-16 text-right tabular-nums text-slate-200">{p.quantity.toLocaleString()}</span>
            <span className="w-20 text-right tabular-nums text-emerald-400">{fmtMoneyPrecise(p.revenue, currency)}</span>
            <span className="w-14 text-right tabular-nums text-slate-500">{p.orderCount}×</span>
          </div>
        );
      })}
    </div>
  );
}

function WeekdayChart({ days, currency }) {
  const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const COLORS = ['#60a5fa', '#34d399', '#a78bfa', '#fbbf24', '#f472b6', '#94a3b8', '#64748b'];

  const total = days.reduce((s, d) => s + (d?.count ?? 0), 0);
  if (total === 0) return <Empty>No orders in range.</Empty>;

  const slices = DISPLAY_ORDER.map((dow, di) => {
    const d = days[dow] ?? { count: 0, revenue: 0 };
    return { dow, label: DOW_LABELS[dow], count: d.count, revenue: d.revenue,
             pct: d.count / total, color: COLORS[di], isWeekend: dow === 0 || dow === 6 };
  });

  const cx = 90, cy = 90, outerR = 78, innerR = 42;
  let angle = -Math.PI / 2;
  const arcs = slices.map(s => {
    const start = angle;
    const sweep = s.pct * 2 * Math.PI;
    angle += sweep;
    if (sweep < 0.001) return { ...s, path: null };
    const large = sweep > Math.PI ? 1 : 0;
    const cos = (a) => Math.cos(a), sin = (a) => Math.sin(a);
    const path = [
      `M ${cx + outerR * cos(start)} ${cy + outerR * sin(start)}`,
      `A ${outerR} ${outerR} 0 ${large} 1 ${cx + outerR * cos(angle)} ${cy + outerR * sin(angle)}`,
      `L ${cx + innerR * cos(angle)} ${cy + innerR * sin(angle)}`,
      `A ${innerR} ${innerR} 0 ${large} 0 ${cx + innerR * cos(start)} ${cy + innerR * sin(start)}`,
      'Z',
    ].join(' ');
    return { ...s, path };
  });

  return (
    <div className="flex flex-col sm:flex-row items-center gap-4">
      <svg viewBox="0 0 180 180" className="w-40 h-40 shrink-0">
        {arcs.map(a => a.path && (
          <path key={a.dow} d={a.path} fill={a.color} opacity={a.isWeekend ? 0.55 : 0.9}>
            <title>{`${a.label} — ${a.count} order${a.count !== 1 ? 's' : ''} (${(a.pct * 100).toFixed(1)}%)\n${fmtMoneyPrecise(a.revenue, currency)}`}</title>
          </path>
        ))}
        <text x={cx} y={cy - 5} textAnchor="middle" fill="#e2e8f0" style={{ fontSize: 20, fontWeight: 700 }}>{total}</text>
        <text x={cx} y={cy + 11} textAnchor="middle" fill="#64748b" style={{ fontSize: 9, letterSpacing: 1 }}>ORDERS</text>
      </svg>

      <div className="flex flex-col gap-1.5 w-full">
        {arcs.map(a => a.count > 0 && (
          <div key={a.dow} className="flex items-center gap-2 text-xs">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: a.color, opacity: a.isWeekend ? 0.55 : 0.9 }} />
            <span className={a.isWeekend ? 'text-slate-500 w-7' : 'text-slate-300 w-7'}>{a.label}</span>
            <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${a.pct * 100}%`, background: a.color, opacity: a.isWeekend ? 0.55 : 0.9 }} />
            </div>
            <span className="text-slate-400 tabular-nums w-8 text-right">{a.count}</span>
            <span className="text-slate-600 tabular-nums w-9 text-right">{(a.pct * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
