import { useState } from "react";
import FulfillmentView from "./fulfillment-view.jsx";
import EtsyDashboard from "./etsy-dashboard.jsx";

const TABS = [
  { key: "fulfillment", label: "Fulfillment" },
  { key: "analytics",   label: "Analytics"   },
];

export default function App() {
  const [activeTab, setActiveTab] = useState("fulfillment");

  return (
    <div style={{ minHeight: "100vh", background: "#f7f7f5" }}>
      {/* Tab bar */}
      <div style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 2,
        padding: "14px 40px 0",
        borderBottom: "1px solid #e4e4e0",
        background: "#f7f7f5",
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}>
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              padding: "8px 16px 10px",
              background: "none",
              border: "none",
              borderBottom: activeTab === tab.key
                ? "2px solid #2D6A4F"
                : "2px solid transparent",
              marginBottom: "-1px",
              cursor: "pointer",
              fontFamily: "'DM Sans', sans-serif",
              fontSize: 13,
              fontWeight: activeTab === tab.key ? 600 : 400,
              color: activeTab === tab.key ? "#2D6A4F" : "#aaa",
              letterSpacing: "0.01em",
              transition: "color 0.15s, border-color 0.15s",
              whiteSpace: "nowrap",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Active view */}
      {activeTab === "fulfillment" && <FulfillmentView />}
      {activeTab === "analytics"   && <EtsyDashboard />}
    </div>
  );
}
