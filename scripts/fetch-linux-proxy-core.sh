#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
directory="$PWD/_output/linux-deps"
mkdir -p "$directory"
core_archive=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("packaging/linux/dependencies.json","utf8")).mihomo.file)')
node scripts/build-meowx-core.mjs \
  --os linux \
  --arch amd64 \
  --out "$directory/mihomo" \
  --gzip "$directory/$core_archive" \
  --cache-dir "$directory" \
  --license-dir "$directory"
