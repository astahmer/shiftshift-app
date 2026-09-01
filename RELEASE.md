# Public release guide

> **This is a planning document, not a runbook to execute autonomously.**
> Nothing here should be run — no tag push, no `gh release create`, no
> flipping the GitHub repo to public, no notarization submission — until the
> project owner explicitly says go. Steps are tagged `[Agent]` (safe for an
> agent to do unattended, reversible, no external side effects) or `[Human]`
> (needs a human decision, a paid account, a secret, or an irreversible/
> externally-visible action). Treat every `[Human]` step as a hard stop: do
> the `[Agent]` steps around it, then ask.

## What "public release" means here

Primary target is **macOS**, and it's the only platform with a signed/
notarized/DMG story below. Platform status as of this writing:

- **macOS**: fully implemented — double-Shift hook, copy-chord simulation
  (`enigo`), native notifications, "reveal in Finder", vibrancy.
- **Linux (X11)**: the double-Shift gesture *and* capturing the selection
  both work — `capture.rs::press_copy_chord` now simulates Ctrl+C via
  `rdev::simulate` on non-mac. Verified for real (not just "compiles") in a
  disposable container against a live X11 display —
  `scripts/linux-test-docker.sh` builds a GTK window with pre-selected
  text and confirms the simulated keystroke actually lands in the
  clipboard. **Wayland is not supported** — `rdev` uses XTest/X11 APIs
  directly for both listening and simulating, so it's a silent no-op there
  (fallback shortcuts still work). Native notifications and "reveal in
  Finder" remain macOS-only stubs on Linux.
- **Windows**: same `rdev::simulate` code path as Linux (the crate targets
  both), but **untested** — no Windows VM/container was used to verify it.
  Should work per rdev's own docs; don't publish a Windows artifact without
  actually checking on real Windows first.

Scope v1 to macOS; Linux could reasonably follow once someone wants it
(the core capture path is proven, just needs packaging — a `.deb`/AppImage
via `tauri-action`'s Linux runner, no new Rust work required). Don't
publish a Windows artifact until it's actually been run there.

Distribution model: a signed `.dmg`/`.app` attached to GitHub Releases, not
the Mac App Store (MAS would mean sandboxing, which conflicts with the raw
`CGEventTap` hook and `osascript` shell-outs this app depends on).

## Checklist

### 1. Repo hygiene `[Agent]`

- [ ] **LICENSE file** — none exists yet. Pick a license
      (`[Human]` decision — MIT/Apache-2.0/other), then an agent can add the
      file and an `SPDX-License-Identifier` mention in `Cargo.toml`/
      `package.json` (`"license"` field, currently absent from both).
- [x] **CHANGELOG.md** — started (`Unreleased` section) — keep adding
      bullet points per notable PR; makes the first release notes free.
- [ ] Add `"license"`, `"repository"`, `"description"` fields to
      `package.json` and `[package]` in `src-tauri/Cargo.toml` — currently
      minimal (`name`/`version`/`private` only).
- [ ] README polish for a stranger landing on the repo: a short screenshot
      or GIF near the top (`[Human]` — needs an actual screen recording; an
      agent can add the markdown image tag once the file exists), a
      "Download" section pointing at `scripts/install.sh` (see step 4) once
      a release actually exists, and reconcile the test counts in the
      "Testing" section (currently says 59/67, actual is 90/68 — drifted
      across several unrelated turns).
- [ ] Decide the `shift` CLI's distribution story: bundled inside the
      `.app`'s `Contents/MacOS/` (already happens automatically since it's a
      `[[bin]]` target Tauri picks up) vs. a separate Homebrew formula/tap.
      `[Human]` product decision; a formula is easy for an agent to write
      once decided.

### 2. Versioning `[Agent]`

- [ ] `package.json`, `src-tauri/Cargo.toml` (`[package] version`), and
      `src-tauri/tauri.conf.json` (`"version"`) are all `0.1.0` today and
      already in sync — keep them that way. Decide whether v1 ships as
      `0.1.0` (pre-1.0, signals "still moving") or `1.0.0` (signals
      "stable enough to trust with your data") — `[Human]` call, cosmetic
      either way, an agent can bump all three in one commit once decided.
- [ ] Confirm `src-tauri/tauri.conf.json`'s `"identifier"`
      (`dev.shiftshift.tauri`) is the bundle ID you want to be stable
      forever — macOS ties permission grants (Accessibility, notifications)
      and auto-update trust to it; changing it later means users re-grant
      permissions. `[Human]` decision, `[Agent]` can make the edit.

### 3. Code signing & notarization `[Human]` (the main blocker)

Everything in this section needs an Apple Developer Program membership
($99/yr) the project owner must already have or buy — an agent cannot do
this part.

- [ ] Enroll in the Apple Developer Program if not already.
- [ ] Create a **Developer ID Application** certificate (Xcode or
      developer.apple.com), export as `.p12`.
- [ ] Create an app-specific password (or an App Store Connect API key) for
      `notarytool`.
- [ ] Add these as **GitHub Actions repo secrets** (never commit them):
      `APPLE_CERTIFICATE` (base64 `.p12`), `APPLE_CERTIFICATE_PASSWORD`,
      `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific
      password), `APPLE_TEAM_ID`. These are the exact env vars
      `tauri-apps/tauri-action` expects — once set, signing + notarization
      is otherwise fully automatic in CI (step 4), no further human step per
      release.

Once the secrets exist, an agent can write/maintain the CI workflow that
consumes them — it never needs to see the secret values themselves.

### 4. Release CI `[Agent]` (mechanically), gated on step 3 `[Human]`

- [x] `.github/workflows/release.yml` — triggers on a `v*` tag push, macOS
      only (per the platform note above — no Windows/Linux artifacts until
      `press_copy_chord` works there), builds via
      [`tauri-apps/tauri-action`](https://github.com/tauri-apps/tauri-action),
      creates a **draft** GitHub Release with the `.dmg` attached. Reads the
      `APPLE_*` secrets automatically when present (step 3) — without them
      it still produces an unsigned `.dmg`, same as a local `pnpm tauri
      build`, so it's safe to have committed now, dormant, before step 3
      lands.
- [x] `scripts/release.sh <version>` — bumps `package.json`/
      `src-tauri/Cargo.toml`/`src-tauri/tauri.conf.json` to the given
      version together, commits, and tags locally. Deliberately does **not**
      push — pushing the tag is what fires the workflow above, so that stays
      an explicit separate `git push --follow-tags` (`[Human]`).
- [x] `scripts/install.sh` — for people who'd rather not use Homebrew:
      downloads the latest release's `.dmg` via the GitHub API, installs to
      `/Applications`, strips the quarantine flag (needed because the app
      isn't notarized yet — step 3). Meant to be run via
      `curl -fsSL .../scripts/install.sh | bash` once the repo is public;
      only works once a release with a `.dmg` actually exists.
- [x] Homebrew Cask — draft at `Casks/shiftshift.rb`, not published (see its
      own header comment for the exact steps). Homebrew requires casks to
      live in a separate `homebrew-<name>` repo to actually be installable
      (`brew tap` + `brew install --cask`) — **creating that repo is left
      for a human**, same reasoning as the GitHub secrets above (new repo =
      externally-visible action). The cask's `sha256`/exact `.dmg` filename
      also can't be finalized until a real release exists to check them
      against — both flagged as TODOs in the file itself.

### 5. Auto-updates `[Agent]` done, one `[Human]` step left

- [x] Signing keypair generated locally (`pnpm tauri signer generate`, no
      password — see the tradeoff note below). Public key is wired into
      `tauri.conf.json`'s `plugins.updater.pubkey`. The **private key** was
      deliberately written *outside* the repo, to
      `~/.shiftshift-updater-key` (and `.pub` alongside it) — never
      committed, never printed in full here.
- [x] `tauri-plugin-updater` + `tauri-plugin-process` (Rust and JS sides),
      `updater.endpoints` pointing at the GitHub Releases `latest.json`,
      `release.yml`'s `includeUpdaterJson: true` so `tauri-action` generates
      that file automatically on every release.
- [x] Settings -> Updates: "Check for updates" (manual only — no auto-check
      on startup, so a fresh install never phones home unprompted) ->
      downloads + installs + relaunches via `@tauri-apps/plugin-updater`/
      `plugin-process`.
- [ ] **`[Human]`: add `~/.shiftshift-updater-key`'s contents as the
      `TAURI_SIGNING_PRIVATE_KEY` GitHub Actions repo secret** (Settings ->
      Secrets and variables -> Actions on the repo) — `release.yml` already
      reads it, but an agent generating a signing key is one thing; an agent
      *pushing it into your repo's secret store* is a step deliberately left
      for you to do yourself, same reasoning as the Apple signing secrets in
      step 3. No `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` needed since the key
      has no password — regenerate with `-p <password>` first if you want
      one (delete the old `.pub` entry from `plugins.updater.pubkey` and
      re-wire it if you do).
- [ ] Without that secret, releases still build fine, just without a valid
      updater signature — "Check for updates" would find new releases but
      fail to install them. Not a blocker for a first release, just means
      auto-update isn't live until the secret's added.

### 6. Privacy & security review `[Agent]` (documentation), flag decisions to `[Human]`

- [x] **S3 secret access key** now lives in the OS keychain (`keyring` crate
      — Keychain/Credential Manager/Secret Service), not `settings.json`.
      `S3Settings.secret_access_key` is write-only over the wire: a non-empty
      value from the frontend goes straight to the keychain, and both the
      in-memory `Settings` and the on-disk file always keep it as `""` (see
      `commands::set_settings` and `settings::save`'s doc comments). Verified
      against the real keychain, not just compiled — `cargo test --lib
      s3_secret_round_trips_through_the_real_keychain -- --ignored`.
      `access_key_id` stays plain (an identifier, not a secret on its own).
- [ ] Write an explicit "what this app does and doesn't send anywhere"
      paragraph for the README — accurate today: no telemetry, no network
      calls except link-preview title/favicon fetches (user-initiated, to
      the URL itself) and the optional S3 backend (user-configured, to the
      user's own bucket). `[Agent]` can draft this by grepping for actual
      network call sites to confirm nothing was missed.
- [ ] Accessibility permission + `osascript` automation are both
      already disclosed in the README's Development section — good, just
      keep in sync with any future OS-integration additions.

### 7. Making the repo public `[Human]`

- [ ] The repo (`astahmer/shiftshift-app`) is currently **private**. Flipping
      it to public is a one-way, externally-visible action — an agent should
      never do this unprompted. Do it last, after LICENSE/README/CI are
      ready, so the first thing a visitor sees isn't a half-finished repo.

### 8. First release `[Human]` triggers, `[Agent]` can prepare everything up to the trigger

- [ ] Once steps 1–6 are done and the repo is public: `scripts/release.sh
      0.1.0` (or whatever was decided in step 2) to bump versions and tag
      locally, review the commit, then `git push --follow-tags` to fire the
      release workflow, review the resulting draft release, hit publish.
      The push and the publish click are both `[Human]` — an agent should
      not run `git push --follow-tags`/`--tags` or `gh release publish`
      without being explicitly told to, even after everything upstream is
      ready (`scripts/release.sh` itself stops right before pushing for
      exactly this reason).

## Suggested order

1–2 (repo hygiene + versions) → 6 (privacy doc) → 4 (CI workflow, dormant)
→ 3 (signing secrets — human blocker, can happen in parallel with 1/2/6) →
4 re-verified end-to-end once 3 lands → 5 (updater, optional) → 7 (go public)
→ 8 (tag + publish).

Everything left of "→ 7" can be fully prepared by an agent; 3, 7, and 8 are
the hard human gates.
