// The same tool call gets the same verdict on every host: each adapter only
// translates the event in and the envelope out. Runs the three hook entry
// points as subprocesses, with no key and no network.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = mkdtempSync(join(tmpdir(), "jev-parity-"));
spawnSync("git", ["init", "-q"], { cwd: repo });
writeFileSync(join(repo, ".env"), "X=1\n");
writeFileSync(join(repo, "a.txt"), "hello\n");

function run(bin, event) {
  const state = mkdtempSync(join(tmpdir(), "jev-parity-state-"));
  const env = { ...process.env, JEV_STATE_DIR: state };
  delete env.TYPESAFE_API_KEY;
  const r = spawnSync(process.execPath, [join(ROOT, "bin", bin)], { input: JSON.stringify(event), env, encoding: "utf8", cwd: repo });
  const logPath = join(state, "jev-log.jsonl");
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, log };
}

/** Reduce a Claude Code / Codex response to {decision, reason}. */
function fromHookSpecific(out) {
  const h = out?.hookSpecificOutput;
  if (h?.permissionDecision && h.permissionDecision !== "allow") return { decision: h.permissionDecision, reason: h.permissionDecisionReason };
  return { decision: h?.updatedInput ? "rewrite" : "none" };
}

/** Reduce an Antigravity response to {decision, reason}. */
function fromAntigravity(out) {
  if (out?.overwrite) return { decision: "rewrite" };
  if (out?.decision === "deny" || out?.decision === "ask") return { decision: out.decision, reason: out.reason };
  return { decision: "none" };
}

const pre = (tool_name, tool_input) => ({ hook_event_name: "PreToolUse", session_id: "s", cwd: repo, tool_name, tool_input });
const agy = (name, args) => ({ toolCall: { name, args }, workspacePaths: [repo], conversationId: "c" });
const shell = (command) => ({
  claude: pre("Bash", { command }),
  codex: pre("Bash", { command }),
  agy: agy("run_command", { CommandLine: command, Cwd: repo }),
});

const CASES = [
  { name: "catastrophic command", expect: "ask", ...shell("rm -rf /") },
  { name: "force push to main", expect: "ask", ...shell("git push --force origin main") },
  { name: "bloated output", expect: "rewrite", ...shell("npm test") },
  { name: "short inspection", expect: "none", logReason: "read-only shell command: deterministic checks only", ...shell("git status") },
  { name: "file write by redirect", expect: "none", ...shell("echo hi > a.txt") },
  {
    name: "read of a credential file",
    expect: "ask",
    claude: pre("Read", { file_path: join(repo, ".env") }),
    codex: pre("Read", { file_path: join(repo, ".env") }),
    agy: agy("view_file", { AbsolutePath: join(repo, ".env") }),
  },
  {
    name: "edit whose text is not in the file",
    expect: "deny",
    claude: pre("Edit", { file_path: join(repo, "a.txt"), old_string: "nope", new_string: "x" }),
    codex: pre("Edit", { file_path: join(repo, "a.txt"), old_string: "nope", new_string: "x" }),
    agy: agy("replace_file_content", { TargetFile: join(repo, "a.txt"), TargetContent: "nope", ReplacementContent: "x" }),
  },
  {
    name: "new file",
    expect: "none",
    claude: pre("Write", { file_path: join(repo, "b.txt"), content: "x" }),
    codex: pre("Write", { file_path: join(repo, "b.txt"), content: "x" }),
    agy: agy("write_to_file", { TargetFile: join(repo, "b.txt"), CodeContent: "x" }),
  },
];

for (const c of CASES) {
  test(`parity: ${c.name}`, () => {
    const results = {
      claude: run("jev-hook.mjs", c.claude),
      codex: run("jev-hook-codex.mjs", c.codex),
      agy: run("jev-hook-antigravity.mjs", c.agy),
    };
    const verdicts = {
      claude: fromHookSpecific(results.claude.out),
      codex: fromHookSpecific(results.codex.out),
      agy: fromAntigravity(results.agy.out),
    };
    for (const [host, r] of Object.entries(results)) {
      assert.equal(r.status, 0, `${host} exits 0`);
      assert.equal(verdicts[host].decision, c.expect, `${host} decision`);
      const records = r.log.filter((e) => e.hook === "PreToolUse");
      assert.equal(records.length, 1, `${host} logs one PreToolUse record`);
      if (c.expect === "ask" || c.expect === "deny") assert.equal(records[0].decision, c.expect, `${host} log decision`);
    }
    assert.equal(verdicts.codex.reason, verdicts.claude.reason, "codex reason matches claude");
    // The log keeps the guard's reason; slimming records its own as wrap_reason.
    const logReasons = Object.fromEntries(Object.entries(results).map(([host, r]) => [host, r.log.find((e) => e.hook === "PreToolUse")?.reason]));
    assert.equal(logReasons.codex, logReasons.claude, "codex log reason matches claude");
    assert.equal(logReasons.agy, logReasons.claude, "agy log reason matches claude");
    if (c.logReason) assert.equal(logReasons.claude, c.logReason);
    assert.equal(verdicts.agy.reason, verdicts.claude.reason, "agy reason matches claude");
  });
}

test("codex: an argv-shaped shell command is slimmed; a bare argv vector is not", () => {
  assert.equal(fromHookSpecific(run("jev-hook-codex.mjs", pre("Bash", { command: ["bash", "-lc", "npm test"] })).out).decision, "rewrite");
  assert.equal(fromHookSpecific(run("jev-hook-codex.mjs", pre("Bash", { command: ["ls", "-la"] })).out).decision, "none");
});
