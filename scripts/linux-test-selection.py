#!/usr/bin/env python3
# Minimal GTK window with a pre-filled, pre-selected text entry — a
# reliable Ctrl+C-copies-to-CLIPBOARD target for verifying
# `capture::press_copy_chord()`'s simulated keystroke actually works
# against a real X11 display. (xterm deliberately isn't used here: its
# Ctrl+C sends SIGINT, not copy — GTK's Entry is what guarantees the
# semantics this test needs.) See scripts/linux-test.sh.
import sys

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import GLib, Gtk  # noqa: E402

text = sys.argv[1] if len(sys.argv) > 1 else "shiftshift-x11-integration-test"

win = Gtk.Window(title="shiftshift-test")
entry = Gtk.Entry()
entry.set_text(text)
win.add(entry)
win.set_default_size(320, 60)
win.show_all()


def select_all():
	win.present()
	entry.grab_focus()
	entry.select_region(0, -1)
	return False


GLib.timeout_add(300, select_all)
# Never hang the test harness even if something upstream goes wrong.
GLib.timeout_add(8000, Gtk.main_quit)
Gtk.main()
