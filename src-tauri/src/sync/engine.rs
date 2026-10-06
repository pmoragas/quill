//! One sync pass between a local vault folder and a remote store (see docs/SYNC-SPEC.md).
//! The remote is a trait so tests can use an in-memory store with the same version rules as R2.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::plan::{decide, Base, Decision};

/// Files larger than this are skipped (the Worker refuses them too).
pub const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
const RECORD_DIR: &str = ".quill";
const RECORD_FILE: &str = "sync.json";
const MAX_PATH_LENGTH: usize = 512;

// ---------- remote ----------

#[derive(Debug, Clone, PartialEq)]
pub struct RemoteFile {
    pub path: String,
    pub etag: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SyncError {
    /// No connection, or the server could not be reached in time.
    Offline(String),
    /// The device token was refused.
    Unauthorized,
    Server(String),
    Io(String),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncError::Offline(m) => write!(f, "offline: {m}"),
            SyncError::Unauthorized => write!(f, "the device token was refused"),
            SyncError::Server(m) => write!(f, "server error: {m}"),
            SyncError::Io(m) => write!(f, "{m}"),
        }
    }
}

pub type Result<T> = std::result::Result<T, SyncError>;

/// What a write is allowed to replace.
#[derive(Debug, Clone, PartialEq)]
pub enum Precondition {
    /// The file must not exist yet.
    Absent,
    /// The file must still be this version.
    Version(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Put {
    Stored(String),
    /// The file is not the version the caller expected.
    Conflict,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Delete {
    Deleted,
    Conflict,
}

#[allow(async_fn_in_trait)]
pub trait Remote {
    async fn list(&self) -> Result<Vec<RemoteFile>>;
    /// The content and its version, or None if the file does not exist.
    async fn get(&self, path: &str) -> Result<Option<(Vec<u8>, String)>>;
    async fn put(&self, path: &str, body: Vec<u8>, precondition: Precondition) -> Result<Put>;
    async fn delete(&self, path: &str, etag: &str) -> Result<Delete>;
}

// ---------- local state ----------

/// What each device remembers: the base for every synced file.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Record {
    #[serde(default)]
    pub files: BTreeMap<String, Base>,
}

impl Record {
    fn path(root: &Path) -> PathBuf {
        root.join(RECORD_DIR).join(RECORD_FILE)
    }

    pub fn exists(root: &Path) -> bool {
        Self::path(root).is_file()
    }

    pub fn load(root: &Path) -> Record {
        fs::read_to_string(Self::path(root))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, root: &Path) -> Result<()> {
        let json = serde_json::to_vec_pretty(self).map_err(|e| SyncError::Io(e.to_string()))?;
        write_atomic(&Self::path(root), &json)
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn io(e: std::io::Error) -> SyncError {
    SyncError::Io(e.to_string())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".sync-tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, bytes).map_err(io)?;
    fs::rename(&tmp, path).map_err(io)
}

fn local_path(root: &Path, vault_path: &str) -> PathBuf {
    vault_path.split('/').fold(root.to_path_buf(), |p, part| p.join(part))
}

/// The same rules the Worker applies to paths, so we never try to sync a name it would refuse.
fn syncable_name(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= MAX_PATH_LENGTH
        && !path.chars().any(|c| c.is_control() || c == '\\')
        && path.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
        && !path.as_bytes().get(1).is_some_and(|b| *b == b':')
}

fn is_hidden_or_temp(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules" || name.ends_with(".sync-tmp") || name.ends_with(".md.tmp")
}

struct Scan {
    /// path -> SHA-256 of the content
    files: BTreeMap<String, String>,
    /// Files left out: too large or not syncable.
    skipped: Vec<String>,
}

fn scan(root: &Path) -> Result<Scan> {
    fn walk(root: &Path, dir: &Path, prefix: &str, out: &mut Scan) -> Result<()> {
        for entry in fs::read_dir(dir).map_err(io)? {
            let entry = entry.map_err(io)?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                out.skipped.push(entry.file_name().to_string_lossy().into_owned());
                continue;
            };
            if is_hidden_or_temp(&name) {
                continue;
            }
            let path = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
            let file_type = entry.file_type().map_err(io)?;
            if file_type.is_dir() {
                walk(root, &entry.path(), &path, out)?;
            } else if file_type.is_file() {
                let size = entry.metadata().map_err(io)?.len();
                if size > MAX_FILE_BYTES || !syncable_name(&path) {
                    out.skipped.push(path);
                } else {
                    out.files.insert(path, sha256_hex(&fs::read(entry.path()).map_err(io)?));
                }
            }
        }
        Ok(())
    }
    let mut out = Scan { files: BTreeMap::new(), skipped: Vec::new() };
    walk(root, root, "", &mut out)?;
    Ok(out)
}

// ---------- conflict names ----------

/// (year, month, day) in UTC for a Unix time.
fn civil_date(unix_secs: u64) -> (i64, u32, u32) {
    let z = (unix_secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + (month <= 2) as i64, month, day)
}

fn today() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (y, m, d) = civil_date(secs);
    format!("{y:04}-{m:02}-{d:02}")
}

fn clean_device(device: &str) -> String {
    let clean: String = device.chars().filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | ' ')).collect();
    if clean.trim().is_empty() { "device".into() } else { clean.trim().to_string() }
}

/// `dir/Name.md` -> `dir/Name (conflict, device, 2026-10-06).md`, numbered if that name is taken.
pub fn conflict_name(path: &str, device: &str, date: &str, taken: &dyn Fn(&str) -> bool) -> String {
    let (dir, file) = path.rsplit_once('/').map_or(("", path), |(d, f)| (d, f));
    let (stem, ext) = file.rsplit_once('.').map_or((file, String::new()), |(s, e)| (s, format!(".{e}")));
    let device = clean_device(device);
    let join = |name: String| if dir.is_empty() { name } else { format!("{dir}/{name}") };
    let first = join(format!("{stem} (conflict, {device}, {date}){ext}"));
    if !taken(&first) {
        return first;
    }
    (2..)
        .map(|n| join(format!("{stem} (conflict, {device}, {date} {n}){ext}")))
        .find(|name| !taken(name))
        .unwrap()
}

// ---------- plan and run ----------

#[derive(Debug, Default, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// No sync record exists yet: this is the first sync of this vault on this device.
    pub first_time: bool,
    pub upload: usize,
    pub download: usize,
    pub delete_remote: usize,
    pub delete_local: usize,
    /// Both sides have the file and the base cannot tell them apart; contents are compared.
    pub compare: usize,
    pub skipped: Vec<String>,
}

#[derive(Debug, Default, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub uploaded: Vec<String>,
    pub downloaded: Vec<String>,
    pub deleted: Vec<String>,
    /// Paths of the conflict copies created in this pass.
    pub conflicts: Vec<String>,
    pub skipped: Vec<String>,
}

struct Plan {
    items: Vec<(String, Decision)>,
    local: BTreeMap<String, String>,
    remote: BTreeMap<String, String>,
    summary: Summary,
}

async fn make_plan<R: Remote>(root: &Path, remote: &R, record: &Record) -> Result<Plan> {
    let local_scan = {
        let root = root.to_path_buf();
        tokio::task::spawn_blocking(move || scan(&root)).await.map_err(|e| SyncError::Io(e.to_string()))??
    };
    let remote_files: BTreeMap<String, String> = remote.list().await?.into_iter().map(|f| (f.path, f.etag)).collect();

    let paths: BTreeSet<&String> = local_scan.files.keys().chain(remote_files.keys()).chain(record.files.keys()).collect();
    let mut summary = Summary { first_time: !Record::exists(root), skipped: local_scan.skipped.clone(), ..Summary::default() };
    let mut items = Vec::new();
    for path in paths {
        let decision = decide(
            local_scan.files.get(path).map(String::as_str),
            remote_files.get(path).map(String::as_str),
            record.files.get(path),
        );
        match &decision {
            Decision::Create | Decision::Replace { .. } => summary.upload += 1,
            Decision::Download => summary.download += 1,
            Decision::DeleteRemote { .. } => summary.delete_remote += 1,
            Decision::DeleteLocal => summary.delete_local += 1,
            Decision::Compare => summary.compare += 1,
            Decision::Nothing | Decision::DropBase => {}
        }
        if decision != Decision::Nothing {
            items.push((path.clone(), decision));
        }
    }
    Ok(Plan { items, local: local_scan.files, remote: remote_files, summary })
}

/// What a pass would do, without doing it.
pub async fn plan<R: Remote>(root: &Path, remote: &R) -> Result<Summary> {
    Ok(make_plan(root, remote, &Record::load(root)).await?.summary)
}

/// Runs one pass. Progress is saved even if the pass stops early (for example when offline).
pub async fn run<R: Remote>(root: &Path, remote: &R, device: &str) -> (Report, Option<SyncError>) {
    let mut record = Record::load(root);
    let mut report = Report::default();
    let outcome = match make_plan(root, remote, &record).await {
        Ok(plan) => {
            report.skipped = plan.summary.skipped.clone();
            execute(root, remote, device, plan, &mut record, &mut report).await
        }
        Err(e) => Err(e),
    };
    let saved = record.save(root);
    (report, outcome.err().or(saved.err()))
}

async fn execute<R: Remote>(
    root: &Path,
    remote: &R,
    device: &str,
    plan: Plan,
    record: &mut Record,
    report: &mut Report,
) -> Result<()> {
    let mut taken: BTreeSet<String> = plan.remote.keys().chain(plan.local.keys()).cloned().collect();
    for (path, decision) in plan.items {
        let local_hash = plan.local.get(&path).cloned();
        match decision {
            Decision::Nothing => {}
            Decision::DropBase => {
                record.files.remove(&path);
            }
            Decision::Create => {
                if !upload(root, remote, &path, Precondition::Absent, record, report).await? {
                    resolve_conflict(root, remote, device, &path, record, report, &mut taken, None).await?;
                }
            }
            Decision::Replace { etag } => {
                if !upload(root, remote, &path, Precondition::Version(etag), record, report).await? {
                    resolve_conflict(root, remote, device, &path, record, report, &mut taken, None).await?;
                }
            }
            Decision::Download => {
                let Some((body, etag)) = remote.get(&path).await? else { continue };
                write_atomic(&local_path(root, &path), &body)?;
                record.files.insert(path.clone(), Base { hash: sha256_hex(&body), etag });
                report.downloaded.push(path);
            }
            Decision::DeleteRemote { etag } => {
                if remote.delete(&path, &etag).await? == Delete::Deleted {
                    record.files.remove(&path);
                    report.deleted.push(path);
                }
                // On a conflict the remote was edited meanwhile; the next pass downloads it.
            }
            Decision::DeleteLocal => {
                let _ = fs::remove_file(local_path(root, &path));
                record.files.remove(&path);
                report.deleted.push(path);
            }
            Decision::Compare => {
                let Some((body, etag)) = remote.get(&path).await? else { continue };
                if Some(sha256_hex(&body)) == local_hash {
                    record.files.insert(path.clone(), Base { hash: sha256_hex(&body), etag });
                } else {
                    resolve_conflict(root, remote, device, &path, record, report, &mut taken, Some((body, etag))).await?;
                }
            }
        }
    }
    Ok(())
}

/// Uploads the local file. Returns false if the remote is no longer the expected version.
async fn upload<R: Remote>(
    root: &Path,
    remote: &R,
    path: &str,
    precondition: Precondition,
    record: &mut Record,
    report: &mut Report,
) -> Result<bool> {
    let body = fs::read(local_path(root, path)).map_err(io)?;
    match remote.put(path, body.clone(), precondition).await? {
        Put::Stored(etag) => {
            record.files.insert(path.to_string(), Base { hash: sha256_hex(&body), etag });
            report.uploaded.push(path.to_string());
            Ok(true)
        }
        Put::Conflict => Ok(false),
    }
}

/// The remote version keeps the name; the local version is kept next to it as a conflict copy.
#[allow(clippy::too_many_arguments)]
async fn resolve_conflict<R: Remote>(
    root: &Path,
    remote: &R,
    device: &str,
    path: &str,
    record: &mut Record,
    report: &mut Report,
    taken: &mut BTreeSet<String>,
    fetched: Option<(Vec<u8>, String)>,
) -> Result<()> {
    let Some((remote_body, remote_etag)) = (match fetched {
        Some(f) => Some(f),
        None => remote.get(path).await?,
    }) else {
        // Deleted remotely in the meantime: the next pass sees "edited here, deleted there".
        return Ok(());
    };
    let local_body = fs::read(local_path(root, path)).map_err(io)?;
    let copy = conflict_name(path, device, &today(), &|name| taken.contains(name));
    taken.insert(copy.clone());

    // Keep the local text first, so nothing is lost if a later step fails.
    write_atomic(&local_path(root, &copy), &local_body)?;
    write_atomic(&local_path(root, path), &remote_body)?;
    record.files.insert(path.to_string(), Base { hash: sha256_hex(&remote_body), etag: remote_etag });
    report.conflicts.push(copy.clone());

    // Share the copy so every device sees both versions. If this fails, the next pass uploads it.
    if let Put::Stored(etag) = remote.put(&copy, local_body.clone(), Precondition::Absent).await? {
        record.files.insert(copy.clone(), Base { hash: sha256_hex(&local_body), etag });
        report.uploaded.push(copy);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
