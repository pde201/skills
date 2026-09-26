// ──────────────────────────────────────────────────────────────────────
//  Catch tool calls that are about to go wrong, before they run.
//
//  Two layers, in this order:
//
//    1. Code, for everything that is knowable. Does the file exist? Is the
//       string being replaced actually in it? Is this `rm -rf /`? These are
//       lookups and rules, not judgments, and a model should never be asked
//       a question that `existsSync` already answers.
//
//    2. Jev, for the rest. Whether a command matches what was actually
//       asked for, whether it is the same thing that just failed, whether
//       it destroys something nobody asked to destroy — these need semantic
//       understanding of the session, and no amount of pattern matching
//       gets there.
//
//  Fails open: no key, no network, bad response — the call proceeds.
// ──────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { systemOne, nouls, pickScore, costUsd, haveKey } from "./client.mjs";
import { looksLikeSecretFile } from "./privacy.mjs";
import { shellSegments, pipelineParts, readOnlyCommand, namesSecretFile } from "./shell.mjs";
import { callSignature } from "./transcript.mjs";
import { ALLOW, ASK, DENY, HAZARDS, BLAST_RADIUS_QUESTION, PHRASING } from "./guard-questions.mjs";
import config from "./config.mjs";

export { ALLOW, ASK, DENY, shellSegments };

// Precedence when several signals fire at once: the strictest wins.
const PRECEDENCE = [DENY, ASK, ALLOW];
const strictest = (decisions) => PRECEDENCE.find((d) => decisions.includes(d)) ?? ALLOW;

// ── Layer 1: deterministic ───────────────────────────────────────────

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

/**
 * Checks that need no judgment at all. Returns a decision, or null to hand
 * the call on to Jev.
 */
export function deterministicCheck(toolName, input, cwd) {
  if (toolName === "Edit") {
    const path = input?.file_path;
    if (typeof path === "string" && typeof input?.old_string === "string") {
      if (!existsSync(path)) {
        return { decision: DENY, reason: `${path} does not exist, so there is nothing to edit.`, by: "code" };
      }
      let body;
      try {
        body = readFileSync(path, "utf8");
      } catch (err) {
        return { decision: ASK, reason: `${path} could not be read: ${err.code ?? err.message}`, by: "code" };
      }
      if (input.old_string && !body.includes(input.old_string)) {
        return {
          decision: DENY,
          reason: `The text to replace does not appear in ${path}. Re-read the file and match its current contents exactly.`,
          by: "code",
        };
      }
      if (input.old_string && !input.replace_all) {
        const count = body.split(input.old_string).length - 1;
        if (count > 1) {
          return {
            decision: DENY,
            reason: `That text appears ${count} times in ${path}. Include more surrounding context to make it unique, or set replace_all.`,
            by: "code",
          };
        }
      }
    }
  }

  if (toolName === "Read" && typeof input?.file_path === "string") {
    const path = input.file_path;
    if (!existsSync(path)) {
      return { decision: DENY, reason: `${path} does not exist.`, by: "code" };
    }
    try {
      if (statSync(path).isDirectory()) {
        return { decision: DENY, reason: `${path} is a directory, not a file. Use a listing or glob instead.`, by: "code" };
      }
    } catch {
      // Raced with something else; let it through and let the tool report.
    }
  }

  if (toolName === "Bash" && typeof input?.command === "string") {
    for (const { re, why } of CATASTROPHIC) {
      if (re.test(input.command)) {
        return { decision: ASK, reason: `This ${why}. Confirm before it runs.`, by: "code" };
      }
    }
    if (hasUnguardedWorktreeCleanup(input.command)) {
      return {
        decision: ASK,
        reason: "A `;` before `git checkout/restore --` lets cleanup run even if earlier checks fail. The checkout can discard changes before the worktree is removed. Confirm this cleanup or connect verification and cleanup with `&&`.",
        by: "code",
      };
    }
  }

  return null;
}

// ── Layer 2: judgment ────────────────────────────────────────────────

// ── Which questions are worth asking ─────────────────────────────────

/** Every string value in a tool input, flattened for a text check. */
const inputText = (input) => {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  return Object.values(input).filter((v) => typeof v === "string").join(" ");
};

/**
 * Does this call name something path-shaped at all?
 *
 * `invented_target` asks whether the call "appears to have invented the
 * path it names". Put to a call that names no path — `npm ci`, `git
 * status`, `make` — the question presupposes something that is not there,
 * and an unanswerable question does not come back as a confident no. It
 * comes back near the middle.
 *
 * Observed live on 2026-09-21: `npm ci` scored 0.51, which clears the 0.45
 * ask threshold and interrupts the user over a path the command never
 * mentioned. No threshold fixes that — 0.51 sits below real detections
 * (0.56-0.77) but above conventional ones, so there is nowhere to put the
 * line. The question simply should not have been asked.
 *
 * This is the same lesson as the original `invented_target` rewording, one
 * step earlier: before asking whether a question is worded right, ask
 * whether it applies.
 */
export function namesAPath(input) {
  const text = inputText(input);
  if (!text) return false;
  // A slash, or a bare filename with a letter-initial extension. Digits
  // after the dot are excluded so version and image tags (`ubuntu:20.04`)
  // do not read as filenames.
  return /\//.test(text) || /\b[\w.\-@+]+\.[A-Za-z]\w{0,7}\b/.test(text);
}

// ── The workspace ────────────────────────────────────────────────────
//
// `wrong_scope` used to be judged against `cwd` alone, which reads a
// sibling checkout, a scratch directory or a skill under ~/.claude as
// "outside the project" even when the session has been working there all
// along. The workspace is wider than the cwd, and it is knowable.

const expandHome = (p) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);
const normalizePath = (p, cwd) => resolve(cwd || process.cwd(), expandHome(String(p).trim())).replace(/\/+$/, "") || "/";

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

// ── The project ──────────────────────────────────────────────────────
//
// Judging intent and scope from the command alone misses what the
// repository itself says. A `git push` is routine where the project's
// rules say work lands on main by pushing, and `gh … --repo <origin>` is
// this project's own remote, not somewhere else.

const git = (cwd, args) => {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

/** `owner/name` for a GitHub-style remote URL, else the URL itself. */
export function remoteSlug(url) {
  const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url ?? "");
  return match ? match[1] : url;
}

// Lines from a policy file worth showing a judgment about intent: the ones
// that say how work is committed, branched, reviewed and published.
const POLICY_LINE = /\b(push(?:es|ed)?|commit(?:s|ted)?|branch(?:es)?|pull requests?|PRs?|merge|main|master|worktrees?|rebase|release|deploy)\b/i;

/** The repository's own workflow rules, trimmed to what bears on git. */
export function policyExcerpt(text, maxChars = 900) {
  if (typeof text !== "string") return "";
  // Rules are prose; commands inside fenced examples are not rules.
  let fenced = false;
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => {
    if (l.startsWith("```")) { fenced = !fenced; return false; }
    return !fenced && l && POLICY_LINE.test(l);
  });
  let out = "";
  for (const line of lines) {
    const next = out ? `${out}\n${line}` : line;
    if (next.length > maxChars) break;
    out = next;
  }
  return out;
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

/**
 * Directories this call and the session's successful calls work in. A repo
 * the session already pushed to from another cwd is the task's project too.
 */
export function sessionRepoDirs(call, recentCalls, userCommands = []) {
  const dirs = call?.toolName === "Bash" ? commandDirs(call.input?.command, call.cwd) : [];
  for (const recent of recentCalls ?? []) {
    if (recent?.failed || typeof recent?.input !== "string") continue;
    dirs.push(...commandDirs(recent.input, call?.cwd));
  }
  for (const command of userCommands ?? []) dirs.push(...commandDirs(command, call?.cwd));
  return [...new Set(dirs)];
}

const remotesOf = (top) => [...new Set(git(top, ["remote", "-v"]).split("\n")
  .map((line) => line.split(/\s+/))
  .filter(([name, url]) => name && url)
  .map(([name, url]) => `${name} ${remoteSlug(url)}`))];

const MAX_OTHER_REPOS = 4;

function policyOf(top) {
  const files = config.policyFiles.length
    ? config.policyFiles.map((f) => normalizePath(f, top))
    : ["AGENTS.md", "CLAUDE.md"].map((f) => join(top, f));
  for (const file of files) {
    let policy = "";
    try {
      policy = policyExcerpt(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (policy) return policy;
  }
  return "";
}

/**
 * The project the call runs in: its remotes and the workflow rules its own
 * agent instructions state, plus the remotes of other repositories in
 * `otherDirs` (labelled with their path). The rules come from the repository
 * `policyFrom` lies in when it is one — a push in another repository answers
 * to that repository's rules, not the session's — else from the cwd's. Every
 * part fails soft to empty — this only adds context, and a hook must never
 * fail because git or a file is missing.
 */
export function projectContext(cwd, otherDirs = [], policyFrom) {
  const base = cwd || process.cwd();
  const top = git(base, ["rev-parse", "--show-toplevel"]);
  const others = [];
  for (const dir of otherDirs) {
    if (others.length >= MAX_OTHER_REPOS) break;
    const other = git(dir, ["rev-parse", "--show-toplevel"]);
    if (other && other !== top && !others.includes(other)) others.push(other);
  }
  const otherRemotes = others.flatMap((other) => remotesOf(other).map((remote) => `${remote} (${other})`));
  const policyTop = (policyFrom && git(policyFrom, ["rev-parse", "--show-toplevel"])) || top;
  return {
    remotes: top ? [...remotesOf(top), ...otherRemotes] : otherRemotes,
    policy: policyTop ? policyOf(policyTop) : "",
  };
}

/** projectContext for one call: remotes the session works with, rules of the repo the call works in. */
export function callProject(call, recentCalls, userCommands) {
  const workDir = call.toolName === "Bash" ? commandDirs(call.input?.command, call.cwd)[0] : undefined;
  return projectContext(call.cwd, sessionRepoDirs(call, recentCalls, userCommands), workDir);
}

const changesOnlyInsideWorkspace = (call, roots) => {
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

/**
 * Is the newest earlier run of this same call a failure? A failure the user
 * has since answered with a new message is not a blind retry: the human turn
 * is the "change that would fix the cause".
 */
function retriesAFailure(call, recentCalls) {
  const signature = callSignature(call.toolName, call.input);
  const lastSameCall = [...(recentCalls ?? [])].reverse().find((recent) => {
    if (recent?.tool !== call.toolName) return false;
    if (recent.signature) return recent.signature === signature;
    // Synthetic and legacy callers may only supply an untruncated Bash command.
    return call.toolName === "Bash" && recent.input === call.input?.command;
  });
  return lastSameCall?.failed === true && !lastSameCall.beforeUserTurn;
}

/** Does the call change only files in agent-owned places? Lexical. */
export const changesOnlyAgentOwned = (call) => {
  if (call.toolName === "Bash") return shellOnlyAgentOwned(call.input?.command, call.cwd);
  const targets = targetPaths(call.toolName, call.input);
  return targets.length > 0 && targets.every((path) => agentOwned(path, call.cwd));
};

/**
 * The batch for one call. Questions that do not apply to it are left out
 * rather than asked and filtered afterwards: a question that cannot apply
 * has no right answer to threshold against.
 *
 * Omitting one changes no other answer — questions batched over a single
 * state are scored independently — so this only removes noise.
 *
 * @param {{toolName?: string, input?: any, cwd?: string}} [call] omit to get every question
 * @param {string[]} [roots] the workspace, from workspaceRoots(); omit to always ask about scope
 * @param {object[]} [recentCalls] recent calls with failure status
 */
export function guardQuestions(call, roots, recentCalls) {
  const questions = { blast_radius: BLAST_RADIUS_QUESTION };
  for (const [id, { question, needsPath, needsOutsideWorkspace }] of Object.entries(HAZARDS)) {
    if (id === "repeat_failure" && call && !retriesAFailure(call, recentCalls)) continue;
    if (needsPath && call && !namesAPath(call.input)) continue;
    if (needsOutsideWorkspace && call && roots && changesOnlyInsideWorkspace(call, roots)) continue;
    if (id === "intent_mismatch" && call && changesOnlyAgentOwned(call)) continue;
    questions[id] = question;
  }
  return questions;
}

// Below this reach the call changes nothing — it only looks.
const CHANGES_SOMETHING = 1;

// Hazards whose borderline judgments become advice rather than prompts.
const SOFTENABLE = new Set(["intent_mismatch", "wrong_scope", "invented_target", "repeat_failure"]);

/**
 * Probabilities and reach in, a decision out. Pure and exported so the
 * thresholds can be tested offline: this is the part that a live run was
 * previously the only way to exercise, which is how a false positive got
 * as far as it did.
 *
 * @returns {{decision: string, fired: Record<string, number>}}
 */
export function decide(probabilities, radius) {
  const triggered = [];
  const fired = {};

  for (const [hazard, probability] of Object.entries(probabilities)) {
    const { action, actsOnRead } = HAZARDS[hazard] ?? {};
    if (!action) continue;
    let level = null;
    if (probability >= config.guardDenyAt) level = action;
    else if (probability >= config.guardAskAt) level = ASK;
    if (!level) continue;
    triggered.push({ hazard, level, actsOnRead: Boolean(actsOnRead) });
    fired[hazard] = probability;
  }

  // A call that changes nothing is cheap to be wrong about. A read of the
  // wrong file, or of a path that was guessed, fails or wastes a few
  // tokens and the model corrects itself without anyone being asked. The
  // cost of prompting anyway is not the one prompt: it is that being
  // interrupted over things that did not matter teaches you to wave
  // through the one that does.
  //
  // So on a read-only call, only hazards marked `actsOnRead` speak, and
  // there are exactly two reasons to earn that mark:
  //
  //   · the damage is done by reading — `secret_exposure`, because a
  //     printed key has already been printed by the time a prompt could
  //     be answered; and
  //   · the hazard is itself evidence that the premise above is false —
  //     `repeat_failure`, because a call repeating one that just failed
  //     is the model not correcting itself.
  //
  // The rest cannot honestly fire on a read at all — a call that changes
  // nothing has destroyed nothing, and reading outside the project is
  // explicitly not `wrong_scope` — so suppressing them removes false
  // positives rather than coverage.
  //
  // This gate only ever sees calls that reached the judgment layer. The
  // deterministic checks run first and return early, so `rm -rf /`, a
  // force push and the rest of CATASTROPHIC still ask no matter what
  // reach Jev assigned.
  if ((radius?.score ?? 0) < CHANGES_SOMETHING) {
    const speaking = triggered.filter((t) => t.actsOnRead);

    // Allowed — but hand back what was set aside rather than dropping it.
    // A hazard suppressed silently is a hazard nobody can tune: the log is
    // the only trace of a judgment that never became a prompt, and a
    // suppression that turns out to be wrong is invisible without it.
    if (!speaking.length) return { decision: ALLOW, fired: {}, suppressed: { ...fired } };

    const kept = {};
    const setAside = {};
    for (const [hazard, probability] of Object.entries(fired)) {
      if (speaking.some((t) => t.hazard === hazard)) kept[hazard] = probability;
      else setAside[hazard] = probability;
    }
    return {
      decision: strictest(speaking.map((t) => t.level)),
      fired: kept,
      ...(Object.keys(setAside).length ? { suppressed: setAside } : {}),
    };
  }

  // Reach is a multiplier, not a hazard of its own: something already
  // suspicious that also touches shared state is not a question to wave
  // through, but a wide-reaching call that trips nothing is just a deploy.
  const wideReaching = (radius?.score ?? 0) >= config.guardBlastRadiusBlock;

  // Just over the ask line, a judgment is a lean, not a finding: two thirds
  // of asks on real sessions sat below 0.60, and most were the task itself.
  // An ask there costs a prompt — and in auto mode, where asks become
  // refusals, a blocked step. So a borderline call on hazards that cannot
  // lose work goes through with the concern handed to the model instead.
  // Never for destruction or exposure, and never for wide-reaching calls.
  const soft = triggered.length > 0 && !wideReaching && triggered.every((t) =>
    t.level === ASK && SOFTENABLE.has(t.hazard) && fired[t.hazard] < config.guardSoftUntil);
  if (soft) return { decision: ALLOW, fired: {}, advisory: { ...fired } };
  const levels = triggered.map((t) => t.level);
  const decision = wideReaching && levels.length
    ? strictest(levels.map((d) => (d === ASK ? DENY : d)))
    : strictest(levels);

  return { decision, fired };
}

/**
 * @returns {Promise<{decision: string, reason: string, by: string, signals?: object, cost?: number}>}
 */
export async function guard({ toolName, input, cwd, task, recentCalls, recentUserActions, userCommands, observed, hostRoots, writtenDirs, model } = {}) {
  const pass = (reason) => ({ decision: ALLOW, reason, by: "code" });
  const promptLabel = (decision, source) =>
    `Jev ${decision === ASK ? "approval request" : "blocked call"} (${source}):`;

  const deterministic = deterministicCheck(toolName, input, cwd);
  if (deterministic) return { ...deterministic, reason: `${promptLabel(deterministic.decision, "local check")} ${deterministic.reason}` };

  if (!config.guard) return pass("guard disabled");

  // A Read changes nothing, and the read-only gate below would suppress
  // every hazard but two anyway. The one that lands on read — exposing a
  // credential — is a fact about the path, so code asks it: a model round
  // trip on every file the agent looks at bought nothing on real sessions
  // (26 of 26 allowed) and cost ~300 ms each.
  if (toolName === "Read" && !config.guardReadsWithModel) {
    const path = input?.file_path;
    if (looksLikeSecretFile(path)) {
      return { decision: ASK, reason: `${promptLabel(ASK, "local check")} ${path} usually holds credentials. Confirm before it is read.`, by: "code" };
    }
    return pass("read-only tool: deterministic checks only");
  }

  // The same trade for a shell command that only reads, as long as neither
  // hazard that speaks on a read could: a credential file sends it to the
  // model, and so does a rerun of the same command that just failed.
  if (toolName === "Bash" && !config.guardReadsWithModel && readOnlyCommand(input?.command)
    && !namesSecretFile(input.command) && !retriesAFailure({ toolName, input }, recentCalls)) {
    return pass("read-only shell command: deterministic checks only");
  }

  if (!haveKey()) return pass("no api key");

  const agentMemoryDirs = (observed ?? [])
    .map((path) => typeof path === "string" ? path.match(/^(.*\/\.claude\/projects\/[^/]+\/memory)(?:\/.*)?$/)?.[1] : null)
    .filter(Boolean);
  const roots = workspaceRoots({ cwd, hostRoots, writtenDirs: [...(writtenDirs ?? []), ...agentMemoryDirs] });
  const questions = guardQuestions({ toolName, input, cwd }, roots, recentCalls);
  // A question that was never asked is not a hazard that stayed quiet, and
  // the log has to be able to tell those apart — otherwise a question this
  // gate has silently stopped asking looks exactly like one that is asking
  // and finding nothing.
  const skippedQuestions = Object.keys(HAZARDS).filter((id) => !(id in questions));

  const project = callProject({ toolName, input, cwd }, recentCalls, userCommands);
  const segments = toolName === "Bash" ? shellSegments(input?.command) : [];

  let res;
  try {
    res = await systemOne({
      model: model ?? config.model,
      state: {
        task: task || "(not stated)",
        cwd: cwd || process.cwd(),
        workspace_roots: roots,
        ...(project.remotes.length ? { project_remotes: project.remotes } : {}),
        ...(project.policy ? { project_policy: project.policy } : {}),
        call: { tool: toolName, input },
        ...(segments.length ? { call_segments: segments } : {}),
        recent_calls: (recentCalls ?? []).map(({ signature: _signature, paths: _paths, beforeUserTurn: _turn, ...recent }) => recent),
        recent_user_actions: recentUserActions ?? [],
        paths_seen_this_session: observed ?? [],
      },
      questions,
    });
  } catch (err) {
    return pass(`jev unavailable: ${err.message}`);
  }

  const probabilities = nouls(res, Object.keys(HAZARDS));
  const radius = pickScore(res, "blast_radius");
  const { decision, fired, suppressed, advisory } = decide(probabilities, radius);
  const hasAdvisory = advisory && Object.keys(advisory).length > 0;

  return {
    decision,
    reason: decision === ALLOW ? "" : `${promptLabel(decision, "model estimate")} ${explain(fired, radius, decision)}`,
    // A borderline concern that did not become a prompt, worded for the
    // model: it proceeds, but should check the step against the request.
    ...(hasAdvisory ? { advisory: `Jev note (borderline, not blocked): ${explain(advisory, radius, ASK)} If this step is not what the user asked for, stop and check with them.` } : {}),
    by: "jev",
    // Everything Jev said, including what fell below the thresholds. The
    // signals below carry only what fired, which is right for explaining a
    // decision to someone and wrong for tuning: a log that records only
    // what crossed the line can justify raising a threshold and can never
    // justify lowering one, so a hazard that is quietly missing everything
    // stays missing.
    probabilities,
    signals: {
      ...fired,
      ...(suppressed && Object.keys(suppressed).length ? { suppressed } : {}),
      ...(hasAdvisory ? { advisory } : {}),
      ...(skippedQuestions.length ? { not_asked: skippedQuestions } : {}),
      blast_radius: radius?.score,
      blast_radius_label: radius?.legend?.[String(Math.round(radius?.score ?? 0))],
    },
    usage: res.usage,
    cost: costUsd(res.usage),
  };
}

function explain(fired, radius, decision) {
  if (decision === ALLOW) return "";
  const parts = Object.entries(fired)
    .sort((a, b) => b[1] - a[1])
    .map(([hazard, p]) => `${PHRASING[hazard]} (${p.toFixed(2)})`);
  const reach = radius?.legend?.[String(Math.round(radius.score))];
  const tail = reach ? ` Reach: ${reach.toLowerCase()}.` : "";
  return `This call ${parts.join("; ")}.${tail}`;
}
