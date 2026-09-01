//! Key management for local SQLite encryption-at-rest (SQLCipher, via
//! `rusqlite`'s `bundled-sqlcipher-vendored-openssl` feature — fully vendored,
//! same "no system dependency" philosophy as the plain `bundled` feature it
//! replaces). Opt-in via `Settings::encrypt_local_storage`.
//!
//! The key is a random 256-bit value generated once and stored in the
//! macOS Keychain via the `security` CLI (shelling out, like
//! `capture::frontmost_app_name`, rather than adding a Keychain-binding
//! crate) — retrievable by this user account on this machine with no
//! password prompt, which protects the raw file at rest (e.g. if it ends up
//! in an unencrypted backup or synced somewhere) without adding daily
//! friction. This is NOT protection against another process running as the
//! same user reading the Keychain — that's a different, much harder threat
//! model this doesn't attempt to solve.

use std::io::Read;
use std::process::Command;

const KEYCHAIN_SERVICE: &str = "dev.shiftshift.tauri.db-key";

fn keychain_account() -> String {
    std::env::var("USER").unwrap_or_else(|_| "shiftshift".to_string())
}

/// Returns the stored key, generating and storing a new one on first use.
pub fn get_or_create_key() -> Result<String, String> {
    if let Some(key) = read_keychain_key()? {
        return Ok(key);
    }
    let key = generate_key();
    store_keychain_key(&key)?;
    Ok(key)
}

fn read_keychain_key() -> Result<Option<String>, String> {
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-a",
            &keychain_account(),
            "-s",
            KEYCHAIN_SERVICE,
            "-w",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Ok(None); // not found yet — not a hard error, `get_or_create_key` will create one
    }
    let key = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(if key.is_empty() { None } else { Some(key) })
}

fn store_keychain_key(key: &str) -> Result<(), String> {
    let output = Command::new("security")
        .args([
            "add-generic-password",
            "-a",
            &keychain_account(),
            "-s",
            KEYCHAIN_SERVICE,
            "-w",
            key,
            "-U",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// 256 bits from the OS CSPRNG, hex-encoded — no `rand` crate dependency
/// needed for a key that's generated once and then just stored.
fn generate_key() -> String {
    let mut file = std::fs::File::open("/dev/urandom").expect("/dev/urandom should exist on macOS");
    let mut bytes = [0u8; 32];
    file.read_exact(&mut bytes)
        .expect("reading 32 bytes from /dev/urandom should not fail");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Escapes a single-quote for interpolation into a SQL string literal — used
/// for `PRAGMA key`/`ATTACH DATABASE`, neither of which rusqlite lets you
/// bind as a parameter (SQLite only allows literals there). The key is our
/// own hex output (never contains a quote) and the path comes from the OS
/// app-data directory, not attacker input, but this costs nothing and
/// removes any doubt.
pub fn sql_quote(s: &str) -> String {
    s.replace('\'', "''")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_key_produces_64_hex_characters() {
        let key = generate_key();
        assert_eq!(key.len(), 64);
        assert!(key.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn generate_key_is_not_the_same_twice() {
        assert_ne!(generate_key(), generate_key());
    }

    #[test]
    fn sql_quote_escapes_single_quotes() {
        assert_eq!(sql_quote("it's a key"), "it''s a key");
    }

    #[test]
    fn sql_quote_leaves_a_plain_string_untouched() {
        assert_eq!(sql_quote("abcdef0123456789"), "abcdef0123456789");
    }
}
