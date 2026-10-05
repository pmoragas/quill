mod folders;
mod pdf;

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State};

/// The folder the user opened. Every file command is confined to it.
#[derive(Default)]
struct Vault(Mutex<Option<PathBuf>>);

const ASSETS_DIR: &str = "assets";

fn vault_root(vault: &State<Vault>) -> Result<PathBuf, String> {
    vault
        .0
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no vault is open".into())
}

/// Joins a vault-relative path onto the root, rejecting anything that could
/// escape it (absolute paths, `..`, drive prefixes).
fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = Path::new(rel);
    if rel.as_os_str().is_empty() || !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(format!("invalid path: {}", rel.display()));
    }
    Ok(root.join(rel))
}

fn resolve_note(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let path = resolve(root, rel)?;
    if path.extension().and_then(|e| e.to_str()) != Some("md") {
        return Err(format!("not a markdown file: {rel}"));
    }
    Ok(path)
}

fn is_hidden_or_assets(name: &str) -> bool {
    name.starts_with('.') || name == ASSETS_DIR || name == "node_modules"
}

fn collect_notes(root: &Path, dir: &Path, out: &mut Vec<String>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_hidden_or_assets(&name) {
            continue;
        }
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            collect_notes(root, &path, out)?;
        } else if file_type.is_file() && path.extension().and_then(|e| e.to_str()) == Some("md") {
            let rel = path.strip_prefix(root).unwrap();
            let parts: Vec<_> = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect();
            out.push(parts.join("/"));
        }
    }
    Ok(())
}

fn list(root: &Path) -> Result<Vec<String>, String> {
    let mut notes = Vec::new();
    collect_notes(root, root, &mut notes).map_err(|e| e.to_string())?;
    notes.sort_by_key(|n| n.to_lowercase());
    Ok(notes)
}

/// Keeps only characters that are safe in a filename on every OS.
fn sanitize_file_name(name: &str) -> String {
    let base = Path::new(name).file_name().and_then(|n| n.to_str()).unwrap_or("");
    let clean: String = base
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '-' })
        .collect();
    let clean = clean.trim_matches(|c| c == '.' || c == '-').to_string();
    if clean.is_empty() { "image.png".into() } else { clean }
}

fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = path.extension().and_then(|e| e.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    (1..)
        .map(|i| dir.join(format!("{stem}-{i}{ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

/// Writes via a temporary file and rename, so a crash never leaves a half-written note.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("md.tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)
}

#[tauri::command]
fn open_vault(app: AppHandle, vault: State<Vault>, path: String) -> Result<Vec<String>, String> {
    let root = fs::canonicalize(&path).map_err(|e| format!("{path}: {e}"))?;
    if !root.is_dir() {
        return Err(format!("not a folder: {path}"));
    }
    app.asset_protocol_scope()
        .allow_directory(&root, true)
        .map_err(|e| e.to_string())?;
    let notes = list(&root)?;
    *vault.0.lock().unwrap() = Some(root);
    Ok(notes)
}

#[tauri::command]
fn vault_path(vault: State<Vault>) -> Result<String, String> {
    Ok(vault_root(&vault)?.to_string_lossy().into_owned())
}

#[tauri::command]
fn list_notes(vault: State<Vault>) -> Result<Vec<String>, String> {
    list(&vault_root(&vault)?)
}

#[tauri::command]
fn read_note(vault: State<Vault>, path: String) -> Result<String, String> {
    let file = resolve_note(&vault_root(&vault)?, &path)?;
    fs::read_to_string(file).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn write_note(vault: State<Vault>, path: String, content: String) -> Result<(), String> {
    let file = resolve_note(&vault_root(&vault)?, &path)?;
    write_atomic(&file, content.as_bytes()).map_err(|e| format!("{path}: {e}"))
}

/// Saves raw image bytes into `assets/` and returns the vault-relative path.
/// The original filename comes URI-encoded in the `x-name` header.
#[tauri::command]
fn save_asset(vault: State<Vault>, request: Request) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    let name = request
        .headers()
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .map(|v| percent_decode(v))
        .unwrap_or_default();
    let dir = vault_root(&vault)?.join(ASSETS_DIR);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = unique_path(&dir, &sanitize_file_name(&name));
    fs::write(&file, bytes).map_err(|e| e.to_string())?;
    Ok(format!("{ASSETS_DIR}/{}", file.file_name().unwrap().to_string_lossy()))
}

/// Saves the current note as a PDF next to it (same name, `.pdf`) and returns the full path.
#[tauri::command]
async fn export_pdf(
    webview: tauri::Webview,
    vault: State<'_, Vault>,
    path: String,
    options: pdf::PdfOptions,
) -> Result<String, String> {
    let out = resolve_note(&vault_root(&vault)?, &path)?.with_extension("pdf");
    let (done, finished) = tokio::sync::oneshot::channel();
    pdf::print_to_file(&webview, out.clone(), &options, done)?;
    finished.await.map_err(|_| "the export was interrupted".to_string())??;
    Ok(out.to_string_lossy().into_owned())
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Vault::default())
        .setup(|_app| {
            // The window is frameless so Windows and Linux get Quill's own title bar;
            // macOS keeps its native one (traffic-light buttons).
            #[cfg(target_os = "macos")]
            _app.get_webview_window("main")
                .expect("main window")
                .set_decorations(true)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_vault,
            vault_path,
            list_notes,
            read_note,
            write_note,
            save_asset,
            export_pdf,
            folders::list_folder,
            folders::default_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_rejects_escapes() {
        let root = Path::new("/vault");
        assert!(resolve(root, "../etc/passwd").is_err());
        assert!(resolve(root, "a/../../b").is_err());
        assert!(resolve(root, "/etc/passwd").is_err());
        assert!(resolve(root, "").is_err());
        assert_eq!(resolve(root, "a/b.md").unwrap(), root.join("a/b.md"));
    }

    #[test]
    fn notes_must_be_markdown() {
        assert!(resolve_note(Path::new("/vault"), "x.txt").is_err());
        assert!(resolve_note(Path::new("/vault"), "x.md").is_ok());
    }

    #[test]
    fn sanitizes_names() {
        assert_eq!(sanitize_file_name("../../evil.png"), "evil.png");
        assert_eq!(sanitize_file_name("my photo (1).jpg"), "my-photo--1-.jpg");
        assert_eq!(sanitize_file_name(""), "image.png");
    }

    #[test]
    fn decodes_names() {
        assert_eq!(percent_decode("caf%C3%A9.png"), "café.png");
        assert_eq!(percent_decode("100%"), "100%");
    }
}
