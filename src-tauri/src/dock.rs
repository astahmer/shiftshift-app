//! Edge notch (Settings -> Dock). Geometry is Tokitoki's: a 20×66 handle
//! flush to one of 20 perimeter anchors. The window keeps the expanded
//! footprint; CSS springs the black surface from the handle. Hover/leave
//! uses a main-thread pointer poll (DOM mouseleave is unreliable on a
//! click-through webview). Never uses the toast's inset 3×3 grid.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

use crate::settings::{SettingsState, ToastPosition};

const DOCK_LABEL: &str = "dock";
/// Tokitoki's icon rail is 84px (quota rings). Ours lists capture titles,
/// so the expanded rail has to be wide enough to read — 84px is what made
/// expand look "clipped off the screen" when it was actually just too thin.
const EXPANDED_ACROSS: f64 = 320.0;
const COLLAPSED_ALONG: f64 = 66.0;
const COLLAPSED_ACROSS: f64 = 20.0;
/// Keep in sync with `src/dock.ts` (`NOTCH_CHROME` / `NOTCH_ROW_GAP`).
const NOTCH_CHROME: f64 = 94.0;
const NOTCH_ROW_GAP: f64 = 6.0;
const DEFAULT_ROW_HEIGHT: f64 = 36.0;
const MIN_ROW_HEIGHT: f64 = 28.0;
const MAX_ROW_HEIGHT: f64 = 64.0;
const MIN_ITEM_COUNT: u8 = 1;
const MAX_ITEM_COUNT: u8 = 16;
/// Extra reach past the visible 20×66 pill. The thin across-axis is the
/// hard miss — pad more toward the screen interior than off-screen, but
/// stay near the pill: a pointer crossing the menu bar or skimming the
/// edge should not arm the rail.
const HOVER_INSET_ALONG: f64 = 12.0;
const HOVER_INSET_INSIDE: f64 = 20.0;
const HOVER_INSET_OUTSIDE: f64 = 6.0;
/// Stay open while the pointer is just outside grabbing a resize edge.
const RESIZE_SLOP: f64 = 12.0;
const MIN_EXPANDED_WIDTH: f64 = 160.0;
const MAX_EXPANDED_WIDTH: f64 = 560.0;
const MIN_EXPANDED_HEIGHT: f64 = 140.0;
const MAX_EXPANDED_HEIGHT: f64 = 720.0;

static VISUALLY_EXPANDED: AtomicBool = AtomicBool::new(false);
static ARRANGING: AtomicBool = AtomicBool::new(false);
static RESIZING: AtomicBool = AtomicBool::new(false);
static COMPOSER_ACTIVE: AtomicBool = AtomicBool::new(false);
static POINTER_WATCH_STARTED: AtomicBool = AtomicBool::new(false);
static TICK_PENDING: AtomicBool = AtomicBool::new(false);
static FRAME_GEN: AtomicU64 = AtomicU64::new(0);

/// Settings -> Dock -> enable/disable toggle — shows/hides the persistent
/// window, always starting collapsed.
pub fn apply_enabled(app: &AppHandle, enabled: bool) {
    if !enabled {
        VISUALLY_EXPANDED.store(false, Ordering::SeqCst);
        RESIZING.store(false, Ordering::SeqCst);
        COMPOSER_ACTIVE.store(false, Ordering::SeqCst);
        if let Some(window) = app.get_webview_window(DOCK_LABEL) {
            let _ = window.set_ignore_cursor_events(true);
            let _ = window.hide();
        }
        return;
    }
    let Some(window) = ensure_window(app) else {
        return;
    };
    layout_stable(app);
    VISUALLY_EXPANDED.store(false, Ordering::SeqCst);
    let _ = window.set_ignore_cursor_events(true);
    let _ = window.set_focusable(false);
    let _ = window.show();
    start_pointer_watch(app);
}

/// Visual expand/collapse only — the window keeps the full rail footprint
/// (Tokitoki). CSS springs the black surface from the 20×66 handle.
pub fn set_expanded(app: &AppHandle, expanded: bool) {
    start_pointer_watch(app);
    if !expanded && COMPOSER_ACTIVE.load(Ordering::SeqCst) {
        return;
    }
    if !expanded {
        COMPOSER_ACTIVE.store(false, Ordering::SeqCst);
    }
    if VISUALLY_EXPANDED.swap(expanded, Ordering::SeqCst) == expanded {
        return;
    }
    let Some(window) = ensure_window(app) else {
        VISUALLY_EXPANDED.store(!expanded, Ordering::SeqCst);
        return;
    };
    let _ = window.set_ignore_cursor_events(!expanded && !ARRANGING.load(Ordering::SeqCst));
    let _ = window.emit("dock-set-expanded", expanded);
}

fn ensure_window(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(window) = app.get_webview_window(DOCK_LABEL) {
        apply_size_limits(&window);
        return Some(window);
    }
    WebviewWindowBuilder::new(app, DOCK_LABEL, WebviewUrl::App("dock.html".into()))
        .title("shiftshift-dock")
        .inner_size(EXPANDED_ACROSS, 508.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .visible(false)
        .skip_taskbar(true)
        .resizable(true)
        .shadow(false)
        .focused(false)
        .focusable(false)
        .accept_first_mouse(true)
        .build()
        .ok()
        .inspect(apply_size_limits)
}

fn apply_size_limits(window: &WebviewWindow) {
    let _ = window.set_min_size(Some(LogicalSize::new(
        MIN_EXPANDED_WIDTH,
        MIN_EXPANDED_HEIGHT,
    )));
    let _ = window.set_max_size(Some(LogicalSize::new(
        MAX_EXPANDED_WIDTH,
        MAX_EXPANDED_HEIGHT,
    )));
}

fn is_vertical(position: ToastPosition) -> bool {
    matches!(
        position,
        ToastPosition::MiddleLeft
            | ToastPosition::MiddleRight
            | ToastPosition::LeftTop
            | ToastPosition::LeftUpper
            | ToastPosition::LeftLower
            | ToastPosition::LeftBottom
            | ToastPosition::RightTop
            | ToastPosition::RightUpper
            | ToastPosition::RightLower
            | ToastPosition::RightBottom
    )
}

#[cfg_attr(not(test), allow(dead_code))]
fn collapsed_size(position: ToastPosition) -> LogicalSize<f64> {
    if is_vertical(position) {
        LogicalSize::new(COLLAPSED_ACROSS, COLLAPSED_ALONG)
    } else {
        LogicalSize::new(COLLAPSED_ALONG, COLLAPSED_ACROSS)
    }
}

fn effective_row_height(settings: &crate::settings::Settings) -> f64 {
    let raw = f64::from(settings.dock_row_height);
    if raw < MIN_ROW_HEIGHT {
        DEFAULT_ROW_HEIGHT
    } else {
        raw.clamp(MIN_ROW_HEIGHT, MAX_ROW_HEIGHT)
    }
}

fn items_that_fit(height: f64, row_height: f64) -> u8 {
    let stride = row_height + NOTCH_ROW_GAP;
    let raw = ((height - NOTCH_CHROME + NOTCH_ROW_GAP) / stride).floor();
    raw.clamp(f64::from(MIN_ITEM_COUNT), f64::from(MAX_ITEM_COUNT)) as u8
}

fn rail_length(item_count: u8, row_height: f64) -> f64 {
    let n = f64::from(item_count.clamp(MIN_ITEM_COUNT, MAX_ITEM_COUNT));
    (NOTCH_CHROME + n * row_height + (n - 1.0) * NOTCH_ROW_GAP)
        .clamp(MIN_EXPANDED_HEIGHT, MAX_EXPANDED_HEIGHT)
}

fn uses_auto_rail(settings: &crate::settings::Settings) -> bool {
    settings.dock_expanded_width < 160
        || settings.dock_expanded_height < 80
        || (settings.dock_expanded_width == 280 && settings.dock_expanded_height == 220)
        || (settings.dock_expanded_width == 280 && settings.dock_expanded_height == 408)
}

fn expanded_size(settings: &crate::settings::Settings) -> LogicalSize<f64> {
    let vertical = is_vertical(settings.dock_position);
    let default_across = EXPANDED_ACROSS;
    let default_along = rail_length(settings.dock_item_count, effective_row_height(settings));
    if uses_auto_rail(settings) {
        return if vertical {
            LogicalSize::new(default_across, default_along)
        } else {
            LogicalSize::new(default_along, default_across)
        };
    }
    clamp_expanded_logical(
        f64::from(settings.dock_expanded_width),
        f64::from(settings.dock_expanded_height),
    )
}

fn clamp_expanded_logical(width: f64, height: f64) -> LogicalSize<f64> {
    LogicalSize::new(
        width.clamp(MIN_EXPANDED_WIDTH, MAX_EXPANDED_WIDTH),
        height.clamp(MIN_EXPANDED_HEIGHT, MAX_EXPANDED_HEIGHT),
    )
}

fn logical_to_physical(logical: LogicalSize<f64>, scale: f64) -> PhysicalSize<u32> {
    PhysicalSize::new(
        (logical.width * scale).round().max(1.0) as u32,
        (logical.height * scale).round().max(1.0) as u32,
    )
}

/// Flush-to-edge top-left for a notch of `window_size`. The contact edge
/// stays glued when the window grows (expand) or shrinks (collapse).
fn frame(
    position: ToastPosition,
    custom: (i32, i32),
    monitor_pos: PhysicalPosition<i32>,
    monitor_size: PhysicalSize<u32>,
    window_size: PhysicalSize<u32>,
) -> (i32, i32) {
    let (mx, my, mw, mh) = (
        monitor_pos.x,
        monitor_pos.y,
        monitor_size.width as i32,
        monitor_size.height as i32,
    );
    let (w, h) = (window_size.width as i32, window_size.height as i32);
    let x_left = mx;
    let x_center = mx + (mw - w) / 2;
    let x_right = mx + mw - w;
    let y_top = my;
    let y_center = my + (mh - h) / 2;
    let y_upper = my + (mh - h) / 4;
    let y_lower = my + 3 * (mh - h) / 4;
    let y_bottom = my + mh - h;
    let x_mid_left = mx + (mw - w) / 4;
    let x_mid_right = mx + 3 * (mw - w) / 4;
    match position {
        ToastPosition::TopLeft => (x_left, y_top),
        ToastPosition::TopMidLeft => (x_mid_left, y_top),
        ToastPosition::TopCenter => (x_center, y_top),
        ToastPosition::TopMidRight => (x_mid_right, y_top),
        ToastPosition::TopRight => (x_right, y_top),
        ToastPosition::LeftTop => (x_left, y_top),
        ToastPosition::LeftUpper => (x_left, y_upper),
        ToastPosition::MiddleLeft => (x_left, y_center),
        ToastPosition::LeftLower => (x_left, y_lower),
        ToastPosition::LeftBottom => (x_left, y_bottom),
        ToastPosition::RightTop => (x_right, y_top),
        ToastPosition::RightUpper => (x_right, y_upper),
        ToastPosition::MiddleRight => (x_right, y_center),
        ToastPosition::RightLower => (x_right, y_lower),
        ToastPosition::RightBottom => (x_right, y_bottom),
        ToastPosition::BottomLeft => (x_left, y_bottom),
        ToastPosition::BottomMidLeft => (x_mid_left, y_bottom),
        ToastPosition::BottomCenter => (x_center, y_bottom),
        ToastPosition::BottomMidRight => (x_mid_right, y_bottom),
        ToastPosition::BottomRight => (x_right, y_bottom),
        ToastPosition::Center => (x_center, y_center),
        ToastPosition::Custom => (
            custom.0.clamp(mx, mx + mw - w),
            custom.1.clamp(my, my + mh - h),
        ),
    }
}

/// Snap from which **window edge** is flush, not the window center.
/// A leftover 320×500 left-rail cannot get its center near the top, so
/// center-based snap refused to stick to top/bottom.
fn snap_to_edge(
    dropped_at: PhysicalPosition<i32>,
    window_size: PhysicalSize<u32>,
    monitor_pos: PhysicalPosition<i32>,
    monitor_size: PhysicalSize<u32>,
    pointer: Option<PhysicalPosition<i32>>,
) -> ToastPosition {
    let mx = monitor_pos.x;
    let my = monitor_pos.y;
    let mw = monitor_size.width.max(1) as i32;
    let mh = monitor_size.height.max(1) as i32;
    let w = window_size.width as i32;
    let h = window_size.height as i32;
    let gaps = [
        ("top", dropped_at.y - my),
        ("right", mx + mw - (dropped_at.x + w)),
        ("bottom", my + mh - (dropped_at.y + h)),
        ("left", dropped_at.x - mx),
    ];
    let nearest = gaps.iter().map(|(_, gap)| *gap).min().unwrap_or(0);
    let tied: Vec<&str> = gaps
        .iter()
        .filter(|(_, gap)| (*gap - nearest).abs() <= 16)
        .map(|(edge, _)| *edge)
        .collect();
    let edge = if tied.len() > 1 {
        if let Some(point) = pointer {
            [
                ("top", point.y - my),
                ("right", mx + mw - point.x),
                ("bottom", my + mh - point.y),
                ("left", point.x - mx),
            ]
            .into_iter()
            .min_by_key(|(_, distance)| *distance)
            .map(|(name, _)| name)
            .unwrap_or(tied[0])
        } else {
            tied[0]
        }
    } else {
        gaps.iter()
            .find(|(_, gap)| *gap == nearest)
            .map(|(name, _)| *name)
            .unwrap_or("right")
    };
    let along = match edge {
        "top" | "bottom" => {
            let x = pointer.map(|p| p.x).unwrap_or(dropped_at.x + w / 2);
            f64::from(x - mx) / f64::from(mw)
        }
        _ => {
            let y = pointer.map(|p| p.y).unwrap_or(dropped_at.y + h / 2);
            f64::from(y - my) / f64::from(mh)
        }
    };
    slot_on_edge(edge, along.clamp(0.0, 1.0))
}

fn slot_on_edge(edge: &str, along: f64) -> ToastPosition {
    let slot = [0.0_f64, 0.25, 0.5, 0.75, 1.0]
        .into_iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| (a - along).abs().total_cmp(&(b - along).abs()))
        .map(|(i, _)| i)
        .unwrap_or(2);
    match edge {
        "top" => [
            ToastPosition::TopLeft,
            ToastPosition::TopMidLeft,
            ToastPosition::TopCenter,
            ToastPosition::TopMidRight,
            ToastPosition::TopRight,
        ][slot],
        "right" => [
            ToastPosition::RightTop,
            ToastPosition::RightUpper,
            ToastPosition::MiddleRight,
            ToastPosition::RightLower,
            ToastPosition::RightBottom,
        ][slot],
        "bottom" => [
            ToastPosition::BottomLeft,
            ToastPosition::BottomMidLeft,
            ToastPosition::BottomCenter,
            ToastPosition::BottomMidRight,
            ToastPosition::BottomRight,
        ][slot],
        _ => [
            ToastPosition::LeftTop,
            ToastPosition::LeftUpper,
            ToastPosition::MiddleLeft,
            ToastPosition::LeftLower,
            ToastPosition::LeftBottom,
        ][slot],
    }
}

fn placement_for_normalized(x: f64, y: f64) -> ToastPosition {
    let distances = [
        ("top", y),
        ("right", 1.0 - x),
        ("bottom", 1.0 - y),
        ("left", x),
    ];
    let nearest = distances
        .iter()
        .map(|(_, d)| *d)
        .fold(f64::INFINITY, f64::min);
    let edge = distances
        .into_iter()
        .find(|(_, d)| (*d - nearest).abs() <= 0.001)
        .map(|(edge, _)| edge)
        .unwrap_or("right");
    let along = if edge == "top" || edge == "bottom" {
        x
    } else {
        y
    };
    slot_on_edge(edge, along)
}

pub fn relayout(app: &AppHandle) {
    layout_stable(app);
}

fn layout_stable(app: &AppHandle) {
    let Some(window) = app.get_webview_window(DOCK_LABEL) else {
        return;
    };
    let settings = app.state::<SettingsState>().0.lock().unwrap().clone();
    apply_frame(
        &window,
        expanded_size(&settings),
        settings.dock_position,
        (settings.dock_custom_x, settings.dock_custom_y),
    );
}

fn start_pointer_watch(app: &AppHandle) {
    if POINTER_WATCH_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(16));
        if TICK_PENDING.swap(true, Ordering::SeqCst) {
            continue;
        }
        let tick_app = app.clone();
        if app
            .run_on_main_thread(move || {
                tick_pointer(&tick_app);
                TICK_PENDING.store(false, Ordering::SeqCst);
            })
            .is_err()
        {
            TICK_PENDING.store(false, Ordering::SeqCst);
        }
    });
}

fn tick_pointer(app: &AppHandle) {
    if ARRANGING.load(Ordering::SeqCst)
        || RESIZING.load(Ordering::SeqCst)
        || COMPOSER_ACTIVE.load(Ordering::SeqCst)
    {
        return;
    }
    let enabled = app.state::<SettingsState>().0.lock().unwrap().dock_enabled;
    if !enabled {
        return;
    }
    let Some(window) = app.get_webview_window(DOCK_LABEL) else {
        return;
    };
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let Some(mouse) = mouse_physical(&window) else {
        return;
    };
    let Ok(pos) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let settings = app.state::<SettingsState>().0.lock().unwrap().clone();
    let scale = window.scale_factor().unwrap_or(1.0);
    let expanded = VISUALLY_EXPANDED.load(Ordering::SeqCst);
    let inside = if expanded {
        expanded_hit_rect(pos, size, scale).contains(mouse.0, mouse.1)
    } else {
        collapsed_hit_rect(pos, size, settings.dock_position, scale).contains(mouse.0, mouse.1)
    };
    if inside != expanded {
        set_expanded(app, inside);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Rect {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

impl Rect {
    fn contains(self, px: i32, py: i32) -> bool {
        px >= self.x && px < self.x + self.w && py >= self.y && py < self.y + self.h
    }

    fn inset(self, d: i32) -> Self {
        Self {
            x: self.x + d,
            y: self.y + d,
            w: (self.w - 2 * d).max(1),
            h: (self.h - 2 * d).max(1),
        }
    }

    fn pad(self, left: i32, top: i32, right: i32, bottom: i32) -> Self {
        Self {
            x: self.x - left,
            y: self.y - top,
            w: (self.w + left + right).max(1),
            h: (self.h + top + bottom).max(1),
        }
    }
}

fn window_rect(pos: PhysicalPosition<i32>, size: PhysicalSize<u32>) -> Rect {
    Rect {
        x: pos.x,
        y: pos.y,
        w: size.width as i32,
        h: size.height as i32,
    }
}

fn expanded_hit_rect(pos: PhysicalPosition<i32>, size: PhysicalSize<u32>, scale: f64) -> Rect {
    window_rect(pos, size).inset(-(RESIZE_SLOP * scale).round() as i32)
}

fn collapsed_handle_rect(
    window_pos: PhysicalPosition<i32>,
    window_size: PhysicalSize<u32>,
    position: ToastPosition,
    scale: f64,
) -> Rect {
    let along = (COLLAPSED_ALONG * scale).round() as i32;
    let across = (COLLAPSED_ACROSS * scale).round() as i32;
    let wx = window_pos.x;
    let wy = window_pos.y;
    let ww = window_size.width as i32;
    let wh = window_size.height as i32;
    let y_top = wy;
    let y_mid = wy + (wh - along) / 2;
    let y_bot = wy + wh - along;
    let x_left = wx;
    let x_mid = wx + (ww - along) / 2;
    let x_right_strip = wx + ww - across;
    // CSS only has start/center/end. Quarter window frames already move the
    // rail; the handle must sit on that same start/end, not a second 25% in.
    let y_right = match position {
        ToastPosition::RightTop | ToastPosition::RightUpper | ToastPosition::TopRight => y_top,
        ToastPosition::RightBottom | ToastPosition::RightLower | ToastPosition::BottomRight => {
            y_bot
        }
        _ => y_mid,
    };
    let x_along = match position {
        ToastPosition::TopLeft
        | ToastPosition::TopMidLeft
        | ToastPosition::LeftTop
        | ToastPosition::BottomLeft
        | ToastPosition::BottomMidLeft => x_left,
        ToastPosition::TopRight
        | ToastPosition::TopMidRight
        | ToastPosition::RightTop
        | ToastPosition::BottomRight
        | ToastPosition::BottomMidRight => wx + ww - along,
        _ => x_mid,
    };
    match position {
        ToastPosition::MiddleLeft
        | ToastPosition::LeftTop
        | ToastPosition::LeftUpper
        | ToastPosition::LeftLower
        | ToastPosition::LeftBottom => Rect {
            x: x_left,
            y: match position {
                ToastPosition::LeftTop | ToastPosition::LeftUpper => y_top,
                ToastPosition::LeftBottom | ToastPosition::LeftLower => y_bot,
                _ => y_mid,
            },
            w: across,
            h: along,
        },
        ToastPosition::MiddleRight
        | ToastPosition::RightTop
        | ToastPosition::RightUpper
        | ToastPosition::RightLower
        | ToastPosition::RightBottom => Rect {
            x: x_right_strip,
            y: y_right,
            w: across,
            h: along,
        },
        ToastPosition::TopLeft
        | ToastPosition::TopMidLeft
        | ToastPosition::TopCenter
        | ToastPosition::TopMidRight
        | ToastPosition::TopRight => Rect {
            x: x_along,
            y: wy,
            w: along,
            h: across,
        },
        ToastPosition::BottomLeft
        | ToastPosition::BottomMidLeft
        | ToastPosition::BottomCenter
        | ToastPosition::BottomMidRight
        | ToastPosition::BottomRight => Rect {
            x: x_along,
            y: wy + wh - across,
            w: along,
            h: across,
        },
        _ => Rect {
            x: x_right_strip,
            y: y_mid,
            w: across,
            h: along,
        },
    }
}

fn collapsed_hit_rect(
    window_pos: PhysicalPosition<i32>,
    window_size: PhysicalSize<u32>,
    position: ToastPosition,
    scale: f64,
) -> Rect {
    let visual = collapsed_handle_rect(window_pos, window_size, position, scale);
    let along = (HOVER_INSET_ALONG * scale).round() as i32;
    let inside = (HOVER_INSET_INSIDE * scale).round() as i32;
    let outside = (HOVER_INSET_OUTSIDE * scale).round() as i32;
    match contact_edge(position) {
        "left" => visual.pad(outside, along, inside, along),
        "right" => visual.pad(inside, along, outside, along),
        "top" => visual.pad(along, outside, along, inside),
        "bottom" => visual.pad(along, inside, along, outside),
        _ => visual.pad(inside, along, inside, along),
    }
}

fn contact_edge(position: ToastPosition) -> &'static str {
    if is_vertical(position) {
        if matches!(
            position,
            ToastPosition::MiddleLeft
                | ToastPosition::LeftTop
                | ToastPosition::LeftUpper
                | ToastPosition::LeftLower
                | ToastPosition::LeftBottom
        ) {
            "left"
        } else {
            "right"
        }
    } else if matches!(
        position,
        ToastPosition::BottomLeft
            | ToastPosition::BottomMidLeft
            | ToastPosition::BottomCenter
            | ToastPosition::BottomMidRight
            | ToastPosition::BottomRight
    ) {
        "bottom"
    } else if matches!(
        position,
        ToastPosition::TopLeft
            | ToastPosition::TopMidLeft
            | ToastPosition::TopCenter
            | ToastPosition::TopMidRight
            | ToastPosition::TopRight
    ) {
        "top"
    } else {
        "right"
    }
}

fn mouse_physical(window: &WebviewWindow) -> Option<(i32, i32)> {
    let pos = window.cursor_position().ok()?;
    Some((pos.x.round() as i32, pos.y.round() as i32))
}

/// Quartz mouse is points, origin bottom-left of the primary display.
#[cfg_attr(not(test), allow(dead_code))]
fn quartz_to_physical(
    qx: f64,
    qy: f64,
    monitor_pos: PhysicalPosition<i32>,
    monitor_size: PhysicalSize<u32>,
    scale: f64,
) -> Option<(i32, i32)> {
    if scale <= 0.0 {
        return None;
    }
    let logical_h = monitor_size.height as f64 / scale;
    let lx = qx - f64::from(monitor_pos.x) / scale;
    let ly = logical_h - qy;
    Some((
        (f64::from(monitor_pos.x) + lx * scale).round() as i32,
        (f64::from(monitor_pos.y) + ly * scale).round() as i32,
    ))
}

/// macOS `set_size` keeps the current top-left and applies asynchronously.
/// If we size first, a right-edge notch grows *off the screen*. Position
/// for the *target* size first, size, then pin the origin again.
fn apply_frame(
    window: &WebviewWindow,
    logical: LogicalSize<f64>,
    position: ToastPosition,
    custom: (i32, i32),
) {
    if ARRANGING.load(Ordering::SeqCst) {
        return;
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = logical_to_physical(logical, scale);
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        let _ = window.set_size(size);
        return;
    };
    let (x, y) = frame(position, custom, *monitor.position(), *monitor.size(), size);
    let pos = PhysicalPosition::new(x, y);
    let gen = FRAME_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = window.set_position(pos);
    let _ = window.set_size(size);
    let _ = window.set_position(pos);
    let later = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(20));
        if FRAME_GEN.load(Ordering::SeqCst) != gen || ARRANGING.load(Ordering::SeqCst) {
            return;
        }
        let _ = later.set_position(pos);
        let _ = later.set_size(size);
        let _ = later.set_position(pos);
    });
}

/// Pointer is on a resize edge — do not collapse mid-drag.
pub fn begin_resize(app: &AppHandle) {
    RESIZING.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(DOCK_LABEL) {
        let _ = window.set_ignore_cursor_events(false);
    }
}

/// Persist the live size and glue the contact edge back on.
pub fn finish_resize(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(DOCK_LABEL)
        .ok_or("dock window missing")?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0).max(0.1);
    let logical = clamp_expanded_logical(size.width as f64 / scale, size.height as f64 / scale);
    persist_expanded_size(app, logical)?;
    RESIZING.store(false, Ordering::SeqCst);
    layout_stable(app);
    let _ = app.emit_to("dock", "refresh", ());
    Ok(())
}

/// Settings sliders — resize without collapsing.
pub fn save_expanded_size(app: &AppHandle, width: u32, height: u32) -> Result<(), String> {
    persist_expanded_size(
        app,
        clamp_expanded_logical(f64::from(width), f64::from(height)),
    )?;
    layout_stable(app);
    let _ = app.emit_to("dock", "refresh", ());
    Ok(())
}

fn persist_expanded_size(app: &AppHandle, logical: LogicalSize<f64>) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let state = app.state::<SettingsState>();
    let mut settings = state.0.lock().unwrap();
    settings.dock_expanded_width = logical.width.round() as u32;
    settings.dock_expanded_height = logical.height.round() as u32;
    settings.dock_item_count = items_that_fit(logical.height, effective_row_height(&settings));
    crate::settings::save(&app_data_dir, &settings)
}

/// Composer focused — stay open until Escape or a click outside.
pub fn set_composer_active(app: &AppHandle, active: bool) {
    COMPOSER_ACTIVE.store(active, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(DOCK_LABEL) {
        let _ = window.set_ignore_cursor_events(false);
        let _ = window.set_focusable(active);
        if active {
            crate::panel::remember_frontmost();
            let _ = window.set_focus();
            if !VISUALLY_EXPANDED.load(Ordering::SeqCst) {
                set_expanded(app, true);
            }
        }
    }
}

/// Collapse the notch, hand focus back, optionally paste — mirrors
/// `panel::hide_and_paste` for Settings → "On Enter".
pub fn hide_and_submit(app: &AppHandle, paste: bool) {
    COMPOSER_ACTIVE.store(false, Ordering::SeqCst);
    set_expanded(app, false);
    if let Some(window) = app.get_webview_window(DOCK_LABEL) {
        let _ = window.set_focusable(false);
    }
    crate::panel::restore_previous_focus();
    if paste {
        let _ = crate::capture::send_paste(app);
    }
}

/// Settings -> Dock -> "Drag to place".
pub fn start_arrange(app: &AppHandle) {
    let _ = ensure_window(app);
    ARRANGING.store(true, Ordering::SeqCst);
    layout_stable(app);
    prepare_drag(app);
    if let Some(window) = app.get_webview_window(DOCK_LABEL) {
        let _ = window.emit("dock-arrange-start", ());
        let _ = window.set_focus();
    }
}

/// Makes the notch draggable without stealing key-window status from the panel.
pub fn prepare_drag(app: &AppHandle) {
    let Some(window) = ensure_window(app) else {
        return;
    };
    ARRANGING.store(true, Ordering::SeqCst);
    let _ = window.set_ignore_cursor_events(false);
    let _ = window.set_focusable(true);
    let _ = window.show();
}

pub fn finish_arrange(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(DOCK_LABEL)
        .ok_or("dock window missing")?;
    let dropped_at = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("no monitor under the dock")?;
    let pointer = window
        .cursor_position()
        .ok()
        .map(|pos| PhysicalPosition::new(pos.x.round() as i32, pos.y.round() as i32));
    let position = snap_to_edge(
        dropped_at,
        size,
        *monitor.position(),
        *monitor.size(),
        pointer,
    );

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let state = app.state::<SettingsState>();
    let mut settings = state.0.lock().unwrap();
    settings.dock_position = position;
    settings.dock_custom_x = dropped_at.x;
    settings.dock_custom_y = dropped_at.y;
    let enabled = settings.dock_enabled;
    crate::settings::save(&app_data_dir, &settings)?;
    drop(settings);

    ARRANGING.store(false, Ordering::SeqCst);
    RESIZING.store(false, Ordering::SeqCst);
    COMPOSER_ACTIVE.store(false, Ordering::SeqCst);
    VISUALLY_EXPANDED.store(false, Ordering::SeqCst);
    let _ = window.emit("dock-arrange-end", ());
    let _ = window.set_focusable(false);
    if !enabled {
        let _ = window.hide();
    } else {
        layout_stable(app);
        let _ = window.set_ignore_cursor_events(true);
        let _ = window.emit("dock-set-expanded", false);
    }
    let _ = app.emit_to("panel", "dock-position-changed", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ten_compact_rows_fit_the_default_rail() {
        assert_eq!(items_that_fit(508.0, 36.0), 10);
        assert!(rail_length(10, 36.0) >= 500.0);
    }

    #[test]
    fn bottom_left_handle_sits_on_the_left() {
        let pos = PhysicalPosition::new(0, 400);
        let size = PhysicalSize::new(640, 816);
        let handle = collapsed_handle_rect(pos, size, ToastPosition::BottomLeft, 2.0);
        assert_eq!(handle.x, 0);
        assert_eq!(handle.y + handle.h, 400 + 816);
        assert!(handle.contains(20, 1210));
        assert!(!handle.contains(320, 1210));
    }

    #[test]
    fn clamp_keeps_a_readable_rail() {
        let tiny = clamp_expanded_logical(80.0, 40.0);
        assert_eq!((tiny.width, tiny.height), (160.0, 140.0));
        let huge = clamp_expanded_logical(2000.0, 2000.0);
        assert_eq!((huge.width, huge.height), (560.0, 720.0));
    }

    #[test]
    fn expanded_hit_includes_inner_edge_slop() {
        let pos = PhysicalPosition::new(2896, 710);
        let size = PhysicalSize::new(560, 816);
        let hit = expanded_hit_rect(pos, size, 2.0);
        assert!(hit.contains(2896 - 20, 900));
        assert!(!hit.contains(2896 - 80, 900));
    }

    #[test]
    fn expanded_side_rail_is_wide_enough_to_read() {
        let mut settings = crate::settings::Settings::default();
        settings.dock_position = ToastPosition::MiddleRight;
        settings.dock_item_count = 5;
        let size = expanded_size(&settings);
        assert!(size.width >= 240.0, "width {}", size.width);
        assert!(size.height >= 160.0, "height {}", size.height);
    }

    #[test]
    fn side_edges_use_a_vertical_capsule() {
        let left = collapsed_size(ToastPosition::MiddleLeft);
        let right_top = collapsed_size(ToastPosition::RightTop);
        assert_eq!((left.width, left.height), (20.0, 66.0));
        assert_eq!((right_top.width, right_top.height), (20.0, 66.0));
    }

    #[test]
    fn top_and_bottom_use_a_horizontal_capsule() {
        let top = collapsed_size(ToastPosition::TopCenter);
        let bottom = collapsed_size(ToastPosition::BottomRight);
        assert_eq!((top.width, top.height), (66.0, 20.0));
        assert_eq!((bottom.width, bottom.height), (66.0, 20.0));
    }

    #[test]
    fn expanding_on_the_right_keeps_the_right_edge_flush() {
        let monitor = PhysicalPosition::new(0, 0);
        let screen = PhysicalSize::new(1920, 1080);
        let collapsed = PhysicalSize::new(40, 132);
        let expanded = PhysicalSize::new(168, 600);
        let (cx, _) = frame(
            ToastPosition::MiddleRight,
            (0, 0),
            monitor,
            screen,
            collapsed,
        );
        let (ex, _) = frame(
            ToastPosition::MiddleRight,
            (0, 0),
            monitor,
            screen,
            expanded,
        );
        assert_eq!(cx + 40, 1920);
        assert_eq!(ex + 168, 1920);
    }

    #[test]
    fn expanding_on_the_top_keeps_the_top_edge_flush() {
        let monitor = PhysicalPosition::new(0, 0);
        let screen = PhysicalSize::new(1920, 1080);
        let collapsed = PhysicalSize::new(132, 40);
        let expanded = PhysicalSize::new(600, 168);
        let (_, cy) = frame(ToastPosition::TopCenter, (0, 0), monitor, screen, collapsed);
        let (_, ey) = frame(ToastPosition::TopCenter, (0, 0), monitor, screen, expanded);
        assert_eq!(cy, 0);
        assert_eq!(ey, 0);
    }

    #[test]
    fn snap_near_the_right_edge_stays_on_the_right() {
        let monitor = PhysicalPosition::new(0, 0);
        let screen = PhysicalSize::new(1920, 1080);
        let size = PhysicalSize::new(40, 132);
        let dropped = PhysicalPosition::new(1880, 500);
        assert_eq!(
            snap_to_edge(dropped, size, monitor, screen, None),
            ToastPosition::MiddleRight
        );
    }

    #[test]
    fn snap_never_picks_the_screen_center() {
        let monitor = PhysicalPosition::new(0, 0);
        let screen = PhysicalSize::new(1920, 1080);
        let size = PhysicalSize::new(40, 132);
        let dropped = PhysicalPosition::new(940, 470);
        let snapped = snap_to_edge(dropped, size, monitor, screen, None);
        assert_ne!(snapped, ToastPosition::Center);
        assert_ne!(snapped, ToastPosition::Custom);
    }

    #[test]
    fn tall_left_rail_flush_to_the_top_snaps_top() {
        let monitor = PhysicalPosition::new(0, 0);
        let screen = PhysicalSize::new(1920, 1080);
        let size = PhysicalSize::new(320, 500);
        let dropped = PhysicalPosition::new(800, 0);
        assert_eq!(
            snap_to_edge(dropped, size, monitor, screen, None),
            ToastPosition::TopCenter
        );
    }

    #[test]
    fn tall_left_rail_flush_to_the_bottom_snaps_bottom() {
        let monitor = PhysicalPosition::new(0, 0);
        let screen = PhysicalSize::new(1920, 1080);
        let size = PhysicalSize::new(320, 500);
        let dropped = PhysicalPosition::new(800, 580);
        assert_eq!(
            snap_to_edge(dropped, size, monitor, screen, None),
            ToastPosition::BottomCenter
        );
    }

    #[test]
    fn quarter_handles_match_css_start_and_end() {
        let pos = PhysicalPosition::new(0, 0);
        let size = PhysicalSize::new(640, 1000);
        let start = collapsed_handle_rect(pos, size, ToastPosition::LeftTop, 2.0);
        let upper = collapsed_handle_rect(pos, size, ToastPosition::LeftUpper, 2.0);
        let lower = collapsed_handle_rect(pos, size, ToastPosition::LeftLower, 2.0);
        let end = collapsed_handle_rect(pos, size, ToastPosition::LeftBottom, 2.0);
        assert_eq!(start, upper);
        assert_eq!(lower, end);
        assert_eq!(start.y, 0);
        assert_eq!(end.y + end.h, 1000);
    }

    #[test]
    fn collapsed_hit_stays_near_the_pill() {
        let pos = PhysicalPosition::new(0, 200);
        let size = PhysicalSize::new(640, 1000);
        let handle = collapsed_handle_rect(pos, size, ToastPosition::MiddleLeft, 2.0);
        let hit = collapsed_hit_rect(pos, size, ToastPosition::MiddleLeft, 2.0);
        assert!(handle.contains(20, 700));
        assert!(!handle.contains(80, 700));
        assert!(hit.contains(20, 700));
        assert!(hit.contains(handle.x + handle.w + 30, 700));
        assert!(!hit.contains(handle.x + handle.w + 60, 700));
        assert!(hit.w > handle.w);
        assert!(hit.h > handle.h);
    }

    #[test]
    fn right_edge_hit_reaches_only_slightly_leftward_into_the_screen() {
        let pos = PhysicalPosition::new(1280, 200);
        let size = PhysicalSize::new(640, 1000);
        let handle = collapsed_handle_rect(pos, size, ToastPosition::MiddleRight, 2.0);
        let hit = collapsed_hit_rect(pos, size, ToastPosition::MiddleRight, 2.0);
        assert!(!handle.contains(handle.x - 30, 700));
        assert!(hit.contains(handle.x - 30, 700));
        assert!(!hit.contains(handle.x - 60, 700));
    }

    #[test]
    fn top_center_hit_does_not_stretch_far_below_the_edge() {
        let pos = PhysicalPosition::new(0, 0);
        let size = PhysicalSize::new(320, 220);
        let handle = collapsed_handle_rect(pos, size, ToastPosition::TopCenter, 2.0);
        let hit = collapsed_hit_rect(pos, size, ToastPosition::TopCenter, 2.0);
        assert_eq!(handle.y, 0);
        assert!(hit.contains(160, handle.y + handle.h + 30));
        assert!(!hit.contains(160, handle.y + handle.h + 60));
    }

    #[test]
    fn right_handle_sits_on_the_contact_edge() {
        let pos = PhysicalPosition::new(2896, 400);
        let size = PhysicalSize::new(560, 816);
        let handle = collapsed_handle_rect(pos, size, ToastPosition::MiddleRight, 2.0);
        assert_eq!(handle.x + handle.w, 2896 + 560);
        assert_eq!((handle.w, handle.h), (40, 132));
        assert!(handle.contains(3450, 800));
        assert!(!handle.contains(2900, 800));
    }

    #[test]
    fn quartz_top_left_of_primary_is_origin() {
        let pos = PhysicalPosition::new(0, 0);
        let size = PhysicalSize::new(3456, 2234);
        assert_eq!(
            quartz_to_physical(0.0, 1117.0, pos, size, 2.0),
            Some((0, 0))
        );
        assert_eq!(
            quartz_to_physical(1728.0, 0.0, pos, size, 2.0),
            Some((3456, 2234))
        );
    }

    #[test]
    fn normalized_corners_match_tokitoki() {
        assert_eq!(
            placement_for_normalized(0.50, 0.04),
            ToastPosition::TopCenter
        );
        assert_eq!(
            placement_for_normalized(0.96, 0.04),
            ToastPosition::TopRight
        );
        assert_eq!(
            placement_for_normalized(0.96, 0.24),
            ToastPosition::RightUpper
        );
        assert_eq!(
            placement_for_normalized(0.96, 0.76),
            ToastPosition::RightLower
        );
        assert_eq!(
            placement_for_normalized(0.04, 0.24),
            ToastPosition::LeftUpper
        );
        assert_eq!(
            placement_for_normalized(0.04, 0.76),
            ToastPosition::LeftLower
        );
        assert_eq!(
            placement_for_normalized(0.04, 0.50),
            ToastPosition::MiddleLeft
        );
        assert_eq!(
            placement_for_normalized(0.04, 0.75),
            ToastPosition::LeftLower
        );
    }
}
