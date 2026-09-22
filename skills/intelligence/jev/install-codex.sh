#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
#  Install the Jev decision layer into Codex.
#
#  Merges hook entries into ~/.codex/hooks.json. Codex reads that file
#  alongside config.toml, so keeping the hooks in their own file leaves
#  config.toml — which is TOML, and yours — untouched.
#
#    ./install-codex.sh            install or update
#    ./install-codex.sh --remove   take the hooks back out
#    ./install-codex.sh --check    show what is currently installed
#
#  Codex will not run a hook it has not been told to trust. After this
#  script finishes, run /hooks inside Codex and approve the entries.
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

JEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
HOOKS="${CODEX_HOOKS:-$CODEX_DIR/hooks.json}"
HOOK_CMD="node $JEV_DIR/bin/jev-hook-codex.mjs"
BIN_DIR="$HOME/.local/bin"

say() { printf "\033[1;34m▸\033[0m %s\n" "$*"; }
ok()  { printf "  \033[32m✓\033[0m %s\n" "$*"; }
warn(){ printf "  \033[33m!\033[0m %s\n" "$*"; }

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

# Strips any hook entry pointing at a jev Codex install, at any nesting
# level, so re-running is safe and so is running it after the skill moves.
read -r -d '' DEJEV <<'JQ' || true
def dejev:
  map(select([ .hooks[]?.command // "" ] | any(contains("jev-hook-codex.mjs")) | not))
  | map(select((.hooks // []) | length > 0));
JQ

case "${1:-install}" in
  install|--check|--remove) ;;
  *) warn "unknown argument: $1"; exit 1 ;;
esac

if [ ! -f "$HOOKS" ]; then
  if [ "${1:-install}" != "install" ]; then
    say "No Jev configuration found at $HOOKS"
    exit 0
  fi
  mkdir -p "$(dirname "$HOOKS")"
  echo '{}' > "$HOOKS"
fi

if ! jq empty "$HOOKS" 2>/dev/null; then
  warn "$HOOKS is not valid JSON; fix it before installing"
  exit 1
fi

case "${1:-install}" in
  --check)
    say "Codex hooks currently registered"
    jq '
      [ .hooks // {} | to_entries[]
        | .key as $event
        | .value[]? | .hooks[]? | select((.command // "") | contains("jev-hook-codex.mjs"))
        | { event: $event, command: .command } ]
    ' "$HOOKS"
    exit 0
    ;;

  --remove)
    BACKUP="$HOOKS.bak-$(date +%Y%m%d-%H%M%S)"
    cp "$HOOKS" "$BACKUP"
    tmp="$(mktemp)"
    jq "$DEJEV"'
      .hooks //= {}
      | .hooks |= with_entries(.value |= dejev)
      | .hooks |= with_entries(select(.value | length > 0))
      | if (.hooks | length) == 0 then del(.hooks) else . end
    ' "$HOOKS" > "$tmp" && mv "$tmp" "$HOOKS"
    ok "hooks removed (backup: $BACKUP)"
    ok "$BIN_DIR/jev-slim left in place for the other agents; ./install.sh all --remove deletes it"
    exit 0
    ;;

  install) ;;
  *) warn "unknown argument: $1"; exit 1 ;;
esac

# ── Install ──────────────────────────────────────────────────────────
say "Installing Jev hooks into $HOOKS"
warn_if_temporary
BACKUP="$HOOKS.bak-$(date +%Y%m%d-%H%M%S)"
cp "$HOOKS" "$BACKUP"

tmp="$(mktemp)"
jq --arg cmd "$HOOK_CMD" "$DEJEV"'
  def entry($matcher; $timeout; $status):
    { matcher: $matcher,
      hooks: [ { type: "command", command: $cmd, timeout: $timeout, statusMessage: $status } ] };

  .hooks //= {}
  | .hooks |= with_entries(.value |= dejev)

  # Guards the call, checks git safety, and rewrites bloated commands. Codex reports edits as
  # apply_patch; Edit and Write are matcher aliases for the same thing.
  | .hooks.PreToolUse =
      ((.hooks.PreToolUse // [])) + [ entry("Bash|apply_patch|Edit|Write|Read"; 15; "jev: checking the tool call") ]

  # Triages errors from failing tools.
  | .hooks.PostToolUse =
      ((.hooks.PostToolUse // [])) + [ entry("Bash|apply_patch|Edit|Write|Read"; 10; "jev: triaging error") ]

  # Remembers what was asked for. PreToolUse carries no prompt, and this
  # is a far better answer than guessing at the transcript format.
  | .hooks.UserPromptSubmit =
      ((.hooks.UserPromptSubmit // [])) + [ entry(""; 5; "jev: noting the request") ]

  # Works out what must survive compaction, and writes it to disk.
  | .hooks.PreCompact =
      ((.hooks.PreCompact // [])) + [ entry(""; 20; "jev: preparing a carry-forward brief") ]

  # Reads that back in on the session that follows a compaction.
  | .hooks.SessionStart =
      ((.hooks.SessionStart // [])) + [ entry("compact"; 10; "jev: restoring the brief") ]

  # Clears the stashed prompt and evaluates DoD verification. Codex caps this event at 3 seconds.
  | .hooks.SessionEnd =
      ((.hooks.SessionEnd // [])) + [ entry(""; 3; "jev: cleaning up") ]
' "$HOOKS" > "$tmp"

jq empty "$tmp" || { warn "refusing to write invalid JSON; hooks untouched"; rm -f "$tmp"; exit 1; }
mv "$tmp" "$HOOKS"
ok "PreToolUse, PostToolUse, UserPromptSubmit, PreCompact, SessionStart and SessionEnd registered"

mkdir -p "$BIN_DIR"
ln -sfn "$JEV_DIR/bin/jev-slim.mjs" "$BIN_DIR/jev-slim"
ok "jev-slim → $BIN_DIR/jev-slim"

say "Checking it runs"
if echo '{"hook_event_name":"SessionStart","source":"startup"}' | node "$JEV_DIR/bin/jev-hook-codex.mjs" >/dev/null 2>&1; then
  ok "hook responds"
else
  warn "hook did not run cleanly; check node"
fi

CONFIG="$CODEX_DIR/config.toml"
if [ -f "$CONFIG" ] && grep -Eq '^[[:space:]]*hooks[[:space:]]*=[[:space:]]*false' "$CONFIG"; then
  warn "$CONFIG sets hooks = false under [features]; nothing will run until that changes"
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
  Installed — but Codex will not run these until you trust them.

    1. Start Codex
    2. Run /hooks
    3. Review the jev entries and approve them

  Codex records trust against the hash of each hook, so editing this
  skill means approving them again.

    JEV_HOOKS=0            turn everything off
    JEV_HOOKS_SLIM=0       keep the guard, stop rewriting commands
    JEV_HOOKS_GUARD=0      keep slimming, stop guarding tool calls

    JEV_CODEX_SLIM_ALLOW=1 pair the rewrite with permissionDecision
                           "allow" — only if your build ignores an
                           unpaired updatedInput. It also skips the
                           approval prompt for wrapped commands.

  Decisions are logged to ~/.local/state/jev-hooks/jev-log.jsonl —
  read it before trusting the default thresholds.

  Backup of your previous hooks: $BACKUP
────────────────────────────────────────────────────────────────────
EOF
