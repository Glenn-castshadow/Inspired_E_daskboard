# Incremental Order Sync — Design

**Date:** 2026-06-12
**Status:** Approved by Glenn (design discussion in session; execution planned for a separate session)

## Problem

Every scheduled refresh (`loadOrders(true)` in `src/App.jsx`, at launch and every 30 minutes) calls `get_orders` with `force_refresh: true`, which re-paginates the **entire paid-order history** from Etsy — ~7,000 receipts for gkdesignhaus (6807617) plus ~1,250 for csdesigninc (7438218), at 100 per page. Historical orders never change, so this is ~70 redundant API requests per cycle. The SQLite cache (`orders` table in `cache.db`) is used only as a display cache (instant first paint, 30-minute freshness window), not as a source of truth that gets topped up.

A second, pre-existing bug: nothing ever **deletes** cache rows. `normalize` filters out `Canceled` receipts before upsert, so an order canceled after being cached lingers in the cache (and the UI) forever.

## Goal

After one full crawl per shop, every subsequent refresh fetches only receipts **modified since the last successful sync** — new orders plus status changes (shipped, canceled). The cache becomes the authoritative store. Canceled orders are evicted.

## Approach

Use Etsy v3 `getShopReceipts`' `min_last_modified` parameter (epoch seconds). Etsy bumps a receipt's modified timestamp on status changes (paid → shipped, cancellation, tracking added), so a delta query returns exactly the rows that need updating.

Approaches rejected:
- *Timer uses only the fast `was_shipped=false` path:* Analytics/Map would never learn when an open order ships or cancels.
- *Windowed crawl (last N days):* still redundant within the window; misses status changes older than the window.

## Changes

All in `src-tauri/src/` unless noted. No frontend changes.

### 1. `etsy.rs` — `fetch_shop_orders`

- Add parameter `min_last_modified: Option<i64>`.
- When `Some(ts)`, append `&min_last_modified={ts}` to the receipts URL. Everything else (pagination loop, `was_paid=true`, `includes=Listings`, image backfill via `fetch_listing_images`) is unchanged.
- **Return type change:** the function currently filters `Canceled` receipts and returns `Vec<Order>`. It must now also surface canceled receipt IDs so the caller can evict them. Return `(Vec<Order>, Vec<String>)` — (active normalized orders, canceled order IDs in `"IE-{receipt_id}"` cache-key format).
- Callers: `load_one_shop_orders` (uses both), `fetch_one_shop_open_orders` (uses both — evict canceled there too; it already upserts).

### 2. `etsy.rs` — `load_one_shop_orders`

New logic, per shop:

| Condition | Behavior |
|---|---|
| Not forced AND `shop_age_secs < 30 min` | Serve cache (unchanged) |
| No `shop_sync` row for shop (first run, or after `clear_shop_orders`) | Full crawl (`min_last_modified: None`), as today |
| Otherwise (forced, or cache stale) | **Delta fetch** with `min_last_modified = synced_at − 300` |

Delta path detail:
1. Capture `sync_started_at = now_unix()` **before** the fetch (receipts modified mid-fetch are caught by the next delta; stamping completion time would skip them).
2. Fetch delta. On any credential/token/fetch error: fail soft exactly as today — serve cache, do NOT touch `shop_sync`.
3. Upsert active orders; `delete_orders(&canceled_ids)`.
4. `mark_shop_synced(shop_id, sync_started_at)`.
5. Return the **full cached set** for the shop (re-read via `get_orders_for_shops`), not just the delta — callers expect the complete list.

The 5-minute overlap absorbs clock skew between Etsy and the local machine; upserts are idempotent so overlap is harmless.

The full-crawl path also gets steps 3–5 (with `sync_started_at`), which fixes canceled-order eviction there too.

### 3. `cache.rs` — two helpers

- `delete_orders(&self, ids: &[String]) -> Result<(), String>` — `DELETE FROM orders WHERE id = ?` in a transaction. No-op on empty slice.
- `mark_shop_synced(&self, shop_id: u64, synced_at: i64)` — add explicit timestamp parameter (currently stamps `now_unix()` internally). Update both existing call sites.

### 4. Semantics note (no code change)

`get_orders { forceRefresh: true }` now means "sync now (delta)" rather than "full crawl now". Full resync remains available via the existing `clear_shop_orders` / clear-cache path, which deletes the `shop_sync` row and thereby triggers the full-crawl branch on next load.

## What does NOT change

- Command signatures (`get_orders`, `get_open_orders`, `get_cached_orders`) — zero frontend changes.
- Fail-soft behavior: a dead shop token still serves stale cache silently. (Surfacing staleness is a separately queued task; out of scope here.)
- Sort order: open first, then shipped, due-date ascending.
- `get_open_orders` fast path keeps `was_shipped=false` (it's already cheap); it additionally evicts canceled IDs now that the fetch returns them.

## Edge cases

- **Hard-deleted receipts** (removed from Etsy entirely, not canceled): won't appear in any delta. Accepted; rare-to-nonexistent, and `clear_shop_orders` full-resync covers it.
- **Empty delta** (nothing changed): zero rows upserted; `synced_at` still advances. Cheapest possible cycle — one API request.
- **Etsy `min_last_modified` + `was_paid=true` interaction:** both are standard filters on the same endpoint; no known conflict.
- **First sync after this ships:** existing installs already have `shop_sync` rows, so their first refresh is a delta from the last full crawl — correct, since the cache holds that crawl's results.

## Verification

1. `cargo check` / `cargo build` in `src-tauri`.
2. Unit test for the canceled/active partition in the fetch-result handling.
3. Live: launch app, force refresh, then check `cache.db` (read-only): `shop_sync.synced_at` advances for both shops within seconds (vs. minutes), order row counts stay ~stable, and a known-canceled order disappears from the cache.
4. Confirm via timing/logs that the refresh issued ~1 request per shop, not ~70.

## Project conventions that apply

- Project path: `C:\Working_Projects\Inspired_E_daskboard` (never build on Z:).
- Pre-commit hook auto-bumps version on every commit (`scripts/bump-version.cjs`).
- Don't change build profiles or add `.cargo/config.toml` (invalidates the 442-crate cache); default MSVC linker only.
- Etsy `x-api-key` format is `keystring:shared_secret`; per-shop credentials in Windows Credential Manager.
