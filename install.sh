#!/usr/bin/env bash
# Copy one skill from this repository into an agent's skills directory.
set -euo pipefail

usage() {
  cat <<'USAGE'
Install a skill from this repository.

Usage:
  ./install.sh <skill> [agents|codex|claude] [--force]
  ./install.sh <skill> --dest /path/to/skills-dir [--force]
  ./install.sh --list

Targets:
  agents  Install to ${AGENTS_HOME:-$HOME/.agents}/skills (default)
  codex   Install to ${CODEX_HOME:-$HOME/.codex}/skills
  claude  Install to ${CLAUDE_HOME:-$HOME/.claude}/skills

Options:
  --dest DIR  Install into a custom skills directory
  --force     Replace an existing install of the skill
  --list      List the skills this script installs
  -h, --help  Show this help

jev is installed by its own scripts, which also register its hooks; see
skills/intelligence/jev/README.md.
USAGE
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Packaging files that stay in the repository rather than the installed skill.
excluded=(bin install.sh package.json README.md evals samples test)

# Print "<name> <source dir>" for every installable skill. The source is the
# directory holding SKILL.md: the package itself, or a subdirectory named
# after the skill (effective-html keeps its samples beside the skill).
list_skills() {
  local package name
  for package in "$repo_root"/skills/*/*/; do
    package="${package%/}"
    name="$(basename "$package")"
    [[ "$name" == "jev" ]] && continue
    if [[ -f "$package/$name/SKILL.md" ]]; then
      echo "$name $package/$name"
    elif [[ -f "$package/SKILL.md" ]]; then
      echo "$name $package"
    fi
  done
}

skill=""
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
    --list)
      list_skills | cut -d' ' -f1
      exit 0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$skill" ]]; then
        echo "error: unexpected argument: $1" >&2
        exit 2
      fi
      skill="$1"
      shift
      ;;
  esac
done

if [[ -z "$skill" ]]; then
  echo "error: name a skill to install" >&2
  usage >&2
  exit 2
fi

if [[ "$skill" == "jev" ]]; then
  echo "error: jev has its own installers, which also register its hooks." >&2
  echo "See skills/intelligence/jev/README.md." >&2
  exit 2
fi

source_dir="$(list_skills | awk -v s="$skill" '$1 == s { print $2 }')"
if [[ -z "$source_dir" ]]; then
  echo "error: unknown skill: $skill" >&2
  echo "Available: $(list_skills | cut -d' ' -f1 | tr '\n' ' ')" >&2
  exit 2
fi

if [[ -z "$dest_base" ]]; then
  case "$target" in
    agents|generic) dest_base="${AGENTS_HOME:-$HOME/.agents}/skills" ;;
    codex) dest_base="${CODEX_HOME:-$HOME/.codex}/skills" ;;
    claude) dest_base="${CLAUDE_HOME:-$HOME/.claude}/skills" ;;
  esac
  rerun_args="$skill $target"
else
  rerun_args="$skill --dest \"$dest_base\""
fi

dest_dir="$dest_base/$skill"
tmp_dir="$dest_base/.$skill.tmp.$$"

if [[ -e "$dest_dir" && "$force" != "1" ]]; then
  cat >&2 <<EOF
error: $dest_dir already exists

Run with --force to replace it:
  $repo_root/install.sh $rerun_args --force
EOF
  exit 1
fi

mkdir -p "$dest_base"
rm -rf "$tmp_dir"
mkdir -p "$tmp_dir"
trap 'rm -rf "$tmp_dir"' EXIT

for entry in "$source_dir"/* "$source_dir"/.[!.]*; do
  [[ -e "$entry" ]] || continue
  name="$(basename "$entry")"
  skip="0"
  for pattern in "${excluded[@]}"; do
    [[ "$name" == "$pattern" ]] && skip="1"
  done
  [[ "$skip" == "1" ]] || cp -R "$entry" "$tmp_dir/"
done

rm -rf "$dest_dir"
mv "$tmp_dir" "$dest_dir"
trap - EXIT

echo "Installed $skill to:"
echo "  $dest_dir"
echo
echo "Restart your agent to pick up the new skill."

legacy_dir="$dest_base/create-html-artifacts"
if [[ "$skill" == "effective-html" && -f "$legacy_dir/SKILL.md" ]]; then
  echo
  echo "note: this skill was previously named create-html-artifacts. The old copy"
  echo "is still at $legacy_dir and will load alongside"
  echo "this one; remove it once you no longer need it:"
  echo "  rm -rf \"$legacy_dir\""
fi
