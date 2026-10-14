#!/bin/sh
# Compatibility entry point: all products are now installed from this monorepo.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd -P)
if [ ! -f "$root/install.sh" ]; then
  echo 'Clone https://github.com/mgd34msu/goodvibes-jev and run ./install.sh from its root.' >&2
  exit 1
fi
if [ "${GOODVIBES_UNINSTALL:-0}" = 1 ]; then
  exec bash "$root/uninstall.sh" "$@"
fi
exec bash "$root/install.sh" "$@"
