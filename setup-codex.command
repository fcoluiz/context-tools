#!/bin/sh
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$SCRIPT_DIR/setup-codex.sh" ]; then
  exec "$SCRIPT_DIR/setup-codex.sh" "$@"
fi

if ! command -v npx >/dev/null 2>&1; then
  printf '%s\n' 'Node.js 18 ou superior nao foi encontrado no PATH.' >&2
  exit 1
fi

exec npx --yes --package github:fcoluiz/context-tools context-tools-setup --guided "$@"
