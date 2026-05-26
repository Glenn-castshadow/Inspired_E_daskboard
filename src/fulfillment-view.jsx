import { useState, useMemo, useEffect, useCallback } from "react";
import { SHOP_IDS } from "./config";

const isTauri = typeof window !== "undefined" && Boolean(window.__TAURI__);

// ── Dev fallback (used when running outside the Tauri shell) ─────────────────
const MOCK_ORDERS = [
  {
    id: "IE-4821",
    receipt_id: "4821",
    product_name: "Driftwood Wall Hanging",
    finish: "Natural Seal",
    due_date: "2026-05-26",
    received_date: "2026-05-21",
    status: "open",
    postage_printed: false,
    details: {
      hanging_holes: 2,
      special_instructions: "Customer wants holes at 18\" apart, not standard spacing.",
    },
    buyer: "Sandra M.",
  },
  {
    id: "IE-4819",
    receipt_id: "4819",
    product_name: "Reclaimed Wood Shelf",
    finish: "Dark Walnut Stain",
    due_date: "2026-05-27",
    received_date: "2026-05-20",
    status: "open",
    postage_printed: false,
    details: {
      hanging_holes: 3,
      special_instructions: "",
    },
    buyer: "Tom R.",
  },
  {
    id: "IE-4815",
    receipt_id: "4815",
    product_name: "Driftwood Wall Hanging",
    finish: "Whitewash",
    due_date: "2026-05-28",
    received_date: "2026-05-19",
    status: "open",
    postage_printed: false,
    details: {
      hanging_holes: 1,
      special_instructions: "Gift — please include note card. No pricing.",
    },
    buyer: "Priya K.",
  },
  {
    id: "IE-4810",
    receipt_id: "4810",
    product_name: "Ceramic Bud Vase Set",
    finish: "Matte White",
    due_date: "2026-05-29",
    received_date: "2026-05-18",
    status: "open",
    postage_printed: false,
    details: {
      hanging_holes: 0,
      special_instructions: "Set of 3, not 2. Confirmed with buyer.",
    },
    buyer: "Laura B.",
  },
  {
    id: "IE-4804",
    receipt_id: "4804",
    product_name: "Woven Jute Table Runner",
    finish: "Natural",
    due_date: "2026-05-25",
    received_date: "2026-05-17",
    status: "completed",
    postage_printed: true,
    details: {
      hanging_holes: 0,
      special_instructions: "",
    },
    buyer: "Helen T.",
  },
  {
    id: "IE-4798",
    receipt_id: "4798",
    product_name: "Reclaimed Wood Shelf",
    finish: "Pale Oak",
    due_date: "2026-05-24",
    received_date: "2026-05-16",
    status: "completed",
    postage_printed: true,
    details: {
      hanging_holes: 2,
      special_instructions: "Drill holes before finishing, not after.",
    },
    buyer: "James W.",
  },
  {
    id: "IE-4791",
    receipt_id: "4791",
    product_name: "Hand-Poured Soy Candle",
    finish: "Unscented / Linen Wick",
    due_date: "2026-05-30",
    received_date: "2026-05-22",
    status: "open",
    postage_printed: false,
    details: {
      hanging_holes: 0,
      special_instructions: "Allergic to lavender — confirmed unscented variant.",
    },
    buyer: "Mei C.",
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

// Local midnight avoids UTC/local offset causing wrong day counts
const parseDue = (str) => {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
};

const today = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();

const daysUntil = (dateStr) =>
  Math.round((parseDue(dateStr) - today) / 86400000);

const dueBadge = (dateStr, status) => {
  if (status === "completed") return { label: "Shipped",    bg: "#f0faf4", color: "#2D6A4F", dot: "#2D6A4F" };
  const d = daysUntil(dateStr);
  if (d < 0)   return { label: "Overdue",   bg: "#fff1f0", color: "#c0392b", dot: "#e74c3c" };
  if (d === 0) return { label: "Due today", bg: "#fff8ec", color: "#b7600a", dot: "#f39c12" };
  if (d === 1) return { label: "Due tmrw",  bg: "#fff8ec", color: "#b7600a", dot: "#f39c12" };
  return       { label: `Due in ${d}d`,     bg: "#f4f4f0", color: "#666",    dot: "#bbb"    };
};

const fmtDate = (str) => {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

// ── Order Row ────────────────────────────────────────────────────────────────
function OrderRow({ order, expanded, onToggle }) {
  const badge = dueBadge(order.due_date, order.status);
  const isShipped = order.status === "completed";
  const hasInstructions = order.details.special_instructions?.trim().length > 0;

  return (
    <div style={{
      background: isShipped ? "#fafaf8" : "#fff",
      border: "1px solid",
      borderColor: isShipped ? "#ebebea" : "#e4e4e0",
      borderRadius: 10,
      overflow: "hidden",
      opacity: isShipped ? 0.72 : 1,
      transition: "box-shadow 0.15s",
    }}>
      {/* Main row */}
      <div
        onClick={onToggle}
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 160px 130px 90px 36px",
          alignItems: "center",
          gap: 16,
          padding: "14px 20px",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        {/* Product + buyer */}
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{
              fontFamily: "'Playfair Display', serif",
              fontSize: 14,
              fontWeight: 600,
              color: isShipped ? "#888" : "#1a1a1a",
            }}>
              {order.product_name}
            </span>
            {hasInstructions && !isShipped && (
              <span title="Has special instructions" style={{
                fontSize: 10,
                background: "#fff3cd",
                color: "#856404",
                border: "1px solid #ffd97d",
                borderRadius: 4,
                padding: "1px 5px",
                fontFamily: "'DM Sans', sans-serif",
                fontWeight: 600,
                letterSpacing: "0.04em",
              }}>NOTE</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: "#aaa", marginTop: 2, fontFamily: "'DM Sans', sans-serif" }}>
            {order.id} · {order.buyer}
          </div>
        </div>

        {/* Finish */}
        <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: isShipped ? "#aaa" : "#444" }}>
          {order.finish}
        </div>

        {/* Due date */}
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            fontSize: 11, fontWeight: 600, fontFamily: "'DM Sans', sans-serif",
            color: badge.color, background: badge.bg,
            padding: "3px 8px", borderRadius: 20, width: "fit-content",
          }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: badge.dot, display: "inline-block" }} />
            {badge.label}
          </span>
          <span style={{ fontSize: 11, color: "#bbb", fontFamily: "'DM Sans', sans-serif", paddingLeft: 2 }}>
            {fmtDate(order.due_date)}
          </span>
        </div>

        {/* Postage */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {isShipped ? (
            <span style={{
              fontSize: 11, fontFamily: "'DM Sans', sans-serif",
              color: "#2D6A4F", display: "flex", alignItems: "center", gap: 4,
            }}>
              <span style={{ fontSize: 14 }}>✓</span> Printed
            </span>
          ) : (
            <span style={{ fontSize: 11, fontFamily: "'DM Sans', sans-serif", color: "#ccc" }}>
              Pending
            </span>
          )}
        </div>

        {/* Expand chevron */}
        <div style={{
          color: "#ccc", fontSize: 14, textAlign: "center",
          transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
          transition: "transform 0.2s",
        }}>
          ▾
        </div>
      </div>

      {/* Expanded detail drawer */}
      {expanded && (
        <div style={{
          borderTop: "1px solid #f0efeb",
          padding: "16px 20px 18px",
          background: "#fdfdfb",
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 20,
        }}>
          <DetailBlock label="Order Received" value={fmtDate(order.received_date)} />
          <DetailBlock
            label="Hanging Holes"
            value={order.details.hanging_holes === 0
              ? "None"
              : `${order.details.hanging_holes} hole${order.details.hanging_holes > 1 ? "s" : ""}`}
          />
          <DetailBlock
            label="Special Instructions"
            value={order.details.special_instructions || "—"}
            highlight={hasInstructions && !isShipped}
          />
        </div>
      )}
    </div>
  );
}

function DetailBlock({ label, value, highlight }) {
  return (
    <div>
      <div style={{
        fontFamily: "'DM Sans', sans-serif",
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: "0.09em",
        color: "#bbb",
        marginBottom: 4,
      }}>{label}</div>
      <div style={{
        fontFamily: "'DM Sans', sans-serif",
        fontSize: 13,
        color: highlight ? "#7a5c00" : "#444",
        background: highlight ? "#fffbea" : "transparent",
        padding: highlight ? "6px 10px" : 0,
        borderRadius: highlight ? 6 : 0,
        border: highlight ? "1px solid #ffe58a" : "none",
        lineHeight: 1.5,
      }}>{value}</div>
    </div>
  );
}

// ── Column header ─────────────────────────────────────────────────────────────
function ColHeader({ label }) {
  return (
    <div style={{
      fontFamily: "'DM Sans', sans-serif",
      fontSize: 10,
      textTransform: "uppercase",
      letterSpacing: "0.09em",
      color: "#bbb",
    }}>{label}</div>
  );
}

// ── Main View ─────────────────────────────────────────────────────────────────
export default function FulfillmentView() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [filter, setFilter] = useState("open");
  const [expandedId, setExpandedId] = useState(null);

  const loadOrders = useCallback(async (forceRefresh = false) => {
    if (!isTauri) {
      setOrders(MOCK_ORDERS);
      setLoading(false);
      setLastUpdated(new Date());
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/tauri");
      const data = await invoke("get_orders", {
        shopIds: SHOP_IDS,
        forceRefresh: forceRefresh || undefined,
      });
      setOrders(data);
      setLastUpdated(new Date());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadOrders();
    const interval = setInterval(() => loadOrders(), 20 * 60 * 1000);
    return () => clearInterval(interval);
  }, [loadOrders]);

  const filtered = useMemo(() => {
    let list = [...orders];
    if (filter === "open")    list = list.filter(o => o.status !== "completed");
    if (filter === "shipped") list = list.filter(o => o.status === "completed");
    if (filter === "overdue") list = list.filter(o => o.status !== "completed" && daysUntil(o.due_date) < 0);
    if (filter === "notes")   list = list.filter(o => o.details.special_instructions?.trim().length > 0);
    list.sort((a, b) => parseDue(a.due_date) - parseDue(b.due_date));
    return list;
  }, [filter, orders]);

  const openCount    = orders.filter(o => o.status !== "completed").length;
  const overdueCount = orders.filter(o => o.status !== "completed" && daysUntil(o.due_date) < 0).length;
  const notesCount   = orders.filter(o => o.details.special_instructions?.trim().length > 0).length;
  const shippedCount = orders.filter(o => o.status === "completed").length;

  const filters = [
    { key: "all",     label: "All",     count: orders.length },
    { key: "open",    label: "Open",    count: openCount },
    { key: "overdue", label: "Overdue", count: overdueCount, danger: true },
    { key: "notes",   label: "Notes",   count: notesCount,   warn: true },
    { key: "shipped", label: "Shipped", count: shippedCount },
  ];

  return (
    <div style={{
      minHeight: "100vh",
      background: "#f7f7f5",
      padding: "32px 40px",
      fontFamily: "'DM Sans', sans-serif",
    }}>
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 700, color: "#1a1a1a", letterSpacing: "-0.02em" }}>
            Inspired Eclectics
          </div>
          <button
            onClick={() => loadOrders(true)}
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
        <div style={{ fontSize: 13, color: "#aaa", marginTop: 3 }}>
          Order fulfillment queue · sorted by due date
          {lastUpdated && ` · updated ${lastUpdated.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`}
        </div>
      </div>

      {/* Filter pills */}
      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        {filters.map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)} style={{
            padding: "6px 14px",
            borderRadius: 20,
            border: "1.5px solid",
            borderColor: filter === f.key
              ? f.danger ? "#e74c3c" : f.warn ? "#f39c12" : "#2D6A4F"
              : "#e0e0dc",
            background: filter === f.key
              ? f.danger ? "#fff1f0" : f.warn ? "#fff8ec" : "#f0faf4"
              : "#fff",
            color: filter === f.key
              ? f.danger ? "#c0392b" : f.warn ? "#b7600a" : "#2D6A4F"
              : "#888",
            fontSize: 12,
            fontWeight: filter === f.key ? 600 : 400,
            fontFamily: "'DM Sans', sans-serif",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
            transition: "all 0.15s",
          }}>
            {f.label}
            <span style={{
              background: filter === f.key
                ? f.danger ? "#e74c3c" : f.warn ? "#f39c12" : "#2D6A4F"
                : "#e8e8e4",
              color: filter === f.key ? "#fff" : "#999",
              fontSize: 10,
              fontWeight: 700,
              borderRadius: 10,
              padding: "1px 6px",
              minWidth: 18,
              textAlign: "center",
            }}>{f.count}</span>
          </button>
        ))}
      </div>

      {/* Column headers */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 160px 130px 90px 36px",
        gap: 16,
        padding: "0 20px",
        marginBottom: 8,
      }}>
        <ColHeader label="Product / Order" />
        <ColHeader label="Finish" />
        <ColHeader label="Due Date" />
        <ColHeader label="Postage" />
        <div />
      </div>

      {/* Order rows */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {loading && orders.length === 0 && (
          <div style={{ textAlign: "center", padding: "48px 0", fontFamily: "'DM Sans', sans-serif", fontSize: 14, color: "#bbb" }}>
            Loading orders…
          </div>
        )}
        {!loading && error && orders.length === 0 && (
          <div style={{ textAlign: "center", padding: "48px 0", fontFamily: "'DM Sans', sans-serif", fontSize: 14, color: "#c0392b" }}>
            <div style={{ marginBottom: 12 }}>{error}</div>
            <button onClick={() => loadOrders()} style={{
              fontFamily: "'DM Sans', sans-serif", fontSize: 12,
              color: "#888", background: "#fff", border: "1px solid #ddd",
              borderRadius: 6, padding: "6px 14px", cursor: "pointer",
            }}>Retry</button>
          </div>
        )}
        {!loading && !error && orders.length === 0 && isTauri && SHOP_IDS.length === 0 && (
          <div style={{ textAlign: "center", padding: "48px 0", fontFamily: "'DM Sans', sans-serif", fontSize: 14, color: "#bbb" }}>
            No shops configured — add your shop IDs to <code>src/config.js</code>.
          </div>
        )}
        {!loading && filtered.length === 0 && orders.length > 0 && (
          <div style={{
            textAlign: "center", padding: "48px 0",
            fontFamily: "'DM Sans', sans-serif", fontSize: 14, color: "#bbb",
          }}>
            No orders match this filter.
          </div>
        )}
        {filtered.map(order => (
          <OrderRow
            key={order.id}
            order={order}
            expanded={expandedId === order.id}
            onToggle={() => setExpandedId(expandedId === order.id ? null : order.id)}
          />
        ))}
      </div>
    </div>
  );
}
