#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
sync_test_directory=$(mktemp -d)
sync_test_port=${SHIFTSHIFT_TEST_S3_PORT:-4569}
sync_test_pid=""
cleanup() {
  if [[ -n "$sync_test_pid" ]]; then
    kill "$sync_test_pid" 2>/dev/null || true
    wait "$sync_test_pid" 2>/dev/null || true
  fi
  rm -rf "$sync_test_directory"
}
trap cleanup EXIT
pnpm exec s3rver --directory "$sync_test_directory" --address 127.0.0.1 \
  --port "$sync_test_port" --silent --no-vhost-buckets \
  --configure-bucket shiftshift-sync-test > "$sync_test_directory/server.log" 2>&1 &
sync_test_pid=$!
export SHIFTSHIFT_TEST_S3_ENDPOINT="http://127.0.0.1:$sync_test_port"
for attempt in {1..100}; do
  if ! kill -0 "$sync_test_pid" 2>/dev/null; then
    cat "$sync_test_directory/server.log"
    exit 1
  fi
  if curl --silent --fail "$SHIFTSHIFT_TEST_S3_ENDPOINT/shiftshift-sync-test" > /dev/null; then
    break
  fi
  if [[ "$attempt" == 100 ]]; then
    cat "$sync_test_directory/server.log"
    exit 1
  fi
  sleep 0.1
done
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib folder_sync_e2e
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib s3_sync_e2e -- --ignored
