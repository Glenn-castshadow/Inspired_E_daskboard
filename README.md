# Genevieve Etsy Dashboard

Internal Tauri desktop app for managing orders across multiple Etsy shops. Replaces manual order tracking with a unified fulfillment queue and analytics view.

**Platform:** Windows 11 only · Single operator · Not a public app
**Current version:** v0.1.18

---

## What it does

- **Fulfillment queue** — open orders sorted by due date, color-coded by urgency, with per-shop color stripes and pills. Expand a row to see buyer notes, hanging hole counts, and live USPS tracking.
- **Analytics dashboard** — monthly revenue/order stats, 30-day revenue trend, orders-by-shop bars, top products ranked.
- **Dark mode** — toggle in the top-right of the tab bar. Choice persists to `localStorage`; defaults to the OS color scheme.
- **Shipped detection** uses Etsy's `is_shipped` flag plus tracking-code presence (not `receipt.status`, which actually tracks payment state).
- **Local SQLite cache** — orders cached 30 minutes, tracking 15 minutes. Survives restarts.
- **Per-shop credentials** — each shop has its own Etsy app (keystring + shared secret) since they're owned by separate accounts. All stored in Windows Credential Manager.

---

## Tech stack

| Layer | Technology |
|---|---|
| Desktop shell | Tauri v1 |
| Backend | Rust — reqwest, serde, tokio, keyring, rusqlite |
| Frontend | React 18, Vite 4, recharts |
| Tracking | EasyPost API v2 |
| Token storage | Windows Credential Manager (via `keyring` crate) |

---

## Project structure

```
src/
  App.jsx                 # Tab shell + dark mode toggle
  theme.js                # CSS custom property palettes for light/dark
  config.js               # Shop IDs + per-shop branding (color, name)
  fulfillment-view.jsx    # Order queue — filter pills, expandable rows, tracking
  etsy-dashboard.jsx      # Analytics (stat cards, revenue area chart, shop bars, top products)
  main.jsx                # React entry point

src-tauri/
  Cargo.toml
  tauri.conf.json
  src/
    main.rs               # Tauri entry — registers state + commands
    etsy.rs               # Per-shop OAuth 2.0 + PKCE, token mgmt, order fetch
    easypost.rs           # EasyPost tracking, in-memory + SQLite cache
    cache.rs              # SQLite cache layer (orders, tracking, shop sync)
```

---

## Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 18+ (avoid v24 — incompatible with prebuilt Tauri CLI; use `cargo install tauri-cli --version "^1.0.0"` instead)
- [Tauri CLI prerequisites for Windows](https://tauri.app/v1/guides/getting-started/prerequisites)
- An [Etsy developer app](https://www.etsy.com/developers) **per shop** (each shop = separate Etsy account = separate app)
- An [EasyPost account](https://www.easypost.com/) with an API key

> **Important:** develop on a **local drive**, not a network mount. Network drives cause stale `.cargo-lock` files and slow incremental builds.

---

## Setup

### 1. Install dependencies and activate git hooks

```powershell
npm install
git config core.hooksPath .githooks
```

The second command activates the pre-commit hook that auto-bumps the patch version on every commit.

### 2. Register OAuth callback in each Etsy app

For each Etsy developer app (one per shop), add this callback URL:

```
http://localhost:7777/callback
```

Etsy v3 no longer accepts IP addresses (`127.0.0.1`), so we use the `localhost` hostname on a fixed port.

### 3. Run the app

```powershell
cargo tauri dev
```

First build is ~10 minutes (cold compile of ~440 Rust crates). Subsequent runs are seconds.

### 4. Configure credentials (one-time, from DevTools console)

Open DevTools with **F12**, then:

```js
const invoke = window.__TAURI__.tauri.invoke

// Set EasyPost key (one global key for tracking lookups)
await invoke("set_easypost_api_key", { apiKey: "EZ_..." })

// Set per-shop Etsy credentials (keystring + shared secret from each app)
await invoke("set_etsy_shop_credentials", {
  shopId: 7438218,             // csdesigninc / Inspired Eclectics
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
- **Callback URL must be a hostname**, not an IP. `http://localhost:7777/callback` works; `http://127.0.0.1:7777` is rejected.
- **Rate limits per app:** 5 QPS / 5K QPD. Our 30-min cache + 250ms inter-shop delay stay well under.

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
const invoke = window.__TAURI__.tauri.invoke
await invoke("export_credentials", {
  shopIds: [7438218, 6807617, 22660031],   // every shop you want included
  passphrase: "pick a strong passphrase",
  filePath: "C:\\Users\\glenn\\Desktop\\genevieve-creds.bak"
})
```

The file is AES-256-GCM encrypted with a PBKDF2-derived key (100k iterations, SHA-256). The file alone is useless without the passphrase. Copy it to the new PC (USB, encrypted cloud, whatever).

**On the new PC** (after installing the dashboard):

```js
const invoke = window.__TAURI__.tauri.invoke
await invoke("import_credentials", {
  passphrase: "same passphrase as export",
  filePath: "C:\\path\\to\\genevieve-creds.bak"
})
// Returns the array of imported shop IDs
```

EasyPost key + every shop's Etsy keystring, shared secret, and OAuth tokens all land in the new PC's Credential Manager. No browser OAuth re-auth needed — token refresh happens on the next API call.

---

## Cache commands

```js
// Check cache age per shop and row counts
await invoke("cache_status", { shopIds: [7438218, 6807617] })

// Force a fresh pull from Etsy on next get_orders call
await invoke("clear_cache")

// Or bypass cache for a single call
await invoke("get_orders", { shopIds: [7438218, 6807617], forceRefresh: true })
```

---

## Running

```powershell
# Development (Vite dev server + Rust auto-rebuild on .rs save)
cargo tauri dev

# Production build (single .msi installer)
cargo tauri build
```

The SQLite cache lives at `%APPDATA%\com.castshadow.etsy-dashboard\cache.db`.
WebView2 user data at `%LOCALAPPDATA%\com.castshadow.etsy-dashboard\EBWebView`.

---

## Build pitfalls (don't repeat)

- **Do not add `[profile.dev]` overrides or `.cargo/config.toml`** — every change invalidates the entire 440-crate cache.
- **Do not use `lld-link`** — causes ntdll.dll access violations at runtime. Stay on the default MSVC linker even though it's slower.
- **Do not develop on a network drive** — file locking semantics differ; `.cargo-lock` gets stuck.
- **Do not kill `cargo tauri dev` mid-build** — leaves stale `.cargo-lock` files. If you do, delete `src-tauri/target/debug/.cargo-lock` before next run.

---

## Version history

| Version | Date |
|---|---|
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
