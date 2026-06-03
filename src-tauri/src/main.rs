// src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cache;
mod catalog;
// EasyPost integration retired in favor of free USPS Tracking 3.2 (see src/usps.rs).
// The easypost.rs file remains in the repo for git history but is no longer compiled.
mod etsy;
mod inventory;
mod settings;
mod usps;

use tauri::Manager;

/// Open WebView2 devtools on demand. Bound to F12 in the frontend so release
/// builds can always reach the console for credential setup & debugging.
#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

#[tauri::command]
fn close_devtools(window: tauri::WebviewWindow) {
    window.close_devtools();
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(usps::UspsState::new())
        .manage(etsy::EtsyState::new())
        // Shared reqwest client — one instance, reused for all HTTP calls.
        // reqwest::Client is already Arc-backed so cloning is cheap.
        .manage(reqwest::Client::new())
        .setup(|app| {
            // Tauri v2: path resolver moved from app.path_resolver() to app.path()
            // and returns Result instead of Option.
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("could not resolve app data directory");
            std::fs::create_dir_all(&data_dir)?;

            app.manage(
                cache::CacheDb::new(&data_dir.join("cache.db"))
                    .expect("failed to open SQLite cache"),
            );
            app.manage(settings::AppSettings::load(&data_dir));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Tracking (USPS Tracking 3.2 — free, OAuth 2.0)
            usps::get_tracking,
            usps::refresh_tracking,
            usps::refresh_all_tracking,
            usps::set_usps_credentials,
            usps::clear_tracking_cache,
            // Etsy orders
            etsy::set_etsy_shop_credentials,
            etsy::etsy_connect,
            etsy::get_orders,
            etsy::get_connected_shops,
            etsy::disconnect_shop,
            etsy::create_receipt_shipment,
            etsy::export_credentials,
            etsy::import_credentials,
            // Inventory
            inventory::get_inventory,
            inventory::add_inventory_item,
            inventory::set_inventory_qty,
            inventory::adjust_inventory_qty,
            inventory::update_inventory_item,
            inventory::delete_inventory_item,
            // Product catalog
            catalog::get_products,
            catalog::add_product,
            catalog::update_product,
            catalog::delete_product,
            // Settings
            settings::get_settings,
            settings::save_settings,
            settings::test_inventory_connection,
            // Cache
            cache::cache_status,
            cache::clear_cache,
            // Devtools
            open_devtools,
            close_devtools,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
