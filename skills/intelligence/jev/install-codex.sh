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
    exit 0
    ;;

  install) ;;
  *) warn "unknown argument: $1"; exit 1 ;;
esac

# ── Install ──────────────────────────────────────────────────────────
say "Installing Jev hooks into $HOOKS"
BACKUP="$HOOKS.bak-$(date +%Y%m%d-%H%M%S)"
cp "$HOOKS" "$BACKUP"

tmp="$(mktemp)"
jq --arg cmd "$HOOK_CMD" "$DEJEV"'
  def entry($matcher; $timeout; $status):
    { matcher: $matcher,
      hooks: [ { type: "command", command: $cmd, timeout: $timeout, statusMessage: $status } ] };

  .hooks //= {}
  | .hooks |= with_entries(.value |= dejev)

  # Guards the call and rewrites bloated commands. Codex reports edits as
  # apply_patch; Edit and Write are matcher aliases for the same thing.
  | .hooks.PreToolUse =
      ((.hooks.PreToolUse // [])) + [ entry("Bash|apply_patch|Edit|Write|Read"; 15; "jev: checking the tool call") ]

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

  # Clears the stashed prompt. Codex caps this event at 3 seconds.
  | .hooks.SessionEnd =
      ((.hooks.SessionEnd // [])) + [ entry(""; 3; "jev: cleaning up") ]
' "$HOOKS" > "$tmp"

jq empty "$tmp" || { warn "refusing to write invalid JSON; hooks untouched"; rm -f "$tmp"; exit 1; }
mv "$tmp" "$HOOKS"
ok "PreToolUse, UserPromptSubmit, PreCompact, SessionStart and SessionEnd registered"

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

    Put it somewhere Codex will inherit it, e.g. ~/.zshrc.local:

      export TYPESAFE_API_KEY="$(op read 'op://Private/TYPESAFE_API_KEY/credential')"

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
