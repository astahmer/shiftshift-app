//! Native drag-out.
//!
//! Images go through `drag` as file URLs (that path already works).
//!
//! Text starts a session on the **window**, not WKWebView — the webview is a
//! text drop destination and eats string drags. No file URL is advertised
//! (destinations then treat the note as a `.txt` attachment). After the
//! session starts we also write the string onto `NSPasteboardNameDrag`,
//! because `beginDraggingSession` clears the pasteboard.

use tauri::WebviewWindow;

/// UTIs written for a note/link/todo. Tests lock this list so we never
/// grow a file type again.
pub const TEXT_DRAG_TYPES: &[&str] = &[
    "public.utf8-plain-text",
    "public.plain-text",
    "text/plain",
    "NSStringPboardType",
    "NeXT plain ascii pasteboard type",
    "public.html",
    "Apple HTML pasteboard type",
];

#[cfg(not(target_os = "macos"))]
pub fn start(window: &WebviewWindow, kind: &str, text: &str) -> Result<(), String> {
    let _ = (window, kind, text);
    Err("item drag-out is only implemented on macOS".into())
}

#[cfg(target_os = "macos")]
pub fn start(window: &WebviewWindow, kind: &str, text: &str) -> Result<(), String> {
    if kind == "image" {
        start_file_drag(window, text)
    } else {
        start_text_drag(window, text)
    }
}

#[cfg(target_os = "macos")]
fn start_file_drag(window: &WebviewWindow, path: &str) -> Result<(), String> {
    drag::start_drag(
        window,
        drag::DragItem::Files(vec![std::path::PathBuf::from(path)]),
        drag::Image::Raw(PIXEL.to_vec()),
        |_, _| {},
        drag::Options::default(),
    )
    .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
const PIXEL: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
];

#[cfg(target_os = "macos")]
fn start_text_drag(window: &WebviewWindow, text: &str) -> Result<(), String> {
    mac::start_text_drag(window, text)
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::RefCell;

    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AnyThread, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSApp, NSDraggingContext, NSDraggingItem, NSDraggingSession, NSDraggingSource, NSEvent,
        NSEventModifierFlags, NSEventType, NSImage, NSPasteboard, NSPasteboardNameDrag,
        NSPasteboardTypeString, NSView, NSWindow,
    };
    use objc2_foundation::{NSArray, NSData, NSPoint, NSRect, NSSize, NSString};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use tauri::WebviewWindow;

    thread_local! {
        static DRAG_WINDOW: RefCell<Option<Retained<NSWindow>>> = const { RefCell::new(None) };
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "ShiftShiftTextDragSource"]
        #[ivars = ()]
        struct ShiftShiftTextDragSource;

        unsafe impl NSObjectProtocol for ShiftShiftTextDragSource {}

        unsafe impl NSDraggingSource for ShiftShiftTextDragSource {
            #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
            unsafe fn dragging_session(
                &self,
                _session: &NSDraggingSession,
                context: NSDraggingContext,
            ) -> objc2_app_kit::NSDragOperation {
                if context == NSDraggingContext::WithinApplication {
                    objc2_app_kit::NSDragOperation::None
                } else {
                    objc2_app_kit::NSDragOperation::Copy
                }
            }

            #[unsafe(method(ignoreModifierKeysForDraggingSession:))]
            unsafe fn ignore_modifier_keys(&self, _session: &NSDraggingSession) -> bool {
                true
            }

            #[unsafe(method(draggingSession:endedAtPoint:operation:))]
            unsafe fn dragging_session_end(
                &self,
                _session: &NSDraggingSession,
                _point: NSPoint,
                _operation: objc2_app_kit::NSDragOperation,
            ) {
                DRAG_WINDOW.with(|slot| {
                    if let Some(window) = slot.borrow_mut().take() {
                        window.setIgnoresMouseEvents(false);
                    }
                });
            }
        }
    );

    impl ShiftShiftTextDragSource {
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(());
            unsafe { msg_send![super(this), init] }
        }
    }

    fn html_payload(text: &str) -> String {
        let escaped = text
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        format!("<meta charset=\"utf-8\"><span>{escaped}</span>")
    }

    fn write_drag_pasteboard(text: &str) {
        unsafe {
            let ns_text = NSString::from_str(text);
            let ns_html = NSString::from_str(&html_payload(text));
            let utf8 = NSData::from_vec(text.as_bytes().to_vec());
            let pb = NSPasteboard::pasteboardWithName(NSPasteboardNameDrag);
            let extra = NSArray::from_retained_slice(
                &super::TEXT_DRAG_TYPES
                    .iter()
                    .map(|ty| NSString::from_str(ty))
                    .collect::<Vec<_>>(),
            );
            pb.addTypes_owner(&extra, None);
            pb.setString_forType(&ns_text, NSPasteboardTypeString);
            pb.setData_forType(Some(&utf8), NSPasteboardTypeString);
            pb.setData_forType(Some(&utf8), &NSString::from_str("text/plain"));
            pb.setData_forType(Some(&utf8), &NSString::from_str("public.utf8-plain-text"));
            for ty in super::TEXT_DRAG_TYPES {
                let value = if ty.contains("html") {
                    &ns_html
                } else {
                    &ns_text
                };
                pb.setString_forType(value, &NSString::from_str(ty));
            }
        }
    }

    pub fn start_text_drag(window: &WebviewWindow, text: &str) -> Result<(), String> {
        let handle = window.window_handle().map_err(|e| e.to_string())?.as_raw();
        let RawWindowHandle::AppKit(w) = handle else {
            return Err("unsupported window handle".into());
        };

        unsafe {
            let mtm = MainThreadMarker::new_unchecked();
            let ns_view = &*(w.ns_view.as_ptr() as *const NSView);
            let ns_window = ns_view.window().ok_or("Failed to get window")?;
            let current_position: NSPoint = ns_window.mouseLocationOutsideOfEventStream();

            let data = NSData::from_vec(super::PIXEL.to_vec());
            let img =
                NSImage::initWithData(NSImage::alloc(), &data).ok_or("Failed to create NSImage")?;
            let image_size: NSSize = img.size();
            let image_rect = NSRect::new(
                NSPoint::new(
                    current_position.x - image_size.width / 2.,
                    current_position.y - image_size.height / 2.,
                ),
                image_size,
            );

            let ns_text = NSString::from_str(text);
            // NSString as the writer — Chromium (T3Code / VS Code) maps
            // NSPasteboardTypeString to HTML5 `text/plain`. NSPasteboardItem
            // alone often never shows up in `dataTransfer.types`.
            let drag_item = NSDraggingItem::initWithPasteboardWriter(
                NSDraggingItem::alloc(),
                &ProtocolObject::from_retained(ns_text.clone()),
            );
            drag_item.setDraggingFrame_contents(image_rect, Some(&*img));

            let current_event = NSApp(mtm).currentEvent();
            let timestamp = current_event.map(|e| e.timestamp()).unwrap_or(0.0);
            let drag_event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
                NSEventType::LeftMouseDragged,
                current_position,
                NSEventModifierFlags::empty(),
                timestamp,
                ns_window.windowNumber(),
                None,
                0,
                1,
                1.0,
            )
            .ok_or("Failed to create NSEvent")?;

            ns_window.setIgnoresMouseEvents(true);
            DRAG_WINDOW.with(|slot| {
                *slot.borrow_mut() = Some(ns_window.clone());
            });

            let source = ShiftShiftTextDragSource::new(mtm);
            let items = NSArray::from_slice(&[&*drag_item]);
            let _session = ns_window.beginDraggingSessionWithItems_event_source(
                &items,
                &drag_event,
                &ProtocolObject::<dyn NSDraggingSource>::from_retained(source),
            );
            write_drag_pasteboard(text);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::TEXT_DRAG_TYPES;

    #[test]
    fn text_drag_types_are_strings_not_files() {
        assert!(TEXT_DRAG_TYPES.contains(&"public.utf8-plain-text"));
        assert!(TEXT_DRAG_TYPES.contains(&"public.plain-text"));
        assert!(TEXT_DRAG_TYPES.contains(&"text/plain"));
        assert!(TEXT_DRAG_TYPES.contains(&"public.html"));
        for ty in TEXT_DRAG_TYPES {
            assert!(
                !ty.to_ascii_lowercase().contains("file"),
                "{ty} looks like a file type"
            );
        }
    }
}
