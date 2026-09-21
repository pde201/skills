#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
#  Install the Jev decision layer into a coding agent.
#
#    ./install.sh                     Claude Code (the default)
#    ./install.sh codex               Codex
#    ./install.sh antigravity         Antigravity
#    ./install.sh all                 every agent above
#
#    ./install.sh [agent] --remove    take the hooks back out
#    ./install.sh [agent] --check     show what is currently installed
#
#  Claude Code is the default because this script installed it before
#  there was anything else to install, and the published one-liner says
#  `install.sh` with no argument.
#
#  The Claude Code half is below: it merges four hook entries into
#  ~/.claude/settings.json. Claude Code writes to that file itself, so
#  this merges rather than symlinking, and re-running replaces only the
#  jev entries and leaves everything else exactly as it was. The other
#  agents live in install-codex.sh and install-antigravity.sh, which
#  this script hands off to.
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

JEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/.local/bin"

say() { printf "\033[1;34m▸\033[0m %s\n" "$*"; }
ok()  { printf "  \033[32m✓\033[0m %s\n" "$*"; }
warn(){ printf "  \033[33m!\033[0m %s\n" "$*"; }

# ── Which agent ──────────────────────────────────────────────────────
case "${1:-}" in
  claude)      shift ;;
  codex)       shift; exec bash "$JEV_DIR/install-codex.sh" "$@" ;;
  antigravity) shift; exec bash "$JEV_DIR/install-antigravity.sh" "$@" ;;
  all)
    shift
    bash "$JEV_DIR/install.sh" claude "$@"
    bash "$JEV_DIR/install-codex.sh" "$@"
    bash "$JEV_DIR/install-antigravity.sh" "$@"
    # The jev-slim symlink is shared by every agent, so only a removal
    # that takes all of them out removes it too.
    if [ "${1:-}" = "--remove" ] && [ -L "$BIN_DIR/jev-slim" ]; then
      rm -f "$BIN_DIR/jev-slim"
      ok "removed $BIN_DIR/jev-slim"
    fi
    exit 0
    ;;
esac

SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
HOOK_CMD="node $JEV_DIR/bin/jev-hook.mjs"

command -v jq   >/dev/null || { warn "jq is required"; exit 1; }
command -v node >/dev/null || { warn "node is required"; exit 1; }

# The hooks need built-in fetch (Node 18+); the tests and evals need 22+.
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  warn "node $NODE_MAJOR is too old — the hooks need Node 18+, the tests and evals Node 22+"
  exit 1
elif [ "$NODE_MAJOR" -lt 22 ]; then
  warn "node $NODE_MAJOR runs the hooks; npm test and the evals need Node 22+"
fi

# Hooks are registered by absolute path. A copy in a temp directory works
# until the directory is cleaned up, then every session reports a broken hook.
warn_if_temporary() {
  local tmp_prefix="${TMPDIR:-/nonexistent-tmpdir}"
  tmp_prefix="${tmp_prefix%/}"
  case "$JEV_DIR" in
    "$tmp_prefix"/*|/tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*)
      warn "$JEV_DIR looks like a temporary directory"
      warn "hooks are registered by absolute path and stop working when it is deleted;"
      warn "copy the skill into a skills directory first (bin/install.js or install-skill.sh) and run install.sh from there"
      ;;
  esac
}

# Strips any hook entry pointing at a jev install, at any nesting level, so
# the script is safe to re-run and safe to run after the skill has moved.
read -r -d '' DEJEV <<'JQ' || true
def dejev:
  map(select([ .hooks[]?.command // "" ] | any(contains("jev-hook.mjs")) | not))
  | map(select((.hooks // []) | length > 0));
JQ

case "${1:-install}" in
  install|--check|--remove) ;;
  *) warn "unknown argument: $1"; exit 1 ;;
esac

if [ ! -f "$SETTINGS" ]; then
  if [ "${1:-install}" != "install" ]; then
    say "No Jev configuration found at $SETTINGS"
    exit 0
  fi
  mkdir -p "$(dirname "$SETTINGS")"
  echo '{}' > "$SETTINGS"
fi

if ! jq empty "$SETTINGS" 2>/dev/null; then
  warn "$SETTINGS is not valid JSON; fix it before installing"
  exit 1
fi

case "${1:-install}" in
  --check)
    say "Hooks currently registered"
    jq --arg d "$JEV_DIR" '
      [ .hooks // {} | to_entries[]
        | .key as $event
        | .value[]? | .hooks[]? | select((.command // "") | contains("jev-hook.mjs"))
        | { event: $event, command: .command } ]
    ' "$SETTINGS"
    exit 0
    ;;

  --remove)
    BACKUP="$SETTINGS.bak-$(date +%Y%m%d-%H%M%S)"
    cp "$SETTINGS" "$BACKUP"
    tmp="$(mktemp)"
    jq "$DEJEV"'
      .hooks //= {}
      | .hooks |= with_entries(.value |= dejev)
      | .hooks |= with_entries(select(.value | length > 0))
      | if (.hooks | length) == 0 then del(.hooks) else . end
    ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
    ok "hooks removed (backup: $BACKUP)"
    ok "$BIN_DIR/jev-slim left in place for the other agents; ./install.sh all --remove deletes it"
    exit 0
    ;;

  install) ;;
  *) warn "unknown argument: $1"; exit 1 ;;
esac

# ── Install ──────────────────────────────────────────────────────────
say "Installing Jev hooks into $SETTINGS"
warn_if_temporary
BACKUP="$SETTINGS.bak-$(date +%Y%m%d-%H%M%S)"
cp "$SETTINGS" "$BACKUP"

tmp="$(mktemp)"
jq --arg cmd "$HOOK_CMD" "$DEJEV"'
  def entry($matcher; $timeout):
    { matcher: $matcher,
      hooks: [ { type: "command", command: $cmd, timeout: $timeout } ] };

  .hooks //= {}
  # Clear every earlier jev entry first, including ones under event names
  # this version no longer registers (PostToolUse before it became PostToolUseFailure).
  | .hooks |= with_entries(.value |= dejev)

  # Guards the call, checks git safety, and rewrites bloated commands. Scoped by matcher so it
  # never spawns for tools it has nothing to say about.
  | .hooks.PreToolUse =
      ((.hooks.PreToolUse // [])) + [ entry("Bash|Edit|Write|NotebookEdit|Read"; 15) ]

  # Triages errors from failing tools. PostToolUse fires only on success and
  # carries no error; failures arrive as PostToolUseFailure.
  | .hooks.PostToolUseFailure =
      ((.hooks.PostToolUseFailure // [])) + [ entry("Bash|Edit|Write|NotebookEdit|Read"; 10) ]

  # Works out what must survive compaction, and writes it to disk.
  | .hooks.PreCompact =
      ((.hooks.PreCompact // [])) + [ entry(""; 20) ]

  # Reads that back in on the session that follows a compaction.
  | .hooks.SessionStart =
      ((.hooks.SessionStart // [])) + [ entry("compact"; 10) ]

  | .hooks |= with_entries(select(.value | length > 0))
' "$SETTINGS" > "$tmp"

jq empty "$tmp" || { warn "refusing to write invalid JSON; settings untouched"; rm -f "$tmp"; exit 1; }
mv "$tmp" "$SETTINGS"
ok "PreToolUse, PostToolUseFailure, PreCompact and SessionStart registered"

mkdir -p "$BIN_DIR"
ln -sfn "$JEV_DIR/bin/jev-slim.mjs" "$BIN_DIR/jev-slim"
ok "jev-slim → $BIN_DIR/jev-slim"

say "Checking it runs"
if echo '{"hook_event_name":"SessionStart","source":"startup"}' | node "$JEV_DIR/bin/jev-hook.mjs" >/dev/null 2>&1; then
  ok "hook responds"
else
  warn "hook did not run cleanly; check node"
fi

if [ -z "${TYPESAFE_API_KEY:-}" ]; then
  warn "TYPESAFE_API_KEY is not set — remote judgments are disabled; deterministic local behavior remains active"
  cat <<'NOTE'

    Export it from your secret manager where the agent process will inherit it.
    A terminal launch reads your shell rc (~/.zshrc, ~/.bashrc); a GUI launch
    does not, so publish it to the login session as well. On macOS:

      launchctl setenv TYPESAFE_API_KEY "$(<secret-manager> read <item>)"

    then quit and relaunch the app. A hook that logs `reason: "no api key"`
    is running without it.

NOTE
else
  ok "TYPESAFE_API_KEY is set"
fi

cat <<EOF

────────────────────────────────────────────────────────────────────
  Installed for Claude Code. Start a new session to pick the hooks up.

  For the other agents:

    ./install.sh codex
    ./install.sh antigravity

    JEV_HOOKS=0            turn everything off
    JEV_HOOKS_SLIM=0       keep the guard, stop rewriting commands
    JEV_HOOKS_GUARD=0      keep slimming, stop guarding tool calls

  Decisions are logged to ~/.local/state/jev-hooks/jev-log.jsonl —
  read it before trusting the default thresholds.

  Backup of your previous settings: $BACKUP
────────────────────────────────────────────────────────────────────
EOF
