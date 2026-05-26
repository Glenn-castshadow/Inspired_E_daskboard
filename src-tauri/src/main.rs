// src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod easypost;
mod etsy;
// mod cache;  // add when ready

fn main() {
    tauri::Builder::default()
        .manage(easypost::EasyPostState::new())
        .manage(etsy::EtsyState::new())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
