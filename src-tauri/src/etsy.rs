// src-tauri/src/etsy.rs
//
// Etsy OAuth 2.0 + PKCE token management and order fetch.
//
// Setup:
//   1. Create an Etsy app at etsy.com/developers and copy the Keystring (API key)
//   2. Add callback URL in your Etsy app: http://localhost:7777/callback
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
const OAUTH_SCOPES: &str = "transactions_r transactions_w listings_r";
const OAUTH_TIMEOUT_SECS: u64 = 300; // 5 min for user to complete browser auth
const KEYRING_SERVICE: &str = "etsy_dashboard";

// ── State ─────────────────────────────────────────────────────────────────────

pub struct EtsyState {
    pub client: Client,
    pub shop_creds: Mutex<HashMap<u64, ShopCredentials>>,
    pub shop_tokens: Mutex<HashMap<u64, ShopTokens>>,
}

impl EtsyState {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            shop_creds: Mutex::new(HashMap::new()),
            shop_tokens: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Clone)]
pub(crate) struct ShopCredentials {
    api_key: String,        // "Keystring" — the OAuth client_id
    shared_secret: String,  // x-api-key value for API requests
}

#[derive(Clone)]
pub(crate) struct ShopTokens {
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
    status: String, // "Paid" | "Completed" | "Open" | "Payment Processing" | "Canceled" — payment state, NOT shipment state
    #[serde(default)]
    is_shipped: bool, // true once a label is printed / shipment created
    name: String,
    message_from_buyer: Option<String>,
    create_timestamp: i64,
    expected_ship_date: Option<i64>,
    transactions: Vec<Transaction>,
    #[serde(default)]
    shipments: Vec<Shipment>,
    grandtotal: Option<Money>,
    // Shipping address — feeds the Map tab's geocoding. All Optional because
    // Etsy occasionally returns receipts (e.g. digital downloads) with no
    // physical address.
    #[serde(default)]
    zip: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    city: Option<String>,
    #[serde(default)]
    country_iso: Option<String>,
}

#[derive(Deserialize)]
struct Shipment {
    tracking_code: Option<String>,
}

#[derive(Deserialize)]
struct Money {
    amount: i64,
    divisor: i64,
}

#[derive(Deserialize)]
struct Transaction {
    title: String,
    #[serde(default)]
    listing_id: u64,
    #[serde(default)]
    variations: Vec<TransactionVariation>,
    personalization: Option<TransactionPersonalization>,
    // Listing thumbnail — Etsy's schema for this varies; we try multiple paths.
    // Etsy v3 OpenAPI lists it as image_listing; some endpoints return listing_image;
    // when ?includes=Listings is used, it shows up nested under listing.images[0].
    #[serde(default)]
    image_listing: Option<ListingImage>,
    #[serde(default)]
    listing_image: Option<ListingImage>,
    #[serde(default)]
    listing: Option<TransactionListing>,
}

#[derive(Deserialize, Default)]
struct TransactionListing {
    #[serde(default)]
    images: Vec<ListingImage>,
}

#[derive(Deserialize, Default)]
struct ListingImage {
    #[serde(default)]
    url_75x75: Option<String>,
    #[serde(default)]
    url_170x135: Option<String>,
    // Etsy uses capital N in the JSON field; rename to keep Rust snake_case happy
    #[serde(default, rename = "url_570xN")]
    url_570x_n: Option<String>,
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
    pub total_price: f64,
    pub tracking_code: Option<String>,
    pub image_url: Option<String>,
    // Shipping destination — used by the Map tab. None for digital orders or
    // older cached blobs that predate the schema (defaulted via serde).
    #[serde(default)]
    pub ship_zip: Option<String>,
    #[serde(default)]
    pub ship_state: Option<String>,
    #[serde(default)]
    pub ship_city: Option<String>,
    #[serde(default)]
    pub ship_country: Option<String>,
    // Internal — kept to allow image enrichment in fetch_shop_orders.
    // Skipped in serialization to avoid leaking to the frontend cache JSON in a
    // breaking way; deserialization defaults to None for older cached blobs.
    #[serde(skip_serializing, default)]
    pub listing_id: Option<u64>,
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

async fn resolve_shop_creds(state: &EtsyState, shop_id: u64) -> Result<ShopCredentials, String> {
    {
        let lock = state.shop_creds.lock().await;
        if let Some(c) = lock.get(&shop_id) {
            return Ok(c.clone());
        }
    }
    let api_key = keyring_get(&format!("shop_{}_api_key", shop_id))
        .ok_or_else(|| format!("No API key configured for shop {}. Call set_etsy_shop_credentials first.", shop_id))?;
    let shared_secret = keyring_get(&format!("shop_{}_shared_secret", shop_id))
        .ok_or_else(|| format!("No shared secret configured for shop {}. Call set_etsy_shop_credentials first.", shop_id))?;
    let creds = ShopCredentials { api_key, shared_secret };
    state.shop_creds.lock().await.insert(shop_id, creds.clone());
    Ok(creds)
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
    let total_price = receipt.grandtotal
        .map(|m| if m.divisor == 0 { 0.0 } else { m.amount as f64 / m.divisor as f64 })
        .unwrap_or(0.0);

    let tracking_code = receipt.shipments.first()
        .and_then(|s| s.tracking_code.as_deref())
        .filter(|t| !t.is_empty())
        .map(str::to_string);

    let txn = receipt.transactions.into_iter().next();

    let product_name = txn.as_ref().map(|t| t.title.clone()).unwrap_or_default();
    let vars = txn.as_ref().map(|t| t.variations.as_slice()).unwrap_or(&[]);
    let finish = find_variation(vars, "Finish").map(str::to_string);

    // Try every shape Etsy might use for the listing image:
    //   transaction.image_listing
    //   transaction.listing_image
    //   transaction.listing.images[0]   (when ?includes=Listings)
    let image_url = txn
        .as_ref()
        .and_then(|t| {
            t.image_listing.as_ref()
                .or(t.listing_image.as_ref())
                .or_else(|| t.listing.as_ref().and_then(|l| l.images.first()))
        })
        .and_then(|img| {
            img.url_170x135.clone()
                .or_else(|| img.url_75x75.clone())
                .or_else(|| img.url_570x_n.clone())
        });

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

    // "Shipped" = a label has been printed (Etsy's is_shipped flag) OR there's a tracking code on the shipment.
    // Etsy's receipt.status tracks PAYMENT state ("Paid", "Completed", "Canceled"), not shipment state.
    let was_shipped = receipt.is_shipped
        || receipt.status == "Completed"
        || tracking_code.is_some();
    let status = if was_shipped { "completed".to_string() } else { "open".to_string() };
    let postage_printed = was_shipped;
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
        total_price,
        tracking_code,
        image_url,
        ship_zip: receipt.zip,
        ship_state: receipt.state,
        ship_city: receipt.city,
        ship_country: receipt.country_iso,
        listing_id: txn.as_ref().and_then(|t| if t.listing_id == 0 { None } else { Some(t.listing_id) }),
    }
}

// ── Order fetch ───────────────────────────────────────────────────────────────

async fn fetch_shop_orders(
    client: &Client,
    api_key: &str,
    shared_secret: &str,
    access_token: &str,
    shop_id: u64,
) -> Result<Vec<Order>, String> {
    // was_paid=true excludes abandoned carts; limit=100 covers most small shops.
    // includes=Listings expands each transaction's listing data (gives us image URLs).
    let url = format!(
        "{}/application/shops/{}/receipts?limit=100&was_paid=true&includes=Listings",
        ETSY_API_BASE, shop_id
    );

    // Etsy v3 API expects x-api-key in the format "keystring:shared_secret"
    let x_api_key = format!("{}:{}", api_key, shared_secret);
    let resp = client
        .get(&url)
        .header("x-api-key", x_api_key)
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
    let mut orders: Vec<Order> = body.results.into_iter().map(|r| normalize(r, shop_id)).collect();

    // The receipts endpoint doesn't reliably include listing images. Fetch them
    // in one batched listings call and stitch them in. Image URLs survive in the
    // SQLite order cache so this only runs on a real refresh.
    let listing_ids: std::collections::HashSet<u64> = orders
        .iter()
        .filter(|o| o.image_url.is_none())
        .filter_map(|o| o.listing_id)
        .collect();
    if !listing_ids.is_empty() {
        let ids: Vec<u64> = listing_ids.into_iter().collect();
        match fetch_listing_images(client, api_key, shared_secret, access_token, &ids).await {
            Ok(map) => {
                for order in orders.iter_mut() {
                    if order.image_url.is_none() {
                        if let Some(lid) = order.listing_id {
                            if let Some(url) = map.get(&lid) {
                                order.image_url = Some(url.clone());
                            }
                        }
                    }
                }
            }
            Err(e) => eprintln!("Listing image fetch failed for shop {}: {}", shop_id, e),
        }
    }

    Ok(orders)
}

#[derive(Deserialize)]
struct ListingsBatchResponse {
    results: Vec<ListingBatch>,
}

#[derive(Deserialize)]
struct ListingBatch {
    listing_id: u64,
    #[serde(default)]
    images: Vec<ListingImage>,
}

/// Batch-fetch listing images for a set of listing IDs. Returns listing_id → URL.
async fn fetch_listing_images(
    client: &Client,
    api_key: &str,
    shared_secret: &str,
    access_token: &str,
    listing_ids: &[u64],
) -> Result<std::collections::HashMap<u64, String>, String> {
    use std::collections::HashMap;
    if listing_ids.is_empty() {
        return Ok(HashMap::new());
    }
    // Etsy's listings/batch endpoint accepts up to 100 IDs at a time
    let mut out: HashMap<u64, String> = HashMap::new();
    let x_api_key = format!("{}:{}", api_key, shared_secret);
    for chunk in listing_ids.chunks(100) {
        let ids_param: String = chunk.iter().map(u64::to_string).collect::<Vec<_>>().join(",");
        let url = format!(
            "{}/application/listings/batch?listing_ids={}&includes=Images",
            ETSY_API_BASE, ids_param
        );
        let resp = client
            .get(&url)
            .header("x-api-key", &x_api_key)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Listings batch HTTP {}: {}", status, body));
        }
        let body: ListingsBatchResponse = resp.json().await.map_err(|e| e.to_string())?;
        for listing in body.results {
            if let Some(url) = listing
                .images
                .into_iter()
                .next()
                .and_then(|img| img.url_170x135.or(img.url_75x75).or(img.url_570x_n))
            {
                out.insert(listing.listing_id, url);
            }
        }
    }
    Ok(out)
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Store the Etsy app credentials (Keystring + Shared Secret) for a specific shop.
/// Each shop is owned by a separate Etsy account with its own developer app.
#[tauri::command]
pub async fn set_etsy_shop_credentials(
    shop_id: u64,
    api_key: String,
    shared_secret: String,
    state: State<'_, EtsyState>,
) -> Result<(), String> {
    keyring_set(&format!("shop_{}_api_key", shop_id), &api_key)?;
    keyring_set(&format!("shop_{}_shared_secret", shop_id), &shared_secret)?;
    state.shop_creds.lock().await.insert(
        shop_id,
        ShopCredentials { api_key, shared_secret },
    );
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
    let creds = resolve_shop_creds(&state, shop_id).await?;
    let api_key = creds.api_key;

    // Bind to a free port so the redirect URI is unique per auth attempt
    let listener = TcpListener::bind("127.0.0.1:7777")
        .await
        .map_err(|e| format!("Could not open OAuth listener: {}", e))?;
    let redirect_uri = "http://localhost:7777/callback".to_string();

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

    // Tauri v2: open URL via tauri-plugin-shell (replaces v1's tauri::api::shell).
    use tauri_plugin_shell::ShellExt;
    app_handle
        .shell()
        .open(&auth_url, None)
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
    const ORDER_CACHE_MAX_AGE: i64 = 30 * 60; // 30 minutes — conservative; key is shared with another app
    let force = force_refresh.unwrap_or(false);

    let mut all_orders: Vec<Order> = Vec::new();
    let mut fetched_count: u32 = 0;

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

        // Cache miss or stale — fetch from Etsy using per-shop credentials.
        // Skip shops that aren't configured/connected yet so one missing shop
        // doesn't break the whole dashboard.
        let creds = match resolve_shop_creds(&state, shop_id).await {
            Ok(c) => c,
            Err(e) => {
                eprintln!("Skipping shop {}: {}", shop_id, e);
                continue;
            }
        };

        // Stagger requests so each shop's QPS stays well under its 5/sec limit
        if fetched_count > 0 {
            tokio::time::sleep(tokio::time::Duration::from_millis(250)).await;
        }
        fetched_count += 1;
        let token = match get_valid_token(&state.client, &creds.api_key, shop_id, &state).await {
            Ok(t) => t,
            Err(e) => {
                eprintln!("Skipping shop {}: {}", shop_id, e);
                continue;
            }
        };
        let orders = fetch_shop_orders(&state.client, &creds.api_key, &creds.shared_secret, &token, shop_id).await?;

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

/// POST tracking info to Etsy, which marks the receipt as shipped and emails the buyer.
/// Etsy endpoint: POST /v3/application/shops/{shop_id}/receipts/{receipt_id}/tracking
/// Requires the `transactions_w` OAuth scope — re-run etsy_connect if you authorized
/// before this scope was added.
#[tauri::command]
pub async fn create_receipt_shipment(
    shop_id: u64,
    receipt_id: u64,
    tracking_code: String,
    carrier_name: Option<String>,
    send_bcc: Option<bool>,
    state: State<'_, EtsyState>,
    cache: State<'_, CacheDb>,
) -> Result<(), String> {
    let creds = resolve_shop_creds(&state, shop_id).await?;
    let token = get_valid_token(&state.client, &creds.api_key, shop_id, &state).await?;
    let x_api_key = format!("{}:{}", creds.api_key, creds.shared_secret);
    let url = format!(
        "{}/application/shops/{}/receipts/{}/tracking",
        ETSY_API_BASE, shop_id, receipt_id
    );

    let mut form: Vec<(&str, String)> = vec![("tracking_code", tracking_code.clone())];
    if let Some(c) = carrier_name {
        if !c.is_empty() { form.push(("carrier_name", c)); }
    }
    if let Some(b) = send_bcc {
        form.push(("send_bcc", b.to_string()));
    }

    let resp = state.client
        .post(&url)
        .header("x-api-key", x_api_key)
        .bearer_auth(token)
        .form(&form)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        if status == 403 && body.contains("scope") {
            return Err(format!(
                "Insufficient OAuth scope. Re-run etsy_connect for shop {} so the new transactions_w scope is granted.",
                shop_id
            ));
        }
        return Err(format!("Etsy API HTTP {}: {}", status, body));
    }

    // Invalidate this shop's order cache so the next get_orders refetches with
    // the shipped state baked in.
    let _ = cache.clear_shop_orders(shop_id);
    Ok(())
}

// ── Credentials export / import ───────────────────────────────────────────────
//
// File format (binary):
//   [magic 4B "GETD"] [version 1B = 1] [salt 16B] [nonce 12B] [ciphertext...]
//
// Ciphertext is AES-256-GCM of the JSON below. Key is PBKDF2-HMAC-SHA256 of the
// user's passphrase, 100k iterations, with the per-file salt.

const BACKUP_MAGIC: &[u8; 4] = b"GETD";
const BACKUP_VERSION: u8 = 1;
const PBKDF2_ITERATIONS: u32 = 100_000;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;

#[derive(serde::Serialize, serde::Deserialize)]
struct CredentialsBackup {
    version: u32,
    exported_at: i64,
    // Older backups carry an EasyPost key — read for back-compat, never written.
    #[serde(default)]
    easypost_api_key: Option<String>,
    // Newer backups carry USPS API credentials (Tracking 3.2 OAuth client).
    #[serde(default)]
    usps_client_id: Option<String>,
    #[serde(default)]
    usps_client_secret: Option<String>,
    shops: std::collections::HashMap<u64, ShopBackup>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct ShopBackup {
    api_key: String,
    shared_secret: String,
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_at: Option<i64>,
}

fn derive_key(passphrase: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(passphrase.as_bytes(), salt, PBKDF2_ITERATIONS, &mut key);
    key
}

/// Export all stored credentials (EasyPost key + per-shop Etsy creds & OAuth tokens)
/// to a passphrase-encrypted file. Pass the path you want the file written to.
///
/// shop_ids: which shops to include (typically your full SHOP_IDS list).
#[tauri::command]
pub async fn export_credentials(
    shop_ids: Vec<u64>,
    passphrase: String,
    file_path: String,
) -> Result<(), String> {
    if passphrase.len() < 8 {
        return Err("Passphrase must be at least 8 characters".to_string());
    }

    let usps_client_id = keyring_get("usps_client_id");
    let usps_client_secret = keyring_get("usps_client_secret");

    let mut shops = std::collections::HashMap::new();
    for shop_id in shop_ids {
        let api_key = keyring_get(&format!("shop_{}_api_key", shop_id));
        let shared_secret = keyring_get(&format!("shop_{}_shared_secret", shop_id));
        // Only include shops that actually have credentials set
        if let (Some(api_key), Some(shared_secret)) = (api_key, shared_secret) {
            let tokens = load_shop_tokens(shop_id);
            shops.insert(shop_id, ShopBackup {
                api_key,
                shared_secret,
                access_token: tokens.as_ref().map(|t| t.access_token.clone()),
                refresh_token: tokens.as_ref().map(|t| t.refresh_token.clone()),
                expires_at: tokens.as_ref().map(|t| t.expires_at),
            });
        }
    }

    let backup = CredentialsBackup {
        version: 1,
        exported_at: now_unix(),
        easypost_api_key: None, // legacy field — no longer written
        usps_client_id,
        usps_client_secret,
        shops,
    };
    let plaintext = serde_json::to_vec(&backup).map_err(|e| e.to_string())?;

    use aes_gcm::{Aes256Gcm, KeyInit};
    use aes_gcm::aead::Aead;
    use rand::RngCore;

    let mut rng = rand::thread_rng();
    let mut salt = [0u8; SALT_LEN];
    rng.fill_bytes(&mut salt);
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rng.fill_bytes(&mut nonce_bytes);

    let key = derive_key(&passphrase, &salt);
    let cipher = Aes256Gcm::new(&key.into());
    let nonce = aes_gcm::Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher.encrypt(nonce, plaintext.as_ref())
        .map_err(|e| format!("Encryption failed: {}", e))?;

    let mut out = Vec::with_capacity(4 + 1 + SALT_LEN + NONCE_LEN + ciphertext.len());
    out.extend_from_slice(BACKUP_MAGIC);
    out.push(BACKUP_VERSION);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);

    std::fs::write(&file_path, &out).map_err(|e| format!("Could not write file: {}", e))?;
    Ok(())
}

/// Import credentials from an encrypted file produced by export_credentials.
/// Writes everything back into Windows Credential Manager.
/// Returns the list of shop IDs that were imported.
#[tauri::command]
pub async fn import_credentials(
    passphrase: String,
    file_path: String,
    state: State<'_, EtsyState>,
) -> Result<Vec<u64>, String> {
    let bytes = std::fs::read(&file_path).map_err(|e| format!("Could not read file: {}", e))?;

    let header_len = 4 + 1 + SALT_LEN + NONCE_LEN;
    if bytes.len() < header_len {
        return Err("Backup file is too small or corrupted".to_string());
    }
    if &bytes[0..4] != BACKUP_MAGIC {
        return Err("Not a Genevieve credentials backup file".to_string());
    }
    if bytes[4] != BACKUP_VERSION {
        return Err(format!("Unsupported backup version: {}", bytes[4]));
    }
    let salt = &bytes[5..5 + SALT_LEN];
    let nonce_bytes = &bytes[5 + SALT_LEN..5 + SALT_LEN + NONCE_LEN];
    let ciphertext = &bytes[header_len..];

    use aes_gcm::{Aes256Gcm, KeyInit};
    use aes_gcm::aead::Aead;

    let key = derive_key(&passphrase, salt);
    let cipher = Aes256Gcm::new(&key.into());
    let nonce = aes_gcm::Nonce::from_slice(nonce_bytes);
    let plaintext = cipher.decrypt(nonce, ciphertext)
        .map_err(|_| "Decryption failed — wrong passphrase or corrupted file".to_string())?;

    let backup: CredentialsBackup = serde_json::from_slice(&plaintext)
        .map_err(|e| format!("Could not parse backup: {}", e))?;

    // Write everything to keyring. Restore EasyPost too (back-compat with old backups).
    if let Some(key) = &backup.easypost_api_key {
        keyring_set("easypost_api_key", key)?;
    }
    if let Some(id) = &backup.usps_client_id {
        keyring_set("usps_client_id", id)?;
    }
    if let Some(secret) = &backup.usps_client_secret {
        keyring_set("usps_client_secret", secret)?;
    }

    let mut imported_ids = Vec::new();
    for (shop_id, s) in backup.shops {
        keyring_set(&format!("shop_{}_api_key", shop_id), &s.api_key)?;
        keyring_set(&format!("shop_{}_shared_secret", shop_id), &s.shared_secret)?;
        // Cache in memory state
        state.shop_creds.lock().await.insert(
            shop_id,
            ShopCredentials { api_key: s.api_key, shared_secret: s.shared_secret },
        );
        // Restore OAuth tokens if present
        if let (Some(access), Some(refresh), Some(expires)) = (s.access_token, s.refresh_token, s.expires_at) {
            keyring_set(&format!("shop_{}_access", shop_id), &access)?;
            keyring_set(&format!("shop_{}_refresh", shop_id), &refresh)?;
            keyring_set(&format!("shop_{}_expires", shop_id), &expires.to_string())?;
            state.shop_tokens.lock().await.insert(
                shop_id,
                ShopTokens { access_token: access, refresh_token: refresh, expires_at: expires },
            );
        }
        imported_ids.push(shop_id);
    }

    Ok(imported_ids)
}
