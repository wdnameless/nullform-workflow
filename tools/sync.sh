#!/usr/bin/env bash
# sync.sh — Forwarder to tools/sync.mjs
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_MJS="$SCRIPT_DIR/sync.mjs"
if [ ! -f "$SYNC_MJS" ] && [ -n "$HARNESS_ROOT" ]; then
  SYNC_MJS="$HARNESS_ROOT/workflow-repo/tools/sync.mjs"
fi

if [ ! -f "$SYNC_MJS" ]; then
  echo "sync.sh: sync.mjs not found next to this script ($SCRIPT_DIR) and HARNESS_ROOT is unset." >&2
  exit 2
fi

exec node "$SYNC_MJS" "$@"
