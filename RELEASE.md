# Automated releases

Each main push that completes CI successfully starts the Release workflow.
GitHub builds a universal macOS package for Apple Silicon and Intel, uploads
its DMG, updater archive, signature, and `latest.json`, then publishes the
release. Failed or cancelled CI runs do not release. Rapid pushes may cancel
older CI runs; those superseded commits are included in the next successful
release. Only macOS is packaged; Linux has CI and sync coverage but no
validated installer pipeline yet.

## Versions and retries

The first automated version is `0.1.1`. Each new release increments the patch
number (`0.1.2`, `0.1.3`, ...), using GitHub release metadata as its version
ledger. Drafts reserve their version too. Major/minor changes can be introduced
by deliberately reserving a higher semantic version before the next run.

The workflow serializes releases and checks out the exact commit that passed
CI. Version fields in `package.json`, `src-tauri/Cargo.toml`, and
`src-tauri/tauri.conf.json` are updated in the runner checkout; Cargo updates
its lockfile during the build. Version changes are not committed back to main,
so they do not cause recursive builds. The release tag identifies the source
commit, and its release notes record the full SHA. Source manifest versions
remain the development baseline; download and installed-app versions are the
allocated release version.

A failed build leaves a draft. Rerun the failed Release workflow from Actions
to retry the same version for the same source SHA. An already published source
SHA is skipped. Publication occurs only after the expected assets exist.
GitHub concurrency retains one pending run; a newer queued run can replace an
older pending release while another build is active.

## Signing credentials

The updater private key is stored in Bitwarden as project alias
`shiftshift-updater-key` in `.secret.json`. GitHub Actions has the same value
in `TAURI_SIGNING_PRIVATE_KEY`; only the public key is committed in
`src-tauri/tauri.conf.json`. The key has no password. To reinstall the GitHub
secret without displaying it:

```bash
secret get shiftshift-updater-key | gh secret set TAURI_SIGNING_PRIVATE_KEY --repo astahmer/shiftshift-app
```

Keep a recoverable vault backup. Replacing the key means apps built with the
old public key cannot accept new updater signatures. The first automated
release uses a newly configured key; older locally installed builds need a
manual replacement before using this signing identity.

Apple code signing and notarization are not configured. Releases can provide
unsigned downloads, but macOS may require manual approval to open them. For
Developer ID signing and notarization, configure these repository Actions
secrets from an Apple Developer account:

- `APPLE_CERTIFICATE`: base64-encoded Developer ID Application `.p12`.
- `APPLE_CERTIFICATE_PASSWORD`: certificate export password.
- `APPLE_SIGNING_IDENTITY`: Developer ID Application identity.
- `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`: notarization identity,
  app-specific password, and team.

The workflow consumes these secrets automatically once configured. Never
commit certificates, private keys, or passwords. Updater signing and Apple
code signing are separate requirements.

## Downloads and updates

Find published packages at
<https://github.com/astahmer/shiftshift-app/releases>. The repository is
currently private, so downloads require repository access. The app's static
GitHub updater URL does not supply authentication: private release assets
are not an automatically usable update feed. For public in-app updates, use
publicly accessible releases or an authenticated update service designed for
that purpose; never embed a repository access token in the app.

The Homebrew Cask under `Casks/` is an unreleased template and is not updated
by this pipeline. It needs a verified version, asset URL, and SHA-256 before
being distributed through a tap.

## Rust cache and local builds

Release compilation happens on GitHub runners and uses a Rust build cache;
your local `src-tauri/target` is not required to publish.

Local development/test output is rebuildable. The development profile disables
dependency debug information and incremental compilation while retaining app
line tables. This reduces disk usage but can slow repeated builds and limits
dependency debugging. Before cleaning, confirm no compiler, test, or dev app
uses that checkout. Then:

```bash
nix develop --command cargo clean --manifest-path src-tauri/Cargo.toml --profile dev
```

This removes debug/test artifacts, including local development bundles. It
preserves release artifacts and installed app records. The next debug build
recompiles dependencies. Do not confuse `target` artifacts with the app's
configured folder store, SQLite database, or installed application.
