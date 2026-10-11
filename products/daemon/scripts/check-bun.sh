#!/bin/sh
# Private workspace prerequisite only; no registry install or lifecycle action.
set -eu
if ! command -v bun >/dev/null 2>&1; then
  printf '%s\n' 'goodvibes-daemon local artifact tooling requires Bun on PATH.' 'Install the workspace-supported Bun version first: https://bun.sh/docs/installation' >&2
  exit 1
fi
if ! bun --version </dev/null >/dev/null 2>&1; then
  printf '%s\n' 'goodvibes-daemon requires a working Bun executable on PATH.' >&2
  exit 1
fi
