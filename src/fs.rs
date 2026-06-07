use std::fs;
use std::time::UNIX_EPOCH;
use chrono::{TimeZone, Local};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub _modified: String,
    pub _extension: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct SidebarItem {
    pub name: String,
    pub path: String,
}

/// Lists all files and directories in the specified path.
/// Entries are sorted so directories appear first, then files, both sorted alphabetically.
pub fn list_dir(path: &str) -> Vec<FileEntry> {
    let mut entries = Vec::new();

    if let Ok(read_dir) = fs::read_dir(path) {
        for entry in read_dir.flatten() {
            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };

            let name = entry.file_name().to_string_lossy().into_owned();
            let path_str = entry.path().to_string_lossy().into_owned();
            let is_dir = metadata.is_dir();
            let size = if is_dir { 0 } else { metadata.len() };

            let modified = metadata.modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| {
                    let secs = d.as_secs();
                    let dt = Local.timestamp_opt(secs as i64, 0)
                        .single()
                        .unwrap_or_else(|| Local::now());
                    dt.format("%b %d %Y").to_string()
                })
                .unwrap_or_else(|| "Unknown".to_string());

            let extension = entry.path()
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or("")
                .to_string();

            entries.push(FileEntry {
                name,
                path: path_str,
                is_dir,
                size,
                _modified: modified,
                _extension: extension,
            });
        }
    }

    // Sort: directories first, then files, then alphabetically by name (case-insensitive)
    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    entries
}

/// Scans drive letters C:\ through Z:\ on Windows and returns detected drives.
pub fn list_drives() -> Vec<String> {
    let mut drives = Vec::new();
    for c in b'C'..=b'Z' {
        let drive_str = format!("{}:\\", c as char);
        if std::path::Path::new(&drive_str).exists() {
            drives.push(format!("{}:", c as char));
        }
    }
    drives
}

/// Retrieves path pairs for system folders: Desktop, Documents, Downloads, Music, Pictures, Videos.
pub fn get_system_folders() -> Vec<(String, String)> {
    let mut folders = Vec::new();
    let mappings = [
        ("Desktop", dirs::desktop_dir()),
        ("Documents", dirs::document_dir()),
        ("Downloads", dirs::download_dir()),
        ("Music", dirs::audio_dir()),
        ("Pictures", dirs::picture_dir()),
        ("Videos", dirs::video_dir()),
    ];
    for (name, path_opt) in mappings {
        if let Some(path) = path_opt {
            folders.push((name.to_string(), path.to_string_lossy().into_owned()));
        }
    }
    folders
}
