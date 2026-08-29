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
- **Unified item model** (`kind: note | todo | link`, `done`, `pinned`, `rank`)
  instead of separate note/todo/clipboard concepts — see
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

- Node 20+, npm
- Rust (stable) via [rustup](https://rustup.rs)
- macOS: Xcode Command Line Tools

If your shell's `cc`/`ld` resolve to a non-Apple toolchain (e.g. via Nix), see
`.cargo/config.toml` — it pins the linker to `/usr/bin/cc` for this project.

## Development

```bash
npm install
npm run tauri dev
```

On first run, macOS will show the app as "not responding to Accessibility
requests" until you grant it under System Settings → Privacy & Security →
Accessibility — until then, double-Shift capture is inactive but the
`Cmd+Shift+Space` / `Cmd+Shift+C` fallback shortcuts still work.

## Testing

```bash
cd src-tauri
cargo test
```

Covers the double-Shift gesture state machine (`mac_tap.rs`) and the local
SQLite store CRUD (`store/local.rs`).
