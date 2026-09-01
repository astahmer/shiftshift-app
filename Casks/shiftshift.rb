# Homebrew Cask for shiftshift — NOT YET PUBLISHED to a tap.
#
# To actually make `brew install --cask shiftshift` work, this needs to live
# in a separate `homebrew-<tap-name>` GitHub repo (Homebrew's convention —
# casks aren't installed straight from an arbitrary repo). Creating that repo
# is a deliberate follow-up step, not done here. Once it exists:
#   1. Copy this file to homebrew-<tap-name>/Casks/shiftshift.rb
#   2. Fill in the `sha256` below from a real release (see TODO)
#   3. `brew tap astahmer/<tap-name>` then `brew install --cask shiftshift`
#
# TODO once v0.1.0 (or whatever's actually tagged first) is released:
# - Verify the exact .dmg filename tauri-action produced — this assumes the
#   "universal" naming release.yml's `--target universal-apple-darwin`
#   produces (matching cooper's own convention), but hasn't been checked
#   against a real release yet.
# - Replace `sha256 :no_check` with the real checksum:
#     shasum -a 256 shiftshift_<version>_universal.dmg

cask "shiftshift" do
  version "0.1.0"
  sha256 :no_check # TODO: replace with a real checksum once released — see above

  url "https://github.com/astahmer/shiftshift-app/releases/download/v#{version}/shiftshift_#{version}_universal.dmg"
  name "shiftshift"
  desc "Quick-capture desktop utility — double-tap Shift to save a note/todo/link/image"
  homepage "https://github.com/astahmer/shiftshift-app"

  auto_updates true # the in-app updater (Settings -> Updates) also works independently of brew upgrades

  app "shiftshift.app"

  zap trash: [
    "~/Library/Application Support/dev.shiftshift.tauri",
    "~/Library/Caches/dev.shiftshift.tauri",
    "~/Library/Saved Application State/dev.shiftshift.tauri.savedState",
  ]
end
