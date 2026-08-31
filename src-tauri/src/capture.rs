use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::{db, panel, settings};

/// Marker written to the clipboard before simulating copy, so "nothing was
/// selected" can be told apart from "the same text was copied again".
const SENTINEL: &str = "\u{200B}shiftshift::capturing\u{200B}";
pub(crate) const TAP_WINDOW: Duration = Duration::from_millis(400);
pub(crate) const HOLD_LIMIT: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Side {
    Left,
    Right,
}

/// Which double-tap gesture triggers which action. Defaults to shiftshift's
/// original mapping (left = capture selection, right = toggle panel) but is
/// user-configurable from the settings screen; persisted via `settings.rs`
/// and read live by both tap listeners so a change applies without restart.
#[derive(Clone, Copy, Serialize, Deserialize)]
pub struct Bindings {
    pub left: Action,
    pub right: Action,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Capture,
    TogglePanel,
    None,
}

/// What happens when text is captured (double-shift, CLI, or clipboard-watch).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMode {
    /// Saved straight to the store; the panel does not appear.
    #[default]
    Silent,
    /// Saved, and the panel is raised so the result is visible immediately.
    Open,
    /// Not saved yet — the panel opens with the captured text prefilled in
    /// the input, so the user can edit it before pressing Enter to save.
    Draft,
}

impl Default for Bindings {
    fn default() -> Self {
        Self { left: Action::Capture, right: Action::TogglePanel }
    }
}

pub(crate) fn action_for(bindings: Bindings, side: Side) -> Action {
    match side {
        Side::Left => bindings.left,
        Side::Right => bindings.right,
    }
}

/// What a completed gesture produced: nothing, a bound double-tap action, or
/// (see `promote_last_capture_to_todo`) a third tap fast-following a Capture
/// double-tap, which promotes that capture to a todo instead of running a
/// fresh capture. Carries the double-tap's own completion time so the
/// promotion only picks up a capture from *that* gesture.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Fired {
    Nothing,
    Action(Action),
    PromoteToTodo(Instant),
}

/// The most recent item created by a Capture gesture, and when. Lets a
/// fast-following third tap (`promote_last_capture_to_todo`) retroactively
/// flip a just-saved Note to a Todo without re-running the capture — which
/// would both be blocked by `CAPTURING` below and needlessly re-simulate the
/// copy chord.
static LAST_CAPTURE: Mutex<Option<(String, Instant)>> = Mutex::new(None);

/// How long a promotion request still counts as "for that capture" — must
/// comfortably exceed `do_capture`'s own worst-case latency (60ms settle +
/// up to 14x50ms polling ~= 760ms).
const PROMOTE_GRACE: Duration = Duration::from_millis(1500);

/// Waits (off-thread, briefly) for the capture from the gesture at
/// `gesture_at` to land, then flips its kind to Todo. A silent no-op if nothing
/// was actually captured (no selection) within the grace window.
pub(crate) fn promote_last_capture_to_todo(app: &AppHandle, gesture_at: Instant) {
    let app = app.clone();
    std::thread::spawn(move || {
        let deadline = Instant::now() + PROMOTE_GRACE;
        loop {
            if let Some((id, at)) = LAST_CAPTURE.lock().unwrap().clone() {
                if at >= gesture_at {
                    let db = app.state::<db::Db>();
                    if db.store.set_kind(&id, crate::store::ItemKind::Todo).is_ok() {
                        let _ = app.emit("refresh", ());
                    }
                    return;
                }
            }
            if Instant::now() >= deadline {
                return;
            }
            std::thread::sleep(Duration::from_millis(30));
        }
    });
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
fn run_action(app: &AppHandle, action: Action) {
    match action {
        Action::Capture => capture_selection(app),
        Action::TogglePanel => panel::toggle(app),
        Action::None => {}
    }
}

/// Global low-level keyboard listener for Linux/Windows. Disabled on macOS,
/// where rdev's event tap crashes inside HIToolbox (see `mac_tap.rs`).
#[cfg(not(target_os = "macos"))]
pub fn start_double_shift_listener(app: AppHandle) {
    std::thread::spawn(move || {
        let mut pressed: Option<(Side, Instant)> = None;
        let mut dirty = false;
        let mut last_tap: Option<(Side, Instant)> = None;
        let mut last_double: Option<(Side, Instant, Action)> = None;

        let result = rdev::listen(move |event| {
            use rdev::{EventType, Key};
            match event.event_type {
                EventType::KeyPress(Key::ShiftLeft) => {
                    if pressed.is_none() {
                        pressed = Some((Side::Left, Instant::now()));
                        dirty = false;
                    }
                }
                EventType::KeyPress(Key::ShiftRight) => {
                    if pressed.is_none() {
                        pressed = Some((Side::Right, Instant::now()));
                        dirty = false;
                    }
                }
                EventType::KeyPress(_) => {
                    dirty = true;
                    last_tap = None;
                }
                EventType::KeyRelease(Key::ShiftLeft) | EventType::KeyRelease(Key::ShiftRight) => {
                    let side = if matches!(event.event_type, EventType::KeyRelease(Key::ShiftLeft)) {
                        Side::Left
                    } else {
                        Side::Right
                    };
                    let now = Instant::now();
                    let tap_ok = matches!(
                        pressed,
                        Some((s, t)) if s == side && !dirty && t.elapsed() < HOLD_LIMIT
                    );
                    pressed = None;
                    if !tap_ok {
                        last_tap = None;
                        last_double = None;
                        return;
                    }
                    if let Some((prev_side, prev_at, prev_action)) = last_double {
                        if prev_side == side && now.saturating_duration_since(prev_at) < TAP_WINDOW {
                            last_double = None;
                            last_tap = None;
                            if prev_action == Action::Capture {
                                promote_last_capture_to_todo(&app, prev_at);
                            }
                            return;
                        }
                    }
                    if let Some((s, t)) = last_tap {
                        if s == side && t.elapsed() < TAP_WINDOW {
                            last_tap = None;
                            let bindings = app.state::<settings::SettingsState>().0.lock().unwrap().bindings;
                            let action = action_for(bindings, side);
                            last_double = Some((side, now, action));
                            run_action(&app, action);
                            return;
                        }
                    }
                    last_tap = Some((side, now));
                    last_double = None;
                }
                _ => {}
            }
        });
        if let Err(e) = result {
            eprintln!(
                "shiftshift: global keyboard listener unavailable ({e:?}); double-shift disabled, fallback hotkeys still active"
            );
        }
    });
}

/// Standard hotkeys for environments where the raw keyboard hook is
/// unavailable (Wayland, denied permissions) or if the user prefers them.
/// Accelerators are user-configurable from the settings screen (persisted as
/// `fallback_toggle`/`fallback_capture`); see `reregister_fallback_shortcuts`
/// for changing them at runtime.
pub fn register_fallback_shortcuts(app: &AppHandle, toggle: &str, capture: &str, image: &str) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let gs = app.global_shortcut();
    // An empty accelerator means "disabled" — the user cleared it in
    // Settings, not an accidental invalid string to reject.
    if !toggle.is_empty() {
        gs.on_shortcut(toggle, |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                panel::toggle(app);
            }
        })
        .map_err(|e| format!("could not register fallback toggle shortcut {toggle:?}: {e}"))?;
    }
    if !capture.is_empty() {
        gs.on_shortcut(capture, |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                capture_selection(app);
            }
        })
        .map_err(|e| format!("could not register fallback capture shortcut {capture:?}: {e}"))?;
    }
    if !image.is_empty() {
        gs.on_shortcut(image, |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                if let Err(e) = crate::images::capture_clipboard_image(app) {
                    eprintln!("shiftshift: image capture failed: {e}");
                }
            }
        })
        .map_err(|e| format!("could not register fallback image shortcut {image:?}: {e}"))?;
    }
    Ok(())
}

/// Swaps the fallback shortcuts at runtime. Registers the new accelerators
/// first and only unregisters the old ones once that succeeds, so a bad
/// accelerator string never leaves the user with no fallback shortcuts at all.
pub fn reregister_fallback_shortcuts(
    app: &AppHandle,
    old: (&str, &str, &str),
    new: (&str, &str, &str),
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    register_fallback_shortcuts(app, new.0, new.1, new.2)?;
    let gs = app.global_shortcut();
    let _ = gs.unregister(old.0);
    let _ = gs.unregister(old.1);
    let _ = gs.unregister(old.2);
    Ok(())
}

/// Capture whatever text is selected in the foreground app by simulating the
/// platform copy chord and reading the clipboard.
pub fn capture_selection(app: &AppHandle) {
    static CAPTURING: AtomicBool = AtomicBool::new(false);
    if CAPTURING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = do_capture(&app) {
            eprintln!("shiftshift: capture failed: {e}");
        }
        CAPTURING.store(false, Ordering::SeqCst);
    });
}

fn do_capture(app: &AppHandle) -> Result<(), String> {
    // Read before the copy chord fires — the frontmost app shouldn't change
    // during that, but there's no reason to risk the race.
    let source_app = frontmost_app_name();

    let mut clip = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let old = clip.get_text().ok();
    let _ = clip.set_text(SENTINEL.to_string());

    std::thread::sleep(Duration::from_millis(60));
    if let Err(e) = send_copy(app) {
        restore(&mut clip, old);
        return Err(e);
    }

    let mut captured = None;
    for _ in 0..14 {
        std::thread::sleep(Duration::from_millis(50));
        if let Ok(text) = clip.get_text() {
            if text != SENTINEL && !text.trim().is_empty() {
                captured = Some(text);
                break;
            }
        }
    }

    match captured {
        Some(text) => {
            handle_captured_text(app, text.trim(), source_app)?;
        }
        None => {
            restore(&mut clip, old);
        }
    }
    Ok(())
}

/// Mirrors `capture-logic.ts`'s `detectKind` (`/^https?:\/\/\S+$/`) — the
/// frontend's typed-capture path already classifies a bare URL as a link;
/// this brings the same classification to the gesture/CLI/clipboard-watch
/// paths, which previously hardcoded every capture as a plain Note
/// regardless of content, so a captured URL never got the link icon,
/// favicon/title fetch, or click-to-open behavior.
pub(crate) fn detect_kind(text: &str) -> crate::store::ItemKind {
    let trimmed = text.trim();
    let rest = trimmed.strip_prefix("https://").or_else(|| trimmed.strip_prefix("http://"));
    let is_bare_url = matches!(rest, Some(r) if !r.is_empty() && !r.contains(char::is_whitespace));
    if is_bare_url {
        crate::store::ItemKind::Link
    } else {
        crate::store::ItemKind::Note
    }
}

/// Best-effort "what app is frontmost" lookup for the source-app field on
/// captured items (Raycast-style per-item source tracking). Goes through
/// System Events' AppleScript bridge rather than the Accessibility API, so
/// it works without the same permission grant the double-shift hook needs —
/// AppleScript's "get name of first process whose frontmost is true" is a
/// read-only System Events query, not an Accessibility-gated action.
#[cfg(target_os = "macos")]
pub(crate) fn frontmost_app_name() -> Option<String> {
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(r#"tell application "System Events" to get name of first application process whose frontmost is true"#)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn frontmost_app_name() -> Option<String> {
    None
}

fn restore(clip: &mut arboard::Clipboard, old: Option<String>) {
    match old {
        Some(text) => {
            let _ = clip.set_text(text);
        }
        None => {
            let _ = clip.clear();
        }
    }
}

/// Applies the user's `CaptureMode`: the single place every capture source
/// (double-shift gesture, CLI, clipboard-watch) routes through, so they all
/// respect the same "silent / open / draft" setting.
///
/// Also seeds `LAST_KNOWN_CLIPBOARD` (see `clipboard_watch.rs`) with the
/// saved text: whatever backend just captured this became the clipboard
/// contents at some point on the way in, and treating it as "already seen"
/// stops clipboard-watch from re-capturing it as a second, duplicate item.
pub(crate) fn handle_captured_text(app: &AppHandle, text: &str, source_app: Option<String>) -> Result<(), String> {
    crate::clipboard_watch::note_own_write(text);

    let mode = app.state::<settings::SettingsState>().0.lock().unwrap().capture_mode;
    if mode == CaptureMode::Draft {
        let _ = app.emit("draft-capture", text);
        panel::show(app);
        return Ok(());
    }

    let db = app.state::<db::Db>();
    let item = db.store.add_item(text, detect_kind(text), source_app)?;
    *LAST_CAPTURE.lock().unwrap() = Some((item.id.clone(), Instant::now()));
    let _ = db.store.log_event(Some(&item.id), "created", Some(&item.text));
    let _ = app.emit("refresh", ());
    let _ = app.emit("captured", ());
    crate::notify::notify_captured(app, &item);
    if mode == CaptureMode::Open {
        panel::show(app);
    }
    Ok(())
}

/// Press the platform copy chord. On macOS this must run on the main thread —
/// enigo's keyboard-layout mapping asserts it is on the main dispatch queue
/// and aborts the process otherwise (the same rule that makes rdev unusable
/// on macOS, see `mac_tap.rs`).
fn send_copy(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(press_copy_chord());
        })
        .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|_| "timed out sending the copy chord".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        press_copy_chord()
    }
}

#[allow(dead_code)]
fn press_copy_chord() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use enigo::{Direction, Enigo, Key, Keyboard, Settings};
        let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
        enigo.key(Key::Meta, Direction::Press).map_err(|e| e.to_string())?;
        enigo.key(Key::Unicode('c'), Direction::Click).map_err(|e| e.to_string())?;
        enigo.key(Key::Meta, Direction::Release).map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("copy-chord simulation not yet wired up for this platform".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::ItemKind;

    #[test]
    fn classifies_a_bare_url_as_a_link() {
        assert_eq!(detect_kind("https://example.com/path"), ItemKind::Link);
        assert_eq!(detect_kind("http://example.com"), ItemKind::Link);
    }

    #[test]
    fn classifies_plain_text_as_a_note() {
        assert_eq!(detect_kind("just some text"), ItemKind::Note);
    }

    #[test]
    fn does_not_classify_a_url_embedded_in_a_sentence_as_a_link() {
        assert_eq!(detect_kind("see https://example.com for details"), ItemKind::Note);
    }

    #[test]
    fn trims_surrounding_whitespace_before_checking() {
        assert_eq!(detect_kind("  https://example.com  \n"), ItemKind::Link);
    }
}
