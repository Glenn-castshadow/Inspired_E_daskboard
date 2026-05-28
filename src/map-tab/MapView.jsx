// src/map-tab/MapView.jsx
//
// Map tab — visualizes live Etsy orders as a ZIP-level heatmap, bubble, arc,
// treasure, or pushpin overlay; also offers a 3-D globe view. Adapts the
// zipmap project's components to the dashboard by replacing CSV-derived
// state with a `get_orders` invoke. Stays Tailwind-styled to keep the
// ported components verbatim — see src/index.css and tailwind.config.js.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

import { SHOP_IDS, SHOP_META } from '../config';

import zipCentroids from './data/zipCentroids.json';
import { styles } from './mapStyles/index.js';

import StyleSwitcher       from './components/StyleSwitcher.jsx';
import OriginInput         from './components/OriginInput.jsx';
import Legend              from './components/Legend.jsx';
import ExportButtons       from './components/ExportButtons.jsx';
import StatCards           from './components/StatCards.jsx';
import TopStatesPanel      from './components/TopStatesPanel.jsx';
import ScaleSwitcher       from './components/ScaleSwitcher.jsx';
import BaseMapToggle       from './components/BaseMapToggle.jsx';
import HeatGradientPicker  from './components/HeatGradientPicker.jsx';
import GlobeLayerControls  from './components/GlobeLayerControls.jsx';
import GlobeView           from './components/GlobeView.jsx';
import CollapsibleSection  from './components/CollapsibleSection.jsx';
import ZipDetailPopup      from './components/ZipDetailPopup.jsx';

// ── Centroid lookups ──────────────────────────────────────────────────────────
const zipLookup      = new Map();
const zipStateLookup = new Map();
const zipCityLookup  = new Map();
for (const { zip, lat, lon, state, city } of zipCentroids) {
  zipLookup.set(zip, { lat, lng: lon });
  zipStateLookup.set(zip, state);
  zipCityLookup.set(zip, city);
}

const isTauri = typeof window !== 'undefined' && Boolean(window.__TAURI__);

// Normalize an Etsy ship_zip into the 5-digit form our centroid table uses.
// Handles ZIP+4 ("48124-1023"), 9-digit concat ("481241023"), and leading-zero
// loss from a possible upstream int coercion ("1023" → "01023").
function normalizeZip(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const justDigits = s.replace(/\D/g, '');
  if (justDigits.length === 0) return null;
  const five = justDigits.slice(0, 5);
  return five.padStart(5, '0');
}

export default function MapView() {
  // ── Orders fetch ────────────────────────────────────────────────────────────
  const [orders, setOrders]   = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  const loadOrders = useCallback(async (forceRefresh = false) => {
    if (!isTauri) {
      // No mock data on this tab — fulfillment-view's MOCK_ORDERS lack ship_zip
      // so they'd produce an empty map anyway. Just show the empty state.
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const data = await invoke('get_orders', {
        shopIds: SHOP_IDS,
        forceRefresh: forceRefresh || undefined,
      });
      setOrders(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadOrders(); }, [loadOrders]);

  // ── Map / globe controls ────────────────────────────────────────────────────
  const [activeStyleId, setActiveStyleId] = useState(styles[0].id);
  const [scaleMode, setScaleMode]         = useState('linear');
  const [heatGradientId, setHeatGradientId]   = useState('spectrum');
  const [globeGradientId, setGlobeGradientId] = useState('spectrum');
  const [globeShowSpikes,   setGlobeShowSpikes]   = useState(true);
  const [globeShowArcs,     setGlobeShowArcs]     = useState(true);
  const [globeShowOrigin,   setGlobeShowOrigin]   = useState(true);
  const [globeArcsAnimated, setGlobeArcsAnimated] = useState(true);
  const [baseMap, setBaseMap]   = useState('flat');
  const [selectedZip, setSelectedZip] = useState(null);
  const [focusedShopId, setFocusedShopId] = useState(null); // optional shop filter
  const [originZip, setOriginZip] = useState(
    () => (typeof localStorage !== 'undefined' && localStorage.getItem('mapTab-origin')) || ''
  );
  const mapRef = useRef(null);

  const originEntry = useMemo(() => {
    if (originZip.length < 5) return null;
    return zipLookup.get(originZip.padStart(5, '0')) ?? null;
  }, [originZip]);

  // ── Derived datasets ────────────────────────────────────────────────────────
  // Orders restricted to the focused shop (if any).
  const focusedOrders = useMemo(
    () => (focusedShopId == null
      ? orders
      : orders.filter(o => o.shop_id === focusedShopId)),
    [orders, focusedShopId],
  );

  // ZIP → order count (US-only since centroid table is US).
  const csvData = useMemo(() => {
    const byZip = new Map();
    for (const o of focusedOrders) {
      if (o.ship_country && o.ship_country.toUpperCase() !== 'US') continue;
      const zip = normalizeZip(o.ship_zip);
      if (!zip) continue;
      byZip.set(zip, (byZip.get(zip) ?? 0) + 1);
    }
    return [...byZip.entries()].map(([zip, count]) => ({ zip, count }));
  }, [focusedOrders]);

  // ZIP → detail bundle for click-to-inspect popup. Field shape matches
  // ZipDetailPopup's expectations from the zipmap project:
  //   { zip, city, state, orders[], totalValue, totalItems, customers (Set) }
  // Each order entry is { customer, sku, items, total, date }.
  const zipDetails = useMemo(() => {
    const byZip = new Map();
    for (const o of focusedOrders) {
      if (o.ship_country && o.ship_country.toUpperCase() !== 'US') continue;
      const zip = normalizeZip(o.ship_zip);
      if (!zip) continue;
      let entry = byZip.get(zip);
      if (!entry) {
        entry = {
          zip,
          city:  o.ship_city  ?? '',
          state: o.ship_state ?? '',
          orders: [],
          totalValue: 0,
          totalItems: 0,
          customers:  new Set(),
        };
        byZip.set(zip, entry);
      }
      const value = Number(o.total_price ?? 0);
      entry.orders.push({
        customer: o.buyer ?? '—',
        sku:      o.product_name ?? '—',
        items:    1,             // Etsy's get_orders gives us receipts, one per order; no per-line quantity here
        total:    value,
        date:     o.received_date,
      });
      entry.totalValue += value;
      entry.totalItems += 1;
      if (o.buyer) entry.customers.add(o.buyer);
    }
    return byZip;
  }, [focusedOrders]);

  const selectedDetail = useMemo(() => {
    if (!selectedZip) return null;
    const d = zipDetails.get(selectedZip);
    if (!d) return null;
    return {
      ...d,
      city:  d.city  || zipCityLookup.get(selectedZip)  || '',
      state: d.state || zipStateLookup.get(selectedZip) || '',
    };
  }, [selectedZip, zipDetails]);

  const { heatPoints, matched, unmatched, total } = useMemo(() => {
    if (!csvData.length) return { heatPoints: [], matched: 0, unmatched: 0, total: 0 };
    const maxCount = Math.max(...csvData.map(d => d.count));
    const logMax   = Math.log(maxCount + 1);
    let matched = 0, unmatched = 0, total = 0;
    const resolved = [];
    for (const { zip, count } of csvData) {
      total += count;
      const loc = zipLookup.get(zip);
      if (!loc) { unmatched++; continue; }
      matched++;
      resolved.push({ zip, lat: loc.lat, lng: loc.lng, count });
    }
    let heatPoints;
    if (scaleMode === 'rank') {
      const sorted = [...resolved].sort((a, b) => a.count - b.count);
      const n = sorted.length;
      heatPoints = sorted.map((p, i) => ({ zip: p.zip, lat: p.lat, lng: p.lng, weight: (i + 1) / n }));
    } else {
      heatPoints = resolved.map(p => ({
        zip: p.zip, lat: p.lat, lng: p.lng,
        weight: scaleMode === 'log'
          ? Math.log(p.count + 1) / logMax
          : p.count / maxCount,
      }));
    }
    return { heatPoints, matched, unmatched, total };
  }, [csvData, scaleMode]);

  const stats = useMemo(() => {
    if (!csvData.length) return null;
    const stateCounts = new Map();
    let topZip = null;
    for (const { zip, count } of csvData) {
      const state = zipStateLookup.get(zip);
      if (!state) continue;
      stateCounts.set(state, (stateCounts.get(state) ?? 0) + count);
      if (!topZip || count > topZip.count) {
        topZip = { zip, count, city: zipCityLookup.get(zip) };
      }
    }
    const topStates = [...stateCounts.entries()]
      .map(([state, count]) => ({ state, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    return { topStates, topZip, stateCount: stateCounts.size };
  }, [csvData]);

  function handleOriginZip(zip) {
    setOriginZip(zip);
    if (zip.length === 5) localStorage.setItem('mapTab-origin', zip);
    else localStorage.removeItem('mapTab-origin');
  }

  const ActiveStyle = styles.find(s => s.id === activeStyleId)?.component;
  const arcsActive  = activeStyleId === 'arcs';
  const needsOrigin = arcsActive && heatPoints.length > 0 && !originEntry;

  return (
    <div className="flex h-[calc(100vh-49px)] w-full overflow-hidden bg-slate-900 text-white">
      {/* ── Sidebar ── */}
      <aside className="w-64 flex-shrink-0 flex flex-col gap-3 p-4 bg-[#061526] border-r border-slate-700 overflow-y-auto">

        {/* ── Data summary ── */}
        <CollapsibleSection title="Live Orders">
          <div className="flex flex-col gap-2 text-xs text-slate-400">
            {loading && <p>Loading orders…</p>}
            {error && <p className="text-rose-400">{error}</p>}
            {!loading && !error && (
              <>
                <p>{orders.length.toLocaleString()} order{orders.length !== 1 ? 's' : ''} loaded</p>
                <p>{csvData.length.toLocaleString()} unique ZIP{csvData.length !== 1 ? 's' : ''}</p>
                <button
                  onClick={() => loadOrders(true)}
                  className="self-start mt-1 text-blue-400 hover:text-blue-300 transition-colors"
                >
                  ↻ Refresh from Etsy
                </button>
              </>
            )}
          </div>
        </CollapsibleSection>

        {/* ── Shop focus ── */}
        {SHOP_IDS.length > 1 && (
          <CollapsibleSection title="Filter by Shop">
            <div className="flex flex-col gap-1">
              <button
                onClick={() => setFocusedShopId(null)}
                className={[
                  'text-left text-xs rounded px-2 py-1 transition-colors',
                  focusedShopId == null
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700',
                ].join(' ')}
              >
                All shops
              </button>
              {SHOP_IDS.map(id => {
                const meta = SHOP_META[id];
                const label = meta?.name ?? `Shop ${id}`;
                return (
                  <button
                    key={id}
                    onClick={() => setFocusedShopId(id)}
                    className={[
                      'text-left text-xs rounded px-2 py-1 transition-colors flex items-center gap-2',
                      focusedShopId === id
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700',
                    ].join(' ')}
                  >
                    <span
                      className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                      style={{ background: meta?.color ?? '#888' }}
                    />
                    {label}
                  </button>
                );
              })}
            </div>
          </CollapsibleSection>
        )}

        {/* ── Base map ── */}
        <CollapsibleSection title="Base Map">
          <BaseMapToggle active={baseMap} onChange={setBaseMap} />
        </CollapsibleSection>

        {baseMap === 'flat' && (
          <CollapsibleSection title="Map Style">
            <div className="flex flex-col gap-2">
              <StyleSwitcher
                styles={styles}
                active={activeStyleId}
                onChange={setActiveStyleId}
              />
              {activeStyleId === 'heatmap' && heatPoints.length > 0 && (
                <HeatGradientPicker
                  active={heatGradientId}
                  onChange={setHeatGradientId}
                />
              )}
            </div>
          </CollapsibleSection>
        )}

        {baseMap === 'globe' && heatPoints.length > 0 && (
          <CollapsibleSection title="Globe Layers">
            <GlobeLayerControls
              showSpikes={globeShowSpikes}     onSpikes={setGlobeShowSpikes}
              showArcs={globeShowArcs}         onArcs={setGlobeShowArcs}
              showOrigin={globeShowOrigin}     onOrigin={setGlobeShowOrigin}
              arcsAnimated={globeArcsAnimated} onArcsAnimated={setGlobeArcsAnimated}
              hasOrigin={!!originEntry}
              gradientId={globeGradientId}     onGradient={setGlobeGradientId}
            />
          </CollapsibleSection>
        )}

        {arcsActive && (
          <CollapsibleSection title="Ship From">
            <OriginInput
              value={originZip}
              onChange={handleOriginZip}
              isValid={!!originEntry}
            />
          </CollapsibleSection>
        )}

        {heatPoints.length > 0 && (
          <CollapsibleSection title="Color Scale" defaultOpen={false}>
            <ScaleSwitcher active={scaleMode} onChange={setScaleMode} />
          </CollapsibleSection>
        )}

        {heatPoints.length > 0 && (
          <CollapsibleSection title="Legend" defaultOpen={false}>
            <Legend unmatched={unmatched} />
          </CollapsibleSection>
        )}

        {heatPoints.length > 0 && (
          <CollapsibleSection title="Export" defaultOpen={false}>
            <ExportButtons mapRef={mapRef} />
          </CollapsibleSection>
        )}

        <div className="mt-auto pt-2 text-xs text-slate-600">
          {zipLookup.size.toLocaleString()} ZIP codes indexed
        </div>
      </aside>

      {/* ── Map area ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {heatPoints.length > 0 && stats && (
          <StatCards total={total} matched={matched} stateCount={stats.stateCount} />
        )}

        <div ref={mapRef} className="flex-1 min-h-0 relative overflow-hidden">
          {baseMap === 'globe' ? (
            <GlobeView
              data={heatPoints}
              origin={originEntry}
              showSpikes={globeShowSpikes}
              showArcs={globeShowArcs}
              showOrigin={globeShowOrigin}
              arcsAnimated={globeArcsAnimated}
              gradientId={globeGradientId}
              onZipClick={setSelectedZip}
            />
          ) : (
            <MapContainer
              center={[39.5, -98.35]}
              zoom={4}
              style={{ height: '100%', width: '100%' }}
              zoomControl
            >
              <TileLayer
                url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
                subdomains="abcd"
                maxZoom={19}
                crossOrigin="anonymous"
              />
              {ActiveStyle && heatPoints.length > 0 && (
                <ActiveStyle
                  data={heatPoints}
                  origin={originEntry}
                  gradientId={heatGradientId}
                  onZipClick={setSelectedZip}
                />
              )}
            </MapContainer>
          )}

          <ZipDetailPopup detail={selectedDetail} onClose={() => setSelectedZip(null)} />

          {!loading && !heatPoints.length && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="bg-slate-900/80 rounded-xl px-6 py-4 text-center">
                <p className="text-slate-300 text-sm">
                  {orders.length === 0
                    ? 'No orders loaded yet'
                    : 'No US ZIP codes found in current orders'}
                </p>
                <p className="text-slate-500 text-xs mt-1">
                  {orders.length === 0
                    ? 'Connect a shop in Fulfillment, then return here.'
                    : 'Map shows US orders only. International addresses are filtered out.'}
                </p>
              </div>
            </div>
          )}

          {needsOrigin && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="bg-slate-900/80 rounded-xl px-6 py-4 text-center">
                <p className="text-slate-300 text-sm">Enter your shop ZIP in the sidebar</p>
                <p className="text-slate-500 text-xs mt-1">to draw shipping arcs from your location</p>
              </div>
            </div>
          )}

          {heatPoints.length > 0 && stats && (
            <TopStatesPanel
              topStates={stats.topStates}
              total={total}
              topZip={stats.topZip}
              stateCount={stats.stateCount}
            />
          )}
        </div>
      </div>
    </div>
  );
}
