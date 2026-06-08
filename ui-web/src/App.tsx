import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface RustFileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  _modified: string;
  _extension: string;
}

interface FileEntryWithMeta {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  _modified: string;
  _extension: string;
  description: string;
  tags: string[];
  is_untagged: boolean;
}

interface SidebarItem {
  name: string;
  path: string;
}

interface FileMetadata {
  description: string;
  tags: string;
}

interface SearchResult {
  path: string;
  description: string;
  tags: string;
}

const appWindow = getCurrentWindow();

export default function App() {
  const [appName, setAppName] = useState("FileLester");
  const [username, setUsername] = useState("amogh");
  const [showHomepage, setShowHomepage] = useState(true);
  const [currentPath, setCurrentPath] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [forwardHistory, setForwardHistory] = useState<string[]>([]);
  
  // Sidebar data
  const [systemFolders, setSystemFolders] = useState<SidebarItem[]>([]);
  const [customPlaces, setCustomPlaces] = useState<SidebarItem[]>([]);
  const [drives, setDrives] = useState<string[]>([]);
  const [activeNav, setActiveNav] = useState("Home");
  const [showAddPlaceInput, setShowAddPlaceInput] = useState(false);
  const [newPlacePath, setNewPlacePath] = useState("");

  // Files data
  const [files, setFiles] = useState<FileEntryWithMeta[]>([]);
  const [allLoadedFiles, setAllLoadedFiles] = useState<FileEntryWithMeta[]>([]);
  const [activeTagFilter, setActiveTagFilter] = useState("");

  // Selected file details
  const [selectedFile, setSelectedFile] = useState<FileEntryWithMeta | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [descriptionSuggestion, setDescriptionSuggestion] = useState("");
  const [descriptionInput, setDescriptionInput] = useState("");
  const [currentTagsList, setCurrentTagsList] = useState<string[]>([]);
  const [newTagInput, setNewTagInput] = useState("");
  const [showTagInput, setShowTagInput] = useState(false);

  // Search
  const [searchQuery, setSearchQuery] = useState("");

  // Hidden paths
  const [hiddenPaths, setHiddenPaths] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);

  // Context menu
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [contextMenuFile, setContextMenuFile] = useState<FileEntryWithMeta | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Mini terminal
  const [showTerminal, setShowTerminal] = useState(false);
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalLines, setTerminalLines] = useState<{ text: string; type: "cmd" | "out" | "err" | "info" }[]>([]);
  const [, setCmdHistory] = useState<string[]>([]);
  const [cmdHistoryIdx, setCmdHistoryIdx] = useState(-1);
  const terminalOutputRef = useRef<HTMLDivElement>(null);
  const terminalInputRef = useRef<HTMLInputElement>(null);

  // Load initial settings and lists
  useEffect(() => {
    const initData = async () => {
      try {
        const sysFolders = await invoke<SidebarItem[]>("get_system_folders");
        setSystemFolders(sysFolders);
        
        const drvs = await invoke<string[]>("get_drives");
        setDrives(drvs);

        const customPlacesSetting = await invoke<string>("get_setting", { key: "custom_places" });
        if (customPlacesSetting) {
          try {
            setCustomPlaces(JSON.parse(customPlacesSetting));
          } catch {
            setCustomPlaces([]);
          }
        }

        const appNm = await invoke<string>("get_setting", { key: "app_name" });
        if (appNm) setAppName(appNm);

        // Fetch user setting or fallback
        const usr = await invoke<string>("get_setting", { key: "username" });
        if (usr) setUsername(usr);

        // Load hidden paths
        const hiddenSetting = await invoke<string>("get_setting", { key: "hidden_paths" });
        if (hiddenSetting) {
          try {
            const arr: string[] = JSON.parse(hiddenSetting);
            setHiddenPaths(new Set(arr));
          } catch { /* ignore */ }
        }
      } catch (e) {
        console.error("Initialization failed:", e);
      }
    };

    initData();
  }, []);

  // Fetch file list with database metadata
  const loadDirectory = async (path: string) => {
    try {
      const rawEntries = await invoke<RustFileEntry[]>("list_dir", { path });
      const entriesWithMeta = await Promise.all(
        rawEntries.map(async (entry) => {
          const meta = await invoke<FileMetadata>("get_file_meta", { path: entry.path });
          const tags = meta.tags
            ? meta.tags.split(",").map((t) => t.trim()).filter(Boolean)
            : [];
          return {
            ...entry,
            description: meta.description || "",
            tags,
            is_untagged: tags.length === 0,
          };
        })
      );
      setAllLoadedFiles(entriesWithMeta);
      setFiles(filterFiles(entriesWithMeta, activeTagFilter, hiddenPaths, showHidden));
    } catch (e) {
      console.error(`Failed to load directory: ${path}`, e);
    }
  };

  // Perform full-text search
  const performSearch = async (query: string) => {
    try {
      const results = await invoke<SearchResult[]>("search_files", { query });
      const entriesWithMeta = await Promise.all(
        results.map(async (res) => {
          const name = res.path.split(/[/\\]/).pop() || res.path;
          const tags = res.tags
            ? res.tags.split(",").map((t) => t.trim()).filter(Boolean)
            : [];
          // Ask Rust whether this path is a directory so double-click navigates correctly
          const is_dir = await invoke<boolean>("path_is_dir", { path: res.path }).catch(() => false);
          return {
            name,
            path: res.path,
            is_dir,
            size: 0,
            _modified: "",
            _extension: name.split(".").pop() || "",
            description: res.description || "",
            tags,
            is_untagged: tags.length === 0,
          };
        })
      );
      setAllLoadedFiles(entriesWithMeta);
      setFiles(filterFiles(entriesWithMeta, activeTagFilter, hiddenPaths, showHidden));
    } catch (e) {
      console.error(`Search failed: ${query}`, e);
    }
  };

  // Helper to filter files locally by tag (and hidden)
  const filterFiles = (list: FileEntryWithMeta[], tag: string, hidden: Set<string>, revealHidden: boolean) => {
    let result = revealHidden ? list : list.filter((f) => !hidden.has(f.path));
    if (tag) result = result.filter((f) => f.tags.some((t) => t.toLowerCase() === tag.toLowerCase()));
    return result;
  };

  // Re-apply filter when activeTagFilter / hiddenPaths / showHidden changes
  useEffect(() => {
    setFiles(filterFiles(allLoadedFiles, activeTagFilter, hiddenPaths, showHidden));
  }, [activeTagFilter, allLoadedFiles, hiddenPaths, showHidden]);

  // Navigate to path
  const navigateTo = async (path: string, isSearch: boolean = false) => {
    if (showHomepage) {
      setHistory((prev) => [...prev, "homepage://"]);
    } else {
      setHistory((prev) => [...prev, currentPath]);
    }
    setForwardHistory([]); // Clear forward stack

    if (isSearch) {
      setShowHomepage(false);
      setCurrentPath(`search results for: ${path}`);
      await performSearch(path);
    } else {
      setShowHomepage(false);
      setCurrentPath(path);
      await loadDirectory(path);
    }
  };

  // Handle Back Click
  const handleBack = async () => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory((prevStack) => prevStack.slice(0, -1));

    if (showHomepage) {
      setForwardHistory((prevStack) => [...prevStack, "homepage://"]);
    } else {
      setForwardHistory((prevStack) => [...prevStack, currentPath]);
    }

    if (prev === "homepage://" || prev === "") {
      setShowHomepage(true);
      setCurrentPath("");
      setFiles([]);
    } else if (prev.startsWith("search results for: ")) {
      setShowHomepage(false);
      setCurrentPath(prev);
      const query = prev.replace("search results for: ", "");
      await performSearch(query);
    } else {
      setShowHomepage(false);
      setCurrentPath(prev);
      await loadDirectory(prev);
    }
  };

  // Handle Forward Click
  const handleForward = async () => {
    if (forwardHistory.length === 0) return;
    const next = forwardHistory[forwardHistory.length - 1];
    setForwardHistory((prevStack) => prevStack.slice(0, -1));

    if (showHomepage) {
      setHistory((prevStack) => [...prevStack, "homepage://"]);
    } else {
      setHistory((prevStack) => [...prevStack, currentPath]);
    }

    if (next === "homepage://" || next === "") {
      setShowHomepage(true);
      setCurrentPath("");
      setFiles([]);
    } else if (next.startsWith("search results for: ")) {
      setShowHomepage(false);
      setCurrentPath(next);
      const query = next.replace("search results for: ", "");
      await performSearch(query);
    } else {
      setShowHomepage(false);
      setCurrentPath(next);
      await loadDirectory(next);
    }
  };

  // Store handlers in ref for global mouse/keybind event listeners
  const navigationRef = useRef({
    history,
    forwardHistory,
    showHomepage,
    currentPath,
    handleBack,
    handleForward,
    showDetail,
    setShowDetail,
    setShowTerminal,
  });

  useEffect(() => {
    navigationRef.current = {
      history,
      forwardHistory,
      showHomepage,
      currentPath,
      handleBack,
      handleForward,
      showDetail,
      setShowDetail,
      setShowTerminal,
    };
  });

  // Setup global event listeners for Back/Forward mouse buttons and Q keybind
  useEffect(() => {
    const handleMouseUp = (e: MouseEvent) => {
      if (e.button === 3) {
        // mouse back
        e.preventDefault();
        navigationRef.current.handleBack();
      } else if (e.button === 4) {
        // mouse forward
        e.preventDefault();
        navigationRef.current.handleForward();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // Shift + ` opens/closes the mini terminal
      if (e.code === "Backquote" && e.shiftKey) {
        e.preventDefault();
        navigationRef.current.setShowTerminal((prev: boolean) => !prev);
        return;
      }
      if (e.key === "q" || e.key === "Q") {
        const activeEl = document.activeElement;
        if (activeEl && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA")) {
          return;
        }
        // Toggle: open panel if a file is selected, close if already open
        navigationRef.current.setShowDetail(
          (prev: boolean) => !prev
        );
      }
    };

    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  // Format File Size
  const formatSize = (bytes: number, isDir: boolean): string => {
    if (isDir) return "--";
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  // Handle click on file entry — selects item but does NOT open panel (press Q to open)
  const handleFileClick = async (file: FileEntryWithMeta) => {
    setSelectedFile(file);
    setShowDetail(false); // panel stays closed; Q will open it
    setDescriptionInput(file.description);
    setCurrentTagsList(file.tags);

    // Fetch suggestion
    try {
      const suggestion = await invoke<string>("suggest_name", { filename: file.name });
      setDescriptionSuggestion(suggestion);
    } catch {
      setDescriptionSuggestion("");
    }
  };

  // Handle double click on file entry
  const handleFileDoubleClick = async (file: FileEntryWithMeta) => {
    if (file.is_dir) {
      setActiveNav("");
      await navigateTo(file.path);
    } else {
      try {
        await invoke("open_file", { path: file.path });
      } catch (e) {
        console.error("Failed to open file", e);
      }
    }
  };

  // 500ms Debounce auto-save description
  useEffect(() => {
    if (!selectedFile) return;
    if (descriptionInput === selectedFile.description) return;

    const timer = setTimeout(async () => {
      try {
        await invoke("save_file_meta", {
          path: selectedFile.path,
          description: descriptionInput,
          tags: currentTagsList.join(","),
        });

        // Update local arrays
        const update = (f: FileEntryWithMeta) =>
          f.path === selectedFile.path ? { ...f, description: descriptionInput } : f;

        setAllLoadedFiles((prev) => prev.map(update));
        setSelectedFile((prev) => (prev ? { ...prev, description: descriptionInput } : null));
      } catch (e) {
        console.error("Failed to auto-save description:", e);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [descriptionInput, selectedFile, currentTagsList]);

  // Save on blur description field
  const handleDescriptionBlur = async () => {
    if (!selectedFile) return;
    try {
      await invoke("save_file_meta", {
        path: selectedFile.path,
        description: descriptionInput,
        tags: currentTagsList.join(","),
      });
      const update = (f: FileEntryWithMeta) =>
        f.path === selectedFile.path ? { ...f, description: descriptionInput } : f;
      setAllLoadedFiles((prev) => prev.map(update));
    } catch (e) {
      console.error(e);
    }
  };

  // Add tag
  const handleAddTag = async (tag: string) => {
    if (!selectedFile || !tag.trim()) return;
    const trimmed = tag.trim();
    if (currentTagsList.includes(trimmed)) {
      setNewTagInput("");
      setShowTagInput(false);
      return;
    }

    const updated = [...currentTagsList, trimmed];
    setCurrentTagsList(updated);
    setNewTagInput("");
    setShowTagInput(false);

    try {
      await invoke("save_file_meta", {
        path: selectedFile.path,
        description: descriptionInput,
        tags: updated.join(","),
      });

      const update = (f: FileEntryWithMeta) =>
        f.path === selectedFile.path ? { ...f, tags: updated, is_untagged: false } : f;
      setAllLoadedFiles((prev) => prev.map(update));
      setSelectedFile((prev) => (prev ? { ...prev, tags: updated } : null));
    } catch (e) {
      console.error(e);
    }
  };

  // Delete tag
  const handleDeleteTag = async (tagToDelete: string) => {
    if (!selectedFile) return;
    const updated = currentTagsList.filter((t) => t !== tagToDelete);
    setCurrentTagsList(updated);

    try {
      await invoke("save_file_meta", {
        path: selectedFile.path,
        description: descriptionInput,
        tags: updated.join(","),
      });

      const update = (f: FileEntryWithMeta) =>
        f.path === selectedFile.path
          ? { ...f, tags: updated, is_untagged: updated.length === 0 }
          : f;
      setAllLoadedFiles((prev) => prev.map(update));
      setSelectedFile((prev) => (prev ? { ...prev, tags: updated } : null));
    } catch (e) {
      console.error(e);
    }
  };

  // Add custom place
  const handleAddCustomPlace = async (path: string) => {
    if (!path.trim()) return;
    const name = path.split(/[/\\]/).pop() || path;
    const updated = [...customPlaces, { name, path }];
    setCustomPlaces(updated);
    setNewPlacePath("");
    setShowAddPlaceInput(false);

    try {
      await invoke("set_setting", { key: "custom_places", value: JSON.stringify(updated) });
    } catch (e) {
      console.error(e);
    }
  };

  // Remove custom place
  const handleRemoveCustomPlace = async (path: string) => {
    const updated = customPlaces.filter((p) => p.path !== path);
    setCustomPlaces(updated);

    try {
      await invoke("set_setting", { key: "custom_places", value: JSON.stringify(updated) });
    } catch (e) {
      console.error(e);
    }
  };

  // native tauri window action wrappers with error bounds
  const winClose = () => {
    try {
      appWindow.close();
    } catch (e) {
      console.error(e);
    }
  };
  const winMinimize = () => {
    try {
      appWindow.minimize();
    } catch (e) {
      console.error(e);
    }
  };
  const winToggleMaximize = () => {
    try {
      appWindow.toggleMaximize();
    } catch (e) {
      console.error(e);
    }
  };

  // Sidebar Folder click
  const handleSidebarClick = async (folder: SidebarItem) => {
    setActiveNav(folder.name);
    await navigateTo(folder.path);
  };

  // Sidebar Drive click
  const handleDriveClick = async (drive: string) => {
    setActiveNav(drive);
    await navigateTo(drive + "\\");
  };

  // Sidebar Tag click
  const handleTagClick = (tag: string) => {
    if (activeTagFilter === tag) {
      setActiveTagFilter("");
    } else {
      setActiveTagFilter(tag);
    }
  };

  // Titlebar search button click
  const handleTitlebarSearchClick = () => {
    setShowHomepage(true);
    setCurrentPath("");
    setFiles([]);
    setAllLoadedFiles([]);
    setSelectedFile(null);
    setShowDetail(false);
  };

  // Calculate status bar counts
  const totalCount = files.length;
  const untaggedCount = files.filter((f) => f.is_untagged).length;

  // Context menu handlers
  const handleContextMenu = (e: React.MouseEvent, file?: FileEntryWithMeta) => {
    if (showHomepage || !currentPath) return;
    e.preventDefault();
    e.stopPropagation();
    setContextMenuFile(file ?? null);
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const closeContextMenu = () => {
    setContextMenu(null);
    setContextMenuFile(null);
  };

  const handleOpenPowershell = async () => {
    closeContextMenu();
    try {
      await invoke("open_in_powershell", { path: currentPath });
    } catch (e) {
      console.error("Failed to open PowerShell:", e);
    }
  };

  const handleOpenLazyvim = async () => {
    closeContextMenu();
    try {
      await invoke("open_in_lazyvim", { path: currentPath });
    } catch (e) {
      console.error("Failed to open LazyVim:", e);
    }
  };

  const saveHiddenPaths = async (updated: Set<string>) => {
    setHiddenPaths(updated);
    try {
      await invoke("set_setting", { key: "hidden_paths", value: JSON.stringify([...updated]) });
    } catch (e) {
      console.error("Failed to save hidden paths:", e);
    }
  };

  const handleHide = async () => {
    if (!contextMenuFile) return;
    closeContextMenu();
    const updated = new Set(hiddenPaths);
    updated.add(contextMenuFile.path);
    await saveHiddenPaths(updated);
  };

  const handleUnhide = async () => {
    if (!contextMenuFile) return;
    closeContextMenu();
    const updated = new Set(hiddenPaths);
    updated.delete(contextMenuFile.path);
    await saveHiddenPaths(updated);
  };

  // Auto-scroll terminal output to bottom when new lines arrive
  useEffect(() => {
    if (terminalOutputRef.current) {
      terminalOutputRef.current.scrollTop = terminalOutputRef.current.scrollHeight;
    }
  }, [terminalLines]);

  // Focus terminal input when it opens
  useEffect(() => {
    if (showTerminal) {
      setTimeout(() => terminalInputRef.current?.focus(), 50);
    }
  }, [showTerminal]);

  const addLine = (text: string, type: "cmd" | "out" | "err" | "info") => {
    setTerminalLines((prev) => [...prev, { text, type }]);
  };

  const runTerminalCommand = async (cmd: string) => {
    const trimmed = cmd.trim();
    if (!trimmed) return;

    // Push to history
    setCmdHistory((prev) => [...prev, trimmed]);
    setCmdHistoryIdx(-1);
    addLine(`> ${trimmed}`, "cmd");

    // --- Custom commands ---

    // unhide all — only unhides items in the current directory
    if (trimmed === "unhide all") {
      const prefix = currentPath ? currentPath.replace(/[/\\]+$/, "") : "";
      const updated = new Set([...hiddenPaths].filter((p) => {
        const parent = p.replace(/[/\\][^/\\]+$/, "");
        return parent !== prefix;
      }));
      setHiddenPaths(updated);
      setShowHidden(false);
      try {
        await invoke("set_setting", { key: "hidden_paths", value: JSON.stringify([...updated]) });
      } catch { /* ignore */ }
      addLine(`Unhid all items in ${prefix || "current directory"}.`, "info");
      return;
    }

    // unhide <name> — unhide specific item by name in current dir
    const unhideMatch = trimmed.match(/^unhide\s+(.+)$/i);
    if (unhideMatch) {
      const name = unhideMatch[1].trim();
      const target = allLoadedFiles.find((f) => f.name.toLowerCase() === name.toLowerCase());
      if (target) {
        const updated = new Set(hiddenPaths);
        updated.delete(target.path);
        setHiddenPaths(updated);
        try {
          await invoke("set_setting", { key: "hidden_paths", value: JSON.stringify([...updated]) });
        } catch { /* ignore */ }
        addLine(`Unhid "${target.name}".`, "info");
      } else {
        addLine(`Not found in current directory: "${name}"`, "err");
      }
      return;
    }

    // hide <name> — hide specific item by name in current dir
    const hideMatch = trimmed.match(/^hide\s+(.+)$/i);
    if (hideMatch) {
      const name = hideMatch[1].trim();
      const target = allLoadedFiles.find((f) => f.name.toLowerCase() === name.toLowerCase());
      if (target) {
        const updated = new Set(hiddenPaths);
        updated.add(target.path);
        setHiddenPaths(updated);
        try {
          await invoke("set_setting", { key: "hidden_paths", value: JSON.stringify([...updated]) });
        } catch { /* ignore */ }
        addLine(`Hid "${target.name}".`, "info");
      } else {
        addLine(`Not found in current directory: "${name}"`, "err");
      }
      return;
    }

    // unhide (no args) — same as unhide all
    if (trimmed === "unhide") {
      setHiddenPaths(new Set());
      setShowHidden(false);
      try {
        await invoke("set_setting", { key: "hidden_paths", value: "[]" });
      } catch { /* ignore */ }
      addLine("All hidden items are now visible (globally).", "info");
      return;
    }

    if (trimmed === "clear") {
      setTerminalLines([]);
      return;
    }
    if (trimmed === "hidden?") {
      const prefix = currentPath ? currentPath.replace(/[/\\]+$/, "") : "";
      const localHidden = [...hiddenPaths].filter((p) => {
        const parent = p.replace(/[/\\][^/\\]+$/, "");
        return parent === prefix;
      });
      if (localHidden.length === 0) {
        addLine("No hidden items in this directory.", "info");
      } else {
        addLine(`${localHidden.length} hidden in current directory:`, "info");
        localHidden.forEach((p) => addLine(`  ${p.split(/[/\\]/).pop()}`, "out"));
      }
      return;
    }
    if (trimmed === "help") {
      addLine("Custom commands:", "info");
      addLine("  hide <name>       — hide item by name in current dir", "info");
      addLine("  unhide <name>     — unhide item by name in current dir", "info");
      addLine("  unhide all        — unhide all items in current dir", "info");
      addLine("  unhide            — unhide everything globally", "info");
      addLine("  hidden?           — list all hidden paths", "info");
      addLine("  clear             — clear terminal", "info");
      addLine("  help              — show this", "info");
      addLine("Everything else runs in PowerShell.", "info");
      return;
    }

    // --- Run in PowerShell ---
    const cwd = currentPath.startsWith("search results") || !currentPath ? "C:\\" : currentPath;
    try {
      const result = await invoke<string>("run_shell_command", { command: trimmed, cwd });
      const lines = result.trim().split("\n").filter(Boolean);
      lines.forEach((l) => addLine(l.trimEnd(), "out"));
      if (lines.length === 0) addLine("(no output)", "info");
    } catch (e) {
      String(e).split("\n").filter(Boolean).forEach((l) => addLine(l.trimEnd(), "err"));
    } finally {
      // Refresh the file list so any fs changes show up immediately
      if (currentPath && !currentPath.startsWith("search results") && !showHomepage) {
        await loadDirectory(currentPath);
      }
    }
  };

  return (
    <div
      className="h-screen w-screen flex flex-col bg-darkBg text-white font-sans overflow-hidden select-none"
      onClick={closeContextMenu}
      onContextMenu={handleContextMenu}
    >
      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg shadow-2xl py-1 min-w-[190px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Directory actions — always shown */}
          <button
            onClick={handleOpenPowershell}
            className="w-full text-left px-4 py-2 text-[12px] text-[#cccccc] hover:bg-[#272727] hover:text-white flex items-center gap-2.5 transition duration-100"
          >
            <span className="text-[#5dcaa5] font-bold text-[13px]">›_</span>
            Open in PowerShell
          </button>
          <button
            onClick={handleOpenLazyvim}
            className="w-full text-left px-4 py-2 text-[12px] text-[#cccccc] hover:bg-[#272727] hover:text-white flex items-center gap-2.5 transition duration-100"
          >
            <span className="text-[#57a6f0] font-bold text-[13px]">ν</span>
            Open in LazyVim
          </button>

          {/* File/folder-specific actions */}
          {contextMenuFile && (
            <>
              <div className="my-1 border-t border-[#2a2a2a]" />
              {hiddenPaths.has(contextMenuFile.path) ? (
                <button
                  onClick={handleUnhide}
                  className="w-full text-left px-4 py-2 text-[12px] text-[#cccccc] hover:bg-[#272727] hover:text-white flex items-center gap-2.5 transition duration-100"
                >
                  <span className="text-[#888888] text-[13px]">◎</span>
                  Unhide
                </button>
              ) : (
                <button
                  onClick={handleHide}
                  className="w-full text-left px-4 py-2 text-[12px] text-[#aaaaaa] hover:bg-[#272727] hover:text-red-400 flex items-center gap-2.5 transition duration-100"
                >
                  <span className="text-[13px]">⊘</span>
                  Hide
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* Mini Terminal — Shift+` to toggle */}
      {showTerminal && (
        <div
          className="fixed bottom-4 right-4 z-50 w-[440px] bg-[#0d0d0d] border border-[#222222] rounded-xl shadow-2xl flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-3.5 py-2 bg-[#111111] border-b border-[#1e1e1e] shrink-0">
            <span className="text-[10px] text-[#3a3a3a] font-bold tracking-[0.15em] font-mono uppercase">terminal</span>
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-[#444444] font-mono truncate max-w-[260px]">
                {currentPath && !currentPath.startsWith("search") ? currentPath : "~"}
              </span>
              <button
                onClick={() => setShowTerminal(false)}
                className="text-[#333333] hover:text-[#777777] text-base leading-none transition"
              >
                ×
              </button>
            </div>
          </div>

          {/* Output */}
          <div
            ref={terminalOutputRef}
            className="h-[190px] overflow-y-auto px-3.5 py-2.5 flex flex-col gap-[2px] font-mono"
          >
            {terminalLines.length === 0 && (
              <span className="text-[11px] text-[#3a3a3a] font-mono">
                {currentPath && !currentPath.startsWith("search") ? currentPath : "~"}
              </span>
            )}
            {terminalLines.map((line, i) => (
              <div
                key={i}
                className={`text-[11px] leading-relaxed whitespace-pre-wrap break-all ${
                  line.type === "cmd" ? "text-[#5dcaa5]" :
                  line.type === "err" ? "text-[#e24b4a]" :
                  line.type === "info" ? "text-[#57a6f0]" :
                  "text-[#d4d4d4]"
                }`}
              >
                {line.text}
              </div>
            ))}
          </div>

          {/* Input row */}
          <div className="flex items-center gap-2 px-3.5 py-2 border-t border-[#1a1a1a] bg-[#0a0a0a] shrink-0">
            <span className="text-[#5dcaa5] text-[13px] font-mono shrink-0">›</span>
            <input
              ref={terminalInputRef}
              value={terminalInput}
              onChange={(e) => {
                setTerminalInput(e.target.value);
                setCmdHistoryIdx(-1);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  runTerminalCommand(terminalInput);
                  setTerminalInput("");
                } else if (e.key === "Escape") {
                  setShowTerminal(false);
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setCmdHistory((hist) => {
                    const nextIdx = cmdHistoryIdx < hist.length - 1 ? cmdHistoryIdx + 1 : hist.length - 1;
                    setCmdHistoryIdx(nextIdx);
                    setTerminalInput(hist[hist.length - 1 - nextIdx] ?? "");
                    return hist;
                  });
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setCmdHistory((hist) => {
                    const nextIdx = cmdHistoryIdx > 0 ? cmdHistoryIdx - 1 : -1;
                    setCmdHistoryIdx(nextIdx);
                    setTerminalInput(nextIdx === -1 ? "" : hist[hist.length - 1 - nextIdx] ?? "");
                    return hist;
                  });
                }
              }}
              placeholder="command..."
              className="flex-1 bg-transparent text-[#cccccc] text-[12px] font-mono outline-none placeholder-[#252525]"
            />
          </div>
        </div>
      )}

      {/* 1. Draggable Titlebar (32px) */}
      <header
        data-tauri-drag-region
        className="h-8 bg-darkHeader flex items-center px-4 justify-between border-b border-borderDark select-none relative shrink-0"
      >
        {/* Left macOS Control Dots & Search Button */}
        <div className="flex items-center gap-2 z-10">
          <div className="flex items-center gap-1.5 mr-2">
            <button
              onClick={winClose}
              className="w-3 h-3 rounded-full bg-[#e24b4a] hover:brightness-75 transition"
              title="Close"
            />
            <button
              onClick={winMinimize}
              className="w-3 h-3 rounded-full bg-[#ef9f27] hover:brightness-75 transition"
              title="Minimize"
            />
            <button
              onClick={winToggleMaximize}
              className="w-3 h-3 rounded-full bg-[#5dcaa5] hover:brightness-75 transition"
              title="Maximize"
            />
          </div>
          
          <button
            onClick={handleTitlebarSearchClick}
            className="bg-[#1a1a1a] hover:bg-[#252525] border border-borderDark rounded px-2.5 py-0.5 text-[#666666] text-[11px] transition duration-200 flex items-center gap-1 select-none font-medium"
          >
            <span>⌕</span> search
          </button>
        </div>

        {/* Centered Application Title */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-[12px] text-[#666666] font-medium tracking-wide">
            {appName}
          </span>
        </div>

        {/* Right spacing */}
        <div className="w-[120px]" />
      </header>

      {/* Main app body */}
      <div className="flex-1 flex overflow-hidden w-full">
        {/* 2. Left Sidebar (200px) */}
        <aside className="w-[200px] bg-darkPanel border-r border-borderDark flex flex-col p-4 gap-4 overflow-y-auto shrink-0 select-none">
          {/* PLACES Section */}
          <div className="flex flex-col gap-1.5">
            <h3 className="text-[10px] text-[#555555] font-bold tracking-wider mb-1">
              PLACES
            </h3>
            {systemFolders.map((folder) => (
              <button
                key={folder.name}
                onClick={() => handleSidebarClick(folder)}
                className={`w-full text-left px-2.5 py-1.5 rounded-md text-[12px] transition duration-150 ${
                  activeNav === folder.name
                    ? "bg-[#252525] text-white"
                    : "text-[#aaaaaa] hover:bg-[#222222] hover:text-white"
                }`}
              >
                {folder.name}
              </button>
            ))}

            {/* Custom Places */}
            {customPlaces.map((folder) => (
              <div
                key={folder.path}
                className={`group flex items-center justify-between rounded-md text-[12px] px-2.5 py-1.5 transition duration-150 ${
                  activeNav === folder.name
                    ? "bg-[#252525] text-white"
                    : "text-[#aaaaaa] hover:bg-[#222222] hover:text-white"
                }`}
              >
                <button
                  onClick={() => handleSidebarClick(folder)}
                  className="flex-1 text-left truncate mr-2"
                >
                  {folder.name}
                </button>
                <button
                  onClick={() => handleRemoveCustomPlace(folder.path)}
                  className="opacity-0 group-hover:opacity-100 hover:text-red-400 text-gray-500 text-sm font-semibold transition"
                >
                  &times;
                </button>
              </div>
            ))}

            {/* Add Custom Place Button */}
            {!showAddPlaceInput ? (
              <button
                onClick={() => setShowAddPlaceInput(true)}
                className="w-full mt-1 border border-borderDark border-dashed hover:border-gray-500 rounded px-2.5 py-1 text-[#aaaaaa] hover:text-white text-[11px] transition text-center select-none"
              >
                + add folder
              </button>
            ) : (
              <div className="mt-1 flex flex-col border border-borderDark rounded bg-[#1e1e1e] p-1.5 gap-1.5">
                <input
                  type="text"
                  autoFocus
                  placeholder="enter path..."
                  value={newPlacePath}
                  onChange={(e) => setNewPlacePath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddCustomPlace(newPlacePath);
                    if (e.key === "Escape") setShowAddPlaceInput(false);
                  }}
                  className="w-full bg-[#121212] text-white text-[11px] px-1.5 py-0.5 rounded outline-none border border-borderDark focus:border-gray-600"
                />
                <div className="flex justify-end gap-1">
                  <button
                    onClick={() => setShowAddPlaceInput(false)}
                    className="text-[10px] text-gray-500 hover:text-white px-1 py-0.5"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => handleAddCustomPlace(newPlacePath)}
                    className="text-[10px] text-purple-400 hover:text-purple-300 font-semibold px-1 py-0.5"
                  >
                    Add
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* DRIVES Section */}
          <div className="flex flex-col gap-1.5">
            <h3 className="text-[10px] text-[#555555] font-bold tracking-wider mb-1">
              DRIVES
            </h3>
            {drives.map((drive) => (
              <button
                key={drive}
                onClick={() => handleDriveClick(drive)}
                className={`w-full text-left px-2.5 py-1.5 rounded-md text-[12px] transition duration-150 ${
                  activeNav === drive
                    ? "bg-[#252525] text-white"
                    : "text-[#aaaaaa] hover:bg-[#222222] hover:text-white"
                }`}
              >
                {drive}
              </button>
            ))}
          </div>

          {/* TAGS Section */}
          <div className="flex flex-col gap-1.5">
            <h3 className="text-[10px] text-[#555555] font-bold tracking-wider mb-1">
              TAGS
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {["Work", "Personal", "Archive", "Receipts"].map((tag) => {
                const isActive = activeTagFilter === tag;
                return (
                  <button
                    key={tag}
                    onClick={() => handleTagClick(tag)}
                    className={`px-3 py-1 rounded-full text-[11px] font-medium border transition duration-150 ${
                      isActive
                        ? "bg-[#1e1b2e] border-[#534ab7] text-[#afa9ec]"
                        : "bg-[#252525] border-[#333333] text-[#888888] hover:text-white"
                    }`}
                  >
                    {tag}
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        {/* 3. Main File / Homepage panel (fills space) */}
        <main className="flex-1 flex flex-col overflow-hidden bg-darkBg">
          {showHomepage ? (
            /* Homepage View */
            <div className="flex-1 flex flex-col items-center justify-center p-8 select-none">
              <h1 className="text-[#dddddd] text-3xl font-medium mb-1">
                hi there, {username}
              </h1>
              <p className="text-[#555555] text-base mb-6 font-medium">
                what are you looking for?
              </p>
              
              <div className="w-[500px] h-11 bg-[#252525] border border-[#333333] rounded-xl flex items-center px-4 shadow-lg focus-within:border-gray-500 transition duration-150">
                <input
                  type="text"
                  placeholder="describe a file..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && searchQuery.trim()) {
                      navigateTo(searchQuery.trim(), true);
                      setSearchQuery("");
                    }
                  }}
                  className="flex-1 bg-transparent text-[#cccccc] text-sm text-center outline-none border-none placeholder-[#555555]"
                />
              </div>
            </div>
          ) : (
            /* Directory / Search list View */
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Breadcrumbs / Action Bar */}
              <div className="h-10 border-b border-borderDark px-4 flex items-center gap-3 shrink-0">
                {/* Back Button */}
                <button
                  onClick={handleBack}
                  disabled={history.length === 0}
                  className={`px-3 py-1 rounded bg-[#252525] border border-[#333333] text-[12px] text-[#aaaaaa] transition duration-150 ${
                    history.length === 0
                      ? "opacity-30 cursor-not-allowed"
                      : "hover:bg-[#333333] hover:text-white"
                  }`}
                >
                  &larr; back
                </button>

                {/* Forward Button */}
                <button
                  onClick={handleForward}
                  disabled={forwardHistory.length === 0}
                  className={`px-3 py-1 rounded bg-[#252525] border border-[#333333] text-[12px] text-[#aaaaaa] transition duration-150 ${
                    forwardHistory.length === 0
                      ? "opacity-30 cursor-not-allowed"
                      : "hover:bg-[#333333] hover:text-white"
                  }`}
                >
                  forward &rarr;
                </button>

                {/* Path display */}
                <div className="text-[12px] text-[#888888] truncate select-text flex-1">
                  {currentPath}
                </div>

                {/* Tag Filter Indicator */}
                {activeTagFilter && (
                  <div className="text-[12px] text-[#9c8ff9] font-bold shrink-0">
                    &bull; filtering by: #{activeTagFilter}
                  </div>
                )}
              </div>

              {/* Files Table / List */}
              <div className="flex-1 overflow-y-auto">
                {files.length === 0 ? (
                  <div className="flex items-center justify-center p-12 text-gray-500 text-sm">
                    No files found
                  </div>
                ) : (
                  <div className="flex flex-col">
                    {files.map((file) => {
                      const isSelected = selectedFile?.path === file.path;
                      const isHidden = hiddenPaths.has(file.path);
                      return (
                        <div
                          key={file.path}
                          onClick={() => handleFileClick(file)}
                          onDoubleClick={() => handleFileDoubleClick(file)}
                          onContextMenu={(e) => handleContextMenu(e, file)}
                          className={`h-[52px] flex items-center px-4 justify-between transition cursor-pointer select-none border-b border-neutral-900 ${
                            isSelected
                              ? "bg-[#252525]"
                              : "hover:bg-[#222222]"
                          } ${isHidden ? "opacity-30" : ""}`}
                        >
                          {/* Left: Icon and Name + tags + description */}
                          <div className="flex items-center gap-3 overflow-hidden">
                            {/* Icon (28x28) */}
                            <div
                              className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${
                                file.is_dir ? "bg-[#1e1e14]" : "bg-[#1a1e2a]"
                              }`}
                            >
                              <div
                                className={`w-3.5 h-3 rounded-[2px] ${
                                  file.is_dir ? "bg-[#ef9f27]" : "bg-[#378add]"
                                }`}
                              />
                            </div>

                            {/* Name, Tags & Description Stack */}
                            <div className="flex flex-col overflow-hidden">
                              <div className="flex items-center gap-2">
                                <span className="text-[13px] text-white truncate font-medium">
                                  {file.name}
                                </span>
                              </div>
                              
                              <div className="flex items-center gap-2.5">
                                {/* Description */}
                                <span
                                  className={`text-[11px] truncate ${
                                    file.description
                                      ? "text-gray-300"
                                      : "text-gray-500 italic"
                                  }`}
                                >
                                  {file.description || "no description"}
                                </span>

                                {/* Tag list */}
                                {file.tags.length > 0 && (
                                  <div className="flex items-center gap-1 shrink-0">
                                    {file.tags.map((t) => (
                                      <span
                                        key={t}
                                        className="text-[9px] bg-[#1e1b2e] border border-[#534ab7] text-[#afa9ec] px-1.5 py-[1px] rounded"
                                      >
                                        {t}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* Right: File Size */}
                          <div className="text-[11px] text-gray-400 shrink-0 ml-4 font-medium">
                            {formatSize(file.size, file.is_dir)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Status bar */}
              <div className="h-6 border-t border-borderDark px-4 flex items-center justify-between bg-darkPanel text-[11px] text-gray-500 shrink-0">
                <div>
                  {totalCount} items
                </div>
                <div>
                  {untaggedCount} untagged
                </div>
              </div>
            </div>
          )}
        </main>

        {/* 4. Right Detail Panel — only visible when a file is selected */}
        <aside
          className={`bg-darkPanel flex flex-col overflow-y-auto shrink-0 select-none transition-all duration-200 ${
            showDetail && selectedFile
              ? "w-[240px] border-l border-borderDark p-4 gap-4"
              : "w-0 border-0 p-0"
          }`}
        >
          {showDetail && selectedFile && (
            <div className="flex flex-col gap-4">
              <div>
                <h3 className="text-[10px] text-[#555555] font-bold tracking-wider mb-2">
                  DETAILS
                </h3>
                <div className="text-[13px] font-semibold truncate text-white" title={selectedFile.name}>
                  {selectedFile.name}
                </div>
                <div className="text-[10px] text-gray-500 break-all select-text mt-1">
                  {selectedFile.path}
                </div>
              </div>

              {/* DESCRIPTION Section */}
              <div className="flex flex-col gap-1.5">
                <h4 className="text-[10px] text-gray-400 font-semibold uppercase tracking-wider">
                  Description
                </h4>
                <div className="relative w-full min-h-[60px] bg-darkBg border border-borderDark rounded-md p-2 flex flex-col focus-within:border-gray-500 transition duration-150">
                  <textarea
                    value={descriptionInput}
                    onChange={(e) => setDescriptionInput(e.target.value)}
                    onBlur={handleDescriptionBlur}
                    placeholder=""
                    className="w-full flex-1 bg-transparent text-white text-[12px] outline-none resize-none min-h-[44px]"
                    onFocus={() => {
                      if (!descriptionInput && descriptionSuggestion) {
                        setDescriptionInput(descriptionSuggestion);
                      }
                    }}
                  />
                  {/* Suggestion Placeholder inside details */}
                  {!descriptionInput && descriptionSuggestion && (
                    <div className="absolute inset-2 text-[#444444] text-[12px] pointer-events-none select-none">
                      {descriptionSuggestion}
                    </div>
                  )}
                </div>
              </div>

              {/* TAGS Section */}
              <div className="flex flex-col gap-1.5">
                <h4 className="text-[10px] text-gray-400 font-semibold uppercase tracking-wider">
                  Tags
                </h4>
                
                {/* List of active tags with x delete buttons */}
                <div className="flex flex-wrap gap-1.5">
                  {currentTagsList.map((tag) => (
                    <div
                      key={tag}
                      className="bg-[#252525] border border-[#333333] rounded-md px-2 py-0.5 text-[11px] text-[#aaaaaa] flex items-center gap-1.5 font-medium"
                    >
                      <span>{tag}</span>
                      <button
                        onClick={() => handleDeleteTag(tag)}
                        className="text-[13px] leading-none text-gray-500 hover:text-red-400 font-bold transition"
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                </div>

                {/* Add Tag Input */}
                {!showTagInput ? (
                  <button
                    onClick={() => setShowTagInput(true)}
                    className="w-full mt-1 border border-borderDark border-dashed hover:border-gray-500 rounded py-1 text-[#aaaaaa] hover:text-white text-[11px] transition text-center select-none"
                  >
                    + Add Tag
                  </button>
                ) : (
                  <div className="flex gap-1.5 mt-1">
                    <input
                      type="text"
                      autoFocus
                      placeholder="tag name..."
                      value={newTagInput}
                      onChange={(e) => setNewTagInput(e.target.value)}
                      onBlur={() => handleAddTag(newTagInput)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleAddTag(newTagInput);
                        if (e.key === "Escape") setShowTagInput(false);
                      }}
                      className="flex-1 bg-darkBg text-white text-[11px] px-2 py-1 rounded border border-borderDark outline-none focus:border-gray-600"
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
