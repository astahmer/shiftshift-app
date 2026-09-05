# ShiftShift automations

ShiftShift can run small external commands after item lifecycle events. The
app owns the event timing and persistence; the command can be a shell script,
Python program, local model runner, or any other executable on `PATH`.

Hooks are configured in Settings → Automations as JSON. They are part of the
same `settings.json` and the existing config export/import. Secrets such as an
LLM API key should stay in the hook's environment or secret manager; they are
not stored in ShiftShift settings.

## Configuration

```json
[
  {
    "id": "auto-classify",
    "enabled": true,
    "events": ["item.created"],
    "command": "/Users/me/bin/shiftshift-classify",
    "args": [],
    "timeout_ms": 10000
  }
]
```

`command` is executed directly with `args`; it is not passed through a shell.
An empty `timeout_ms`/`0` uses 10 seconds, and values above 60 seconds are
capped. Hooks run after the item is saved and do not delay capture. Multiple
matching hooks run one after another in configuration order.

Supported events:

- `item.created` — a capture or inserted item was persisted.
- `item.updated` — text, kind, todo state, or another item field changed.
- `item.used` — the item was opened or copied.
- `item.bookmarked` — bookmark state changed.
- `item.deleted` — the item was deleted; the request still contains the last item snapshot.

## Input

The command receives one JSON object on stdin:

```json
{
  "schema_version": 1,
  "event": "item.created",
  "item": {
    "id": "…",
    "kind": "note",
    "text": "buy milk",
    "done": false,
    "bookmarked": false,
    "rank": 1000,
    "source_app": "Notes",
    "created_at": "2026-09-08T12:00:00Z",
    "copy_count": 0,
    "first_copied_at": null,
    "last_copied_at": null
  }
}
```

The `item` value is `null` for no-item lifecycle events if those are added in
future protocol versions.

## Output

Write a JSON object to stdout. Logs belong on stderr.

```json
{
  "actions": [
    { "type": "set_kind", "kind": "todo" },
    { "type": "add_tags", "tags": ["work", "follow-up"] },
    { "type": "set_bookmarked", "bookmarked": true }
  ]
}
```

Supported actions in protocol version 1:

- `set_kind` with `note`, `todo`, `link`, or `image`.
- `set_done` with a boolean.
- `set_bookmarked` with a boolean.
- `add_tags` with tag strings. Invalid/numeric tags are ignored, duplicates are skipped, and at most 16 tags are added per response.

Tags are first-class item metadata, so they remain filterable without changing
the entry text. Older entries may still contain inline `#tag` tokens; the app
reads those for compatibility, while new automation and UI tag changes write
to the metadata field. App-initiated copies return only the entry text and do
not copy metadata or legacy rendered hashtag tokens.

## Contributed views

A hook can contribute a saved, faceted view by adding a `views` array to its
definition. Views use the same portable query shape as user collections. They
appear as tabs when both the hook and the individual view are enabled in
Settings → Automations; disabling either hides the view without deleting its
definition.

```json
{
  "id": "organizer",
  "command": "/path/to/organizer",
  "events": ["item.created", "item.updated"],
  "enabled": true,
  "views": [
    {
      "id": "work-queue",
      "label": "Work queue",
      "description": "Unfinished work items",
      "icon": "▣",
      "sort": "newest",
      "enabled": true,
      "query": {
        "all": [
          { "field": "tag", "operator": "equals", "value": "work" },
          { "field": "done", "operator": "equals", "value": "false" }
        ],
        "any": [],
        "none": []
      }
    }
  ]
}
```

The query supports `all`, `any`, and `none` predicate groups. Predicate values
are strings (`"true"`/`"false"` for boolean fields); supported fields are
`tag`, `kind`, `done`, `bookmarked`, `source_app`, `text`, and `created_at`.

There is intentionally no `suggest` response in version 1. “Suggest” would
mean queuing a proposal for manual review; this first implementation is
automatic “apply”, with `automation_applied` and `automation_failed` entries
written to history for auditing.

## Minimal hook

```python
#!/usr/bin/env python3
import json
import sys

request = json.load(sys.stdin)
item = request.get("item") or {}
text = item.get("text", "").lower()
actions = []

if text.startswith("http://") or text.startswith("https://"):
    actions.append({"type": "add_tags", "tags": ["link"]})
elif "buy " in text or text.startswith("todo:"):
    actions.append({"type": "set_kind", "kind": "todo"})
    actions.append({"type": "add_tags", "tags": ["follow-up"]})

print(json.dumps({"actions": actions}))
```

For an LLM-backed organizer, replace the small decision block with the model
call and constrain the model to return only the action schema above. Keep the
hook idempotent: on a later `item.updated` run, returning the same tags is a
no-op.

## Automation ideas

These are intentionally small, composable automations. A hook should make a
few predictable changes to an item; broader workflows can be built by running
several hooks for the same event.

### Auto-classify captures

Run after `item.created` and infer the item's kind from its content:

- URLs become `link` items.
- Requests, errands, and phrases such as “need to” become `todo` items.
- Everything else remains a `note`.

The current protocol supports this with `set_kind`. The built-in heuristic
already handles the obvious URL case; a local or hosted LLM can handle the
ambiguous cases.

### Add source and topic tags

Use the captured `source_app` and text to add stable tags such as
`source:mail`, `source:browser`, `topic:work`, or `topic:personal`. This gives
the list useful facets without moving or duplicating the entry.

### Route project work

Detect project names or prefixes and add tags such as `project:website` and
`area:engineering`. A saved collection can then show all unfinished work for
that project. The entry stays in the same underlying store even when it is
visible in several project views.

### Detect priority and follow-up

Recognize “urgent”, deadlines, questions, or explicit follow-up language and:

- add tags such as `priority:high` and `follow-up`;
- convert the entry to a todo;
- bookmark only when the confidence is high.

The conservative version should tag uncertain matches rather than silently
changing the kind or bookmark state.

### Organize links

For link items, inspect the URL host and title and add tags such as
`read-later`, `reference`, `shopping`, `video`, or `docs`. A later version
could also store structured link metadata, such as a canonical URL or domain,
instead of encoding every distinction in tags.

### Export or integrate elsewhere

After an item is classified, a hook can send it to another local tool or API:

- append daily notes to a Markdown journal;
- create a task in a task manager when `follow-up` is present;
- archive selected links to a read-later service;
- mirror a tag-defined subset to a project file or database.

External side effects should be opt-in, idempotent, and recorded with enough
detail to diagnose failures. They should not block capture.

### Usage-based organization

Run after `item.used` to tag or bookmark frequently copied entries, or to
surface stale entries that have never been used. This is a good fit for a
periodic hook once scheduled events exist; it should avoid changing content on
every copy.

### Suggested first organizer

The smallest useful LLM integration is:

1. Trigger on `item.created`.
2. Send the item text, kind, and source app to a cheap/local model.
3. Ask for a kind, zero to three canonical tags, and an optional bookmark.
4. Validate the response against the action schema.
5. Apply only high-confidence changes. Until first-class tags land, generated
   tag tokens are stored inline, but the copy boundary still excludes them.

This provides automatic classification and organization while the collection
model is still being developed. “Suggest” can be added later as a review queue
when we want proposed changes to wait for approval instead of being applied
immediately.

## Future protocol actions

The current v1 action set is deliberately small: kind, done state, bookmark,
and tags. The following actions are useful candidates once the data model is
ready:

- `set_title` or structured link metadata;
- `set_due_at` and `set_priority` for richer todos;
- `add_to_collection` for explicitly curated collections;
- `archive` or `snooze` without deleting the item;
- `merge_into` for duplicate captures;
- `run_integration` with a safe, permissioned connector.

Collections should preferably be saved views over metadata, so most routing
does not need an `add_to_collection` action: an automation adds tags and the
right collection picks the item up automatically.
