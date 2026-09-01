#!/usr/bin/env bash
# Bumps package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json to
# the given version, commits, and tags — but does NOT push. Pushing the tag
# is what triggers .github/workflows/release.yml, so it's left as a
# deliberate separate step: review `git show HEAD` first, then
# `git push --follow-tags` when you're actually ready to cut a release.
#
# Usage: scripts/release.sh 0.2.0   (no leading "v" — the tag gets one)
set -euo pipefail

if [[ $# -ne 1 ]]; then
	echo "usage: $0 <version>   (e.g. $0 0.2.0)" >&2
	exit 1
fi
version="$1"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	echo "version must be X.Y.Z (no leading 'v')" >&2
	exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [[ -n "$(git status --porcelain)" ]]; then
	echo "working tree isn't clean — commit or stash first" >&2
	exit 1
fi

if git rev-parse "v$version" >/dev/null 2>&1; then
	echo "tag v$version already exists" >&2
	exit 1
fi

node -e "
	const fs = require('fs');
	const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
	p.version = '$version';
	fs.writeFileSync('package.json', JSON.stringify(p, null, '\t') + '\n');
"

node -e "
	const fs = require('fs');
	const p = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
	p.version = '$version';
	fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(p, null, '\t') + '\n');
"

# BSD sed (macOS default) — this repo is macOS-first, see .cargo/config.toml.
sed -i '' -E "s/^version = \"[0-9]+\.[0-9]+\.[0-9]+\"\$/version = \"$version\"/" src-tauri/Cargo.toml

git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
git commit -m "chore: bump version to $version"
git tag -a "v$version" -m "v$version"

echo
echo "v$version tagged locally — nothing pushed yet."
echo "Review:  git show HEAD"
echo "Ship it: git push --follow-tags"
