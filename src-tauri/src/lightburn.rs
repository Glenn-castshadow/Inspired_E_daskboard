// src-tauri/src/lightburn.rs
//
// Lightburn production file library.
//
// One .lbrn2 file per base product (category + design code, no finish).
// Files are stored either in the shared Docker server (when configured) or in
// a local "lightburn" subfolder of the app data directory.
//
// When queuing a job, the file is copied to Desktop\Jobs_to_Cut with the
// Etsy receipt ID prepended: #4821_DBC-RBH_doorbell-chime-round.lbrn2

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{Manager, State};

use crate::cache::CacheDb;
use crate::inventory::{http_get, http_post, http_put_json, http_delete};
use crate::settings::AppSettings;

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LightburnFile {
    pub id:         i64,
    /// e.g. "DBC-RBH"
    pub sku_base:   String,
    /// e.g. "doorbell-chime-round"
    pub short_name: String,
    /// e.g. "DBC-RBH_doorbell-chime-round.lbrn2"
    pub filename:   String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LightburnMapping {
    pub id:                i64,
    pub product_name:      String,
    pub lightburn_file_id: i64,
    pub sku_base:          String,
    pub short_name:        String,
    pub filename:          String,
}

/// Tauri-managed state — holds the local library directory path.
pub struct LightburnState {
    pub lib_dir: PathBuf,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn slugify(s: &str) -> String {
    let raw: String = s
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    raw.split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

async fn http_get_bytes(
    http: &reqwest::Client,
    url: &str,
    api_key: &str,
) -> Result<Vec<u8>, String> {
    let resp = http
        .get(url)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Server error {}: {}", status, body));
    }
    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| e.to_string())
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Read any file from disk and return its contents as a base64 string.
/// Used by the frontend drop zone to hand a native-dragged file to save_lightburn_file.
#[tauri::command]
pub fn read_file_as_base64(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Cannot read {}: {}", path, e))?;
    Ok(STANDARD.encode(&bytes))
}

#[tauri::command]
pub async fn list_lightburn_files(
    cache:    State<'_, CacheDb>,
    settings: State<'_, AppSettings>,
    http:     State<'_, reqwest::Client>,
) -> Result<Vec<LightburnFile>, String> {
    if let Some(base) = settings.server_url() {
        http_get(&http, &format!("{}/lightburn", base), &settings.api_key()).await
    } else {
        cache.get_lightburn_files()
    }
}

#[tauri::command]
pub async fn save_lightburn_file(
    sku_base:    String,
    short_name:  String,
    data_base64: String,
    lb_state:    State<'_, LightburnState>,
    cache:       State<'_, CacheDb>,
    settings:    State<'_, AppSettings>,
    http:        State<'_, reqwest::Client>,
) -> Result<LightburnFile, String> {
    let base = sku_base.to_uppercase().trim().to_string();
    let slug = slugify(&short_name);

    if let Some(server_base) = settings.server_url() {
        let body = serde_json::json!({
            "sku_base":    base,
            "short_name":  short_name.trim(),
            "data_base64": data_base64,
        });
        http_post(&http, &format!("{}/lightburn", server_base), &settings.api_key(), &body).await
    } else {
        let filename = format!("{}_{}.lbrn2", base, slug);
        let file_path = lb_state.lib_dir.join(&filename);
        let bytes = STANDARD.decode(&data_base64).map_err(|e| e.to_string())?;
        std::fs::write(&file_path, &bytes).map_err(|e| e.to_string())?;
        cache.add_lightburn_file(&base, short_name.trim(), &filename)
    }
}

#[tauri::command]
pub async fn delete_lightburn_file(
    id:       i64,
    lb_state: State<'_, LightburnState>,
    cache:    State<'_, CacheDb>,
    settings: State<'_, AppSettings>,
    http:     State<'_, reqwest::Client>,
) -> Result<(), String> {
    if let Some(base) = settings.server_url() {
        http_delete(&http, &format!("{}/lightburn/{}", base, id), &settings.api_key()).await
    } else {
        // Look up filename before deleting so we can remove the file.
        let file = cache.get_lightburn_file(id)?;
        cache.delete_lightburn_file(id)?;
        let _ = std::fs::remove_file(lb_state.lib_dir.join(&file.filename));
        Ok(())
    }
}

/// Copy the .lbrn2 to Desktop\Jobs_to_Cut\#{receipt_id}_{filename}.
/// Returns the destination path as a string.
#[tauri::command]
pub async fn queue_cut_job(
    lightburn_file_id: i64,
    receipt_id:        String,
    app:               tauri::AppHandle,
    lb_state:          State<'_, LightburnState>,
    cache:             State<'_, CacheDb>,
    settings:          State<'_, AppSettings>,
    http:              State<'_, reqwest::Client>,
) -> Result<String, String> {
    let (filename, bytes) = if let Some(base) = settings.server_url() {
        // Get metadata for the filename, then download the binary.
        let meta: LightburnFile =
            http_get(&http, &format!("{}/lightburn/{}", base, lightburn_file_id), &settings.api_key()).await
                .map_err(|_| format!("Could not find Lightburn file {}", lightburn_file_id))?;
        let data = http_get_bytes(
            &http,
            &format!("{}/lightburn/{}/file", base, lightburn_file_id),
            &settings.api_key(),
        ).await?;
        (meta.filename, data)
    } else {
        let file = cache.get_lightburn_file(lightburn_file_id)?;
        let path = lb_state.lib_dir.join(&file.filename);
        let data = std::fs::read(&path)
            .map_err(|_| format!("File not found on disk: {}", file.filename))?;
        (file.filename, data)
    };

    let desktop = app.path().desktop_dir().map_err(|e| e.to_string())?;
    let jobs_dir = desktop.join("Jobs_to_Cut");
    std::fs::create_dir_all(&jobs_dir).map_err(|e| e.to_string())?;

    let dest_name = format!("#{receipt_id}_{filename}");
    let dest_path = jobs_dir.join(&dest_name);
    std::fs::write(&dest_path, bytes).map_err(|e| e.to_string())?;

    Ok(dest_path.to_string_lossy().into_owned())
}

/// Update SKU base and short name for an existing file, renaming the file on disk.
#[tauri::command]
pub async fn update_lightburn_file(
    id:         i64,
    sku_base:   String,
    short_name: String,
    lb_state:   State<'_, LightburnState>,
    cache:      State<'_, CacheDb>,
    settings:   State<'_, AppSettings>,
    http:       State<'_, reqwest::Client>,
) -> Result<LightburnFile, String> {
    let base = sku_base.to_uppercase().trim().to_string();
    let slug = slugify(&short_name);
    let new_filename = format!("{}_{}.lbrn2", base, slug);

    if let Some(server_base) = settings.server_url() {
        // Server-side rename — the PUT route updates DB and renames the file on disk.
        // Requires the container to be rebuilt with the updated routes/lightburn.js.
        let body = serde_json::json!({
            "sku_base":   base,
            "short_name": short_name.trim(),
        });
        http_put_json(&http, &format!("{}/lightburn/{}", server_base, id), &settings.api_key(), &body).await
    } else {
        let old_file = cache.get_lightburn_file(id)?;
        if old_file.filename != new_filename {
            let old_path = lb_state.lib_dir.join(&old_file.filename);
            let new_path = lb_state.lib_dir.join(&new_filename);
            if old_path.exists() {
                std::fs::rename(&old_path, &new_path).map_err(|e| e.to_string())?;
            }
        }
        cache.update_lightburn_file(id, &base, short_name.trim(), &new_filename)
    }
}

/// Export a .lbrn2 file to Desktop\Lightburn_Exports\{filename}.
/// Returns the full destination path.
#[tauri::command]
pub async fn export_lightburn_file(
    lightburn_file_id: i64,
    filename: String,
    app: tauri::AppHandle,
    lb_state: State<'_, LightburnState>,
    cache: State<'_, CacheDb>,
    settings: State<'_, AppSettings>,
    http: State<'_, reqwest::Client>,
) -> Result<String, String> {
    let bytes = if let Some(base) = settings.server_url() {
        http_get_bytes(
            &http,
            &format!("{}/lightburn/{}/file", base, lightburn_file_id),
            &settings.api_key(),
        ).await?
    } else {
        let file = cache.get_lightburn_file(lightburn_file_id)?;
        let path = lb_state.lib_dir.join(&file.filename);
        std::fs::read(&path)
            .map_err(|_| format!("File not found on disk: {}", file.filename))?
    };

    let desktop = app.path().desktop_dir().map_err(|e| e.to_string())?;
    let exports_dir = desktop.join("Lightburn_Exports");
    std::fs::create_dir_all(&exports_dir).map_err(|e| e.to_string())?;

    // Sanitise: strip any path component the caller might have injected.
    let safe_name = PathBuf::from(&filename)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| filename.clone());

    let dest_path = exports_dir.join(&safe_name);
    std::fs::write(&dest_path, bytes).map_err(|e| e.to_string())?;

    Ok(dest_path.to_string_lossy().into_owned())
}

// ── Mapping commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_lightburn_mappings(
    cache:    State<'_, CacheDb>,
    settings: State<'_, AppSettings>,
    http:     State<'_, reqwest::Client>,
) -> Result<Vec<LightburnMapping>, String> {
    if let Some(base) = settings.server_url() {
        http_get(&http, &format!("{}/lightburn/mappings", base), &settings.api_key()).await
    } else {
        cache.get_lightburn_mappings()
    }
}

#[tauri::command]
pub async fn save_lightburn_mapping(
    product_name:      String,
    lightburn_file_id: i64,
    cache:             State<'_, CacheDb>,
    settings:          State<'_, AppSettings>,
    http:              State<'_, reqwest::Client>,
) -> Result<(), String> {
    if let Some(base) = settings.server_url() {
        let body = serde_json::json!({
            "product_name":      product_name.trim(),
            "lightburn_file_id": lightburn_file_id,
        });
        let _: serde_json::Value =
            http_post(&http, &format!("{}/lightburn/mappings", base), &settings.api_key(), &body).await?;
        Ok(())
    } else {
        cache.upsert_lightburn_mapping(product_name.trim(), lightburn_file_id)
    }
}

#[tauri::command]
pub async fn delete_lightburn_mapping(
    id:       i64,
    cache:    State<'_, CacheDb>,
    settings: State<'_, AppSettings>,
    http:     State<'_, reqwest::Client>,
) -> Result<(), String> {
    if let Some(base) = settings.server_url() {
        http_delete(&http, &format!("{}/lightburn/mappings/{}", base, id), &settings.api_key()).await
    } else {
        cache.delete_lightburn_mapping(id)
    }
}
