//! `atm://localhost/…` → files under the renderer directory only (§5).
//!
//! wry serves the custom protocol as `https://atm.localhost/` on WebView2. Only GET of a
//! plain relative path made of `[A-Za-z0-9._-/]` is served, the resolved file must stay
//! inside the renderer directory after resolving links, and every response carries
//! nosniff plus, for the document, a CSP with no network, no frames and no plugins.

use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};

use wry::http::{Request, Response, StatusCode};

pub const ENTRY_URL: &str = "atm://localhost/index.html";
/// The URL the page reports once wry has mapped the scheme (see the WebView2 spike).
pub const ENTRY_SOURCE: &str = "https://atm.localhost/index.html";
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;

pub const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; child-src 'none'; \
worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

fn mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        _ => "application/octet-stream",
    }
}

/// `/assets/app-1a2b.js` → `assets/app-1a2b.js`; anything unusual → None.
pub fn relative_path(path: &str) -> Option<String> {
    let trimmed = path.strip_prefix('/')?;
    let trimmed = if trimmed.is_empty() {
        "index.html"
    } else {
        trimmed
    };
    let safe_chars = trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'));
    let safe_segments = trimmed
        .split('/')
        .all(|segment| !segment.is_empty() && segment != "." && segment != "..");
    (safe_chars && safe_segments && trimmed.len() <= 512).then(|| trimmed.to_owned())
}

pub fn resolve(root: &Path, request_path: &str) -> Option<PathBuf> {
    let relative = relative_path(request_path)?;
    let root = fs::canonicalize(root).ok()?;
    let file = fs::canonicalize(root.join(relative)).ok()?;
    let metadata = fs::metadata(&file).ok()?;
    (file.starts_with(&root) && metadata.is_file() && metadata.len() <= MAX_FILE_BYTES)
        .then_some(file)
}

fn empty(status: StatusCode) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header("X-Content-Type-Options", "nosniff")
        .body(Cow::Borrowed(&[][..]))
        .expect("static response")
}

pub fn serve(root: &Path, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    if request.method() != wry::http::Method::GET {
        return empty(StatusCode::METHOD_NOT_ALLOWED);
    }
    let uri = request.uri();
    if uri.host() != Some("localhost") || uri.query().is_some() {
        return empty(StatusCode::NOT_FOUND);
    }
    let Some(file) = resolve(root, uri.path()) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let Ok(bytes) = fs::read(&file) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", mime(&file))
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store");
    if file.extension().and_then(|extension| extension.to_str()) == Some("html") {
        response = response
            .header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
            .header("X-Frame-Options", "DENY");
    }
    response
        .body(Cow::Owned(bytes))
        .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR))
}

/// A navigation is allowed only to the entry document itself (reloads included).
pub fn navigation_allowed(url: &str) -> bool {
    url == ENTRY_SOURCE || url == ENTRY_URL
}

pub fn navigation_allowed_owned(url: String) -> bool {
    navigation_allowed(&url)
}

/// The IPC source must be exactly the entry document; the spike showed wry passes
/// WebView2's `WebMessageReceived.Source`, which is the top document's URL.
pub fn ipc_source_trusted(source: &str) -> bool {
    source == ENTRY_SOURCE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_relative_paths() {
        assert_eq!(relative_path("/").as_deref(), Some("index.html"));
        assert_eq!(
            relative_path("/assets/app-1a2B.js").as_deref(),
            Some("assets/app-1a2B.js")
        );
        for bad in [
            "",
            "index.html",
            "/../secret",
            "/a/../b",
            "/a//b",
            "/a%2e%2e/b",
            "/a:b",
            "/a\\b",
            "/C:/x",
            "/a b",
        ] {
            assert_eq!(relative_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn source_and_navigation_are_exact() {
        assert!(ipc_source_trusted("https://atm.localhost/index.html"));
        for bad in [
            "https://atm.localhost/other.html",
            "https://atm.localhost.evil.com/index.html",
            "https://user@atm.localhost/index.html",
            "https://atm.localhost:444/index.html",
            "http://atm.localhost/index.html",
            "about:blank",
        ] {
            assert!(!ipc_source_trusted(bad), "{bad}");
        }
        assert!(navigation_allowed(ENTRY_SOURCE));
        assert!(!navigation_allowed("https://example.com/"));
    }

    #[test]
    fn files_stay_inside_the_renderer_directory() {
        let dir = std::env::temp_dir().join(format!("atm-host-assets-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("renderer").join("assets")).unwrap();
        fs::write(dir.join("renderer").join("index.html"), b"<html>").unwrap();
        fs::write(dir.join("secret.txt"), b"x").unwrap();
        let root = dir.join("renderer");
        assert!(resolve(&root, "/").is_some());
        assert!(resolve(&root, "/secret.txt").is_none());
        assert!(resolve(&root, "/assets").is_none());
        assert!(CONTENT_SECURITY_POLICY.contains("connect-src 'none'"));
        assert!(CONTENT_SECURITY_POLICY.contains("frame-src 'none'"));
        let _ = fs::remove_dir_all(&dir);
    }
}
