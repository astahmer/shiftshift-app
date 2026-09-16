//! Persisted user settings (double-shift bindings, theme, notifications,
//! fallback global-shortcut accelerators). Kept as its own small JSON file
//! rather than a table in the SQLite store so it can be read once at startup
//! before the DB (and the rest of app state) exists.

use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::capture::{Bindings, CaptureMode};
use crate::store::CollectionQuery;

const FILE_NAME: &str = "settings.json";

pub const DEFAULT_FALLBACK_TOGGLE: &str = "CmdOrCtrl+Shift+Space";
pub const DEFAULT_FALLBACK_CAPTURE: &str = "CmdOrCtrl+Shift+X";
pub const DEFAULT_FALLBACK_IMAGE: &str = "CmdOrCtrl+Shift+I";
pub const DEFAULT_SOUND_NAME: &str = "Glass";

const LEGACY_FALLBACK_CAPTURE: &str = "CmdOrCtrl+Shift+C";

/// What happens when something is captured — see `notify.rs`. `Custom` is
/// an in-app toast (the panel briefly appears unfocused with a checkmark
/// animation) rather than going through the OS notification center at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationStyle {
    #[default]
    None,
    Native,
    Custom,
}

/// What text a notification shows — applies to both `Native` and `Custom`
/// styles (see `notify.rs::notify_captured`). Native can't actually go
/// text-free (`display notification` requires a body), so `IconOnly` there
/// degrades to just the kind label ("Note saved") instead of the excerpt.
// The shared "Icon" prefix is deliberate, not accidental repetition —
// every variant includes the icon, that's the axis being named.
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotifyContent {
    IconOnly,
    IconTitle,
    #[default]
    IconTitleExcerpt,
    IconExcerpt,
}

/// Where the "custom" toast (`NotificationStyle::Custom`) window sits on
/// screen — a 3x3 grid of corner/edge/center presets for the toast, extra
/// perimeter anchors for the dock (5 slots per edge), plus `Custom` for a
/// user-dragged exact position.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToastPosition {
    TopLeft,
    TopCenter,
    #[default]
    TopRight,
    MiddleLeft,
    /// Extra dock-only perimeter anchors (5 slots per edge). The toast
    /// 3×3 picker never offers these; `toast::place` still maps them so a
    /// leftover saved value can't fail to compile.
    LeftTop,
    LeftUpper,
    LeftLower,
    LeftBottom,
    RightTop,
    RightUpper,
    RightLower,
    RightBottom,
    TopMidLeft,
    TopMidRight,
    BottomMidLeft,
    BottomMidRight,
    Center,
    MiddleRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
    Custom,
}

/// What Enter (or a pinned-slot shortcut) does on a highlighted item.
/// Default is the Raycast-like "copy, hide, paste into wherever you were".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HighlightSubmit {
    Copy,
    CopyHide,
    #[default]
    CopyHideWrite,
}

/// Lifecycle points at which an external automation command may run. The
/// dotted wire names are stable protocol values, not Rust implementation
/// names, so a hook can be written in any language.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AutomationEvent {
    #[serde(rename = "item.created")]
    ItemCreated,
    #[serde(rename = "item.updated")]
    ItemUpdated,
    #[serde(rename = "item.used")]
    ItemUsed,
    #[serde(rename = "item.bookmarked")]
    ItemBookmarked,
    #[serde(rename = "item.deleted")]
    ItemDeleted,
}

impl AutomationEvent {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ItemCreated => "item.created",
            Self::ItemUpdated => "item.updated",
            Self::ItemUsed => "item.used",
            Self::ItemBookmarked => "item.bookmarked",
            Self::ItemDeleted => "item.deleted",
        }
    }
}

fn default_automation_hook_enabled() -> bool {
    true
}

fn default_automation_hook_timeout_ms() -> u64 {
    10_000
}

fn default_automation_view_enabled() -> bool {
    true
}

fn default_automation_view_sort() -> String {
    "manual".to_string()
}

/// A read-only smart view contributed by an automation/plugin. The hook owns
/// the definition, while the user owns the `enabled` switch in Settings.
/// Prefixing its tab id with the hook id keeps two plugins free to use the
/// same local view id.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AutomationView {
    pub id: String,
    pub label: String,
    pub description: String,
    pub icon: String,
    pub query: CollectionQuery,
    #[serde(default = "default_automation_view_sort")]
    pub sort: String,
    #[serde(default = "default_automation_view_enabled")]
    pub enabled: bool,
}

impl Default for AutomationView {
    fn default() -> Self {
        Self {
            id: String::new(),
            label: String::new(),
            description: String::new(),
            icon: String::new(),
            query: CollectionQuery::default(),
            sort: default_automation_view_sort(),
            enabled: true,
        }
    }
}

/// A direct executable invocation. The app never passes this through a shell:
/// `command` is the executable and `args` are passed as individual arguments.
/// Keeping this in Settings makes hooks portable through config export/import;
/// credentials remain the hook's responsibility and are never part of this
/// object.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AutomationHook {
    pub id: String,
    #[serde(default = "default_automation_hook_enabled")]
    pub enabled: bool,
    pub events: Vec<AutomationEvent>,
    pub command: String,
    pub args: Vec<String>,
    #[serde(default = "default_automation_hook_timeout_ms")]
    pub timeout_ms: u64,
    /// Smart views contributed by this hook/plugin. They are configuration,
    /// not executable output, so they remain stable between item events.
    #[serde(default)]
    pub views: Vec<AutomationView>,
}

impl Default for AutomationHook {
    fn default() -> Self {
        Self {
            id: String::new(),
            enabled: true,
            events: Vec::new(),
            command: String::new(),
            args: Vec::new(),
            timeout_ms: default_automation_hook_timeout_ms(),
            views: Vec::new(),
        }
    }
}

/// `secret_access_key` is write-only over the wire — see `commands::set_settings`,
/// which moves a non-empty value into the OS keychain and always persists ""
/// to `settings.json` instead, and `s3_secret_access_key`/`clear_s3_secret`
/// below. `access_key_id` stays plain (an identifier, not a secret on its
/// own — same treatment AWS's own CLI gives it).
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct S3Settings {
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub prefix: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub bindings: Bindings,
    /// Opaque to Rust — the frontend owns the theme registry and CSS variable
    /// blocks (see `src/themes.ts`); this is just persisted verbatim.
    pub theme: String,
    pub notification_style: NotificationStyle,
    pub notify_sound: bool,
    /// One of the file stems under /System/Library/Sounds — see notify.rs's
    /// `play_sound` for how an unrecognized name is handled (skipped, not
    /// an error, since this is user-typed-adjacent via a <select> but kept
    /// as a plain string rather than an enum for forward-compatibility).
    pub notify_sound_name: String,
    /// 0-100, passed to `afplay -v` as a 0.0-1.0 fraction — independent of
    /// the system's own notification-sound volume, which `display
    /// notification`'s own `sound name` clause has no control over.
    pub notify_sound_volume: u8,
    /// Applies to both `Native` and `Custom` styles — see `NotifyContent`.
    pub notify_content: NotifyContent,
    /// Only meaningful for `NotificationStyle::Custom` — see `toast.rs`.
    pub toast_position: ToastPosition,
    /// Physical screen coordinates of the toast window's top-left corner —
    /// only meaningful when `toast_position == ToastPosition::Custom`
    /// (dragged into place, see `toast.rs`'s `finish_arrange`).
    pub toast_custom_x: i32,
    pub toast_custom_y: i32,
    /// Milliseconds the toast stays up before auto-hiding — `Custom` style
    /// only, native banners' visible duration is OS-controlled.
    pub toast_duration_ms: u32,
    /// Percent scale (e.g. 100 = normal) applied to the toast's text/icon —
    /// `Custom` style only, same reasoning as `toast_duration_ms`.
    pub toast_font_scale: u8,
    /// Off by default — a small always-visible pill (see `dock.rs`) showing
    /// the most recent captures, click to expand/collapse. Same 3x3-grid
    /// positioning concept as the toast, hence sharing `ToastPosition`.
    pub dock_enabled: bool,
    pub dock_position: ToastPosition,
    pub dock_custom_x: i32,
    pub dock_custom_y: i32,
    /// How many recent items the expanded dock shows.
    pub dock_item_count: u8,
    /// Logical pixel height of one expanded row. `0` means the compiled default.
    pub dock_row_height: u8,
    /// Expanded notch size in logical pixels. `0` means the compiled default.
    pub dock_expanded_width: u32,
    pub dock_expanded_height: u32,
    /// Tauri accelerator strings (e.g. "CmdOrCtrl+Shift+Space") for the
    /// fallback global shortcuts, used where the raw double-shift hook is
    /// unavailable or denied. Empty string means "disabled, don't register".
    pub fallback_toggle: String,
    pub fallback_capture: String,
    /// Saves whatever image is on the clipboard (see `images.rs`) — a
    /// dedicated shortcut rather than folded into `fallback_capture`,
    /// since that one simulates a text-copy chord that would clobber a
    /// clipboard image before it could be read.
    pub fallback_image: String,
    pub capture_mode: CaptureMode,
    /// Enter on a highlighted row — see `HighlightSubmit`.
    pub highlight_submit: HighlightSubmit,
    /// Hide the panel when it loses focus (e.g. the user clicks elsewhere).
    pub hide_on_blur: bool,
    /// macOS inline autocorrect / spellcheck on the capture input. Off by
    /// default — a capture box should not rewrite "bonjour" while you type.
    pub input_spellcheck: bool,
    /// Auto-capture everything copied to the system clipboard, own writes
    /// excluded (shiftshift's clipboard-watch).
    pub clipboard_watch: bool,
    /// One list-tab per distinct #tag (the default) vs. a single combined
    /// "Tags" tab with its own multi-select filter (`capture-logic.ts`'s
    /// `buildListTabs`).
    pub separate_tag_tabs: bool,
    pub launch_at_login: bool,
    /// "local" or "s3" — which `Store` backend `Db::open` constructs.
    /// Switching requires a restart (no live backend hot-swap).
    pub backend: String,
    pub s3: S3Settings,
    /// Opaque to Rust, like `theme` — the frontend applies this client-side
    /// (`capture-logic.ts`'s `applySort`) rather than re-querying the store,
    /// since the canonical DB order already IS "manual" (rank-based).
    /// "manual" | "newest" | "oldest" | "az" | "za".
    pub sort_mode: String,
    /// Direct external commands invoked asynchronously after matching item
    /// lifecycle events. See `automation.rs` and AUTOMATIONS.md.
    pub automation_hooks: Vec<AutomationHook>,
    /// Both default to `false` — this app is meant to be invoked purely via
    /// the double-shift gesture / fallback shortcuts, so "no dock icon, no
    /// menu-bar icon" is the intended steady state, not an oversight.
    pub show_in_dock: bool,
    pub show_tray_icon: bool,
    /// A plain directory path (e.g. inside iCloud Drive/Dropbox/Syncthing) —
    /// used when `backend == "folder"`. Sync is entirely the filesystem
    /// client's job; see `store/folder.rs`'s module doc for the same
    /// single-writer caveat `S3Store` has.
    pub folder_path: String,
    /// Overrides the active theme's own `--bg-alpha` when `> 0` (0 means "no
    /// override, use whatever the theme sets") — a user-facing "how see-
    /// through is the panel" control independent of picking a theme.
    pub panel_opacity: u8,
    /// App names (case-insensitive substring match against the frontmost
    /// app) that clipboard-watch never auto-captures from — password
    /// managers by default, so a copied password/2FA code doesn't end up
    /// sitting in plaintext in shiftshift's history. Only applies to
    /// clipboard-watch; an explicit double-shift/CLI capture always goes
    /// through regardless, since that's a deliberate action.
    pub excluded_apps: Vec<String>,
    /// Encrypts the local SQLite store at rest (SQLCipher) — off by default
    /// so existing plaintext databases are never touched unless explicitly
    /// opted into; see `store/local.rs`'s `migrate_plaintext_to_encrypted`
    /// for how an existing database is migrated the first time this turns
    /// on. Only affects the local backend; S3/folder backends store plain
    /// JSON regardless (out of scope for this pass).
    pub encrypt_local_storage: bool,
    /// Remembered panel size/position. `panel_width == 0` means "use the
    /// compiled default"; `panel_placed` is false until the user has
    /// resized or dragged the window at least once.
    pub panel_width: u32,
    pub panel_height: u32,
    pub panel_x: i32,
    pub panel_y: i32,
    pub panel_placed: bool,
    /// Item ids pinned to ⌘1-⌘9 for instant copy-and-close, Raycast-
    /// favorites-style — index 0 is slot 1, etc. Always exactly 9 entries;
    /// an empty string means that slot is unassigned. Kept as item ids
    /// (not a separate struct) so a pin is just "point at an existing row",
    /// no duplicate storage of the item's content.
    pub pinned_items: Vec<String>,
}

pub const DEFAULT_EXCLUDED_APPS: &[&str] = &[
    "1Password",
    "Bitwarden",
    "Dashlane",
    "LastPass",
    "Keychain Access",
    "KeePassXC",
    "Enpass",
    "NordPass",
    "RoboForm",
];

impl Default for Settings {
    fn default() -> Self {
        Self {
            bindings: Bindings::default(),
            theme: "tokyo-night".to_string(),
            notification_style: NotificationStyle::default(),
            notify_sound: true,
            notify_sound_name: DEFAULT_SOUND_NAME.to_string(),
            notify_sound_volume: 50,
            notify_content: NotifyContent::default(),
            toast_position: ToastPosition::default(),
            toast_custom_x: 0,
            toast_custom_y: 0,
            toast_duration_ms: 1800,
            toast_font_scale: 100,
            dock_enabled: false,
            dock_position: ToastPosition::TopCenter,
            dock_custom_x: 0,
            dock_custom_y: 0,
            dock_item_count: 10,
            dock_row_height: 36,
            dock_expanded_width: 0,
            dock_expanded_height: 0,
            fallback_toggle: DEFAULT_FALLBACK_TOGGLE.to_string(),
            fallback_capture: DEFAULT_FALLBACK_CAPTURE.to_string(),
            fallback_image: DEFAULT_FALLBACK_IMAGE.to_string(),
            capture_mode: CaptureMode::default(),
            highlight_submit: HighlightSubmit::default(),
            hide_on_blur: true,
            input_spellcheck: false,
            clipboard_watch: false,
            separate_tag_tabs: true,
            launch_at_login: false,
            backend: "local".to_string(),
            s3: S3Settings::default(),
            sort_mode: "manual".to_string(),
            automation_hooks: Vec::new(),
            show_in_dock: false,
            show_tray_icon: false,
            folder_path: String::new(),
            panel_opacity: 0,
            excluded_apps: DEFAULT_EXCLUDED_APPS
                .iter()
                .map(|s| s.to_string())
                .collect(),
            encrypt_local_storage: false,
            pinned_items: vec![String::new(); 9],
            panel_width: 0,
            panel_height: 0,
            panel_x: 0,
            panel_y: 0,
            panel_placed: false,
        }
    }
}

/// Shared, live-readable settings. The tap listeners and shortcut handlers
/// re-read this on every gesture rather than capturing a snapshot, so a
/// change from the settings screen applies immediately, no restart needed.
pub struct SettingsState(pub Mutex<Settings>);

pub fn load(app_data_dir: &Path) -> Settings {
    let Some(raw) = std::fs::read_to_string(app_data_dir.join(FILE_NAME)).ok() else {
        return Settings::default();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Settings::default();
    };
    // `#[serde(default)]` would happily (mis)parse a legacy bindings-only
    // file as a Settings with default everything-else and the top-level
    // left/right keys silently ignored as unknown fields — so the shape is
    // checked explicitly rather than just trying Settings first.
    if value.get("bindings").is_some() {
        let mut settings = serde_json::from_value(value).unwrap_or_default();
        migrate_legacy_dock_box(&mut settings);
        migrate_legacy_fallback_capture(&mut settings);
        return settings;
    }
    // Legacy settings.json from before Settings grew beyond just bindings —
    // the whole file used to *be* a bare Bindings object.
    if let Ok(bindings) = serde_json::from_value::<Bindings>(value) {
        return Settings {
            bindings,
            ..Settings::default()
        };
    }
    Settings::default()
}

/// The first notch build stored a 280×220 list-box as the expanded default.
/// That size is a floating card, not Tokitoki's 84px rail — treat it as unset
/// so expand hugs the edge instead of hanging off-screen.
fn migrate_legacy_dock_box(settings: &mut Settings) {
    if settings.dock_expanded_width > 0 && settings.dock_expanded_width < 160 {
        settings.dock_expanded_width = 0;
        settings.dock_expanded_height = 0;
    }
    if settings.dock_expanded_width == 280 && settings.dock_expanded_height == 220 {
        settings.dock_expanded_width = 0;
        settings.dock_expanded_height = 0;
    }
    if settings.dock_expanded_width == 280 && settings.dock_expanded_height == 408 {
        settings.dock_expanded_width = 0;
        settings.dock_expanded_height = 0;
    }
    if settings.dock_expanded_width == 0
        && settings.dock_expanded_height == 0
        && settings.dock_item_count == 5
    {
        settings.dock_item_count = 10;
    }
}

fn migrate_legacy_fallback_capture(settings: &mut Settings) {
    if settings.fallback_capture == LEGACY_FALLBACK_CAPTURE {
        settings.fallback_capture = DEFAULT_FALLBACK_CAPTURE.to_string();
    }
}

/// Always writes `s3.secret_access_key` as `""` regardless of what's in
/// `settings` — the real value lives in the OS keychain (see
/// `s3_secret_access_key`/`set_s3_secret_access_key` below), never on disk.
/// Defense in depth: `commands::set_settings` already scrubs it before this
/// is ever called, but a settings.json that's safe to `cat` no matter what
/// bypasses that is worth the one clone.
pub fn save(app_data_dir: &Path, settings: &Settings) -> Result<(), String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
    let mut settings = settings.clone();
    settings.s3.secret_access_key.clear();
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(app_data_dir.join(FILE_NAME), json).map_err(|e| e.to_string())
}

const KEYCHAIN_SERVICE: &str = "dev.shiftshift.tauri";
const KEYCHAIN_S3_SECRET_ACCOUNT: &str = "s3-secret-access-key";

/// Reads the S3 secret access key from the OS keychain — `None` if never
/// set. This is the only place that ever reads the *real* secret; `Settings`
/// itself never carries it (see `S3Settings`'s doc comment).
pub fn s3_secret_access_key() -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_S3_SECRET_ACCOUNT)
        .ok()?
        .get_password()
        .ok()
}

/// Called from `commands::set_settings` when the incoming (write-only)
/// `s3.secret_access_key` is non-empty — an empty value there means
/// "untouched" (see `S3Settings`'s doc comment), not "clear it"; use
/// `clear_s3_secret_access_key` for that.
pub fn set_s3_secret_access_key(secret: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_S3_SECRET_ACCOUNT)
        .map_err(|e| e.to_string())?;
    entry.set_password(secret).map_err(|e| e.to_string())
}

/// Settings -> Sync -> the secret field's "Clear" button — explicit removal,
/// since a blank field on save no longer means that (see above).
pub fn clear_s3_secret_access_key() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_S3_SECRET_ACCOUNT)
        .map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::Action;

    #[test]
    fn missing_file_falls_back_to_defaults() {
        let settings = load(&tempdir());
        assert_eq!(settings.bindings.left, Action::Capture);
        assert_eq!(settings.theme, "tokyo-night");
        assert_eq!(settings.notification_style, NotificationStyle::None);
        assert_eq!(settings.notify_sound_name, "Glass");
        assert_eq!(settings.notify_sound_volume, 50);
        assert_eq!(settings.toast_position, ToastPosition::TopRight);
        assert!(!settings.dock_enabled);
        assert_eq!(settings.dock_position, ToastPosition::TopCenter);
        assert_eq!(settings.dock_item_count, 10);
        assert_eq!(settings.dock_row_height, 36);
        assert_eq!(settings.highlight_submit, HighlightSubmit::CopyHideWrite);
        assert!(!settings.input_spellcheck);
    }

    #[test]
    fn old_expanded_box_size_becomes_auto_rail() {
        let dir = tempdir();
        let mut settings = Settings::default();
        settings.dock_expanded_width = 280;
        settings.dock_expanded_height = 220;
        save(&dir, &settings).unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.dock_expanded_width, 0);
        assert_eq!(loaded.dock_expanded_height, 0);
    }

    #[test]
    fn previous_280x408_default_becomes_auto_rail() {
        let dir = tempdir();
        let mut settings = Settings::default();
        settings.dock_expanded_width = 280;
        settings.dock_expanded_height = 408;
        settings.dock_item_count = 5;
        save(&dir, &settings).unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.dock_expanded_width, 0);
        assert_eq!(loaded.dock_expanded_height, 0);
        assert_eq!(loaded.dock_item_count, 10);
    }

    #[test]
    fn skinny_84px_rail_becomes_auto() {
        let dir = tempdir();
        let mut settings = Settings::default();
        settings.dock_expanded_width = 84;
        settings.dock_expanded_height = 320;
        save(&dir, &settings).unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.dock_expanded_width, 0);
        assert_eq!(loaded.dock_expanded_height, 0);
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempdir();
        let mut settings = Settings::default();
        settings.bindings = Bindings {
            left: Action::None,
            right: Action::Capture,
        };
        settings.theme = "dracula".to_string();
        settings.notification_style = NotificationStyle::Custom;
        settings.notify_sound_name = "Ping".to_string();
        settings.notify_sound_volume = 80;
        settings.toast_position = ToastPosition::Custom;
        settings.toast_custom_x = 120;
        settings.toast_custom_y = 40;
        settings.notify_content = NotifyContent::IconExcerpt;
        settings.toast_duration_ms = 3000;
        settings.toast_font_scale = 125;
        settings.panel_width = 800;
        settings.panel_height = 500;
        settings.panel_x = 40;
        settings.panel_y = 80;
        settings.panel_placed = true;
        save(&dir, &settings).unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.bindings.left, Action::None);
        assert_eq!(loaded.theme, "dracula");
        assert_eq!(loaded.notification_style, NotificationStyle::Custom);
        assert_eq!(loaded.notify_sound_name, "Ping");
        assert_eq!(loaded.notify_sound_volume, 80);
        assert_eq!(loaded.toast_position, ToastPosition::Custom);
        assert_eq!(loaded.toast_custom_x, 120);
        assert_eq!(loaded.toast_custom_y, 40);
        assert_eq!(loaded.notify_content, NotifyContent::IconExcerpt);
        assert_eq!(loaded.toast_duration_ms, 3000);
        assert_eq!(loaded.toast_font_scale, 125);
        assert_eq!(loaded.panel_width, 800);
        assert_eq!(loaded.panel_height, 500);
        assert_eq!(loaded.panel_x, 40);
        assert_eq!(loaded.panel_y, 80);
        assert!(loaded.panel_placed);
    }

    #[test]
    fn save_never_persists_the_s3_secret_access_key_to_disk() {
        let dir = tempdir();
        let mut settings = Settings::default();
        settings.s3.secret_access_key = "super-secret-value".to_string();
        save(&dir, &settings).unwrap();
        let raw = std::fs::read_to_string(dir.join(FILE_NAME)).unwrap();
        assert!(!raw.contains("super-secret-value"));
        assert_eq!(load(&dir).s3.secret_access_key, "");
    }

    /// Real end-to-end check against the actual OS keychain (not run by
    /// default — CI/sandboxed environments may not have one unlocked, and
    /// this touches the same entry the running app itself uses). Run
    /// manually with `cargo test --lib s3_secret_round_trips_through_the_real_keychain -- --ignored`.
    #[test]
    #[ignore = "touches the real OS keychain — run manually"]
    fn s3_secret_round_trips_through_the_real_keychain() {
        set_s3_secret_access_key("smoke-test-value-12345").expect("set");
        assert_eq!(
            s3_secret_access_key().as_deref(),
            Some("smoke-test-value-12345")
        );
        clear_s3_secret_access_key().expect("clear");
        assert_eq!(s3_secret_access_key(), None);
        // Clearing an already-cleared entry must stay a no-op, not an error.
        clear_s3_secret_access_key().expect("clear again");
    }

    #[test]
    fn reads_a_legacy_bindings_only_settings_file() {
        let dir = tempdir();
        std::fs::write(dir.join(FILE_NAME), r#"{"left":"none","right":"capture"}"#).unwrap();
        let settings = load(&dir);
        assert_eq!(settings.bindings.left, Action::None);
        assert_eq!(settings.bindings.right, Action::Capture);
        assert_eq!(settings.theme, "tokyo-night");
    }

    #[test]
    fn migrates_the_old_capture_fallback_shortcut() {
        let dir = tempdir();
        let mut settings = Settings::default();
        settings.fallback_capture = LEGACY_FALLBACK_CAPTURE.to_string();
        save(&dir, &settings).unwrap();

        let loaded = load(&dir);

        assert_eq!(loaded.fallback_capture, DEFAULT_FALLBACK_CAPTURE);
    }

    #[test]
    fn preserves_custom_capture_fallback_shortcuts() {
        let dir = tempdir();
        let mut settings = Settings::default();
        settings.fallback_capture = "CmdOrCtrl+Shift+K".to_string();
        save(&dir, &settings).unwrap();

        let loaded = load(&dir);

        assert_eq!(loaded.fallback_capture, "CmdOrCtrl+Shift+K");
    }

    fn tempdir() -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("shiftshift-settings-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
