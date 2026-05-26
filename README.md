# Inspired Eclectics Dashboard

Internal Tauri desktop app for managing orders across all 3 Etsy shops. Replaces manual order tracking with a unified fulfillment queue and analytics view.

**Platform:** Windows 11 only · Single operator · Not a public app  
**Current version:** v0.1.8

---

## What it does

- **Fulfillment queue** — all open orders sorted by due date, color-coded by urgency, expandable rows showing buyer notes and hanging hole counts
- **Analytics** — sales charts and shop breakdowns (in progress)
- **Order status** is read directly from Etsy: `receipt.status === "completed"` means postage is printed, no manual toggle
- **Local SQLite cache** — data pulled from Etsy every 20 minutes, persists across restarts
- **USPS tracking** via EasyPost API, cached 15 minutes in SQLite

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
  App.jsx                 # Tab shell (Fulfillment / Analytics)
  fulfillment-view.jsx    # Order queue — filter pills, expandable rows
  etsy-dashboard.jsx      # Analytics dashboard (placeholder)
  main.jsx                # React entry point

src-tauri/
  Cargo.toml
  build.rs
  tauri.conf.json
  src/
    main.rs               # Tauri entry point — registers state + commands
    etsy.rs               # Etsy OAuth 2.0 + PKCE, token management, order fetch
    easypost.rs           # EasyPost tracking, in-memory + SQLite cache
    cache.rs              # SQLite cache layer (orders, tracking, shop sync)
```

---

## Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 18+
- [Tauri CLI prerequisites for Windows](https://tauri.app/v1/guides/getting-started/prerequisites)
- An [Etsy developer account](https://www.etsy.com/developers) with an app created
- An [EasyPost account](https://www.easypost.com/) with an API key

---

## Setup

### 1. Install dependencies and activate git hooks

```powershell
npm install
git config core.hooksPath .githooks
```

The second command activates the pre-commit hook that auto-bumps the patch version on every commit. Run it once after cloning — it's not automatic.

### 2. Configure API keys

On first launch, set your keys via the Tauri commands (call these once from the browser devtools console or wire up a settings UI):

```js
// Etsy app Keystring (from etsy.com/developers → your app → Keystring)
await invoke("set_etsy_api_key", { apiKey: "your_etsy_keystring" })

// EasyPost production API key
await invoke("set_easypost_api_key", { apiKey: "your_easypost_key" })
```

Keys are stored in **Windows Credential Manager** — you won't need to re-enter them after the first setup.

For development, you can use environment variables instead:

```powershell
$env:ETSY_API_KEY = "your_etsy_keystring"
$env:EASYPOST_API_KEY = "your_easypost_key"
```

### 3. Connect your Etsy shops

Call `etsy_connect` once per shop. This opens a browser tab for OAuth and waits for the redirect:

```js
await invoke("etsy_connect", { shopId: 12345678 })
```

Repeat for each of the 3 shops. Tokens are saved to Credential Manager and auto-refreshed.

> **Etsy app redirect URI setting:** in your Etsy developer app, add `http://127.0.0.1` as an allowed redirect URI (Etsy permits wildcard ports for desktop apps).

---

## Running

```powershell
# Development (Vite dev server + Rust hot reload)
cargo tauri dev

# Production build
cargo tauri build
```

The SQLite cache lives at `%APPDATA%\etsy-dashboard\cache.db`.

---

## Wiring up live data

The fulfillment queue currently uses mock data. To switch to live Etsy orders:

1. Replace `MOCK_ORDERS` in [`src/fulfillment-view.jsx`](src/fulfillment-view.jsx) with:

```js
const [orders, setOrders] = useState([]);
useEffect(() => {
  invoke("get_orders", { shopIds: [SHOP_ID_1, SHOP_ID_2, SHOP_ID_3] })
    .then(setOrders);
}, []);
```

2. The `Order` shape from the Rust layer matches the mock data exactly — no transformation needed.

### Etsy field mapping

| Frontend field | Etsy receipt field |
|---|---|
| `product_name` | `transactions[0].title` |
| `buyer` | `receipt.name` |
| `finish` | `transactions[0].variations[name="Finish"]` |
| `details.hanging_holes` | `transactions[0].personalization` (parsed int) |
| `details.special_instructions` | `receipt.message_from_buyer` |
| `due_date` | `receipt.expected_ship_date` (Unix → ISO date) |
| `shipped` / `postage_printed` | `receipt.status === "completed"` |

> Confirm the variation names "Finish" match your actual Etsy listing variation names before going live.

---

## Cache commands

```js
// Check cache age per shop and row counts
await invoke("cache_status", { shopIds: [123, 456, 789] })

// Force a fresh pull from Etsy on next get_orders call
await invoke("clear_cache")

// Or bypass cache for a single call
await invoke("get_orders", { shopIds: [...], forceRefresh: true })
```

---

## Version history

| Version | Date |
|---|---|
| v0.1.8 | 2026-05-26 |
| v0.1.7 | 2026-05-26 |
| v0.1.6 | 2026-05-26 |
| v0.1.5 | 2026-05-26 |
| v0.1.4 | 2026-05-26 |
| v0.1.3 | 2026-05-26 |
| v0.1.2 | 2026-05-26 |
| v0.1.1 | 2026-05-26 |
| v0.1.0 | 2026-05-26 |
