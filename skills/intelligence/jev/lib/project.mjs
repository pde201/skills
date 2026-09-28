// ──────────────────────────────────────────────────────────────────────
//  The project a call runs in.
//
// Judging intent and scope from the command alone misses what the
// repository itself says. A `git push` is routine where the project's
// rules say work lands on main by pushing, and `gh … --repo <origin>` is
// this project's own remote, not somewhere else.
// ──────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { commandDirs, normalizePath } from "./workspace.mjs";
import config from "./config.mjs";

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
