#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
pause_on_error() {
  if [ -t 0 ] && [ -t 1 ]; then
    printf '%s' 'Pressione Enter para fechar esta janela... '
    read -r _ || true
  fi
}
if [ -f "$SCRIPT_DIR/setup-codex.mjs" ]; then
  if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' 'Node.js 18 ou superior nao foi encontrado no PATH.' >&2
    pause_on_error
    exit 1
  fi
  exec node "$SCRIPT_DIR/setup-codex.mjs" --guided "$@"
fi

if ! command -v npx >/dev/null 2>&1; then
  printf '%s\n' 'Node.js 18 ou superior nao foi encontrado no PATH.' >&2
  pause_on_error
  exit 1
fi

exec npx --yes --package github:fcoluiz/context-tools context-tools-setup --guided "$@"
