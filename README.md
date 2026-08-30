# shiftshift (Tauri)

A quick-capture desktop utility in the vein of shadcn's Copper — double-tap
Shift to save a note/todo/link without leaving what you're doing. This is a
from-scratch rebuild on Tauri 2, taking the strongest ideas from two prior
clones ([`shiftshift`](https://github.com) and
[`cooper`](https://github.com/TouchMyBar/cooper)) rather than being a fork of
either.

## Design decisions

- **Tauri 2 + native webview**, not Electron-family — smaller binaries,
  lower idle RAM, native cross-platform (macOS/Windows/Linux) from one
  codebase.
- **Vanilla TypeScript frontend**, no React — this is a tiny, latency-critical
  overlay that opens/closes constantly; no VDOM diffing in the capture path.
- **Unified item model** (`kind: note | todo | link`, `done`, `bookmarked`,
  `rank`) instead of separate note/todo/clipboard concepts — see
  `src-tauri/src/store/mod.rs`.
- **Native double-Shift hook**: a real `CGEventTap` on macOS
  (`src-tauri/src/mac_tap.rs`), `rdev` on Linux/Windows
  (`src-tauri/src/capture.rs`), with `CmdOrCtrl+Shift+Space/C` global-shortcut
  fallback when the raw hook is unavailable or denied.
- **Storage**: shiftshift's "pick a backend" model — a `Store` trait is the
  seam. `LocalSqliteStore` (default) and `S3Store` (any S3-compatible
  bucket, single-writer only) both implement it; picking one is a Settings
  toggle, switching takes effect on next launch. See the conflict-resolution
  note in `store/mod.rs` for the single-writer caveat, and `store/s3.rs`'s
  module doc — it's implemented and unit-tested at the mapping/logic level,
  but not yet verified against a real bucket (no test credentials available
  while building it).

## Requirements

- Node 24.19.0, pnpm 12.1.0 (both pinned — see below)
- Rust 1.93.0 (stable)
- macOS: Xcode Command Line Tools

All dependency versions (npm and Cargo) are pinned exactly (no `^`/`=`-less
ranges) — bump them deliberately, not implicitly on `install`.

If your shell's `cc`/`ld` resolve to a non-Apple toolchain (e.g. via Nix), see
`.cargo/config.toml` — it pins the linker and `CC`/`CXX` to `/usr/bin/cc` /
`/usr/bin/c++` for this project, by absolute path, so it wins regardless of
what's earlier on `PATH`.

### Option A: Nix flake (reproducible, recommended if you have Nix)

```bash
nix develop
```

Drops you into a shell with the exact pinned Rust toolchain, Node, and (via
Corepack) pnpm 12.1.0 — no rustup/nvm setup needed. See `flake.nix` for why it
doesn't need to fight the Nix-cc-shadowing problem above: the `.cargo/config.toml`
override already wins regardless of what the flake puts on `PATH`.

### Option B: rustup + your own Node

```bash
rustup toolchain install 1.93.0
corepack enable   # or: npm i -g corepack
corepack use pnpm@12.1.0
```

## Development

```bash
pnpm install
pnpm tauri dev
```

On first run, macOS will show the app as "not responding to Accessibility
requests" until you grant it under System Settings → Privacy & Security →
Accessibility — until then, double-Shift capture is inactive but the
fallback shortcuts (`Cmd+Shift+Space` toggle / `Cmd+Shift+C` capture /
`Cmd+Shift+I` image, all reconfigurable or disableable from Settings) still
work.

## Features

- **Settings** (gear icon in the panel): theme, capture behavior, double-shift
  bindings, fallback shortcuts, notifications, sync backend, snippet
  templates, Markdown export, history. All persist to `settings.json` and
  apply live, no restart needed (except the sync backend choice).
- **Themes**: 22 built-in presets (Tokyo Night, Dracula, Nord, Catppuccin,
  Gruvbox, Rosé Pine, Solarized, GitHub, VS Code, One Dark — each with a
  light/dark sibling — plus Glass, Neobrutalism, Paper, Windows 95, Raycast,
  and Discord, which also override structural tokens like corner radius,
  shadow, border width, and backdrop blur, not just colors — see the
  `--radius`/`--shadow`/`--backdrop-blur`/`--bg-alpha` custom properties in
  `src/style.css`) — see `src/themes.ts`. Switch from Settings, or type
  `/theme` (suggests every theme, filtered as you keep typing), `/light`/
  `/dark` (suggests just that mode's themes). Both live-preview the
  highlighted suggestion as you arrow through it — `Enter` persists,
  `Escape` reverts. **Custom themes** (Settings → Custom themes): pick your
  own 7 colors with color pickers, save/edit/delete, "Use" to apply. Export
  copies every custom theme as JSON to the clipboard; Import reads JSON back
  from the clipboard (validated before being added) — no file picker needed,
  so no new Tauri plugin either.
- **Sort order**: `/sort` (or Settings → Sort order) — manual (the
  fractional-rank order, the default), newest/oldest first, or name A→Z/Z→A.
  Bookmarked items stay pinned above the rest regardless of mode.
- **Native vibrancy**: the panel uses macOS `NSVisualEffectView` / Windows DWM
  acrylic (`src-tauri/src/vibrancy.rs`, ported from cooper's `glass.rs`).
- **Capture behavior** (Settings → Capture behavior): silent (default, saves
  without showing the panel), open (saves and shows it), or draft (shows the
  panel with the captured text prefilled, not yet saved — review/edit, then
  Enter to save). Applies to the double-shift gesture, the CLI, and
  clipboard-watch alike, via `capture::handle_captured_text`.
- **Clipboard watch** (off by default): auto-captures everything you copy as
  a note, own writes excluded (`clipboard_watch.rs`).
- **Keyboard-driven list**: typing filters the list below (substring match,
  plus tag filters — `@bookmarks`/`@links`/`@todos`/`@notes` or the
  equivalent `has:x` form, combinable with a text query e.g. `@todos ship`).
  Typing `@` also suggests the available filter tags directly, and typing
  `#` suggests hashtags already in use across your items (both: `Tab` or
  `Enter` on a highlighted one completes it) — `#hashtags` anywhere in an
  item's text also render as a small pill in the row.
  `↑`/`↓` selects a row, `Enter` copies note/todo text (or opens a link, or
  copies an image back to the clipboard) and closes the panel; `⌘C` does the
  same but leaves the panel open. `⌘Enter` always saves the typed text as a
  new item regardless of selection. `Shift+Enter` adds the selected row to a
  multi-selection; plain `Enter` with one or more selected copies them as a
  numbered list ("1. foo\n2. bar") and closes. `Space` toggles a selected
  todo's done state, `⌘B` bookmarks (bookmarked rows get a persistent accent
  bar on the left edge, not just the star button on hover), `⌘T` toggles
  todo/not-todo, `⌘E` edits inline, `⌥↑`/`⌥↓` reorders (unfiltered view
  only — holding it keeps walking the *same* item through the list, not
  whatever else ends up under the cursor after each step), `⌘Backspace`/
  `⌘Delete` (input empty) deletes — the bare key without `⌘` no longer does,
  so a stray Delete/Backspace while just browsing can't wipe a row by
  accident. `Shift+→` opens a full detail view for the selected row (complete
  untruncated text, all dates, copy count, action buttons) — `Shift+←` or
  `Escape` goes back. `⌘Z`/`⌘⇧Z` undoes/redoes the last mutation made
  through this UI (add, delete, edit, bookmark, todo-convert, reorder) —
  session-scoped, not persisted across restarts. `Escape` reverts an
  in-progress theme/sort preview, then closes the detail view if open, then
  clears a pending multi-selection, then closes Settings if open, then hides
  the panel — it does each in its own keypress, never more than one at a
  time. A subtle relative-time label sits on each row (hidden in favor of
  the action buttons on hover/select), and selecting a row shows a one-line
  detail strip below the list — source app, content type, created-at, and
  copy count/last-copied, Raycast-style, derived from `history`'s "used"
  events.
- **Click-outside to close**: losing focus (clicking another app) hides the
  panel — opt out via Settings → "Hide when the panel loses focus".
- **Duplicate hint**: a non-blocking inline note ("Already saved") appears
  while typing text that exactly matches an existing item — saving anyway
  is still one Enter away.
- **Triple-tap → todo**: a third Shift tap fast-following a capture double-tap
  flips that just-saved item to a todo, without delaying the double-tap's own
  (instant) fire — see the `Fired::PromoteToTodo` path in `capture.rs`.
- **Save notifications**: opt-in (off by default), with an optional sound —
  see Settings → Notifications. In `pnpm tauri dev`, macOS shows these under
  Terminal's notification permission (Tauri's dev-mode identity workaround),
  not shiftshift's — check System Settings → Notifications → Terminal if
  nothing appears in dev.
- **History**: a chronological log of what was created, edited, bookmarked,
  converted, used (copied/opened), and deleted — both in Settings → History
  and inline via `/history` (filter by typing after it, e.g. `/history
  deleted`), so you don't have to leave the capture flow to check it.
- **Snippet templates**: type `/name arg1 arg2` in the capture input to
  expand a saved template. `{{var}}` placeholders fill positionally in
  first-appearance order (a repeated `{{name}}` reuses the same arg). Manage
  templates from Settings; typing `/` shows matching commands and templates
  as you type, `Tab` autocompletes the highlighted one — and (unlike before)
  `Enter` on a still-partial command completes it too instead of saving the
  partial text as a literal note.
- **Inline Markdown in the list**: `**bold**`, `*italic*`, and `` `code` ``
  render as such within a row's text (`capture-logic.ts`'s
  `parseInlineMarkdown` — inline-only, no blocks/links/nesting, just enough
  for short snippets and emphasis to stay readable in a single line).
- **Markdown export**: writes a timestamped `.md` file (grouped by
  Todo/Note/Link/Image, todos as checkboxes, images as `![]()`) under the
  app data dir and opens it.
- **Link previews**: items detected as URLs render with a link icon and open
  in the default browser on click (via `@tauri-apps/plugin-shell`). The
  page's `<title>` and favicon are fetched once (Rust-side `ureq` GET,
  `src-tauri/src/link_preview.rs` — plain string search for `<title>`/
  `<link rel="icon">` rather than a full HTML parser dependency) and shown
  in place of the raw URL; the favicon `<img>` loads cross-origin directly
  in the webview (unaffected by CORS, which only blocks script-readable
  fetches), so only the title/favicon-URL lookup needs to go through Rust.
  Cached in memory for the session, not persisted.
- **Images**: `⌘Shift+I` (configurable) or Settings → Images → "Capture
  image" saves whatever's on the system clipboard as a PNG under the app
  data dir; the item renders as a thumbnail, and clicking it copies the
  image back to the clipboard.
- **Tray icon and Dock presence** (both off by default — Settings →
  Visibility): this app is meant to be summoned purely via the double-shift
  gesture / fallback shortcuts, so no Dock icon and no menu-bar icon is the
  intended steady state, not an oversight. Turn on "Show in menu bar" for a
  discoverable way back (left-click toggles the panel; the menu's Show/Quit
  are the only things that actually quit the app — Cmd+Q / Dock ▸ Quit are
  intercepted via `RunEvent::ExitRequested` with `code: None`, so the panel
  survives being "closed" the way a window with no title bar otherwise
  couldn't recover from) or "Show in Dock" for normal Cmd+Tab/Dock behavior;
  both apply live, no restart needed. Optional launch-at-login via
  `tauri-plugin-autostart`.
- **CLI capture** (`shift`): a companion binary that sends text to a running
  shiftshift instance over a local TCP port (`cli_protocol.rs`), so you can
  do `shift "buy milk"` or `git log -1 | shift` from a terminal. Requires the
  app to already be running — it does not touch the SQLite file directly.
  Build it alongside the app (`cargo build --bins` in `src-tauri`) or run it
  with `cargo run --bin shift -- some text`.

## Testing

```bash
cd src-tauri
cargo test
```

Covers the double-Shift and triple-tap gesture state machine (`mac_tap.rs`),
the local SQLite store CRUD, fractional reordering, and undo/redo primitives
(`restore_item`/`set_rank`) (`store/local.rs`, `store/mod.rs`), the derived
copy-tracking stats (`apply_copy_stats`), settings/template/custom-theme
persistence, Markdown export formatting, the notification excerpt
formatting, the CLI's line-capture logic, the link-preview title/favicon
HTML scraping (`link_preview.rs`), and the S3 backend's config validation
(59 tests — the S3 backend's actual network calls are not covered; see
`store/s3.rs`'s module doc).

Frontend logic (kind detection, template expansion, capture resolution, list
filtering/sorting, duplicate detection, the unified `/`-suggestion-mode
parser, theme/sort/`@`/`#`-suggestion matching, relative-time formatting,
inline Markdown/hashtag parsing, and custom-theme import validation) has 67
Vitest unit tests:

```bash
pnpm test
```
