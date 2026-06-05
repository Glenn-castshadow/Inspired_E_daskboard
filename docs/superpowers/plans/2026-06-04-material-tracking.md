# Material Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add QR pool-label scan-in/scan-out tracking for all shop stock plus an offcut recommendation badge in the Fulfillment tab.

**Architecture:** Pre-printed QR labels (pool UUIDs) are generated locally; scanning one opens a mobile web page on the Node.js inventory server that handles check-in (assign label → create inventory item) and check-out (quantity → 0, label → retired). The Tauri desktop app gains label-pool management UI in the Inventory tab and a passive offcut-availability badge in the Fulfillment tab.

**Tech Stack:** Rust/Tauri (cache.rs + inventory.rs), Node.js/Express inventory-server (better-sqlite3 + qrcode npm), React/JSX frontend.

---

## File Map

| File | Change |
|---|---|
| `src-tauri/Cargo.toml` | Add `uuid = { version = "1", features = ["v4"] }` |
| `src-tauri/src/cache.rs` | Schema v12; `label_id` on `InventoryItem`; 4 new DB methods; 2 new types |
| `src-tauri/src/inventory.rs` | 4 new Tauri commands |
| `src-tauri/src/main.rs` | Register 4 new commands |
| `inventory-server/package.json` | Add `qrcode` dep |
| `inventory-server/database.js` | 3 schema additions |
| `inventory-server/routes/scan.js` | **New** — mobile scan landing page + check-in/out |
| `inventory-server/routes/labels.js` | **New** — generate, counts, QR PNG, print page |
| `inventory-server/server.js` | Mount 2 new route files |
| `src/App.jsx` | Load `categoryBlankSizes` at startup, pass to `FulfillmentView` |
| `src/inventory-tab.jsx` | Add `LabelPool` section + mock data |
| `src/fulfillment-view.jsx` | Add `OffcutBadge` component + filter logic |

---

## Task 1: Add `uuid` crate to Cargo.toml

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add uuid dependency**

  Open `src-tauri/Cargo.toml`. After the `rand = "0.8"` line, add:
  ```toml
  uuid = { version = "1", features = ["v4"] }
  ```

- [ ] **Step 2: Verify it compiles**

  ```bash
  cd src-tauri && cargo check 2>&1 | tail -5
  ```
  Expected: `Finished` with no errors (uuid will be downloaded and compiled).

- [ ] **Step 3: Commit**

  ```bash
  git add src-tauri/Cargo.toml
  git commit -m "chore: add uuid crate for label pool generation"
  ```

---

## Task 2: Schema v12 — label_pool, category_blank_sizes, label_id column

**Files:**
- Modify: `src-tauri/src/cache.rs`

- [ ] **Step 1: Bump SCHEMA_VERSION to 12**

  In `cache.rs` line 26, change:
  ```rust
  const SCHEMA_VERSION: i32 = 11;
  ```
  to:
  ```rust
  const SCHEMA_VERSION: i32 = 12;
  ```

- [ ] **Step 2: Add v12 migration block**

  Append after the v11 migration block (after the `conn.execute_batch("PRAGMA user_version = 11;")` / closing brace), before the `let final_version` check:

  ```rust
  // ── v12: material tracking — label pool + category blank sizes + label_id ─
  if version < 12 {
      conn.execute_batch(
          "CREATE TABLE IF NOT EXISTS label_pool (
              id          TEXT    PRIMARY KEY,
              status      TEXT    NOT NULL DEFAULT 'unassigned',
              created_at  INTEGER NOT NULL,
              assigned_at INTEGER
          );
          CREATE TABLE IF NOT EXISTS category_blank_sizes (
              category   TEXT    PRIMARY KEY,
              min_width  REAL    NOT NULL,
              min_height REAL    NOT NULL
          );
          PRAGMA user_version = 12;",
      )
      .map_err(|e| e.to_string())?;
      match conn.execute(
          "ALTER TABLE inventory ADD COLUMN label_id TEXT REFERENCES label_pool(id)",
          [],
      ) {
          Ok(_) => {}
          Err(e) if e.to_string().contains("duplicate column") => {}
          Err(e) => return Err(e.to_string()),
      }
  }
  ```

- [ ] **Step 3: Add `label_id` to `InventoryItem` struct**

  In `src-tauri/src/inventory.rs`, the `InventoryItem` struct currently ends with `updated_at`. Add one field after `updated_at`:

  ```rust
  /// Pool label UUID assigned to this physical piece. None for items
  /// entered manually (pre-tracking) or not yet labelled.
  #[serde(default)]
  pub label_id:   Option<String>,
  ```

- [ ] **Step 4: Update `get_inventory` SELECT in cache.rs**

  Find the `get_inventory` method. Replace the `prepare` call's SQL string:

  Old:
  ```rust
  "SELECT id, item_type, material, width, height, thickness, quantity, sku, notes, unit_cost, created_at, updated_at
   FROM inventory ORDER BY item_type, material, width DESC, height DESC"
  ```

  New:
  ```rust
  "SELECT id, item_type, material, width, height, thickness, quantity, sku, notes, unit_cost, created_at, updated_at, label_id
   FROM inventory ORDER BY item_type, material, width DESC, height DESC"
  ```

- [ ] **Step 5: Update `get_inventory` row mapping in cache.rs**

  In the same method, the `Ok(crate::inventory::InventoryItem { ... })` block currently ends with `updated_at: row.get(11)?`. Add:
  ```rust
  label_id:   row.get(12)?,
  ```

- [ ] **Step 6: Update `add_inventory_item` return value in cache.rs**

  `add_inventory_item` constructs an `InventoryItem` to return. It currently ends with `updated_at: now,`. Add:
  ```rust
  label_id:   None,
  ```

- [ ] **Step 7: Verify it compiles**

  ```bash
  cd src-tauri && cargo check 2>&1 | tail -10
  ```
  Expected: `Finished` — no errors.

- [ ] **Step 8: Commit**

  ```bash
  git add src-tauri/src/cache.rs src-tauri/src/inventory.rs
  git commit -m "feat: schema v12 — label_pool, category_blank_sizes, label_id on inventory"
  ```

---

## Task 3: cache.rs — label pool + category size types and DB methods

**Files:**
- Modify: `src-tauri/src/cache.rs`

- [ ] **Step 1: Add two new public types near the bottom of cache.rs**

  After the `AdSpend` struct definition, add:

  ```rust
  /// Counts of label pool entries by status. Returned by get_label_pool_counts.
  #[derive(Debug, Serialize, Deserialize, Clone)]
  pub struct LabelPoolCounts {
      pub unassigned: i64,
      pub active:     i64,
      pub retired:    i64,
  }

  /// A category's minimum blank size for the offcut recommendation engine.
  #[derive(Debug, Serialize, Deserialize, Clone)]
  pub struct CategoryBlankSize {
      pub category:   String,
      pub min_width:  f64,
      pub min_height: f64,
  }
  ```

- [ ] **Step 2: Add `generate_label_batch` method on `CacheDb`**

  Append inside the `impl CacheDb` block, after `delete_catalog_file_meta`:

  ```rust
  // ── Label pool ────────────────────────────────────────────────────────────

  /// Generate `n` new unassigned label UUIDs in the local pool.
  /// Returns the list of new IDs. When the inventory server is configured,
  /// use the server-side route instead (see inventory.rs generate_label_batch).
  pub fn generate_label_batch(&self, n: usize) -> Result<Vec<String>, String> {
      let conn = self.conn.lock().unwrap();
      let now = now_unix();
      let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
      let mut ids = Vec::with_capacity(n);
      for _ in 0..n {
          let id = uuid::Uuid::new_v4().to_string();
          tx.execute(
              "INSERT INTO label_pool (id, status, created_at) VALUES (?1, 'unassigned', ?2)",
              params![id, now],
          )
          .map_err(|e| e.to_string())?;
          ids.push(id);
      }
      tx.commit().map_err(|e| e.to_string())?;
      Ok(ids)
  }

  pub fn get_label_pool_counts(&self) -> Result<LabelPoolCounts, String> {
      let conn = self.conn.lock().unwrap();
      let count = |status: &str| -> Result<i64, String> {
          conn.query_row(
              "SELECT COUNT(*) FROM label_pool WHERE status = ?1",
              params![status],
              |r| r.get(0),
          )
          .map_err(|e| e.to_string())
      };
      Ok(LabelPoolCounts {
          unassigned: count("unassigned")?,
          active:     count("active")?,
          retired:    count("retired")?,
      })
  }

  // ── Category blank sizes ───────────────────────────────────────────────────

  pub fn get_category_blank_sizes(&self) -> Result<Vec<CategoryBlankSize>, String> {
      let conn = self.conn.lock().unwrap();
      let mut stmt = conn.prepare(
          "SELECT category, min_width, min_height FROM category_blank_sizes ORDER BY category",
      )
      .map_err(|e| e.to_string())?;
      let rows = stmt
          .query_map([], |row| {
              Ok(CategoryBlankSize {
                  category:   row.get(0)?,
                  min_width:  row.get(1)?,
                  min_height: row.get(2)?,
              })
          })
          .map_err(|e| e.to_string())?;
      rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
  }

  pub fn upsert_category_blank_size(
      &self,
      category: &str,
      min_width: f64,
      min_height: f64,
  ) -> Result<(), String> {
      let conn = self.conn.lock().unwrap();
      conn.execute(
          "INSERT INTO category_blank_sizes (category, min_width, min_height)
           VALUES (?1, ?2, ?3)
           ON CONFLICT(category) DO UPDATE SET
             min_width  = excluded.min_width,
             min_height = excluded.min_height",
          params![category.to_uppercase(), min_width, min_height],
      )
      .map_err(|e| e.to_string())?;
      Ok(())
  }
  ```

- [ ] **Step 3: Verify it compiles**

  ```bash
  cd src-tauri && cargo check 2>&1 | tail -10
  ```
  Expected: `Finished`.

- [ ] **Step 4: Commit**

  ```bash
  git add src-tauri/src/cache.rs
  git commit -m "feat: label pool + category blank size DB methods"
  ```

---

## Task 4: Tauri commands — label pool + category sizes

**Files:**
- Modify: `src-tauri/src/inventory.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add four Tauri commands to `inventory.rs`**

  Append after the `delete_inventory_item` command:

  ```rust
  // ── Label pool commands ───────────────────────────────────────────────────

  /// Generate a batch of unassigned pool labels.
  /// Routes through the inventory server when configured; falls back to local cache.db.
  /// `n` is clamped to 1–200.
  #[tauri::command]
  pub async fn generate_label_batch(
      n: i64,
      cache: State<'_, CacheDb>,
      settings: State<'_, AppSettings>,
      http: State<'_, reqwest::Client>,
  ) -> Result<Vec<String>, String> {
      let count = (n.max(1).min(200)) as usize;
      if let Some(base) = settings.server_url() {
          #[derive(serde::Deserialize)] struct Resp { ids: Vec<String> }
          let resp: Resp = http_post(
              &http,
              &format!("{}/labels/generate", base),
              &settings.api_key(),
              &serde_json::json!({ "n": count }),
          )
          .await?;
          Ok(resp.ids)
      } else {
          cache.generate_label_batch(count)
      }
  }

  /// Return unassigned / active / retired counts for the label pool.
  #[tauri::command]
  pub async fn get_label_pool_counts(
      cache: State<'_, CacheDb>,
      settings: State<'_, AppSettings>,
      http: State<'_, reqwest::Client>,
  ) -> Result<crate::cache::LabelPoolCounts, String> {
      if let Some(base) = settings.server_url() {
          http_get(&http, &format!("{}/labels/counts", base), &settings.api_key()).await
      } else {
          cache.get_label_pool_counts()
      }
  }

  /// Return all category → min blank size entries.
  /// Always reads from local cache.db (category sizes are per-machine config).
  #[tauri::command]
  pub async fn get_category_blank_sizes(
      cache: State<'_, CacheDb>,
  ) -> Result<Vec<crate::cache::CategoryBlankSize>, String> {
      cache.get_category_blank_sizes()
  }

  /// Seed or update one category's minimum blank dimensions (inches).
  #[tauri::command]
  pub async fn upsert_category_blank_size(
      category: String,
      min_width: f64,
      min_height: f64,
      cache: State<'_, CacheDb>,
  ) -> Result<(), String> {
      cache.upsert_category_blank_size(&category, min_width, min_height)
  }
  ```

- [ ] **Step 2: Register all four commands in `main.rs`**

  In `main.rs`, inside `tauri::generate_handler![...]`, after `inventory::delete_inventory_item,` add:
  ```rust
  inventory::generate_label_batch,
  inventory::get_label_pool_counts,
  inventory::get_category_blank_sizes,
  inventory::upsert_category_blank_size,
  ```

- [ ] **Step 3: Verify it compiles**

  ```bash
  cd src-tauri && cargo check 2>&1 | tail -10
  ```
  Expected: `Finished`.

- [ ] **Step 4: Commit**

  ```bash
  git add src-tauri/src/inventory.rs src-tauri/src/main.rs
  git commit -m "feat: Tauri commands for label pool and category blank sizes"
  ```

---

## Task 5: inventory-server — qrcode dep + schema additions

**Files:**
- Modify: `inventory-server/package.json` (via npm install)
- Modify: `inventory-server/database.js`

- [ ] **Step 1: Install qrcode npm package**

  ```bash
  cd inventory-server && npm install qrcode
  ```
  Expected: `qrcode` appears in `node_modules/` and `package.json` dependencies.

- [ ] **Step 2: Add schema additions to `database.js`**

  In `inventory-server/database.js`, after the existing `db.exec(`` ... ``)` block (which creates inventory, products, lightburn_files, lightburn_mappings), add:

  ```javascript
  // v2: material tracking — label pool + category blank sizes + label_id on inventory
  db.exec(`
    CREATE TABLE IF NOT EXISTS label_pool (
      id          TEXT    PRIMARY KEY,
      status      TEXT    NOT NULL DEFAULT 'unassigned',
      created_at  INTEGER NOT NULL,
      assigned_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS category_blank_sizes (
      category   TEXT    PRIMARY KEY,
      min_width  REAL    NOT NULL,
      min_height REAL    NOT NULL
    );
  `);

  // Add label_id column if this is an existing DB that predates v2
  try {
    db.exec('ALTER TABLE inventory ADD COLUMN label_id TEXT REFERENCES label_pool(id)');
  } catch (e) {
    if (!e.message.includes('duplicate column')) throw e;
  }
  ```

- [ ] **Step 3: Verify server starts cleanly**

  ```bash
  cd inventory-server && node -e "require('./database'); console.log('schema ok')"
  ```
  Expected: `schema ok` — no errors.

- [ ] **Step 4: Commit**

  ```bash
  git add inventory-server/package.json inventory-server/package-lock.json inventory-server/database.js
  git commit -m "feat: inventory-server schema v2 — label_pool, category_blank_sizes, label_id"
  ```

---

## Task 6: inventory-server/routes/scan.js — mobile scan pages

**Files:**
- Create: `inventory-server/routes/scan.js`
- Modify: `inventory-server/server.js`

- [ ] **Step 1: Create `inventory-server/routes/scan.js`**

  ```javascript
  // routes/scan.js
  //
  // Mobile scan landing pages for QR-labelled inventory pieces.
  // No API-key auth — iPhone users scan these with Safari, no credentials.
  // Routes: GET /m/:id, POST /m/:id/in, POST /m/:id/out

  const express = require('express');
  const router  = express.Router();
  const db      = require('../database');

  router.use(express.urlencoded({ extended: false }));

  const now = () => Math.floor(Date.now() / 1000);

  const MAT_LABELS = {
    plywood:         'Plywood',
    raw_mdf:         'Raw MDF',
    copper_mdf:      'Copper MDF',
    gold_foil_mdf:   'Gold Foil',
    silver_foil_mdf: 'Silver Foil',
    black_foil_mdf:  'Black Foil',
    white_foil_mdf:  'White Foil',
    custom:          'Custom',
  };

  const MATERIALS = [
    { id: 'plywood',         label: 'Plywood'        },
    { id: 'raw_mdf',         label: 'Raw MDF'         },
    { id: 'copper_mdf',      label: 'Copper MDF'      },
    { id: 'gold_foil_mdf',   label: 'Gold Foil'       },
    { id: 'silver_foil_mdf', label: 'Silver Foil'     },
    { id: 'black_foil_mdf',  label: 'Black Foil'      },
    { id: 'white_foil_mdf',  label: 'White Foil'      },
    { id: 'custom',          label: 'Other / Custom'  },
  ];

  const ITEM_TYPES = [
    { id: 'sheet',    label: 'Sheet stock'    },
    { id: 'blank',    label: 'Prepared blank' },
    { id: 'offcut',   label: 'Offcut'         },
    { id: 'finished', label: 'Finished piece' },
  ];

  function page(title, body) {
    return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
    <title>${title}</title>
    <style>
      *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
      body{font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;
           background:#0f1117;color:#e8e8f0;min-height:100vh;padding:24px 20px 48px}
      h1{font-size:22px;font-weight:700;margin-bottom:8px;color:#fff}
      p{font-size:15px;color:#8899bb;line-height:1.5;margin-bottom:18px}
      .card{background:#1a1d2e;border-radius:14px;padding:18px;margin-bottom:18px}
      label{display:block;font-size:11px;font-weight:600;color:#5577aa;
            text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px}
      select,input[type=number],input[type=text]{
        width:100%;padding:14px;font-size:16px;
        background:#0f1117;border:1px solid #2a3050;
        border-radius:10px;color:#e8e8f0;-webkit-appearance:none;appearance:none;
        margin-bottom:18px}
      select:focus,input:focus{outline:none;border-color:#5599ff}
      .btn{display:block;width:100%;padding:18px;font-size:17px;font-weight:700;
           border:none;border-radius:12px;cursor:pointer;margin-top:8px;
           font-family:-apple-system,BlinkMacSystemFont,sans-serif}
      .btn-primary{background:#5599ff;color:#fff}
      .btn-danger{background:#cc3333;color:#fff}
      .meta-row{display:flex;justify-content:space-between;align-items:center;
                padding:10px 0;border-bottom:1px solid #252840;font-size:15px}
      .meta-row:last-child{border-bottom:none}
      .ml{font-size:11px;font-weight:600;text-transform:uppercase;
          letter-spacing:.06em;color:#5577aa}
      .mv{font-weight:600;color:#e8e8f0}
      .badge{display:inline-block;padding:4px 10px;border-radius:6px;
             font-size:11px;font-weight:700;text-transform:uppercase;
             letter-spacing:.07em;margin-bottom:16px}
      .new{background:#0d2a1e;color:#33cc66}
      .in{background:#0e1e3a;color:#5599ff}
      .out{background:#2a0e0e;color:#cc3333}
      .id{font-family:monospace;font-size:11px;color:#334466;
          background:#0a0d16;padding:4px 8px;border-radius:5px;
          word-break:break-all;margin-bottom:20px;display:block}
    </style>
  </head>
  <body>${body}</body>
  </html>`;
  }

  // GET /m/:id
  router.get('/:id', (req, res) => {
    const { id } = req.params;
    const label = db.prepare('SELECT * FROM label_pool WHERE id = ?').get(id);

    if (!label) {
      return res.send(page('Label Not Recognized', `
        <h1>Label not recognized</h1>
        <span class="id">${id}</span>
        <p>This QR code isn't in the label pool.<br>
           Generate a fresh batch from the desktop app and try again.</p>
      `));
    }

    if (label.status === 'retired') {
      const item = db.prepare('SELECT * FROM inventory WHERE label_id = ?').get(id);
      return res.send(page('Label Retired', `
        <h1>Label retired</h1>
        <span class="badge out">Retired</span>
        <span class="id">${id}</span>
        ${item ? `
        <div class="card">
          <div class="meta-row"><span class="ml">Type</span><span class="mv">${item.item_type}</span></div>
          <div class="meta-row"><span class="ml">Material</span><span class="mv">${MAT_LABELS[item.material] ?? item.material}</span></div>
          <div class="meta-row"><span class="ml">Size</span><span class="mv">${item.width}" × ${item.height}"</span></div>
          <div class="meta-row"><span class="ml">Thickness</span><span class="mv">${item.thickness}"</span></div>
          ${item.notes ? `<div class="meta-row"><span class="ml">Notes</span><span class="mv">${item.notes}</span></div>` : ''}
        </div>` : ''}
        <p>This piece has been checked out. Stick a fresh label on new material.</p>
      `));
    }

    if (label.status === 'active') {
      const item = db.prepare('SELECT * FROM inventory WHERE label_id = ?').get(id);
      if (!item) return res.redirect(`/m/${id}`); // data inconsistency — fall through to unassigned
      return res.send(page('Check Out', `
        <h1>Check out</h1>
        <span class="badge in">In stock</span>
        <span class="id">${id}</span>
        <div class="card">
          <div class="meta-row"><span class="ml">Type</span><span class="mv">${item.item_type}</span></div>
          <div class="meta-row"><span class="ml">Material</span><span class="mv">${MAT_LABELS[item.material] ?? item.material}</span></div>
          <div class="meta-row"><span class="ml">Size</span><span class="mv">${item.width}" × ${item.height}"</span></div>
          <div class="meta-row"><span class="ml">Thickness</span><span class="mv">${item.thickness}"</span></div>
          ${item.notes ? `<div class="meta-row"><span class="ml">Notes</span><span class="mv">${item.notes}</span></div>` : ''}
        </div>
        <form method="POST" action="/m/${id}/out">
          <button type="submit" class="btn btn-danger">Check Out — Mark Used</button>
        </form>
      `));
    }

    // Unassigned — show check-in form
    const matOpts = MATERIALS.map(m => `<option value="${m.id}">${m.label}</option>`).join('');
    const typeOpts = ITEM_TYPES.map(t => `<option value="${t.id}">${t.label}</option>`).join('');
    res.send(page('Check In', `
      <h1>Check in</h1>
      <span class="badge new">New label</span>
      <span class="id">${id}</span>
      <form method="POST" action="/m/${id}/in">
        <div class="card">
          <label>Item Type</label>
          <select name="item_type" required>${typeOpts}</select>
          <label>Material</label>
          <select name="material" required>${matOpts}</select>
          <label>Width (inches)</label>
          <input type="number" name="width" placeholder="e.g. 12" step="0.01" min="0.01" required>
          <label>Height (inches)</label>
          <input type="number" name="height" placeholder="e.g. 18" step="0.01" min="0.01" required>
          <label>Thickness</label>
          <select name="thickness">
            <option value="1/8">1/8"</option>
            <option value="1/4">1/4"</option>
          </select>
          <label>Notes (optional)</label>
          <input type="text" name="notes" placeholder="e.g. From 12×18 cut">
        </div>
        <button type="submit" class="btn btn-primary">Check In</button>
      </form>
    `));
  });

  // POST /m/:id/in
  router.post('/:id/in', (req, res) => {
    const { id } = req.params;
    const label = db.prepare("SELECT * FROM label_pool WHERE id = ?").get(id);
    if (!label || label.status !== 'unassigned') {
      return res.status(400).send(page('Error', `
        <h1>Cannot check in</h1>
        <p>Label <code>${id}</code> is not available (status: ${label?.status ?? 'unknown'}).</p>
      `));
    }
    const { item_type, material, width, height, thickness, notes } = req.body;
    if (!material || !width || !height) {
      return res.status(400).send(page('Missing fields', `
        <h1>Missing fields</h1><p>Material, width, and height are required.</p>
      `));
    }
    const ts = now();
    db.prepare(
      `INSERT INTO inventory
         (item_type, material, width, height, thickness, quantity, sku, notes, unit_cost, label_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, '', ?, 0, ?, ?, ?)`
    ).run(
      item_type || 'blank',
      material,
      parseFloat(width),
      parseFloat(height),
      thickness || '1/8',
      notes || '',
      id, ts, ts
    );
    db.prepare("UPDATE label_pool SET status = 'active', assigned_at = ? WHERE id = ?").run(ts, id);
    const matLabel = MAT_LABELS[material] ?? material;
    res.send(page('Checked In', `
      <h1>Checked in ✓</h1>
      <span class="badge in">In stock</span>
      <span class="id">${id}</span>
      <div class="card">
        <div class="meta-row"><span class="ml">Type</span><span class="mv">${item_type || 'blank'}</span></div>
        <div class="meta-row"><span class="ml">Material</span><span class="mv">${matLabel}</span></div>
        <div class="meta-row"><span class="ml">Size</span><span class="mv">${width}" × ${height}"</span></div>
        <div class="meta-row"><span class="ml">Thickness</span><span class="mv">${thickness || '1/8'}"</span></div>
        ${notes ? `<div class="meta-row"><span class="ml">Notes</span><span class="mv">${notes}</span></div>` : ''}
      </div>
      <p>Piece is now tracked in inventory.</p>
    `));
  });

  // POST /m/:id/out
  router.post('/:id/out', (req, res) => {
    const { id } = req.params;
    const label = db.prepare("SELECT * FROM label_pool WHERE id = ?").get(id);
    if (!label || label.status !== 'active') {
      return res.status(400).send(page('Error', `
        <h1>Cannot check out</h1>
        <p>Label <code>${id}</code> is not active.</p>
      `));
    }
    db.prepare("UPDATE inventory SET quantity = 0, updated_at = ? WHERE label_id = ?").run(now(), id);
    db.prepare("UPDATE label_pool SET status = 'retired' WHERE id = ?").run(id);
    res.send(page('Checked Out', `
      <h1>Checked out ✓</h1>
      <span class="badge out">Retired</span>
      <span class="id">${id}</span>
      <p>Piece marked as used. The label is now retired.<br>
         Stick a fresh label on any new material.</p>
    `));
  });

  module.exports = router;
  ```

- [ ] **Step 2: Mount scan routes in `server.js`**

  In `inventory-server/server.js`, **before** the `app.use(requireApiKey)` line, add:
  ```javascript
  // Scan routes — no auth required (iPhone users, no API key)
  app.use('/m', require('./routes/scan'));
  ```

- [ ] **Step 3: Smoke-test the scan routes**

  Start the server: `cd inventory-server && node server.js`

  In a second terminal:
  ```bash
  # Unknown label
  curl -s http://localhost:3456/m/not-a-real-uuid | grep -o '<h1>[^<]*</h1>'
  ```
  Expected output: `<h1>Label not recognized</h1>`

  ```bash
  # Unassigned label (after generating one via SQLite)
  cd inventory-server
  node -e "
    const db = require('./database');
    db.prepare(\"INSERT INTO label_pool (id, status, created_at) VALUES ('test-label-001', 'unassigned', ?)\").run(Math.floor(Date.now()/1000));
    console.log('inserted');
  "
  curl -s http://localhost:3456/m/test-label-001 | grep -o '<h1>[^<]*</h1>'
  ```
  Expected: `<h1>Check in</h1>`

- [ ] **Step 4: Commit**

  ```bash
  git add inventory-server/routes/scan.js inventory-server/server.js
  git commit -m "feat: mobile scan check-in/out pages (GET+POST /m/:id)"
  ```

---

## Task 7: inventory-server/routes/labels.js — generate, counts, QR, print

**Files:**
- Create: `inventory-server/routes/labels.js`
- Modify: `inventory-server/server.js`

- [ ] **Step 1: Create `inventory-server/routes/labels.js`**

  ```javascript
  // routes/labels.js
  //
  // Label pool management routes.
  // /labels/generate and /labels/counts require the API key (called from Tauri app).
  // /labels/print and /labels/qr/:id are public (opened in browser, no key available).

  const express  = require('express');
  const router   = express.Router();
  const db       = require('../database');
  const QRCode   = require('qrcode');
  const crypto   = require('crypto');
  const { apiKey } = require('../config');
  const requireApiKey = require('../middleware/auth');

  const now = () => Math.floor(Date.now() / 1000);

  // POST /labels/generate — create N unassigned labels (requires API key)
  router.post('/generate', requireApiKey, (req, res) => {
    const n = Math.min(Math.max(parseInt(req.body?.n ?? 50, 10), 1), 200);
    const insert = db.prepare("INSERT INTO label_pool (id, status, created_at) VALUES (?, 'unassigned', ?)");
    const createBatch = db.transaction((count) => {
      const ids = [];
      const ts = now();
      for (let i = 0; i < count; i++) {
        const id = crypto.randomUUID();
        insert.run(id, ts);
        ids.push(id);
      }
      return ids;
    });
    const ids = createBatch(n);
    res.json({ ids });
  });

  // GET /labels/counts — pool counts by status (requires API key)
  router.get('/counts', requireApiKey, (req, res) => {
    const unassigned = db.prepare("SELECT COUNT(*) AS c FROM label_pool WHERE status = 'unassigned'").get().c;
    const active     = db.prepare("SELECT COUNT(*) AS c FROM label_pool WHERE status = 'active'").get().c;
    const retired    = db.prepare("SELECT COUNT(*) AS c FROM label_pool WHERE status = 'retired'").get().c;
    res.json({ unassigned, active, retired });
  });

  // GET /labels/qr/:id — PNG QR code (no auth — loaded by <img> tags in print page)
  router.get('/qr/:id', async (req, res) => {
    // Encode the full scan URL into the QR so the iPhone just scans → Safari opens it
    const host  = req.headers['x-forwarded-host'] ?? req.headers.host;
    const proto = req.headers['x-forwarded-proto'] ?? 'http';
    const url   = `${proto}://${host}/m/${req.params.id}`;
    try {
      const png = await QRCode.toBuffer(url, {
        type: 'png', width: 150, margin: 1,
        color: { dark: '#000000', light: '#ffffff' },
      });
      res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=86400').send(png);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /labels/print — 30-up print sheet (no auth — opened in system browser)
  router.get('/print', (req, res) => {
    const labels = db.prepare(
      "SELECT id FROM label_pool WHERE status = 'unassigned' ORDER BY created_at"
    ).all();
    const cells = labels.map(l => `
      <div class="cell">
        <img src="/labels/qr/${l.id}" width="80" height="80" alt="">
        <div class="id">${l.id.slice(0, 8).toUpperCase()}</div>
      </div>`).join('');
    res.set('Content-Type', 'text/html').send(`<!DOCTYPE html>
  <html><head><meta charset="utf-8"><title>Label Sheet — ${labels.length} labels</title>
  <style>
    @page { size: letter portrait; margin: 0.5in 0.1875in; }
    body  { margin: 0; padding: 0; font-family: sans-serif; }
    .grid { display: grid; grid-template-columns: repeat(3, 2.625in);
            column-gap: 0.125in; row-gap: 0; }
    .cell { display: flex; flex-direction: column; align-items: center;
            justify-content: center; height: 1in; padding: 2px;
            border: 0.5px dashed #ccc; }
    .cell img { display: block; }
    .id   { font-family: monospace; font-size: 6.5px; color: #444;
            margin-top: 2px; text-align: center; letter-spacing: .04em; }
    @media print { .cell { border-color: transparent; } }
  </style></head>
  <body>
    <div class="grid">${cells}</div>
    <p style="margin-top:12px;font-size:11px;color:#888;">
      ${labels.length} unassigned labels · Print on Avery 5160 (3×10 per sheet)
    </p>
  </body></html>`);
  });

  module.exports = router;
  ```

- [ ] **Step 2: Mount label routes in `server.js`**

  In `inventory-server/server.js`, **before** the `app.use(requireApiKey)` line (alongside the scan route), add:
  ```javascript
  // Label routes — some endpoints public (print/qr), some protected (generate/counts).
  // Auth is handled per-route inside labels.js.
  app.use('/labels', require('./routes/labels'));
  ```

  The server.js public-route section should now look like:
  ```javascript
  app.get('/health', (_req, res) => { ... });

  // Scan routes — no auth required (iPhone users)
  app.use('/m', require('./routes/scan'));

  // Label routes — per-route auth (print/qr public, generate/counts protected)
  app.use('/labels', require('./routes/labels'));

  // All routes below require a valid API key
  app.use(requireApiKey);

  app.use('/inventory',  require('./routes/inventory'));
  app.use('/products',   require('./routes/products'));
  app.use('/lightburn',  require('./routes/lightburn'));
  ```

- [ ] **Step 3: Smoke-test label routes**

  With server running and `API_KEY=test` set (or blank key warning accepted):

  ```bash
  # Generate 3 labels (use your real API key or omit header if key is blank)
  curl -s -X POST http://localhost:3456/labels/generate \
       -H "Authorization: Bearer test" \
       -H "Content-Type: application/json" \
       -d '{"n":3}' | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); console.log(JSON.parse(d).ids.length, 'ids')"
  ```
  Expected: `3 ids`

  ```bash
  # Counts
  curl -s http://localhost:3456/labels/counts -H "Authorization: Bearer test"
  ```
  Expected: JSON like `{"unassigned":3,"active":0,"retired":0}`

  ```bash
  # QR PNG (save and open to verify)
  FIRST_ID=$(curl -s http://localhost:3456/labels/counts -H "Authorization: Bearer test" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const db=require('./database');console.log(db.prepare(\"SELECT id FROM label_pool WHERE status='unassigned' LIMIT 1\").get()?.id??'')})")
  # Or just grab any unassigned id and test:
  curl -s "http://localhost:3456/labels/qr/test-label-001" -o /tmp/test-qr.png && file /tmp/test-qr.png
  ```
  Expected: `/tmp/test-qr.png: PNG image data`

  ```bash
  # Print page
  curl -s http://localhost:3456/labels/print | grep -o 'unassigned labels'
  ```
  Expected: `unassigned labels`

- [ ] **Step 4: Commit**

  ```bash
  git add inventory-server/routes/labels.js inventory-server/server.js
  git commit -m "feat: label pool routes — generate, counts, QR PNG, print sheet"
  ```

---

## Task 8: App.jsx — load categoryBlankSizes at startup

**Files:**
- Modify: `src/App.jsx`

- [ ] **Step 1: Add categoryBlankSizes state near the other shared state declarations**

  In `App.jsx`, after the `[listingSync, setListingSync]` state line, add:
  ```jsx
  const [categoryBlankSizes, setCategoryBlankSizes] = useState([]);
  ```

- [ ] **Step 2: Load categoryBlankSizes at startup**

  In the `useEffect` that calls `loadCachedOrders()...loadOrders(true)`, add a parallel load after the chain. The full effect should look like:
  ```jsx
  useEffect(() => {
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
  ```

- [ ] **Step 3: Pass categoryBlankSizes to FulfillmentView**

  Find the line that renders FulfillmentView (currently around line 366):
  ```jsx
  {activeTab === "fulfillment" && <FulfillmentView theme={theme} orders={orders} loading={ordersLoading} error={ordersError} lastUpdated={lastUpdated} onRefresh={() => { loadOpenOrders(); loadOrders(true); }} />}
  ```
  Add the new prop:
  ```jsx
  {activeTab === "fulfillment" && <FulfillmentView theme={theme} orders={orders} loading={ordersLoading} error={ordersError} lastUpdated={lastUpdated} onRefresh={() => { loadOpenOrders(); loadOrders(true); }} categoryBlankSizes={categoryBlankSizes} />}
  ```

- [ ] **Step 4: Verify app compiles in Vite dev mode**

  ```bash
  cd C:\Working_Projects\Inspired_E_daskboard && npm run dev 2>&1 | head -20
  ```
  Expected: Vite server starts, no errors in the output.

- [ ] **Step 5: Commit**

  ```bash
  git add src/App.jsx
  git commit -m "feat: load categoryBlankSizes at startup, pass to FulfillmentView"
  ```

---

## Task 9: inventory-tab.jsx — Label Pool section

**Files:**
- Modify: `src/inventory-tab.jsx`

- [ ] **Step 1: Add mock data for label pool counts**

  In `inventory-tab.jsx`, after the `MOCK_PRODUCTS` constant, add:
  ```jsx
  const MOCK_LABEL_COUNTS = { unassigned: 25, active: 8, retired: 3 };
  ```

  Also add `label_id` to the mock inventory items that simulate labelled pieces (optional but realistic). In `MOCK_INVENTORY`, update the offcut entries:
  ```jsx
  { id: 8, item_type: "offcut", material: "copper_mdf", width: 8, height: 6, thickness: "1/8", quantity: 1, sku: "", notes: "From 12×18 cut", label_id: "mock-label-001", created_at: 0, updated_at: 0 },
  { id: 9, item_type: "offcut", material: "raw_mdf",    width: 10, height: 8, thickness: "1/8", quantity: 1, sku: "", notes: "",               label_id: "mock-label-002", created_at: 0, updated_at: 0 },
  ```

- [ ] **Step 2: Add `LabelPool` component**

  Add a new component near the top of the component section, after `fmtMoney`:

  ```jsx
  // ── Label Pool section ────────────────────────────────────────────────────────

  function LabelPool({ serverUrl }) {
    const [counts, setCounts]     = useState(null);
    const [batchN, setBatchN]     = useState(50);
    const [busy, setBusy]         = useState(false);
    const [open, setOpen]         = useState(false);

    const loadCounts = useCallback(async () => {
      const data = await invokeOrMock("get_label_pool_counts", {}, () => MOCK_LABEL_COUNTS);
      setCounts(data);
    }, []);

    useEffect(() => { loadCounts(); }, [loadCounts]);

    const handleGenerate = async () => {
      setBusy(true);
      try {
        await invokeOrMock("generate_label_batch", { n: batchN }, () => Array.from({ length: batchN }, (_, i) => `mock-${i}`));
        await loadCounts();
      } catch (e) {
        console.error("generate_label_batch failed:", e);
      } finally {
        setBusy(false);
      }
    };

    const handlePrint = async () => {
      if (!serverUrl) return;
      const { open: shellOpen } = await import("@tauri-apps/plugin-shell");
      shellOpen(`${serverUrl.replace(/\/$/, "")}/labels/print`).catch(console.error);
    };

    return (
      <div style={{ marginBottom: 24 }}>
        <button
          onClick={() => setOpen(o => !o)}
          style={{
            background: "none", border: "none", cursor: "pointer",
            display: "flex", alignItems: "center", gap: 8,
            fontFamily: "'DM Sans', sans-serif", fontSize: 12, fontWeight: 600,
            color: "var(--text-muted)", textTransform: "uppercase",
            letterSpacing: "0.05em", padding: "0 0 10px",
          }}
        >
          <span style={{ fontSize: 14 }}>{open ? "▾" : "▸"}</span>
          Label Pool
          {counts && (
            <span style={{
              marginLeft: 6, fontFamily: "monospace", fontWeight: 400,
              fontSize: 11, color: "var(--text-faint)",
            }}>
              {counts.unassigned} ready · {counts.active} active · {counts.retired} retired
            </span>
          )}
        </button>

        {open && (
          <div style={{
            background: "var(--bg-surface)", border: "1px solid var(--border)",
            borderRadius: 10, padding: 16, display: "flex",
            flexWrap: "wrap", gap: 12, alignItems: "flex-end",
          }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 11, fontWeight: 600,
                             color: "var(--text-muted)", textTransform: "uppercase",
                             letterSpacing: "0.05em" }}>Batch size</span>
              <input
                type="number" min={1} max={200} value={batchN}
                onChange={e => setBatchN(Math.max(1, Math.min(200, Number(e.target.value))))}
                style={{
                  width: 80, padding: "7px 10px", fontFamily: "'DM Sans', sans-serif",
                  fontSize: 13, background: "var(--bg-canvas)",
                  border: "1px solid var(--border)", borderRadius: 6,
                  color: "var(--text)",
                }}
              />
            </div>
            <button
              onClick={handleGenerate} disabled={busy}
              style={{
                ...btnPrimary, padding: "8px 16px", fontSize: 13,
                opacity: busy ? 0.6 : 1, cursor: busy ? "not-allowed" : "pointer",
              }}
            >
              {busy ? "Generating…" : "Generate batch"}
            </button>
            {serverUrl ? (
              <button
                onClick={handlePrint}
                style={{
                  fontFamily: "'DM Sans', sans-serif", fontSize: 13, fontWeight: 600,
                  padding: "8px 16px", background: "var(--bg-muted)",
                  border: "1px solid var(--border)", borderRadius: 6,
                  color: "var(--text)", cursor: "pointer",
                }}
              >
                Print batch ↗
              </button>
            ) : (
              <span style={{ fontSize: 12, color: "var(--text-faint)", fontFamily: "'DM Sans', sans-serif" }}>
                (Print requires inventory server)
              </span>
            )}
          </div>
        )}
      </div>
    );
  }
  ```

- [ ] **Step 3: Read server URL from settings and render LabelPool in InventoryTab**

  In the `InventoryTab` component (around the `return (` at line ~1103), add state for server URL near the top of the function body:
  ```jsx
  const [serverUrl, setServerUrl] = useState(null);
  useEffect(() => {
    invokeOrMock("get_settings", {}, () => ({}))
      .then(s => setServerUrl(s.inventory_server_url || null))
      .catch(() => {});
  }, []);
  ```

  Then in the return JSX, just **before** the existing inventory content (before the filter bar or wherever the tab content starts), add:
  ```jsx
  <LabelPool serverUrl={serverUrl} />
  ```
  
  Place it inside the outermost container div, as the first child.

- [ ] **Step 4: Verify the Inventory tab renders without errors in Vite**

  ```bash
  npm run dev
  ```
  Open http://localhost:1420, go to Inventory tab. Expect to see "Label Pool ▸" header with counts.

- [ ] **Step 5: Commit**

  ```bash
  git add src/inventory-tab.jsx
  git commit -m "feat: Label Pool section in Inventory tab"
  ```

---

## Task 10: fulfillment-view.jsx — offcut badge

**Files:**
- Modify: `src/fulfillment-view.jsx`

- [ ] **Step 1: Add mock categoryBlankSizes to fulfillment-view.jsx**

  Near the top of `fulfillment-view.jsx`, after other mock data constants, add:
  ```jsx
  const MOCK_CATEGORY_BLANK_SIZES = [
    { category: "ORN", min_width: 6,  min_height: 6  },
    { category: "DBC", min_width: 10, min_height: 14 },
    { category: "WAL", min_width: 12, min_height: 18 },
    { category: "LMP", min_width: 16, min_height: 24 },
  ];
  ```

- [ ] **Step 2: Add `OffcutBadge` component**

  Add a new component after the `FamilyBadge` component (after line ~247):

  ```jsx
  // ── Offcut availability badge ────────────────────────────────────────────────
  function OffcutBadge({ matches }) {
    const [open, setOpen] = useState(false);
    if (!matches || matches.length === 0) return null;
    return (
      <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
        <button
          onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
          title={`${matches.length} offcut${matches.length > 1 ? "s" : ""} available`}
          style={{
            background: "#1a2e1a", border: "1px solid #3a6a3a",
            borderRadius: 4, padding: "1px 7px",
            fontSize: 10, fontFamily: "'DM Sans', sans-serif",
            color: "#66cc66", cursor: "pointer",
            display: "inline-flex", alignItems: "center", gap: 4,
            whiteSpace: "nowrap",
          }}
        >
          ✂ {matches.length} offcut{matches.length > 1 ? "s" : ""}
        </button>
        {open && (
          <div
            onClick={e => e.stopPropagation()}
            style={{
              position: "absolute", top: "calc(100% + 4px)", left: 0,
              background: "var(--bg-surface)", border: "1px solid var(--border)",
              borderRadius: 8, padding: 10, zIndex: 20, minWidth: 220,
              boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
            }}
          >
            <div style={{
              fontSize: 10, fontWeight: 700, color: "var(--text-muted)",
              textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6,
            }}>
              Matching offcuts
            </div>
            {matches.map((item, i) => (
              <div key={i} style={{
                fontSize: 12, fontFamily: "'DM Sans', sans-serif",
                padding: "5px 0", borderTop: i > 0 ? "1px solid var(--border)" : "none",
                color: "var(--text)",
              }}>
                <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-muted)", marginRight: 6 }}>
                  {item.label_id?.slice(0, 8).toUpperCase() ?? "—"}
                </span>
                {item.material.replace(/_/g, " ")} · {item.width}" × {item.height}"
                {item.notes ? ` · ${item.notes}` : ""}
              </div>
            ))}
          </div>
        )}
      </span>
    );
  }
  ```

- [ ] **Step 3: Accept `categoryBlankSizes` prop in `FulfillmentView`**

  Change the function signature from:
  ```jsx
  export default function FulfillmentView({ theme = "light", orders = [], loading = false, error = null, lastUpdated = null, onRefresh }) {
  ```
  to:
  ```jsx
  export default function FulfillmentView({ theme = "light", orders = [], loading = false, error = null, lastUpdated = null, onRefresh, categoryBlankSizes = [] }) {
  ```

- [ ] **Step 4: Build categoryBlankSizeMap and offcut filter inside FulfillmentView**

  `FulfillmentView` does not load inventory items — add a one-time load, then add the two memos. Place all three after the `familyByProduct` useMemo (around line ~624):

  ```jsx
  // Load inventory once on mount so the offcut badge can filter labelled offcuts.
  // In non-Tauri (Vite preview) mode inventoryItems stays empty and badges are absent — acceptable.
  const [inventoryItems, setInventoryItems] = useState([]);
  useEffect(() => {
    if (!isTauri) return;
    import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("get_inventory").then(setInventoryItems).catch(() => {})
    );
  }, []);

  // Map category → { min_width, min_height } for O(1) lookup per order row.
  const blankSizeByCategory = useMemo(() => {
    const m = {};
    for (const s of categoryBlankSizes) m[s.category.toUpperCase()] = s;
    return m;
  }, [categoryBlankSizes]);

  // All tracked offcuts currently in stock (quantity > 0, has a label assigned).
  const availableOffcuts = useMemo(() => {
    return inventoryItems.filter(
      item => item.item_type === "offcut" && item.quantity > 0 && item.label_id
    );
  }, [inventoryItems]);
  ```

- [ ] **Step 5: Add `offcutMatchesFor` helper function inside FulfillmentView**

  After the `availableOffcuts` memo, add a helper function:
  ```jsx
  const offcutMatchesFor = useCallback((productName) => {
    const family = familyByProduct[productName];
    if (!family?.base) return [];
    const category = family.base.split("-")[0].toUpperCase();
    const sizeReq = blankSizeByCategory[category];
    if (!sizeReq) return [];
    return availableOffcuts.filter(
      item => item.width >= sizeReq.min_width && item.height >= sizeReq.min_height
    );
  }, [familyByProduct, blankSizeByCategory, availableOffcuts]);
  ```

- [ ] **Step 6: Pass offcut matches to OrderRow**

  In `FulfillmentView`'s return JSX, find where `OrderRow` is rendered. It currently receives `family={familyByProduct[order.product_name]}`. Add a new prop:
  ```jsx
  offcutMatches={offcutMatchesFor(order.product_name)}
  ```

  The full OrderRow render call should include this prop.

- [ ] **Step 7: Render `OffcutBadge` inside `OrderRow`**

  In the `OrderRow` component signature, add `offcutMatches` to the destructured props:
  ```jsx
  function OrderRow({ order, family, offcutMatches, expanded, onToggle, trackingEntry, onTrackingLoad, isDark, selected, onSelect, onShipped }) {
  ```

  In the OrderRow JSX, find where `FamilyBadge` is rendered and add `OffcutBadge` immediately after it:
  ```jsx
  <FamilyBadge family={family} dim={isShipped} />
  <OffcutBadge matches={offcutMatches} />
  ```

- [ ] **Step 8: Verify in Vite dev mode**

  ```bash
  npm run dev
  ```
  Open the Fulfillment tab. In non-Tauri (Vite) mode `inventoryItems` stays empty so no badges appear — that's expected. To test badge rendering, run the full Tauri app with a labelled offcut in inventory and a seeded `category_blank_sizes` entry (see Task 11 Step 6).

- [ ] **Step 9: Commit**

  ```bash
  git add src/fulfillment-view.jsx
  git commit -m "feat: offcut availability badge in Fulfillment tab"
  ```

---

## Task 11: End-to-End Manual Test

This is the only task that requires human presence (an iPhone, a running inventory server, and the desktop app).

- [ ] **Step 1: Start inventory server and verify health**

  ```bash
  cd inventory-server && node server.js
  # Expected: [inventory-server] Listening on port 3456
  curl http://localhost:3456/health
  # Expected: {"ok":true,"service":"castshadow-inventory","version":"1.0.0"}
  ```

- [ ] **Step 2: Generate a batch of labels from Inventory tab**

  Launch the Tauri app. Open the Inventory tab. Expand the "Label Pool" section.
  - Confirm counts show (should start at 0 / 0 / 0 on a fresh DB).
  - Set batch size to 5. Click "Generate batch."
  - Confirm counts update to `5 ready · 0 active · 0 retired`.

- [ ] **Step 3: Print labels and scan one**

  Click "Print batch ↗" — the system browser should open `http://localhost:3456/labels/print` showing a 5-cell grid.
  - Find the server's LAN IP: `ipconfig | grep IPv4` (Windows) → note the `192.168.x.x` address.
  - On your iPhone, navigate to `http://192.168.x.x:3456/labels/print`.
  - You should see the same grid. Tap one QR code image (or use Camera app to scan the printed label).
  - Safari should navigate to `http://192.168.x.x:3456/m/[UUID]` and show the **Check in** form.

- [ ] **Step 4: Check in a piece**

  On the iPhone check-in page:
  - Select Type: Offcut, Material: Copper MDF, Width: 8, Height: 6, Thickness: 1/8, Notes: "Test offcut"
  - Tap "Check In."
  - Expected: "Checked in ✓" confirmation page.

- [ ] **Step 5: Verify the item appears in the desktop Inventory tab**

  Force-refresh the Inventory tab (or re-open it). The new offcut should appear in the list with a non-null `label_id`.

- [ ] **Step 6: Verify the Fulfillment badge**

  In the Fulfillment tab, seed a `category_blank_sizes` entry so the badge fires. In Tauri devtools console:
  ```js
  window.__TAURI__.core.invoke("upsert_category_blank_size", { category: "ORN", minWidth: 6.0, minHeight: 6.0 })
  ```
  Reload the app. Orders for ORN-category products should now show the `✂ 1 offcut` badge.

- [ ] **Step 7: Check out the piece**

  Scan the same label again with the iPhone. The page now shows the item details + "Check Out — Mark Used" button. Tap it.
  Expected: "Checked out ✓" page.

  Back in the desktop Inventory tab, the item's quantity should now be 0 and the badge should disappear from the Fulfillment tab (on next reload).

- [ ] **Step 8: Scan a retired label**

  Scan the same QR code again. Expected: "Label retired" page showing the item's last known details.

- [ ] **Step 9: Final commit**

  ```bash
  git add .
  git commit -m "feat: material tracking — label pool, iPhone scan-in/out, offcut badge complete"
  ```

---

## Deferred (not in this plan)

- Transaction log / audit history (`material_events` table)
- Dedicated Materials tab
- Per-SKU cut dimensions
- Partial quantity check-out
- Offcut shape types beyond bounding box
