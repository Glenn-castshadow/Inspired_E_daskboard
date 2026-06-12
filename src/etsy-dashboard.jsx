import { useState, useMemo, useEffect, useCallback } from "react";
import {
  AreaChart, Area, BarChart, Bar, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { SHOP_META, SHOP_IDS } from "./config";
import { categoryLabel } from "./taxonomy.js";
import AnalyticsHistory from "./analytics-history.jsx";
import { PageHeader, PageShell, ghostButtonStyle } from "./ui.jsx";

const isTauri = typeof window !== "undefined" && Boolean(window.__TAURI__);


// Decode HTML entities in Etsy-sourced strings (Etsy sometimes returns &quot;, &amp;, etc.)
const decodeHtml = (() => {
  const ta = typeof document !== "undefined" ? document.createElement("textarea") : null;
  return (s) => {
    if (!s || !ta) return s ?? "";
    ta.innerHTML = s;
    return ta.value;
  };
})();

const SHOP_NAMES = {
  7438218:  "csdesigninc",
  22660031: "bitterchimp",
  6807617:  "gkdesignhaus",
};

// ── Dev mock — deterministic seeded PRNG so results are stable on reload ──────

function seeded(seed) {
  let s = seed;
  return () => {
    s = Math.imul(s ^ (s >>> 15), s | 1);
    s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
    return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
  };
}

const MOCK_ORDERS = (() => {
  const rand = seeded(42);
  const products = [
    "Driftwood Wall Hanging",
    "Reclaimed Wood Shelf",
    "Hand-Poured Soy Candle",
    "Ceramic Bud Vase Set",
    "Woven Jute Table Runner",
  ];
  const shops = [7438218, 22660031, 6807617];
  const orders = [];
  let id = 4700;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (let day = 29; day >= 0; day--) {
    const d = new Date(today); d.setDate(d.getDate() - day);
    const iso = d.toISOString().slice(0, 10);
    const count = Math.floor(rand() * 2.5) + 1;
    for (let j = 0; j < count; j++) {
      orders.push({
        id: `IE-${id}`, receipt_id: String(id++),
        product_name: products[Math.floor(rand() * products.length)],
        finish: "Natural",
        due_date: iso, received_date: iso,
        status: day > 7 ? "completed" : "open",
        postage_printed: day > 7,
        details: { hanging_holes: 0, special_instructions: "" },
        buyer: "Mock Buyer",
        shop_id: shops[Math.floor(rand() * shops.length)],
        total_price: Math.round((25 + rand() * 120) * 100) / 100,
        tracking_code: null,
      });
    }
  }
  return orders;
})();

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmtRevenue = (v) =>
  "$" + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const fmtRevenueShort = (v) =>
  v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`;

// ── Date-range helpers ──────────────────────────────────────────────────────
// Orders carry received_date as "YYYY-MM-DD" — string comparison is
// chronological and timezone-safe.
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); }
function daysBetween(a, b) {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}
const round2 = (v) => Math.round(v * 100) / 100;

const DATE_PRESETS = [
  { id: "all",  label: "All time"     },
  { id: "30d",  label: "30 days"      },
  { id: "90d",  label: "90 days"      },
  { id: "12mo", label: "12 months"    },
  { id: "ytd",  label: "Year to date" },
];

function labelDay(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function labelMonth(ym) {
  const d = new Date(ym + "-01T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function DateRangeControl({ preset, from, to, onPreset, onFrom, onTo, onClear }) {
  const chip = (active) => ({
    fontFamily: "'DM Sans', sans-serif", fontSize: 12, fontWeight: 500,
    padding: "5px 12px", borderRadius: 999, cursor: "pointer", whiteSpace: "nowrap",
    border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
    background: active ? "var(--accent)" : "var(--bg-surface)",
    color: active ? "#fff" : "var(--text-muted)",
  });
  const dateInput = {
    fontFamily: "'DM Sans', sans-serif", fontSize: 12,
    padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border)",
    background: "var(--bg-surface)", color: "var(--text)",
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 7, alignItems: "center" }}>
      {DATE_PRESETS.map(p => (
        <button key={p.id} style={chip(preset === p.id)}
          onClick={() => onPreset(p.id)}>{p.label}</button>
      ))}
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, marginLeft: 4 }}>
        <input type="date" value={from} max={to || undefined}
          onChange={e => onFrom(e.target.value)} style={dateInput} />
        <span style={{ color: "var(--text-faint)", fontSize: 12 }}>–</span>
        <input type="date" value={to} min={from || undefined}
          onChange={e => onTo(e.target.value)} style={dateInput} />
      </span>
      {preset === "custom" && (from || to) && (
        <button onClick={onClear} style={{ ...chip(false), borderRadius: 6 }}>Clear</button>
      )}
    </div>
  );
}

function StatCard({ label, value, loading }) {
  return (
    <div style={{
      background: "var(--bg-surface)",
      border: "1px solid var(--border)",
      borderRadius: 10,
      padding: "20px 24px",
    }}>
      <div style={{
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: "0.09em",
        color: "var(--text-faint)",
        marginBottom: 10,
        fontFamily: "'DM Sans', sans-serif",
      }}>
        {label}
      </div>
      <div style={{
        fontFamily: "'Playfair Display', serif",
        fontSize: 26,
        color: loading ? "var(--text-fainter)" : "var(--text)",
        lineHeight: 1,
      }}>
        {loading ? "—" : value}
      </div>
    </div>
  );
}

const CHART_PALETTE = {
  light: {
    axis:       "#bbb",
    grid:       "#f0efeb",
    productRow: "#444",
    productBar: "#f4f4f0",
    rank:       "#ddd",
    count:      "#bbb",
    accent:     "#2D6A4F",
    accentFill: "#e8f5ee",
    tooltipBg:  "#fff",
    tooltipBorder: "#e4e4e0",
    tooltipText: "#1a1a1a",
    statValue:  "#1a1a1a",
  },
  dark: {
    axis:       "#888",
    grid:       "#2e2e2c",
    productRow: "#e0ddd5",
    productBar: "#2e2e2c",
    rank:       "#666",
    count:      "#888",
    accent:     "#4ECDC4",
    accentFill: "#1e2e2b",
    tooltipBg:  "#252523",
    tooltipBorder: "#3a3a37",
    tooltipText: "#f0ede5",
    statValue:  "#f0ede5",
  },
};

// ── Main View ─────────────────────────────────────────────────────────────────

export default function EtsyDashboard({ theme = "light", orders = [], loading = false, error = null, lastUpdated = null, onRefresh }) {
  const c = CHART_PALETTE[theme] || CHART_PALETTE.light;
  const TOOLTIP_STYLE = {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: 12,
    background: c.tooltipBg,
    border: `1px solid ${c.tooltipBorder}`,
    color: c.tooltipText,
    borderRadius: 8,
    boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
  };

  // Shop focus — click a bar to drill into that shop, click again to clear
  const [focusedShopId, setFocusedShopId] = useState(null);

  // Listing → product-family links, for the category breakdown.
  const [links, setLinks] = useState([]);
  useEffect(() => {
    if (!isTauri) return;
    import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("list_listing_product_links").then(setLinks).catch(() => {}));
  }, [orders]);
  const categoryByProduct = useMemo(() => {
    const m = {};
    for (const l of links) if (l.sku_base) m[l.product_name] = l.sku_base.split("-")[0];
    return m;
  }, [links]);

  // Per-shop, per-month ad spend (Etsy's API doesn't expose it — imported from
  // monthly statement CSVs or entered by hand). Shape: { [shopId]: { [month]: amount } }.
  const [adSpendByShopMonth, setAdSpendByShopMonth] = useState({});
  useEffect(() => {
    if (!isTauri) return;
    import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("list_ad_spend").then(rows => {
        const m = {};
        for (const r of rows) {
          if (!m[r.shop_id]) m[r.shop_id] = {};
          m[r.shop_id][r.month] = r.amount;
        }
        setAdSpendByShopMonth(m);
      }).catch(() => {}));
  }, []);
  const handleSetAdSpend = useCallback(async (shopId, month, amount) => {
    setAdSpendByShopMonth(prev => ({
      ...prev,
      [shopId]: { ...(prev[shopId] ?? {}), [month]: amount },
    }));
    if (!isTauri) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_ad_spend", { shopId, month, amount });
    } catch (e) { console.error("set_ad_spend failed", e); }
  }, []);

  // Spend overlay for the chart: one shop when focused, else summed across shops
  // so the revenue bars and the spend line always share the same shop basis.
  const displaySpendByMonth = useMemo(() => {
    if (focusedShopId != null) return adSpendByShopMonth[focusedShopId] ?? {};
    const out = {};
    for (const byMonth of Object.values(adSpendByShopMonth)) {
      for (const [month, amt] of Object.entries(byMonth)) {
        out[month] = (out[month] ?? 0) + Number(amt || 0);
      }
    }
    return out;
  }, [adSpendByShopMonth, focusedShopId]);

  // Shop options for the import / edit dropdown.
  const shopOptions = useMemo(
    () => SHOP_IDS.map(id => ({ id, name: SHOP_META[id]?.name ?? `Shop ${id}` })),
    [],
  );

  // Date range — scopes the top of the dashboard (the "All-time history" panel
  // below intentionally stays all-time).
  const [datePreset, setDatePreset] = useState("all"); // see DATE_PRESETS | "custom"
  const [customFrom, setCustomFrom] = useState("");
  const [customTo,   setCustomTo]   = useState("");

  const { fromDate, toDate } = useMemo(() => {
    if (datePreset === "custom") return { fromDate: customFrom || null, toDate: customTo || null };
    const today = ymd(new Date());
    switch (datePreset) {
      case "30d":  return { fromDate: daysAgo(30),  toDate: today };
      case "90d":  return { fromDate: daysAgo(90),  toDate: today };
      case "12mo": return { fromDate: daysAgo(365), toDate: today };
      case "ytd":  return { fromDate: `${new Date().getFullYear()}-01-01`, toDate: today };
      default:     return { fromDate: null, toDate: null };
    }
  }, [datePreset, customFrom, customTo]);

  const rangeLabel = useMemo(() => {
    if (datePreset === "custom") {
      if (fromDate && toDate) return `${fromDate} – ${toDate}`;
      if (fromDate) return `since ${fromDate}`;
      if (toDate) return `through ${toDate}`;
      return "all time";
    }
    return (DATE_PRESETS.find(p => p.id === datePreset)?.label ?? "All time").toLowerCase();
  }, [datePreset, fromDate, toDate]);

  // ── Aggregations ────────────────────────────────────────────────────────────

  // Orders within the selected date range.
  const rangeOrders = useMemo(() => {
    if (!fromDate && !toDate) return orders;
    return orders.filter(o => {
      const d = o.received_date;
      if (!d) return false;
      if (fromDate && d < fromDate) return false;
      if (toDate && d > toDate) return false;
      return true;
    });
  }, [orders, fromDate, toDate]);

  // Range ∩ shop focus drives the top section. shopData stays across all shops
  // (within range) so you can click between them.
  const focusedOrders = useMemo(
    () => focusedShopId == null ? rangeOrders : rangeOrders.filter(o => o.shop_id === focusedShopId),
    [rangeOrders, focusedShopId]
  );

  // All-time, shop-aware set for the "All-time history" panel only.
  const historyOrders = useMemo(
    () => focusedShopId == null ? orders : orders.filter(o => o.shop_id === focusedShopId),
    [orders, focusedShopId]
  );

  const stats = useMemo(() => {
    const revenue = focusedOrders.reduce((s, o) => s + (o.total_price || 0), 0);
    return {
      orders: focusedOrders.length,
      revenue,
      avgOrderValue: focusedOrders.length ? revenue / focusedOrders.length : 0,
      openOrders: focusedOrders.filter(o => o.status !== "completed").length,
    };
  }, [focusedOrders]);

  // Adaptive time series: daily buckets for ranges ≤ 92 days, monthly otherwise.
  // Only buckets that actually have orders are emitted, so all-time stays sparse
  // enough to read instead of thousands of empty daily points.
  const { timeSeriesData, timeBucket } = useMemo(() => {
    if (!focusedOrders.length) return { timeSeriesData: [], timeBucket: "day" };
    let start = fromDate, end = toDate;
    if (!start || !end) {
      let min = null, max = null;
      for (const o of focusedOrders) {
        const d = o.received_date; if (!d) continue;
        if (min == null || d < min) min = d;
        if (max == null || d > max) max = d;
      }
      start = start || min;
      end   = end   || max;
    }
    const daily = start && end ? daysBetween(start, end) <= 92 : true;
    const buckets = new Map();
    for (const o of focusedOrders) {
      const d = o.received_date; if (!d) continue;
      const key = daily ? d : d.slice(0, 7); // YYYY-MM-DD or YYYY-MM
      const b = buckets.get(key) || { revenue: 0, orders: 0 };
      b.revenue += o.total_price || 0;
      b.orders  += 1;
      buckets.set(key, b);
    }
    const rows = [...buckets.keys()].sort().map(k => ({
      date: daily ? labelDay(k) : labelMonth(k),
      revenue: round2(buckets.get(k).revenue),
      orders: buckets.get(k).orders,
    }));
    return { timeSeriesData: rows, timeBucket: daily ? "day" : "month" };
  }, [focusedOrders, fromDate, toDate]);

  // shopData shows all shops within the selected range so the user can click
  // between them. Includes shopId so the click handler knows which to focus.
  const shopData = useMemo(() =>
    SHOP_IDS.map(id => ({
      shopId: id,
      name: SHOP_NAMES[id] || String(id),
      orders: rangeOrders.filter(o => o.shop_id === id).length,
      revenue: round2(rangeOrders.filter(o => o.shop_id === id)
        .reduce((s, o) => s + (o.total_price || 0), 0)),
    }))
  , [rangeOrders]);

  const topProducts = useMemo(() => {
    const map = {};
    focusedOrders.forEach(o => {
      if (!map[o.product_name]) map[o.product_name] = { count: 0, revenue: 0 };
      map[o.product_name].count++;
      map[o.product_name].revenue += o.total_price || 0;
    });
    return Object.entries(map)
      .map(([name, v]) => ({ name, count: v.count, revenue: round2(v.revenue) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }, [focusedOrders]);

  const categoryData = useMemo(() => {
    const map = {};
    for (const o of focusedOrders) {
      const code = categoryByProduct[o.product_name] || null;
      const key = code || "__uncat__";
      if (!map[key]) map[key] = { code, count: 0, revenue: 0 };
      map[key].count++;
      map[key].revenue += o.total_price || 0;
    }
    return Object.entries(map)
      .map(([key, v]) => ({
        key,
        label: v.code ? categoryLabel(v.code) : "Uncategorized",
        count: v.count,
        revenue: round2(v.revenue),
      }))
      .sort((a, b) => b.revenue - a.revenue);
  }, [focusedOrders, categoryByProduct]);

  const isLoading = loading && orders.length === 0;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <PageShell scroll padBottom={32}>
      {/* Header */}
      <PageHeader
        title="Analytics"
        subtitle={(
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {focusedShopId != null ? (
              <>
                <span>Focused on </span>
                <span style={{
                  fontWeight: 600,
                  color: "#fff",
                  background: SHOP_META[focusedShopId]?.color || "#888",
                  padding: "2px 10px",
                  borderRadius: 10,
                  fontSize: 11,
                }}>
                  {SHOP_META[focusedShopId]?.name || `Shop ${focusedShopId}`}
                </span>
                <button
                  onClick={() => setFocusedShopId(null)}
                  style={{
                    fontSize: 11, fontFamily: "'DM Sans', sans-serif",
                    color: "var(--text-muted)", background: "none",
                    border: "1px solid var(--border)", borderRadius: 6,
                    padding: "2px 8px", cursor: "pointer",
                  }}
                >
                  clear x
                </button>
              </>
            ) : (
              <span>Sales analytics · click a bar to focus on one shop</span>
            )}
            {lastUpdated && (
              <span style={{ color: "var(--text-fainter)" }}>
                · updated {lastUpdated.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
              </span>
            )}
          </div>
        )}
        actions={(
          <button
            onClick={() => onRefresh()}
            disabled={loading}
            style={ghostButtonStyle(loading)}
          >
            <span style={{ fontSize: 14, display: "inline-block", animation: loading ? "spin 1s linear infinite" : "none" }}>↻</span>
            {loading && orders.length > 0 ? "Updating…" : "Refresh"}
          </button>
        )}
      >
        {/* Date range */}
        <DateRangeControl
          preset={datePreset}
          from={customFrom}
          to={customTo}
          onPreset={(id) => { setDatePreset(id); setCustomFrom(""); setCustomTo(""); }}
          onFrom={(v) => { setCustomFrom(v); setDatePreset("custom"); }}
          onTo={(v) => { setCustomTo(v); setDatePreset("custom"); }}
          onClear={() => { setDatePreset("all"); setCustomFrom(""); setCustomTo(""); }}
        />
      </PageHeader>

      {/* Error state */}
      {error && (
        <div style={{ marginBottom: 20, padding: "12px 16px", background: "#fff1f0", border: "1px solid #ffd0cc", borderRadius: 8, fontSize: 13, color: "#c0392b", fontFamily: "'DM Sans', sans-serif", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          {error}
          <button onClick={() => onRefresh()} style={{ fontSize: 12, color: "#c0392b", background: "none", border: "1px solid #ffd0cc", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontFamily: "'DM Sans', sans-serif" }}>Retry</button>
        </div>
      )}

      {/* Stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 28 }}>
        <StatCard label={`Orders · ${rangeLabel}`}   value={String(stats?.orders ?? 0)}             loading={isLoading} />
        <StatCard label={`Revenue · ${rangeLabel}`}  value={fmtRevenue(stats?.revenue ?? 0)}        loading={isLoading} />
        <StatCard label="Avg order value"            value={fmtRevenue(stats?.avgOrderValue ?? 0)}  loading={isLoading} />
        <StatCard label="Open orders"                value={String(stats?.openOrders ?? 0)}         loading={isLoading} />
      </div>

      {/* Revenue over time */}
      <div style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "24px 24px 16px",
        marginBottom: 16,
      }}>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.09em", color: "var(--text-faint)", marginBottom: 16, fontFamily: "'DM Sans', sans-serif" }}>
          Revenue · {rangeLabel} {timeBucket === "month" ? "(monthly)" : "(daily)"}
        </div>
        <ResponsiveContainer width="100%" height={180}>
          <AreaChart data={timeSeriesData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={c.grid} vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontFamily: "'DM Sans', sans-serif", fontSize: 10, fill: c.axis }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
              minTickGap={28}
            />
            <YAxis
              tick={{ fontFamily: "'DM Sans', sans-serif", fontSize: 10, fill: c.axis }}
              tickLine={false}
              axisLine={false}
              tickFormatter={fmtRevenueShort}
              width={44}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(v) => [fmtRevenue(v), "Revenue"]}
            />
            <Area
              type="monotone"
              dataKey="revenue"
              stroke={c.accent}
              fill={c.accentFill}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3, fill: c.accent }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Orders by shop + Top products */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

        {/* Orders by shop */}
        <div style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: "24px 24px 16px",
        }}>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.09em", color: "var(--text-faint)", marginBottom: 16, fontFamily: "'DM Sans', sans-serif" }}>
            Orders by shop
          </div>
          <ResponsiveContainer width="100%" height={150}>
            <BarChart data={shopData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barSize={28}>
              <CartesianGrid strokeDasharray="3 3" stroke={c.grid} vertical={false} />
              <XAxis
                dataKey="name"
                tick={{ fontFamily: "'DM Sans', sans-serif", fontSize: 10, fill: c.axis }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tick={{ fontFamily: "'DM Sans', sans-serif", fontSize: 10, fill: c.axis }}
                tickLine={false}
                axisLine={false}
                width={24}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                cursor={{ fill: "transparent" }}
                formatter={(v, name, props) => [
                  `${v} orders · ${fmtRevenue(props.payload.revenue)}`,
                  "Shop"
                ]}
              />
              <Bar
                dataKey="orders"
                radius={[3, 3, 0, 0]}
                cursor="pointer"
                onClick={(d) => setFocusedShopId(prev => prev === d.shopId ? null : d.shopId)}
              >
                {shopData.map(entry => {
                  const color = SHOP_META[entry.shopId]?.color || c.accent;
                  const dim = focusedShopId != null && focusedShopId !== entry.shopId;
                  return (
                    <Cell
                      key={entry.shopId}
                      fill={color}
                      fillOpacity={dim ? 0.25 : 1}
                    />
                  );
                })}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Top products */}
        <div style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: "24px",
        }}>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.09em", color: "var(--text-faint)", marginBottom: 18, fontFamily: "'DM Sans', sans-serif" }}>
            Top products
          </div>
          {isLoading ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {[80, 100, 60, 90, 70].map((w, i) => (
                <div key={i} style={{ height: 24, background: c.productBar, borderRadius: 4, width: `${w}%` }} />
              ))}
            </div>
          ) : topProducts.length === 0 ? (
            <div style={{ color: "var(--text-fainter)", fontSize: 13, textAlign: "center", paddingTop: 20 }}>No data</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {topProducts.map((p, i) => {
                const maxCount = topProducts[0].count;
                return (
                  <div key={p.name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ fontSize: 11, color: c.rank, width: 14, textAlign: "right", fontFamily: "'DM Sans', sans-serif", flexShrink: 0 }}>
                      {i + 1}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: c.productRow, fontFamily: "'DM Sans', sans-serif", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {decodeHtml(p.name)}
                      </div>
                      <div style={{ marginTop: 4, height: 3, background: c.productBar, borderRadius: 2, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${(p.count / maxCount) * 100}%`, background: c.accent, borderRadius: 2, transition: "width 0.4s" }} />
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: c.count, fontFamily: "'DM Sans', sans-serif", flexShrink: 0, textAlign: "right", minWidth: 44 }}>
                      {p.count}×
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

      </div>

      {/* Revenue by category */}
      <div style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "24px",
        marginTop: 16,
      }}>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.09em", color: "var(--text-faint)", marginBottom: 18, fontFamily: "'DM Sans', sans-serif" }}>
          Revenue by category · {rangeLabel}
        </div>
        {categoryData.length === 0 ? (
          <div style={{ color: "var(--text-fainter)", fontSize: 13, fontFamily: "'DM Sans', sans-serif" }}>No data</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {categoryData.map(cat => {
              const maxRev = categoryData[0].revenue || 1;
              return (
                <div key={cat.key} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 190, fontSize: 12, color: cat.key === "__uncat__" ? "var(--text-faint)" : c.productRow, fontFamily: "'DM Sans', sans-serif", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0 }}>
                    {cat.label}
                  </div>
                  <div style={{ flex: 1, height: 8, background: c.productBar, borderRadius: 4, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${(cat.revenue / maxRev) * 100}%`, background: cat.key === "__uncat__" ? c.count : c.accent, borderRadius: 4, transition: "width 0.4s" }} />
                  </div>
                  <div style={{ width: 90, textAlign: "right", fontSize: 12, fontWeight: 600, color: c.statValue, fontFamily: "'DM Sans', sans-serif", flexShrink: 0 }}>
                    {fmtRevenue(cat.revenue)}
                  </div>
                  <div style={{ width: 48, textAlign: "right", fontSize: 11, color: c.count, fontFamily: "'DM Sans', sans-serif", flexShrink: 0 }}>
                    {cat.count}×
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* All-time historical view — monthly revenue, top buyers, top products,
          weekday breakdown. Rendered in a dark panel since the ported zipmap
          components are Tailwind/dark-themed and would look out of place against
          the light theme; the panel framing gives the section its own visual
          identity below the recharts-driven current-month strip above. */}
      <div style={{ marginTop: 32 }}>
        <div style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.09em",
          color: "var(--text-faint)",
          marginBottom: 12,
          fontFamily: "'DM Sans', sans-serif",
        }}>
          All-time history
        </div>
        <div style={{
          background: "#0f172a",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: 20,
        }}>
          <AnalyticsHistory
            orders={historyOrders}
            adSpendByMonth={displaySpendByMonth}
            adSpendByShopMonth={adSpendByShopMonth}
            onSetAdSpend={handleSetAdSpend}
            shops={shopOptions}
            focusedShopId={focusedShopId}
          />
        </div>
      </div>
    </PageShell>
  );
}
