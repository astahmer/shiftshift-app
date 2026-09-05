//! Asynchronous external automations.
//!
//! Hooks are deliberately process-based rather than provider-based: a small
//! executable receives one JSON request on stdin and returns a JSON action
//! list on stdout. This keeps API keys and model choices outside ShiftShift,
//! while still giving every capture source the same lifecycle seam.

use std::collections::HashSet;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::db::Db;
use crate::settings::{AutomationEvent, AutomationHook, SettingsState};
use crate::store::{normalize_tag, Item, ItemKind};

const PROTOCOL_VERSION: u32 = 1;
const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const MAX_TIMEOUT_MS: u64 = 60_000;
const MAX_OUTPUT_BYTES: usize = 1_048_576;
const MAX_ACTIONS: usize = 32;
const MAX_TAGS_PER_ACTION: usize = 16;

/// Serializes the input contract sent to every matching hook.
#[derive(Debug, Serialize)]
struct HookRequest {
    schema_version: u32,
    event: AutomationEvent,
    item: Option<Item>,
}

/// The only mutations a hook can ask ShiftShift to make in v1. Tags are stored
/// as item metadata; the copy boundary therefore never needs to remove a
/// generated tag from the user content.
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum AutomationAction {
    SetKind { kind: ItemKind },
    SetBookmarked { bookmarked: bool },
    SetDone { done: bool },
    AddTags { tags: Vec<String> },
}

#[derive(Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct HookResponse {
    actions: Vec<AutomationAction>,
}

impl Default for HookResponse {
    fn default() -> Self {
        Self {
            actions: Vec::new(),
        }
    }
}

/// Remote/folder stores are intentionally single-writer today. Serializing
/// the apply phase also makes multiple hooks deterministic for one capture and
/// avoids concurrent read-modify-write races in those backends.
static APPLY_LOCK: Mutex<()> = Mutex::new(());

/// Starts matching hooks after the caller has already persisted the event.
/// The caller never waits for a hook process or its network request.
pub fn dispatch(app: &AppHandle, event: AutomationEvent, item: Option<Item>) {
    let hooks = {
        let state = app.state::<SettingsState>();
        let settings = state.0.lock().unwrap();
        settings
            .automation_hooks
            .iter()
            .filter(|hook| {
                hook.enabled
                    && !hook.id.trim().is_empty()
                    && !hook.command.trim().is_empty()
                    && hook.events.iter().any(|candidate| *candidate == event)
            })
            .cloned()
            .collect::<Vec<_>>()
    };
    if hooks.is_empty() {
        return;
    }

    let request = HookRequest {
        schema_version: PROTOCOL_VERSION,
        event,
        item,
    };
    let payload = match serde_json::to_vec(&request) {
        Ok(payload) => payload,
        Err(error) => {
            eprintln!("shiftshift: could not encode automation request: {error}");
            return;
        }
    };

    let app = app.clone();
    thread::spawn(move || {
        for hook in hooks {
            run_hook(&app, &hook, event, &request, &payload);
        }
    });
}

/// Looks up the current item for mutations that only have an id, then feeds
/// the same event path as a capture. A missing item simply means there is
/// nothing for an item-level hook to inspect.
pub fn dispatch_current_item(app: &AppHandle, event: AutomationEvent, id: &str) {
    let app = app.clone();
    let id = id.to_string();
    thread::spawn(move || {
        let item = app
            .state::<Db>()
            .store
            .list_items()
            .ok()
            .and_then(|items| items.into_iter().find(|item| item.id == id));
        if item.is_some() {
            dispatch(&app, event, item);
        }
    });
}

fn run_hook(
    app: &AppHandle,
    hook: &AutomationHook,
    event: AutomationEvent,
    request: &HookRequest,
    payload: &[u8],
) {
    let item_id = request.item.as_ref().map(|item| item.id.clone());
    let response = match execute_hook(hook, payload) {
        Ok(response) => response,
        Err(error) => {
            record_failure(app, hook, event, item_id.as_deref(), &error);
            return;
        }
    };
    if let Err(error) = apply_actions(app, hook, event, item_id.as_deref(), &response.actions) {
        record_failure(app, hook, event, item_id.as_deref(), &error);
    }
}

fn execute_hook(hook: &AutomationHook, payload: &[u8]) -> Result<HookResponse, String> {
    let command = hook.command.trim();
    if command.is_empty() {
        return Err("command is empty".to_string());
    }

    // Direct process invocation is intentional: command strings are not
    // shell-expanded, so a config value cannot accidentally reinterpret `$`,
    // backticks, pipes, or redirects.
    let mut child = Command::new(command)
        .args(&hook.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Keep diagnostic output out of the protocol pipe and prevent a noisy
        // hook from filling a stderr pipe while the child is running.
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("could not start command: {error}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        if let Err(error) = stdin.write_all(payload) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("could not write request: {error}"));
        }
    }

    let timeout_ms = if hook.timeout_ms == 0 {
        DEFAULT_TIMEOUT_MS
    } else {
        hook.timeout_ms.min(MAX_TIMEOUT_MS)
    };
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("timed out after {timeout_ms}ms"));
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("could not poll command: {error}"));
            }
        }
    };

    let output = child
        .wait_with_output()
        .map_err(|error| format!("could not read command output: {error}"))?;
    if !status.success() {
        return Err(format!("command exited with {status}"));
    }
    if output.stdout.len() > MAX_OUTPUT_BYTES {
        return Err(format!("stdout exceeds {MAX_OUTPUT_BYTES} bytes"));
    }
    if output.stdout.iter().all(u8::is_ascii_whitespace) {
        return Ok(HookResponse::default());
    }

    let response: HookResponse = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("stdout was not valid hook JSON: {error}"))?;
    if response.actions.len() > MAX_ACTIONS {
        return Err(format!("response contains more than {MAX_ACTIONS} actions"));
    }
    Ok(response)
}

fn apply_actions(
    app: &AppHandle,
    hook: &AutomationHook,
    event: AutomationEvent,
    item_id: Option<&str>,
    actions: &[AutomationAction],
) -> Result<(), String> {
    if actions.is_empty() {
        return Ok(());
    }
    let Some(item_id) = item_id else {
        return Ok(());
    };

    let _guard = APPLY_LOCK.lock().map_err(|error| error.to_string())?;
    let db = app.state::<Db>();
    let Some(mut item) = db
        .store
        .list_items()?
        .into_iter()
        .find(|candidate| candidate.id == item_id)
    else {
        // A delete hook can still perform an external side effect, but its
        // item mutation actions have nothing left to apply.
        return Ok(());
    };

    let mut applied = Vec::new();
    for action in actions {
        match action {
            AutomationAction::SetKind { kind } if item.kind != *kind => {
                db.store.set_kind(item_id, *kind)?;
                item.kind = *kind;
                applied.push(format!("set_kind={kind:?}"));
            }
            AutomationAction::SetBookmarked { bookmarked } if item.bookmarked != *bookmarked => {
                db.store.toggle_bookmarked(item_id)?;
                item.bookmarked = *bookmarked;
                applied.push(format!("set_bookmarked={bookmarked}"));
            }
            AutomationAction::SetDone { done } if item.done != *done => {
                db.store.toggle_done(item_id)?;
                item.done = *done;
                applied.push(format!("set_done={done}"));
            }
            AutomationAction::AddTags { tags } => {
                let mut next_tags = item.tags.clone();
                let existing = next_tags.iter().cloned().collect::<HashSet<_>>();
                let mut added = 0;
                for raw in tags {
                    if added >= MAX_TAGS_PER_ACTION {
                        break;
                    }
                    let Some(tag) = normalize_tag(raw) else {
                        continue;
                    };
                    if existing.contains(&tag) || next_tags.iter().any(|seen| seen == &tag) {
                        continue;
                    }
                    next_tags.push(tag);
                    added += 1;
                }
                if next_tags != item.tags {
                    db.store.set_tags(item_id, next_tags.clone())?;
                    item.tags = next_tags;
                    applied.push("add_tags".to_string());
                }
            }
            _ => {}
        }
    }

    if applied.is_empty() {
        return Ok(());
    }
    let detail = format!(
        "hook={}; event={}; actions={}",
        hook.id,
        event.as_str(),
        applied.join(",")
    );
    let _ = db
        .store
        .log_event(Some(item_id), "automation_applied", Some(&detail));
    let _ = app.emit("refresh", ());
    Ok(())
}

fn record_failure(
    app: &AppHandle,
    hook: &AutomationHook,
    event: AutomationEvent,
    item_id: Option<&str>,
    error: &str,
) {
    eprintln!(
        "shiftshift: automation hook '{}' failed for {}: {}",
        hook.id,
        event.as_str(),
        error
    );
    let Some(item_id) = item_id else {
        return;
    };
    let db = app.state::<Db>();
    let detail = format!("hook={}; event={}; error={error}", hook.id, event.as_str());
    let _ = db
        .store
        .log_event(Some(item_id), "automation_failed", Some(&detail));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_and_rejects_tags_consistently() {
        assert_eq!(normalize_tag("#Follow up"), Some("follow-up".into()));
        assert_eq!(normalize_tag("482"), None);
        assert_eq!(normalize_tag("work"), Some("work".into()));
    }

    #[test]
    fn accepts_empty_hook_output_as_a_no_op() {
        let parsed: HookResponse = serde_json::from_str("{}").unwrap();
        assert!(parsed.actions.is_empty());
    }

    #[test]
    fn serializes_the_stable_event_name() {
        assert_eq!(
            serde_json::to_string(&AutomationEvent::ItemCreated).unwrap(),
            "\"item.created\""
        );
    }
}
