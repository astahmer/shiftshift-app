#!/usr/bin/env bash
# E2E check: does summoning shiftshift actually take focus *and* keyboard
# input away from whatever app is frontmost?
#
# WHAT THIS DOES NOT COVER — read this before trusting a green run:
# it triggers via the fallback hotkey (CmdOrCtrl+Shift+Space), NOT the
# double-Shift gesture, so it does not exercise the CGEventTap at all. A
# pass therefore does not prove the gesture works. The Input Monitoring
# check below exists precisely to cover that gap, because a missing
# Input Monitoring kills the gesture while leaving everything here green.
#
# Driving the real gesture synthetically was tried and does not work; don't
# burn time re-attempting it:
#   - AppleScript `key down shift` doesn't carry the device-specific NX bits
#     (NX_DEVICELSHIFTKEYMASK/RSHIFT) the tap keys off, so it never registers.
#   - CGEventPost of right-Shift with those exact bits set by hand, at both
#     CGEventTapLocation::HID and ::Session, never reaches the tap either —
#     macOS filters synthetic events from it.
# The gesture itself has to be verified by a human pressing a real key.
#
# Run from a normal, already-trusted interactive Terminal session: it drives
# System Events to switch focus and type, which needs that terminal to hold
# Accessibility + Automation (macOS prompts on first run). Running it from a
# sandboxed/automated shell that isn't trusted shows up as INCONCLUSIVE
# rather than FAIL — that's an untrusted harness, not a shiftshift bug.
#
# Usage: scripts/mac-focus-e2e.sh
set -uo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
	echo "macOS only." >&2
	exit 1
fi

APP="/Applications/shiftshift.app"
APP_BIN="$APP/Contents/MacOS/shiftshift-tauri"
BUNDLE_ID="dev.shiftshift.tauri"
MARKER="ZZFOCUSPROBEZZ"

if [[ ! -x "$APP_BIN" ]]; then
	echo "Not found: $APP_BIN — build and install shiftshift.app first." >&2
	exit 1
fi

# --- Input Monitoring -------------------------------------------------------
# The permission the double-Shift tap actually needs, and the one that is
# invisible when missing: AXIsProcessTrusted() still reports "granted", the
# Settings checkbox still looks ticked, and the gesture is simply dead. Read
# it straight from TCC where possible so a regression fails loudly here.
# Reading TCC.db needs Full Disk Access for *this* terminal; without it we
# can't verify, and say so rather than passing quietly.
echo "== Input Monitoring =="
tcc_db="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
im_row="$(sqlite3 "$tcc_db" \
	"select auth_value from access where service='kTCCServiceListenEvent' and client='$BUNDLE_ID';" 2>/dev/null)"
im_status=$?
if [[ $im_status -ne 0 ]]; then
	echo "UNVERIFIED: can't read TCC.db (this terminal lacks Full Disk Access)."
	echo "            A pass below does NOT cover the double-Shift gesture."
	echo "            Check manually: System Settings > Privacy & Security > Input Monitoring."
elif [[ -z "$im_row" ]]; then
	echo "FAIL: shiftshift is not in the Input Monitoring list at all."
	echo "      The double-Shift gesture cannot work. The app requests this at"
	echo "      startup (mac_tap::request_input_monitoring) — if the row is"
	echo "      missing, that request regressed."
	exit 1
elif [[ "$im_row" != "2" ]]; then
	echo "FAIL: Input Monitoring present but not granted (auth_value=$im_row)."
	echo "      Enable shiftshift under System Settings > Privacy & Security > Input Monitoring."
	exit 1
else
	echo "OK: Input Monitoring granted."
fi
echo

# --- focus + keyboard ownership --------------------------------------------
echo "== Focus / keyboard ownership =="
pkill -f shiftshift-tauri 2>/dev/null || true
sleep 1
open -a "$APP"
sleep 3

pass=0
fail=0
for i in 1 2 3; do
	if ! osascript \
		-e 'tell application "TextEdit" to activate' \
		-e 'tell application "TextEdit" to if (count of documents) = 0 then make new document' \
		-e 'tell application "TextEdit" to set text of front document to ""' >/dev/null 2>&1; then
		echo "INCONCLUSIVE: can't drive TextEdit via System Events — this terminal isn't trusted for Automation."
		exit 2
	fi
	sleep 1

	before="$(osascript -e 'tell application "System Events" to get name of first process whose frontmost is true' 2>/dev/null)"
	osascript -e 'tell application "System Events" to keystroke space using {command down, shift down}' >/dev/null 2>&1
	sleep 1.2
	after="$(osascript -e 'tell application "System Events" to get name of first process whose frontmost is true' 2>/dev/null)"

	# Two assertions, because "frontmost" alone can't distinguish the capture
	# panel from the dock window — and because the failure that actually
	# matters to a user is keystrokes landing in the wrong app.
	osascript -e "tell application \"System Events\" to keystroke \"$MARKER\"" >/dev/null 2>&1
	sleep 1
	leaked="$(osascript -e 'tell application "TextEdit" to get text of front document' 2>/dev/null)"

	took_focus="no"; [[ "$after" == *shiftshift* ]] && took_focus="yes"
	kept_keys="no"; [[ "$leaked" != *"$MARKER"* ]] && kept_keys="yes"

	if [[ "$took_focus" == "yes" && "$kept_keys" == "yes" ]]; then
		echo "run $i: PASS ($before -> $after, keystrokes did not leak)"
		pass=$((pass + 1))
	else
		echo "run $i: FAIL ($before -> $after, took_focus=$took_focus kept_keystrokes=$kept_keys)"
		fail=$((fail + 1))
	fi

	# Dismiss deterministically before the next round. Escape alone is not
	# reliable here, and a panel left visible makes the *next* trigger toggle
	# it shut instead of open — which reads as an intermittent focus failure
	# and is really just harness state desync. Toggle, then confirm the app
	# actually gave focus back.
	for _ in 1 2 3; do
		now="$(osascript -e 'tell application "System Events" to get name of first process whose frontmost is true' 2>/dev/null)"
		[[ "$now" != *shiftshift* ]] && break
		osascript -e 'tell application "System Events" to keystroke space using {command down, shift down}' >/dev/null 2>&1
		sleep 1
	done
done

echo
echo "RESULT: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
