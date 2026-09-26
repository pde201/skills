// Read-only shell commands skip the model; anything that writes, runs code,
// names a credential file or repeats a failure still reaches it.
// No key is set, so a call that reaches the model layer passes as "no api key".
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.JEV_STATE_DIR = mkdtempSync(join(tmpdir(), "jev-readonly-"));
delete process.env.TYPESAFE_API_KEY;
delete process.env.JEV_GUARD_READ_MODEL;

const { readOnlyCommand } = await import("../lib/shell.mjs");
const { guard } = await import("../lib/guard.mjs");

const READS = [
  "git status --short",
  "git -C ../other log --oneline -5",
  "git --no-pager diff HEAD~1 -- lib/",
  "git branch --show-current",
  "git stash list",
  "git worktree list",
  "git config --get user.email",
  "git remote -v",
  "cd lib && rg -n 'foo|bar' guard.mjs | head -20",
  "sed -n '1,80p' lib/guard.mjs",
  "sed -n '/^## Open/,/^## /p' notes.md",
  "find . -name '*.mjs' -newer package.json 2>/dev/null",
  "awk '{print $1}' data.txt | sort | uniq -c",
  "jq '.scripts' package.json",
  "gh run view 123 --log-failed",
  "gh pr list --state open --json number,title",
  "gh api repos/o/r/pulls --jq '.[].number'",
  "ls -la ~/work && wc -l *.mjs",
  "cat README.md 2>&1 | tail -5",
];

const NOT_READS = [
  "echo $GITHUB_TOKEN",
  "env",
  "printenv HOME",
  "cat $(git rev-parse --show-toplevel)/x",
  "rg foo > out.txt",
  "ls | tee listing.txt",
  "sed -i '' 's/a/b/' f.txt",
  "sed -n 's/a/b/w out.txt' f.txt",
  "awk '{print > \"out\"}' f.txt",
  "awk 'BEGIN{system(\"rm x\")}'",
  "find . -name '*.tmp' -delete",
  "find . -exec rm {} ;",
  "sort -o sorted.txt f.txt",
  "uniq in.txt out.txt",
  "rg --pre ./run.sh foo",
  "git -c core.pager=sh log",
  "git branch new-feature",
  "git branch -D old",
  "git stash",
  "git tag v1.0",
  "git remote add up https://x",
  "git config --list",
  "git config --get credential.helper",
  "git diff --output=patch.diff",
  "git fetch origin",
  "git push origin main",
  "gh auth token",
  "gh auth status --show-token",
  "gh api repos/o/r/issues -f title=x",
  "gh api -X POST repos/o/r/labels",
  "gh pr create --fill",
  "GIT_EXTERNAL_DIFF=./x git diff",
  "cat <<EOF\nx\nEOF",
  "diff <(ls a) <(ls b)",
  "sleep 5 &",
  "npm test",
  "xargs rm < files.txt",
  "sed -ni 's/a/b/' f",
  "sed -Ei 's/a/b/' f",
  "sort -ro out f",
  "fd -xrm",
  "fd --exec=rm x",
  "sed '1w out' f",
  "sed -n '$w out' f",
  "sed \"1w out\" f",
  "sed 's/a/b/e' f",
  "awk -f prog.awk f",
  "awk 'BEGIN{print ENVIRON[\"GITHUB_TOKEN\"]}'",
  "jq -n 'env.GITHUB_TOKEN'",
  "jq -n '$ENV.GITHUB_TOKEN'",
  "jq -f prog.jq f.json",
  "gh auth status -t",
  "echo \"don't $TOKEN\" 'x'",
];

test("read-only commands are recognised", () => {
  for (const command of READS) assert.equal(readOnlyCommand(command), true, command);
});

test("writes, code execution, expansion and secrets-by-command are not", () => {
  for (const command of NOT_READS) assert.equal(readOnlyCommand(command), false, command);
});

test("a read-only shell command skips the model", async () => {
  const verdict = await guard({ toolName: "Bash", input: { command: "git status --short" }, cwd: process.cwd(), task: "x" });
  assert.equal(verdict.decision, "allow");
  assert.equal(verdict.reason, "read-only shell command: deterministic checks only");
});

test("a read-only command naming a credential file still reaches the model", async () => {
  const verdict = await guard({ toolName: "Bash", input: { command: "cat ~/.aws/credentials" }, cwd: process.cwd(), task: "x" });
  assert.equal(verdict.reason, "no api key");
});

test("reads of files that may hold credentials still reach the model", async () => {
  for (const command of ["cat ~/.pgpass", "grep DSN ~/.zshenv", "jq . ~/.claude/settings.json", "cat ~/.config/gh/hosts.yml"]) {
    const verdict = await guard({ toolName: "Bash", input: { command }, cwd: process.cwd(), task: "x" });
    assert.equal(verdict.reason, "no api key", command);
  }
});

test("credential stores ask before the Read tool opens them", async () => {
  const home = mkdtempSync(join(tmpdir(), "jev-creds-"));
  mkdirSync(join(home, ".config/gh"), { recursive: true });
  const files = [join(home, ".pgpass"), join(home, ".config/gh/hosts.yml")];
  for (const file of files) writeFileSync(file, "x\n");
  for (const file_path of files) {
    const verdict = await guard({ toolName: "Read", input: { file_path }, cwd: process.cwd(), task: "x" });
    assert.equal(verdict.decision, "ask", file_path);
  }
});

test("rerunning a read that just failed still reaches the model", async () => {
  const command = "rg -n foo missing.txt";
  const recentCalls = [{ tool: "Bash", input: command, failed: true }];
  const verdict = await guard({ toolName: "Bash", input: { command }, cwd: process.cwd(), task: "x", recentCalls });
  assert.equal(verdict.reason, "no api key");
});

test("a failure the user has answered since is not a blind retry", async () => {
  const command = "rg -n foo missing.txt";
  const recentCalls = [{ tool: "Bash", input: command, failed: true, beforeUserTurn: true }];
  const verdict = await guard({ toolName: "Bash", input: { command }, cwd: process.cwd(), task: "x", recentCalls });
  assert.equal(verdict.reason, "read-only shell command: deterministic checks only");
});

