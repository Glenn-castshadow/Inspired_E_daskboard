// src/etsy-dashboard.jsx
//
// Analytics dashboard — placeholder until charts are wired up.
// Data source (when Rust layer is ready):
//   invoke("get_orders", { shop_ids: [SHOP_IDS], force_refresh: false })
//   then aggregate client-side: revenue by day, orders by shop, top products.

export default function EtsyDashboard() {
  return (
    <div style={{
      minHeight: "calc(100vh - 45px)",
      background: "#f7f7f5",
      padding: "32px 40px",
      fontFamily: "'DM Sans', sans-serif",
    }}>
      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <div style={{
          fontFamily: "'Playfair Display', serif",
          fontSize: 26,
          fontWeight: 700,
          color: "#1a1a1a",
          letterSpacing: "-0.02em",
        }}>
          Inspired Eclectics
        </div>
        <div style={{ fontSize: 13, color: "#aaa", marginTop: 3 }}>
          Sales analytics · all 3 shops
        </div>
      </div>

      {/* Stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 32 }}>
        {[
          { label: "Orders this month", value: "—" },
          { label: "Revenue this month", value: "—" },
          { label: "Avg order value", value: "—" },
          { label: "Open orders", value: "—" },
        ].map(card => (
          <div key={card.label} style={{
            background: "#fff",
            border: "1px solid #e4e4e0",
            borderRadius: 10,
            padding: "20px 24px",
          }}>
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.09em", color: "#bbb", marginBottom: 10 }}>
              {card.label}
            </div>
            <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 28, color: "#ccc" }}>
              {card.value}
            </div>
          </div>
        ))}
      </div>

      {/* Chart placeholder */}
      <div style={{
        background: "#fff",
        border: "1px solid #e4e4e0",
        borderRadius: 10,
        padding: "24px",
        marginBottom: 16,
        height: 260,
        display: "flex",
        flexDirection: "column",
      }}>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.09em", color: "#bbb", marginBottom: 16 }}>
          Revenue · last 30 days
        </div>
        <div style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "1.5px dashed #e8e8e4",
          borderRadius: 6,
          color: "#ccc",
          fontSize: 13,
        }}>
          Chart coming soon — wire up get_orders and aggregate by date
        </div>
      </div>

      {/* Two column placeholders */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {[
          { label: "Orders by shop" },
          { label: "Top products" },
        ].map(card => (
          <div key={card.label} style={{
            background: "#fff",
            border: "1px solid #e4e4e0",
            borderRadius: 10,
            padding: "24px",
            height: 200,
            display: "flex",
            flexDirection: "column",
          }}>
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.09em", color: "#bbb", marginBottom: 16 }}>
              {card.label}
            </div>
            <div style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "1.5px dashed #e8e8e4",
              borderRadius: 6,
              color: "#ccc",
              fontSize: 13,
            }}>
              Coming soon
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
