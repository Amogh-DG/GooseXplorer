mod autonamer;
mod db;
mod fs;

struct DbState {
    conn: std::sync::Mutex<rusqlite::Connection>,
}

#[tauri::command]
fn list_dir(path: String) -> Vec<fs::FileEntry> {
    fs::list_dir(&path)
}

#[tauri::command]
fn get_file_meta(state: tauri::State<'_, DbState>, path: String) -> Result<db::FileMetadata, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    Ok(db::get_file_metadata(&conn, &path))
}

#[tauri::command]
fn save_file_meta(
    state: tauri::State<'_, DbState>,
    path: String,
    description: String,
    tags: String,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::save_file_description_and_tags(&conn, &path, &description, &tags).map_err(|e| e.to_string())
}

#[tauri::command]
fn search_files(state: tauri::State<'_, DbState>, query: String) -> Result<Vec<db::SearchResult>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::search_files(&conn, &query).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_drives() -> Vec<String> {
    fs::list_drives()
}

#[tauri::command]
fn get_system_folders() -> Vec<fs::SidebarItem> {
    fs::get_system_folders()
        .into_iter()
        .map(|(name, path)| fs::SidebarItem { name, path })
        .collect()
}

#[tauri::command]
fn suggest_name(filename: String) -> String {
    autonamer::suggest_name(&filename)
}

#[tauri::command]
fn get_setting(state: tauri::State<'_, DbState>, key: String) -> Result<String, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    Ok(db::get_setting(&conn, &key))
}

#[tauri::command]
fn set_setting(state: tauri::State<'_, DbState>, key: String, value: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::set_setting(&conn, &key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_file(path: String) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn();
    }
}

#[tauri::command]
fn path_is_dir(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

#[tauri::command]
fn open_in_powershell(path: String) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("powershell")
            .args(["-NoExit", "-Command", &format!("Set-Location '{}'", path)])
            .creation_flags(0x00000010) // CREATE_NEW_CONSOLE
            .spawn();
    }
}

#[tauri::command]
fn open_in_lazyvim(path: String) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("powershell")
            .args(["-NoExit", "-Command", &format!("nvim '{}'", path)])
            .creation_flags(0x00000010) // CREATE_NEW_CONSOLE
            .spawn();
    }
}

#[tauri::command]
fn run_shell_command(command: String, cwd: String) -> Result<String, String> {
    let work_dir = if std::path::Path::new(&cwd).is_dir() {
        cwd.clone()
    } else {
        String::from("C:\\")
    };
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &command])
        .current_dir(&work_dir)
        .output()
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.success() {
        Ok(stdout)
    } else {
        Err(if stderr.trim().is_empty() { stdout } else { stderr })
    }
}

#[tauri::command]
fn find_dirs_by_name(
    state: tauri::State<'_, DbState>,
    name: String,
) -> Result<Vec<String>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    // Normalize: strip non-alphanumeric, lowercase
    // "spiderman" -> matches "spider-man miles morales" -> "spidermanmilesmorales"
    let norm_query: String = name
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>()
        .to_lowercase();
    let mut stmt = conn
        .prepare("SELECT DISTINCT path FROM files")
        .map_err(|e| e.to_string())?;
    let paths: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .filter(|p| {
            let fname = std::path::Path::new(p)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            let norm_fname: String = fname
                .chars()
                .filter(|c| c.is_alphanumeric())
                .collect::<String>()
                .to_lowercase();
            norm_fname.contains(&norm_query) && std::path::Path::new(p).is_dir()
        })
        .collect();
    Ok(paths)
}

#[tauri::command]
fn index_path(state: tauri::State<'_, DbState>, path: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO files (path, description, tags) VALUES (?1, '', '')",
        [&path],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_indexed_paths(state: tauri::State<'_, DbState>) -> Result<Vec<String>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT DISTINCT path FROM files ORDER BY path")
        .map_err(|e| e.to_string())?;
    let paths: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(paths)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let conn = db::init_db()?;
    let db_state = DbState {
        conn: std::sync::Mutex::new(conn),
    };

    tauri::Builder::default()
        .manage(db_state)
        .invoke_handler(tauri::generate_handler![
            list_dir,
            get_file_meta,
            save_file_meta,
            search_files,
            get_drives,
            get_system_folders,
            suggest_name,
            get_setting,
            set_setting,
            open_file,
            path_is_dir,
            open_in_powershell,
            open_in_lazyvim,
            run_shell_command,
            find_dirs_by_name,
            index_path,
            list_indexed_paths,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    Ok(())
}
