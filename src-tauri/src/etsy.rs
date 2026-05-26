// src-tauri/src/etsy.rs
//
// Etsy OAuth 2.0 + PKCE token management and order fetch.
//
// Setup:
//   1. Create an Etsy app at etsy.com/developers and copy the Keystring (API key)
//   2. Set the redirect URI in your Etsy app to: http://127.0.0.1:*/callback
//      (Etsy allows wildcard port in redirect URIs for desktop apps)
//   3. Call set_etsy_api_key("your_keystring") once from the settings UI
//   4. Call etsy_connect(shop_id) for each shop — opens browser for OAuth

use crate::cache::CacheDb;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

// ── Constants ─────────────────────────────────────────────────────────────────

const ETSY_AUTH_URL: &str = "https://www.etsy.com/oauth/connect";
const ETSY_TOKEN_URL: &str = "https://api.etsy.com/v3/public/oauth/token";
const ETSY_API_BASE: &str = "https://openapi.etsy.com/v3";
const OAUTH_SCOPES: &str = "transactions_r listings_r";
const OAUTH_TIMEOUT_SECS: u64 = 300; // 5 min for user to complete browser auth
const KEYRING_SERVICE: &str = "etsy_dashboard";

// ── State ─────────────────────────────────────────────────────────────────────

pub struct EtsyState {
    pub client: Client,
    pub api_key: Mutex<Option<String>>,
    pub shop_tokens: Mutex<HashMap<u64, ShopTokens>>,
}

impl EtsyState {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            api_key: Mutex::new(None),
            shop_tokens: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Clone)]
struct ShopTokens {
    access_token: String,
    refresh_token: String,
    expires_at: i64, // Unix seconds
}

// ── Etsy API response types ───────────────────────────────────────────────────

#[derive(Deserialize)]
struct ReceiptsResponse {
    results: Vec<Receipt>,
}

#[derive(Deserialize)]
struct Receipt {
    receipt_id: u64,
    status: String, // "open" | "completed" | "payment_processing" | "cancelled"
    name: String,
    message_from_buyer: Option<String>,
    create_timestamp: i64,
    expected_ship_date: Option<i64>,
    transactions: Vec<Transaction>,
}

#[derive(Deserialize)]
struct Transaction {
    title: String,
    #[serde(default)]
    variations: Vec<TransactionVariation>,
    personalization: Option<TransactionPersonalization>,
}

#[derive(Deserialize)]
struct TransactionVariation {
    formatted_name: String,
    formatted_value: String,
}

#[derive(Deserialize, Default)]
struct TransactionPersonalization {
    // Etsy v3 uses personalization_details; guard against schema drift
    #[serde(default)]
    personalization_details: Option<String>,
    #[serde(default)]
    details: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
}

// ── Normalized types (what the frontend receives) ────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OrderDetails {
    pub hanging_holes: Option<u32>,
    pub special_instructions: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Order {
    pub id: String,          // "IE-{receipt_id}" — display format
    pub receipt_id: String,
    pub product_name: String,
    pub finish: Option<String>,
    pub due_date: String,      // "YYYY-MM-DD"
    pub received_date: String, // "YYYY-MM-DD"
    pub status: String,        // "open" | "completed"
    pub postage_printed: bool, // true when status == "completed"
    pub details: OrderDetails,
    pub buyer: String,
    pub shop_id: u64,
}

#[derive(Debug, Serialize)]
pub struct ShopInfo {
    pub shop_id: u64,
    pub connected: bool,
}

// ── PKCE ──────────────────────────────────────────────────────────────────────

fn random_string(len: usize) -> String {
    use rand::Rng;
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..len).map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char).collect()
}

fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

// ── URL encoding ──────────────────────────────────────────────────────────────

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

// ── Timestamp helpers ─────────────────────────────────────────────────────────

fn unix_to_iso_date(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|dt| dt.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
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

fn keyring_delete(username: &str) {
    if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, username) {
        let _ = e.delete_password();
    }
}

fn load_shop_tokens(shop_id: u64) -> Option<ShopTokens> {
    Some(ShopTokens {
        access_token: keyring_get(&format!("shop_{}_access", shop_id))?,
        refresh_token: keyring_get(&format!("shop_{}_refresh", shop_id))?,
        expires_at: keyring_get(&format!("shop_{}_expires", shop_id))?.parse().ok()?,
    })
}

fn save_shop_tokens(shop_id: u64, tokens: &ShopTokens) -> Result<(), String> {
    keyring_set(&format!("shop_{}_access", shop_id), &tokens.access_token)?;
    keyring_set(&format!("shop_{}_refresh", shop_id), &tokens.refresh_token)?;
    keyring_set(&format!("shop_{}_expires", shop_id), &tokens.expires_at.to_string())
}

fn delete_shop_tokens(shop_id: u64) {
    keyring_delete(&format!("shop_{}_access", shop_id));
    keyring_delete(&format!("shop_{}_refresh", shop_id));
    keyring_delete(&format!("shop_{}_expires", shop_id));
}

// ── API key resolution ────────────────────────────────────────────────────────

async fn resolve_api_key(state: &EtsyState) -> Result<String, String> {
    {
        let lock = state.api_key.lock().await;
        if let Some(key) = &*lock {
            return Ok(key.clone());
        }
    }
    if let Some(key) = keyring_get("etsy_api_key") {
        *state.api_key.lock().await = Some(key.clone());
        return Ok(key);
    }
    if let Ok(key) = std::env::var("ETSY_API_KEY") {
        *state.api_key.lock().await = Some(key.clone());
        return Ok(key);
    }
    Err("Etsy API key not configured. Call set_etsy_api_key first.".to_string())
}

// ── Token management ──────────────────────────────────────────────────────────

async fn get_valid_token(
    client: &Client,
    api_key: &str,
    shop_id: u64,
    state: &EtsyState,
) -> Result<String, String> {
    let cached = state.shop_tokens.lock().await.get(&shop_id).cloned();

    let tokens = match cached {
        Some(t) => t,
        None => load_shop_tokens(shop_id)
            .ok_or_else(|| format!("Shop {} not connected. Run etsy_connect first.", shop_id))?,
    };

    // Refresh if expiring within 60 seconds
    if tokens.expires_at - now_unix() < 60 {
        let refreshed = refresh_token(client, api_key, &tokens.refresh_token).await?;
        save_shop_tokens(shop_id, &refreshed)?;
        let access = refreshed.access_token.clone();
        state.shop_tokens.lock().await.insert(shop_id, refreshed);
        return Ok(access);
    }

    // Warm the in-memory cache if this came from keyring
    state.shop_tokens.lock().await.entry(shop_id).or_insert_with(|| tokens.clone());

    Ok(tokens.access_token)
}

async fn refresh_token(
    client: &Client,
    api_key: &str,
    refresh_token: &str,
) -> Result<ShopTokens, String> {
    let resp = client
        .post(ETSY_TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", api_key),
            ("refresh_token", refresh_token),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("Token refresh failed: {}", resp.text().await.unwrap_or_default()));
    }

    let t: TokenResponse = resp.json().await.map_err(|e| e.to_string())?;
    Ok(ShopTokens {
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: now_unix() + t.expires_in as i64,
    })
}

// ── OAuth callback server ─────────────────────────────────────────────────────

async fn wait_for_callback(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    let (mut stream, _) = timeout(Duration::from_secs(OAUTH_TIMEOUT_SECS), listener.accept())
        .await
        .map_err(|_| "OAuth timed out — browser callback not received within 5 minutes".to_string())?
        .map_err(|e| e.to_string())?;

    let mut buf = vec![0u8; 4096];
    let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
    let request = std::str::from_utf8(&buf[..n]).unwrap_or("");

    // Parse "GET /callback?key=val HTTP/1.1"
    let path = request
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("");

    let params: HashMap<&str, &str> = path
        .split('?')
        .nth(1)
        .unwrap_or("")
        .split('&')
        .filter_map(|pair| {
            let mut kv = pair.splitn(2, '=');
            Some((kv.next()?, kv.next()?))
        })
        .collect();

    let (status_line, body) = if let Some(err) = params.get("error") {
        (
            "400 Bad Request",
            format!("<h2>Authorization denied</h2><p>{}</p>", err),
        )
    } else {
        (
            "200 OK",
            "<h2>Connected!</h2><p>You can close this tab and return to the dashboard.</p>"
                .to_string(),
        )
    };

    let _ = stream
        .write_all(
            format!(
                "HTTP/1.1 {}\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n\
                 <html><body style='font-family:system-ui;padding:40px;max-width:480px'>\
                 {}</body></html>",
                status_line, body
            )
            .as_bytes(),
        )
        .await;

    if let Some(err) = params.get("error") {
        return Err(format!("Etsy denied authorization: {}", err));
    }

    if params.get("state").copied().unwrap_or("") != expected_state {
        return Err("OAuth state mismatch — aborting to prevent CSRF.".to_string());
    }

    params
        .get("code")
        .map(|s| s.to_string())
        .ok_or_else(|| "No authorization code in callback".to_string())
}

// ── Code exchange ─────────────────────────────────────────────────────────────

async fn exchange_code(
    client: &Client,
    api_key: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<ShopTokens, String> {
    let resp = client
        .post(ETSY_TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", api_key),
            ("redirect_uri", redirect_uri),
            ("code", code),
            ("code_verifier", verifier),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("Token exchange failed: {}", resp.text().await.unwrap_or_default()));
    }

    let t: TokenResponse = resp.json().await.map_err(|e| e.to_string())?;
    Ok(ShopTokens {
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: now_unix() + t.expires_in as i64,
    })
}

// ── Order normalization ───────────────────────────────────────────────────────

fn find_variation<'a>(vars: &'a [TransactionVariation], name: &str) -> Option<&'a str> {
    vars.iter()
        .find(|v| v.formatted_name.eq_ignore_ascii_case(name))
        .map(|v| v.formatted_value.as_str())
}

fn parse_hanging_holes(s: &str) -> Option<u32> {
    let s = s.trim().to_lowercase();
    if matches!(s.as_str(), "none" | "no" | "n/a" | "0") {
        return Some(0);
    }
    s.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok()
}

fn normalize(receipt: Receipt, shop_id: u64) -> Order {
    let txn = receipt.transactions.into_iter().next();

    let product_name = txn.as_ref().map(|t| t.title.clone()).unwrap_or_default();
    let vars = txn.as_ref().map(|t| t.variations.as_slice()).unwrap_or(&[]);
    let finish = find_variation(vars, "Finish").map(str::to_string);

    // hanging_holes from the personalization field (e.g. "2 holes", "None")
    let hanging_holes = txn
        .as_ref()
        .and_then(|t| t.personalization.as_ref())
        .and_then(|p| p.personalization_details.as_deref().or(p.details.as_deref()))
        .and_then(parse_hanging_holes);

    // special_instructions from the buyer's message on the receipt
    let special_instructions = receipt
        .message_from_buyer
        .filter(|s| !s.trim().is_empty());

    // Fall back to create_timestamp + 7 days if Etsy didn't set an expected ship date
    let due_date = receipt
        .expected_ship_date
        .map(unix_to_iso_date)
        .unwrap_or_else(|| unix_to_iso_date(receipt.create_timestamp + 7 * 86400));

    let status = if receipt.status == "completed" {
        "completed".to_string()
    } else {
        "open".to_string()
    };
    let postage_printed = receipt.status == "completed";
    let receipt_id = receipt.receipt_id.to_string();

    Order {
        id: format!("IE-{}", receipt_id),
        receipt_id,
        product_name,
        finish,
        due_date,
        received_date: unix_to_iso_date(receipt.create_timestamp),
        status,
        postage_printed,
        details: OrderDetails { hanging_holes, special_instructions },
        buyer: receipt.name,
        shop_id,
    }
}

// ── Order fetch ───────────────────────────────────────────────────────────────

async fn fetch_shop_orders(
    client: &Client,
    api_key: &str,
    access_token: &str,
    shop_id: u64,
) -> Result<Vec<Order>, String> {
    // was_paid=true excludes abandoned carts; limit=100 covers most small shops
    let url = format!(
        "{}/application/shops/{}/receipts?limit=100&was_paid=true",
        ETSY_API_BASE, shop_id
    );

    let resp = client
        .get(&url)
        .header("x-api-key", api_key)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Etsy API HTTP {}: {}", status, body));
    }

    let body: ReceiptsResponse = resp.json().await.map_err(|e| e.to_string())?;
    Ok(body.results.into_iter().map(|r| normalize(r, shop_id)).collect())
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Store the Etsy app API key (the "Keystring" from etsy.com/developers).
#[tauri::command]
pub async fn set_etsy_api_key(
    api_key: String,
    state: State<'_, EtsyState>,
) -> Result<(), String> {
    keyring_set("etsy_api_key", &api_key)?;
    *state.api_key.lock().await = Some(api_key);
    Ok(())
}

/// OAuth 2.0 + PKCE connect flow for a single shop. Opens the system browser,
/// waits for the redirect callback, exchanges the code, and persists tokens.
/// Call once per shop during initial setup or if tokens are revoked.
#[tauri::command]
pub async fn etsy_connect(
    shop_id: u64,
    app_handle: tauri::AppHandle,
    state: State<'_, EtsyState>,
) -> Result<(), String> {
    let api_key = resolve_api_key(&state).await?;

    // Bind to a free port so the redirect URI is unique per auth attempt
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Could not open OAuth listener: {}", e))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{}/callback", port);

    let verifier = random_string(64);
    let challenge = pkce_challenge(&verifier);
    let state_param = random_string(16);

    let auth_url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}\
         &state={}&code_challenge={}&code_challenge_method=S256",
        ETSY_AUTH_URL,
        urlencode(&api_key),
        urlencode(&redirect_uri),
        urlencode(OAUTH_SCOPES),
        urlencode(&state_param),
        urlencode(&challenge),
    );

    tauri::api::shell::open(&app_handle.shell_scope(), &auth_url, None)
        .map_err(|e| format!("Could not open browser: {}", e))?;

    let code = wait_for_callback(listener, &state_param).await?;
    let tokens = exchange_code(&state.client, &api_key, &code, &verifier, &redirect_uri).await?;

    save_shop_tokens(shop_id, &tokens)?;
    state.shop_tokens.lock().await.insert(shop_id, tokens);

    Ok(())
}

/// Fetch paid orders from one or more shops.
///
/// Returns cached data (SQLite) if each shop's cache is younger than
/// ORDER_CACHE_MAX_AGE seconds. Pass force_refresh: true to bypass the
/// cache and always hit the Etsy API.
///
/// Results are sorted: open orders first, then shipped; due-date ascending
/// within each group.
#[tauri::command]
pub async fn get_orders(
    shop_ids: Vec<u64>,
    force_refresh: Option<bool>,
    state: State<'_, EtsyState>,
    cache: State<'_, CacheDb>,
) -> Result<Vec<Order>, String> {
    const ORDER_CACHE_MAX_AGE: i64 = 20 * 60; // 20 minutes
    let force = force_refresh.unwrap_or(false);

    let api_key = resolve_api_key(&state).await?;
    let mut all_orders: Vec<Order> = Vec::new();

    for shop_id in shop_ids {
        // Serve from cache if fresh enough
        if !force {
            if let Some(age) = cache.shop_age_secs(shop_id) {
                if age < ORDER_CACHE_MAX_AGE {
                    let blobs = cache.get_orders_for_shops(&[shop_id])?;
                    let cached: Vec<Order> = blobs
                        .iter()
                        .filter_map(|j| serde_json::from_str(j).ok())
                        .collect();
                    all_orders.extend(cached);
                    continue;
                }
            }
        }

        // Cache miss or stale — fetch from Etsy
        let token = get_valid_token(&state.client, &api_key, shop_id, &state).await?;
        let orders = fetch_shop_orders(&state.client, &api_key, &token, shop_id).await?;

        let rows: Vec<(String, u64, String)> = orders
            .iter()
            .filter_map(|o| {
                serde_json::to_string(o).ok().map(|j| (o.id.clone(), o.shop_id, j))
            })
            .collect();
        cache.upsert_orders(&rows)?;
        cache.mark_shop_synced(shop_id)?;

        all_orders.extend(orders);
    }

    all_orders.sort_by(|a, b| {
        a.postage_printed.cmp(&b.postage_printed).then(a.due_date.cmp(&b.due_date))
    });

    Ok(all_orders)
}

/// Returns connection status for the given shop IDs.
#[tauri::command]
pub async fn get_connected_shops(shop_ids: Vec<u64>) -> Result<Vec<ShopInfo>, String> {
    Ok(shop_ids
        .into_iter()
        .map(|id| ShopInfo { shop_id: id, connected: load_shop_tokens(id).is_some() })
        .collect())
}

/// Remove stored tokens for a shop (effectively disconnects it).
#[tauri::command]
pub async fn disconnect_shop(
    shop_id: u64,
    state: State<'_, EtsyState>,
) -> Result<(), String> {
    delete_shop_tokens(shop_id);
    state.shop_tokens.lock().await.remove(&shop_id);
    Ok(())
}
