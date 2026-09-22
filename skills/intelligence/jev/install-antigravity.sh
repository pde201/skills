#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
#  Install the Jev decision layer into Antigravity.
#
#  Antigravity keys hooks.json by hook name rather than by event, so the
#  whole install is one top-level "jev" object — which makes removing it
#  exact rather than a search through nested entries.
#
#    ./install-antigravity.sh            install or update
#    ./install-antigravity.sh --remove   take the hooks back out
#    ./install-antigravity.sh --check    show what is currently installed
#
#  Guarding, command slimming (via PreToolUse argument rewrite), and context
#  carry-forward (via PreInvocation step injection).
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

JEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS="${JEV_ANTIGRAVITY_HOOKS:-$HOME/.gemini/config/hooks.json}"
HOOK_CMD="node $JEV_DIR/bin/jev-hook-antigravity.mjs"
BIN_DIR="$HOME/.local/bin"

# Which tools get a hook spawn. Matching every tool would fire on browser
# and search calls that a guard has nothing to say about, so the default
# is the tools that run commands or touch files. Antigravity builds do not
# all use the same names — read the log, then widen this if yours differ.
MATCHER="${JEV_ANTIGRAVITY_MATCHER:-run_command|view_file|read_file|write_to_file|create_file|edit_file|replace_file_content}"

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
    say "Antigravity hooks currently registered in $HOOKS"
    jq '{ jev: (.jev // "not installed") }' "$HOOKS"
    exit 0
    ;;

  --remove)
    BACKUP="$HOOKS.bak-$(date +%Y%m%d-%H%M%S)"
    cp "$HOOKS" "$BACKUP"
    tmp="$(mktemp)"
    jq 'del(.jev)' "$HOOKS" > "$tmp" && mv "$tmp" "$HOOKS"
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
jq --arg cmd "$HOOK_CMD" --arg matcher "$MATCHER" '
  .jev = {
    enabled: true,
    PreToolUse: [
      { matcher: $matcher,
        hooks: [ { type: "command", command: $cmd, timeout: 15 } ] }
    ],
    PreInvocation: [
      { type: "command", command: $cmd, timeout: 10 }
    ],
    # Triage only reads failures of the same tools the guard watches; a
    # wildcard here would spawn node after every browser and search call too.
    PostToolUse: [
      { matcher: $matcher,
        hooks: [ { type: "command", command: $cmd, timeout: 10 } ] }
    ],
    Stop: [
      { type: "command", command: $cmd, timeout: 15 }
    ]
  }
' "$HOOKS" > "$tmp"

jq empty "$tmp" || { warn "refusing to write invalid JSON; hooks untouched"; rm -f "$tmp"; exit 1; }
mv "$tmp" "$HOOKS"
ok "PreToolUse registered for: $MATCHER (guard, git safety, command slimming)"
ok "PreInvocation registered (context carry-forward and thrashing gate)"
ok "PostToolUse registered for the same tools (error triage)"
ok "Stop registered (definition of done verification gate)"

mkdir -p "$BIN_DIR"
ln -sfn "$JEV_DIR/bin/jev-slim.mjs" "$BIN_DIR/jev-slim"
ok "jev-slim → $BIN_DIR/jev-slim"

say "Checking it runs"
if echo '{"toolCall":{"name":"run_command","args":{"CommandLine":"true"}}}' \
   | node "$JEV_DIR/bin/jev-hook-antigravity.mjs" >/dev/null 2>&1; then
  ok "hook responds"
else
  warn "hook did not run cleanly; check node"
fi

if [ ! -d "$HOME/.gemini" ]; then
  warn "$HOME/.gemini does not exist — is Antigravity installed for this user?"
fi

if [ -z "${TYPESAFE_API_KEY:-}" ]; then
  warn "TYPESAFE_API_KEY is not set — remote judgments are disabled; deterministic guard checks remain active"
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
  Installed. Restart Antigravity to pick the hooks up.

  Registered capabilities:
  - PreToolUse: command slimming (via overwrite), safety guarding & git safety
  - PreInvocation: context carry-forward briefs & thrashing/drift guidance
  - PostToolUse: structured error triage
  - Stop: Definition of Done (DoD) verification gate

  If this build reads a different hooks.json, check:

    $HOME/.gemini/config/hooks.json         (the documented path)
    $HOME/.gemini/antigravity-cli/hooks.json
    <workspace>/.agents/hooks.json          (per project)

  Point this script at another one with:

    JEV_ANTIGRAVITY_HOOKS=/path/to/hooks.json ./install-antigravity.sh

  Knobs:

    JEV_HOOKS=0                        turn everything off
    JEV_HOOKS_GUARD=0                  stop guarding tool calls
    JEV_ANTIGRAVITY_MATCHER='a|b'      which tool names get a hook
    JEV_ANTIGRAVITY_EXPLICIT_ALLOW=1   emit {"decision":"allow"} instead
                                       of staying silent on allowed calls

  Decisions are logged to ~/.local/state/jev-hooks/jev-log.jsonl.
  The "tool" field there is the real name your build used — the fastest
  way to find out what to put in JEV_ANTIGRAVITY_MATCHER.

  Backup of your previous hooks: $BACKUP
────────────────────────────────────────────────────────────────────
EOF
