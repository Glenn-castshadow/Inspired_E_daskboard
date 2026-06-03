// src-tauri/src/settings.rs
//
// Persistent app settings stored as JSON in the app data directory.
// Currently holds the inventory server URL and API key so both the
// primary machine (Glenn) and the client machine (Genevieve) can
// connect to the shared inventory server.
//
// When inventory_server_url is None (or empty), the app falls back to
// the local SQLite DB in cache.rs — so the app works offline or
// before the server has been configured.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct Settings {
    /// Full base URL of the inventory server, e.g. "http://192.168.1.10:3456"
    /// or "http://synology.local:3456". Empty / None = use local SQLite.
    pub inventory_server_url: Option<String>,
    /// Shared API key — must match API_KEY env var on the server.
    pub inventory_api_key: Option<String>,
}

pub struct AppSettings {
    inner: Mutex<Settings>,
    path: PathBuf,
}

impl AppSettings {
    /// Load settings from disk, defaulting to empty if the file doesn't exist.
    pub fn load(data_dir: &Path) -> Self {
        let path = data_dir.join("settings.json");
        let inner = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
            .unwrap_or_default();
        Self { inner: Mutex::new(inner), path }
    }

    /// Returns the configured server base URL, or None if not set.
    pub fn server_url(&self) -> Option<String> {
        self.inner.lock().unwrap()
            .inventory_server_url.clone()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim_end_matches('/').to_string())
    }

    /// Returns the configured API key, empty string if not set.
    pub fn api_key(&self) -> String {
        self.inner.lock().unwrap()
            .inventory_api_key.clone()
            .unwrap_or_default()
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_settings(settings: State<'_, AppSettings>) -> Settings {
    settings.inner.lock().unwrap().clone()
}

#[tauri::command]
pub fn save_settings(
    new_settings: Settings,
    settings: State<'_, AppSettings>,
) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&new_settings).map_err(|e| e.to_string())?;
    std::fs::write(&settings.path, &json).map_err(|e| e.to_string())?;
    let mut guard = settings.inner.lock().unwrap();
    *guard = new_settings;
    Ok(())
}

/// Quick connectivity test — hits /health on the server (no auth required).
/// Returns the server's version string on success, or an error message.
#[tauri::command]
pub async fn test_inventory_connection(
    url: String,
    api_key: String,
    http: State<'_, reqwest::Client>,
) -> Result<String, String> {
    let base = url.trim_end_matches('/');
    let resp = http
        .get(format!("{}/health", base))
        .bearer_auth(&api_key)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    if resp.status().is_success() {
        let body: serde_json::Value = resp.json().await.unwrap_or_default();
        Ok(format!(
            "Connected — {}",
            body["version"].as_str().unwrap_or("ok")
        ))
    } else {
        Err(format!("Server returned HTTP {}", resp.status()))
    }
}
