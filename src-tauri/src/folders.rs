//! Folder browsing for the in-app "Open folder" panel.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Stop counting notes after this many, so huge trees (a home folder) stay fast.
const NOTE_COUNT_CAP: usize = 500;
/// Only look this many levels below each folder when counting notes.
const NOTE_COUNT_DEPTH: usize = 3;

#[derive(Serialize)]
pub struct Folder {
    name: String,
    path: String,
    /// Markdown notes inside (capped at `NOTE_COUNT_CAP`).
    notes: usize,
}

#[derive(Serialize)]
pub struct Listing {
    path: String,
    parent: Option<String>,
    folders: Vec<Folder>,
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules" || name == "$RECYCLE.BIN"
}

fn count_notes(dir: &Path, depth: usize, count: &mut usize) {
    if depth > NOTE_COUNT_DEPTH || *count >= NOTE_COUNT_CAP {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if *count >= NOTE_COUNT_CAP {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_hidden(&name) {
            continue;
        }
        match entry.file_type() {
            Ok(t) if t.is_dir() => count_notes(&entry.path(), depth + 1, count),
            Ok(t) if t.is_file() && name.ends_with(".md") => *count += 1,
            _ => {}
        }
    }
}

/// Lists the subfolders of `path` with how many notes each one holds.
#[tauri::command]
pub fn list_folder(path: String) -> Result<Listing, String> {
    let dir = PathBuf::from(&path);
    let entries = fs::read_dir(&dir).map_err(|e| format!("{path}: {e}"))?;
    let mut folders: Vec<Folder> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if is_hidden(&name) {
                return None;
            }
            let mut notes = 0;
            count_notes(&e.path(), 1, &mut notes);
            Some(Folder { name, path: e.path().to_string_lossy().into_owned(), notes })
        })
        .collect();
    folders.sort_by_key(|f| f.name.to_lowercase());
    Ok(Listing {
        path: dir.to_string_lossy().into_owned(),
        parent: dir.parent().map(|p| p.to_string_lossy().into_owned()),
        folders,
    })
}

/// Where the panel starts when no folder is open: Documents, else home.
#[tauri::command]
pub fn default_folder(app: AppHandle) -> Option<String> {
    let paths = app.path();
    [paths.document_dir().ok(), paths.home_dir().ok()]
        .into_iter()
        .flatten()
        .find(|p| p.is_dir())
        .map(|p| p.to_string_lossy().into_owned())
}
