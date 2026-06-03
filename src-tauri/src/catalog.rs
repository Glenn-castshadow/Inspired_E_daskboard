// src-tauri/src/catalog.rs
//
// Product catalog — maps SKUs to product definitions.
// Reads/writes go to the shared inventory HTTP server when configured,
// or fall back to the local SQLite DB otherwise.

use serde::{Deserialize, Serialize};
use tauri::State;
use crate::cache::CacheDb;
use crate::settings::AppSettings;
use crate::inventory::{http_get, http_post, http_put, http_delete};

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Product {
    pub id:         i64,
    pub sku:        String,
    pub name:       String,
    pub category:   String,
    pub design:     String,
    pub finish:     String,
    pub width:      f64,
    pub height:     f64,
    pub thickness:  String,
    pub material:   String,
    pub notes:      String,
    pub active:     bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize, Serialize)]
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

#[tauri::command]
pub async fn get_products(
    cache: State<'_, CacheDb>,
    settings: State<'_, AppSettings>,
    http: State<'_, reqwest::Client>,
) -> Result<Vec<Product>, String> {
    if let Some(base) = settings.server_url() {
        http_get(&http, &format!("{}/products", base), &settings.api_key()).await
    } else {
        cache.get_products()
    }
}

#[tauri::command]
pub async fn add_product(
    product: NewProduct,
    cache: State<'_, CacheDb>,
    settings: State<'_, AppSettings>,
    http: State<'_, reqwest::Client>,
) -> Result<Product, String> {
    if let Some(base) = settings.server_url() {
        http_post(&http, &format!("{}/products", base), &settings.api_key(), &product).await
    } else {
        cache.add_product(&product)
    }
}

#[tauri::command]
pub async fn update_product(
    product: Product,
    cache: State<'_, CacheDb>,
    settings: State<'_, AppSettings>,
    http: State<'_, reqwest::Client>,
) -> Result<(), String> {
    if let Some(base) = settings.server_url() {
        http_put(&http, &format!("{}/products/{}", base, product.id), &settings.api_key(), &product).await
    } else {
        cache.update_product(&product)
    }
}

#[tauri::command]
pub async fn delete_product(
    id: i64,
    cache: State<'_, CacheDb>,
    settings: State<'_, AppSettings>,
    http: State<'_, reqwest::Client>,
) -> Result<(), String> {
    if let Some(base) = settings.server_url() {
        http_delete(&http, &format!("{}/products/{}", base, id), &settings.api_key()).await
    } else {
        cache.delete_product(id)
    }
}
