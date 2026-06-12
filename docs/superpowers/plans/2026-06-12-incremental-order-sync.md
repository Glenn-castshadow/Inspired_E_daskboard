# Incremental Order Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop re-crawling the full Etsy order history every refresh; delta-fetch only receipts modified since the last successful sync, and evict canceled orders from the cache.

**Architecture:** `fetch_shop_orders` gains a `min_last_modified` filter and returns canceled receipt IDs alongside normalized orders. `load_one_shop_orders` does a full crawl only when a shop has no `shop_sync` row; otherwise it delta-fetches from `synced_at − 5 min`, merges into the SQLite cache (upsert active / delete canceled), and returns the full cached set. The cache becomes the source of truth.

**Tech Stack:** Rust (Tauri v2 backend), rusqlite (bundled, WAL), reqwest, Etsy Open API v3 `getShopReceipts`.

**Spec:** `docs/superpowers/specs/2026-06-12-incremental-order-sync-design.md`

**Critical project constraints (from hard-won experience — do not violate):**
- Work in `C:\Working_Projects\Inspired_E_daskboard` (NEVER the Z: network path — cargo file locks).
- Do NOT change cargo build profiles or add `.cargo/config.toml` (invalidates the 442-crate cache). Default MSVC linker only.
- The pre-commit hook auto-bumps the version on every commit; just commit normally.
- The working tree has unrelated WIP (`inventory-server/routes/scan.js`, `package-lock.json`, `src-tauri/Cargo.lock`). Never `git add -A`; stage only the files named in each commit step (the hook stages its own version files).
- Run tests with: `cargo test --manifest-path src-tauri/Cargo.toml` from the project root. The first run compiles the full crate tree (~minutes); later runs are incremental. There are no pre-existing tests — this plan adds the first ones.

---

### Task 1: Cache helpers — `delete_orders`, timestamped `mark_shop_synced`, `shop_synced_at`

**Files:**
- Modify: `src-tauri/src/cache.rs` (existing helpers at lines ~321–385)
- Tests: inline `#[cfg(test)]` module at the bottom of `cache.rs`

Note: this task changes `mark_shop_synced`'s signature, which breaks its one call site at `src-tauri/src/etsy.rs:1018` until Task 3 rewires it. To keep every commit compiling, Step 3 includes a one-line interim fix at that call site.

- [ ] **Step 1: Write the failing tests**

Append to the bottom of `src-tauri/src/cache.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn test_db() -> CacheDb {
        // rusqlite treats ":memory:" as an in-memory database; all migrations
        // in CacheDb::new run against it (WAL pragma is a no-op there).
        CacheDb::new(Path::new(":memory:")).expect("in-memory cache")
    }

    #[test]
    fn delete_orders_removes_only_named_ids() {
        let db = test_db();
        db.upsert_orders(&[
            ("IE-1".to_string(), 7, "{\"id\":\"IE-1\"}".to_string()),
            ("IE-2".to_string(), 7, "{\"id\":\"IE-2\"}".to_string()),
        ])
        .unwrap();

        db.delete_orders(&["IE-1".to_string()]).unwrap();

        let rows = db.get_orders_for_shops(&[7]).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].contains("IE-2"));
    }

    #[test]
    fn delete_orders_empty_slice_is_noop() {
        let db = test_db();
        db.delete_orders(&[]).unwrap();
    }

    #[test]
    fn mark_shop_synced_stores_explicit_timestamp() {
        let db = test_db();
        db.mark_shop_synced(7, 1_750_000_000).unwrap();
        assert_eq!(db.shop_synced_at(7), Some(1_750_000_000));
    }

    #[test]
    fn shop_synced_at_none_for_unknown_shop() {
        let db = test_db();
        assert_eq!(db.shop_synced_at(999), None);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: COMPILE ERROR — `no method named delete_orders` / `no method named shop_synced_at` on `CacheDb`, and `mark_shop_synced` called with 2 args but takes 1.

- [ ] **Step 3: Implement the helpers**

In `src-tauri/src/cache.rs`, replace the existing `shop_age_secs` and `mark_shop_synced` (lines ~366–385) with:

```rust
    /// Unix timestamp of the shop's last successful sync, if any.
    pub fn shop_synced_at(&self, shop_id: u64) -> Option<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT synced_at FROM shop_sync WHERE shop_id = ?1",
            params![shop_id as i64],
            |row| row.get::<_, i64>(0),
        )
        .ok()
    }

    pub fn shop_age_secs(&self, shop_id: u64) -> Option<i64> {
        self.shop_synced_at(shop_id).map(|synced_at| now_unix() - synced_at)
    }

    /// Record a successful sync. Callers pass the time the fetch STARTED so
    /// receipts modified mid-fetch fall after the mark and are caught by the
    /// next delta.
    pub fn mark_shop_synced(&self, shop_id: u64, synced_at: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO shop_sync (shop_id, synced_at) VALUES (?1, ?2)",
            params![shop_id as i64, synced_at],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
```

Directly below `upsert_orders` (after line ~335), add:

```rust
    /// Delete cached orders by id — used to evict receipts Etsy reports as
    /// Canceled, which would otherwise linger in the cache forever.
    pub fn delete_orders(&self, ids: &[String]) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for id in ids {
            tx.execute("DELETE FROM orders WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }
```

Interim fix so the crate keeps compiling (Task 3 replaces this line properly) — in `src-tauri/src/etsy.rs:1018`, change:

```rust
    let _ = cache.mark_shop_synced(shop_id);
```

to:

```rust
    let _ = cache.mark_shop_synced(shop_id, now_unix());
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — 4 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/cache.rs src-tauri/src/etsy.rs
git commit -m "feat(cache): delete_orders, shop_synced_at, timestamped mark_shop_synced"
```

---

### Task 2: Pure fetch helpers — `receipts_url` and `partition_receipts`

**Files:**
- Modify: `src-tauri/src/etsy.rs` (add two functions near `fetch_shop_orders`, line ~629; add `#[cfg(test)]` module at the bottom)

These are new standalone functions; nothing calls them until Task 3, so the crate compiles throughout.

- [ ] **Step 1: Write the failing tests**

Append to the bottom of `src-tauri/src/etsy.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipts_url_without_min_last_modified() {
        let url = receipts_url(6807617, 100, 0, false, None);
        assert!(url.contains("/application/shops/6807617/receipts?"));
        assert!(url.contains("limit=100"));
        assert!(url.contains("offset=0"));
        assert!(url.contains("was_paid=true"));
        assert!(url.contains("includes=Listings"));
        assert!(!url.contains("min_last_modified"));
        assert!(!url.contains("was_shipped"));
    }

    #[test]
    fn receipts_url_with_min_last_modified_and_unshipped() {
        let url = receipts_url(6807617, 100, 200, true, Some(1_750_000_000));
        assert!(url.contains("min_last_modified=1750000000"));
        assert!(url.contains("was_shipped=false"));
        assert!(url.contains("offset=200"));
    }

    #[test]
    fn partition_receipts_splits_canceled_from_active() {
        // Minimal valid receipts: Option / #[serde(default)] fields omitted.
        let receipts: Vec<Receipt> = serde_json::from_str(
            r#"[
                {"receipt_id": 111, "status": "Paid",
                 "name": "Active Buyer", "create_timestamp": 1700000000,
                 "transactions": []},
                {"receipt_id": 222, "status": "Canceled",
                 "name": "Gone Buyer", "create_timestamp": 1700000000,
                 "transactions": []}
            ]"#,
        )
        .unwrap();

        let (orders, canceled) = partition_receipts(receipts, 6807617);

        assert_eq!(orders.len(), 1);
        assert_eq!(orders[0].id, "IE-111");
        assert_eq!(orders[0].shop_id, 6807617);
        assert_eq!(canceled, vec!["IE-222".to_string()]);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: COMPILE ERROR — `cannot find function receipts_url` / `partition_receipts`.

- [ ] **Step 3: Implement both functions**

In `src-tauri/src/etsy.rs`, directly above `fetch_shop_orders` (line ~631), add:

```rust
/// Build one page's receipts URL. `min_last_modified` (epoch seconds) asks
/// Etsy for only receipts created/changed since then — new orders plus status
/// flips (shipped, canceled) — which is what makes incremental sync possible.
fn receipts_url(
    shop_id: u64,
    limit: u32,
    offset: u32,
    unshipped_only: bool,
    min_last_modified: Option<i64>,
) -> String {
    // was_paid=true excludes abandoned carts.
    // includes=Listings expands each transaction's listing data (image URLs).
    let mut url = format!(
        "{}/application/shops/{}/receipts?limit={}&offset={}&was_paid=true&includes=Listings",
        ETSY_API_BASE, shop_id, limit, offset
    );
    if unshipped_only {
        // The fulfillment queue only needs unshipped orders — a tiny slice of
        // the full paid history.
        url.push_str("&was_shipped=false");
    }
    if let Some(ts) = min_last_modified {
        url.push_str(&format!("&min_last_modified={}", ts));
    }
    url
}

/// Split receipts into normalized active orders and the cache IDs of canceled
/// receipts, so callers can evict the latter (see CacheDb::delete_orders).
/// The ID format must match normalize(): "IE-{receipt_id}".
fn partition_receipts(receipts: Vec<Receipt>, shop_id: u64) -> (Vec<Order>, Vec<String>) {
    let mut orders = Vec::new();
    let mut canceled = Vec::new();
    for r in receipts {
        if r.status == "Canceled" {
            canceled.push(format!("IE-{}", r.receipt_id));
        } else {
            orders.push(normalize(r, shop_id));
        }
    }
    (orders, canceled)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — 7 tests total (4 cache + 3 etsy), 0 failures. (A `dead_code` warning on the two new functions is expected until Task 3 wires them in.)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/etsy.rs
git commit -m "feat(etsy): receipts_url builder and canceled/active receipt partition"
```

---

### Task 3: Wire incremental sync into the fetch and load paths

**Files:**
- Modify: `src-tauri/src/etsy.rs` — `fetch_shop_orders` (~line 631), `fetch_one_shop_open_orders` (~line 914), `load_one_shop_orders` (~line 962)

No new unit tests in this task — the new logic is I/O orchestration over the pure pieces tested in Tasks 1–2; it is verified live in Task 4.

- [ ] **Step 1: Change `fetch_shop_orders` signature and body**

Replace the signature (line ~631):

```rust
async fn fetch_shop_orders(
    client: &Client,
    api_key: &str,
    shared_secret: &str,
    access_token: &str,
    shop_id: u64,
    unshipped_only: bool,
) -> Result<Vec<Order>, String> {
```

with:

```rust
/// Fetch receipts from one shop. With `min_last_modified: Some(ts)` this is a
/// delta fetch — only receipts created/changed since `ts` come back, typically
/// one page instead of the ~70 a full history crawl takes.
/// Returns (active normalized orders, cache IDs of canceled receipts).
async fn fetch_shop_orders(
    client: &Client,
    api_key: &str,
    shared_secret: &str,
    access_token: &str,
    shop_id: u64,
    unshipped_only: bool,
    min_last_modified: Option<i64>,
) -> Result<(Vec<Order>, Vec<String>), String> {
```

Inside the body, delete the old `shipped_filter` line and the old URL `format!` (lines ~645 and ~652–655), replacing the URL construction in the loop with:

```rust
        let url = receipts_url(shop_id, PAGE_SIZE, offset, unshipped_only, min_last_modified);
```

Replace the old filter+normalize block (lines ~683–686):

```rust
    let mut orders: Vec<Order> = all_receipts.into_iter()
        .filter(|r| r.status != "Canceled")
        .map(|r| normalize(r, shop_id))
        .collect();
```

with:

```rust
    let (mut orders, canceled_ids) = partition_receipts(all_receipts, shop_id);
```

And change the final `Ok(orders)` (line ~714) to:

```rust
    Ok((orders, canceled_ids))
```

(The image-stitching block between those two points operates on `orders` and is unchanged.)

- [ ] **Step 2: Update `fetch_one_shop_open_orders` (~line 914)**

Replace the fetch-and-upsert tail of the function (from `let orders = match fetch_shop_orders(` through the final `orders`) with:

```rust
    let (orders, canceled_ids) = match fetch_shop_orders(
        &state.client, &creds.api_key, &creds.shared_secret, &token, shop_id, true, None,
    ).await {
        Ok(r) => r,
        Err(e) => { eprintln!("open orders: fetch failed shop {}: {}", shop_id, e); return vec![]; }
    };
    let rows: Vec<(String, u64, String)> = orders
        .iter()
        .filter_map(|o| serde_json::to_string(o).ok().map(|j| (o.id.clone(), o.shop_id, j)))
        .collect();
    let _ = cache.upsert_orders(&rows);
    let _ = cache.delete_orders(&canceled_ids);
    orders
```

- [ ] **Step 3: Rewrite `load_one_shop_orders` (~line 962)**

Replace the entire function with:

```rust
/// Load one shop's orders: serve fresh cache, else sync from Etsy and serve
/// the updated cache. After the first full crawl, every sync is a DELTA —
/// only receipts modified since the last successful sync (new orders plus
/// status flips) — so refreshes are ~1 request instead of ~70. On any
/// credential/token/fetch failure (including a timeout) it returns that
/// shop's last cached orders instead of erroring, and leaves shop_sync
/// untouched — so one failing or slow shop can't block or sink the others.
async fn load_one_shop_orders(
    shop_id: u64,
    force: bool,
    state: &EtsyState,
    cache: &CacheDb,
) -> Vec<Order> {
    const ORDER_CACHE_MAX_AGE: i64 = 30 * 60; // 30 minutes — conservative; key is shared with another app
    // Subtracted from the last sync mark when building the delta window, so
    // clock skew against Etsy and receipts modified mid-fetch are never
    // missed. Upserts are idempotent, so re-fetching the overlap is harmless.
    const SYNC_OVERLAP_SECS: i64 = 5 * 60;

    let cached = || -> Vec<Order> {
        cache
            .get_orders_for_shops(&[shop_id])
            .unwrap_or_default()
            .iter()
            .filter_map(|j| serde_json::from_str(j).ok())
            .collect()
    };

    let last_synced_at = cache.shop_synced_at(shop_id);

    // Serve from cache if fresh enough.
    if !force {
        if let Some(synced_at) = last_synced_at {
            if now_unix() - synced_at < ORDER_CACHE_MAX_AGE {
                return cached();
            }
        }
    }

    // No shop_sync row (first run, or after clear_shop_orders) → full crawl.
    // Otherwise → delta from the last successful sync.
    let min_last_modified = last_synced_at.map(|ts| ts - SYNC_OVERLAP_SECS);

    let creds = match resolve_shop_creds(state, shop_id).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Skipping shop {}: {}", shop_id, e);
            return cached();
        }
    };
    let token = match get_valid_token(&state.client, &creds.api_key, shop_id, state).await {
        Ok(t) => t,
        Err(e) => {
            eprintln!("Shop {} token error ({}); serving cached orders", shop_id, e);
            return cached();
        }
    };

    // Stamp the sync from BEFORE the fetch: receipts modified mid-fetch fall
    // after this mark and get picked up by the next delta.
    let sync_started_at = now_unix();

    let (orders, canceled_ids) = match fetch_shop_orders(
        &state.client, &creds.api_key, &creds.shared_secret, &token, shop_id, false, min_last_modified,
    ).await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Shop {} order fetch failed ({}); serving cached orders", shop_id, e);
            return cached();
        }
    };

    let rows: Vec<(String, u64, String)> = orders
        .iter()
        .filter_map(|o| serde_json::to_string(o).ok().map(|j| (o.id.clone(), o.shop_id, j)))
        .collect();
    let _ = cache.upsert_orders(&rows);
    let _ = cache.delete_orders(&canceled_ids);
    let _ = cache.mark_shop_synced(shop_id, sync_started_at);

    // A delta is only a slice of the history; callers expect the complete set.
    cached()
}
```

Note: this removes Task 1's interim `mark_shop_synced(shop_id, now_unix())` line — it is superseded by `sync_started_at`.

- [ ] **Step 4: Compile and run all tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — 7 tests, 0 failures, and no `dead_code` warnings for `receipts_url`/`partition_receipts` (now in use).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/etsy.rs
git commit -m "feat(etsy): incremental order sync via min_last_modified; evict canceled orders"
```

---

### Task 4: Live verification against real Etsy data

**Files:** none (verification only)

The installed app (`C:\Users\glenn\AppData\Local\etsy-dashboard\etsy-dashboard.exe`) and the dev build share the same app-data dir (`%APPDATA%\com.castshadow.etsy-dashboard\cache.db`). Close the installed app before testing so two processes don't share the WAL.

- [ ] **Step 1: Record pre-test cache state**

```bash
python -c "
import sqlite3, datetime
con = sqlite3.connect('file:C:/Users/glenn/AppData/Roaming/com.castshadow.etsy-dashboard/cache.db?mode=ro', uri=True)
cur = con.cursor()
cur.execute('SELECT shop_id, COUNT(*), MAX(fetched_at) FROM orders GROUP BY shop_id')
for s, n, mx in cur.fetchall(): print('shop', s, 'rows', n, 'newest', datetime.datetime.fromtimestamp(mx))
cur.execute('SELECT shop_id, synced_at FROM shop_sync')
print('sync:', [(s, str(datetime.datetime.fromtimestamp(t))) for s, t in cur.fetchall()])
"
```

Note the row counts and `synced_at` values.

- [ ] **Step 2: Close the installed app, launch the dev build**

```powershell
Stop-Process -Name etsy-dashboard -Force -ErrorAction SilentlyContinue
```

Then from the project root: `npm run tauri dev` (background; first launch takes a while if the debug profile is cold). The app auto-runs `loadCachedOrders → loadOpenOrders → loadOrders(true)` at launch.

- [ ] **Step 3: Verify the delta behavior**

Wait ~30 s after the UI paints, then re-run the Step 1 query. Expected:
- `shop_sync.synced_at` advanced to launch time for BOTH shops (7438218 and 6807617) within seconds of launch — not minutes.
- Row counts unchanged or +small (only genuinely new orders).
- The refresh completed far too fast to have re-paginated ~8,000 receipts (a full gkdesignhaus crawl alone takes minutes).

If a shop's `synced_at` did NOT advance, that shop's fetch failed — check the dev console (`npm run tauri dev` shows `eprintln!` output, unlike the release build) for the per-shop error before assuming the code is wrong. A dead OAuth token fails soft and is a known, separate condition.

- [ ] **Step 4: Verify full-crawl fallback still works**

In the app's devtools console (F12):

```js
await window.__TAURI__.core.invoke("clear_cache")
```

(`clear_cache` is registered in `src-tauri/src/cache.rs:1187`; its `clear_orders` deletes both the `orders` and `shop_sync` tables, which is exactly what arms the full-crawl branch.) Then trigger Refresh in the UI. Expected: full re-crawl repopulates the cache (row counts return to ~8,200 total; takes minutes — this is the one-time cost after a cache wipe, no longer the per-refresh cost).

- [ ] **Step 5: Stop the dev build, build and install the release**

```bash
npm run tauri build
```

Expected: installer lands under `src-tauri/target/release/bundle/` (version already bumped by the Task 1–3 commits). Install it, launch, and confirm the Fulfillment tab paints and refreshes normally.

- [ ] **Step 6: Commit any verification fixes; push**

If verification surfaced fixes, commit them with specific messages. Then:

```bash
git push
```

---

## Out of scope (deliberately)

- Surfacing per-shop staleness / reconnect UI — separately queued task.
- Hard-deleted (not canceled) receipts — only recoverable via `clear_shop_orders` full resync; accepted in spec.
- The `get_open_orders` 30-min-timer architecture in `App.jsx` — unchanged.
