// src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod easypost;
// mod etsy;   // add when ready
// mod cache;  // add when ready

fn main() {
    tauri::Builder::default()
        .manage(easypost::EasyPostState::new())
        .invoke_handler(tauri::generate_handler![
            easypost::get_tracking,
            easypost::refresh_tracking,
            easypost::refresh_all_tracking,
            easypost::set_easypost_api_key,
            easypost::clear_tracking_cache,
            // etsy::get_orders,
            // etsy::refresh_all_shops,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
