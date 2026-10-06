//! The real remote: the sync API in sync-api/ over HTTPS.

use std::time::Duration;

use reqwest::{header, Client, RequestBuilder, Response, StatusCode, Url};
use serde::Deserialize;

use super::engine::{Delete, Precondition, Put, Remote, RemoteFile, Result, SyncError};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub struct Http {
    client: Client,
    base: Url,
    token: String,
}

#[derive(Deserialize)]
struct Listing {
    files: Vec<ListedFile>,
    cursor: Option<String>,
}

#[derive(Deserialize)]
struct ListedFile {
    path: String,
    etag: String,
}

#[derive(Deserialize)]
struct Stored {
    etag: String,
}

/// Plain HTTP is only accepted for a server on this machine (development).
fn is_local(url: &Url) -> bool {
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
}

fn offline(e: reqwest::Error) -> SyncError {
    if e.is_connect() || e.is_timeout() || e.is_request() {
        SyncError::Offline(e.without_url().to_string())
    } else {
        SyncError::Server(e.without_url().to_string())
    }
}

fn bare_tag(value: &str) -> String {
    value.trim_start_matches("W/").trim_matches('"').to_string()
}

impl Http {
    pub fn new(address: &str, token: &str) -> std::result::Result<Http, String> {
        let base = Url::parse(address.trim()).map_err(|_| "The server address is not a valid URL.".to_string())?;
        if base.scheme() != "https" && !(base.scheme() == "http" && is_local(&base)) {
            return Err("The server address must start with https://.".into());
        }
        if token.trim().is_empty() {
            return Err("The device token is empty.".into());
        }
        let client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Http { client, base, token: token.trim().to_string() })
    }

    /// `<base>/v1/files[/<path>]`, with every path part encoded.
    pub fn url(&self, path: Option<&str>) -> Url {
        let mut url = self.base.clone();
        {
            let mut segments = url.path_segments_mut().expect("an http(s) URL has path segments");
            segments.pop_if_empty().push("v1").push("files");
            if let Some(path) = path {
                segments.extend(path.split('/'));
            }
        }
        url
    }

    fn request(&self, method: reqwest::Method, url: Url) -> RequestBuilder {
        self.client.request(method, url).bearer_auth(&self.token)
    }

    async fn send(&self, request: RequestBuilder) -> Result<Response> {
        let response = request.send().await.map_err(offline)?;
        match response.status() {
            StatusCode::UNAUTHORIZED => Err(SyncError::Unauthorized),
            s if s.is_server_error() => Err(SyncError::Server(format!("the server answered {s}"))),
            _ => Ok(response),
        }
    }

    async fn failed(response: Response) -> SyncError {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        SyncError::Server(format!("the server answered {status}: {detail}"))
    }
}

impl Remote for Http {
    async fn list(&self) -> Result<Vec<RemoteFile>> {
        let mut files = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut url = self.url(None);
            if let Some(cursor) = &cursor {
                url.query_pairs_mut().append_pair("cursor", cursor);
            }
            let response = self.send(self.request(reqwest::Method::GET, url)).await?;
            if !response.status().is_success() {
                return Err(Self::failed(response).await);
            }
            let page: Listing = response.json().await.map_err(|e| SyncError::Server(e.to_string()))?;
            files.extend(page.files.into_iter().map(|f| RemoteFile { path: f.path, etag: f.etag }));
            match page.cursor {
                Some(next) => cursor = Some(next),
                None => return Ok(files),
            }
        }
    }

    async fn get(&self, path: &str) -> Result<Option<(Vec<u8>, String)>> {
        let response = self.send(self.request(reqwest::Method::GET, self.url(Some(path)))).await?;
        match response.status() {
            StatusCode::NOT_FOUND => Ok(None),
            s if s.is_success() => {
                let etag = response
                    .headers()
                    .get(header::ETAG)
                    .and_then(|v| v.to_str().ok())
                    .map(bare_tag)
                    .ok_or_else(|| SyncError::Server("the server sent no version for the file".into()))?;
                let body = response.bytes().await.map_err(offline)?;
                Ok(Some((body.to_vec(), etag)))
            }
            _ => Err(Self::failed(response).await),
        }
    }

    async fn put(&self, path: &str, body: Vec<u8>, precondition: Precondition) -> Result<Put> {
        let request = self.request(reqwest::Method::PUT, self.url(Some(path)));
        let request = match precondition {
            Precondition::Absent => request.header(header::IF_NONE_MATCH, "*"),
            Precondition::Version(etag) => request.header(header::IF_MATCH, etag),
        };
        let response = self.send(request.body(body)).await?;
        match response.status() {
            StatusCode::PRECONDITION_FAILED => Ok(Put::Conflict),
            s if s.is_success() => {
                let stored: Stored = response.json().await.map_err(|e| SyncError::Server(e.to_string()))?;
                Ok(Put::Stored(stored.etag))
            }
            _ => Err(Self::failed(response).await),
        }
    }

    async fn delete(&self, path: &str, etag: &str) -> Result<Delete> {
        let response = self
            .send(self.request(reqwest::Method::DELETE, self.url(Some(path))).header(header::IF_MATCH, etag))
            .await?;
        match response.status() {
            StatusCode::PRECONDITION_FAILED => Ok(Delete::Conflict),
            s if s.is_success() => Ok(Delete::Deleted),
            _ => Err(Self::failed(response).await),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_encoded_urls() {
        let http = Http::new("https://quill-sync.example.workers.dev/", "t").unwrap();
        assert_eq!(http.url(None).as_str(), "https://quill-sync.example.workers.dev/v1/files");
        assert_eq!(
            http.url(Some("Agent Engineering/1 Visió #1.md")).as_str(),
            "https://quill-sync.example.workers.dev/v1/files/Agent%20Engineering/1%20Visi%C3%B3%20%231.md"
        );
    }

    #[test]
    fn only_https_or_a_local_server_is_accepted() {
        assert!(Http::new("http://quill-sync.example.com", "t").is_err());
        assert!(Http::new("http://localhost:8787", "t").is_ok());
        assert!(Http::new("https://x.example.com", " ").is_err());
        assert!(Http::new("not a url", "t").is_err());
    }

    #[test]
    fn strips_quotes_from_version_tags() {
        assert_eq!(bare_tag("\"abc\""), "abc");
        assert_eq!(bare_tag("W/\"abc\""), "abc");
    }
}

/// Needs a running sync API: `SYNC_TEST_URL=http://localhost:8787 SYNC_TEST_TOKEN=... cargo test -- --ignored`.
#[cfg(test)]
mod live {
    use std::fs;

    use super::super::engine::run;
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn two_devices_sync_through_a_real_server() {
        let url = std::env::var("SYNC_TEST_URL").expect("SYNC_TEST_URL");
        let token = std::env::var("SYNC_TEST_TOKEN").expect("SYNC_TEST_TOKEN");
        let http = Http::new(&url, &token).unwrap();
        let (desktop, phone) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let write = |dir: &tempfile::TempDir, path: &str, text: &str| {
            let full = path.split('/').fold(dir.path().to_path_buf(), |p, part| p.join(part));
            fs::create_dir_all(full.parent().unwrap()).unwrap();
            fs::write(full, text).unwrap();
        };
        let read = |dir: &tempfile::TempDir, path: &str| {
            fs::read_to_string(path.split('/').fold(dir.path().to_path_buf(), |p, part| p.join(part))).ok()
        };
        // Unique names so repeated runs against one server do not interfere.
        let id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
        let note = format!("live-{id}/Notes with spaces é.md");
        let asset = format!("live-{id}/assets/pic.bin");

        write(&desktop, &note, "base");
        fs::create_dir_all(desktop.path().join(format!("live-{id}/assets"))).unwrap();
        fs::write(desktop.path().join(format!("live-{id}/assets/pic.bin")), [0u8, 1, 2, 255, 254]).unwrap();
        let (r, e) = run(desktop.path(), &http, "desktop").await;
        assert_eq!(e, None);
        assert_eq!(r.uploaded.len(), 2, "{r:?}");

        let (r, e) = run(phone.path(), &http, "phone").await;
        assert_eq!(e, None);
        assert!(r.downloaded.contains(&note) && r.downloaded.contains(&asset), "{r:?}");
        assert_eq!(read(&phone, &note).as_deref(), Some("base"));
        assert_eq!(fs::read(phone.path().join(format!("live-{id}/assets/pic.bin"))).unwrap(), [0u8, 1, 2, 255, 254]);

        // Both edit the same note; the second to sync gets a conflict copy.
        write(&desktop, &note, "desktop edit");
        let (_, e) = run(desktop.path(), &http, "desktop").await;
        assert_eq!(e, None);
        write(&phone, &note, "phone edit");
        let (r, e) = run(phone.path(), &http, "phone").await;
        assert_eq!(e, None);
        assert_eq!(r.conflicts.len(), 1, "{r:?}");
        assert_eq!(read(&phone, &note).as_deref(), Some("desktop edit"));
        assert_eq!(read(&phone, &r.conflicts[0]).as_deref(), Some("phone edit"));

        let (r, _) = run(desktop.path(), &http, "desktop").await;
        assert_eq!(read(&desktop, &r.downloaded[0]).as_deref(), Some("phone edit"));

        // Clean up everything this test created.
        for dir in [&desktop, &phone] {
            fs::remove_dir_all(dir.path().join(format!("live-{id}"))).unwrap();
        }
        let (r, e) = run(desktop.path(), &http, "desktop").await;
        assert_eq!(e, None);
        let (_, e2) = run(phone.path(), &http, "phone").await;
        assert_eq!(e2, None);
        assert!(r.deleted.len() >= 3, "{r:?}");
    }
}
