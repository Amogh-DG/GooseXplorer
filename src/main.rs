mod autonamer;
mod db;
mod fs;

use std::rc::Rc;
use std::cell::RefCell;
use slint::Model;
slint::include_modules!();

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct CustomPlace {
    name: String,
    path: String,
}

/// Helper to load custom places from DB and populate the UI property
fn load_custom_places(window: &MainWindow, conn: &rusqlite::Connection) {
    let custom_places_json = db::get_setting(conn, "custom_places");
    let places: Vec<CustomPlace> = if custom_places_json.is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(&custom_places_json).unwrap_or_default()
    };
    
    let slint_places: Vec<SidebarItem> = places
        .into_iter()
        .map(|p| SidebarItem {
            name: p.name.into(),
            path: p.path.into(),
        })
        .collect();
        
    let model = slint::ModelRc::from(std::rc::Rc::new(slint::VecModel::from(slint_places)));
    window.set_custom_places(model);
}

fn add_custom_place(window: &MainWindow, conn: &rusqlite::Connection, path_str: &str) {
    let path_buf = std::path::PathBuf::from(path_str);
    let name = path_buf
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path_str)
        .to_string();
        
    let custom_places_json = db::get_setting(conn, "custom_places");
    let mut places: Vec<CustomPlace> = if custom_places_json.is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(&custom_places_json).unwrap_or_default()
    };
    
    if !places.iter().any(|p| p.path == path_str) {
        places.push(CustomPlace {
            name,
            path: path_str.to_string(),
        });
        if let Ok(serialized) = serde_json::to_string(&places) {
            let _ = db::set_setting(conn, "custom_places", &serialized);
        }
    }
    
    load_custom_places(window, conn);
}

fn remove_custom_place(window: &MainWindow, conn: &rusqlite::Connection, path_str: &str) {
    let custom_places_json = db::get_setting(conn, "custom_places");
    let mut places: Vec<CustomPlace> = if custom_places_json.is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(&custom_places_json).unwrap_or_default()
    };
    
    places.retain(|p| p.path != path_str);
    if let Ok(serialized) = serde_json::to_string(&places) {
        let _ = db::set_setting(conn, "custom_places", &serialized);
    }
    
    load_custom_places(window, conn);
}

fn get_navigation_path(window: &MainWindow) -> std::path::PathBuf {
    if window.get_show_homepage() {
        std::path::PathBuf::from("homepage://")
    } else {
        let current_path_str = window.get_current_path().to_string();
        if current_path_str.starts_with("search results for: ") {
            let query = current_path_str.trim_start_matches("search results for: ");
            std::path::PathBuf::from(format!("search:{}", query))
        } else {
            std::path::PathBuf::from(current_path_str)
        }
    }
}

fn save_and_update_ui(
    conn: &rusqlite::Connection,
    app_state: &RefCell<AppState>,
    window: &MainWindow,
    path: &str,
    description: &str,
    tags: &str,
) {
    if let Err(e) = db::save_file_description_and_tags(conn, path, description, tags) {
        eprintln!("Failed to save description and tags: {}", e);
    }

    let state = app_state.borrow();
    let model = &state.current_model;
    let total_count = model.row_count() as i32;
    let mut untagged_count = 0;

    let tags_vec: Vec<slint::SharedString> = if tags.trim().is_empty() {
        Vec::new()
    } else {
        tags.split(',')
            .map(|t| t.trim().to_string().into())
            .collect()
    };

    for i in 0..model.row_count() {
        if let Some(mut item) = model.row_data(i) {
            if item.path == path {
                item.description = description.to_string().into();
                let tags_model = slint::ModelRc::from(std::rc::Rc::new(slint::VecModel::from(tags_vec.clone())));
                item.tags = tags_model;
                item.is_untagged = tags.trim().is_empty();
                model.set_row_data(i, item.clone());
            }

            if item.is_untagged {
                untagged_count += 1;
            }
        }
    }

    let status_text = format!("{} items  •  {} untagged", total_count, untagged_count);
    window.set_status_text(status_text.into());
}

fn perform_search(
    window: &MainWindow,
    conn: &rusqlite::Connection,
    app_state: &RefCell<AppState>,
    query: &str,
) {
    let results = match db::search_files(conn, query) {
        Ok(res) => res,
        Err(e) => {
            eprintln!("FTS5 search failed: {}", e);
            Vec::new()
        }
    };
    
    let active_tag = window.get_active_tag_filter().to_string();
    let filtered_results: Vec<_> = results
        .into_iter()
        .filter(|res| {
            if active_tag.is_empty() {
                true
            } else {
                let tags_list: Vec<&str> = res.tags.split(',').map(|t| t.trim()).collect();
                tags_list.iter().any(|t| t.eq_ignore_ascii_case(&active_tag))
            }
        })
        .collect();

    let total_count = filtered_results.len() as i32;
    let mut untagged_count = 0;
    
    let slint_files: Vec<FileItem> = filtered_results
        .into_iter()
        .map(|res| {
            let path_obj = std::path::Path::new(&res.path);
            let name = path_obj.file_name().and_then(|n| n.to_str()).unwrap_or(&res.path).to_string();
            let is_dir = path_obj.is_dir();
            let has_tags = !res.tags.trim().is_empty();
            if !has_tags {
                untagged_count += 1;
            }
            
            let size_str = if is_dir {
                "--".to_string()
            } else {
                std::fs::metadata(path_obj)
                    .map(|m| format_size(m.len()))
                    .unwrap_or_else(|_| "0 B".to_string())
            };
            
            let tags_vec: Vec<slint::SharedString> = if res.tags.trim().is_empty() {
                Vec::new()
            } else {
                res.tags
                    .split(',')
                    .map(|t| t.trim().to_string().into())
                    .collect()
            };
            let tags_model = slint::ModelRc::from(std::rc::Rc::new(slint::VecModel::from(tags_vec)));
            
            FileItem {
                name: name.into(),
                path: res.path.into(),
                is_dir,
                size: size_str.into(),
                description: res.description.into(),
                tags: tags_model,
                is_untagged: !has_tags,
            }
        })
        .collect();
        
    let model = std::rc::Rc::new(slint::VecModel::from(slint_files));
    window.set_files(slint::ModelRc::from(model.clone()));
    
    app_state.borrow_mut().current_model = model;
    
    window.set_current_path(format!("search results for: {}", query).into());
    let status_text = format!("{} search results  •  {} untagged", total_count, untagged_count);
    window.set_status_text(status_text.into());
}

fn load_path(
    window: &MainWindow,
    path: &std::path::Path,
    conn: &rusqlite::Connection,
    app_state: &RefCell<AppState>,
) {
    let path_str = path.to_string_lossy();
    if path_str == "homepage://" {
        window.set_show_homepage(true);
        window.set_current_path("".into());
        window.set_files(slint::ModelRc::from(std::rc::Rc::new(slint::VecModel::default())));
    } else if path_str.starts_with("search:") {
        let query = &path_str["search:".len()..];
        window.set_show_homepage(false);
        perform_search(window, conn, app_state, query);
    } else {
        window.set_show_homepage(false);
        load_directory(window, path, conn, app_state);
    }
}

fn refresh_view(
    window: &MainWindow,
    conn: &rusqlite::Connection,
    app_state: &RefCell<AppState>,
) {
    if window.get_show_homepage() {
        return;
    }
    let current_path_str = window.get_current_path().to_string();
    if current_path_str.starts_with("search results for: ") {
        let query = current_path_str.trim_start_matches("search results for: ");
        perform_search(window, conn, app_state, query);
    } else {
        let path = std::path::Path::new(&current_path_str);
        load_directory(window, path, conn, app_state);
    }
}

/// Shared application state containing the active VecModel and navigation history.
struct AppState {
    current_model: Rc<slint::VecModel<FileItem>>,
    history: Vec<std::path::PathBuf>,
    forward_history: Vec<std::path::PathBuf>,
}

/// Helper to format file size in human-readable terms.
fn format_size(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;

    if bytes >= GB {
        format!("{:.1} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.1} KB", bytes as f64 / KB as f64)
    } else {
        format!("{} B", bytes)
    }
}

/// Helper to load a directory's contents, query database metadata, and populate the Slint window.
fn load_directory(
    window: &MainWindow,
    path: &std::path::Path,
    conn: &rusqlite::Connection,
    app_state: &RefCell<AppState>,
) {
    let entries = fs::list_dir(&path.to_string_lossy());
    let active_tag = window.get_active_tag_filter().to_string();
    let mut untagged_count = 0;

    let slint_files: Vec<FileItem> = entries
        .into_iter()
        .map(|entry| {
            let meta = db::get_file_metadata(conn, &entry.path);
            let has_tags = !meta.tags.trim().is_empty();
            if !has_tags {
                untagged_count += 1;
            }

            let size_str = if entry.is_dir {
                "--".to_string()
            } else {
                format_size(entry.size)
            };

            let tags_vec: Vec<slint::SharedString> = if meta.tags.trim().is_empty() {
                Vec::new()
            } else {
                meta.tags
                    .split(',')
                    .map(|t| t.trim().to_string().into())
                    .collect()
            };
            let tags_model = slint::ModelRc::from(std::rc::Rc::new(slint::VecModel::from(tags_vec)));

            FileItem {
                name: entry.name.into(),
                path: entry.path.into(),
                is_dir: entry.is_dir,
                size: size_str.into(),
                description: meta.description.into(),
                tags: tags_model,
                is_untagged: !has_tags,
            }
        })
        .filter(|item| {
            if active_tag.is_empty() {
                true
            } else {
                let meta = db::get_file_metadata(conn, &item.path.to_string());
                let tags_list: Vec<&str> = meta.tags.split(',').map(|t| t.trim()).collect();
                tags_list.iter().any(|t| t.eq_ignore_ascii_case(&active_tag))
            }
        })
        .collect();

    let total_count = slint_files.len() as i32;
    let model = std::rc::Rc::new(slint::VecModel::from(slint_files));
    window.set_files(slint::ModelRc::from(model.clone()));

    // Keep reference in AppState for in-place modifications
    app_state.borrow_mut().current_model = model;

    // Update path and statusbar text
    window.set_current_path(path.to_string_lossy().into_owned().into());
    let status_text = format!("{} items  •  {} untagged", total_count, untagged_count);
    window.set_status_text(status_text.into());
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Initialize the SQLite database (wrapped in Rc for shared reference)
    let conn = Rc::new(db::init_db()?);

    // 2. Initialize the shared application state
    let app_state = Rc::new(RefCell::new(AppState {
        current_model: Rc::new(slint::VecModel::default()),
        history: Vec::new(),
        forward_history: Vec::new(),
    }));

    // 3. Load app_name from settings
    let app_name = db::get_setting(&conn, "app_name");
    let title = if app_name.is_empty() {
        "FileLester".to_string()
    } else {
        app_name
    };

    // 4. Open the Slint window
    let window = MainWindow::new()?;
    window.set_app_name(title.into());
    window.window().set_maximized(true);

    // Load custom places on startup
    load_custom_places(&window, &conn);

    // Get current username and pass to UI
    let username = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "amogh".to_string());
    window.set_username(username.into());

    // Pass system folders list to UI
    let system_folders_vec: Vec<SidebarItem> = fs::get_system_folders()
        .into_iter()
        .map(|(name, path)| SidebarItem {
            name: name.into(),
            path: path.into(),
        })
        .collect();
    let system_folders_model = slint::ModelRc::from(std::rc::Rc::new(slint::VecModel::from(system_folders_vec)));
    window.set_system_folders(system_folders_model);

    // Pass drives list to UI
    let drives_vec: Vec<slint::SharedString> = fs::list_drives()
        .into_iter()
        .map(|d| d.into())
        .collect();
    let drives_model = slint::ModelRc::from(std::rc::Rc::new(slint::VecModel::from(drives_vec)));
    window.set_drives(drives_model);

    // 5. Load Home directory in memory on startup (hidden behind homepage)
    if let Some(home) = dirs::home_dir() {
        load_directory(&window, &home, &conn, &app_state);
    }

    // 6. Setup sidebar navigation callback
    let window_weak = window.as_weak();
    let conn_clone = conn.clone();
    let app_state_sidebar = app_state.clone();
    window.on_sidebar_clicked(move |path_str| {
        let Some(window) = window_weak.upgrade() else { return; };
        let path = std::path::Path::new(path_str.as_str());
        let current_path = get_navigation_path(&window);
        if current_path != path {
            let mut state = app_state_sidebar.borrow_mut();
            state.history.push(current_path);
            state.forward_history.clear();
            window.set_can_go_back(true);
            window.set_can_go_forward(false);
        }
        load_path(&window, path, &conn_clone, &app_state_sidebar);
    });

    // 7. Setup file row click selection callback
    let window_weak = window.as_weak();
    let conn_click = conn.clone();
    window.on_file_clicked(move |path| {
        let Some(window) = window_weak.upgrade() else { return; };
        let path_obj = std::path::Path::new(path.as_str());
        let name = path_obj.file_name().and_then(|n| n.to_str()).unwrap_or("");

        let meta = db::get_file_metadata(&conn_click, path.as_str());

        window.set_selected_file_name(name.into());
        window.set_selected_file_path(path.clone());
        let description_is_empty = meta.description.trim().is_empty();
        window.set_selected_file_description(meta.description.into());
        
        let suggestion = if description_is_empty {
            autonamer::suggest_name(name)
        } else {
            String::new()
        };
        window.set_description_suggestion(suggestion.into());
        
        let tags_str = meta.tags.clone();
        window.set_current_tags(tags_str.clone().into());
        
        let tags_vec: Vec<slint::SharedString> = if tags_str.trim().is_empty() {
            Vec::new()
        } else {
            tags_str
                .split(',')
                .map(|t| t.trim().to_string().into())
                .collect()
        };
        let tags_model = slint::ModelRc::from(std::rc::Rc::new(slint::VecModel::from(tags_vec)));
        window.set_selected_file_tags_list(tags_model);
        
        window.set_show_detail(true);
    });

    // 7.1 Setup folder row click navigation callback
    let window_weak = window.as_weak();
    let conn_folder = conn.clone();
    let app_state_folder = app_state.clone();
    window.on_folder_clicked(move |path| {
        let Some(window) = window_weak.upgrade() else { return; };
        let path_obj = std::path::Path::new(path.as_str());
        let current_path = get_navigation_path(&window);
        
        if current_path != path_obj {
            let mut state = app_state_folder.borrow_mut();
            state.history.push(current_path);
            state.forward_history.clear();
            window.set_can_go_back(true);
            window.set_can_go_forward(false);
        }
        
        load_path(&window, path_obj, &conn_folder, &app_state_folder);
    });

    // 7.2 Setup add tag callback
    let window_weak = window.as_weak();
    let conn_add_tag = conn.clone();
    let app_state_add_tag = app_state.clone();
    window.on_add_tag(move |new_tag| {
        let Some(window) = window_weak.upgrade() else { return; };
        let new_tag_trimmed = new_tag.trim();
        if new_tag_trimmed.is_empty() {
            return;
        }
        let current_tags_str = window.get_current_tags().to_string();
        let updated_tags = if current_tags_str.trim().is_empty() {
            new_tag_trimmed.to_string()
        } else {
            let mut tags: Vec<String> = current_tags_str
                .split(',')
                .map(|t| t.trim().to_string())
                .collect();
            if !tags.contains(&new_tag_trimmed.to_string()) {
                tags.push(new_tag_trimmed.to_string());
            }
            tags.join(",")
        };
        window.set_current_tags(updated_tags.clone().into());
        
        let tags_vec: Vec<slint::SharedString> = updated_tags
            .split(',')
            .map(|t| t.trim().to_string().into())
            .collect();
        let tags_model = slint::ModelRc::from(std::rc::Rc::new(slint::VecModel::from(tags_vec)));
        window.set_selected_file_tags_list(tags_model);

        // Auto-save
        let path = window.get_selected_file_path().to_string();
        let description = window.get_selected_file_description().to_string();
        save_and_update_ui(&conn_add_tag, &app_state_add_tag, &window, &path, &description, &updated_tags);
    });

    // 7.2.1 Setup remove tag callback
    let window_weak = window.as_weak();
    let conn_remove_tag = conn.clone();
    let app_state_remove_tag = app_state.clone();
    window.on_remove_tag(move |tag_to_remove| {
        let Some(window) = window_weak.upgrade() else { return; };
        let current_tags_str = window.get_current_tags().to_string();
        if current_tags_str.trim().is_empty() {
            return;
        }
        let tag_to_remove_trimmed = tag_to_remove.trim();
        let filtered_tags: Vec<&str> = current_tags_str
            .split(',')
            .map(|t| t.trim())
            .filter(|t| !t.is_empty() && *t != tag_to_remove_trimmed)
            .collect();
        let updated_tags = filtered_tags.join(",");
        window.set_current_tags(updated_tags.clone().into());
        
        let tags_vec: Vec<slint::SharedString> = if updated_tags.trim().is_empty() {
            Vec::new()
        } else {
            updated_tags
                .split(',')
                .map(|t| t.trim().to_string().into())
                .collect()
        };
        let tags_model = slint::ModelRc::from(std::rc::Rc::new(slint::VecModel::from(tags_vec)));
        window.set_selected_file_tags_list(tags_model);

        // Auto-save
        let path = window.get_selected_file_path().to_string();
        let description = window.get_selected_file_description().to_string();
        save_and_update_ui(&conn_remove_tag, &app_state_remove_tag, &window, &path, &description, &updated_tags);
    });

    // 7.2.2 Setup add custom place callback
    let window_weak = window.as_weak();
    let conn_add_place = conn.clone();
    window.on_add_custom_place(move |path| {
        let Some(window) = window_weak.upgrade() else { return; };
        add_custom_place(&window, &conn_add_place, path.as_str());
    });

    // 7.2.3 Setup remove custom place callback
    let window_weak = window.as_weak();
    let conn_remove_place = conn.clone();
    window.on_remove_custom_place(move |path| {
        let Some(window) = window_weak.upgrade() else { return; };
        remove_custom_place(&window, &conn_remove_place, path.as_str());
    });

    // 7.3 Setup back click callback
    let window_weak = window.as_weak();
    let conn_back = conn.clone();
    let app_state_back = app_state.clone();
    window.on_back_clicked(move || {
        let Some(window) = window_weak.upgrade() else { return; };
        let current_path = get_navigation_path(&window);
        
        let prev_path = {
            let mut state = app_state_back.borrow_mut();
            if let Some(path) = state.history.pop() {
                state.forward_history.push(current_path);
                window.set_can_go_back(!state.history.is_empty());
                window.set_can_go_forward(true);
                Some(path)
            } else {
                None
            }
        };
        if let Some(path) = prev_path {
            load_path(&window, &path, &conn_back, &app_state_back);
        }
    });

    // 7.4 Setup forward click callback
    let window_weak = window.as_weak();
    let conn_forward = conn.clone();
    let app_state_forward = app_state.clone();
    window.on_forward_clicked(move || {
        let Some(window) = window_weak.upgrade() else { return; };
        let current_path = get_navigation_path(&window);
        
        let next_path = {
            let mut state = app_state_forward.borrow_mut();
            if let Some(path) = state.forward_history.pop() {
                state.history.push(current_path);
                window.set_can_go_back(true);
                window.set_can_go_forward(!state.forward_history.is_empty());
                Some(path)
            } else {
                None
            }
        };
        if let Some(path) = next_path {
            load_path(&window, &path, &conn_forward, &app_state_forward);
        }
    });

    // 8. Setup save callback (saves description and tags, mutates VecModel in-place)
    let window_weak = window.as_weak();
    let conn_save = conn.clone();
    let app_state_save = app_state.clone();
    window.on_save_file(move |path, description, tags| {
        let Some(window) = window_weak.upgrade() else { return; };
        save_and_update_ui(&conn_save, &app_state_save, &window, path.as_str(), description.as_str(), tags.as_str());
    });

    // 8.1 Setup search callback
    let window_weak = window.as_weak();
    let conn_search = conn.clone();
    let app_state_search = app_state.clone();
    window.on_search_query(move |query| {
        let Some(window) = window_weak.upgrade() else { return; };
        let query_str = query.trim();
        if query_str.is_empty() {
            return;
        }
        
        let current_path = get_navigation_path(&window);
        let new_path = std::path::PathBuf::from(format!("search:{}", query_str));
        
        if current_path != new_path {
            let mut state = app_state_search.borrow_mut();
            state.history.push(current_path);
            state.forward_history.clear();
            window.set_can_go_back(true);
            window.set_can_go_forward(false);
        }
        
        load_path(&window, &new_path, &conn_search, &app_state_search);
    });

    // 8.2 Setup double click callback to open files
    window.on_file_double_clicked(move |path| {
        #[cfg(target_os = "windows")]
        {
            let _ = std::process::Command::new("cmd")
                .args(["/C", "start", "", path.as_str()])
                .spawn();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = std::process::Command::new("xdg-open")
                .arg(path.as_str())
                .spawn();
        }
    });

    // 8.3 Setup tag filter callback
    let window_weak = window.as_weak();
    let conn_filter = conn.clone();
    let app_state_filter = app_state.clone();
    window.on_tag_filter_clicked(move || {
        let Some(window) = window_weak.upgrade() else { return; };
        refresh_view(&window, &conn_filter, &app_state_filter);
    });

    // 8.4 Setup debounced description edited callback
    let debounce_timer = Rc::new(RefCell::new(slint::Timer::default()));
    let debounce_timer_clone = debounce_timer.clone();
    let window_weak = window.as_weak();
    let conn_debounce = conn.clone();
    let app_state_debounce = app_state.clone();
    window.on_description_edited(move |new_text| {
        let Some(_window) = window_weak.upgrade() else { return; };
        let conn = conn_debounce.clone();
        let app_state = app_state_debounce.clone();
        let window_weak2 = window_weak.clone();
        let text_to_save = new_text.to_string();
        
        debounce_timer_clone.borrow().start(
            slint::TimerMode::SingleShot,
            std::time::Duration::from_millis(500),
            move || {
                let Some(window) = window_weak2.upgrade() else { return; };
                let path = window.get_selected_file_path().to_string();
                let tags = window.get_current_tags().to_string();
                save_and_update_ui(&conn, &app_state, &window, &path, &text_to_save, &tags);
            }
        );
    });

    // 9. Run the Slint event loop
    window.run()?;

    Ok(())
}
