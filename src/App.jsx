import { useState, useEffect, useCallback } from "react";
import FulfillmentView, { MOCK_ORDERS } from "./fulfillment-view.jsx";
import EtsyDashboard from "./etsy-dashboard.jsx";
import MapView from "./map-tab/MapView.jsx";
import { applyTheme, getInitialTheme, persistTheme } from "./theme.js";
import { SHOP_IDS } from "./config.js";

const isTauri = typeof window !== "undefined" && Boolean(window.__TAURI__);

const TABS = [
  { key: "fulfillment", label: "Fulfillment" },
  { key: "analytics",   label: "Analytics"   },
  { key: "map",         label: "Map"         },
];

export default function App() {
  const [activeTab, setActiveTab] = useState("fulfillment");
  const [theme, setTheme] = useState(getInitialTheme);

  // ── Shared order state — fetched once, passed to all tabs ──────────────────
  const [orders, setOrders] = useState([]);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [ordersError, setOrdersError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const loadOrders = useCallback(async (forceRefresh = false) => {
    if (!isTauri) {
      setOrders(MOCK_ORDERS);
      setOrdersLoading(false);
      setLastUpdated(new Date());
      return;
    }
    setOrdersLoading(true);
    setOrdersError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const data = await invoke("get_orders", {
        shopIds: SHOP_IDS,
        forceRefresh: forceRefresh || undefined,
      });
      setOrders(data);
      setLastUpdated(new Date());
    } catch (e) {
      setOrdersError(String(e));
    } finally {
      setOrdersLoading(false);
    }
  }, []);

  useEffect(() => {
    loadOrders(true);
    const interval = setInterval(() => loadOrders(true), 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, [loadOrders]);

  useEffect(() => {
    applyTheme(theme);
    persistTheme(theme);
  }, [theme]);

  // F12 toggles WebView2 devtools in release builds. The `devtools` feature on
  // tauri enables them; this listener guarantees the keystroke routes through
  // even when WebView2's built-in F12 binding doesn't fire.
  useEffect(() => {
    let devtoolsOpen = false;
    const onKey = async (e) => {
      if (e.key !== "F12") return;
      e.preventDefault();
      try {
        // Tauri v2: invoke lives at window.__TAURI__.core.invoke (was .tauri in v1).
        const core = window.__TAURI__?.core;
        if (!core) return;
        await core.invoke(devtoolsOpen ? "close_devtools" : "open_devtools");
        devtoolsOpen = !devtoolsOpen;
      } catch {/* ignore */}
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleTheme = () => setTheme(t => t === "dark" ? "light" : "dark");
  const isDark = theme === "dark";

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-canvas)", color: "var(--text)" }}>
      {/* Tab bar */}
      <div style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 2,
        padding: "14px 40px 0",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-canvas)",
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
                ? "2px solid var(--accent)"
                : "2px solid transparent",
              marginBottom: "-1px",
              cursor: "pointer",
              fontFamily: "'DM Sans', sans-serif",
              fontSize: 13,
              fontWeight: activeTab === tab.key ? 600 : 400,
              color: activeTab === tab.key ? "var(--accent)" : "var(--text-faint)",
              letterSpacing: "0.01em",
              transition: "color 0.15s, border-color 0.15s",
              whiteSpace: "nowrap",
            }}
          >
            {tab.label}
          </button>
        ))}

        {/* Theme toggle — right-aligned */}
        <button
          onClick={toggleTheme}
          title={`Switch to ${isDark ? "light" : "dark"} mode`}
          style={{
            marginLeft: "auto",
            marginBottom: 6,
            padding: "6px 10px",
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            cursor: "pointer",
            fontFamily: "'DM Sans', sans-serif",
            fontSize: 12,
            color: "var(--text-muted)",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            transition: "background 0.15s, border-color 0.15s",
          }}
        >
          <span style={{ fontSize: 14, lineHeight: 1 }}>{isDark ? "☀" : "☾"}</span>
          {isDark ? "Light" : "Dark"}
        </button>
      </div>

      {/* Active view */}
      {activeTab === "fulfillment" && <FulfillmentView theme={theme} orders={orders} loading={ordersLoading} error={ordersError} lastUpdated={lastUpdated} onRefresh={() => loadOrders(true)} />}
      {activeTab === "analytics"   && <EtsyDashboard theme={theme} orders={orders} loading={ordersLoading} error={ordersError} lastUpdated={lastUpdated} onRefresh={() => loadOrders(true)} />}
      {activeTab === "map"         && <MapView orders={orders} loading={ordersLoading} error={ordersError} onRefresh={() => loadOrders(true)} />}
    </div>
  );
}
