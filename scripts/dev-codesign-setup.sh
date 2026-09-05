#!/usr/bin/env bash
# Creates (once) a self-signed code-signing certificate for local dev builds.
#
# Why this exists — the non-obvious part:
#
# macOS stores the Accessibility (TCC) grant against the app's *designated
# requirement*. For an ad-hoc signed app — which is what `pnpm tauri build`
# produces with no signing identity — that requirement is `cdhash H"..."`,
# a hash of the binary itself. So **every rebuild invalidates the grant**:
# the checkbox in System Settings still shows ticked (macOS never clears
# it), but `AXIsProcessTrusted()` returns false and the double-Shift tap
# silently never arms. Running the binary straight from a terminal masks
# this completely — the responsible process is then Terminal.app, which
# already has Accessibility, so the child inherits the trust and everything
# appears to work. That divergence is what makes this so confusing to chase.
#
# Signing with a certificate instead pins the requirement to
#   identifier "dev.shiftshift.tauri" and certificate leaf = H"<cert>"
# which is stable across rebuilds, so the grant is given once and sticks.
#
# Usage:
#   scripts/dev-codesign-setup.sh          # create the cert if missing
#   APPLE_SIGNING_IDENTITY="shiftshift-dev-signing" pnpm tauri build
#
# The identity lives in your login keychain; this script is idempotent and
# safe to re-run. CI/release signs with a real Developer ID from secrets
# instead (see .github/workflows/release.yml), so nothing here affects it.
set -euo pipefail

IDENTITY_NAME="shiftshift-dev-signing"

if security find-identity -p codesigning | grep -q "$IDENTITY_NAME"; then
	echo "Already set up: \"$IDENTITY_NAME\" is in your login keychain."
	echo "Build with: APPLE_SIGNING_IDENTITY=\"$IDENTITY_NAME\" pnpm tauri build"
	exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cat >"$work/cert.cnf" <<'EOF'
[ req ]
distinguished_name = dn
x509_extensions    = v3_codesign
prompt             = no

[ dn ]
CN = shiftshift-dev-signing

[ v3_codesign ]
basicConstraints       = critical,CA:false
keyUsage               = critical,digitalSignature
extendedKeyUsage       = critical,codeSigning
subjectKeyIdentifier   = hash
EOF

echo "Generating a self-signed code-signing certificate..."
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
	-keyout "$work/signing.key" -out "$work/signing.crt" \
	-config "$work/cert.cnf" >/dev/null 2>&1

# Legacy PBE/MAC algorithms on purpose: macOS's Security framework rejects
# the PKCS#12 defaults that LibreSSL (the system openssl) writes.
openssl pkcs12 -export -out "$work/signing.p12" \
	-inkey "$work/signing.key" -in "$work/signing.crt" \
	-name "$IDENTITY_NAME" \
	-certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1 \
	-passout pass:shiftshiftdev >/dev/null 2>&1

security import "$work/signing.p12" \
	-k "$HOME/Library/Keychains/login.keychain-db" \
	-P shiftshiftdev -T /usr/bin/codesign

echo
echo "Done. The cert shows as untrusted (CSSMERR_TP_NOT_TRUSTED) — that's"
echo "expected for self-signed and does not stop codesign from using it."
echo
echo "Build with: APPLE_SIGNING_IDENTITY=\"$IDENTITY_NAME\" pnpm tauri build"
echo "Then grant Accessibility once; it will survive later rebuilds."
