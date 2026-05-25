#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Install the prd-lifecycle skill.

Usage:
  ./install.sh [agents|codex|claude] [--force]
  ./install.sh --dest /path/to/skills-dir [--force]

Targets:
  agents  Install to ${AGENTS_HOME:-$HOME/.agents}/skills (default)
  codex   Install to ${CODEX_HOME:-$HOME/.codex}/skills
  claude  Install to ${CLAUDE_HOME:-$HOME/.claude}/skills

Options:
  --dest DIR  Install into a custom skills directory
  --force     Replace an existing prd-lifecycle install
  -h, --help  Show this help
USAGE
}

target="agents"
dest_base=""
force="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    agents|generic|codex|claude)
      target="$1"
      shift
      ;;
    --dest)
      if [[ $# -lt 2 ]]; then
        echo "error: --dest requires a directory" >&2
        exit 2
      fi
      dest_base="$2"
      shift 2
      ;;
    --force)
      force="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -f "$script_dir/SKILL.md" ]]; then
  echo "error: cannot find skill source at $script_dir" >&2
  exit 1
fi

if [[ -z "$dest_base" ]]; then
  case "$target" in
    agents|generic)
      dest_base="${AGENTS_HOME:-$HOME/.agents}/skills"
      ;;
    codex)
      dest_base="${CODEX_HOME:-$HOME/.codex}/skills"
      ;;
    claude)
      dest_base="${CLAUDE_HOME:-$HOME/.claude}/skills"
      ;;
  esac
fi

dest_dir="$dest_base/prd-lifecycle"
tmp_dir="$dest_base/.prd-lifecycle.tmp.$$"

if [[ -e "$dest_dir" && "$force" != "1" ]]; then
  cat >&2 <<EOF
error: $dest_dir already exists

Run with --force to replace it:
  ./install.sh $target --force
EOF
  exit 1
fi

mkdir -p "$dest_base"
rm -rf "$tmp_dir"
mkdir -p "$tmp_dir"

cp "$script_dir/SKILL.md" "$tmp_dir/"
if [[ -d "$script_dir/scripts" ]]; then
  cp -R "$script_dir/scripts" "$tmp_dir/"
fi

if [[ -e "$dest_dir" ]]; then
  rm -rf "$dest_dir"
fi
mv "$tmp_dir" "$dest_dir"

echo "Installed prd-lifecycle to:"
echo "  $dest_dir"
echo
echo "Restart your agent to pick up the new skill."
