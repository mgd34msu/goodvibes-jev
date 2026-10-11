#!/bin/sh
# Source-checkout entry usable even when Bun is missing or broken on PATH.
set -eu
case "$0" in
  */*) script_dir=${0%/*} ;;
  *) script_dir=. ;;
esac
script_dir=$(CDPATH= cd -- "$script_dir" && pwd)
. "$script_dir/check-bun.sh"
case "${1-}" in
  run) shift; exec bun "$script_dir/run-native.ts" "$@" ;;
  acquire) shift; exec bun "$script_dir/acquire-native.ts" "$@" ;;
  *) exec bun "$script_dir/install-native.ts" "$@" ;;
esac
