# Genevieve Etsy Dashboard

Internal Tauri desktop app for managing orders across multiple Etsy shops. Replaces manual order tracking with a unified fulfillment queue, analytics dashboard, and customer geography map.

**Platform:** Windows 11 only · Single operator · Not a public app
**Current version:** v0.1.24

---

## What it does

Three tabs:

### Fulfillment
- Open orders sorted by due date, color-coded by urgency, with per-shop color stripes and pills.
- Daily summary banner — overdue / due today / due tomorrow counts, clickable to apply an "urgent" filter.
- Listing photo thumbnails on every row.
- Expand a row for buyer notes, hanging-hole counts, special instructions, and live USPS tracking lookup.
- **Bulk pick list** — checkbox rows and print a single page with photos, finish, and notes; print CSS hides app chrome so the printout is clean.
- **Mark as shipped** from the row drawer — tracking code + carrier dropdown; POSTs Etsy's `createReceiptShipment` (which emails the buyer) and invalidates that shop's cache.
- HTML entity decoding for Etsy product titles (`&quot;` etc.).

### Analytics
- 4 stat cards for the **current month**: orders, revenue, avg order value, open orders.
- 30-day revenue area chart.
- Orders-by-shop bar chart — colored to match Fulfillment; click a bar to focus the whole tab on one shop.
- Top 5 products this month.
- **All-time history panel** (ported from the etsy-customer-heatmap project):
  - All-time KPIs — gross revenue, orders, avg order, months covered.
  - Monthly revenue bar chart for every month in the cache.
  - Top 10 buyers, ranked, with gradient bars.
  - Top 10 products by revenue with units + order count.
  - Orders-by-weekday donut chart with weekend vs. weekday emphasis.

### Map
- Live ZIP-level customer geography fed by the same `get_orders` invoke as the rest of the app.
- 5 flat-map styles: heat map, bubbles, shipping arcs, treasure piles, pushpins.
- 3-D globe view with spikes / arcs / origin marker.
- Per-shop filter pills that match Fulfillment colors.
- Linear / log / rank weight normalization; six gradient themes for heat and globe.
- Click any ZIP for a popup: orders, top customers, top products, revenue, recent orders.
- Floating Top States panel with auto-generated insights.
- Export current map view as PNG / JPEG.
- 42,354 US ZIP centroids bundled — no network calls.

### Cross-cutting
- **Dark mode** — toggle in the top-right of the tab bar. Choice persists to `localStorage`; defaults to the OS color scheme. (Map tab is dark-only since map visualizations need a dark canvas.)
- **F12** opens WebView2 devtools even in release builds.
- **Shipped detection** uses Etsy's `is_shipped` flag plus tracking-code presence (not `receipt.status`, which actually tracks payment state).
- **Local SQLite cache** — orders cached 30 minutes, tracking 15 minutes. Survives restarts.
- **Per-shop credentials** — each shop has its own Etsy app (keystring + shared secret) since they're owned by separate accounts. All stored in Windows Credential Manager.
- **Encrypted credentials export/import** to migrate setups between PCs (see *Migrating to a new PC* below).

---

## Tech stack

| Layer | Technology |
|---|---|
| Desktop shell | Tauri v2 |
| Backend | Rust — reqwest, serde, tokio, keyring, rusqlite, aes-gcm |
| Frontend | React 18, Vite 4 |
| Charts (Analytics current-month) | recharts |
| Charts (Analytics history) | hand-rolled SVG |
| Map (flat) | leaflet + react-leaflet 4 + custom canvas heat layer |
| Map (globe) | react-globe.gl + three.js |
| Map styling | Tailwind v3 (Map tab + Analytics history panel only) |
| Tracking | USPS Tracking 3.2 (OAuth 2.0 client credentials) — *unverified, pending real credentials* |
| Token storage | Windows Credential Manager (via `keyring` crate) |

---

## Project structure

```
src/
  App.jsx                       # Tab shell + dark mode toggle (Fulfillment / Analytics / Map)
  theme.js                      # CSS custom property palettes for light/dark
  config.js                     # Shop IDs + per-shop branding (color, name)
  fulfillment-view.jsx          # Order queue — filter pills, expandable rows, mark-shipped, pick list
  etsy-dashboard.jsx            # Analytics — current-month KPIs + recharts panels + history embed
  analytics-history.jsx         # All-time history panel — monthly bars, top buyers/products, weekday donut
  index.css                     # Tailwind base — Map tab and history panel only
  main.jsx                      # React entry point
  map-tab/
    MapView.jsx                 # Map tab root — adapts live orders to zipmap data shape
    components/                 # Ported from etsy-customer-heatmap project
    mapStyles/                  # heatmap / bubbles / arcs / treasure / pushpins
    data/zipCentroids.json      # 42,354 US ZIP centroids
    utils/                      # exportMap, useLodData

src-tauri/
  Cargo.toml
  tauri.conf.json               # Tauri v2 schema
  capabilities/default.json     # Tauri v2 capabilities (was v1 allowlist)
  src/
    main.rs                     # Tauri entry — registers state, plugins, commands
    etsy.rs                     # Per-shop OAuth 2.0 + PKCE, token mgmt, order fetch,
                                # createReceiptShipment, encrypted credentials export/import
    usps.rs                     # USPS Tracking 3.2 (OAuth) — replaces easypost.rs
    easypost.rs                 # NOT compiled (preserved for git history)
    cache.rs                    # SQLite cache layer (orders, tracking, shop sync, clear_shop_orders)
```

---

## Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 18+
- [Tauri v2 prerequisites for Windows](https://v2.tauri.app/start/prerequisites/)
- An [Etsy developer app](https://www.etsy.com/developers) **per shop** (each shop = separate Etsy account = separate app)
- A [USPS Web Tools account](https://developer.usps.com/) (Consumer Key + Consumer Secret for Tracking 3.2)

> **Important:** develop on a **local drive**, not a network mount. Network drives cause stale `.cargo-lock` files and slow incremental builds. This project once lived on a `Z:\` share and got stuck repeatedly until it was moved to `C:\Working_Projects\`.

---

## Setup

### 1. Install dependencies and activate git hooks

```powershell
npm install
git config core.hooksPath .githooks
```

The second command activates the pre-commit hook that auto-bumps the patch version on every commit (now Tauri-v2-schema aware).

### 2. Register OAuth callback in each Etsy app

For each Etsy developer app (one per shop), add this callback URL:

```
http://localhost:7777/callback
```

Etsy v3 no longer accepts IP addresses (`127.0.0.1`), so we use the `localhost` hostname on a fixed port.

### 3. Run the app

```powershell
npx tauri dev
```

First build is ~10 minutes (cold compile of ~440 Rust crates). Subsequent runs are seconds.

### 4. Configure credentials (one-time, from DevTools console)

Open DevTools with **F12**, then:

```js
const { invoke } = window.__TAURI__.core   // Tauri v2 — was window.__TAURI__.tauri.invoke in v1

// Set USPS credentials (one global pair for tracking lookups)
await invoke("set_usps_credentials", {
  clientId:     "consumer_key_here",
  clientSecret: "consumer_secret_here"
})

// Set per-shop Etsy credentials (keystring + shared secret from each app)
await invoke("set_etsy_shop_credentials", {
  shopId: 7438218,             // Inspired Eclectics
  apiKey: "keystring_here",
  sharedSecret: "shared_secret_here"
})

await invoke("set_etsy_shop_credentials", {
  shopId: 6807617,             // gkdesignhaus
  apiKey: "keystring_here",
  sharedSecret: "shared_secret_here"
})

// Connect each shop via OAuth (opens browser, log in as that shop's account, approve)
await invoke("etsy_connect", { shopId: 7438218 })
await invoke("etsy_connect", { shopId: 6807617 })
```

All credentials live in Windows Credential Manager. The dashboard auto-pulls on launch.

---

## Etsy API specifics

These cost us hours of debugging — documented here so they don't again:

- **`x-api-key` header format:** `keystring:shared_secret` (colon-separated). Not just the keystring, not just the secret.
- **`receipt.status` is payment state**, not shipment state. Use `receipt.is_shipped` (boolean) for "did we ship this".
- **Mark-as-shipped requires the `transactions_w` OAuth scope.** If you upgraded from a version before this scope was added, re-run `etsy_connect` for each shop.
- **Callback URL must be a hostname**, not an IP. `http://localhost:7777/callback` works; `http://127.0.0.1:7777` is rejected.
- **Rate limits per app:** 5 QPS / 5K QPD. Our 30-min cache + 250ms inter-shop delay stay well under.
- **Receipt shipping address fields are top-level** (`zip`, `state`, `city`, `country_iso`) — not nested under a `shipping_address` object. Used by the Map tab.

---

## Etsy field mapping

| Frontend field | Etsy receipt field |
|---|---|
| `product_name` | `transactions[0].title` |
| `buyer` | `receipt.name` |
| `finish` | `transactions[0].variations[name="Finish"]` |
| `details.hanging_holes` | `transactions[0].personalization` (parsed int) |
| `details.special_instructions` | `receipt.message_from_buyer` |
| `due_date` | `receipt.expected_ship_date` (Unix → ISO date) |
| `total_price` | `receipt.grandtotal.amount / divisor` |
| `tracking_code` | `receipt.shipments[0].tracking_code` |
| `postage_printed` / `status: "completed"` | `receipt.is_shipped` OR tracking_code present |
| `image_url` | `/listings/batch?listing_ids=...&includes=Images` (batched second call) |
| `ship_zip`, `ship_state`, `ship_city`, `ship_country` | `receipt.zip`, `receipt.state`, `receipt.city`, `receipt.country_iso` |

---

## Per-shop branding

Each shop has a color used for both a 4px left-border stripe on every row and a solid pill near the order ID:

| Shop | Color | Hex |
|---|---|---|
| Inspired Eclectics (csdesigninc) | Dark coffee brown | `#6F4E37` |
| gkdesignhaus | Purple | `#5E3A8E` |
| BitterChimp | Green | `#4A7C4A` |

Defined in `src/config.js` → `SHOP_META`.

---

## Migrating to a new PC

Credentials live in Windows Credential Manager, which is per-user per-machine, so they don't sync automatically. Use the encrypted export/import commands to move everything in one file.

**On the source PC** (with credentials already configured):

```js
const { invoke } = window.__TAURI__.core
await invoke("export_credentials", {
  shopIds: [7438218, 6807617, 22660031],   // every shop you want included
  passphrase: "pick a strong passphrase",
  filePath: "C:/Users/glenn/Desktop/genevieve-creds.bak"
})
```

The file is AES-256-GCM encrypted with a PBKDF2-derived key (100k iterations, SHA-256). The file alone is useless without the passphrase. Copy it to the new PC (USB, encrypted cloud, whatever).

**On the new PC** (after installing the dashboard):

```js
const { invoke } = window.__TAURI__.core
await invoke("import_credentials", {
  passphrase: "same passphrase as export",
  filePath: "C:/path/to/genevieve-creds.bak"
})
// Returns the array of imported shop IDs
```

USPS keys + every shop's Etsy keystring, shared secret, and OAuth tokens all land in the new PC's Credential Manager. No browser OAuth re-auth needed — token refresh happens on the next API call.

> **Path tip:** use forward slashes or double-backslashes in JS strings. A single `\` in `"C:\path\..."` is an escape sequence and will fail with `OS error 3`.

---

## Cache commands

```js
// Check cache age per shop and row counts
await invoke("cache_status", { shopIds: [7438218, 6807617] })

// Force a fresh pull from Etsy on next get_orders call
await invoke("clear_cache")

// Or bypass cache for a single call
await invoke("get_orders", { shopIds: [7438218, 6807617], forceRefresh: true })

// Clear the tracking cache only (USPS lookups)
await invoke("clear_tracking_cache")
```

---

## Running

```powershell
# Development (Vite dev server + Rust auto-rebuild on .rs save)
npx tauri dev

# Production build (single .msi + .exe installer)
npx tauri build
```

Installer output: `src-tauri/target/release/bundle/nsis/etsy-dashboard_<version>_x64-setup.exe`

The SQLite cache lives at `%APPDATA%\com.castshadow.etsy-dashboard\cache.db`.
WebView2 user data at `%LOCALAPPDATA%\com.castshadow.etsy-dashboard\EBWebView`.

---

## Build pitfalls (don't repeat)

- **Do not add `[profile.dev]` overrides or `.cargo/config.toml`** — every change invalidates the entire 440-crate cache.
- **Do not use `lld-link`** — causes ntdll.dll access violations at runtime. Stay on the default MSVC linker even though it's slower.
- **Do not develop on a network drive** — file locking semantics differ; `.cargo-lock` gets stuck. Use `C:\Working_Projects\` (or wherever your local SSD lives), not the `Z:\` share.
- **Do not kill `cargo tauri dev` mid-build** — leaves stale `.cargo-lock` files. If you do, delete `src-tauri/target/debug/.cargo-lock` before next run.
- **`src-tauri/gen/` is gitignored** — Tauri v2 generates it from `capabilities/` + config at every build. Don't commit it.

---

## Outstanding work

- USPS Tracking 3.2 is wired up but unverified end-to-end. Need to register at [developer.usps.com](https://developer.usps.com/), get a Consumer Key + Consumer Secret, call `set_usps_credentials`, and test `get_tracking` against a real tracking number. May need URL or field-name adjustments depending on USPS's actual response shape.

---

## Version history

| Version | Date |
|---|---|
| v0.1.24 | 2026-05-28 |
| v0.1.23 | 2026-05-28 |
| v0.1.22 | 2026-05-28 |
| v0.1.21 | 2026-05-28 |
| v0.1.20 | 2026-05-28 |
| v0.1.19 | 2026-05-28 |
| v0.1.18 | 2026-05-27 |
| v0.1.16 | 2026-05-27 |
| v0.1.15 | 2026-05-27 |
| v0.1.14 | 2026-05-27 |
| v0.1.13 | 2026-05-27 |
| v0.1.12 | 2026-05-27 |
| v0.1.11 | 2026-05-27 |
| v0.1.10 | 2026-05-27 |
| v0.1.9 | 2026-05-27 |
| v0.1.8 | 2026-05-26 |
| v0.1.7 | 2026-05-26 |
| v0.1.6 | 2026-05-26 |
| v0.1.5 | 2026-05-26 |
| v0.1.4 | 2026-05-26 |
| v0.1.3 | 2026-05-26 |
| v0.1.2 | 2026-05-26 |
| v0.1.1 | 2026-05-26 |
| v0.1.0 | 2026-05-26 |
