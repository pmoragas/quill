//! The decision table of the sync protocol (see docs/SYNC-SPEC.md): for one file, what to do
//! given the local content hash, the remote version tag, and the *base*, the state both sides
//! agreed on at the last sync.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Base {
    /// SHA-256 of the content at the last sync.
    pub hash: String,
    /// Remote version tag (ETag) at the last sync.
    pub etag: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    Nothing,
    /// Upload a file the remote does not have (`If-None-Match: *`).
    Create,
    /// Upload a new version over the one we last saw (`If-Match: etag`).
    Replace { etag: String },
    Download,
    /// Delete on the remote, if it is still the version we last saw.
    DeleteRemote { etag: String },
    DeleteLocal,
    /// Gone on both sides: forget the base.
    DropBase,
    /// Both sides have it and the base cannot tell them apart: compare the contents.
    Compare,
}

pub fn decide(local: Option<&str>, remote: Option<&str>, base: Option<&Base>) -> Decision {
    use Decision::*;
    match (local, remote, base) {
        (None, None, None) => Nothing,
        (None, None, Some(_)) => DropBase,
        (Some(_), None, None) => Create,
        (None, Some(_), None) => Download,
        (Some(_), Some(_), None) => Compare,
        // Deleted here. If the remote is untouched, delete it there too; an edit beats a delete.
        (None, Some(remote), Some(base)) => {
            if remote == base.etag {
                DeleteRemote { etag: base.etag.clone() }
            } else {
                Download
            }
        }
        // Deleted there. If we did not touch it, delete it here too; otherwise re-upload.
        (Some(local), None, Some(base)) => {
            if local == base.hash {
                DeleteLocal
            } else {
                Create
            }
        }
        (Some(local), Some(remote), Some(base)) => match (local != base.hash, remote != base.etag) {
            (false, false) => Nothing,
            (true, false) => Replace { etag: base.etag.clone() },
            (false, true) => Download,
            (true, true) => Compare,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Decision::*;

    fn base() -> Base {
        Base { hash: "h1".into(), etag: "e1".into() }
    }

    // Rows of the table in docs/SYNC-SPEC.md, in the same order.

    #[test]
    fn unchanged_on_both_sides_does_nothing() {
        assert_eq!(decide(Some("h1"), Some("e1"), Some(&base())), Nothing);
    }

    #[test]
    fn local_change_uploads_over_the_known_version() {
        assert_eq!(decide(Some("h2"), Some("e1"), Some(&base())), Replace { etag: "e1".into() });
    }

    #[test]
    fn remote_change_downloads() {
        assert_eq!(decide(Some("h1"), Some("e2"), Some(&base())), Download);
    }

    #[test]
    fn change_on_both_sides_compares_contents() {
        assert_eq!(decide(Some("h2"), Some("e2"), Some(&base())), Compare);
    }

    #[test]
    fn local_delete_of_an_untouched_file_deletes_remotely() {
        assert_eq!(decide(None, Some("e1"), Some(&base())), DeleteRemote { etag: "e1".into() });
    }

    #[test]
    fn remote_delete_of_an_untouched_file_deletes_locally() {
        assert_eq!(decide(Some("h1"), None, Some(&base())), DeleteLocal);
    }

    #[test]
    fn an_edit_beats_a_delete_in_both_directions() {
        // Deleted here, edited there: keep the remote version.
        assert_eq!(decide(None, Some("e2"), Some(&base())), Download);
        // Edited here, deleted there: upload the local version again.
        assert_eq!(decide(Some("h2"), None, Some(&base())), Create);
    }

    #[test]
    fn deleted_on_both_sides_forgets_the_file() {
        assert_eq!(decide(None, None, Some(&base())), DropBase);
    }

    #[test]
    fn files_never_synced_before() {
        assert_eq!(decide(Some("h"), None, None), Create);
        assert_eq!(decide(None, Some("e"), None), Download);
        // Both sides have it but we have no base: the contents decide, not a guess.
        assert_eq!(decide(Some("h"), Some("e"), None), Compare);
        assert_eq!(decide(None, None, None), Nothing);
    }
}
