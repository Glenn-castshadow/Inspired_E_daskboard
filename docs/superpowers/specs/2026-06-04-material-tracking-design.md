# Material Tracking — Design Spec
**Date:** 2026-06-04  
**Status:** Approved  
**Scope:** Approach A (Core only) — label pool + iPhone scan-in/out + Fulfillment offcut badge

---

## Overview

Every piece of physical stock in the shop (sheets, blanks, offcuts, finished pieces) gets a pre-printed low-tack QR label from a pool. Scanning the label with an iPhone opens a mobile web page served by the existing inventory HTTP server. From there, operators check material in (assign label → record dimensions) or out (mark used). The Fulfillment tab passively shows an "Offcut available" badge when an active offcut's dimensions satisfy the category's minimum blank size.

---

## Data Model

Three additions to `cache.db`.

### `label_pool` (new table)
```sql
CREATE TABLE label_pool (
    id          TEXT PRIMARY KEY,   -- UUID baked into the QR code
    status      TEXT NOT NULL,      -- 'unassigned' | 'active' | 'retired'
    created_at  INTEGER NOT NULL,
    assigned_at INTEGER             -- unix timestamp; NULL until first scan
);
```

### `inventory_items` (new column)
```sql
ALTER TABLE inventory_items ADD COLUMN label_id TEXT REFERENCES label_pool(id);
```
`NULL` means the item predates the tracking system or was entered manually without a label. The rest of the inventory system is unaffected.

### `category_blank_sizes` (new table)
```sql
CREATE TABLE category_blank_sizes (
    category   TEXT PRIMARY KEY,   -- e.g. 'ORN', 'DBC', 'WAL' (taxonomy codes)
    min_width  REAL NOT NULL,      -- inches
    min_height REAL NOT NULL
);
```
Seeded manually once by the operator. An offcut is a candidate for an order when `offcut.width >= min_width AND offcut.height >= min_height` for the order's resolved category.

---

## iPhone Scan Flow

### QR code content
Each label encodes a single URL:
```
http://[inventory-server-ip]:[port]/m/[LABEL_ID]
```

### New routes on the inventory HTTP server

#### `GET /m/:id` — scan landing page
Two states based on label status:

**Unassigned label** → check-in form:
- Item type selector: Sheet / Blank / Offcut / Finished
- Material selector (from taxonomy MATERIALS list)
- Width (inches), Height (inches)
- Thickness selector: 1/8" / 1/4"
- Optional notes field
- Submit → `POST /m/:id/in`

**Active label** → item summary + action:
- Shows: item type, material, dimensions, thickness, notes
- Single large **"Check Out"** button → `POST /m/:id/out`

**Retired label** → read-only message: "This label has been retired." Shows last known item details. No actions.

**Unknown label** → "Label not recognized. Please generate a fresh batch from the desktop."

#### `POST /m/:id/in` — check in
Creates an `inventory_items` row with the submitted fields and `quantity = 1` (one label = one physical piece), sets `label_id = id`, updates `label_pool.status = 'active'` and `assigned_at = now()`. Labeled items always have `quantity = 1`; the label itself is the identity of the piece.

#### `POST /m/:id/out` — check out
Sets `inventory_items.quantity = 0` for the linked item, sets `label_pool.status = 'retired'`.

### Mobile page design
Plain HTML + inline CSS, no JavaScript framework, no build step. Served directly by the Rust HTTP server. Designed for one-handed use in Safari. Large tap targets, minimal form fields.

---

## Label Pool Management (Desktop)

New collapsible **"Label Pool"** section at the top of the Inventory tab.

**Displays:**
- Count of unassigned / active / retired labels

**Actions:**
- **Generate batch** — creates N UUIDs in `label_pool` with `status = 'unassigned'`. Default N = 50, input field to override.
- **Print batch** — opens `http://localhost:[port]/labels/print` in the system browser. Shows a grid of QR codes for all unassigned labels (30 per page, Avery-sheet-compatible). Operator prints via browser native print dialog.

### New routes for label printing

#### `GET /labels/print` — print page
Plain HTML grid of `<img src="/labels/qr/:id">` tags for all `status = 'unassigned'` labels.

#### `GET /labels/qr/:id` — QR code image
Returns a PNG QR code for the given label ID. Generated with the `qrcode` + `image` Rust crates (no network dependency, no external service).

---

## Fulfillment Tab — Offcut Badge

### Logic (runs client-side in JavaScript)
For each order row in the Fulfillment tab:
1. Resolve `sku_base` → category via existing `listing_product_links` data (already loaded).
2. Look up category in `category_blank_sizes` (loaded once at app start via `get_category_blank_sizes`).
3. Filter `inventory_items` (already loaded via `get_inventory`) where:
   - `item_type = 'offcut'`
   - `width >= min_width`
   - `height >= min_height`
   - `label_id IS NOT NULL` (actively tracked piece)
   - `quantity > 0`

### UI
- Match found → **"✂ Offcut available"** badge on the order row (styled consistently with existing stock/category badges).
- Clicking the badge expands an inline list of matching offcuts: material, W×H dimensions, label ID (so operator can locate the physical piece).
- No match, or category has no size entry → badge absent. No error state.

### New Tauri command
`get_category_blank_sizes` — simple `SELECT * FROM category_blank_sizes`. Called once in `App.jsx` at startup alongside other data loads. Result passed down to Fulfillment tab as a prop.

---

## Error Handling & Edge Cases

| Scenario | Behavior |
|---|---|
| Retired label scanned | Read-only page: "This label has been retired." Last item details shown. |
| Unknown label UUID | "Label not recognized." Prompt to generate new batch. |
| Inventory server not running | QR URL times out in Safari. Server starts automatically with the app (existing behavior). |
| Category missing from `category_blank_sizes` | Offcut badge simply absent for that order. No crash. |
| Offcut dimensions entered wrong | No validation beyond > 0. Notes field is the escape hatch. |
| Two machines / two operators | When `inventory_server_url` is configured, both iPhones hit the same shared server. Same label pool, same DB. |

---

## What This Does NOT Include (Deferred)

- **Transaction log / audit history** — no `material_events` table. Operator was present for every move.
- **Dedicated Materials tab** — label pool management lives in the Inventory tab. No new nav item.
- **Per-SKU cut dimensions** — recommendation uses category-level defaults only.
- **Partial quantity check-out** — checking out retires the whole label. Multi-quantity sheets would need multiple labels or a manual quantity edit.
- **Offcut shape types** — bounding box (W×H) only. L-shapes and other irregular cuts use the notes field.

---

## Files Touched

### Rust (`src-tauri/src/`)
- `inventory.rs` — add `label_id` field to `InventoryItem` / `NewInventoryItem`; add check-in/out HTTP route handlers; add label pool table init + batch generation logic; add QR generation routes
- `cache.rs` — add `label_pool` and `category_blank_sizes` table creation to DB init
- `main.rs` — register `get_category_blank_sizes` Tauri command

### Frontend (`src/`)
- `inventory-tab.jsx` — add Label Pool section (generate batch, print batch buttons + counts)
- `fulfillment-view.jsx` — add offcut badge logic + expandable offcut list per order row
- `App.jsx` — load `category_blank_sizes` at startup, pass to Fulfillment tab

### Dependencies (Cargo.toml)
- `qrcode = "0.14"` — new, not currently in Cargo.toml
- `image = "0.25"` — new, not currently in Cargo.toml

---

## Open Questions (none blocking)
- What label sheet format does your label printer use? (Affects the print page layout — Avery 5160 assumed.)
- Initial `category_blank_sizes` values — you'll seed these after the feature ships.
