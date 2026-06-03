// src-tauri/src/catalog.rs
//
// Product catalog — maps SKUs to product definitions.
// A SKU encodes the product category, design, optional size, and finish:
//   [CATEGORY]-[DESIGN]-[SIZE*]-[FINISH]
//   e.g. DBC-RBH-SM-CU  →  Door Bell Cover, Robie House, Small, Copper
//
// The catalog table lives in the same SQLite DB as inventory (schema v3+).
// Products are soft-deleted (active = 0) so SKU history is preserved.

use serde::{Deserialize, Serialize};
use tauri::State;
use crate::cache::CacheDb;

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Product {
    pub id:         i64,
    /// Unique SKU — e.g. "DBC-RBH-SM-CU"
    pub sku:        String,
    /// Human-readable product name
    pub name:       String,
    /// Category code — e.g. "DBC"
    pub category:   String,
    /// Design code — e.g. "RBH"
    pub design:     String,
    /// Finish code — e.g. "CU"
    pub finish:     String,
    /// Blank width needed (inches)
    pub width:      f64,
    /// Blank height needed (inches)
    pub height:     f64,
    /// "1/8" | "1/4"
    pub thickness:  String,
    /// Default material — e.g. "copper_mdf"
    pub material:   String,
    pub notes:      String,
    pub active:     bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
pub struct NewProduct {
    pub sku:       String,
    pub name:      String,
    pub category:  String,
    pub design:    String,
    pub finish:    String,
    pub width:     f64,
    pub height:    f64,
    pub thickness: String,
    pub material:  String,
    pub notes:     String,
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Return all active products ordered by category, then SKU.
#[tauri::command]
pub fn get_products(cache: State<'_, CacheDb>) -> Result<Vec<Product>, String> {
    cache.get_products()
}

/// Create a new product. Returns the saved row with its assigned id.
#[tauri::command]
pub fn add_product(
    product: NewProduct,
    cache: State<'_, CacheDb>,
) -> Result<Product, String> {
    cache.add_product(&product)
}

/// Update all editable fields of an existing product.
#[tauri::command]
pub fn update_product(
    product: Product,
    cache: State<'_, CacheDb>,
) -> Result<(), String> {
    cache.update_product(&product)
}

/// Soft-delete a product (sets active = 0). SKU history is preserved.
#[tauri::command]
pub fn delete_product(
    id: i64,
    cache: State<'_, CacheDb>,
) -> Result<(), String> {
    cache.delete_product(id)
}
