import { useState, useMemo } from "react";
import {
  AreaChart, Area, BarChart, Bar, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { SHOP_META } from "./config";
import AnalyticsHistory from "./analytics-history.jsx";


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

// ── Sub-components ────────────────────────────────────────────────────────────

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

  // ── Aggregations ────────────────────────────────────────────────────────────

  // All aggregations except shopData run on the focused subset so the rest of
  // the dashboard reflects the click. shopData stays full so you can click out.
  const focusedOrders = useMemo(
    () => focusedShopId == null ? orders : orders.filter(o => o.shop_id === focusedShopId),
    [orders, focusedShopId]
  );

  const stats = useMemo(() => {
    if (!focusedOrders.length) return null;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
      .toISOString().slice(0, 10);
    const thisMonth = focusedOrders.filter(o => o.received_date >= monthStart);
    const revenue = thisMonth.reduce((s, o) => s + (o.total_price || 0), 0);
    return {
      ordersThisMonth: thisMonth.length,
      revenueThisMonth: revenue,
      avgOrderValue: thisMonth.length ? revenue / thisMonth.length : 0,
      openOrders: focusedOrders.filter(o => o.status !== "completed").length,
    };
  }, [focusedOrders]);

  const timeSeriesData = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return Array.from({ length: 30 }, (_, i) => {
      const d = new Date(today); d.setDate(d.getDate() - (29 - i));
      const iso = d.toISOString().slice(0, 10);
      const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const dayOrders = focusedOrders.filter(o => o.received_date === iso);
      return {
        date: label,
        revenue: Math.round(dayOrders.reduce((s, o) => s + (o.total_price || 0), 0) * 100) / 100,
        orders: dayOrders.length,
      };
    });
  }, [focusedOrders]);

  // shopData always shows ALL shops so the user can click between them.
  // Includes shopId so the click handler knows which one to focus on.
  const shopData = useMemo(() =>
    SHOP_IDS.map(id => ({
      shopId: id,
      name: SHOP_NAMES[id] || String(id),
      orders: orders.filter(o => o.shop_id === id).length,
      revenue: Math.round(orders.filter(o => o.shop_id === id)
        .reduce((s, o) => s + (o.total_price || 0), 0) * 100) / 100,
    }))
  , [orders]);

  const topProducts = useMemo(() => {
    const map = {};
    focusedOrders.forEach(o => {
      if (!map[o.product_name]) map[o.product_name] = { count: 0, revenue: 0 };
      map[o.product_name].count++;
      map[o.product_name].revenue += o.total_price || 0;
    });
    return Object.entries(map)
      .map(([name, v]) => ({ name, count: v.count, revenue: Math.round(v.revenue * 100) / 100 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }, [focusedOrders]);

  const isLoading = loading && orders.length === 0;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={{
      minHeight: "calc(100vh - 45px)",
      background: "var(--bg-canvas)", color: "var(--text)",
      padding: "32px 40px",
      fontFamily: "'DM Sans', sans-serif",
    }}>
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <div style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: 26,
            fontWeight: 700,
            color: "var(--text)",
            letterSpacing: "-0.02em",
          }}>
            Genevieve Etsy Dashboard
          </div>
          <button
            onClick={() => onRefresh()}
            disabled={loading}
            style={{
              fontFamily: "'DM Sans', sans-serif",
              fontSize: 12,
              color: loading ? "#ccc" : "#888",
              background: "none",
              border: "none",
              cursor: loading ? "default" : "pointer",
              padding: "4px 0",
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            <span style={{ fontSize: 14, display: "inline-block", animation: loading ? "spin 1s linear infinite" : "none" }}>↻</span>
            {loading && orders.length > 0 ? "Updating…" : "Refresh"}
          </button>
        </div>
        <div style={{ fontSize: 13, color: "var(--text-faint)", marginTop: 3, display: "flex", alignItems: "center", gap: 10 }}>
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
                letterSpacing: "0.03em",
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
                clear ×
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
      </div>

      {/* Error state */}
      {error && (
        <div style={{ marginBottom: 20, padding: "12px 16px", background: "#fff1f0", border: "1px solid #ffd0cc", borderRadius: 8, fontSize: 13, color: "#c0392b", fontFamily: "'DM Sans', sans-serif", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          {error}
          <button onClick={() => loadOrders()} style={{ fontSize: 12, color: "#c0392b", background: "none", border: "1px solid #ffd0cc", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontFamily: "'DM Sans', sans-serif" }}>Retry</button>
        </div>
      )}

      {/* Stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 28 }}>
        <StatCard label="Orders this month"  value={String(stats?.ordersThisMonth ?? 0)}       loading={isLoading} />
        <StatCard label="Revenue this month" value={fmtRevenue(stats?.revenueThisMonth ?? 0)}  loading={isLoading} />
        <StatCard label="Avg order value"    value={fmtRevenue(stats?.avgOrderValue ?? 0)}     loading={isLoading} />
        <StatCard label="Open orders"        value={String(stats?.openOrders ?? 0)}            loading={isLoading} />
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
          Revenue · last 30 days
        </div>
        <ResponsiveContainer width="100%" height={180}>
          <AreaChart data={timeSeriesData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={c.grid} vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontFamily: "'DM Sans', sans-serif", fontSize: 10, fill: c.axis }}
              tickLine={false}
              axisLine={false}
              interval={4}
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
          <AnalyticsHistory orders={focusedOrders} />
        </div>
      </div>

    </div>
  );
}
