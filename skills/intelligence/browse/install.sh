#!/usr/bin/env bash
# Install the browse skill for Claude Code and check what it needs:
# agent-browser on PATH, the jev skill beside it, and a TypeSafe key.
set -euo pipefail

usage() {
  cat <<'USAGE'
Install the browse skill.

Usage:
  ./install.sh [--dest DIR] [--force]

Options:
  --dest DIR  Skills directory (default: ${CLAUDE_HOME:-$HOME/.claude}/skills)
  --force     Replace an existing install
  -h, --help  Show this help
USAGE
}

src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest_base="${CLAUDE_HOME:-$HOME/.claude}/skills"
force="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest)
      [[ $# -ge 2 ]] || { echo "error: --dest requires a directory" >&2; exit 2; }
      dest_base="$2"; shift 2 ;;
    --force) force="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument $1" >&2; usage >&2; exit 2 ;;
  esac
done

warn() { echo "warning: $*" >&2; }

dest="$dest_base/browse"
if [[ -e "$dest" && "$force" != "1" ]]; then
  echo "error: $dest exists; pass --force to replace it" >&2
  exit 1
fi

mkdir -p "$dest_base"
tmp="$(mktemp -d "$dest_base/.browse.tmp.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
cp -R "$src/SKILL.md" "$src/CONTEXT.md" "$src/docs" "$src/scripts" "$tmp/"
chmod +x "$tmp/scripts/browse.mjs"
rm -rf "$dest"
mv "$tmp" "$dest"
trap - EXIT
echo "installed browse to $dest"

# The Driver is jev's client, found beside this skill.
if [[ ! -f "$dest_base/jev/lib/client.mjs" ]]; then
  warn "the jev skill is not in $dest_base; install it (skills/intelligence/jev) or set BROWSE_JEV_LIB to its lib directory"
fi

if ! command -v agent-browser >/dev/null 2>&1; then
  if [[ -t 0 ]]; then
    read -r -p "agent-browser is not installed. Install it now with npm (npm i -g agent-browser && agent-browser install)? [y/N] " answer
    if [[ "$answer" =~ ^[Yy]$ ]]; then
      npm i -g agent-browser && agent-browser install
    else
      warn "browse needs agent-browser: npm i -g agent-browser && agent-browser install"
    fi
  else
    warn "browse needs agent-browser: npm i -g agent-browser && agent-browser install"
  fi
fi

if [[ -z "${TYPESAFE_API_KEY:-}" ]]; then
  warn "TYPESAFE_API_KEY is not set; every Run will hand back driver_unavailable until it is"
fi
