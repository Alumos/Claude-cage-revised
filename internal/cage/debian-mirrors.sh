#!/bin/sh
# Only stock and Cage-owned lists are managed. Custom lists and direct URIs
# remain under the user's control. The preference survives guest cloning.
# A choice measured on the host arrives as a plain shell variable, never an
# exported one, so later installers do not inherit it.
sudo env APT_CONFIG="${CAGE_APT_CONFIG:-/dev/null}" sh -s -e -- "${debian_mirror_choice:-}" <<'CAGE_DEBIAN_MIRRORS'
set -eu
preference=auto
if [ -f /etc/claude-cage/debian-mirror ]; then
  preference=$(cat /etc/claude-cage/debian-mirror)
fi
# The host's choice wins over the saved file and is kept for later
# maintenance runs, which do not repeat the measurement.
if [ -n "${1:-}" ]; then
  case "$1" in
    auto|official|tw|tuna|zju|nju|ustc) ;;
    *) echo 'Invalid Debian mirror choice: use auto, official, tw, tuna, zju, nju or ustc.' >&2; exit 1;;
  esac
  preference=$1
  mkdir -p "$(dirname /etc/claude-cage/debian-mirror)"
  printf '%s\n' "$preference" > /etc/claude-cage/debian-mirror
fi
case "$preference" in
  auto|official|nju) mirrors="https://mirrors.nju.edu.cn https://mirrors.ustc.edu.cn https://mirrors.zju.edu.cn https://mirrors.tuna.tsinghua.edu.cn https://debian.csie.ntu.edu.tw";;
  ustc) mirrors="https://mirrors.ustc.edu.cn https://mirrors.nju.edu.cn https://mirrors.zju.edu.cn https://mirrors.tuna.tsinghua.edu.cn";;
  zju) mirrors="https://mirrors.zju.edu.cn https://mirrors.nju.edu.cn https://mirrors.ustc.edu.cn https://mirrors.tuna.tsinghua.edu.cn";;
  tuna) mirrors="https://mirrors.tuna.tsinghua.edu.cn https://mirrors.nju.edu.cn https://mirrors.ustc.edu.cn https://mirrors.zju.edu.cn";;
  tw) mirrors="https://debian.csie.ntu.edu.tw https://mirrors.zju.edu.cn https://mirrors.nju.edu.cn https://mirrors.ustc.edu.cn https://mirrors.tuna.tsinghua.edu.cn";;
  *) echo 'Invalid /etc/claude-cage/debian-mirror: use auto, official, tw, tuna, zju, nju or ustc.' >&2; exit 1;;
esac
for repository in debian debian-security; do
  list="/etc/apt/mirrors/$repository.list"
  [ -f "$list" ] || continue
  content=$(cat "$list")
  official="https://deb.debian.org/$repository"
  old=$(printf '%s\tpriority:%s\n' "https://mirrors.nju.edu.cn/$repository" 1 "https://mirrors.ustc.edu.cn/$repository" 2 "$official" 3)
  case "$content" in
    "$official"|"$old"|'# Cage managed Debian mirrors'*) ;;
    *) continue;;
  esac
  stage=$(mktemp "$list.XXXXXX")
  probe=$(mktemp)
  trap 'rm -f "$stage" "$probe"' EXIT
  printf '# Cage managed Debian mirrors\n' > "$stage"
  suite=$(. /etc/os-release; printf '%s' "${VERSION_CODENAME:-trixie}")
  [ "$repository" != debian-security ] || suite="$suite-security"
  priority=0
  # "auto" prefers the official CDN when it works through the guest's
  # configured network and probes mirrors only after it fails.
  # Specific mirror IDs put that mirror first, followed by fallback mirrors
  # and the official source last.
  if [ "$preference" = tw ] || [ "$preference" = tuna ] || [ "$preference" = zju ] || [ "$preference" = nju ] || [ "$preference" = ustc ] || { [ "$preference" = auto ] && ! timeout 8 /usr/lib/apt/apt-helper -o Acquire::Retries=0 \
      -o Acquire::http::Timeout=5 -o Acquire::https::Timeout=5 \
      download-file "$official/dists/$suite/InRelease" "$probe" >/dev/null 2>&1; }; then
    for origin in $mirrors; do
      mirror="$origin/$repository"
      rm -f "$probe"
      if timeout 8 /usr/lib/apt/apt-helper -o Acquire::Retries=0 \
          -o Acquire::http::Timeout=5 -o Acquire::https::Timeout=5 \
          download-file "$mirror/dists/$suite/InRelease" "$probe" >/dev/null 2>&1; then
        priority=$((priority + 1))
        printf '%s\tpriority:%s\n' "$mirror" "$priority" >> "$stage"
      else
        printf 'Debian mirror unavailable; using the next source: %s\n' "$mirror"
      fi
    done
  fi
  priority=$((priority + 1))
  printf '%s\tpriority:%s\n' "$official" "$priority" >> "$stage"
  chmod 0644 "$stage"
  mv -f "$stage" "$list"
  rm -f "$probe"
  trap - EXIT
done
CAGE_DEBIAN_MIRRORS
