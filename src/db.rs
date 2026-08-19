use rusqlite::{params, Connection};
use std::fs;

/// Initializes the SQLite database at `~/.moGoosexplorer/data.db`.
/// Creates the files and settings tables, and populates default settings if they do not exist.
pub fn init_db() -> Result<Connection, Box<dyn std::error::Error>> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let db_dir = home.join(".moGoosexplorer");
    fs::create_dir_all(&db_dir)?;
    let db_path = db_dir.join("data.db");
    
    let conn = Connection::open(db_path)?;
    
    conn.execute(
        "CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE,
            description TEXT,
            tags TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );",
        [],
    )?;
    
    conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(path, description, tags, content=files, content_rowid=id);",
        [],
    )?;
    
    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
        [],
    )?;
    
    // Insert default settings
    conn.execute(
        "INSERT OR IGNORE INTO settings (key, value) VALUES ('app_name', 'Goosexplorer');",
        [],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_name', 'true');",
        [],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO settings (key, value) VALUES ('smart_mode', 'false');",
        [],
    )?;
    
    // Migration: Update default app name setting
    conn.execute(
        "UPDATE settings SET value = 'Goosexplorer' WHERE key = 'app_name';",
        [],
    )?;
    
    Ok(conn)
}

/// Retrieves a setting value by key, returning an empty string if it does not exist or fails.
pub fn get_setting(conn: &Connection, key: &str) -> String {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        [key],
        |row| row.get::<_, String>(0),
    )
    .unwrap_or_default()
}

/// Sets or updates a setting key-value pair.
pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![key, value],
    )?;
    Ok(())
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct FileMetadata {
    pub description: String,
    pub tags: String,
}

/// Retrieves a file's description and tags from the database.
/// Returns default/empty values if the file path is not found.
pub fn get_file_metadata(conn: &Connection, path: &str) -> FileMetadata {
    conn.query_row(
        "SELECT description, tags FROM files WHERE path = ?1",
        [path],
        |row| {
            Ok(FileMetadata {
                description: row.get(0).unwrap_or_default(),
                tags: row.get(1).unwrap_or_default(),
            })
        },
    )
    .unwrap_or(FileMetadata {
        description: String::new(),
        tags: String::new(),
    })
}

/// Saves or updates both the description and tags of a file in the database.
pub fn save_file_description_and_tags(
    conn: &Connection,
    path: &str,
    description: &str,
    tags: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT OR REPLACE INTO files (path, description, tags) VALUES (?1, ?2, ?3);",
        params![path, description, tags],
    )?;
    conn.execute(
        "INSERT INTO files_fts(files_fts) VALUES('rebuild');",
        [],
    )?;
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SearchResult {
    pub path: String,
    pub description: String,
    pub tags: String,
}

/// Searches the FTS5 virtual table for matching files.
pub fn search_files(conn: &Connection, query: &str) -> Result<Vec<SearchResult>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT path, description, tags FROM files_fts WHERE files_fts MATCH ?1"
    )?;
    let rows = stmt.query_map([query], |row| {
        Ok(SearchResult {
            path: row.get(0).unwrap_or_default(),
            description: row.get(1).unwrap_or_default(),
            tags: row.get(2).unwrap_or_default(),
        })
    })?;
    
    let mut results = Vec::new();
    for row in rows {
        if let Ok(res) = row {
            results.push(res);
        }
    }
    Ok(results)
}


