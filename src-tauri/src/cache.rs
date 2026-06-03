// src-tauri/src/cache.rs
//
// SQLite cache layer.
//
// Orders and tracking snapshots are stored as JSON blobs alongside a small
// set of indexed metadata columns (shop_id, fetched_at, tracking_number).
// This keeps the schema stable even as the domain types evolve, and lets
// callers do all meaningful filtering in Rust rather than SQL.
//
// Schema lives entirely in init() — no migration framework needed at this
// scale. If the schema changes, bump the user_version pragma and re-create.
//
// Thread safety: rusqlite::Connection is Send (not Sync). Wrapping it in
// std::sync::Mutex gives us Send + Sync, which Tauri's State requires.
// All DB methods are synchronous and release the lock before returning,
// so it is safe to call them from async Tauri commands.

use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use tauri::State;

const SCHEMA_VERSION: i32 = 2;

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

        if version < SCHEMA_VERSION {
            conn.execute_batch(&format!(
                "
                CREATE TABLE IF NOT EXISTS orders (
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

                CREATE TABLE IF NOT EXISTS inventory (
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

                PRAGMA user_version = {};
                ",
                SCHEMA_VERSION
            ))
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
            "SELECT id, item_type, material, width, height, thickness, quantity, notes, created_at, updated_at
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
                notes:      row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        }).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn add_inventory_item(&self, item: &crate::inventory::NewInventoryItem) -> Result<crate::inventory::InventoryItem, String> {
        let conn = self.conn.lock().unwrap();
        let now = now_unix();
        conn.execute(
            "INSERT INTO inventory (item_type, material, width, height, thickness, quantity, notes, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![item.item_type, item.material, item.width, item.height,
                    item.thickness, item.quantity, item.notes, now],
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
             thickness=?5, quantity=?6, notes=?7, updated_at=?8 WHERE id=?9",
            params![item.item_type, item.material, item.width, item.height,
                    item.thickness, item.quantity, item.notes, now_unix(), item.id],
        ).map_err(|e| e.to_string())?;
        if rows == 0 { Err(format!("inventory item {} not found", item.id)) } else { Ok(()) }
    }

    pub fn delete_inventory_item(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM inventory WHERE id = ?1", params![id])
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
