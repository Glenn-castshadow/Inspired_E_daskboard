import { useState, useEffect } from "react";
import FulfillmentView from "./fulfillment-view.jsx";
import EtsyDashboard from "./etsy-dashboard.jsx";
import { applyTheme, getInitialTheme, persistTheme } from "./theme.js";

const TABS = [
  { key: "fulfillment", label: "Fulfillment" },
  { key: "analytics",   label: "Analytics"   },
];

export default function App() {
  const [activeTab, setActiveTab] = useState("fulfillment");
  const [theme, setTheme] = useState(getInitialTheme);

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
      {activeTab === "fulfillment" && <FulfillmentView theme={theme} />}
      {activeTab === "analytics"   && <EtsyDashboard theme={theme} />}
    </div>
  );
}
