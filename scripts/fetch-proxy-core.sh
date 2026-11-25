#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
version=v0.5.4
case "${CAGE_CORE_ARCH:-$(uname -m)}" in
  arm64) arch=arm64 ;;
  x86_64|amd64) arch=amd64 ;;
  *) echo 'Unsupported Cage proxy-core architecture' >&2; exit 1 ;;
esac
directory=_output/proxy-core
mkdir -p "$directory"
node scripts/build-meowx-core.mjs \
  --os darwin \
  --arch "$arch" \
  --out "$directory/mihomo" \
  --cache-dir "$directory" \
  --license-dir "$directory"
host_arch="$(uname -m)"
if [[ "$host_arch" == x86_64 ]]; then
  host_arch=amd64
fi
if [[ "$arch" == "$host_arch" ]]; then
  "$directory/mihomo" -v
fi
