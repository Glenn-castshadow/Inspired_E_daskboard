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

const SCHEMA_VERSION: i32 = 1;

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
