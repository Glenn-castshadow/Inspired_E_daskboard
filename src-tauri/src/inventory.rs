// src-tauri/src/inventory.rs
//
// Material inventory — flat laser sheet goods (plywood, MDF, prepared blanks,
// offcuts). Persistent in the same SQLite DB as orders (cache.rs owns the
// schema and low-level methods; this file owns the types and Tauri commands).

use serde::{Deserialize, Serialize};
use tauri::State;
use crate::cache::CacheDb;

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InventoryItem {
    pub id:         i64,
    /// "sheet" | "blank" | "offcut"
    pub item_type:  String,
    /// e.g. "plywood", "raw_mdf", "copper_mdf", "gold_foil_mdf", "custom:..."
    pub material:   String,
    pub width:      f64,   // inches
    pub height:     f64,   // inches
    /// "1/8" | "1/4"
    pub thickness:  String,
    pub quantity:   i32,
    pub notes:      String,
    pub created_at: i64,   // unix
    pub updated_at: i64,   // unix
}

#[derive(Debug, Deserialize)]
pub struct NewInventoryItem {
    pub item_type:  String,
    pub material:   String,
    pub width:      f64,
    pub height:     f64,
    pub thickness:  String,
    pub quantity:   i32,
    pub notes:      String,
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_inventory(cache: State<'_, CacheDb>) -> Result<Vec<InventoryItem>, String> {
    cache.get_inventory()
}

#[tauri::command]
pub fn add_inventory_item(
    item: NewInventoryItem,
    cache: State<'_, CacheDb>,
) -> Result<InventoryItem, String> {
    cache.add_inventory_item(&item)
}

/// Overwrite quantity for a single item (used by the bulk reconcile / direct
/// type-in flow).
#[tauri::command]
pub fn set_inventory_qty(
    id: i64,
    quantity: i32,
    cache: State<'_, CacheDb>,
) -> Result<(), String> {
    cache.set_inventory_qty(id, quantity.max(0))
}

/// Increment or decrement by `delta` (pass −1 or +1). Quantity floors at 0.
/// Returns the new quantity so the frontend can update without a full reload.
#[tauri::command]
pub fn adjust_inventory_qty(
    id: i64,
    delta: i32,
    cache: State<'_, CacheDb>,
) -> Result<i32, String> {
    cache.adjust_inventory_qty(id, delta)
}

/// Update all editable fields of an existing item (used by the edit modal).
#[tauri::command]
pub fn update_inventory_item(
    item: InventoryItem,
    cache: State<'_, CacheDb>,
) -> Result<(), String> {
    cache.update_inventory_item(&item)
}

#[tauri::command]
pub fn delete_inventory_item(
    id: i64,
    cache: State<'_, CacheDb>,
) -> Result<(), String> {
    cache.delete_inventory_item(id)
}
