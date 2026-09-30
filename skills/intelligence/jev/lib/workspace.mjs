// ──────────────────────────────────────────────────────────────────────
//  Where a call works: the workspace a scope judgment is measured
//  against, the files a call would change, and the places the agent
//  keeps for itself. All lexical — no filesystem access.
//
// `wrong_scope` used to be judged against `cwd` alone, which reads a
// sibling checkout, a scratch directory or a skill under ~/.claude as
// "outside the project" even when the session has been working there all
// along. The workspace is wider than the cwd, and it is knowable.
// ──────────────────────────────────────────────────────────────────────

import { resolve, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { shellSegments, pipelineParts } from "./shell.mjs";
import config from "./config.mjs";

const expandHome = (p) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);
export const normalizePath = (p, cwd) => resolve(cwd || process.cwd(), expandHome(String(p).trim())).replace(/\/+$/, "") || "/";

// macOS reaches /tmp and /var through /private; a path may be spelled either way.
const privateAliases = (p) => {
  if (/^\/private\/(tmp|var|etc)(\/|$)/.test(p)) return [p, p.replace(/^\/private/, "")];
  if (/^\/(tmp|var|etc)(\/|$)/.test(p)) return [p, `/private${p}`];
  return [p];
};

/**
 * Every directory that counts as "the workspace" for a scope judgment.
 *
 * @param {{cwd?: string, hostRoots?: string[], writtenDirs?: string[]}} opts
 *   hostRoots   — workspace folders the host reports (Antigravity `workspacePaths`)
 *   writtenDirs — directories this session has already changed files in
 */
export function workspaceRoots({ cwd, hostRoots = [], writtenDirs = [] } = {}) {
  const base = cwd || process.cwd();
  const roots = new Set();
  const add = (p) => {
    if (typeof p !== "string" || !p.trim()) return;
    for (const alias of privateAliases(normalizePath(p, base))) roots.add(alias);
  };
  add(base);
  for (const root of hostRoots) add(root);
  for (const root of config.workspaceRoots) add(root);
  for (const dir of writtenDirs) add(dir);
  add(tmpdir());
  add("/tmp");
  if (process.env.TMPDIR) add(process.env.TMPDIR);
  return [...roots];
}

/** Is `path` one of the roots or beneath one of them? Lexical, no filesystem access. */
export function insideWorkspace(path, roots, cwd) {
  if (typeof path !== "string" || !path.trim()) return false;
  const candidates = privateAliases(normalizePath(path, cwd));
  return candidates.some((full) => roots.some((root) => full === root || full.startsWith(`${root}/`)));
}

/** The files a call would change, when that is knowable from its input. */
export function targetPaths(toolName, input) {
  if (["Edit", "Write", "NotebookEdit", "MultiEdit"].includes(toolName)) {
    const path = input?.file_path ?? input?.notebook_path;
    return typeof path === "string" && path.trim() ? [path] : [];
  }
  if (toolName === "apply_patch" && typeof input?.patch === "string") {
    return [...input.patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
  }
  return [];
}

const unquote = (s) => s.replace(/^(["'])(.*)\1$/, "$2");
const DIR_ARG = `("[^"]+"|'[^']+'|[^\\s;&|]+)`;

/**
 * Directories a shell command works in: `cd <dir>` at the start of a part,
 * and `git -C <dir>`. Lexical; a path built from a variable is not guessed.
 */
export function commandDirs(command, cwd) {
  if (typeof command !== "string") return [];
  const parts = shellSegments(command);
  const dirs = [];
  for (const part of parts.length ? parts : [command]) {
    const cd = new RegExp(`^\\s*cd\\s+${DIR_ARG}`).exec(part);
    if (cd) dirs.push(cd[1]);
    for (const m of part.matchAll(new RegExp(`\\bgit\\s+-C\\s+${DIR_ARG}`, "g"))) dirs.push(m[1]);
  }
  return [...new Set(dirs.map(unquote).filter((d) => !d.includes("$")).map((d) => normalizePath(d, cwd)))];
}

export const changesOnlyInsideWorkspace = (call, roots) => {
  const targets = targetPaths(call.toolName, call.input);
  return targets.length > 0 && targets.every((path) => insideWorkspace(path, roots, call.cwd));
};

// Places the agent keeps for itself: its memory, and the session scratchpad
// Claude Code creates under the temp dir. Writing there is upkeep the agent
// is expected to do alongside any task, so the task is no measure of it.
const AGENT_OWNED = [
  /\/\.claude\/projects\/[^/]+\/memory(\/|$)/,
  /^(\/private)?\/tmp\/claude-\d+\/[^/]+\/[^/]+\/scratchpad(\/|$)/,
];

const agentOwned = (path, cwd) => AGENT_OWNED.some((re) => re.test(normalizePath(path, cwd)));

// Commands that only read or change local files named on their command line.
const LOCAL_FILE_COMMANDS = new Set([
  "cd", "sed", "awk", "cat", "head", "tail", "rg", "grep", "ls", "wc", "sort", "uniq",
  "cut", "tr", "echo", "printf", "mv", "cp", "rm", "mkdir", "touch", "jq", "diff", "test", "true",
]);
// An argument that names an absolute path: `~/…`, or `/` followed by a
// top-level directory. A sed address such as `/^## Open/` is not one.
const ABSOLUTE_PATH = /^(?:~(?:\/|$)|\/(?:Users|home|private|tmp|var|etc|opt|usr|Volumes|Library|System|Applications|bin|sbin|dev|root|srv|mnt|proc|sys)(?:\/|$))/;

/**
 * A shell command that starts by `cd`-ing into an agent-owned place and then
 * only runs local file tools on paths there: relative paths resolve inside it,
 * and every absolute path it names is agent-owned too.
 */
function shellOnlyAgentOwned(command, cwd) {
  // Substitution runs code; inside single quotes `$(` and backticks are text.
  if (typeof command !== "string" || /\$\(|`/.test(command.replace(/'[^']*'/g, "''"))) return false;
  const parts = shellSegments(command);
  const segments = parts.length ? parts : [command.trim()];
  if (!/^cd\s/.test(segments[0])) return false;
  const dirs = commandDirs(command, cwd);
  if (!dirs.length || !dirs.every((dir) => agentOwned(dir, cwd))) return false;
  for (const segment of segments) {
    for (const piece of pipelineParts(segment)) {
      const words = piece.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
      if (!LOCAL_FILE_COMMANDS.has(words[0])) return false;
      for (const word of words.slice(1)) {
        const arg = word.replace(/^[<>0-9&]*[<>]/, "").replace(/^(["'])([\s\S]*)\1$/, "$2");
        if (ABSOLUTE_PATH.test(arg) && !agentOwned(arg, cwd)) return false;
      }
    }
  }
  return true;
}

/** Does the call change only files in agent-owned places? Lexical. */
export const changesOnlyAgentOwned = (call) => {
  if (call.toolName === "Bash") return shellOnlyAgentOwned(call.input?.command, call.cwd);
  const targets = targetPaths(call.toolName, call.input);
  return targets.length > 0 && targets.every((path) => agentOwned(path, call.cwd));
};

// ── Local work in agent-owned places ─────────────────────────────────
//
// `underspecified_target` asks whether a call acts on something nobody
// identified. A scratch repo the agent builds for a test, the stub scripts
// it writes there and the files it creates are the agent's own choice, not
// a guess — yet on real sessions they drew that ask at 0.5-0.75, most of
// all when the command also carried prompts about vague targets. This is
// the wider cousin of changesOnlyAgentOwned for that one question: it also
// admits git, loops, functions and heredoc bodies, and it still hands every
// command that could reach a real target (a send, a push, an interpreter,
// an unknown executable) to the model.

// Commands that stay on this machine and act only on the paths they name.
const AGENT_LOCAL_COMMANDS = new Set([
  ...LOCAL_FILE_COMMANDS, "chmod", "ln", "tee", "set", "export", "unset", "command",
  "for", "while", "if", "then", "else", "fi", "do", "done", "{", "}", "[", "[[",
  // A nested agent: its own tool calls pass through its own hooks.
  "claude",
]);
// git subcommands that reach another machine or person.
const GIT_REMOTE = /^(push|send-email|request-pull|imap-send|svn|p4)$/;
// Before the first `cd`, only setting up the place to work in.
const SETUP_COMMANDS = new Set(["set", "export", "rm", "mkdir", "cd"]);

// Heredoc bodies are data for the command that reads them, which is still
// checked. Null when a heredoc is never closed.
function stripHeredocs(command) {
  const out = [];
  let end = null;
  for (const line of command.split("\n")) {
    if (end) { if (line.trim() === end) end = null; continue; }
    out.push(line);
    const m = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/.exec(line);
    if (m) end = m[2];
  }
  return end ? null : out.join("\n");
}

const expandVars = (text, vars) =>
  text.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m, name) => (name in vars ? vars[name] : m));

function shellOnlyAgentLocal(command, cwd) {
  if (typeof command !== "string") return false;
  const stripped = stripHeredocs(command);
  if (stripped === null) return false;
  // Substitution runs code; inside single quotes `$(` and backticks are text.
  if (/\$\(|`/.test(stripped.replace(/'[^']*'/g, "''"))) return false;

  const vars = {};
  const functions = new Set();
  let enteredOwned = false;
  const parts = shellSegments(stripped);
  for (const raw of parts.length ? parts : [stripped.trim()]) {
    const segment = expandVars(raw, vars).trim();
    // NAME=value on its own: remember it for later segments.
    const assign = /^([A-Za-z_]\w*)=(\S*)$/.exec(segment);
    if (assign && !/['"]/.test(assign[2])) { vars[assign[1]] = assign[2]; continue; }
    const fn = /^([A-Za-z_][\w-]*)\s*\(\)\s*\{?\s*(.*)$/.exec(segment);
    const body = fn ? fn[2] : segment;
    if (fn) functions.add(fn[1]);
    for (const piece of pipelineParts(body)) {
      const words = piece.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
      // Leading keywords and env assignments (`do git …`, `A=1 cmd`) are not the command.
      while (words.length && (/^(do|then|else|\{|\})$/.test(words[0]) || /^[A-Za-z_]\w*=/.test(words[0]))) words.shift();
      if (!words.length) continue;
      const [name, ...args] = words[0] === "command" ? words.slice(1) : words;
      if (!name) continue;
      if (!enteredOwned && !SETUP_COMMANDS.has(name)) return false;
      if (!AGENT_LOCAL_COMMANDS.has(name) && !functions.has(name) && name !== "git") return false;
      if (name === "git" && args.some((a) => GIT_REMOTE.test(a))) return false;
      if (name === "cd") {
        const dir = args[0]?.replace(/^(["'])(.*)\1$/, "$2");
        if (!dir || dir.includes("$") || !agentOwned(dir, cwd)) return false;
        enteredOwned = true;
        continue;
      }
      for (const word of args) {
        const arg = word.replace(/^[<>0-9&]*[<>]/, "").replace(/^(["'])([\s\S]*)\1$/, "$2").replace(/^--?[\w-]+=/, "");
        if (ABSOLUTE_PATH.test(arg) && !agentOwned(arg, cwd)) return false;
        // Before the first cd, setup may only name agent-owned absolute paths.
        if (!enteredOwned && name !== "set" && name !== "export" && !arg.startsWith("-") && !ABSOLUTE_PATH.test(arg)) return false;
      }
    }
  }
  return enteredOwned;
}

/**
 * Does the call work only in agent-owned places, with commands that cannot
 * reach a target outside them? Lexical; wider than changesOnlyAgentOwned.
 */
export const worksOnlyAgentLocal = (call) => {
  if (call.toolName === "Bash") return shellOnlyAgentLocal(call.input?.command, call.cwd);
  return changesOnlyAgentOwned(call);
};
