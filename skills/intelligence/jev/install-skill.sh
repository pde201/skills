#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
#  Copy this skill into a skills directory. Packaging only.
#
#  This is NOT the Jev hook installer. Registering the Claude Code hooks
#  is install.sh, run from the installed copy afterwards. The two are
#  deliberately separate files because they do unrelated things, and
#  jev's hook installer had the name first.
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

usage() {
  cat <<'USAGE'
Install the jev skill.

Usage:
  ./install-skill.sh [codex|claude] [--force]
  ./install-skill.sh --dest /path/to/skills-dir [--force]

Targets:
  codex   Install to ${CODEX_HOME:-$HOME/.codex}/skills
  claude  Install to ${CLAUDE_HOME:-$HOME/.claude}/skills

Options:
  --dest DIR  Install into a custom skills directory
  --force     Replace an existing jev install
  -h, --help  Show this help

This copies the skill. The Claude Code hooks are registered separately, by
running install.sh from the installed skill directory.
USAGE
}

target="codex"
dest_base=""
force="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    codex|claude)
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
  echo "error: cannot find skill source at $script_dir/SKILL.md" >&2
  exit 1
fi

if [[ -z "$dest_base" ]]; then
  case "$target" in
    codex)
      dest_base="${CODEX_HOME:-$HOME/.codex}/skills"
      ;;
    claude)
      dest_base="${CLAUDE_HOME:-$HOME/.claude}/skills"
      ;;
  esac
fi

dest_dir="$dest_base/jev"
tmp_dir="$dest_base/.jev.tmp.$$"

if [[ -e "$dest_dir" && "$force" != "1" ]]; then
  cat >&2 <<EOF
error: $dest_dir already exists

Run with --force to replace it:
  ./install-skill.sh $target --force
EOF
  exit 1
fi

mkdir -p "$dest_base"
rm -rf "$tmp_dir"
mkdir -p "$tmp_dir"

for name in SKILL.md README.md install.sh install-skill.sh; do
  [[ -f "$script_dir/$name" ]] && cp -p "$script_dir/$name" "$tmp_dir/"
done

# install.sh writes the absolute path of bin/jev-hook.mjs into the Claude
# Code settings, so bin/ and lib/ have to travel with SKILL.md.
for name in bin lib test; do
  [[ -d "$script_dir/$name" ]] && cp -R "$script_dir/$name" "$tmp_dir/"
done
rm -f "$tmp_dir/bin/install.js"

if [[ -e "$dest_dir" ]]; then
  rm -rf "$dest_dir"
fi
mv "$tmp_dir" "$dest_dir"

echo "Installed jev to:"
echo "  $dest_dir"
echo
echo "The skill is installed; the Claude Code hooks are not yet registered."
echo "To register them:"
echo "  $dest_dir/install.sh"
echo
echo "Restart your agent to pick up the new skill."
