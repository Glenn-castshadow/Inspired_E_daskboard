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

const SCHEMA_VERSION: i32 = 6;

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

    /// Seconds elapsed since this shop's cache was last written.
    /// Returns None if the shop has never been synced.
    pub fn shop_age_secs(&self, shop_id: u64) -> Option<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT synced_at FROM shop_sync WHERE shop_id = ?1",
            params![shop_id as i64],
            |row| row.get::<_, i64>(0),
        )
        .ok()
        .map(|synced_at| now_unix() - synced_at)
    }

    pub fn mark_shop_synced(&self, shop_id: u64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO shop_sync (shop_id, synced_at) VALUES (?1, ?2)",
            params![shop_id as i64, now_unix()],
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
            "SELECT id, item_type, material, width, height, thickness, quantity, sku, notes, created_at, updated_at
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
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
            })
        }).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn add_inventory_item(&self, item: &crate::inventory::NewInventoryItem) -> Result<crate::inventory::InventoryItem, String> {
        let conn = self.conn.lock().unwrap();
        let now = now_unix();
        conn.execute(
            "INSERT INTO inventory (item_type, material, width, height, thickness, quantity, sku, notes, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            params![item.item_type, item.material, item.width, item.height,
                    item.thickness, item.quantity, item.sku, item.notes, now],
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
            created_at: now,
            updated_at: now,
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
             thickness=?5, quantity=?6, sku=?7, notes=?8, updated_at=?9 WHERE id=?10",
            params![item.item_type, item.material, item.width, item.height,
                    item.thickness, item.quantity, item.sku, item.notes, now_unix(), item.id],
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
            "SELECT id, product_name, shop_id, image_url, last_seen, created_at, updated_at
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
}

/// Sent by the frontend when syncing products from orders.
#[derive(Debug, Deserialize)]
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
