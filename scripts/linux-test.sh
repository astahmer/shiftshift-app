#!/usr/bin/env bash
# Runs INSIDE the container built from scripts/linux-test.Dockerfile (needs
# Xvfb/xdotool/python3-gi/cargo on PATH) — not meant to run on a bare host.
# Verifies the Linux port of `capture.rs::press_copy_chord` for real: starts
# a virtual X11 display, opens a GTK window with pre-selected text, and
# confirms the simulated Ctrl+C actually copies it to the clipboard.
#
# Driven by scripts/linux-test-docker.sh from the host — see that file for
# the one-liner that builds the image and runs this.
set -euo pipefail

cd /work/src-tauri

export DISPLAY=:99
Xvfb "$DISPLAY" -screen 0 1024x768x24 &
xvfb_pid=$!
trap 'kill $xvfb_pid 2>/dev/null || true' EXIT
sleep 1

echo "=== cargo build --lib ==="
cargo build --lib

echo "=== cargo test --lib (unit tests, no display needed) ==="
cargo test --lib

echo "=== starting the GTK selection helper ==="
python3 /work/scripts/linux-test-selection.py "shiftshift-x11-integration-test" &
gtk_pid=$!
sleep 1.5
xdotool search --name "shiftshift-test" windowactivate --sync 2>&1 || echo "windowactivate failed (no WM running) — relying on GTK's own focus-on-show"
sleep 0.5

echo "=== cargo test --lib press_copy_chord_copies_a_real_x11_selection (real X11 integration) ==="
cargo test --lib press_copy_chord_copies_a_real_x11_selection -- --ignored --nocapture

wait $gtk_pid 2>/dev/null || true
echo "=== all Linux checks passed ==="
