// src-tauri/src/inventory.rs
//
// Material inventory — flat laser sheet goods (plywood, MDF, prepared blanks,
// finished pieces, offcuts). Persistent in either:
//   a) The shared inventory HTTP server (when settings.inventory_server_url is set)
//   b) The local SQLite DB in cache.rs (fallback / offline mode)
//
// When the server URL is configured both machines (Glenn's and Genevieve's)
// read/write the same data. The server runs as a Docker container — initially
// on Glenn's machine, eventually on the Synology NAS.

use serde::{Deserialize, Serialize};
use tauri::State;
use crate::cache::CacheDb;
use crate::settings::AppSettings;

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InventoryItem {
    pub id:         i64,
    /// "sheet" | "blank" | "finished" | "offcut"
    pub item_type:  String,
    /// e.g. "plywood", "raw_mdf", "copper_mdf", "gold_foil_mdf", "custom:..."
    pub material:   String,
    pub width:      f64,   // inches
    pub height:     f64,   // inches
    /// "1/8" | "1/4"
    pub thickness:  String,
    pub quantity:   i32,
    /// SKU from the product catalog — set on blanks and finished pieces.
    /// Empty string means untagged.
    pub sku:        String,
    pub notes:      String,
    /// Landed cost per unit (per sheet/blank/piece), in dollars. 0 = not costed.
    #[serde(default)]
    pub unit_cost:  f64,
    pub created_at: i64,   // unix
    pub updated_at: i64,   // unix
    /// Pool label UUID assigned to this physical piece. None for items
    /// entered manually (pre-tracking) or not yet labelled.
    #[serde(default)]
    pub label_id:   Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct NewInventoryItem {
    pub item_type:  String,
    pub material:   String,
    pub width:      f64,
    pub height:     f64,
    pub thickness:  String,
    pub quantity:   i32,
    pub sku:        String,
    pub notes:      String,
    #[serde(default)]
    pub unit_cost:  f64,
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

pub(crate) async fn http_get<T: serde::de::DeserializeOwned>(
    http: &reqwest::Client,
    url: &str,
    api_key: &str,
) -> Result<T, String> {
    let resp = http.get(url).bearer_auth(api_key).send().await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Server error {}: {}", status, body));
    }
    resp.json().await.map_err(|e| e.to_string())
}

pub(crate) async fn http_post<B: Serialize, T: serde::de::DeserializeOwned>(
    http: &reqwest::Client,
    url: &str,
    api_key: &str,
    body: &B,
) -> Result<T, String> {
    let resp = http.post(url).bearer_auth(api_key).json(body).send().await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let b = resp.text().await.unwrap_or_default();
        return Err(format!("Server error {}: {}", status, b));
    }
    resp.json().await.map_err(|e| e.to_string())
}

pub(crate) async fn http_put<B: Serialize>(
    http: &reqwest::Client,
    url: &str,
    api_key: &str,
    body: &B,
) -> Result<(), String> {
    let resp = http.put(url).bearer_auth(api_key).json(body).send().await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let b = resp.text().await.unwrap_or_default();
        return Err(format!("Server error {}: {}", status, b));
    }
    Ok(())
}

/// PUT and deserialize the response body as JSON — for endpoints that return the updated object.
pub(crate) async fn http_put_json<T: serde::de::DeserializeOwned, B: Serialize>(
    http: &reqwest::Client,
    url: &str,
    api_key: &str,
    body: &B,
) -> Result<T, String> {
    let resp = http.put(url).bearer_auth(api_key).json(body).send().await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let b = resp.text().await.unwrap_or_default();
        return Err(format!("Server error {}: {}", status, b));
    }
    resp.json().await.map_err(|e| e.to_string())
}

pub(crate) async fn http_patch<B: Serialize, T: serde::de::DeserializeOwned>(
    http: &reqwest::Client,
    url: &str,
    api_key: &str,
    body: &B,
) -> Result<T, String> {
    let resp = http.patch(url).bearer_auth(api_key).json(body).send().await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let b = resp.text().await.unwrap_or_default();
        return Err(format!("Server error {}: {}", status, b));
    }
    resp.json().await.map_err(|e| e.to_string())
}

pub(crate) async fn http_delete(
    http: &reqwest::Client,
    url: &str,
    api_key: &str,
) -> Result<(), String> {
    let resp = http.delete(url).bearer_auth(api_key).send().await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let b = resp.text().await.unwrap_or_default();
        return Err(format!("Server error {}: {}", status, b));
    }
    Ok(())
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_inventory(
    cache: State<'_, CacheDb>,
    settings: State<'_, AppSettings>,
    http: State<'_, reqwest::Client>,
) -> Result<Vec<InventoryItem>, String> {
    if let Some(base) = settings.server_url() {
        http_get(&http, &format!("{}/inventory", base), &settings.api_key()).await
    } else {
        cache.get_inventory()
    }
}

#[tauri::command]
pub async fn add_inventory_item(
    item: NewInventoryItem,
    cache: State<'_, CacheDb>,
    settings: State<'_, AppSettings>,
    http: State<'_, reqwest::Client>,
) -> Result<InventoryItem, String> {
    if let Some(base) = settings.server_url() {
        http_post(&http, &format!("{}/inventory", base), &settings.api_key(), &item).await
    } else {
        cache.add_inventory_item(&item)
    }
}

/// Overwrite quantity for a single item (used by the bulk reconcile / direct
/// type-in flow).
#[tauri::command]
pub async fn set_inventory_qty(
    id: i64,
    quantity: i32,
    cache: State<'_, CacheDb>,
    settings: State<'_, AppSettings>,
    http: State<'_, reqwest::Client>,
) -> Result<(), String> {
    if let Some(base) = settings.server_url() {
        http_put(&http, &format!("{}/inventory/{}/qty", base, id), &settings.api_key(), &serde_json::json!({ "quantity": quantity.max(0) })).await
    } else {
        cache.set_inventory_qty(id, quantity.max(0))
    }
}

/// Increment or decrement by `delta` (pass −1 or +1). Quantity floors at 0.
/// Returns the new quantity so the frontend can update without a full reload.
#[tauri::command]
pub async fn adjust_inventory_qty(
    id: i64,
    delta: i32,
    cache: State<'_, CacheDb>,
    settings: State<'_, AppSettings>,
    http: State<'_, reqwest::Client>,
) -> Result<i32, String> {
    if let Some(base) = settings.server_url() {
        #[derive(Deserialize)] struct QtyResp { quantity: i32 }
        let resp: QtyResp = http_patch(&http, &format!("{}/inventory/{}/qty", base, id), &settings.api_key(), &serde_json::json!({ "delta": delta })).await?;
        Ok(resp.quantity)
    } else {
        cache.adjust_inventory_qty(id, delta)
    }
}

/// Update all editable fields of an existing item (used by the edit modal).
#[tauri::command]
pub async fn update_inventory_item(
    item: InventoryItem,
    cache: State<'_, CacheDb>,
    settings: State<'_, AppSettings>,
    http: State<'_, reqwest::Client>,
) -> Result<(), String> {
    if let Some(base) = settings.server_url() {
        http_put(&http, &format!("{}/inventory/{}", base, item.id), &settings.api_key(), &item).await
    } else {
        cache.update_inventory_item(&item)
    }
}

#[tauri::command]
pub async fn delete_inventory_item(
    id: i64,
    cache: State<'_, CacheDb>,
    settings: State<'_, AppSettings>,
    http: State<'_, reqwest::Client>,
) -> Result<(), String> {
    if let Some(base) = settings.server_url() {
        http_delete(&http, &format!("{}/inventory/{}", base, id), &settings.api_key()).await
    } else {
        cache.delete_inventory_item(id)
    }
}
