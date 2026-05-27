// src-tauri/src/usps.rs
//
// USPS Tracking 3.2 API integration. Replaces the EasyPost integration.
//
// Auth: OAuth 2.0 client credentials grant
//   POST https://apis.usps.com/oauth2/v3/token
//   Body: { client_id, client_secret, grant_type: "client_credentials" }
//   Returns: access_token (Bearer), expires_in (seconds)
//
// Tracking: GET https://apis.usps.com/tracking/v3/tracking/{trackingNumber}?expand=DETAIL
//   Header: Authorization: Bearer {access_token}
//
// Frontend keeps calling get_tracking / refresh_tracking / refresh_all_tracking /
// clear_tracking_cache — same shape as before. Only set-credentials command name
// changed (set_easypost_api_key → set_usps_credentials).

use crate::cache::CacheDb;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;
use tokio::sync::Mutex;

const KEYRING_SERVICE: &str = "etsy_dashboard";
const USPS_OAUTH_URL: &str = "https://apis.usps.com/oauth2/v3/token";
const USPS_TRACKING_BASE: &str = "https://apis.usps.com/tracking/v3/tracking";

// ── Public types (identical shape to the previous EasyPost types) ────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TrackingInfo {
    pub tracking_number: String,
    pub status: TrackingStatus,
    pub status_label: String,
    pub carrier: String,
    pub est_delivery_date: Option<String>,
    pub last_update: Option<String>,
    pub last_location: Option<String>,
    pub last_message: Option<String>,
    pub scan_count: usize,
    pub events: Vec<TrackingEvent>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TrackingEvent {
    pub message: String,
    pub datetime: String,
    pub location: Option<String>,
}

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

// ── State ─────────────────────────────────────────────────────────────────────

pub struct UspsState {
    pub client: Client,
    pub client_id: Mutex<Option<String>>,
    pub client_secret: Mutex<Option<String>>,
    pub token: Mutex<Option<UspsToken>>,
    pub cache: Mutex<HashMap<String, TrackingInfo>>,
}

#[derive(Clone)]
pub struct UspsToken {
    pub access_token: String,
    pub expires_at: i64,
}

impl UspsState {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            client_id: Mutex::new(None),
            client_secret: Mutex::new(None),
            token: Mutex::new(None),
            cache: Mutex::new(HashMap::new()),
        }
    }
}

// ── Keyring helpers ───────────────────────────────────────────────────────────

fn keyring_get(username: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, username)
        .and_then(|e| e.get_password())
        .ok()
}

fn keyring_set(username: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(KEYRING_SERVICE, username)
        .map_err(|e| e.to_string())?
        .set_password(value)
        .map_err(|e| e.to_string())
}

fn now_unix() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

// ── Credentials resolution ────────────────────────────────────────────────────

async fn resolve_credentials(state: &UspsState) -> Result<(String, String), String> {
    {
        let cid = state.client_id.lock().await;
        let cs  = state.client_secret.lock().await;
        if let (Some(id), Some(secret)) = (cid.as_ref(), cs.as_ref()) {
            return Ok((id.clone(), secret.clone()));
        }
    }
    let id = keyring_get("usps_client_id")
        .ok_or_else(|| "USPS client_id not configured. Call set_usps_credentials first.".to_string())?;
    let secret = keyring_get("usps_client_secret")
        .ok_or_else(|| "USPS client_secret not configured. Call set_usps_credentials first.".to_string())?;
    *state.client_id.lock().await = Some(id.clone());
    *state.client_secret.lock().await = Some(secret.clone());
    Ok((id, secret))
}

// ── OAuth token management ────────────────────────────────────────────────────

#[derive(Deserialize)]
struct UspsOAuthResponse {
    access_token: String,
    #[serde(default)]
    expires_in: Option<u64>,
}

async fn fetch_token(state: &UspsState) -> Result<String, String> {
    let (client_id, client_secret) = resolve_credentials(state).await?;
    let body = serde_json::json!({
        "client_id": client_id,
        "client_secret": client_secret,
        "grant_type": "client_credentials",
    });
    let resp = state.client.post(USPS_OAUTH_URL)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send().await
        .map_err(|e| format!("USPS OAuth request failed: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("USPS OAuth HTTP {}: {}", status, body));
    }
    let t: UspsOAuthResponse = resp.json().await
        .map_err(|e| format!("Could not parse USPS OAuth response: {}", e))?;
    let expires_at = now_unix() + t.expires_in.unwrap_or(1800) as i64;
    *state.token.lock().await = Some(UspsToken {
        access_token: t.access_token.clone(),
        expires_at,
    });
    Ok(t.access_token)
}

async fn get_valid_token(state: &UspsState) -> Result<String, String> {
    {
        let lock = state.token.lock().await;
        if let Some(t) = &*lock {
            // Refresh if expiring within 60 seconds
            if t.expires_at - now_unix() > 60 {
                return Ok(t.access_token.clone());
            }
        }
    }
    fetch_token(state).await
}

// ── Tracking API response types (defensive — fields all Optional) ────────────

#[derive(Deserialize)]
struct UspsTrackingResponse {
    #[serde(default)]
    tracking_number: Option<String>,
    #[serde(default, alias = "trackingNumber")]
    tracking_number_camel: Option<String>,
    #[serde(default)]
    status_category: Option<String>,
    #[serde(default, alias = "statusCategory")]
    status_category_camel: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    expected_delivery_date: Option<String>,
    #[serde(default, alias = "expectedDeliveryDate")]
    expected_delivery_date_camel: Option<String>,
    #[serde(default)]
    tracking_events: Vec<UspsTrackingEvent>,
    #[serde(default, alias = "trackingEvents")]
    tracking_events_camel: Vec<UspsTrackingEvent>,
}

#[derive(Deserialize)]
struct UspsTrackingEvent {
    #[serde(default)]
    event_timestamp: Option<String>,
    #[serde(default, alias = "eventTimestamp")]
    event_timestamp_camel: Option<String>,
    #[serde(default)]
    event_description: Option<String>,
    #[serde(default, alias = "eventDescription")]
    event_description_camel: Option<String>,
    #[serde(default)]
    event_city: Option<String>,
    #[serde(default, alias = "eventCity")]
    event_city_camel: Option<String>,
    #[serde(default)]
    event_state: Option<String>,
    #[serde(default, alias = "eventState")]
    event_state_camel: Option<String>,
}

// ── Normalize ─────────────────────────────────────────────────────────────────

fn map_status(category: Option<&str>, status_text: Option<&str>) -> (TrackingStatus, String) {
    let cat = category.unwrap_or("").to_ascii_uppercase();
    if cat.contains("DELIVER") && !cat.contains("OUT") { return (TrackingStatus::Delivered, "Delivered".into()); }
    if cat.contains("OUT_FOR_DELIVERY") || cat.contains("OUT FOR DELIVERY") { return (TrackingStatus::OutForDelivery, "Out for delivery".into()); }
    if cat.contains("IN_TRANSIT") || cat == "IN TRANSIT" { return (TrackingStatus::InTransit, "In transit".into()); }
    if cat.contains("PRE_SHIPMENT") || cat.contains("ACCEPTED") || cat.contains("PRE-SHIPMENT") { return (TrackingStatus::PreTransit, "Pre-shipment".into()); }
    if cat.contains("RETURN") { return (TrackingStatus::ReturnToSender, "Return to sender".into()); }
    if cat.contains("FAIL") || cat.contains("EXCEPTION") || cat.contains("UNDELIVER") { return (TrackingStatus::Failure, "Delivery exception".into()); }
    // Fall back to parsing the human-readable status text
    let s = status_text.unwrap_or("").to_ascii_lowercase();
    if s.contains("delivered") { return (TrackingStatus::Delivered, "Delivered".into()); }
    if s.contains("out for delivery") { return (TrackingStatus::OutForDelivery, "Out for delivery".into()); }
    if s.contains("in transit") || s.contains("departed") || s.contains("arrived") || s.contains("accepted") { return (TrackingStatus::InTransit, "In transit".into()); }
    if s.contains("pre-shipment") || s.contains("label created") { return (TrackingStatus::PreTransit, "Pre-shipment".into()); }
    if s.contains("return") { return (TrackingStatus::ReturnToSender, "Return to sender".into()); }
    if s.contains("undeliver") || s.contains("exception") { return (TrackingStatus::Failure, "Delivery exception".into()); }
    (TrackingStatus::Unknown, status_text.unwrap_or("Unknown").to_string())
}

fn normalize(raw: UspsTrackingResponse, tracking_number: String) -> TrackingInfo {
    let category = raw.status_category.clone().or(raw.status_category_camel.clone());
    let status_text = raw.status.clone();
    let (status, status_label) = map_status(category.as_deref(), status_text.as_deref());

    let est_delivery_date = raw.expected_delivery_date.or(raw.expected_delivery_date_camel);

    // Merge both event field shapes
    let mut raw_events = raw.tracking_events;
    raw_events.extend(raw.tracking_events_camel);

    let events: Vec<TrackingEvent> = raw_events
        .into_iter()
        .map(|ev| {
            let msg = ev.event_description.or(ev.event_description_camel).unwrap_or_default();
            let dt = ev.event_timestamp.or(ev.event_timestamp_camel).unwrap_or_default();
            let city = ev.event_city.or(ev.event_city_camel);
            let state_ = ev.event_state.or(ev.event_state_camel);
            let location = match (city.as_deref(), state_.as_deref()) {
                (Some(c), Some(s)) if !c.is_empty() && !s.is_empty() => Some(format!("{}, {}", c, s)),
                (Some(c), _) if !c.is_empty() => Some(c.to_string()),
                _ => None,
            };
            TrackingEvent { message: msg, datetime: dt, location }
        })
        .filter(|e| !e.message.is_empty() || !e.datetime.is_empty())
        .collect();

    let scan_count = events.len();
    let last_update = events.first().map(|e| e.datetime.clone()).filter(|s| !s.is_empty());
    let last_location = events.first().and_then(|e| e.location.clone());
    let last_message = events.first().map(|e| e.message.clone()).filter(|s| !s.is_empty());

    TrackingInfo {
        tracking_number,
        status,
        status_label,
        carrier: "USPS".to_string(),
        est_delivery_date,
        last_update,
        last_location,
        last_message,
        scan_count,
        events,
    }
}

// ── HTTP fetch ────────────────────────────────────────────────────────────────

async fn fetch_tracking_from_usps(
    state: &UspsState,
    tracking_number: &str,
) -> Result<TrackingInfo, TrackingError> {
    let token = get_valid_token(state).await.map_err(|m| TrackingError {
        code: "USPS_AUTH_FAILED".into(),
        message: m,
    })?;
    let url = format!("{}/{}?expand=DETAIL", USPS_TRACKING_BASE, tracking_number);
    let resp = state.client.get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/json")
        .send().await
        .map_err(|e| TrackingError { code: "USPS_REQUEST_FAILED".into(), message: e.to_string() })?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(TrackingError {
            code: format!("USPS_HTTP_{}", status),
            message: body,
        });
    }

    let raw: UspsTrackingResponse = resp.json().await
        .map_err(|e| TrackingError { code: "USPS_PARSE_FAILED".into(), message: e.to_string() })?;
    Ok(normalize(raw, tracking_number.to_string()))
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Store USPS API client_id + client_secret (from developers.usps.com → your app).
#[tauri::command]
pub async fn set_usps_credentials(
    client_id: String,
    client_secret: String,
    state: State<'_, UspsState>,
) -> Result<(), String> {
    keyring_set("usps_client_id", &client_id)?;
    keyring_set("usps_client_secret", &client_secret)?;
    *state.client_id.lock().await = Some(client_id);
    *state.client_secret.lock().await = Some(client_secret);
    *state.token.lock().await = None; // force fresh token on next call
    Ok(())
}

/// Fetch tracking for a single shipment. Hits in-memory → SQLite cache → USPS API.
#[tauri::command]
pub async fn get_tracking(
    tracking_number: String,
    state: State<'_, UspsState>,
    db: State<'_, CacheDb>,
) -> Result<TrackingInfo, TrackingError> {
    const TRACKING_CACHE_MAX_AGE: i64 = 15 * 60; // 15 minutes

    // 1. In-memory
    {
        let mem = state.cache.lock().await;
        if let Some(info) = mem.get(&tracking_number) {
            return Ok(info.clone());
        }
    }

    // 2. SQLite
    if let Some((fetched_at, json)) = db.get_tracking(&tracking_number) {
        if crate::cache::now_unix() - fetched_at < TRACKING_CACHE_MAX_AGE {
            if let Ok(info) = serde_json::from_str::<TrackingInfo>(&json) {
                state.cache.lock().await.insert(tracking_number, info.clone());
                return Ok(info);
            }
        }
    }

    // 3. USPS API
    let info = fetch_tracking_from_usps(&state, &tracking_number).await?;
    if let Ok(json) = serde_json::to_string(&info) {
        let _ = db.upsert_tracking(&tracking_number, &json);
    }
    state.cache.lock().await.insert(tracking_number, info.clone());

    Ok(info)
}

/// Force-refresh a single tracking number, bypassing both caches.
#[tauri::command]
pub async fn refresh_tracking(
    tracking_number: String,
    state: State<'_, UspsState>,
    db: State<'_, CacheDb>,
) -> Result<TrackingInfo, TrackingError> {
    let info = fetch_tracking_from_usps(&state, &tracking_number).await?;
    if let Ok(json) = serde_json::to_string(&info) {
        let _ = db.upsert_tracking(&tracking_number, &json);
    }
    state.cache.lock().await.insert(tracking_number.clone(), info.clone());
    Ok(info)
}

#[derive(Serialize)]
pub struct TrackingOutcome {
    pub ok: Option<TrackingInfo>,
    pub error: Option<TrackingError>,
}

/// Refresh many tracking numbers in parallel. Used after manual refresh.
#[tauri::command]
pub async fn refresh_all_tracking(
    tracking_numbers: Vec<String>,
    state: State<'_, UspsState>,
    db: State<'_, CacheDb>,
) -> Result<HashMap<String, TrackingOutcome>, String> {
    let mut out: HashMap<String, TrackingOutcome> = HashMap::new();
    // USPS doesn't publish a hard QPS limit for this API but we throttle anyway
    for (i, tn) in tracking_numbers.iter().enumerate() {
        if i > 0 {
            tokio::time::sleep(tokio::time::Duration::from_millis(150)).await;
        }
        match fetch_tracking_from_usps(&state, tn).await {
            Ok(info) => {
                if let Ok(json) = serde_json::to_string(&info) {
                    let _ = db.upsert_tracking(tn, &json);
                }
                state.cache.lock().await.insert(tn.clone(), info.clone());
                out.insert(tn.clone(), TrackingOutcome { ok: Some(info), error: None });
            }
            Err(e) => {
                out.insert(tn.clone(), TrackingOutcome { ok: None, error: Some(e) });
            }
        }
    }
    Ok(out)
}

/// Clear the in-memory tracking cache (SQLite cache survives).
#[tauri::command]
pub async fn clear_tracking_cache(state: State<'_, UspsState>) -> Result<(), String> {
    state.cache.lock().await.clear();
    Ok(())
}
