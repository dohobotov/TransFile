mod adb;
mod connection;
mod dialog;
mod proc_guard;
mod scanner;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            adb::load_custom_adb_path(app.handle());
            connection::start_device_watcher(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            adb::check_adb_status,
            adb::set_custom_adb_path,
            adb::get_connected_devices,
            adb::connect_device,
            adb::connect_lan_devices,
            adb::disconnect_device,
            adb::pair_device,
            adb::switch_to_tcpip,
            adb::list_device_files,
            adb::list_device_dirs,
            adb::create_device_folder,
            adb::delete_device_item,
            adb::push_files_to_multiple_devices,
            adb::pull_file_from_device,
            connection::wait_device_ready,
            scanner::discover_network_devices,
            dialog::pick_local_files,
            dialog::pick_local_folder,
            dialog::pick_save_folder,
            dialog::pick_adb_executable
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
