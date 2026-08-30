//! Listens for captures sent by the `shift` CLI binary. Each connection is
//! read line by line so a single call can submit several items (e.g. piped
//! multi-line stdin); every line goes through `capture::handle_captured_text`
//! (same as the double-shift gesture and clipboard-watch), so it respects the
//! configured capture mode and gets its own history entry.

use std::io::{BufRead, BufReader};
use std::net::TcpListener;

use tauri::AppHandle;

use crate::cli_protocol::PORT;

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let listener = match TcpListener::bind(("127.0.0.1", PORT)) {
            Ok(listener) => listener,
            Err(e) => {
                eprintln!("shiftshift: CLI capture disabled, could not bind 127.0.0.1:{PORT}: {e}");
                return;
            }
        };
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    if let Some(text) = normalize_line(&line) {
                        let source = crate::capture::frontmost_app_name().unwrap_or_else(|| "CLI".to_string());
                        let _ = crate::capture::handle_captured_text(&app, &text, Some(source));
                    }
                }
            });
        }
    });
}

/// Trims a CLI line and filters out blanks — the only part of this module
/// worth unit-testing in isolation; the actual save goes through
/// `handle_captured_text`, which needs a real `AppHandle`.
fn normalize_line(line: &str) -> Option<String> {
    let text = line.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_and_keeps_a_non_blank_line() {
        assert_eq!(normalize_line("  buy milk  "), Some("buy milk".to_string()));
    }

    #[test]
    fn skips_a_blank_line() {
        assert_eq!(normalize_line("   "), None);
    }
}
