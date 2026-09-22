#!/usr/bin/env bash
# install.sh — Portable harness installer wrapper for Linux, macOS, and Git Bash.

set -e

if ! command -v node >/dev/null 2>&1; then
  echo "Error: 'node' is not found in PATH." >&2
  echo "The workflow harness requires Node.js 18+ to install and run." >&2
  echo "Please install Node.js (https://nodejs.org) and ensure it is in your PATH." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/tools/install-harness.mjs" "$@"
