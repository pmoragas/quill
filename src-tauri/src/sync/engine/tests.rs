use std::collections::BTreeMap;
use std::sync::Mutex;

use tempfile::TempDir;

use super::*;

/// In-memory remote with R2's version rules: the ETag is a hash of the content.
#[derive(Default)]
struct Fake {
    files: Mutex<BTreeMap<String, Vec<u8>>>,
    /// Applied to the next write, as if another device had written first.
    interfere: Mutex<Option<(String, Vec<u8>)>>,
    /// Calls left before the connection drops.
    budget: Mutex<Option<usize>>,
}

fn etag_of(body: &[u8]) -> String {
    sha256_hex(body)[..32].to_string()
}

impl Fake {
    fn spend(&self) -> Result<()> {
        let mut budget = self.budget.lock().unwrap();
        match *budget {
            Some(0) => Err(SyncError::Offline("connection lost".into())),
            Some(n) => {
                *budget = Some(n - 1);
                Ok(())
            }
            None => Ok(()),
        }
    }
    fn text(&self, path: &str) -> Option<String> {
        self.files.lock().unwrap().get(path).map(|b| String::from_utf8(b.clone()).unwrap())
    }
    fn paths(&self) -> Vec<String> {
        self.files.lock().unwrap().keys().cloned().collect()
    }
}

impl Remote for Fake {
    async fn list(&self) -> Result<Vec<RemoteFile>> {
        self.spend()?;
        Ok(self.files.lock().unwrap().iter().map(|(p, b)| RemoteFile { path: p.clone(), etag: etag_of(b) }).collect())
    }
    async fn get(&self, path: &str) -> Result<Option<(Vec<u8>, String)>> {
        self.spend()?;
        Ok(self.files.lock().unwrap().get(path).map(|b| (b.clone(), etag_of(b))))
    }
    async fn put(&self, path: &str, body: Vec<u8>, precondition: Precondition) -> Result<Put> {
        self.spend()?;
        if let Some((p, b)) = self.interfere.lock().unwrap().take() {
            self.files.lock().unwrap().insert(p, b);
        }
        let mut files = self.files.lock().unwrap();
        let ok = match (&precondition, files.get(path)) {
            (Precondition::Absent, None) => true,
            (Precondition::Version(v), Some(current)) => *v == etag_of(current),
            _ => false,
        };
        if !ok {
            return Ok(Put::Conflict);
        }
        let etag = etag_of(&body);
        files.insert(path.to_string(), body);
        Ok(Put::Stored(etag))
    }
    async fn delete(&self, path: &str, etag: &str) -> Result<Delete> {
        self.spend()?;
        let mut files = self.files.lock().unwrap();
        match files.get(path) {
            None => Ok(Delete::Deleted),
            Some(current) if etag_of(current) == etag => {
                files.remove(path);
                Ok(Delete::Deleted)
            }
            Some(_) => Ok(Delete::Conflict),
        }
    }
}

/// One device: a vault folder and a name.
struct Device {
    dir: TempDir,
    name: &'static str,
}

impl Device {
    fn new(name: &'static str) -> Device {
        Device { dir: TempDir::new().unwrap(), name }
    }
    fn write(&self, path: &str, text: &str) {
        let full = local_path(self.dir.path(), path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, text).unwrap();
    }
    fn read(&self, path: &str) -> Option<String> {
        fs::read_to_string(local_path(self.dir.path(), path)).ok()
    }
    fn remove(&self, path: &str) {
        fs::remove_file(local_path(self.dir.path(), path)).unwrap();
    }
    async fn sync(&self, remote: &Fake) -> Report {
        let (report, error) = run(self.dir.path(), remote, self.name).await;
        assert_eq!(error, None, "sync should not fail");
        report
    }
}

fn names(list: &[String]) -> Vec<&str> {
    list.iter().map(String::as_str).collect()
}

#[tokio::test]
async fn first_sync_uploads_everything_and_the_next_pass_is_quiet() {
    let remote = Fake::default();
    let desktop = Device::new("desktop");
    desktop.write("a.md", "# A");
    desktop.write("folder/b.md", "# B");
    desktop.write("assets/pic.png", "png");

    let first = desktop.sync(&remote).await;
    assert_eq!(names(&first.uploaded), ["a.md", "assets/pic.png", "folder/b.md"]);
    assert_eq!(remote.text("folder/b.md").as_deref(), Some("# B"));

    let second = desktop.sync(&remote).await;
    assert_eq!(second, Report::default());
}

#[tokio::test]
async fn a_new_device_downloads_everything() {
    let remote = Fake::default();
    let desktop = Device::new("desktop");
    desktop.write("a.md", "# A");
    desktop.write("deep/er/b.md", "# B");
    desktop.sync(&remote).await;

    let phone = Device::new("phone");
    let report = phone.sync(&remote).await;
    assert_eq!(names(&report.downloaded), ["a.md", "deep/er/b.md"]);
    assert_eq!(phone.read("deep/er/b.md").as_deref(), Some("# B"));
    assert_eq!(phone.sync(&remote).await, Report::default());
}

#[tokio::test]
async fn an_edit_travels_to_the_other_device() {
    let remote = Fake::default();
    let (desktop, phone) = (Device::new("desktop"), Device::new("phone"));
    desktop.write("a.md", "v1");
    desktop.sync(&remote).await;
    phone.sync(&remote).await;

    desktop.write("a.md", "v2");
    desktop.sync(&remote).await;
    let report = phone.sync(&remote).await;
    assert_eq!(names(&report.downloaded), ["a.md"]);
    assert_eq!(phone.read("a.md").as_deref(), Some("v2"));
}

#[tokio::test]
async fn editing_the_same_note_on_both_devices_keeps_both_versions() {
    let remote = Fake::default();
    let (desktop, phone) = (Device::new("desktop"), Device::new("phone"));
    desktop.write("Notes/a.md", "base");
    desktop.sync(&remote).await;
    phone.sync(&remote).await;

    desktop.write("Notes/a.md", "desktop edit");
    desktop.sync(&remote).await;
    phone.write("Notes/a.md", "phone edit");
    let report = phone.sync(&remote).await;

    // The remote version keeps the name; the phone's text survives next to it.
    assert_eq!(phone.read("Notes/a.md").as_deref(), Some("desktop edit"));
    assert_eq!(report.conflicts.len(), 1);
    let copy = &report.conflicts[0];
    assert!(copy.starts_with("Notes/a (conflict, phone, ") && copy.ends_with(").md"), "{copy}");
    assert_eq!(phone.read(copy).as_deref(), Some("phone edit"));
    assert_eq!(remote.text(copy).as_deref(), Some("phone edit"));

    // The desktop receives the copy too, so both devices see both versions.
    let back = desktop.sync(&remote).await;
    assert_eq!(names(&back.downloaded), [copy.as_str()]);
    assert_eq!(desktop.read("Notes/a.md").as_deref(), Some("desktop edit"));
    assert_eq!(desktop.read(copy).as_deref(), Some("phone edit"));

    // Everything is settled afterwards.
    assert_eq!(phone.sync(&remote).await, Report::default());
    assert_eq!(desktop.sync(&remote).await, Report::default());
}

#[tokio::test]
async fn identical_content_on_both_sides_is_not_a_conflict() {
    let remote = Fake::default();
    let desktop = Device::new("desktop");
    desktop.write("a.md", "same");
    desktop.sync(&remote).await;

    // A second device that already has the same file but never synced.
    let phone = Device::new("phone");
    phone.write("a.md", "same");
    let report = phone.sync(&remote).await;
    assert_eq!(report, Report::default());
    assert_eq!(phone.sync(&remote).await, Report::default());
}

#[tokio::test]
async fn different_content_on_a_first_sync_is_a_conflict_not_an_overwrite() {
    let remote = Fake::default();
    let desktop = Device::new("desktop");
    desktop.write("a.md", "desktop text");
    desktop.sync(&remote).await;

    let phone = Device::new("phone");
    phone.write("a.md", "phone text");
    let report = phone.sync(&remote).await;
    assert_eq!(report.conflicts.len(), 1);
    assert_eq!(phone.read("a.md").as_deref(), Some("desktop text"));
    assert_eq!(phone.read(&report.conflicts[0]).as_deref(), Some("phone text"));
}

#[tokio::test]
async fn a_deletion_travels_in_both_directions() {
    let remote = Fake::default();
    let (desktop, phone) = (Device::new("desktop"), Device::new("phone"));
    desktop.write("a.md", "x");
    desktop.write("b.md", "y");
    desktop.sync(&remote).await;
    phone.sync(&remote).await;

    desktop.remove("a.md");
    let report = desktop.sync(&remote).await;
    assert_eq!(names(&report.deleted), ["a.md"]);
    assert_eq!(remote.paths(), ["b.md"]);
    phone.sync(&remote).await;
    assert_eq!(phone.read("a.md"), None);

    phone.remove("b.md");
    phone.sync(&remote).await;
    desktop.sync(&remote).await;
    assert_eq!(desktop.read("b.md"), None);
    assert!(remote.paths().is_empty());
}

#[tokio::test]
async fn an_edit_beats_a_delete() {
    let remote = Fake::default();
    let (desktop, phone) = (Device::new("desktop"), Device::new("phone"));
    desktop.write("a.md", "base");
    desktop.write("b.md", "base");
    desktop.sync(&remote).await;
    phone.sync(&remote).await;

    // Deleted on the desktop, edited on the phone: the phone's edit survives.
    desktop.remove("a.md");
    phone.write("a.md", "phone edit");
    phone.sync(&remote).await;
    desktop.sync(&remote).await;
    assert_eq!(desktop.read("a.md").as_deref(), Some("phone edit"));

    // Edited on the desktop, deleted on the phone: the desktop uploads it again.
    phone.remove("b.md");
    phone.sync(&remote).await;
    desktop.write("b.md", "desktop edit");
    desktop.sync(&remote).await;
    assert_eq!(remote.text("b.md").as_deref(), Some("desktop edit"));
}

#[tokio::test]
async fn a_write_that_loses_the_race_becomes_a_conflict_copy() {
    let remote = Fake::default();
    let phone = Device::new("phone");
    phone.write("a.md", "base");
    phone.sync(&remote).await;

    phone.write("a.md", "phone edit");
    // The desktop's upload lands after the phone listed the remote but before it writes.
    *remote.interfere.lock().unwrap() = Some(("a.md".into(), b"desktop edit".to_vec()));
    let report = phone.sync(&remote).await;

    assert_eq!(report.conflicts.len(), 1);
    assert_eq!(phone.read("a.md").as_deref(), Some("desktop edit"));
    assert_eq!(phone.read(&report.conflicts[0]).as_deref(), Some("phone edit"));
    assert_eq!(remote.text("a.md").as_deref(), Some("desktop edit"));
}

#[tokio::test]
async fn repeated_conflicts_on_one_day_get_distinct_names() {
    let remote = Fake::default();
    let (desktop, phone) = (Device::new("desktop"), Device::new("phone"));
    desktop.write("a.md", "base");
    desktop.sync(&remote).await;
    phone.sync(&remote).await;

    let mut copies = Vec::new();
    for round in 1..=2 {
        desktop.write("a.md", &format!("desktop {round}"));
        desktop.sync(&remote).await;
        phone.write("a.md", &format!("phone {round}"));
        copies.extend(phone.sync(&remote).await.conflicts);
        desktop.sync(&remote).await;
    }
    assert_eq!(copies.len(), 2);
    assert_ne!(copies[0], copies[1]);
    assert_eq!(phone.read(&copies[0]).as_deref(), Some("phone 1"));
    assert_eq!(phone.read(&copies[1]).as_deref(), Some("phone 2"));
}

#[tokio::test]
async fn hidden_files_temp_files_and_big_files_are_not_synced() {
    let remote = Fake::default();
    let desktop = Device::new("desktop");
    desktop.write("a.md", "keep");
    desktop.write(".quill/private.json", "{}");
    desktop.write(".hidden.md", "x");
    desktop.write("a.md.tmp", "half written");
    let big = local_path(desktop.dir.path(), "big.bin");
    fs::write(&big, vec![0u8; (MAX_FILE_BYTES + 1) as usize]).unwrap();

    let report = desktop.sync(&remote).await;
    assert_eq!(names(&report.uploaded), ["a.md"]);
    assert_eq!(remote.paths(), ["a.md"]);
    assert!(report.skipped.contains(&"big.bin".to_string()));
}

#[tokio::test]
async fn losing_the_connection_keeps_the_progress_made() {
    let remote = Fake::default();
    let desktop = Device::new("desktop");
    for name in ["a.md", "b.md", "c.md"] {
        desktop.write(name, name);
    }
    // list + one upload succeed, then the connection drops.
    *remote.budget.lock().unwrap() = Some(2);
    let (report, error) = run(desktop.dir.path(), &remote, "desktop").await;
    assert!(matches!(error, Some(SyncError::Offline(_))));
    assert_eq!(names(&report.uploaded), ["a.md"]);

    // Back online: only the rest is uploaded.
    *remote.budget.lock().unwrap() = None;
    let next = desktop.sync(&remote).await;
    assert_eq!(names(&next.uploaded), ["b.md", "c.md"]);
}

#[tokio::test]
async fn planning_changes_nothing_and_knows_whether_it_is_the_first_sync() {
    let remote = Fake::default();
    let desktop = Device::new("desktop");
    desktop.write("a.md", "a");
    desktop.write("b.md", "b");
    remote.files.lock().unwrap().insert("c.md".into(), b"c".to_vec());

    let summary = plan(desktop.dir.path(), &remote).await.unwrap();
    assert_eq!((summary.first_time, summary.upload, summary.download), (true, 2, 1));
    assert!(remote.text("a.md").is_none() && desktop.read("c.md").is_none());
    assert!(!Record::exists(desktop.dir.path()));

    desktop.sync(&remote).await;
    let after = plan(desktop.dir.path(), &remote).await.unwrap();
    assert_eq!((after.first_time, after.upload, after.download), (false, 0, 0));
}

#[test]
fn conflict_names_keep_the_folder_and_extension() {
    let free = |_: &str| false;
    assert_eq!(conflict_name("a.md", "phone", "2026-10-06", &free), "a (conflict, phone, 2026-10-06).md");
    assert_eq!(conflict_name("x/y/Notes.md", "My Phone!", "2026-10-06", &free), "x/y/Notes (conflict, My Phone, 2026-10-06).md");
    assert_eq!(conflict_name("README", "pc", "2026-10-06", &free), "README (conflict, pc, 2026-10-06)");
    assert_eq!(conflict_name("a.md", "!!!", "2026-10-06", &free), "a (conflict, device, 2026-10-06).md");
    let taken = |n: &str| n == "a (conflict, pc, 2026-10-06).md" || n == "a (conflict, pc, 2026-10-06 2).md";
    assert_eq!(conflict_name("a.md", "pc", "2026-10-06", &taken), "a (conflict, pc, 2026-10-06 3).md");
}

#[test]
fn civil_dates_are_correct() {
    assert_eq!(civil_date(0), (1970, 1, 1));
    assert_eq!(civil_date(951_782_400), (2000, 2, 29));
    assert_eq!(civil_date(1_700_000_000), (2023, 11, 14));
    assert_eq!(civil_date(1_791_331_200), (2026, 10, 7));
}

#[test]
fn names_the_api_would_refuse_are_not_synced() {
    // Checked on the name itself: Windows cannot even create some of these files.
    for good in ["a.md", "Notes/Visió general.md", "assets/img 1.png"] {
        assert!(syncable_name(good), "{good}");
    }
    for bad in ["", "/a.md", "a//b.md", "a/../b.md", "./a.md", "a\\b.md", "C:/x.md", "bad\u{1}name.md"] {
        assert!(!syncable_name(bad), "{bad:?}");
    }
    assert!(!syncable_name(&"x".repeat(513)));
}
