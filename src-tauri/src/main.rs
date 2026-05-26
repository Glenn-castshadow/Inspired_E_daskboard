// src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cache;
mod easypost;
mod etsy;

fn main() {
    tauri::Builder::default()
        .manage(easypost::EasyPostState::new())
        .manage(etsy::EtsyState::new())
        .setup(|app| {
            let data_dir = app
                .path_resolver()
                .app_data_dir()
                .expect("could not resolve app data directory");
            std::fs::create_dir_all(&data_dir)?;
            app.manage(
                cache::CacheDb::new(&data_dir.join("cache.db"))
                    .expect("failed to open SQLite cache"),
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // EasyPost tracking
            easypost::get_tracking,
            easypost::refresh_tracking,
            easypost::refresh_all_tracking,
            easypost::set_easypost_api_key,
            easypost::clear_tracking_cache,
            // Etsy orders
            etsy::set_etsy_api_key,
            etsy::etsy_connect,
            etsy::get_orders,
            etsy::get_connected_shops,
            etsy::disconnect_shop,
            // Cache
            cache::cache_status,
            cache::clear_cache,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
