import { useState, useEffect, useCallback, useRef, lazy, Suspense } from "react";
import FulfillmentView, { MOCK_ORDERS } from "./fulfillment-view.jsx";
import InventoryTab from "./inventory-tab.jsx";
import LightburnTab from "./lightburn-tab.jsx";
import CatalogTab from "./catalog-tab.jsx";

// Lazy-loaded: Analytics pulls in recharts (~340 kB) and Map pulls in
// leaflet + three/globe + html2canvas + the 42k ZIP centroid table (~4 MB
// minified). Deferring them keeps startup parse work to the core bundle;
// the chunks load from local disk on first tab visit.
const EtsyDashboard = lazy(() => import("./etsy-dashboard.jsx"));
const MapView = lazy(() => import("./map-tab/MapView.jsx"));
import { applyTheme, getInitialTheme, persistTheme } from "./theme.js";
import { SHOP_IDS } from "./config.js";
import { version as APP_VERSION } from "../package.json";

const isTauri = typeof window !== "undefined" && Boolean(window.__TAURI__);

const TAB_GROUPS = [
  [
    { key: "fulfillment", label: "Fulfillment" },
    { key: "inventory",   label: "Inventory"   },
    { key: "catalog",     label: "Listings"    },
    { key: "ingest",      label: "Ingest"      },
  ],
  [
    { key: "analytics",   label: "Analytics"   },
    { key: "map",         label: "Map"         },
  ],
];

// Brief spinner while a lazy tab chunk loads from disk (first visit only).
function TabLoading() {
  return (
    <div style={{
      flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'DM Sans', sans-serif", color: "var(--text-faint)", fontSize: 13, gap: 8,
    }}>
      <span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>↻</span>
      Loading…
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState("fulfillment");
  const [theme, setTheme] = useState(getInitialTheme);

  // ── Shared order state — fetched once, passed to all tabs ──────────────────
  const [orders, setOrders]               = useState([]);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [ordersRefreshing, setRefreshing] = useState(false);  // background refresh
  const [ordersError, setOrdersError]     = useState(null);
  const [lastUpdated, setLastUpdated]     = useState(null);
  const [listingSync, setListingSync]     = useState({ state: "idle", results: [], updatedAt: null });
  const [categoryBlankSizes, setCategoryBlankSizes] = useState([]);

  // Tracks whether we've shown data at least once — avoids blocking spinner
  // on subsequent refreshes. Using a ref so loadOrders stays stable (no dep).
  const hasDataRef = useRef(false);

  // Phase 1 of launch: paint instantly from the on-disk cache. This NEVER calls
  // Etsy (unlike loadOrders(false), which re-fetches once the cache passes its
  // 30-min freshness window), so the first tab renders without waiting on the
  // network. The background refresh in loadOrders(true) brings it up to date.
  const loadCachedOrders = useCallback(async () => {
    if (!isTauri) {
      setOrders(MOCK_ORDERS);
      setLastUpdated(new Date());
      hasDataRef.current = true;
      setOrdersLoading(false);
      return;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const data = await invoke("get_cached_orders", { shopIds: SHOP_IDS });
      if (data && data.length) {
        setOrders(data);
        hasDataRef.current = true; // so the upcoming refresh shows "Updating…" not a blocking spinner
        // Intentionally leave lastUpdated unset — cache isn't "fresh"; the
        // force refresh that follows sets the real timestamp.
      }
    } catch (e) {
      console.error("cache-only order load failed:", e);
    } finally {
      setOrdersLoading(false); // clear the blocking spinner regardless
    }
  }, []);

  // Fast fulfillment refresh: pull only the unshipped queue from Etsy (seconds,
  // not the minutes the full history takes) and merge it into the shared orders
  // array. The Fulfillment tab's open queue goes fresh quickly without waiting on
  // the full historical fetch that Analytics needs. Merge by id so cached/historical
  // orders (used by the Shipped/All filters) are preserved.
  const loadOpenOrders = useCallback(async () => {
    if (!isTauri) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const open = await invoke("get_open_orders", { shopIds: SHOP_IDS });
      if (Array.isArray(open) && open.length >= 0) {
        setOrders(prev => {
          const byId = new Map(prev.map(o => [o.id, o]));
          for (const o of open) byId.set(o.id, o);
          return [...byId.values()];
        });
        hasDataRef.current = true;
        setOrdersLoading(false);
      }
    } catch (e) {
      console.error("open-orders fast load failed:", e);
    }
  }, []);

  const syncActiveListings = useCallback(async () => {
    if (!isTauri) return;
    setListingSync({ state: "syncing", results: [], updatedAt: null });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const results = await invoke("sync_active_listings", { shopIds: SHOP_IDS });
      setListingSync({
        state: "done",
        results: Array.isArray(results) ? results : [],
        updatedAt: new Date().toISOString(),
      });
    } catch (e) {
      setListingSync({
        state: "error",
        results: [{ shop_id: 0, ok: false, active_count: 0, message: String(e) }],
        updatedAt: new Date().toISOString(),
      });
      console.error("sync_active_listings failed:", e);
    }
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let unlisten;
    let cancelled = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen("active-listings-progress", (event) => {
        const p = event.payload ?? {};
        setListingSync(prev => {
          const rows = [...(prev.results ?? [])];
          const idx = rows.findIndex(r => r.shop_id === p.shop_id);
          const next = {
            shop_id: p.shop_id,
            ok: Boolean(p.ok),
            active_count: Number(p.synced_count ?? 0),
            message: p.message ?? "",
          };
          if (idx >= 0) rows[idx] = next;
          else rows.push(next);
          return {
            state: p.done && !p.ok ? "error" : "syncing",
            results: rows,
            updatedAt: p.done ? new Date().toISOString() : prev.updatedAt,
          };
        });
      }))
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e) => console.error("active-listings-progress listener failed:", e));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const loadOrders = useCallback(async (forceRefresh = false) => {
    if (!isTauri) {
      setOrders(MOCK_ORDERS);
      setOrdersLoading(false);
      setLastUpdated(new Date());
      hasDataRef.current = true;
      return;
    }

    // If we already have data, refresh silently in the background rather than
    // blanking the UI with a loading spinner.
    if (hasDataRef.current) {
      setRefreshing(true);
    } else {
      setOrdersLoading(true);
    }
    setOrdersError(null);

    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const data = await invoke("get_orders", {
        shopIds: SHOP_IDS,
        forceRefresh: forceRefresh || undefined,
      });
      setOrders(data);
      setLastUpdated(new Date());
      hasDataRef.current = true;

      // Persist unique products into the durable catalog table so they survive
      // listing deletion, orders cache clears, or pagination gaps.
      const seen = new Map();
      for (const o of data) {
        if (!o.product_name) continue;
        const ex = seen.get(o.product_name);
        const date = o.received_date ?? null;
        const img  = o.image_url ?? null;
        if (!ex) {
          seen.set(o.product_name, {
            productName: o.product_name,
            shopId: o.shop_id ?? 0,
            imageUrl: img,
            lastSeen: date,
          });
        } else {
          if (date && (!ex.lastSeen || date > ex.lastSeen)) ex.lastSeen = date;
          if (img && !ex.imageUrl) ex.imageUrl = img;
          if (o.shop_id && !ex.shopId) ex.shopId = o.shop_id;
        }
      }
      invoke("sync_catalog_products", { items: [...seen.values()] }).catch((e) => console.error("sync_catalog_products failed:", e));

      // Fetch all active Etsy listings so the Listings tab shows everything,
      // not just products that have appeared in a paid order.
      if (forceRefresh) {
        syncActiveListings();
      }
    } catch (e) {
      setOrdersError(String(e));
    } finally {
      setOrdersLoading(false);
      setRefreshing(false);
    }
  }, [syncActiveListings]);

  useEffect(() => {
    // Phase 1  — paint instantly from cache (no Etsy call; fast first render).
    // Phase 1b — refresh the unshipped fulfillment queue from Etsy (seconds).
    // Phase 2  — load the full order history in the background for Analytics
    //            (minutes; never blocks the Fulfillment tab).
    // All of this runs here at the App level on a fixed schedule, independent of
    // which tab is active — switching tabs never reorders or restarts it.
    loadCachedOrders()
      .then(() => loadOpenOrders())
      .then(() => loadOrders(true));
    const interval = setInterval(() => loadOrders(true), 30 * 60 * 1000);

    // Load category blank sizes once — these change rarely (manual config).
    if (isTauri) {
      import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("get_category_blank_sizes")
          .then(setCategoryBlankSizes)
          .catch((e) => console.error("get_category_blank_sizes failed:", e))
      );
    }

    return () => clearInterval(interval);
  }, [loadCachedOrders, loadOpenOrders, loadOrders]);

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
    <div style={{
      height: "100vh",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      background: "var(--bg-canvas)",
      color: "var(--text)",
    }}>
      {/* Tab bar */}
      <div style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 2,
        padding: "14px 40px 0",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-canvas)",
        flexShrink: 0,
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}>
        {TAB_GROUPS.map((group, gi) => (
          <div key={gi} style={{ display: "flex", alignItems: "flex-end", gap: 2 }}>
            {gi > 0 && (
              <div style={{
                width: 1, height: 20, background: "var(--border)",
                margin: "0 10px 12px",
                alignSelf: "flex-end",
              }} />
            )}
            {group.map(tab => (
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
          </div>
        ))}

        {/* Background refresh indicator */}
        {ordersRefreshing && (
          <span style={{
            marginLeft: "auto",
            marginBottom: 6,
            fontFamily: "'DM Sans', sans-serif",
            fontSize: 11,
            color: "var(--text-faint)",
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
          }}>
            <span style={{ display: "inline-block", animation: "spin 1s linear infinite", fontSize: 13 }}>↻</span>
            Updating…
          </span>
        )}

        {/* Version number — sits just left of the theme toggle */}
        <span style={{
          marginLeft: ordersRefreshing ? 14 : "auto",
          marginBottom: 9,
          fontFamily: "'DM Sans', sans-serif",
          fontSize: 11,
          color: "var(--text-faint)",
          letterSpacing: "0.02em",
          userSelect: "none",
        }}>
          v{APP_VERSION}
        </span>

        {/* Theme toggle — right-aligned */}
        <button
          onClick={toggleTheme}
          title={`Switch to ${isDark ? "light" : "dark"} mode`}
          style={{
            marginLeft: 10,
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
      <Suspense fallback={<TabLoading />}>
        {activeTab === "fulfillment" && <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}><FulfillmentView theme={theme} orders={orders} loading={ordersLoading} error={ordersError} lastUpdated={lastUpdated} onRefresh={() => { loadOpenOrders(); loadOrders(true); }} categoryBlankSizes={categoryBlankSizes} /></div>}
        {activeTab === "analytics"   && <EtsyDashboard theme={theme} orders={orders} loading={ordersLoading} error={ordersError} lastUpdated={lastUpdated} onRefresh={() => loadOrders(true)} />}
        {activeTab === "inventory"   && <InventoryTab />}
        {activeTab === "catalog"     && <CatalogTab activeListingSync={listingSync} />}
        {activeTab === "ingest"      && <LightburnTab orders={orders} />}
        {activeTab === "map"         && <MapView orders={orders} loading={ordersLoading} error={ordersError} onRefresh={() => loadOrders(true)} />}
      </Suspense>
    </div>
  );
}
