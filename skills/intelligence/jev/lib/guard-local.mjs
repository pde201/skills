// ──────────────────────────────────────────────────────────────────────
//  The guard's first layer: checks that need no judgment. Does the file
//  exist? Is the string being replaced actually in it? Is this `rm -rf /`?
//  These are lookups and rules, and a model should never be asked a
//  question that `existsSync` already answers.
// ──────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync, statSync } from "node:fs";
import { ASK, DENY } from "./guard-questions.mjs";

// Patterns that are catastrophic regardless of intent. Short, and every
// entry earns its place — this is not a general-purpose linter.
const CATASTROPHIC = [
  // Any option may sit between `rm` and a bare `/` or `/*` — including the
  // long `--no-preserve-root`, which is the one that makes the delete work.
  { re: /\brm\b(?:\s+-{1,2}[\w-]+)*\s+\/(?:\*)?(\s|$)/, why: "recursive delete of /" },
  { re: /\brm\b[^|;&]*--no-preserve-root/, why: "recursive delete with --no-preserve-root" },
  { re: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+(~|\$HOME)(\/\s*)?(\s|$)/, why: "recursive delete of the home directory" },
  // `--force` and `-f` alike; `--force-with-lease` and `--force-if-includes`
  // are the safe spellings and are deliberately not matched.
  { re: /\bgit\s+push\b[^|;&]*\s(--force|-f)(\s|$)/, why: "force push without --force-with-lease" },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f)/, why: "discards uncommitted work irreversibly" },
  { re: /\b(mkfs|dd\s+if=[^\s]+\s+of=\/dev\/)/, why: "writes directly to a device" },
  { re: /\bchmod\s+-R\s+777\s+\//, why: "recursive permission change from the filesystem root" },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:/, why: "fork bomb" },
  { re: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, why: "destructive SQL" },
  { re: /\bcurl\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/, why: "pipes a downloaded script straight into a shell" },
];

// A semicolon before discarding a worktree file breaks the safety chain:
// earlier verification may fail while checkout/restore and removal still run.
function hasUnguardedWorktreeCleanup(command) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char !== ";") continue;

    const cleanup = command.slice(i + 1);
    const discard = /^\s*git(?:\s+-C\s+\S+)?\s+(?:checkout|restore)\b[^;&\n]*?\s--\s+\S+/.exec(cleanup);
    if (discard && /&&\s*git(?:\s+-C\s+\S+)?\s+worktree\s+remove\b/.test(cleanup.slice(discard[0].length))) {
      return true;
    }
  }
  return false;
}

const verdict = (decision, reason) => ({ decision, reason, by: "code" });

function checkEdit({ file_path: path, old_string: oldString, replace_all: replaceAll }) {
  if (typeof path !== "string" || typeof oldString !== "string") return null;
  if (!existsSync(path)) return verdict(DENY, `${path} does not exist, so there is nothing to edit.`);
  let body;
  try {
    body = readFileSync(path, "utf8");
  } catch (err) {
    return verdict(ASK, `${path} could not be read: ${err.code ?? err.message}`);
  }
  if (!oldString) return null;
  const count = body.split(oldString).length - 1;
  if (count === 0) {
    return verdict(DENY, `The text to replace does not appear in ${path}. Re-read the file and match its current contents exactly.`);
  }
  if (count > 1 && !replaceAll) {
    return verdict(DENY, `That text appears ${count} times in ${path}. Include more surrounding context to make it unique, or set replace_all.`);
  }
  return null;
}

function checkRead({ file_path: path }) {
  if (typeof path !== "string") return null;
  if (!existsSync(path)) return verdict(DENY, `${path} does not exist.`);
  try {
    if (statSync(path).isDirectory()) {
      return verdict(DENY, `${path} is a directory, not a file. Use a listing or glob instead.`);
    }
  } catch {
    // Raced with something else; let it through and let the tool report.
  }
  return null;
}

function checkBash({ command }) {
  if (typeof command !== "string") return null;
  const hit = CATASTROPHIC.find(({ re }) => re.test(command));
  if (hit) return verdict(ASK, `This ${hit.why}. Confirm before it runs.`);
  if (hasUnguardedWorktreeCleanup(command)) {
    return verdict(ASK, "A `;` before `git checkout/restore --` lets cleanup run even if earlier checks fail. The checkout can discard changes before the worktree is removed. Confirm this cleanup or connect verification and cleanup with `&&`.");
  }
  return null;
}

const CHECKS = { Edit: checkEdit, Read: checkRead, Bash: checkBash };

/**
 * Checks that need no judgment at all. Returns a decision, or null to hand
 * the call on to Jev.
 */
export function deterministicCheck(toolName, input) {
  const check = Object.hasOwn(CHECKS, toolName) ? CHECKS[toolName] : null;
  return check ? check(input ?? {}) : null;
}
