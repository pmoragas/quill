//! Cloud sync (see docs/SYNC-SPEC.md): settings, and the commands the app calls.

pub mod engine;
mod http;
pub mod plan;

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::{vault_root, Vault};
use engine::{Record, Remote, Report, Summary, SyncError};
use http::Http;

/// One sync at a time.
#[derive(Default)]
pub struct SyncLock(tokio::sync::Mutex<()>);

#[derive(Default, Serialize, Deserialize)]
struct Config {
    #[serde(default)]
    url: String,
    #[serde(default)]
    token: String,
    #[serde(default)]
    device: String,
    /// The one folder that syncs, so opening another folder never mixes two vaults into the bucket.
    #[serde(default)]
    vault: Option<String>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("sync.json"))
}

fn load_config(app: &AppHandle) -> Result<Config, String> {
    let path = config_path(app)?;
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display())),
        Err(_) => Ok(Config::default()),
    }
}

fn save_config(app: &AppHandle, config: &Config) -> Result<(), String> {
    let path = config_path(app)?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(&path, serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    // The token is a credential: keep the file private to this user where the OS allows it.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn root_string(root: &Path) -> String {
    root.to_string_lossy().into_owned()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    url: String,
    device: String,
    /// The token is never sent to the interface, only whether one is stored.
    has_token: bool,
    /// Sync is switched on for the folder that is open now.
    enabled_here: bool,
    /// Sync is switched on for some other folder.
    enabled_elsewhere: bool,
}

fn view(config: &Config, root: Option<&Path>) -> ConfigView {
    let here = root.map(root_string);
    ConfigView {
        url: config.url.clone(),
        device: config.device.clone(),
        has_token: !config.token.is_empty(),
        enabled_here: config.vault.is_some() && config.vault == here,
        enabled_elsewhere: config.vault.is_some() && config.vault != here,
    }
}

#[tauri::command]
pub fn sync_get_config(app: AppHandle, vault: State<Vault>) -> Result<ConfigView, String> {
    let config = load_config(&app)?;
    Ok(view(&config, vault_root(&vault).ok().as_deref()))
}

/// Saves the settings. An empty `token` keeps the stored one.
#[tauri::command]
pub fn sync_set_config(
    app: AppHandle,
    vault: State<Vault>,
    url: String,
    token: Option<String>,
    device: String,
    enable_here: bool,
) -> Result<ConfigView, String> {
    let mut config = load_config(&app)?;
    let url = url.trim().to_string();
    let token = token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    // Reject a bad address or token now rather than at the first sync.
    Http::new(&url, token.as_deref().unwrap_or(&config.token))?;
    config.url = url;
    if let Some(token) = token {
        config.token = token;
    }
    config.device = device.trim().to_string();
    let root = vault_root(&vault).ok();
    if enable_here {
        config.vault = Some(root_string(root.as_deref().ok_or("Open a folder first.")?));
    }
    save_config(&app, &config)?;
    Ok(view(&config, root.as_deref()))
}

/// Stops syncing the open folder. The files stay where they are, here and in the cloud.
#[tauri::command]
pub fn sync_disable(app: AppHandle, vault: State<Vault>) -> Result<ConfigView, String> {
    let mut config = load_config(&app)?;
    config.vault = None;
    save_config(&app, &config)?;
    Ok(view(&config, vault_root(&vault).ok().as_deref()))
}

/// The remote and the folder for a sync, if sync is set up for the open folder.
fn target(app: &AppHandle, vault: &State<Vault>) -> Result<(Http, PathBuf, String), String> {
    let config = load_config(app)?;
    let root = vault_root(vault)?;
    if config.vault.as_deref() != Some(&root_string(&root)) {
        return Err("not_enabled".into());
    }
    let http = Http::new(&config.url, &config.token)?;
    let device = if config.device.is_empty() { "device".to_string() } else { config.device };
    Ok((http, root, device))
}

/// Connects with the saved settings and counts the files in the cloud.
#[tauri::command]
pub async fn sync_check(app: AppHandle) -> Result<usize, String> {
    let config = load_config(&app)?;
    let http = Http::new(&config.url, &config.token)?;
    http.list().await.map(|files| files.len()).map_err(describe)
}

/// What a sync would do now, without doing it.
#[tauri::command]
pub async fn sync_plan(app: AppHandle, vault: State<'_, Vault>) -> Result<Summary, String> {
    let (http, root, _) = target(&app, &vault)?;
    engine::plan(&root, &http).await.map_err(describe)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    report: Report,
    /// "offline", "unauthorized" or "failed" when the pass stopped early; progress is kept.
    error: Option<String>,
    message: Option<String>,
}

fn describe(e: SyncError) -> String {
    e.to_string()
}

/// Runs one sync. The first sync of a folder must be confirmed, because it can upload a whole vault.
#[tauri::command]
pub async fn sync_run(
    app: AppHandle,
    vault: State<'_, Vault>,
    lock: State<'_, SyncLock>,
    confirmed: bool,
) -> Result<RunResult, String> {
    let (http, root, device) = target(&app, &vault)?;
    if !Record::exists(&root) && !confirmed {
        return Err("confirmation_required".into());
    }
    let Ok(_running) = lock.0.try_lock() else { return Err("busy".into()) };
    let (report, error) = engine::run(&root, &http, &device).await;
    let (kind, message) = match error {
        None => (None, None),
        Some(SyncError::Offline(m)) => (Some("offline"), Some(m)),
        Some(SyncError::Unauthorized) => (Some("unauthorized"), Some(SyncError::Unauthorized.to_string())),
        Some(e) => (Some("failed"), Some(e.to_string())),
    };
    Ok(RunResult { report, error: kind.map(str::to_owned), message })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(vault: Option<&str>) -> Config {
        Config { url: "https://x".into(), token: "secret".into(), device: "pc".into(), vault: vault.map(String::from) }
    }

    #[test]
    fn sync_belongs_to_exactly_one_folder() {
        let here = Path::new("/notes/Quill");
        let v = view(&config(Some("/notes/Quill")), Some(here));
        assert!(v.enabled_here && !v.enabled_elsewhere);

        // Another folder is open: sync stays off for it, so two vaults never mix in the bucket.
        let v = view(&config(Some("/notes/Quill")), Some(Path::new("/notes/Other")));
        assert!(!v.enabled_here && v.enabled_elsewhere);

        let v = view(&config(None), Some(here));
        assert!(!v.enabled_here && !v.enabled_elsewhere);
        assert!(!view(&config(Some("/notes/Quill")), None).enabled_here);
    }

    #[test]
    fn the_token_is_never_exposed_to_the_interface() {
        let json = serde_json::to_string(&view(&config(None), None)).unwrap();
        assert!(!json.contains("secret"));
        assert!(json.contains("\"hasToken\":true"));
    }
}
