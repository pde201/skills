// Dense output (wide JSON log lines, long stack traces) must fit the model's token cap:
// lines are clipped in the state, and a max_tokens_exceeded answer gets one smaller retry.
// Logged: 8 slims failed with "TypeSafe 400: max_tokens_exceeded" (mvn test ~840 lines,
// kubectl logs of 101 wide JSON lines, a 50 KB SQL printf) and passed through untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const SHAPE_KEYS = ["test_results", "build_or_compile", "package_manager", "file_listing", "structured_data", "stack_trace",
  "diff_or_patch", "log_stream", "status_report", "prose_or_docs", "other"];
const bodies = [];
const answer = (ids) => {
  const weights = (selected) => Object.fromEntries(ids.map((id) => [id, id === selected ? 1 : 0]));
  return {
    model: "jev-test",
    answers: {
      shape: { type: "choice", choice: "log_stream", probabilities: Object.fromEntries(SHAPE_KEYS.map((k) => [k, k === "log_stream" ? 1 : 0])), confidence: 1 },
      failed: { type: "noul", noul: 0 },
      actionable: { type: "noul", noul: 0 },
      detail_needed: { type: "score", score: 0, legend: { "0": "short", "1": "some", "2": "diagnostic", "3": "full" }, probabilities: { "0": 1, "1": 0, "2": 0, "3": 0 }, confidence: 1 },
      relevance: { type: "choice", choice: ids[1], probabilities: weights(ids[1]), confidence: 1 },
      second_relevance: { type: "choice", choice: ids[2], probabilities: weights(ids[2]), confidence: 1 },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
};
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const body = JSON.parse(raw);
    bodies.push(body);
    if (body.state.output.length > 30_000) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: { error_type: "max_tokens_exceeded" } }));
      return;
    }
    const ids = Array.from({ length: 100 }, (_, i) => `B${String(i).padStart(3, "0")}`); // the retry's 100 blocks
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answer(ids)));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const state = mkdtempSync(join(tmpdir(), "jev-slim-dense-"));
Object.assign(process.env, {
  TYPESAFE_API_KEY: "synthetic-test-key",
  TYPESAFE_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  JEV_RETRIES: "0",
  JEV_STATE_DIR: state,
});
const { slim, renderBlocks, toBlocks } = await import("../lib/slim.mjs");
test.after(() => { server.close(); rmSync(state, { recursive: true, force: true }); });

test("wide lines are clipped in the state, never in the kept output", () => {
  const wide = `{"event":"voi.wide","attributes":{"payload":"${"x".repeat(3000)}"}}`;
  const { text } = renderBlocks(toBlocks([wide, "short"]));
  assert.ok(text.length < 600, "a 3 KB line becomes a gist");
  assert.match(text, /…\[\+\d+ chars\]/);
});

test("a max_tokens_exceeded answer gets one smaller retry and the slim still happens", async () => {
  bodies.length = 0;
  const lines = Array.from({ length: 400 }, (_, i) => `{"i":${i},"event":"voi.wide","payload":"${"y".repeat(390)}"}`);
  const output = lines.join("\n");
  const result = await slim(output, { task: "check the logs", command: "kubectl logs deploy/voi" });
  assert.equal(bodies.length, 2, "first try overflowed, the retry fit");
  assert.ok(bodies[0].state.output.length > 30_000);
  assert.ok(bodies[1].state.output.length <= 30_000);
  assert.equal(result.changed, true, result.reason);
  for (const kept of result.text.split("\n").filter((l) => l.startsWith('{"i":'))) {
    assert.ok(lines.includes(kept), "kept lines are the original, unclipped text");
  }
  const fullPath = result.fullPath;
  assert.equal(readFileSync(fullPath, "utf8"), output);
  rmSync(dirname(fullPath), { recursive: true, force: true });
});

test("other errors are not retried", async () => {
  bodies.length = 0;
  const saved = process.env.TYPESAFE_API_KEY;
  const result = await slim("", { command: "x" });
  assert.equal(result.changed, false);
  assert.equal(bodies.length, 0);
  process.env.TYPESAFE_API_KEY = saved;
});
