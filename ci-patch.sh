#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] node is required but not found in PATH." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

if [ -f "${SCRIPT_DIR}/scripts/sillytavern-patch.mjs" ]; then
  exec node "${SCRIPT_DIR}/scripts/sillytavern-patch.mjs" "$@"
elif [ -f "${SCRIPT_DIR}/ci-patch.mjs" ]; then
  exec node "${SCRIPT_DIR}/ci-patch.mjs" "$@"
else
  echo "[ERROR] Cannot find patch manager script in ${SCRIPT_DIR}" >&2
  exit 1
fi
