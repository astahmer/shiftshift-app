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
  seam, `LocalSqliteStore` is the only implementation today. See the
  conflict-resolution note in `store/mod.rs` for what changes when a remote
  backend is added.

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
`Cmd+Shift+Space` / `Cmd+Shift+C` fallback shortcuts still work.

## Features

- **Settings** (gear icon in the panel): theme, double-shift bindings,
  fallback shortcuts, notifications, snippet templates, Markdown export. All
  persist to `settings.json` and apply live, no restart needed.
- **Themes**: 16 presets (Tokyo Night, Dracula, Nord, Catppuccin, Gruvbox,
  Rosé Pine, Solarized, GitHub, VS Code, One Dark — each with a light/dark
  sibling) — see `src/themes.ts`. Switch from Settings or via `/light`,
  `/dark` (jumps to the current theme's light/dark sibling), `/theme <name>`.
- **Native vibrancy**: the panel uses macOS `NSVisualEffectView` / Windows DWM
  acrylic (`src-tauri/src/vibrancy.rs`, ported from cooper's `glass.rs`).
- **Keyboard-driven list**: typing filters the list below (fuzzy-ish
  substring match, plus tag filters — `@bookmarks`/`@links`/`@todos`/`@notes`
  or the equivalent `has:x` form, combinable with a text query e.g.
  `@todos ship`). `↑`/`↓` selects a row, `Enter` acts on it (copies
  note/todo text, opens a link), `⌘Enter` always saves the typed text as a
  new item regardless of selection. `Space` toggles a selected todo's done
  state, `⌘B` bookmarks, `⌘E` edits inline, `Backspace`/`Delete` (with the
  input empty) deletes. `Escape` hides the panel.
- **Duplicate hint**: a non-blocking inline note ("Already saved") appears
  while typing text that exactly matches an existing item — saving anyway
  is still one Enter away.
- **Triple-tap → todo**: a third Shift tap fast-following a capture double-tap
  flips that just-saved item to a todo, without delaying the double-tap's own
  (instant) fire — see the `Fired::PromoteToTodo` path in `capture.rs`.
- **Save notifications**: opt-in (off by default), with an optional sound —
  see Settings → Notifications.
- **Snippet templates**: type `/name arg1 arg2` in the capture input to
  expand a saved template. `{{var}}` placeholders fill positionally in
  first-appearance order (a repeated `{{name}}` reuses the same arg). Manage
  templates from Settings.
- **Markdown export**: writes a timestamped `.md` file (grouped by
  Todo/Note/Link, todos as checkboxes) under the app data dir and opens it.
- **Link previews**: items detected as URLs render with a link icon and open
  in the default browser on click (via `@tauri-apps/plugin-shell`).
- **CLI capture** (`shift`): a companion binary that sends text to a running
  shiftshift instance over a local TCP port (`cli_protocol.rs`), so you can
  do `shift "buy milk"` or `git log -1 | shift` from a terminal. Requires the
  app to already be running — it does not touch the SQLite file directly.
  Build it alongside the app (`cargo build --bins` in `src-tauri`) or run it
  with `cargo run --bin shift -- some text`.

### Not (yet) implemented

Flagged during the production-readiness pass but out of scope for it: sync
backends (remote storage needs an auth UI, a background sync loop, and —
per the conflict-resolution note in `store/mod.rs` — a real answer to
concurrent-edit merging before it's worth building at all); a tray icon /
close-to-tray / autostart wiring (the `tauri-plugin-autostart` dependency is
already installed but unused); inline Markdown rendering in the item list;
fractional manual reordering; a clipboard-watch auto-capture mode.

## Testing

```bash
cd src-tauri
cargo test
```

Covers the double-Shift and triple-tap gesture state machine (`mac_tap.rs`),
the local SQLite store CRUD (`store/local.rs`), settings/template
persistence, Markdown export formatting, the notification excerpt
formatting, and the CLI's line-capture logic.

Frontend logic (kind detection, template expansion, capture resolution, list
filtering, duplicate detection, UI slash commands) has Vitest unit tests:

```bash
pnpm test
```
