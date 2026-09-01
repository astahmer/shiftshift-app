#!/usr/bin/env bash
# Installs the latest shiftshift release onto this Mac — downloads the
# newest GitHub release's .dmg, copies the app into /Applications, and
# strips the quarantine flag (the release isn't notarized yet, so without
# this Gatekeeper would refuse to open it with "app is damaged and can't
# be opened" — the same manual fix documented for cooper, this just
# automates it). See RELEASE.md for the notarization plan.
#
# Usage: curl -fsSL https://raw.githubusercontent.com/astahmer/shiftshift-app/main/scripts/install.sh | bash
set -euo pipefail

REPO="astahmer/shiftshift-app"

if [[ "$(uname)" != "Darwin" ]]; then
	echo "This installer only supports macOS right now — the double-Shift capture gesture isn't wired up on other platforms yet (see README)." >&2
	echo "Build from source instead: https://github.com/$REPO#development" >&2
	exit 1
fi

echo "Fetching the latest release..."
# `|| true` on the curl itself — under `set -eo pipefail`, a 404 (private
# repo, or no release published yet) would otherwise abort the script with
# curl's raw error instead of the friendlier message below.
api_response="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null || true)"
dmg_url="$(grep -o 'https://[^"]*\.dmg' <<<"$api_response" | head -n1 || true)"

if [[ -z "$dmg_url" ]]; then
	echo "Couldn't find a .dmg attached to the latest release — has one been published yet?" >&2
	echo "Check: https://github.com/$REPO/releases" >&2
	exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

dmg_path="$tmp_dir/shiftshift.dmg"
echo "Downloading $dmg_url"
curl -fsSL "$dmg_url" -o "$dmg_path"

mount_point="$tmp_dir/mount"
mkdir -p "$mount_point"
hdiutil attach "$dmg_path" -mountpoint "$mount_point" -nobrowse -quiet

app_source="$(find "$mount_point" -maxdepth 1 -iname "*.app" | head -n1)"
if [[ -z "$app_source" ]]; then
	hdiutil detach "$mount_point" -quiet
	echo "No .app bundle found inside the DMG." >&2
	exit 1
fi

dest="/Applications/$(basename "$app_source")"
if [[ -d "$dest" ]]; then
	echo "Replacing existing install at $dest"
	rm -rf "$dest"
fi

echo "Installing to $dest"
cp -R "$app_source" "$dest"
hdiutil detach "$mount_point" -quiet

xattr -dr com.apple.quarantine "$dest"

echo
echo "Installed: $dest"
echo "First run: grant Accessibility permission in System Settings -> Privacy & Security -> Accessibility for the double-Shift capture gesture to work (fallback shortcuts work without it)."
