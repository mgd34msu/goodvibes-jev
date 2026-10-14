#!/usr/bin/env bash
# Install the Jev suite from this checkout, without changing system runtimes.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
case "${1:-}" in
  --help|-h)
    cat <<'HELP'
Usage: ./install.sh [--prefix DIR] [--bin-dir DIR] [--data-dir DIR] [--workspace DIR]
                    [--port PORT] [--no-service|--service]

Build and install the daemon, terminal UI, agent and WebUI from this checkout.
Linux x64/arm64 with glibc is supported. Run as your regular user, without sudo.
Bun and Node are supplied privately when needed. Git, curl, tar, unzip and
sha256sum must be available. By default a systemd user service is enabled.

Defaults:
  Programs: $HOME/.local/share/goodvibes-jev
  Commands: $HOME/.local/bin
  Data:     $HOME/.local/share/goodvibes-jev-data
  WebUI:    http://127.0.0.1:3421

Export TYPESAFE_API_KEY before installation or put it in the installed
private environment file afterward. Jev uses jev-latest.
Re-run to update from the current checkout. Use ./uninstall.sh to remove.
HELP
    exit 0 ;;
  --uninstall) shift; exec "$root/uninstall.sh" "$@" ;;
esac
[[ $(uname -s) == Linux ]] || { echo 'The installer currently supports Linux only.' >&2; exit 1; }
[[ $(id -u) != 0 ]] || { echo 'Run as your regular user, without sudo.' >&2; exit 1; }
case "$(uname -m)" in
  x86_64) bun_arch=x64; node_arch=x64 ;;
  aarch64|arm64) bun_arch=aarch64; node_arch=arm64 ;;
  *) echo 'Supported architectures: x64 and arm64.' >&2; exit 1 ;;
esac
for command in git curl tar unzip sha256sum; do
  command -v "$command" >/dev/null || { echo "Install the prerequisite: $command" >&2; exit 1; }
done
getconf GNU_LIBC_VERSION >/dev/null 2>&1 || { echo 'A glibc Linux distribution is required (musl/Alpine is not supported).' >&2; exit 1; }
[[ -f "$root/products/daemon/scripts/install-native.ts" ]] || { echo 'Run install.sh from a cloned goodvibes-jev repository.' >&2; exit 1; }
work=$(mktemp -d -t goodvibes-jev-bootstrap.XXXXXXXX)
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/bin"
fetch() { curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --retry 3 "$1" -o "$2"; }
verify() {
  local hash
  hash=$(awk -v name="$2" '$2 == name || $2 == "*"name { print $1 }' "$1")
  [[ $hash =~ ^[a-fA-F0-9]{64}$ ]] || { echo "Missing or ambiguous checksum: $2" >&2; exit 1; }
  (cd "$work" && printf '%s  %s\n' "$hash" "$2" | sha256sum --check --status)
}
# This is the compiler version required by the repository, not a Jev model pin.
bun_version=1.3.14
if command -v bun >/dev/null && [[ $(bun --version) == "$bun_version" ]]; then
  cp -- "$(command -v bun)" "$work/bin/bun"
else
  asset="bun-linux-$bun_arch.zip"
  base="https://github.com/oven-sh/bun/releases/download/bun-v$bun_version"
  echo "Downloading Bun $bun_version..."
  fetch "$base/SHASUMS256.txt" "$work/bun-shasums"
  fetch "$base/$asset" "$work/$asset"
  verify "$work/bun-shasums" "$asset"
  unzip -q "$work/$asset" -d "$work"
  cp -- "$work/bun-linux-$bun_arch/bun" "$work/bin/bun"
fi
if command -v node >/dev/null && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  cp -- "$(command -v node)" "$work/bin/node"
else
  echo 'Downloading the latest Node 22 runtime...'
  base=https://nodejs.org/dist/latest-v22.x
  fetch "$base/SHASUMS256.txt" "$work/node-shasums"
  asset=$(awk -v arch="$node_arch" '$2 ~ "^node-v22\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.gz$" {print $2}' "$work/node-shasums")
  [[ $asset =~ ^node-v22\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.gz$ ]] || { echo 'Cannot identify a Node runtime.' >&2; exit 1; }
  fetch "$base/$asset" "$work/$asset"
  verify "$work/node-shasums" "$asset"
  tar -xzf "$work/$asset" -C "$work"
  cp -- "$work/${asset%.tar.gz}/bin/node" "$work/bin/node"
fi
chmod 755 "$work/bin/bun" "$work/bin/node"
export PATH="$work/bin:$PATH"
cd "$root"
"$work/bin/bun" "$root/scripts/install.ts" --runtime-dir "$work/bin" "$@"
