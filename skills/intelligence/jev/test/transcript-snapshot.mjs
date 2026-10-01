import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  activeTaskContext,
  createTranscriptSnapshot,
  latestUserRequest,
  observedPaths,
  recentToolCalls,
  recentUserActions,
  transcriptContext,
  transcriptPathFor,
  writtenDirs,
} from "../lib/transcript.mjs";

function fixture(entries) {
  const dir = mkdtempSync(join(tmpdir(), "jev-transcript-snapshot-"));
  const path = join(dir, "transcript.jsonl");
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  return { dir, path };
}

function withoutSnapshot({ snapshot: _snapshot, ...context }) {
  return context;
}

test("a snapshot derives the same task, call, action, and path views as direct reads", () => {
  const { dir, path } = fixture([
    {
      type: "user",
      message: { role: "user", content: "Fix the parser and keep the public API unchanged." },
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/workspace/src/parser.mjs" } }],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "read-1", content: [{ type: "text", text: "source" }] }],
      },
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "write-1", name: "Write", input: { file_path: "/workspace/src/parser.mjs", content: "fixed" } }],
      },
    },
    {
      type: "user",
      origin: { kind: "human" },
      message: {
        role: "user",
        content: [
          { type: "text", text: "<bash-input>git push origin codex/parser</bash-input><bash-stdout>abc123..def456  HEAD -> codex/parser</bash-stdout>" },
        ],
      },
    },
    {
      type: "user",
      message: { role: "user", content: "Continue." },
    },
  ]);

  try {
    const snapshot = createTranscriptSnapshot(path);
    const direct = transcriptContext(path);
    const fromSnapshot = transcriptContext(snapshot);

    assert.deepEqual(withoutSnapshot(fromSnapshot), withoutSnapshot(direct));
    assert.equal(activeTaskContext(snapshot), activeTaskContext(path));
    assert.equal(latestUserRequest(snapshot), latestUserRequest(path));
    assert.deepEqual(recentToolCalls(snapshot, { limit: 400 }), recentToolCalls(path, { limit: 400 }));
    assert.deepEqual(recentUserActions(snapshot), recentUserActions(path));
    assert.deepEqual(observedPaths(snapshot), observedPaths(path));
    assert.deepEqual(writtenDirs(snapshot), writtenDirs(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a snapshot is stable after the transcript advances", () => {
  const { dir, path } = fixture([{ type: "user", message: { role: "user", content: "Keep the first request." } }]);
  try {
    const snapshot = createTranscriptSnapshot(path);
    writeFileSync(path, JSON.stringify({ type: "user", message: { role: "user", content: "Use the replacement request." } }));

    assert.equal(latestUserRequest(snapshot), "Keep the first request.");
    assert.equal(latestUserRequest(path), "Use the replacement request.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a subagent's call reads the subagent's own transcript, not the parent's", () => {
  const { dir, path } = fixture([{ type: "user", message: { role: "user", content: "Run it with a general-purpose agent." } }]);
  const sessionId = "d042968f-c433-45fc-a8c1-27f62c8573d5";
  const subagentDir = join(dir, sessionId, "subagents");
  mkdirSync(subagentDir, { recursive: true });
  const subagentPath = join(subagentDir, "agent-ae49b99f4b7bf9b44.jsonl");
  writeFileSync(subagentPath, JSON.stringify({
    type: "user",
    isSidechain: true,
    message: { role: "user", content: "Implement issue #7: the upload and image quality gate." },
  }));
  const event = { transcript_path: path, session_id: sessionId, agent_id: "ae49b99f4b7bf9b44" };

  try {
    assert.equal(transcriptPathFor(event), subagentPath);
    assert.equal(latestUserRequest(transcriptPathFor(event)), "Implement issue #7: the upload and image quality gate.");
    // The main session, a subagent with no transcript yet, and an id that
    // would escape the directory all keep the parent transcript.
    assert.equal(transcriptPathFor({ transcript_path: path, session_id: sessionId }), path);
    assert.equal(transcriptPathFor({ ...event, agent_id: "missing" }), path);
    assert.equal(transcriptPathFor({ ...event, agent_id: "../../x" }), path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("large tool-result traces associate failures without quadratic lookup", () => {
  const entries = [];
  const callCount = 8_000;
  for (let i = 0; i < callCount; i++) {
    const id = `call-${i}`;
    entries.push({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id, name: "Read", input: { file_path: `/tmp/file-${i}` } }] },
    });
    entries.push({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: i % 997 === 0, content: "result" }] },
    });
  }
  const { dir, path } = fixture(entries);
  const small = fixture(entries.slice(0, 2_000));
  try {
    // Warm up the parser before comparing the two trace sizes. The generous
    // envelope tolerates filesystem and CI variance while still rejecting the
    // old all-prior-calls scan, whose work grows with every result/call pair.
    recentToolCalls(createTranscriptSnapshot(small.path), { limit: 1_000 });
    const smallStart = performance.now();
    recentToolCalls(createTranscriptSnapshot(small.path), { limit: 1_000 });
    const smallMs = performance.now() - smallStart;

    const snapshot = createTranscriptSnapshot(path);
    const largeStart = performance.now();
    const calls = recentToolCalls(snapshot, { limit: callCount });
    const largeMs = performance.now() - largeStart;

    assert.equal(calls.length, callCount);
    assert.equal(calls[0].failed, true);
    assert.equal(calls[1].failed, false);
    assert.equal(calls.at(-1).failed, false);
    assert.equal(observedPaths(snapshot).length, 200);
    assert.ok(largeMs < Math.max(250, smallMs * 18), `expected near-linear association, small=${smallMs.toFixed(1)}ms large=${largeMs.toFixed(1)}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(small.dir, { recursive: true, force: true });
  }
});
