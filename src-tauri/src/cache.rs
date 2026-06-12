// src-tauri/src/cache.rs
//
// SQLite cache layer.
//
// Orders and tracking snapshots are stored as JSON blobs alongside a small
// set of indexed metadata columns (shop_id, fetched_at, tracking_number).
// This keeps the schema stable even as the domain types evolve, and lets
// callers do all meaningful filtering in Rust rather than SQL.
//
// Schema versioning uses stepped migrations: each version block is
// idempotent (CREATE TABLE IF NOT EXISTS / ALTER TABLE … ADD COLUMN with
// ignored-if-exists error) so upgrading from any earlier version works
// correctly without re-creating tables that already have data.
//
// Thread safety: rusqlite::Connection is Send (not Sync). Wrapping it in
// std::sync::Mutex gives us Send + Sync, which Tauri's State requires.
// All DB methods are synchronous and release the lock before returning,
// so it is safe to call them from async Tauri commands.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;
use tauri::State;

const SCHEMA_VERSION: i32 = 13;

// ── State ─────────────────────────────────────────────────────────────────────

pub struct CacheDb {
    conn: Mutex<Connection>,
}

impl CacheDb {
    pub fn new(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;

        // WAL mode: readers don't block writers in the same process
        conn.execute_batch("PRAGMA journal_mode=WAL;")
            .map_err(|e| e.to_string())?;

        let version: i32 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap_or(0);

        // ── v1 base schema ────────────────────────────────────────────────────
        if version < 1 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS orders (
                    id         TEXT    PRIMARY KEY,
                    shop_id    INTEGER NOT NULL,
                    fetched_at INTEGER NOT NULL,
                    data       TEXT    NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_orders_shop ON orders(shop_id);

                CREATE TABLE IF NOT EXISTS tracking (
                    tracking_number TEXT    PRIMARY KEY,
                    fetched_at      INTEGER NOT NULL,
                    data            TEXT    NOT NULL
                );

                CREATE TABLE IF NOT EXISTS shop_sync (
                    shop_id   INTEGER PRIMARY KEY,
                    synced_at INTEGER NOT NULL
                );

                PRAGMA user_version = 1;",
            )
            .map_err(|e| e.to_string())?;
        }

        // ── v2: inventory table ───────────────────────────────────────────────
        if version < 2 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS inventory (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    item_type   TEXT    NOT NULL DEFAULT 'blank',
                    material    TEXT    NOT NULL,
                    width       REAL    NOT NULL,
                    height      REAL    NOT NULL,
                    thickness   TEXT    NOT NULL DEFAULT '1/8',
                    quantity    INTEGER NOT NULL DEFAULT 0,
                    notes       TEXT    NOT NULL DEFAULT '',
                    created_at  INTEGER NOT NULL,
                    updated_at  INTEGER NOT NULL
                );

                PRAGMA user_version = 2;",
            )
            .map_err(|e| e.to_string())?;
        }

        // ── v3: sku column on inventory + products catalog table ──────────────
        if version < 3 {
            // Add sku to existing inventory rows (ignore error if column already
            // present — happens on a fresh install that skipped v2 directly).
            let _ = conn.execute(
                "ALTER TABLE inventory ADD COLUMN sku TEXT NOT NULL DEFAULT ''",
                [],
            );

            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS products (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    sku         TEXT    NOT NULL UNIQUE,
                    name        TEXT    NOT NULL,
                    category    TEXT    NOT NULL DEFAULT '',
                    design      TEXT    NOT NULL DEFAULT '',
                    finish      TEXT    NOT NULL DEFAULT '',
                    width       REAL    NOT NULL DEFAULT 0,
                    height      REAL    NOT NULL DEFAULT 0,
                    thickness   TEXT    NOT NULL DEFAULT '1/8',
                    material    TEXT    NOT NULL DEFAULT '',
                    notes       TEXT    NOT NULL DEFAULT '',
                    active      INTEGER NOT NULL DEFAULT 1,
                    created_at  INTEGER NOT NULL,
                    updated_at  INTEGER NOT NULL
                );

                PRAGMA user_version = 3;",
            )
            .map_err(|e| e.to_string())?;
        }

        // ── v4: lightburn file library + product→file mappings ────────────────
        if version < 4 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS lightburn_files (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    sku_base    TEXT    NOT NULL UNIQUE,
                    short_name  TEXT    NOT NULL,
                    filename    TEXT    NOT NULL UNIQUE,
                    created_at  INTEGER NOT NULL,
                    updated_at  INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS lightburn_mappings (
                    id                INTEGER PRIMARY KEY AUTOINCREMENT,
                    product_name      TEXT    NOT NULL UNIQUE,
                    lightburn_file_id INTEGER NOT NULL REFERENCES lightburn_files(id) ON DELETE CASCADE,
                    created_at        INTEGER NOT NULL
                );
                PRAGMA user_version = 4;",
            )
            .map_err(|e| e.to_string())?;
        }

        // ── v5: durable product catalog (survives listing deletion / cache clear) ─
        if version < 5 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS catalog_products (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    product_name TEXT    NOT NULL UNIQUE,
                    image_url    TEXT,
                    last_seen    TEXT,        -- ISO date 'YYYY-MM-DD'
                    created_at   INTEGER NOT NULL,
                    updated_at   INTEGER NOT NULL
                );
                PRAGMA user_version = 5;",
            )
            .map_err(|e| e.to_string())?;
        }

        // ── v6: shop_id on catalog_products + catalog file attachments ────────
        if version < 6 {
            let _ = conn.execute(
                "ALTER TABLE catalog_products ADD COLUMN shop_id INTEGER NOT NULL DEFAULT 0",
                [],
            );
            conn.execute_batch(
                // Files (.svg, .zip, etc.) are stored on disk; only metadata here.
                "CREATE TABLE IF NOT EXISTS catalog_files (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    product_name TEXT    NOT NULL,
                    label        TEXT    NOT NULL DEFAULT '',
                    filename     TEXT    NOT NULL,
                    file_size    INTEGER NOT NULL DEFAULT 0,
                    created_at   INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_catalog_files_product
                    ON catalog_files(product_name);
                PRAGMA user_version = 6;",
            )
            .map_err(|e| e.to_string())?;
        }

        // ── v7: per-unit cost on inventory (for BOM + landed-cost calcs) ──────
        if version < 7 {
            match conn.execute(
                "ALTER TABLE inventory ADD COLUMN unit_cost REAL NOT NULL DEFAULT 0",
                [],
            ) {
                Ok(_) => {}
                Err(e) if e.to_string().contains("duplicate column") => {}
                Err(e) => return Err(e.to_string()),
            }
            conn.execute_batch("PRAGMA user_version = 7;")
                .map_err(|e| e.to_string())?;
        }

        // ── v8: listing → product-family links ───────────────────────────────
        // Maps an Etsy listing (by title) to a product family identified by its
        // SKU base (CATEGORY-DESIGN, e.g. "DBC-RBH"). One listing → one family;
        // a family can back many listings (e.g. the same design in two shops).
        // This is the spine that lets Listings inherit category/stock/file.
        if version < 8 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS listing_product_links (
                    product_name TEXT    NOT NULL PRIMARY KEY,
                    sku_base     TEXT    NOT NULL,
                    created_at   INTEGER NOT NULL
                );
                PRAGMA user_version = 8;",
            )
            .map_err(|e| e.to_string())?;
        }

        // ── v9: manual monthly ad spend ──────────────────────────────────────
        // Etsy's Open API does not expose advertising spend, so it's entered by
        // hand. Keyed by month "YYYY-MM"; amount in dollars.
        if version < 9 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS ad_spend (
                    month      TEXT    NOT NULL PRIMARY KEY,
                    amount     REAL    NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL
                );
                PRAGMA user_version = 9;",
            )
            .map_err(|e| e.to_string())?;
        }

        // ── v10: per-shop ad spend ───────────────────────────────────────────
        // Each Etsy shop is a separate account with its own monthly statement,
        // so ad spend is now keyed by (shop_id, month). Pre-v10 rows had no shop
        // attribution — migrate them to shop_id 0 ("unattributed"), where they
        // still count toward the all-shops total until re-imported per shop.
        if version < 10 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS ad_spend_v2 (
                    shop_id    INTEGER NOT NULL DEFAULT 0,
                    month      TEXT    NOT NULL,
                    amount     REAL    NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (shop_id, month)
                );
                INSERT INTO ad_spend_v2 (shop_id, month, amount, updated_at)
                    SELECT 0, month, amount, updated_at FROM ad_spend;
                DROP TABLE ad_spend;
                ALTER TABLE ad_spend_v2 RENAME TO ad_spend;
                PRAGMA user_version = 10;",
            )
            .map_err(|e| e.to_string())?;
        }

        // ── v11: active-listing flag on catalog_products ─────────────────────
        // catalog_products accumulates everything ever seen — both currently
        // active Etsy listings AND old products that only appear in historical
        // orders (e.g. a material ordered years ago, since delisted). This flag,
        // refreshed by sync_active_listings, marks the rows that are live on the
        // storefront right now so the Listings tab can hide delisted items.
        // Seed existing rows active so upgrading does not blank the Listings tab
        // before active-listing sync has succeeded with the new listings_r scope.
        // Successful per-shop syncs will still clear delisted rows afterward.
        if version < 11 {
            match conn.execute(
                "ALTER TABLE catalog_products ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1",
                [],
            ) {
                Ok(_) => {}
                Err(e) if e.to_string().contains("duplicate column") => {}
                Err(e) => return Err(e.to_string()),
            }
            conn.execute_batch("PRAGMA user_version = 11;")
            .map_err(|e| e.to_string())?;
        }

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

        // ── v13: seller notes — local-only private notes per receipt (Etsy's
        // own private order notes are not exposed in the v3 API) ─────────────
        if version < 13 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS seller_notes (
                    receipt_id TEXT    PRIMARY KEY,
                    note       TEXT    NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                PRAGMA user_version = 13;",
            )
            .map_err(|e| e.to_string())?;
        }

        let final_version: i32 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if final_version < SCHEMA_VERSION {
            return Err(format!(
                "cache schema migration incomplete: version {} < {}",
                final_version, SCHEMA_VERSION
            ));
        }

        Ok(Self { conn: Mutex::new(conn) })
    }

    // ── Orders ────────────────────────────────────────────────────────────────

    /// Upsert a batch of orders. Each tuple is (id, shop_id, json).
    pub fn upsert_orders(&self, rows: &[(String, u64, String)]) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let now = now_unix();

        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for (id, shop_id, data) in rows {
            tx.execute(
                "INSERT OR REPLACE INTO orders (id, shop_id, fetched_at, data)
                 VALUES (?1, ?2, ?3, ?4)",
                params![id, *shop_id as i64, now, data],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

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

    /// Return JSON blobs for all cached orders belonging to the given shops.
    pub fn get_orders_for_shops(&self, shop_ids: &[u64]) -> Result<Vec<String>, String> {
        if shop_ids.is_empty() {
            return Ok(vec![]);
        }
        let conn = self.conn.lock().unwrap();

        let ids_i64: Vec<i64> = shop_ids.iter().map(|&id| id as i64).collect();
        let placeholders = (1..=ids_i64.len())
            .map(|i| format!("?{}", i))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!("SELECT data FROM orders WHERE shop_id IN ({})", placeholders);

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(
                rusqlite::params_from_iter(ids_i64.iter()),
                |row| row.get::<_, String>(0),
            )
            .map_err(|e| e.to_string())?;

        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    // ── Shop sync timestamps ──────────────────────────────────────────────────

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

    // ── Tracking ──────────────────────────────────────────────────────────────

    pub fn upsert_tracking(&self, tracking_number: &str, data: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO tracking (tracking_number, fetched_at, data)
             VALUES (?1, ?2, ?3)",
            params![tracking_number, now_unix(), data],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Returns (fetched_at_unix, json_blob) if present.
    pub fn get_tracking(&self, tracking_number: &str) -> Option<(i64, String)> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT fetched_at, data FROM tracking WHERE tracking_number = ?1",
            params![tracking_number],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .ok()
    }

    // ── Inventory ─────────────────────────────────────────────────────────────

    pub fn get_inventory(&self) -> Result<Vec<crate::inventory::InventoryItem>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, item_type, material, width, height, thickness, quantity, sku, notes, unit_cost, created_at, updated_at, label_id
             FROM inventory ORDER BY item_type, material, width DESC, height DESC"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok(crate::inventory::InventoryItem {
                id:         row.get(0)?,
                item_type:  row.get(1)?,
                material:   row.get(2)?,
                width:      row.get(3)?,
                height:     row.get(4)?,
                thickness:  row.get(5)?,
                quantity:   row.get(6)?,
                sku:        row.get(7)?,
                notes:      row.get(8)?,
                unit_cost:  row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
                label_id:   row.get(12)?,
            })
        }).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn add_inventory_item(&self, item: &crate::inventory::NewInventoryItem) -> Result<crate::inventory::InventoryItem, String> {
        let conn = self.conn.lock().unwrap();
        let now = now_unix();
        conn.execute(
            "INSERT INTO inventory (item_type, material, width, height, thickness, quantity, sku, notes, unit_cost, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![item.item_type, item.material, item.width, item.height,
                    item.thickness, item.quantity, item.sku, item.notes, item.unit_cost, now],
        ).map_err(|e| e.to_string())?;
        let id = conn.last_insert_rowid();
        Ok(crate::inventory::InventoryItem {
            id,
            item_type:  item.item_type.clone(),
            material:   item.material.clone(),
            width:      item.width,
            height:     item.height,
            thickness:  item.thickness.clone(),
            quantity:   item.quantity,
            sku:        item.sku.clone(),
            notes:      item.notes.clone(),
            unit_cost:  item.unit_cost,
            created_at: now,
            updated_at: now,
            label_id:   None,
        })
    }

    pub fn set_inventory_qty(&self, id: i64, quantity: i32) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let rows = conn.execute(
            "UPDATE inventory SET quantity = ?1, updated_at = ?2 WHERE id = ?3",
            params![quantity, now_unix(), id],
        ).map_err(|e| e.to_string())?;
        if rows == 0 { Err(format!("inventory item {} not found", id)) } else { Ok(()) }
    }

    pub fn adjust_inventory_qty(&self, id: i64, delta: i32) -> Result<i32, String> {
        let conn = self.conn.lock().unwrap();
        let now = now_unix();
        conn.execute(
            "UPDATE inventory SET quantity = MAX(0, quantity + ?1), updated_at = ?2 WHERE id = ?3",
            params![delta, now, id],
        ).map_err(|e| e.to_string())?;
        let qty: i32 = conn.query_row(
            "SELECT quantity FROM inventory WHERE id = ?1", params![id], |r| r.get(0)
        ).map_err(|e| e.to_string())?;
        Ok(qty)
    }

    pub fn update_inventory_item(&self, item: &crate::inventory::InventoryItem) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let rows = conn.execute(
            "UPDATE inventory SET item_type=?1, material=?2, width=?3, height=?4,
             thickness=?5, quantity=?6, sku=?7, notes=?8, unit_cost=?9, updated_at=?10 WHERE id=?11",
            params![item.item_type, item.material, item.width, item.height,
                    item.thickness, item.quantity, item.sku, item.notes, item.unit_cost, now_unix(), item.id],
        ).map_err(|e| e.to_string())?;
        if rows == 0 { Err(format!("inventory item {} not found", item.id)) } else { Ok(()) }
    }

    pub fn delete_inventory_item(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM inventory WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── Products ──────────────────────────────────────────────────────────────

    pub fn get_products(&self) -> Result<Vec<crate::catalog::Product>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, sku, name, category, design, finish, width, height,
                    thickness, material, notes, active, created_at, updated_at
             FROM products WHERE active = 1 ORDER BY category, sku"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok(crate::catalog::Product {
                id:         row.get(0)?,
                sku:        row.get(1)?,
                name:       row.get(2)?,
                category:   row.get(3)?,
                design:     row.get(4)?,
                finish:     row.get(5)?,
                width:      row.get(6)?,
                height:     row.get(7)?,
                thickness:  row.get(8)?,
                material:   row.get(9)?,
                notes:      row.get(10)?,
                active:     row.get::<_, i64>(11)? != 0,
                created_at: row.get(12)?,
                updated_at: row.get(13)?,
            })
        }).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn add_product(&self, p: &crate::catalog::NewProduct) -> Result<crate::catalog::Product, String> {
        let conn = self.conn.lock().unwrap();
        let now = now_unix();
        conn.execute(
            "INSERT INTO products
             (sku, name, category, design, finish, width, height, thickness, material, notes, active, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, ?11)",
            params![p.sku, p.name, p.category, p.design, p.finish,
                    p.width, p.height, p.thickness, p.material, p.notes, now],
        ).map_err(|e| e.to_string())?;
        let id = conn.last_insert_rowid();
        Ok(crate::catalog::Product {
            id,
            sku:        p.sku.clone(),
            name:       p.name.clone(),
            category:   p.category.clone(),
            design:     p.design.clone(),
            finish:     p.finish.clone(),
            width:      p.width,
            height:     p.height,
            thickness:  p.thickness.clone(),
            material:   p.material.clone(),
            notes:      p.notes.clone(),
            active:     true,
            created_at: now,
            updated_at: now,
        })
    }

    pub fn update_product(&self, p: &crate::catalog::Product) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let rows = conn.execute(
            "UPDATE products SET sku=?1, name=?2, category=?3, design=?4, finish=?5,
             width=?6, height=?7, thickness=?8, material=?9, notes=?10, updated_at=?11
             WHERE id=?12",
            params![p.sku, p.name, p.category, p.design, p.finish,
                    p.width, p.height, p.thickness, p.material, p.notes, now_unix(), p.id],
        ).map_err(|e| e.to_string())?;
        if rows == 0 { Err(format!("product {} not found", p.id)) } else { Ok(()) }
    }

    pub fn delete_product(&self, id: i64) -> Result<(), String> {
        // Soft delete — set active = 0, preserve history
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE products SET active = 0, updated_at = ?1 WHERE id = ?2",
            params![now_unix(), id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── Lightburn file library ────────────────────────────────────────────────

    pub fn get_lightburn_files(&self) -> Result<Vec<crate::lightburn::LightburnFile>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, sku_base, short_name, filename, created_at, updated_at
             FROM lightburn_files ORDER BY sku_base"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok(crate::lightburn::LightburnFile {
                id:         row.get(0)?,
                sku_base:   row.get(1)?,
                short_name: row.get(2)?,
                filename:   row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        }).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn add_lightburn_file(&self, sku_base: &str, short_name: &str, filename: &str) -> Result<crate::lightburn::LightburnFile, String> {
        let conn = self.conn.lock().unwrap();
        let now = now_unix();
        conn.execute(
            "INSERT INTO lightburn_files (sku_base, short_name, filename, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![sku_base, short_name, filename, now],
        ).map_err(|e| {
            if e.to_string().contains("UNIQUE") {
                format!("A Lightburn file for \"{}\" already exists", sku_base)
            } else {
                e.to_string()
            }
        })?;
        let id = conn.last_insert_rowid();
        Ok(crate::lightburn::LightburnFile {
            id,
            sku_base:   sku_base.to_string(),
            short_name: short_name.to_string(),
            filename:   filename.to_string(),
            created_at: now,
            updated_at: now,
        })
    }

    pub fn update_lightburn_file(
        &self, id: i64, sku_base: &str, short_name: &str, filename: &str,
    ) -> Result<crate::lightburn::LightburnFile, String> {
        let conn = self.conn.lock().unwrap();
        let now = now_unix();
        let rows = conn.execute(
            "UPDATE lightburn_files SET sku_base=?1, short_name=?2, filename=?3, updated_at=?4
             WHERE id=?5",
            params![sku_base, short_name, filename, now, id],
        ).map_err(|e| e.to_string())?;
        if rows == 0 { return Err(format!("Lightburn file {} not found", id)); }
        conn.query_row(
            "SELECT id, sku_base, short_name, filename, created_at, updated_at
             FROM lightburn_files WHERE id=?1",
            params![id],
            |row| Ok(crate::lightburn::LightburnFile {
                id:         row.get(0)?,
                sku_base:   row.get(1)?,
                short_name: row.get(2)?,
                filename:   row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            }),
        ).map_err(|e| e.to_string())
    }

    pub fn get_lightburn_file(&self, id: i64) -> Result<crate::lightburn::LightburnFile, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, sku_base, short_name, filename, created_at, updated_at
             FROM lightburn_files WHERE id = ?1",
            params![id],
            |row| Ok(crate::lightburn::LightburnFile {
                id:         row.get(0)?,
                sku_base:   row.get(1)?,
                short_name: row.get(2)?,
                filename:   row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            }),
        ).map_err(|_| format!("Lightburn file {} not found", id))
    }

    pub fn delete_lightburn_file(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM lightburn_mappings WHERE lightburn_file_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM lightburn_files WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_lightburn_mappings(&self) -> Result<Vec<crate::lightburn::LightburnMapping>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT m.id, m.product_name, m.lightburn_file_id,
                    f.sku_base, f.short_name, f.filename
             FROM lightburn_mappings m
             JOIN lightburn_files f ON f.id = m.lightburn_file_id
             ORDER BY m.product_name"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok(crate::lightburn::LightburnMapping {
                id:                 row.get(0)?,
                product_name:       row.get(1)?,
                lightburn_file_id:  row.get(2)?,
                sku_base:           row.get(3)?,
                short_name:         row.get(4)?,
                filename:           row.get(5)?,
            })
        }).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn upsert_lightburn_mapping(&self, product_name: &str, lightburn_file_id: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO lightburn_mappings (product_name, lightburn_file_id, created_at)
             VALUES (?1, ?2, ?3)",
            params![product_name, lightburn_file_id, now_unix()],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_lightburn_mapping(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM lightburn_mappings WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── Catalog products ──────────────────────────────────────────────────────

    /// Bulk-upsert products seen in orders. Keeps the latest last_seen date,
    /// fills in image_url only when currently null, updates shop_id when known.
    /// Never deletes — once a product is in the table it stays forever.
    pub fn upsert_catalog_products(&self, items: &[CatalogProductInput]) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let now = now_unix();
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for item in items {
            tx.execute(
                "INSERT INTO catalog_products (product_name, shop_id, image_url, last_seen, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                 ON CONFLICT(product_name) DO UPDATE SET
                   shop_id    = CASE WHEN excluded.shop_id != 0 THEN excluded.shop_id ELSE shop_id END,
                   image_url  = COALESCE(excluded.image_url, image_url),
                   last_seen  = CASE
                                  WHEN excluded.last_seen IS NOT NULL
                                   AND (last_seen IS NULL OR excluded.last_seen > last_seen)
                                  THEN excluded.last_seen
                                  ELSE last_seen
                                END,
                   updated_at = excluded.updated_at",
                params![item.product_name, item.shop_id, item.image_url, item.last_seen, now],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn list_catalog_products(&self) -> Result<Vec<CatalogProduct>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, product_name, shop_id, image_url, last_seen, created_at, updated_at, is_active
             FROM catalog_products ORDER BY shop_id, product_name COLLATE NOCASE"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok(CatalogProduct {
                id:           row.get(0)?,
                product_name: row.get(1)?,
                shop_id:      row.get(2)?,
                image_url:    row.get(3)?,
                last_seen:    row.get(4)?,
                created_at:   row.get(5)?,
                updated_at:   row.get(6)?,
                is_active:    row.get::<_, i64>(7)? != 0,
            })
        }).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Replace the active-listing flags for one shop: every row for that shop is
    /// reset to inactive, then the supplied product names (the listings Etsy
    /// reports as active right now) are flagged active. Run after upserting a
    /// shop's active listings so delisted items get unflagged automatically.
    /// Done in a single transaction so the Listings tab never sees a half-updated
    /// state. Only call when the active-listings fetch for the shop succeeded —
    /// otherwise a failed fetch would wrongly clear every flag.
    pub fn mark_shop_listings_active(&self, shop_id: i64, active_names: &[String]) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE catalog_products SET is_active = 0 WHERE shop_id = ?1",
            params![shop_id],
        ).map_err(|e| e.to_string())?;
        for name in active_names {
            tx.execute(
                "UPDATE catalog_products SET is_active = 1 WHERE shop_id = ?1 AND product_name = ?2",
                params![shop_id, name],
            ).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    // ── Listing → product-family links ───────────────────────────────────────

    /// Link a listing (by title) to a product family (SKU base, e.g. "DBC-RBH").
    pub fn link_listing_product(&self, product_name: &str, sku_base: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO listing_product_links (product_name, sku_base, created_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(product_name) DO UPDATE SET sku_base = excluded.sku_base",
            params![product_name, sku_base.to_uppercase(), now_unix()],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Remove a listing's product-family link.
    pub fn unlink_listing_product(&self, product_name: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM listing_product_links WHERE product_name = ?1",
            params![product_name],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_listing_product_links(&self) -> Result<Vec<ListingProductLink>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT product_name, sku_base FROM listing_product_links"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok(ListingProductLink {
                product_name: row.get(0)?,
                sku_base:     row.get(1)?,
            })
        }).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Seed links from existing Lightburn mappings: each mapped listing already
    /// points at a file whose `sku_base` is exactly the product family. Existing
    /// links are left untouched (INSERT OR IGNORE) so manual links win.
    /// Returns the number of links created.
    pub fn seed_listing_links_from_mappings(&self) -> Result<usize, String> {
        let conn = self.conn.lock().unwrap();
        let now = now_unix();
        let count = conn.execute(
            "INSERT OR IGNORE INTO listing_product_links (product_name, sku_base, created_at)
             SELECT m.product_name, UPPER(f.sku_base), ?1
             FROM lightburn_mappings m
             JOIN lightburn_files f ON f.id = m.lightburn_file_id
             WHERE f.sku_base IS NOT NULL AND f.sku_base != ''",
            params![now],
        ).map_err(|e| e.to_string())?;
        Ok(count)
    }

    // ── Ad spend (per-shop monthly entry / statement import) ─────────────────

    /// Set (upsert) the ad spend for one shop in a month ("YYYY-MM"). Amount in
    /// dollars. Keyed by (shop_id, month), so writing one shop's month never
    /// touches another shop or another month.
    pub fn set_ad_spend(&self, shop_id: u64, month: &str, amount: f64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO ad_spend (shop_id, month, amount, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(shop_id, month) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at",
            params![shop_id as i64, month, amount, now_unix()],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_ad_spend(&self) -> Result<Vec<AdSpend>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT shop_id, month, amount FROM ad_spend ORDER BY shop_id, month"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok(AdSpend {
                shop_id: row.get::<_, i64>(0)? as u64,
                month:   row.get(1)?,
                amount:  row.get(2)?,
            })
        }).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    // ── Seller notes (local-only private notes per receipt) ──────────────────

    /// Set or clear the seller's private note for a receipt. An empty/blank
    /// note deletes the row so the badge logic can treat absence as "no note".
    pub fn set_seller_note(&self, receipt_id: &str, note: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        if note.trim().is_empty() {
            conn.execute("DELETE FROM seller_notes WHERE receipt_id = ?1", params![receipt_id])
                .map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "INSERT INTO seller_notes (receipt_id, note, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(receipt_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at",
                params![receipt_id, note, now_unix()],
            ).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn list_seller_notes(&self) -> Result<Vec<SellerNote>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT receipt_id, note FROM seller_notes"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok(SellerNote {
                receipt_id: row.get(0)?,
                note:       row.get(1)?,
            })
        }).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    // ── Catalog files (.svg, .zip, etc. — stored on disk) ────────────────────

    pub fn insert_catalog_file(
        &self,
        product_name: &str,
        label: &str,
        filename: &str,
        file_size: i64,
    ) -> Result<CatalogFile, String> {
        let conn = self.conn.lock().unwrap();
        let now = now_unix();
        conn.execute(
            "INSERT INTO catalog_files (product_name, label, filename, file_size, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![product_name, label, filename, file_size, now],
        ).map_err(|e| e.to_string())?;
        Ok(CatalogFile {
            id: conn.last_insert_rowid(),
            product_name: product_name.to_string(),
            label:        label.to_string(),
            filename:     filename.to_string(),
            file_size,
            created_at:   now,
        })
    }

    pub fn list_catalog_files(&self) -> Result<Vec<CatalogFile>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, product_name, label, filename, file_size, created_at
             FROM catalog_files ORDER BY product_name COLLATE NOCASE, created_at"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok(CatalogFile {
                id:           row.get(0)?,
                product_name: row.get(1)?,
                label:        row.get(2)?,
                filename:     row.get(3)?,
                file_size:    row.get(4)?,
                created_at:   row.get(5)?,
            })
        }).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn get_catalog_file_meta(&self, id: i64) -> Result<CatalogFile, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, product_name, label, filename, file_size, created_at
             FROM catalog_files WHERE id = ?1",
            params![id],
            |row| Ok(CatalogFile {
                id:           row.get(0)?,
                product_name: row.get(1)?,
                label:        row.get(2)?,
                filename:     row.get(3)?,
                file_size:    row.get(4)?,
                created_at:   row.get(5)?,
            }),
        ).map_err(|_| format!("Catalog file {} not found", id))
    }

    pub fn delete_catalog_file_meta(&self, id: i64) -> Result<String, String> {
        let conn = self.conn.lock().unwrap();
        let filename: String = conn.query_row(
            "SELECT filename FROM catalog_files WHERE id = ?1",
            params![id],
            |row| row.get(0),
        ).map_err(|_| format!("Catalog file {} not found", id))?;
        conn.execute("DELETE FROM catalog_files WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(filename)
    }

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

    // ── Maintenance ───────────────────────────────────────────────────────────

    pub fn clear_orders(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM orders", []).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM shop_sync", []).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Clear cached orders for a single shop and reset its sync timestamp.
    /// Used after a write (e.g. marking shipped) so the next get_orders re-pulls
    /// fresh data for that shop only.
    pub fn clear_shop_orders(&self, shop_id: u64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM orders WHERE shop_id = ?1", [shop_id]).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM shop_sync WHERE shop_id = ?1", [shop_id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn clear_tracking(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM tracking", []).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn order_count(&self) -> i64 {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
            .unwrap_or(0)
    }

    pub fn tracking_count(&self) -> i64 {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM tracking", [], |r| r.get(0))
            .unwrap_or(0)
    }
}

// ── Catalog product types ─────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CatalogProduct {
    pub id:           i64,
    pub product_name: String,
    pub shop_id:      i64,
    pub image_url:    Option<String>,
    pub last_seen:    Option<String>,
    pub created_at:   i64,
    pub updated_at:   i64,
    /// True if this product is a listing currently live on the Etsy storefront
    /// (as of the last active-listings sync). False for delisted items and
    /// products that only ever appeared in historical orders.
    pub is_active:    bool,
}

/// Sent by the frontend when syncing products from orders.
/// JS sends camelCase keys (productName, shopId, …) so we rename accordingly.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogProductInput {
    pub product_name: String,
    pub shop_id:      i64,
    pub image_url:    Option<String>,
    pub last_seen:    Option<String>,
}

/// Catalog file metadata (.svg, .zip, etc. — content lives on disk).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CatalogFile {
    pub id:           i64,
    pub product_name: String,
    pub label:        String,
    pub filename:     String,
    pub file_size:    i64,
    pub created_at:   i64,
}

/// A listing (by title) linked to a product family (SKU base, e.g. "DBC-RBH").
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ListingProductLink {
    pub product_name: String,
    pub sku_base:     String,
}

/// Ad spend for one shop in a month ("YYYY-MM"), in dollars. shop_id 0 means
/// "unattributed" (pre-v10 rows entered before per-shop tracking existed).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AdSpend {
    pub shop_id: u64,
    pub month:   String,
    pub amount:  f64,
}

/// The seller's private note on a receipt — local-only, never synced to Etsy
/// (the v3 API has no field for Etsy's own private order notes).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SellerNote {
    pub receipt_id: String,
    pub note:       String,
}

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

// ── Helpers ───────────────────────────────────────────────────────────────────

pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct CacheStatus {
    pub order_count: i64,
    pub tracking_count: i64,
    pub shop_ages: Vec<ShopAge>,
}

#[derive(Serialize)]
pub struct ShopAge {
    pub shop_id: u64,
    /// Seconds since last sync, or null if never synced.
    pub age_secs: Option<i64>,
}

/// Returns row counts and per-shop cache age. Useful for a settings/debug panel.
#[tauri::command]
pub fn cache_status(shop_ids: Vec<u64>, cache: State<'_, CacheDb>) -> CacheStatus {
    CacheStatus {
        order_count: cache.order_count(),
        tracking_count: cache.tracking_count(),
        shop_ages: shop_ids
            .into_iter()
            .map(|id| ShopAge { shop_id: id, age_secs: cache.shop_age_secs(id) })
            .collect(),
    }
}

/// Wipe all cached orders and tracking. Forces a full re-fetch on next get_orders call.
#[tauri::command]
pub fn clear_cache(cache: State<'_, CacheDb>) -> Result<(), String> {
    cache.clear_orders()?;
    cache.clear_tracking()
}

/// Upsert products extracted from orders into the durable catalog table.
/// Call this after every successful order load. Products are never deleted.
#[tauri::command]
pub fn sync_catalog_products(
    items: Vec<CatalogProductInput>,
    cache: State<'_, CacheDb>,
) -> Result<(), String> {
    cache.upsert_catalog_products(&items)
}

/// Return all products ever seen, ordered alphabetically.
#[tauri::command]
pub fn list_catalog_products(cache: State<'_, CacheDb>) -> Result<Vec<CatalogProduct>, String> {
    cache.list_catalog_products()
}

// ── Listing → product-family link commands ──────────────────────────────────

/// Link a listing (by title) to a product family (SKU base, e.g. "DBC-RBH").
#[tauri::command]
pub fn link_listing_product(
    product_name: String,
    sku_base: String,
    cache: State<'_, CacheDb>,
) -> Result<(), String> {
    cache.link_listing_product(&product_name, &sku_base)
}

/// Remove a listing's product-family link.
#[tauri::command]
pub fn unlink_listing_product(
    product_name: String,
    cache: State<'_, CacheDb>,
) -> Result<(), String> {
    cache.unlink_listing_product(&product_name)
}

/// List all listing → product-family links.
#[tauri::command]
pub fn list_listing_product_links(cache: State<'_, CacheDb>) -> Result<Vec<ListingProductLink>, String> {
    cache.list_listing_product_links()
}

/// Seed links from existing Lightburn mappings. Returns count of new links.
#[tauri::command]
pub fn seed_listing_links_from_mappings(cache: State<'_, CacheDb>) -> Result<usize, String> {
    cache.seed_listing_links_from_mappings()
}

// ── Ad spend commands ───────────────────────────────────────────────────────

/// Set the ad spend for one shop in a month ("YYYY-MM").
#[tauri::command]
pub fn set_ad_spend(shop_id: u64, month: String, amount: f64, cache: State<'_, CacheDb>) -> Result<(), String> {
    cache.set_ad_spend(shop_id, &month, amount)
}

/// List all manually-entered monthly ad spend.
#[tauri::command]
pub fn list_ad_spend(cache: State<'_, CacheDb>) -> Result<Vec<AdSpend>, String> {
    cache.list_ad_spend()
}

/// Set or clear (empty note) the seller's private note for a receipt.
#[tauri::command]
pub fn set_seller_note(receipt_id: String, note: String, cache: State<'_, CacheDb>) -> Result<(), String> {
    cache.set_seller_note(&receipt_id, &note)
}

/// List all seller private notes.
#[tauri::command]
pub fn list_seller_notes(cache: State<'_, CacheDb>) -> Result<Vec<SellerNote>, String> {
    cache.list_seller_notes()
}

/// Attach a file (.svg, .zip, etc.) to a catalog product.
/// `data_base64` is the raw file bytes encoded as base64 — works for both
/// text (SVG/XML) and binary (ZIP) content.
#[tauri::command]
pub fn save_catalog_file(
    product_name: String,
    label: String,
    filename: String,
    data_base64: String,
    cache: State<'_, CacheDb>,
    app: tauri::AppHandle,
) -> Result<CatalogFile, String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use tauri::Manager;

    let bytes = STANDARD.decode(&data_base64).map_err(|e| e.to_string())?;
    let file_size = bytes.len() as i64;

    let files_dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("catalog_files");
    std::fs::create_dir_all(&files_dir).map_err(|e| e.to_string())?;

    let safe_name = std::path::PathBuf::from(&filename)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| filename.clone());

    std::fs::write(files_dir.join(&safe_name), &bytes).map_err(|e| e.to_string())?;

    cache.insert_catalog_file(product_name.trim(), label.trim(), &safe_name, file_size)
}

/// Return all catalog file metadata (no content).
#[tauri::command]
pub fn list_catalog_files(cache: State<'_, CacheDb>) -> Result<Vec<CatalogFile>, String> {
    cache.list_catalog_files()
}

/// Delete a catalog file by id — removes from DB and disk.
#[tauri::command]
pub fn delete_catalog_file(
    id: i64,
    cache: State<'_, CacheDb>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Manager;
    let filename = cache.delete_catalog_file_meta(id)?;
    let files_dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("catalog_files");
    let _ = std::fs::remove_file(files_dir.join(&filename));
    Ok(())
}

/// Copy a catalog file to Desktop\Catalog_Files\{filename} and return the path.
#[tauri::command]
pub fn export_catalog_file(
    id: i64,
    cache: State<'_, CacheDb>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    use tauri::Manager;
    let meta = cache.get_catalog_file_meta(id)?;
    let files_dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("catalog_files");
    let src = files_dir.join(&meta.filename);
    let bytes = std::fs::read(&src)
        .map_err(|_| format!("File not found on disk: {}", meta.filename))?;

    let desktop = app.path().desktop_dir().map_err(|e| e.to_string())?;
    let exports_dir = desktop.join("Catalog_Files");
    std::fs::create_dir_all(&exports_dir).map_err(|e| e.to_string())?;
    let dest = exports_dir.join(&meta.filename);
    std::fs::write(&dest, bytes).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

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
