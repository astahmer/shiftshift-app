//! Double-shift listener for macOS, built on a listen-only `CGEventTap`.
//!
//! rdev is unusable here: it decodes characters off the main thread via the
//! keyboard-layout APIs, which aren't thread-safe and crash inside HIToolbox.
//! Telling the two Shift keys apart only needs the modifier flag bits, so
//! this tap never touches those APIs.
//!
//! The tap needs **Input Monitoring** (`kTCCServiceListenEvent`) — not
//! Accessibility, which is a different permission and is only what lets the
//! panel take focus afterwards. Granting Accessibility alone leaves the
//! gesture completely dead while every check that looks at
//! `AXIsProcessTrusted` cheerfully reports "granted", which is a deeply
//! misleading place to end up; see `input_monitoring_granted`.
//!
//! An unauthorised tap does not fail loudly — it hands back a live-looking
//! port with its mask silently stripped — so viability is judged by
//! `CGEventTapIsEnabled`, not by getting a handle back.
//!
//! Note also that running the binary straight from a terminal masks all of
//! this: the responsible process is then the terminal, so the tap inherits
//! whatever permissions *it* has and works even when the app bundle's own
//! grants are missing.
//!
//! `pnpm tauri dev` is exactly that case — it runs `target/debug` as a child
//! of your terminal — so it can never surface a missing permission here, and
//! neither can `cargo run` or launching the bundle's binary by path. Verify
//! anything permission-sensitive against the installed .app launched the
//! normal way (Finder/Spotlight/`open -a`); that is the only path that
//! exercises the bundle's own TCC identity.

use std::cell::RefCell;
use std::ffi::c_void;
use std::os::raw::c_uchar;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use core_foundation::base::TCFType;
use core_foundation::mach_port::CFMachPortRef;
use core_foundation::runloop::{kCFRunLoopCommonModes, kCFRunLoopDefaultMode, CFRunLoop};
use core_graphics::event::{
    CGEvent, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventTapProxy, CGEventType, CallbackResult,
};
use tauri::{AppHandle, Manager};

use crate::capture::{self, action_for, Action, Bindings, Fired, Side, HOLD_LIMIT, TAP_WINDOW};
use crate::panel;
use crate::settings::SettingsState;

const NX_DEVICELSHIFTKEYMASK: u64 = 0x0000_0002;
const NX_DEVICERSHIFTKEYMASK: u64 = 0x0000_0004;
const SHIFT_BITS: u64 = NX_DEVICELSHIFTKEYMASK | NX_DEVICERSHIFTKEYMASK;
const NX_SHIFTMASK: u64 = 0x0002_0000;
const NX_NONCOALESCEDMASK: u64 = 0x2000_0000;
/// Bits that move as a side effect of a plain Shift tap; a change confined to
/// these must not be mistaken for "some other modifier was pressed".
const COMPANION_BITS: u64 = SHIFT_BITS | NX_SHIFTMASK | NX_NONCOALESCEDMASK;

const RETRY_DELAY: Duration = Duration::from_secs(3);
const HEALTH_INTERVAL: Duration = Duration::from_secs(2);

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    fn CGEventTapIsEnabled(tap: CFMachPortRef) -> bool;
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> c_uchar;
}

// Listening to keystrokes from other apps is gated by Input Monitoring
// (`kTCCServiceListenEvent`), which is a *separate* permission from
// Accessibility — `AXIsProcessTrusted` says nothing about it. Without it
// `CGEventTap::new` still hands back a live-looking port whose mask has
// been silently stripped, which is exactly the "tap would not arm despite
// Accessibility being granted" case.
#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOHIDCheckAccess(request: u32) -> u32;
    fn IOHIDRequestAccess(request: u32) -> bool;
}

const KIOHID_REQUEST_TYPE_LISTEN_EVENT: u32 = 1;
const KIOHID_ACCESS_TYPE_GRANTED: u32 = 0;

/// Whether Input Monitoring is granted. Also see `request_input_monitoring`,
/// which is what actually puts the app in the System Settings list.
pub fn input_monitoring_granted() -> bool {
    unsafe { IOHIDCheckAccess(KIOHID_REQUEST_TYPE_LISTEN_EVENT) == KIOHID_ACCESS_TYPE_GRANTED }
}

/// Whether the gesture listener is usable. macOS can keep reporting an
/// unknown TCC result for an ad-hoc app bundle even after the event tap has
/// successfully armed, so the live tap is the authoritative fallback.
pub fn input_monitoring_ready() -> bool {
    input_monitoring_granted() || is_running()
}

/// Prompts for Input Monitoring the first time, and — importantly — makes
/// macOS create the app's row in System Settings so the checkbox is there
/// to tick, mirroring what `AXIsProcessTrusted` does for Accessibility.
pub fn request_input_monitoring() -> bool {
    unsafe { IOHIDRequestAccess(KIOHID_REQUEST_TYPE_LISTEN_EVENT) }
}

static TAP_RUNNING: AtomicBool = AtomicBool::new(false);

/// Reserved for a future settings screen to show tap health.
#[allow(dead_code)]
pub fn is_running() -> bool {
    TAP_RUNNING.load(Ordering::Relaxed)
}

/// Calling this also makes macOS create the app's row in the Accessibility
/// list, so the user can tick a checkbox instead of hunting for it.
pub fn is_trusted() -> bool {
    unsafe { AXIsProcessTrusted() != 0 }
}

struct State {
    prev_flags: u64,
    pressed: Option<(Side, Instant)>,
    dirty: bool,
    last_tap: Option<(Side, Instant)>,
    /// The side, time, and action of the double-tap that just fired, so a
    /// fast-following third tap on the same side can be recognised as a
    /// promote-to-todo rather than starting (or breaking) a fresh pair.
    last_double: Option<(Side, Instant, Action)>,
}

/// Driven by flag-bit edges rather than key events, so holding both Shifts
/// resolves correctly and state resynchronises if an event is ever missed.
/// `now` is passed in rather than read inside so the timing rules are
/// testable.
fn on_flags_changed(state: &RefCell<State>, flags: u64, now: Instant, bindings: Bindings) -> Fired {
    let mut s = state.borrow_mut();
    let changed = flags ^ s.prev_flags;
    s.prev_flags = flags;

    if changed & !COMPANION_BITS != 0 {
        s.dirty = true;
        s.last_tap = None;
        s.last_double = None;
    }

    let mut fired = Fired::Nothing;
    for &(bit, side) in &[
        (NX_DEVICELSHIFTKEYMASK, Side::Left),
        (NX_DEVICERSHIFTKEYMASK, Side::Right),
    ] {
        if changed & bit == 0 {
            continue;
        }
        if flags & bit != 0 {
            if s.pressed.is_none() {
                s.pressed = Some((side, now));
                s.dirty = false;
            }
            continue;
        }
        let tapped = match s.pressed {
            Some((p, at)) => {
                p == side && !s.dirty && now.saturating_duration_since(at) < HOLD_LIMIT
            }
            None => false,
        };
        s.pressed = None;
        if !tapped {
            s.last_tap = None;
            s.last_double = None;
            continue;
        }

        if let Some((prev_side, prev_at, prev_action)) = s.last_double {
            if prev_side == side && now.saturating_duration_since(prev_at) < TAP_WINDOW {
                s.last_double = None;
                s.last_tap = None;
                fired = if prev_action == Action::Capture {
                    Fired::PromoteToTodo(prev_at)
                } else {
                    Fired::Nothing
                };
                continue;
            }
        }

        let is_double = matches!(
            s.last_tap,
            Some((prev, at)) if prev == side && now.saturating_duration_since(at) < TAP_WINDOW
        );
        if is_double {
            s.last_tap = None;
            let action = action_for(bindings, side);
            s.last_double = Some((side, now, action));
            fired = Fired::Action(action);
        } else {
            s.last_tap = Some((side, now));
            s.last_double = None;
        }
    }
    fired
}

fn run_tap(app: &AppHandle) -> Result<(), &'static str> {
    let state = RefCell::new(State {
        prev_flags: 0,
        pressed: None,
        dirty: false,
        last_tap: None,
        last_double: None,
    });
    let port: Arc<AtomicPtr<c_void>> = Arc::new(AtomicPtr::new(ptr::null_mut()));
    let port_cb = Arc::clone(&port);
    let app_cb = app.clone();

    let tap = CGEventTap::new(
        CGEventTapLocation::Session,
        CGEventTapPlacement::HeadInsertEventTap,
        CGEventTapOptions::ListenOnly,
        vec![CGEventType::FlagsChanged, CGEventType::KeyDown],
        move |_proxy: CGEventTapProxy, etype: CGEventType, event: &CGEvent| {
            match etype {
                CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput => {
                    let p = port_cb.load(Ordering::Relaxed);
                    if !p.is_null() {
                        unsafe { CGEventTapEnable(p as CFMachPortRef, true) };
                    }
                }
                CGEventType::KeyDown => {
                    let mut s = state.borrow_mut();
                    s.dirty = true;
                    s.last_tap = None;
                }
                CGEventType::FlagsChanged => {
                    let bindings = app_cb.state::<SettingsState>().0.lock().unwrap().bindings;
                    match on_flags_changed(
                        &state,
                        event.get_flags().bits(),
                        Instant::now(),
                        bindings,
                    ) {
                        Fired::Action(Action::Capture) => capture::capture_selection(&app_cb),
                        // `panel::toggle` shows/focuses a window — running it inline on
                        // this callback risks macOS's CGEventTap watchdog disabling the
                        // tap (`TapDisabledByTimeout`) before it returns, but a plain
                        // spawned thread isn't the fix either: stealing focus from
                        // whatever app is currently frontmost is an AppKit operation
                        // that's unreliable off the main thread (it can silently fail
                        // to activate instead of erroring). `run_on_main_thread` just
                        // enqueues the closure and returns immediately, so the tap
                        // callback stays fast *and* the actual window activation runs
                        // on the thread that can actually do it.
                        Fired::Action(Action::TogglePanel) => {
                            let app = app_cb.clone();
                            let _ = app_cb.run_on_main_thread(move || panel::toggle(&app));
                        }
                        Fired::Action(Action::None) | Fired::Nothing => {}
                        Fired::PromoteToTodo(gesture_at) => {
                            capture::promote_last_capture_to_todo(&app_cb, gesture_at)
                        }
                    }
                }
                _ => {}
            }
            CallbackResult::Keep
        },
    )
    .map_err(|()| "could not create the event tap")?;

    let port_ref = tap.mach_port().as_concrete_TypeRef();
    port.store(port_ref as *mut c_void, Ordering::Relaxed);
    let source = tap
        .mach_port()
        .create_runloop_source(0)
        .map_err(|()| "could not attach the tap to a run loop")?;
    CFRunLoop::get_current().add_source(&source, unsafe { kCFRunLoopCommonModes });
    tap.enable();

    // Input Monitoring is checked first and named explicitly: it's the one
    // that actually gates a keystroke tap, it's a different permission from
    // Accessibility, and an earlier version of this message only mentioned
    // Accessibility — which reads as "permissions are fine, something else
    // is broken" and sends you looking in entirely the wrong place.
    if !unsafe { CGEventTapIsEnabled(port_ref) } {
        return Err(match (input_monitoring_granted(), is_trusted()) {
            (false, _) => "Input Monitoring not granted (System Settings > Privacy & Security > Input Monitoring) — this is separate from Accessibility, and it is what a keystroke tap needs",
            (true, false) => "Accessibility not granted",
            (true, true) => "the event tap would not arm even though Input Monitoring and Accessibility are both granted",
        });
    }

    TAP_RUNNING.store(true, Ordering::Relaxed);
    while unsafe { CGEventTapIsEnabled(port_ref) } {
        CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, HEALTH_INTERVAL, false);
    }
    TAP_RUNNING.store(false, Ordering::Relaxed);
    Err("the event tap was switched off")
}

/// Start the listener on its own thread. Never fails loudly: if the
/// permission is missing we keep retrying, and the fallback hotkeys still
/// work regardless.
pub fn start(app: AppHandle) {
    let _ = is_trusted();
    // Also puts the app in the Input Monitoring list so there's a checkbox
    // to tick — without this the row never appears and the permission is
    // undiscoverable.
    let _ = request_input_monitoring();
    std::thread::spawn(move || {
        let mut reported: Option<&'static str> = None;
        loop {
            if let Err(reason) = run_tap(&app) {
                if reported != Some(reason) {
                    reported = Some(reason);
                    eprintln!(
                        "shiftshift: double-shift inactive — {reason}; fallback hotkeys still work"
                    );
                }
            }
            std::thread::sleep(RETRY_DELAY);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const L: u64 = NX_DEVICELSHIFTKEYMASK;
    const R: u64 = NX_DEVICERSHIFTKEYMASK;

    fn state() -> RefCell<State> {
        RefCell::new(State {
            prev_flags: 0,
            pressed: None,
            dirty: false,
            last_tap: None,
            last_double: None,
        })
    }

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn flags(held: u64) -> u64 {
        if held == 0 {
            NX_NONCOALESCEDMASK
        } else {
            held | NX_SHIFTMASK | NX_NONCOALESCEDMASK
        }
    }

    fn feed(st: &RefCell<State>, base: Instant, steps: &[(u64, u64)]) -> Fired {
        let bindings = Bindings::default();
        let mut last = Fired::Nothing;
        for &(held, at) in steps {
            last = on_flags_changed(st, flags(held), base + ms(at), bindings);
        }
        last
    }

    #[test]
    fn left_double_tap_captures() {
        let (st, t0) = (state(), Instant::now());
        let a = feed(&st, t0, &[(L, 0), (0, 50), (L, 100), (0, 150)]);
        assert_eq!(a, Fired::Action(Action::Capture));
    }

    #[test]
    fn right_double_tap_toggles() {
        let (st, t0) = (state(), Instant::now());
        let a = feed(&st, t0, &[(R, 0), (0, 50), (R, 100), (0, 150)]);
        assert_eq!(a, Fired::Action(Action::TogglePanel));
    }

    #[test]
    fn single_tap_does_nothing() {
        let (st, t0) = (state(), Instant::now());
        let a = feed(&st, t0, &[(L, 0), (0, 50)]);
        assert_eq!(a, Fired::Nothing);
    }

    #[test]
    fn second_tap_after_the_window_does_not_fire() {
        let (st, t0) = (state(), Instant::now());
        let a = feed(&st, t0, &[(L, 0), (0, 50), (L, 100), (0, 500)]);
        assert_eq!(a, Fired::Nothing);
    }

    #[test]
    fn holding_shift_too_long_is_not_a_tap() {
        let (st, t0) = (state(), Instant::now());
        let a = feed(&st, t0, &[(L, 0), (0, 600), (L, 700), (0, 1300)]);
        assert_eq!(a, Fired::Nothing);
    }

    #[test]
    fn the_two_sides_do_not_combine() {
        let (st, t0) = (state(), Instant::now());
        let a = feed(&st, t0, &[(L, 0), (0, 50), (R, 100), (0, 150)]);
        assert_eq!(a, Fired::Nothing);
    }

    #[test]
    fn holding_both_shifts_fires_nothing() {
        let (st, t0) = (state(), Instant::now());
        let a = feed(&st, t0, &[(L, 0), (L | R, 20), (R, 40), (0, 60)]);
        assert_eq!(a, Fired::Nothing);
    }

    #[test]
    fn triple_tap_on_the_capture_side_promotes_to_todo() {
        let (st, t0) = (state(), Instant::now());
        // Left is bound to Capture by default: tap, tap (fires Capture), tap
        // (promotes) — each release within TAP_WINDOW of the previous.
        let a = feed(
            &st,
            t0,
            &[(L, 0), (0, 50), (L, 100), (0, 150), (L, 200), (0, 250)],
        );
        assert_eq!(a, Fired::PromoteToTodo(t0 + ms(150)));
    }

    #[test]
    fn triple_tap_on_the_toggle_panel_side_does_nothing_extra() {
        let (st, t0) = (state(), Instant::now());
        // Right is bound to TogglePanel by default — nothing to promote.
        let a = feed(
            &st,
            t0,
            &[(R, 0), (0, 50), (R, 100), (0, 150), (R, 200), (0, 250)],
        );
        assert_eq!(a, Fired::Nothing);
    }

    #[test]
    fn a_fourth_tap_after_a_promotion_starts_a_fresh_pair() {
        let (st, t0) = (state(), Instant::now());
        // Triple-tap promotes at 250ms, then a lone fourth tap must not
        // itself fire anything — it only arms a new potential double.
        let a = feed(
            &st,
            t0,
            &[
                (L, 0),
                (0, 50),
                (L, 100),
                (0, 150),
                (L, 200),
                (0, 250),
                (L, 300),
                (0, 350),
            ],
        );
        assert_eq!(a, Fired::Nothing);
    }

    #[test]
    fn a_third_tap_outside_the_window_does_not_promote() {
        let (st, t0) = (state(), Instant::now());
        // Third release lands 450ms after the double fired, past TAP_WINDOW.
        let a = feed(
            &st,
            t0,
            &[(L, 0), (0, 50), (L, 100), (0, 150), (L, 550), (0, 600)],
        );
        assert_eq!(a, Fired::Nothing);
    }
}
