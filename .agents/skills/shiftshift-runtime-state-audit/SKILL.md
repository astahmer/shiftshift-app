---
name: shiftshift-runtime-state-audit
description: Investigate ShiftShift data-loss reports, storage-backend confusion, duplicate macOS app instances, and Nix launch-item ownership without deleting user data.
---

# ShiftShift Runtime State Audit

Use when entries appear missing, the app falls back to another store, or
multiple app bundles/processes compete for the panel or login item.

## 1. Identify the running app

- Inspect running processes and their absolute bundle/executable paths. Do not
  rely on `open -a` when more than one bundle has the same app identity.
- Inspect the matching LaunchAgent and determine whether Nix or the app owns
  login-item registration. The `.nix-launchd-managed` marker records Nix-managed
  ownership.
- Check `.instance.lock` while the process is live. The lock is held for the
  process lifetime; do not remove it to clear a suspected duplicate.

## 2. Identify the actual data store

1. Read the live settings file and trace `Db::open` to the selected backend.
2. Check the backend's configured path and fallback/error state. An empty local
   SQLite file does not establish loss if the configured Folder backend is in
   use.
3. Inspect the configured folder and synchronization state before concluding
   that iCloud data is absent. Distinguish the folder store from the local
   database and from initial settings/templates.
4. Confirm whether Home Manager only seeded initial settings or actually
   changed the live backend configuration. Never infer runtime state from the
   template alone.

## 3. Preserve and verify

- Keep the initial investigation read-only. Do not reset, merge, move, or delete
  user records until the active backend, data location, and backup/recovery path
  are understood.
- If an approved change is needed, target the absolute intended app bundle and
  preserve both stores until migration is verified.
- Verify one running process, expected LaunchAgent ownership, the runtime
  backend, and representative records after the change. Report application
  behavior separately from source or package build evidence.
