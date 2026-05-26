// src-tauri/src/easypost.rs
//
// EasyPost tracking module
// Handles all USPS package tracking via EasyPost API v2
//
// Setup:
//   1. Sign up at easypost.com and get your TEST and PRODUCTION API keys
//   2. Store your production key via:
//        keyring::set_password("etsy_dashboard", "easypost_api_key", "your_key_here")
//      or set env var EASYPOST_API_KEY for development
//   3. Register this module in main.rs and add commands to tauri builder

use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;
use tokio::sync::Mutex;

// ── API base ──────────────────────────────────────────────────────────────────

const EASYPOST_BASE: &str = "https://api.easypost.com/v2";

// ── State ─────────────────────────────────────────────────────────────────────

pub struct EasyPostState {
    pub client: Client,
    pub api_key: Mutex<Option<String>>,
    /// In-memory cache: tracking_number -> TrackingInfo
    pub cache: Mutex<HashMap<String, TrackingInfo>>,
}

impl EasyPostState {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            api_key: Mutex::new(None),
            cache: Mutex::new(HashMap::new()),
        }
    }
}

// ── EasyPost API types ────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Clone)]
pub struct EasyPostTracker {
    pub id: String,
    pub tracking_code: String,
    pub status: String, // "pre_transit" | "in_transit" | "out_for_delivery" | "delivered" | "return_to_sender" | "failure" | "unknown"
    pub status_detail: Option<String>,
    pub carrier: Option<String>,
    pub est_delivery_date: Option<String>, // ISO 8601
    pub tracking_details: Vec<TrackingDetail>,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
pub struct TrackingDetail {
    pub object: Option<String>,
    pub message: String,
    pub status: String,
    pub datetime: String, // ISO 8601
    pub source: Option<String>,
    pub tracking_location: Option<TrackingLocation>,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
pub struct TrackingLocation {
    pub city: Option<String>,
    pub state: Option<String>,
    pub country: Option<String>,
    pub zip: Option<String>,
}

// ── Our normalized type (what the frontend receives) ─────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct TrackingInfo {
    pub tracking_number: String,
    pub status: TrackingStatus,
    pub status_label: String,
    pub carrier: String,
    pub est_delivery_date: Option<String>,
    pub last_update: Option<String>,   // datetime of most recent scan
    pub last_location: Option<String>, // "City, ST" of most recent scan
    pub last_message: Option<String>,  // most recent event message
    pub scan_count: usize,
    pub events: Vec<TrackingEvent>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TrackingStatus {
    PreTransit,
    InTransit,
    OutForDelivery,
    Delivered,
    ReturnToSender,
    Failure,
    Unknown,
}

#[derive(Debug, Serialize, Clone)]
pub struct TrackingEvent {
    pub message: String,
    pub datetime: String,
    pub location: Option<String>,
}

// ── Error type ────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct TrackingError {
    pub code: String,
    pub message: String,
}

impl std::fmt::Display for TrackingError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

// ── Batch result wrapper ──────────────────────────────────────────────────────

/// Serializable per-item result for refresh_all_tracking.
/// Result<T,E> doesn't implement Serialize, so we use explicit ok/error fields.
#[derive(Debug, Serialize)]
pub struct TrackingOutcome {
    pub ok: Option<TrackingInfo>,
    pub error: Option<String>,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn parse_status(s: &str) -> TrackingStatus {
    match s {
        "pre_transit" => TrackingStatus::PreTransit,
        "in_transit" => TrackingStatus::InTransit,
        "out_for_delivery" => TrackingStatus::OutForDelivery,
        "delivered" => TrackingStatus::Delivered,
        "return_to_sender" => TrackingStatus::ReturnToSender,
        "failure" => TrackingStatus::Failure,
        _ => TrackingStatus::Unknown,
    }
}

fn status_label(status: &TrackingStatus) -> String {
    match status {
        TrackingStatus::PreTransit => "Label Created".to_string(),
        TrackingStatus::InTransit => "In Transit".to_string(),
        TrackingStatus::OutForDelivery => "Out for Delivery".to_string(),
        TrackingStatus::Delivered => "Delivered".to_string(),
        TrackingStatus::ReturnToSender => "Return to Sender".to_string(),
        TrackingStatus::Failure => "Delivery Failed".to_string(),
        TrackingStatus::Unknown => "Unknown".to_string(),
    }
}

fn format_location(loc: &TrackingLocation) -> Option<String> {
    match (&loc.city, &loc.state) {
        (Some(city), Some(state)) => Some(format!("{}, {}", city, state)),
        (Some(city), None) => Some(city.clone()),
        _ => None,
    }
}

fn normalize(tracker: EasyPostTracker) -> TrackingInfo {
    let status = parse_status(&tracker.status);
    let label = status_label(&status);

    // most recent event first — tracker is moved in, no clone needed
    let mut details = tracker.tracking_details;
    details.sort_by(|a, b| b.datetime.cmp(&a.datetime));

    let last = details.first();
    let last_update = last.map(|d| d.datetime.clone());
    let last_message = last.map(|d| d.message.clone());
    let last_location = last
        .and_then(|d| d.tracking_location.as_ref())
        .and_then(|l| format_location(l));

    let events: Vec<TrackingEvent> = details
        .iter()
        .map(|d| TrackingEvent {
            message: d.message.clone(),
            datetime: d.datetime.clone(),
            location: d.tracking_location.as_ref().and_then(|l| format_location(l)),
        })
        .collect();

    TrackingInfo {
        tracking_number: tracker.tracking_code,
        status,
        status_label: label,
        carrier: tracker.carrier.unwrap_or_else(|| "USPS".to_string()),
        est_delivery_date: tracker.est_delivery_date,
        last_update,
        last_location,
        last_message,
        scan_count: events.len(),
        events,
    }
}

/// Resolve API key: check keyring first, fall back to env var (dev)
async fn resolve_api_key(state: &EasyPostState) -> Result<String, TrackingError> {
    {
        let lock = state.api_key.lock().await;
        if let Some(key) = &*lock {
            return Ok(key.clone());
        }
    }

    if let Ok(key) = keyring::Entry::new("etsy_dashboard", "easypost_api_key")
        .and_then(|e| e.get_password())
    {
        let mut lock = state.api_key.lock().await;
        *lock = Some(key.clone());
        return Ok(key);
    }

    if let Ok(key) = std::env::var("EASYPOST_API_KEY") {
        let mut lock = state.api_key.lock().await;
        *lock = Some(key.clone());
        return Ok(key);
    }

    Err(TrackingError {
        code: "NO_API_KEY".to_string(),
        message: "EasyPost API key not found. Set via keyring or EASYPOST_API_KEY env var."
            .to_string(),
    })
}

// ── Core fetch ────────────────────────────────────────────────────────────────

async fn fetch_tracker(
    client: &Client,
    api_key: &str,
    tracking_number: &str,
) -> Result<EasyPostTracker, TrackingError> {
    let url = format!("{}/trackers", EASYPOST_BASE);

    // Create a tracker (idempotent — EasyPost returns existing if already created)
    let body = serde_json::json!({
        "tracker": {
            "tracking_code": tracking_number,
            "carrier": "USPS"
        }
    });

    let resp = client
        .post(&url)
        .basic_auth(api_key, Some(""))
        .json(&body)
        .send()
        .await
        .map_err(|e| TrackingError {
            code: "NETWORK_ERROR".to_string(),
            message: e.to_string(),
        })?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(TrackingError {
            code: format!("HTTP_{}", status),
            message: text,
        });
    }

    resp.json::<EasyPostTracker>().await.map_err(|e| TrackingError {
        code: "PARSE_ERROR".to_string(),
        message: e.to_string(),
    })
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Track a single package. Uses in-memory cache — call refresh_tracking to force a fresh fetch.
#[tauri::command]
pub async fn get_tracking(
    tracking_number: String,
    state: State<'_, EasyPostState>,
) -> Result<TrackingInfo, TrackingError> {
    {
        let cache = state.cache.lock().await;
        if let Some(info) = cache.get(&tracking_number) {
            return Ok(info.clone());
        }
    }

    let api_key = resolve_api_key(&state).await?;
    let tracker = fetch_tracker(&state.client, &api_key, &tracking_number).await?;
    let info = normalize(tracker);

    {
        let mut cache = state.cache.lock().await;
        cache.insert(tracking_number, info.clone());
    }

    Ok(info)
}

/// Force-refresh a single tracking number, bypassing cache.
#[tauri::command]
pub async fn refresh_tracking(
    tracking_number: String,
    state: State<'_, EasyPostState>,
) -> Result<TrackingInfo, TrackingError> {
    let api_key = resolve_api_key(&state).await?;
    let tracker = fetch_tracker(&state.client, &api_key, &tracking_number).await?;
    let info = normalize(tracker);

    let mut cache = state.cache.lock().await;
    cache.insert(tracking_number, info.clone());

    Ok(info)
}

/// Batch-refresh a list of tracking numbers (e.g. all shipped orders).
/// Returns a map of tracking_number -> TrackingOutcome.
#[tauri::command]
pub async fn refresh_all_tracking(
    tracking_numbers: Vec<String>,
    state: State<'_, EasyPostState>,
) -> Result<HashMap<String, TrackingOutcome>, String> {
    let api_key = resolve_api_key(&state).await.map_err(|e| e.message)?;
    let mut results = HashMap::new();

    for tn in tracking_numbers {
        // Small delay to stay comfortably under rate limits
        tokio::time::sleep(tokio::time::Duration::from_millis(120)).await;

        let outcome = match fetch_tracker(&state.client, &api_key, &tn).await {
            Ok(tracker) => {
                let info = normalize(tracker);
                let mut cache = state.cache.lock().await;
                cache.insert(tn.clone(), info.clone());
                TrackingOutcome { ok: Some(info), error: None }
            }
            Err(e) => TrackingOutcome { ok: None, error: Some(e.message) },
        };
        results.insert(tn, outcome);
    }

    Ok(results)
}

/// Store the EasyPost API key securely in the OS keyring.
#[tauri::command]
pub async fn set_easypost_api_key(
    api_key: String,
    state: State<'_, EasyPostState>,
) -> Result<(), String> {
    keyring::Entry::new("etsy_dashboard", "easypost_api_key")
        .map_err(|e| e.to_string())?
        .set_password(&api_key)
        .map_err(|e| e.to_string())?;

    let mut lock = state.api_key.lock().await;
    *lock = Some(api_key);

    Ok(())
}

/// Clear the in-memory tracking cache (e.g. on manual refresh).
#[tauri::command]
pub async fn clear_tracking_cache(state: State<'_, EasyPostState>) -> Result<(), String> {
    let mut cache = state.cache.lock().await;
    cache.clear();
    Ok(())
}
