#!/usr/bin/env bash
# One-liner to actually verify the Linux build/capture path in a throwaway
# container (Docker or OrbStack) — builds shiftshift-linux-test if it
# doesn't exist yet, then runs scripts/linux-test.sh inside it against a
# live-mounted src-tauri/ (so it always tests your current working tree,
# not a stale copy).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

docker build -f scripts/linux-test.Dockerfile -t shiftshift-linux-test .

docker run --rm \
	-v "$repo_root/src-tauri":/work/src-tauri \
	-v "$repo_root/scripts":/work/scripts \
	shiftshift-linux-test \
	bash /work/scripts/linux-test.sh
