use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
#[cfg(not(target_os = "macos"))]
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::{db, panel};
#[cfg(not(target_os = "macos"))]
use crate::settings;

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
                    let tap_ok = matches!(
                        pressed,
                        Some((s, t)) if s == side && !dirty && t.elapsed() < HOLD_LIMIT
                    );
                    pressed = None;
                    if !tap_ok {
                        last_tap = None;
                        return;
                    }
                    if let Some((s, t)) = last_tap {
                        if s == side && t.elapsed() < TAP_WINDOW {
                            last_tap = None;
                            let bindings = *app.state::<settings::SettingsState>().0.lock().unwrap();
                            run_action(&app, action_for(bindings, side));
                            return;
                        }
                    }
                    last_tap = Some((side, Instant::now()));
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
pub fn register_fallback_shortcuts(app: &AppHandle) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let gs = app.global_shortcut();
    if let Err(e) = gs.on_shortcut("CmdOrCtrl+Shift+Space", |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            panel::toggle(app);
        }
    }) {
        eprintln!("shiftshift: could not register CmdOrCtrl+Shift+Space: {e}");
    }
    if let Err(e) = gs.on_shortcut("CmdOrCtrl+Shift+C", |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            capture_selection(app);
        }
    }) {
        eprintln!("shiftshift: could not register CmdOrCtrl+Shift+C: {e}");
    }
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
            add_text_item(app, text.trim())?;
        }
        None => {
            restore(&mut clip, old);
        }
    }
    Ok(())
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

fn add_text_item(app: &AppHandle, text: &str) -> Result<(), String> {
    let db = app.state::<db::Db>();
    db.0.add_item(text, crate::store::ItemKind::Note, None)?;
    let _ = app.emit("refresh", ());
    let _ = app.emit("captured", ());
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
