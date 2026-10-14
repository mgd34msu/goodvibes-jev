#!/usr/bin/env bash
set -euo pipefail
prefix="${HOME:?}/.local/share/goodvibes-jev"
args=()
while (($#)); do
  case "$1" in
    --prefix) [[ $# -ge 2 && -n $2 ]] || { echo '--prefix needs a directory.' >&2; exit 1; }; prefix=$2; shift 2 ;;
    --purge) args+=(--purge); shift ;;
    --help|-h) echo 'Usage: ./uninstall.sh [--prefix DIR] [--purge]'; echo 'Stops/removes the installed service and programs. Data is preserved unless --purge is given.'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
if [[ ! -e "$prefix/installation.json" ]]; then
  echo "No Jev installation at $prefix. Any preserved user data remains untouched."
  exit 0
fi
[[ -x "$prefix/current/runtime/bun" && -f "$prefix/current/uninstall.js" ]] || {
  echo "The installed uninstaller is missing. Restore it by re-running install.sh with --prefix '$prefix'." >&2; exit 1;
}
exec "$prefix/current/runtime/bun" "$prefix/current/uninstall.js" --prefix "$prefix" "${args[@]}"
