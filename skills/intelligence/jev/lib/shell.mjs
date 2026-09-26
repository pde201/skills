// ──────────────────────────────────────────────────────────────────────
//  Lexical shell parsing for the guard: splitting a compound command into
//  its steps and pipelines, and recognising commands that only read.
//  No execution, no filesystem access beyond the path checks it is given.
// ──────────────────────────────────────────────────────────────────────

import { looksLikeSecretFile } from "./privacy.mjs";

/**
 * The top-level parts of a compound shell command, split on `&&`, `||`, `;`
 * and newlines outside quotes. Pipes stay inside their part: a pipeline is
 * one step. Returns [] for a command with a single part.
 */
export function shellSegments(command) {
  if (typeof command !== "string") return [];
  const parts = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (escaped) { current += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { current += char; escaped = true; continue; }
    if (quote) { current += char; if (char === quote) quote = null; continue; }
    if (char === "'" || char === '"' || char === "`") { current += char; quote = char; continue; }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") { parts.push(current); current = ""; i++; continue; }
    if (char === ";" || char === "\n") { parts.push(current); current = ""; continue; }
    current += char;
  }
  parts.push(current);
  const trimmed = parts.map((p) => p.trim()).filter(Boolean);
  return trimmed.length > 1 ? trimmed : [];
}

/** The commands of one pipeline, split on `|` outside quotes. */
export function pipelineParts(segment) {
  const parts = [];
  let current = "";
  let quote = null;
  for (const char of segment) {
    if (quote) { current += char; if (char === quote) quote = null; continue; }
    if (char === "'" || char === '"') { current += char; quote = char; continue; }
    if (char === "|") { parts.push(current); current = ""; continue; }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

// ── Read-only shell commands ─────────────────────────────────────────
//
// Half of all shell calls only look: `git status`, `rg`, `sed -n`, `gh run
// view`. The judgment layer cannot find a hazard in them that code cannot —
// the read-only gate in decide() lets only exposure and repeated failure
// speak on a read — so they skip the model round trip. The classifier is
// deliberately narrow: anything it does not recognise goes to the model.

const READ_COMMANDS = new Set([
  "cd", "ls", "cat", "head", "tail", "wc", "rg", "grep", "fd", "find", "tree", "jq", "stat", "file",
  "du", "df", "which", "type", "pwd", "date", "whoami", "diff", "sort", "uniq", "cut", "tr", "awk",
  "sed", "basename", "dirname", "realpath", "readlink", "test", "true", "column", "nl", "echo", "printf",
]);
// Options that make an otherwise read-only command write a file, run one,
// or read its program from a file. Short options may be clustered (`-ni`).
const WRITING_OPTIONS = {
  sed: /^-[^-]*i|^--in-place/,
  find: /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/,
  sort: /^-[^-]*o|^--output/,
  tree: /^-o$/,
  rg: /^--pre(=|$)/,
  fd: /^-[^-]*[xX]|^--exec/,
  awk: /^-[flE]|^--(file|load|include|exec)/,
  jq: /^-f|^--from-file/,
};
const GIT_READ = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "blame", "describe",
  "shortlog", "grep", "cat-file", "merge-base", "check-ignore", "branch", "stash", "worktree",
  "config", "tag", "remote",
]);
const GH_READ = /^gh\s+(run\s+(view|list|watch)|pr\s+(view|list|checks|diff|status)|issue\s+(view|list|status)|repo\s+view|release\s+(view|list)|auth\s+status(?!.*(--show-token|\s-t\b))|api\s)/;
const GH_API_WRITE = /\s(-X|--method)\s*(?!GET\b)\S|\s(-f|-F|--field|--raw-field|--input)(\s|=)/;
// Redirects that discard or merge output write nothing.
const HARMLESS_REDIRECT = /\d?>&\d|&?\d?>\s*\/dev\/null/g;

const words = (piece) => piece.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
const unquoteWord = (word) => word.replace(/^(["'])([\s\S]*)\1$/, "$2");

function gitReads(args) {
  // `-c key=value` can set a pager or alias that runs anything.
  let i = 0;
  while (args[i]?.startsWith("-")) {
    if (args[i] === "-c") return false;
    i += args[i] === "-C" ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!GIT_READ.has(sub) || rest.some((a) => /^--output(=|$)/.test(a))) return false;
  const positional = rest.filter((a) => !a.startsWith("-"));
  switch (sub) {
    case "branch":
      return positional.length === 0 && !rest.some((a) => /^-[dDmMcCfu]$|^--(delete|move|copy|force|set-upstream|unset-upstream|edit-description)/.test(a));
    case "stash": return ["list", "show"].includes(rest[0]);
    case "worktree": return rest[0] === "list";
    case "tag": return positional.length === 0 || rest.some((a) => a === "-l" || a === "--list");
    case "remote": return positional.length === 0 || positional[0] === "get-url";
    case "config":
      return (rest[0] === "--get" || rest[0] === "--get-all") && rest.length === 2
        && !/credential|token|password|secret|extraheader/i.test(rest[1]);
    default: return true;
  }
}

function pieceReads(piece) {
  const argv = words(piece);
  const head = argv[0];
  if (head === "git") return gitReads(argv.slice(1).map(unquoteWord));
  if (head === "gh") return GH_READ.test(piece) && !(/^gh\s+api\s/.test(piece) && GH_API_WRITE.test(piece));
  if (!READ_COMMANDS.has(head)) return false;
  const args = argv.slice(1);
  if (WRITING_OPTIONS[head] && args.some((a) => WRITING_OPTIONS[head].test(a))) return false;
  // Writes, command execution and environment reads inside the program text.
  if (head === "awk" && /system\s*\(|[>|]|getline|ENVIRON/.test(piece)) return false;
  if (head === "jq" && /\benv\b|\$ENV/.test(piece)) return false;
  if (head === "sed" && args.some((a) => !a.startsWith("-") && /(^|[^a-zA-Z\\])[wWe](\s|$|['"])/.test(a))) return false;
  if (head === "uniq" && args.filter((a) => !a.startsWith("-")).length > 1) return false;
  return true;
}

/**
 * Does this shell command provably only read? Lexical and conservative:
 * substitutions, heredocs, redirects to files, variable expansion and
 * leading assignments are all enough to say no.
 */
export function readOnlyCommand(command) {
  if (typeof command !== "string" || !command.trim()) return false;
  const bare = words(command).map((w) => (/^'[\s\S]*'$/.test(w) ? "''" : w)).join(" ").replace(HARMLESS_REDIRECT, " ");
  if (/\$|`|<<|<\(|>|\btee\b|&\s*$|(^|[^&])&(?!&)/.test(bare)) return false;
  const segments = shellSegments(command);
  for (const segment of segments.length ? segments : [command.trim()]) {
    const pieces = pipelineParts(segment.replace(HARMLESS_REDIRECT, " "));
    if (!pieces.length) return false;
    for (const piece of pieces) {
      if (/^\w+=/.test(piece) || !pieceReads(piece)) return false;
    }
  }
  return true;
}

// Files that can hold credentials without being credential files: shell
// startup files that export them, and agent settings with an `env` block.
// Naming one sends the read to the model rather than asking outright.
const MAY_HOLD_CREDENTIALS = /(^|\/)(\.zshenv|\.zshrc|\.bashrc|\.bash_profile|\.profile|\.claude\.json)$|\/\.claude\/settings(\.local)?\.json$/;

/** Does a read-only command name a file that usually holds credentials? */
export const namesSecretFile = (command) =>
  words(command).map(unquoteWord).some((word) => !word.startsWith("-") && (looksLikeSecretFile(word) || MAY_HOLD_CREDENTIALS.test(word)));
