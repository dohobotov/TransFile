use rfd::FileDialog;

#[tauri::command]
pub fn pick_local_files() -> Vec<String> {
    if let Some(files) = FileDialog::new()
        .set_title("Выберите файлы для отправки")
        .pick_files()
    {
        files
            .into_iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect()
    } else {
        Vec::new()
    }
}

#[tauri::command]
pub fn pick_local_folder() -> Option<String> {
    FileDialog::new()
        .set_title("Выберите папку для отправки")
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn pick_save_folder() -> Option<String> {
    FileDialog::new()
        .set_title("Выберите папку на ПК для сохранения")
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn pick_adb_executable() -> Option<String> {
    FileDialog::new()
        .set_title("Укажите исполняемый файл adb.exe")
        .add_filter("ADB Executable", &["exe", ""])
        .pick_file()
        .map(|p| p.to_string_lossy().to_string())
}
