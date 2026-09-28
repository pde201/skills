#!/usr/bin/env bash
# Verify a parent PRD is ready to close: children closed, walkthrough present,
# workspace clean, and the project's typecheck and tests pass.
set -uo pipefail

usage() {
  cat <<'USAGE'
Usage: verify-prd-closing.sh <parent_prd_issue_number> [options]

Options:
  --dir DIR         Run the typecheck and tests from DIR (default: repo root)
  --typecheck CMD   Typecheck command, or "none" to skip (default: detected)
  --test CMD        Test command, or "none" to skip (default: detected)
  --html PATH       Walkthrough HTML that must exist (default: docs/walkthrough.html)
  -h, --help        Show this help

Environment equivalents: PRD_CHECK_DIR, PRD_TYPECHECK_CMD, PRD_TEST_CMD,
PRD_WALKTHROUGH_HTML. Flags take precedence.

Detection: "npm run typecheck" if package.json defines it, else
"npx tsc --noEmit" if tsconfig.json exists; "npm test" if package.json
defines a test script. Anything undetected is skipped with a warning.
USAGE
}

parent_id=""
check_dir="${PRD_CHECK_DIR:-.}"
typecheck_cmd="${PRD_TYPECHECK_CMD:-}"
test_cmd="${PRD_TEST_CMD:-}"
html_path="${PRD_WALKTHROUGH_HTML:-docs/walkthrough.html}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir|--typecheck|--test|--html)
      if [[ $# -lt 2 ]]; then
        echo "❌ Error: $1 requires a value" >&2
        exit 2
      fi
      case "$1" in
        --dir) check_dir="$2" ;;
        --typecheck) typecheck_cmd="$2" ;;
        --test) test_cmd="$2" ;;
        --html) html_path="$2" ;;
      esac
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "❌ Error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$parent_id" ]]; then
        echo "❌ Error: unexpected argument: $1" >&2
        exit 2
      fi
      parent_id="${1#\#}"
      shift
      ;;
  esac
done

if [[ ! "$parent_id" =~ ^[0-9]+$ ]]; then
  echo "❌ Error: a numeric parent PRD issue number is required." >&2
  usage >&2
  exit 2
fi

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "❌ Error: not inside a git repository." >&2
  exit 1
}
cd "$repo_root" || exit 1

echo "=== Verifying PRD #$parent_id closing requirements ==="

# 0. Branch name should reference the parent for traceability (warning only).
current_branch=$(git branch --show-current)
if [[ ! "$current_branch" =~ (^|[^0-9])${parent_id}([^0-9]|$) ]]; then
  echo "⚠️  Warning: branch '$current_branch' does not reference PRD #$parent_id."
  echo "   Consider a branch name like feature/issue-$parent_id."
fi

# 1. Every child issue must be closed. Children are open issues whose body
# references #<parent> as a whole number (so #12 never matches #123), plus
# GitHub-native sub-issues where the host supports them.
echo "Checking child issues on GitHub..."
body_children=$(gh issue list --state open --limit 1000 --json number,body \
  --jq ".[] | select(.number != $parent_id) | select((.body // \"\") | test(\"#${parent_id}([^0-9]|$)\")) | .number") || {
  echo "❌ Error: could not list issues with gh. Is it installed and authenticated?" >&2
  exit 1
}
sub_children=$(gh api --paginate "repos/{owner}/{repo}/issues/$parent_id/sub_issues" \
  --jq '.[] | select(.state == "open") | .number' 2>/dev/null) || {
  echo "   (Sub-issues API unavailable; checked body references only.)"
  sub_children=""
}
open_children=$(printf '%s\n%s\n' "$body_children" "$sub_children" | grep -E '^[0-9]+$' | sort -un)

if [[ -n "$open_children" ]]; then
  echo "❌ Error: open child issues still reference PRD #$parent_id:"
  echo "$open_children" | sed 's/^/   #/'
  echo "Close them before closing the parent PRD."
  exit 1
fi
echo "✅ All child issues are closed."

# 2. The walkthrough HTML must exist.
if [[ ! -f "$html_path" ]]; then
  echo "❌ Error: $html_path is missing. Generate it with generate-walkthrough.js."
  exit 1
fi
echo "✅ $html_path is present."

# 3. Nothing else may be uncommitted; walkthrough files are allowed.
echo "Checking the git workspace..."
walkthrough_stem="${html_path%.*}"
dirty_files=$(git status --porcelain | grep -vF -e "$walkthrough_stem" -e "walkthrough.md" || true)
if [[ -n "$dirty_files" ]]; then
  echo "❌ Error: uncommitted changes besides the walkthrough:"
  echo "$dirty_files"
  echo "Commit, stash or clean them before closing the PRD."
  exit 1
fi
echo "✅ Git workspace is clean."

# 4 & 5. Typecheck and tests, from the configured directory.
if [[ ! -d "$check_dir" ]]; then
  echo "❌ Error: check directory '$check_dir' does not exist." >&2
  exit 1
fi
cd "$check_dir" || exit 1

has_npm_script() {
  [[ -f package.json ]] && node -e \
    'process.exit(require("./package.json").scripts?.[process.argv[1]] ? 0 : 1)' "$1" 2>/dev/null
}

if [[ -z "$typecheck_cmd" ]]; then
  if has_npm_script typecheck; then
    typecheck_cmd="npm run typecheck"
  elif [[ -f tsconfig.json ]]; then
    typecheck_cmd="npx tsc --noEmit"
  fi
fi
if [[ -z "$test_cmd" ]] && has_npm_script test; then
  test_cmd="npm test"
fi

run_check() {
  local label="$1" cmd="$2"
  if [[ -z "$cmd" ]]; then
    echo "⚠️  Warning: no $label command detected in $check_dir; skipped. Pass --${label} to set one."
    return 0
  fi
  if [[ "$cmd" == "none" ]]; then
    echo "   Skipping $label (disabled)."
    return 0
  fi
  echo "Running $label: $cmd"
  # CI=true keeps watch-mode runners (vitest, jest) to a single run.
  if ! CI=true bash -c "$cmd"; then
    echo "❌ Error: $label failed."
    exit 1
  fi
  echo "✅ $label passed."
}

run_check typecheck "$typecheck_cmd"
run_check test "$test_cmd"

echo "🎉 All checks passed. PRD #$parent_id is ready to close."
exit 0
