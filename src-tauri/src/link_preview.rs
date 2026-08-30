//! Best-effort link-preview fetch (title + favicon URL) for `link` items — a
//! plain GET of the page's HTML on the Rust side, since the webview can't
//! read cross-origin HTML due to CORS. Scans for `<title>` and `<link
//! rel="icon">` with plain string search rather than pulling in a full HTML
//! parser dependency for what's just a "good enough" preview. The favicon
//! URL is handed back to the frontend as-is; the `<img>` tag that displays it
//! does its own cross-origin GET, which CORS doesn't restrict (that only
//! blocks script-readable fetches, not image display).

use std::io::Read;
use std::time::Duration;

use serde::Serialize;

/// Caps how much of the response body we read — a preview only needs the
/// `<head>`, and this keeps a pathologically large page from blocking the
/// command for long or eating memory.
const MAX_BODY_BYTES: u64 = 200_000;

#[derive(Debug, Clone, Serialize)]
pub struct LinkPreview {
    pub title: Option<String>,
    pub favicon: Option<String>,
}

pub fn fetch(url: &str) -> Result<LinkPreview, String> {
    let response = ureq::get(url).timeout(Duration::from_secs(5)).call().map_err(|e| e.to_string())?;
    let mut body = String::new();
    response.into_reader().take(MAX_BODY_BYTES).read_to_string(&mut body).map_err(|e| e.to_string())?;
    let title = extract_title(&body);
    let favicon = extract_favicon(&body, url).or_else(|| default_favicon(url));
    Ok(LinkPreview { title, favicon })
}

fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let start = lower.find("<title")?;
    let open_end = html[start..].find('>')? + start + 1;
    let close = lower[open_end..].find("</title>")? + open_end;
    let raw = html[open_end..close].trim();
    if raw.is_empty() {
        None
    } else {
        Some(decode_entities(raw))
    }
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'")
}

/// Scans `<link>` tags for one whose `rel` mentions "icon" (covers `icon`,
/// `shortcut icon`, `apple-touch-icon`), and resolves its `href`.
fn extract_favicon(html: &str, page_url: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let mut search_from = 0;
    while let Some(rel_pos) = lower[search_from..].find("rel=") {
        let abs_rel = search_from + rel_pos;
        let Some(tag_start) = lower[..abs_rel].rfind('<') else { break };
        if !lower[tag_start..].starts_with("<link") {
            search_from = abs_rel + 4;
            continue;
        }
        let Some(tag_end) = lower[abs_rel..].find('>').map(|i| abs_rel + i) else { break };
        if lower[tag_start..tag_end].contains("icon") {
            if let Some(href) = extract_attr(&html[tag_start..tag_end], "href") {
                return Some(resolve_url(page_url, &href));
            }
        }
        search_from = tag_end;
    }
    None
}

fn extract_attr(tag: &str, attr: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    let key = format!("{attr}=");
    let pos = lower.find(&key)? + key.len();
    let quote = *tag.as_bytes().get(pos)?;
    if quote != b'"' && quote != b'\'' {
        return None;
    }
    let value_start = pos + 1;
    let value_end = tag[value_start..].find(quote as char)? + value_start;
    Some(tag[value_start..value_end].to_string())
}

/// Resolves a `<link>` href relative to the page it came from — handles the
/// common cases (absolute, protocol-relative, root-relative); anything
/// trickier (relative to the current directory) is passed through as-is
/// rather than getting full RFC 3986 resolution, since `fetch` falls back to
/// `default_favicon` for hrefs this can't confidently place anyway.
fn resolve_url(page_url: &str, href: &str) -> String {
    if href.starts_with("http://") || href.starts_with("https://") {
        return href.to_string();
    }
    if let Some(rest) = href.strip_prefix("//") {
        let scheme = if page_url.starts_with("https://") { "https" } else { "http" };
        return format!("{scheme}://{rest}");
    }
    if let Some(origin) = origin_of(page_url) {
        if let Some(path) = href.strip_prefix('/') {
            return format!("{origin}/{path}");
        }
        return format!("{origin}/{href}");
    }
    href.to_string()
}

fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let host_end = rest.find('/').unwrap_or(rest.len());
    Some(format!("{scheme}://{}", &rest[..host_end]))
}

fn default_favicon(url: &str) -> Option<String> {
    origin_of(url).map(|origin| format!("{origin}/favicon.ico"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_a_simple_title() {
        assert_eq!(extract_title("<html><head><title>Hello World</title></head></html>"), Some("Hello World".to_string()));
    }

    #[test]
    fn extracts_a_title_with_attributes_on_the_tag() {
        assert_eq!(extract_title("<title lang=\"en\">Hi</title>"), Some("Hi".to_string()));
    }

    #[test]
    fn decodes_common_html_entities_in_the_title() {
        assert_eq!(extract_title("<title>Fish &amp; Chips</title>"), Some("Fish & Chips".to_string()));
    }

    #[test]
    fn returns_none_without_a_title_tag() {
        assert_eq!(extract_title("<html></html>"), None);
    }

    #[test]
    fn returns_none_for_an_empty_title() {
        assert_eq!(extract_title("<title></title>"), None);
    }

    #[test]
    fn extracts_an_absolute_favicon_href() {
        let html = r#"<link rel="icon" href="https://cdn.example.com/f.png">"#;
        assert_eq!(extract_favicon(html, "https://example.com/page"), Some("https://cdn.example.com/f.png".to_string()));
    }

    #[test]
    fn resolves_a_root_relative_favicon_href() {
        let html = r#"<link rel="shortcut icon" href="/f.ico">"#;
        assert_eq!(extract_favicon(html, "https://example.com/page"), Some("https://example.com/f.ico".to_string()));
    }

    #[test]
    fn resolves_a_protocol_relative_favicon_href() {
        let html = r#"<link rel="icon" href="//cdn.example.com/f.png">"#;
        assert_eq!(extract_favicon(html, "https://example.com/page"), Some("https://cdn.example.com/f.png".to_string()));
    }

    #[test]
    fn ignores_unrelated_link_tags() {
        let html = r#"<link rel="stylesheet" href="/style.css"><link rel="icon" href="/f.ico">"#;
        assert_eq!(extract_favicon(html, "https://example.com/"), Some("https://example.com/f.ico".to_string()));
    }

    #[test]
    fn falls_back_to_default_favicon_when_none_declared() {
        assert_eq!(default_favicon("https://example.com/page/deep"), Some("https://example.com/favicon.ico".to_string()));
    }
}
