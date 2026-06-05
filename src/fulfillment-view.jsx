import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { SHOP_META } from "./config";
import { categoryLabel } from "./taxonomy.js";
import { QueueCutWidget } from "./lightburn-tab.jsx";

const isTauri = typeof window !== "undefined" && Boolean(window.__TAURI__);

// ── Dev fallback (used when running outside the Tauri shell) ─────────────────
export const MOCK_ORDERS = [
  {
    id: "IE-4821",
    receipt_id: "4821",
    product_name: "Driftwood Wall Hanging",
    finish: "Natural Seal",
    material: "Driftwood",
    dimensions: "24\" × 18\"",
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
    material: "Reclaimed Pine",
    dimensions: "36\" × 8\"",
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
    material: "Driftwood",
    dimensions: "18\" × 14\"",
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
    material: "Stoneware",
    dimensions: "Set of 3",
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
    material: "Jute",
    dimensions: "72\" × 14\"",
    due_date: "2026-05-25",
    received_date: "2026-05-17",
    status: "completed",
    postage_printed: true,
    tracking_code: "9400111899223773219453",
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
    material: "Reclaimed Pine",
    dimensions: "48\" × 10\"",
    due_date: "2026-05-24",
    received_date: "2026-05-16",
    status: "completed",
    postage_printed: true,
    tracking_code: "9400111899223773219460",
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
    material: "Soy Wax",
    dimensions: "8 oz",
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

const MOCK_CATEGORY_BLANK_SIZES = [
  { category: "ORN", min_width: 6,  min_height: 6  },
  { category: "DBC", min_width: 10, min_height: 14 },
  { category: "WAL", min_width: 12, min_height: 18 },
  { category: "LMP", min_width: 16, min_height: 24 },
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

const dueBadge = (dateStr, status, isDark = false) => {
  // In dark mode every badge inverts to solid color + white text so it pops on the dark canvas.
  if (status === "completed") return isDark
    ? { label: "Shipped",    bg: "#2D6A4F", color: "#fff",    dot: "#a3d9b8" }
    : { label: "Shipped",    bg: "#f0faf4", color: "#2D6A4F", dot: "#2D6A4F" };
  const d = daysUntil(dateStr);
  if (d < 0)   return isDark
    ? { label: "Overdue",   bg: "#c0392b", color: "#fff",    dot: "#ff8a7e" }
    : { label: "Overdue",   bg: "#fff1f0", color: "#c0392b", dot: "#e74c3c" };
  if (d === 0) return isDark
    ? { label: "Due today", bg: "#b7600a", color: "#fff",    dot: "#ffc170" }
    : { label: "Due today", bg: "#fff8ec", color: "#b7600a", dot: "#f39c12" };
  if (d === 1) return isDark
    ? { label: "Due tmrw",  bg: "#b7600a", color: "#fff",    dot: "#ffc170" }
    : { label: "Due tmrw",  bg: "#fff8ec", color: "#b7600a", dot: "#f39c12" };
  return         isDark
    ? { label: `Due in ${d}d`, bg: "#3a3a37", color: "#e0ddd5", dot: "#888" }
    : { label: `Due in ${d}d`, bg: "#f4f4f0", color: "#666",    dot: "#bbb" };
};

const fmtDate = (str) => {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

// Etsy returns some titles with HTML entities (&quot;, &amp;, &#39;, etc.).
// Decode them by letting the browser parse them via a textarea.
const decodeHtml = (() => {
  const ta = typeof document !== "undefined" ? document.createElement("textarea") : null;
  return (s) => {
    if (!s || !ta) return s ?? "";
    ta.innerHTML = s;
    return ta.value;
  };
})();

// ── Tracking helpers ──────────────────────────────────────────────────────────

const trackingBadge = (status) => {
  switch (status) {
    case "pre_transit":      return { bg: "#f4f4f0", color: "#888",    dot: "#bbb"    };
    case "in_transit":       return { bg: "#eff6ff", color: "#1d4ed8", dot: "#3b82f6" };
    case "out_for_delivery": return { bg: "#fff8ec", color: "#b7600a", dot: "#f39c12" };
    case "delivered":        return { bg: "#f0faf4", color: "#2D6A4F", dot: "#2D6A4F" };
    case "return_to_sender":
    case "failure":          return { bg: "#fff1f0", color: "#c0392b", dot: "#e74c3c" };
    default:                 return { bg: "#f4f4f0", color: "#888",    dot: "#bbb"    };
  }
};

function TrackingSection({ entry, code }) {
  if (!entry)            return <div style={{ fontSize: 12, color: "#ccc", fontFamily: "'DM Sans', sans-serif" }}>Loading tracking…</div>;
  if (entry.error)       return <div style={{ fontSize: 12, color: "#bbb", fontFamily: "'DM Sans', sans-serif" }}>Tracking unavailable · <span style={{ fontFamily: "monospace" }}>{code}</span></div>;
  if (!entry.info)       return null;

  const t = entry.info;
  const badge = trackingBadge(t.status);

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          fontSize: 11, fontWeight: 600, color: badge.color, background: badge.bg,
          padding: "3px 8px", borderRadius: 20,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: badge.dot, display: "inline-block" }} />
          {t.status_label}
        </span>
        <span style={{ fontSize: 11, color: "#aaa", fontFamily: "monospace" }}>{t.tracking_number}</span>
        {t.est_delivery_date && (
          <span style={{ fontSize: 11, color: "#888" }}>
            Est. {new Date(t.est_delivery_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </span>
        )}
      </div>
      {t.last_message && (
        <div style={{ fontSize: 12, color: "#999", marginTop: 5 }}>
          {t.last_location ? `${t.last_location} — ` : ""}{t.last_message}
        </div>
      )}
    </div>
  );
}

// ── Product-family badge (sku_base + category) ───────────────────────────────
function FamilyBadge({ family, dim }) {
  if (!family) return null;
  return (
    <span title={`Product family ${family.base}`} style={{
      fontSize: 10, fontFamily: "'DM Sans', sans-serif",
      color: "var(--text-muted)", background: "var(--bg-muted)",
      border: "1px solid var(--border)", borderRadius: 4, padding: "1px 6px",
      display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap",
      opacity: dim ? 0.65 : 1,
    }}>
      <span style={{ fontFamily: "monospace", fontWeight: 700, color: "var(--accent)" }}>{family.base}</span>
      {family.cat ? `· ${family.cat}` : ""}
    </span>
  );
}

// ── Offcut availability badge ────────────────────────────────────────────────
function OffcutBadge({ matches }) {
  const [open, setOpen] = useState(false);
  if (!matches || matches.length === 0) return null;
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <button
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        title={`${matches.length} offcut${matches.length > 1 ? "s" : ""} available`}
        style={{
          background: "#1a2e1a", border: "1px solid #3a6a3a",
          borderRadius: 4, padding: "1px 7px",
          fontSize: 10, fontFamily: "'DM Sans', sans-serif",
          color: "#66cc66", cursor: "pointer",
          display: "inline-flex", alignItems: "center", gap: 4,
          whiteSpace: "nowrap",
        }}
      >
        ✂ {matches.length} offcut{matches.length > 1 ? "s" : ""}
      </button>
      {open && (
        <div
          onClick={e => e.stopPropagation()}
          style={{
            position: "absolute", top: "calc(100% + 4px)", left: 0,
            background: "var(--bg-surface)", border: "1px solid var(--border)",
            borderRadius: 8, padding: 10, zIndex: 20, minWidth: 220,
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          }}
        >
          <div style={{
            fontSize: 10, fontWeight: 700, color: "var(--text-muted)",
            textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6,
          }}>
            Matching offcuts
          </div>
          {matches.map((item, i) => (
            <div key={i} style={{
              fontSize: 12, fontFamily: "'DM Sans', sans-serif",
              padding: "5px 0", borderTop: i > 0 ? "1px solid var(--border)" : "none",
              color: "var(--text)",
            }}>
              <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-muted)", marginRight: 6 }}>
                {item.label_id?.slice(0, 8).toUpperCase() ?? "—"}
              </span>
              {item.material.replace(/_/g, " ")} · {item.width}" × {item.height}"
              {item.notes ? ` · ${item.notes}` : ""}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

// ── Order Row ────────────────────────────────────────────────────────────────
function OrderRow({ order, family, offcutMatches, expanded, onToggle, trackingEntry, onTrackingLoad, isDark, selected, onSelect, onShipped }) {
  useEffect(() => {
    if (!expanded || !order.postage_printed || !order.tracking_code || trackingEntry) return;
    onTrackingLoad(order.id, order.tracking_code);
  }, [expanded, trackingEntry, onTrackingLoad, order.id, order.tracking_code, order.postage_printed]);
  const badge = dueBadge(order.due_date, order.status, isDark);
  const isShipped = order.status === "completed";
  const hasInstructions = order.details.special_instructions?.trim().length > 0;
  const shop = SHOP_META[order.shop_id] || { name: `Shop ${order.shop_id}`, color: "#999" };

  return (
    <div style={{
      background: isShipped ? "var(--bg-muted)" : "var(--bg-surface)",
      border: "1px solid",
      borderColor: isShipped ? "var(--border-muted)" : "var(--border)",
      borderLeft: `4px solid ${shop.color}`,
      borderRadius: 10,
      overflow: "hidden",
      flexShrink: 0,
      opacity: isShipped ? 0.72 : 1,
      transition: "box-shadow 0.15s",
    }}>
      {/* Main row */}
      <div
        onClick={onToggle}
        style={{
          display: "grid",
          gridTemplateColumns: "24px 52px minmax(0, 1fr) 160px 130px 90px 36px",
          alignItems: "center",
          gap: 16,
          padding: "14px 20px",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        {/* Selection checkbox */}
        <div onClick={(e) => { e.stopPropagation(); onSelect(order.id); }} style={{ cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <input
            type="checkbox"
            checked={selected}
            readOnly
            style={{ width: 16, height: 16, accentColor: "var(--accent)", cursor: "pointer" }}
          />
        </div>

        {/* Listing photo */}
        <div style={{
          width: 48, height: 48,
          borderRadius: 6,
          overflow: "hidden",
          background: "var(--bg-muted)",
          border: "1px solid var(--border-muted)",
          flexShrink: 0,
          opacity: isShipped ? 0.65 : 1,
        }}>
          {order.image_url ? (
            <img
              src={order.image_url}
              alt=""
              loading="lazy"
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
          ) : null}
        </div>

        {/* Product + buyer */}
        <div style={{ minWidth: 0, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span style={{
              fontFamily: "'Playfair Display', serif",
              fontSize: 14,
              fontWeight: 600,
              color: isShipped ? "var(--text-faint)" : "var(--text)",
              display: "block",
              flex: "1 1 auto",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }} title={decodeHtml(order.product_name)}>
              {decodeHtml(order.product_name)}
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
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2, minWidth: 0, overflow: "hidden" }}>
            <span style={{
              fontSize: 10, fontFamily: "'DM Sans', sans-serif", fontWeight: 600,
              color: "#fff", background: shop.color,
              padding: "2px 8px", borderRadius: 10, letterSpacing: "0.03em",
              opacity: isShipped ? 0.65 : 1,
            }}>
              {shop.name}
            </span>
            <FamilyBadge family={family} dim={isShipped} />
            <OffcutBadge matches={offcutMatches} />
            <span style={{
              fontSize: 12,
              color: "#aaa",
              fontFamily: "'DM Sans', sans-serif",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>
              {order.id} · {decodeHtml(order.buyer)}
            </span>
          </div>
        </div>

        {/* Finish */}
        <div style={{
          fontFamily: "'DM Sans', sans-serif",
          fontSize: 13,
          color: isShipped ? "var(--text-faint)" : "var(--text)",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }} title={decodeHtml(order.finish)}>
          {decodeHtml(order.finish)}
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
        <div style={{ borderTop: "1px solid var(--border-muted)", background: "var(--bg-muted)" }}>
          <div style={{
            padding: "16px 20px 18px",
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
              value={decodeHtml(order.details.special_instructions) || "—"}
              highlight={hasInstructions && !isShipped}
            />
          </div>
          {isShipped && order.tracking_code && (
            <div style={{
              borderTop: "1px solid var(--border-muted)",
              padding: "12px 20px 14px",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}>
              <div style={{
                fontFamily: "'DM Sans', sans-serif",
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.09em",
                color: "var(--text-faint)",
                marginBottom: 6,
              }}>Tracking</div>
              <TrackingSection entry={trackingEntry} code={order.tracking_code} />
            </div>
          )}
          {!isShipped && (
            <>
              <QueueCutWidget order={order} />
              <MarkShippedForm order={order} onShipped={onShipped} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Mark-as-shipped form ──────────────────────────────────────────────────────
function MarkShippedForm({ order, onShipped }) {
  const [code, setCode] = useState("");
  const [carrier, setCarrier] = useState("USPS");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    if (!code.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("create_receipt_shipment", {
        shopId: order.shop_id,
        receiptId: parseInt(order.receipt_id, 10),
        trackingCode: code.trim(),
        carrierName: carrier,
        sendBcc: true,
      });
      setCode("");
      onShipped?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        borderTop: "1px solid var(--border-muted)",
        padding: "12px 20px 14px",
        background: "var(--bg-muted)",
      }}
    >
      <div style={{
        fontFamily: "'DM Sans', sans-serif",
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: "0.09em",
        color: "var(--text-faint)",
        marginBottom: 8,
      }}>Mark as shipped</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Tracking number"
          disabled={submitting}
          style={{
            flex: 1, fontSize: 13, padding: "6px 10px",
            fontFamily: "'DM Sans', sans-serif",
            background: "var(--bg-surface)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            outline: "none",
          }}
        />
        <select
          value={carrier}
          onChange={(e) => setCarrier(e.target.value)}
          disabled={submitting}
          style={{
            fontSize: 13, padding: "6px 8px",
            fontFamily: "'DM Sans', sans-serif",
            background: "var(--bg-surface)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          <option>USPS</option>
          <option>UPS</option>
          <option>FedEx</option>
          <option>DHL</option>
          <option>Other</option>
        </select>
        <button
          onClick={submit}
          disabled={submitting || !code.trim()}
          style={{
            fontSize: 12, fontWeight: 600,
            color: "#fff", background: code.trim() ? "var(--accent)" : "var(--border)",
            border: "none", borderRadius: 6,
            padding: "7px 16px", cursor: code.trim() && !submitting ? "pointer" : "default",
            fontFamily: "'DM Sans', sans-serif",
            whiteSpace: "nowrap",
          }}
        >
          {submitting ? "Sending…" : "Mark shipped"}
        </button>
      </div>
      {error && (
        <div style={{ marginTop: 8, fontSize: 12, color: "#c0392b", fontFamily: "'DM Sans', sans-serif" }}>
          {error}
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
export default function FulfillmentView({ theme = "light", orders = [], loading = false, error = null, lastUpdated = null, onRefresh, categoryBlankSizes = [] }) {
  const isDark = theme === "dark";
  const [filter, setFilter] = useState("open");
  const [expandedId, setExpandedId] = useState(null);
  const [trackingCache, setTrackingCache] = useState({});
  const fetchingTracking = useRef(new Set());
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [pickListOpen, setPickListOpen] = useState(false);
  const [links, setLinks] = useState([]);

  // Listing → product-family links, so each order can show its SKU family/category.
  useEffect(() => {
    if (!isTauri) return;
    import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("list_listing_product_links").then(setLinks).catch(() => {}));
  }, [orders]);

  const familyByProduct = useMemo(() => {
    const m = {};
    for (const l of links) {
      if (!l.sku_base) continue;
      m[l.product_name] = { base: l.sku_base, cat: categoryLabel(l.sku_base.split("-")[0]) };
    }
    return m;
  }, [links]);

  // Load inventory once on mount so the offcut badge can filter labelled offcuts.
  // In non-Tauri (Vite preview) mode inventoryItems stays empty — badge is absent, which is fine.
  const [inventoryItems, setInventoryItems] = useState([]);
  useEffect(() => {
    if (!isTauri) return;
    import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("get_inventory").then(setInventoryItems).catch(() => {})
    );
  }, []);

  // Map category → { min_width, min_height } for O(1) lookup per order row.
  const blankSizeByCategory = useMemo(() => {
    const m = {};
    for (const s of categoryBlankSizes) m[s.category.toUpperCase()] = s;
    return m;
  }, [categoryBlankSizes]);

  // All tracked offcuts currently in stock (quantity > 0, has a label assigned).
  const availableOffcuts = useMemo(() => {
    return inventoryItems.filter(
      item => item.item_type === "offcut" && item.quantity > 0 && item.label_id
    );
  }, [inventoryItems]);

  const offcutMatchesFor = useCallback((productName) => {
    const family = familyByProduct[productName];
    if (!family?.base) return [];
    const category = family.base.split("-")[0].toUpperCase();
    const sizeReq = blankSizeByCategory[category];
    if (!sizeReq) return [];
    return availableOffcuts.filter(
      item => item.width >= sizeReq.min_width && item.height >= sizeReq.min_height
    );
  }, [familyByProduct, blankSizeByCategory, availableOffcuts]);

  const toggleSelected = useCallback((id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const clearSelected = () => setSelectedIds(new Set());

  const handleTrackingLoad = useCallback((orderId, trackingNumber) => {
    if (fetchingTracking.current.has(orderId)) return;
    fetchingTracking.current.add(orderId);

    const doFetch = isTauri
      ? import("@tauri-apps/api/core").then(({ invoke }) =>
          invoke("get_tracking", { trackingNumber }))
      : Promise.reject("not in tauri");

    doFetch
      .then(info => setTrackingCache(prev => ({ ...prev, [orderId]: { info } })))
      .catch(err => setTrackingCache(prev => ({ ...prev, [orderId]: { error: String(err) } })))
      .finally(() => fetchingTracking.current.delete(orderId));
  }, []);

  const filtered = useMemo(() => {
    let list = [...orders];
    if (filter === "open")    list = list.filter(o => o.status !== "completed");
    if (filter === "shipped") list = list.filter(o => o.status === "completed");
    if (filter === "overdue") list = list.filter(o => o.status !== "completed" && daysUntil(o.due_date) < 0);
    if (filter === "notes")   list = list.filter(o => o.details.special_instructions?.trim().length > 0);
    if (filter === "urgent")  list = list.filter(o => o.status !== "completed" && daysUntil(o.due_date) <= 1);
    list.sort((a, b) => parseDue(a.due_date) - parseDue(b.due_date));
    return list;
  }, [filter, orders]);

  const openCount    = orders.filter(o => o.status !== "completed").length;
  const overdueCount = orders.filter(o => o.status !== "completed" && daysUntil(o.due_date) < 0).length;
  const notesCount   = orders.filter(o => o.details.special_instructions?.trim().length > 0).length;
  const shippedCount = orders.filter(o => o.status === "completed").length;

  // Daily summary — urgent work for today
  const dueTodayCount   = orders.filter(o => o.status !== "completed" && daysUntil(o.due_date) === 0).length;
  const dueTmrwCount    = orders.filter(o => o.status !== "completed" && daysUntil(o.due_date) === 1).length;
  const todayUrgentTotal = overdueCount + dueTodayCount + dueTmrwCount;

  const filters = [
    { key: "all",     label: "All",     count: orders.length },
    { key: "open",    label: "Open",    count: openCount },
    { key: "overdue", label: "Overdue", count: overdueCount, danger: true },
    { key: "notes",   label: "Notes",   count: notesCount,   warn: true },
    { key: "shipped", label: "Shipped", count: shippedCount },
  ];

  return (
    <div style={{
      height: "100%",
      minHeight: 0,
      display: "flex", flexDirection: "column", overflow: "hidden",
      background: "var(--bg-canvas)",
      padding: "32px 40px 0",
      fontFamily: "'DM Sans', sans-serif",
      color: "var(--text)",
    }}>
      {/* Header */}
      <div style={{ marginBottom: 28, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.02em" }}>
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
        <div style={{ fontSize: 13, color: "var(--text-faint)", marginTop: 3 }}>
          Order fulfillment queue · sorted by due date
          {lastUpdated && ` · updated ${lastUpdated.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`}
        </div>
      </div>

      {/* Daily summary banner — surfaces today's urgent work */}
      {orders.length > 0 && (
        <div
          onClick={() => todayUrgentTotal > 0 && setFilter("urgent")}
          style={{
            marginBottom: 20,
            padding: "14px 20px",
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            borderLeft: todayUrgentTotal > 0 ? "4px solid #e74c3c" : "4px solid var(--accent)",
            borderRadius: 10,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            cursor: todayUrgentTotal > 0 ? "pointer" : "default",
            transition: "border-color 0.15s",
            flexShrink: 0,
          }}
        >
          <div>
            <div style={{
              fontFamily: "'Playfair Display', serif",
              fontSize: 18,
              fontWeight: 600,
              color: "var(--text)",
              marginBottom: 4,
            }}>
              {todayUrgentTotal === 0
                ? "All caught up — nothing urgent through tomorrow"
                : `${todayUrgentTotal} order${todayUrgentTotal === 1 ? "" : "s"} need attention soon`}
            </div>
            {todayUrgentTotal > 0 && (
              <div style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", gap: 14, fontFamily: "'DM Sans', sans-serif" }}>
                <span style={{ color: overdueCount > 0 ? "#c0392b" : "var(--text-faint)", fontWeight: overdueCount > 0 ? 600 : 400 }}>
                  {overdueCount} overdue
                </span>
                <span style={{ color: "var(--text-faint)" }}>·</span>
                <span style={{ color: dueTodayCount > 0 ? "#b7600a" : "var(--text-faint)", fontWeight: dueTodayCount > 0 ? 600 : 400 }}>
                  {dueTodayCount} due today
                </span>
                <span style={{ color: "var(--text-faint)" }}>·</span>
                <span style={{ color: dueTmrwCount > 0 ? "#b7600a" : "var(--text-faint)", fontWeight: dueTmrwCount > 0 ? 600 : 400 }}>
                  {dueTmrwCount} due tomorrow
                </span>
              </div>
            )}
          </div>
          {todayUrgentTotal > 0 && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "'DM Sans', sans-serif" }}>
              click to focus →
            </div>
          )}
        </div>
      )}

      {/* Filter pills */}
      <div style={{ display: "flex", gap: 8, marginBottom: 24, flexShrink: 0 }}>
        {filters.map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)} style={{
            padding: "6px 14px",
            borderRadius: 20,
            border: "1.5px solid",
            borderColor: filter === f.key
              ? f.danger ? "#e74c3c" : f.warn ? "#f39c12" : "var(--accent)"
              : "var(--border)",
            background: filter === f.key
              ? isDark
                ? f.danger ? "#c0392b" : f.warn ? "#b7600a" : "var(--accent)"
                : f.danger ? "#fff1f0" : f.warn ? "#fff8ec" : "var(--accent-bg)"
              : "var(--bg-surface)",
            color: filter === f.key
              ? isDark
                ? "#fff"
                : f.danger ? "#c0392b" : f.warn ? "#b7600a" : "var(--accent)"
              : "var(--text-muted)",
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
        gridTemplateColumns: "24px 52px minmax(0, 1fr) 160px 130px 90px 36px",
        gap: 16,
        padding: "0 20px",
        marginBottom: 8,
        alignItems: "center",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <input
            type="checkbox"
            title={selectedIds.size > 0 ? "Clear selection" : "Select all visible"}
            checked={filtered.length > 0 && filtered.every(o => selectedIds.has(o.id))}
            onChange={() => {
              if (filtered.every(o => selectedIds.has(o.id)) && filtered.length > 0) {
                clearSelected();
              } else {
                setSelectedIds(new Set(filtered.map(o => o.id)));
              }
            }}
            style={{ width: 14, height: 14, accentColor: "var(--accent)", cursor: "pointer" }}
          />
        </div>
        <div />
        <ColHeader label="Product / Order" />
        <ColHeader label="Finish" />
        <ColHeader label="Due Date" />
        <ColHeader label="Postage" />
        <div />
      </div>

      {/* Order rows — scrolls independently */}
      <div style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        overscrollBehavior: "contain",
        scrollbarGutter: "stable",
        paddingBottom: 40,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}>
        {loading && orders.length === 0 && (
          <div style={{ textAlign: "center", padding: "48px 0", fontFamily: "'DM Sans', sans-serif" }}>
            <div style={{ fontSize: 24, marginBottom: 12, display: "inline-block", animation: "spin 1s linear infinite", color: "var(--text-faint)" }}>↻</div>
            <div style={{ fontSize: 14, color: "var(--text-muted)" }}>Syncing orders from Etsy…</div>
            <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 6 }}>
              The first sync pulls every order and can take up to a minute on a new computer.
            </div>
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
            family={familyByProduct[order.product_name]}
            offcutMatches={offcutMatchesFor(order.product_name)}
            expanded={expandedId === order.id}
            onToggle={() => setExpandedId(expandedId === order.id ? null : order.id)}
            trackingEntry={trackingCache[order.id]}
            onTrackingLoad={handleTrackingLoad}
            isDark={isDark}
            selected={selectedIds.has(order.id)}
            onSelect={toggleSelected}
            onShipped={() => loadOrders(true)}
          />
        ))}
      </div>

      {/* Floating selection bar — appears when ≥1 order checked */}
      {selectedIds.size > 0 && !pickListOpen && (
        <div style={{
          position: "fixed",
          right: 32,
          bottom: 32,
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: "12px 16px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
          zIndex: 100,
          fontFamily: "'DM Sans', sans-serif",
        }}>
          <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 600 }}>
            {selectedIds.size} selected
          </span>
          <button
            onClick={clearSelected}
            style={{
              fontSize: 12, color: "var(--text-muted)",
              background: "none", border: "1px solid var(--border)",
              borderRadius: 6, padding: "6px 10px", cursor: "pointer",
              fontFamily: "'DM Sans', sans-serif",
            }}
          >
            Clear
          </button>
          <button
            onClick={() => setPickListOpen(true)}
            style={{
              fontSize: 12, fontWeight: 600,
              color: "#fff", background: "var(--accent)",
              border: "none",
              borderRadius: 6, padding: "6px 14px", cursor: "pointer",
              fontFamily: "'DM Sans', sans-serif",
            }}
          >
            Print pick list →
          </button>
        </div>
      )}

      {/* Pick list modal — print-friendly */}
      {pickListOpen && (
        <PickList
          orders={orders.filter(o => selectedIds.has(o.id))}
          familyByProduct={familyByProduct}
          onClose={() => setPickListOpen(false)}
        />
      )}
    </div>
  );
}

// ── Pick list modal ──────────────────────────────────────────────────────────
const STAGES = [
  { key: "cut",       label: "Cut"   },
  { key: "assembled", label: "Asm"   },
  { key: "packed",    label: "Packed" },
];

function StageBox({ checked, label, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
        cursor: "pointer", userSelect: "none",
      }}
    >
      <div style={{
        width: 18, height: 18,
        border: `2px solid ${checked ? "var(--accent)" : "var(--border)"}`,
        borderRadius: 4,
        background: checked ? "var(--accent)" : "transparent",
        display: "flex", alignItems: "center", justifyContent: "center",
        transition: "background 0.1s, border-color 0.1s",
        WebkitPrintColorAdjust: "exact",
        printColorAdjust: "exact",
      }}>
        {checked && (
          <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
            <path d="M1 4l3 3 5-6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>
      <span style={{
        fontSize: 9, fontFamily: "'DM Sans', sans-serif", fontWeight: 700,
        letterSpacing: "0.04em",
        color: checked ? "var(--accent)" : "var(--text-muted)",
        textTransform: "uppercase",
      }}>{label}</span>
    </div>
  );
}

function PickList({ orders, familyByProduct = {}, onClose }) {
  const [stages, setStages] = useState(() =>
    Object.fromEntries(orders.map(o => [o.id, { cut: false, assembled: false, packed: false }]))
  );

  const toggleStage = (id, key) =>
    setStages(s => ({ ...s, [id]: { ...s[id], [key]: !s[id][key] } }));

  // Portal div appended directly to <body> so print CSS can target it as a
  // direct child — avoids the duplicate-page bug caused by visibility:hidden
  // leaving the full dashboard layout in the print flow.
  const [printRoot] = useState(() => {
    const el = document.createElement("div");
    el.id = "pick-list-print-portal";
    document.body.appendChild(el);
    return el;
  });
  useEffect(() => () => printRoot.remove(), [printRoot]);

  useEffect(() => {
    const style = document.createElement("style");
    style.id = "pick-list-print-style";
    style.textContent = `
      #pick-list-print-portal { display: none; }
      @media print {
        body > *:not(#pick-list-print-portal) { display: none !important; }
        #pick-list-print-portal {
          display: block !important;
          padding: 16px;
          background: #fff;
          color: #000;
        }
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
      }
    `;
    document.head.appendChild(style);
    return () => { document.getElementById("pick-list-print-style")?.remove(); };
  }, []);

  // Rendered into both the modal (screen) and the body portal (print).
  // Called as a function so each call produces an independent element tree.
  const renderBody = () => (
    <>
      <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, fontWeight: 700, marginBottom: 4 }}>
        Pick list
      </div>
      <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 11, marginBottom: 16, opacity: 0.7 }}>
        {new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
        {" · "}{orders.length} order{orders.length === 1 ? "" : "s"}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {orders.map(o => {
          const shop = SHOP_META[o.shop_id] || { name: `Shop ${o.shop_id}`, color: "#999" };
          const s = stages[o.id] || { cut: false, assembled: false, packed: false };
          const notes = decodeHtml(o.details?.special_instructions || "");

          const fam = familyByProduct[o.product_name];

          // Build metadata chips — only include fields that have a value
          const meta = [
            fam                              && { label: null,         value: fam.base + (fam.cat ? ` · ${fam.cat}` : ""), bold: true, mono: true },
            o.buyer                          && { label: null,         value: decodeHtml(o.buyer),         bold: true  },
            o.dimensions                     && { label: null,         value: decodeHtml(o.dimensions),    bold: false },
            o.received_date                  && { label: "Ordered",    value: fmtDate(o.received_date),    bold: false },
            o.due_date                       && { label: "Due",        value: fmtDate(o.due_date),         bold: true  },
            (o.material || o.finish)         && { label: null,         value: [o.material && decodeHtml(o.material), o.finish && decodeHtml(o.finish)].filter(Boolean).join(" · "), bold: false },
          ].filter(Boolean);

          return (
            <div key={o.id} style={{
              border: "1px solid var(--border)",
              borderLeft: `4px solid ${shop.color}`,
              borderRadius: 8,
              overflow: "hidden",
              pageBreakInside: "avoid",
            }}>
              <div style={{
                display: "grid",
                gridTemplateColumns: "90px 64px 1fr",
                gap: 12,
                alignItems: "center",
                padding: "12px 14px",
              }}>
                {/* Stage checkboxes */}
                <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                  {STAGES.map(({ key, label }) => (
                    <StageBox
                      key={key}
                      checked={s[key]}
                      label={label}
                      onClick={() => toggleStage(o.id, key)}
                    />
                  ))}
                </div>

                {/* Listing photo */}
                {o.image_url
                  ? <img src={o.image_url} alt="" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 4, display: "block" }} />
                  : <div style={{ width: 64, height: 64, background: "var(--bg-muted)", borderRadius: 4 }} />
                }

                {/* Content: name on line 1, all metadata on line 2 */}
                <div style={{ minWidth: 0 }}>
                  <div style={{
                    fontFamily: "'Playfair Display', serif",
                    fontSize: 14, fontWeight: 700,
                    lineHeight: 1.3,
                    marginBottom: 5,
                    wordBreak: "break-word",
                  }}>
                    {decodeHtml(o.product_name)}
                  </div>
                  <div style={{
                    display: "flex", flexWrap: "wrap", alignItems: "center",
                    gap: "4px 12px",
                    fontFamily: "'DM Sans', sans-serif", fontSize: 11,
                  }}>
                    {meta.map((m, i) => (
                      <span key={i} style={{ fontWeight: m.bold ? 700 : 400, opacity: m.bold ? 1 : 0.75, whiteSpace: "nowrap", fontFamily: m.mono ? "monospace" : undefined }}>
                        {m.label && <span style={{ opacity: 0.55, fontWeight: 400 }}>{m.label} </span>}
                        {m.value}
                      </span>
                    ))}
                    <span style={{ opacity: 0.35, fontSize: 10 }}>{o.id}</span>
                  </div>
                </div>
              </div>

              {notes && (
                <div style={{
                  padding: "6px 14px 8px 18px",
                  borderTop: "1px solid var(--border-muted)",
                  background: "#fffbea",
                  fontFamily: "'DM Sans', sans-serif", fontSize: 11,
                  color: "#7a5c00",
                }}>
                  <strong>Note:</strong> {notes}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );

  return (
    <>
      {/* Body-level portal — only used during print, hidden on screen */}
      {createPortal(renderBody(), printRoot)}

      {/* Modal */}
      <div style={{
        position: "fixed", inset: 0,
        background: "rgba(0,0,0,0.5)",
        zIndex: 200,
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "40px 20px",
        overflowY: "auto",
      }}>
        <div style={{
          background: "var(--bg-surface)",
          color: "var(--text)",
          borderRadius: 12,
          width: "100%", maxWidth: 1020,
          padding: "24px 32px",
          boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
        }}>
          {/* Toolbar */}
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            marginBottom: 20, paddingBottom: 16, borderBottom: "1px solid var(--border)",
          }}>
            <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 700 }}>
              Pick list ({orders.length})
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={onClose}
                style={{
                  fontSize: 13, color: "var(--text-muted)",
                  background: "none", border: "1px solid var(--border)",
                  borderRadius: 6, padding: "8px 14px", cursor: "pointer",
                  fontFamily: "'DM Sans', sans-serif",
                }}
              >Close</button>
              <button
                onClick={() => window.print()}
                style={{
                  fontSize: 13, fontWeight: 600,
                  color: "#fff", background: "var(--accent)",
                  border: "none", borderRadius: 6, padding: "8px 18px", cursor: "pointer",
                  fontFamily: "'DM Sans', sans-serif",
                }}
              >Print</button>
            </div>
          </div>

          {/* Screen content */}
          {renderBody()}
        </div>
      </div>
    </>
  );
}
