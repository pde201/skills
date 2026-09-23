// ──────────────────────────────────────────────────────────────────────
//  The circuit breaker, in its own file so its state directory and its
//  short cooldown cannot leak into the other suites.
// ──────────────────────────────────────────────────────────────────────

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.JEV_STATE_DIR = mkdtempSync(join(tmpdir(), "jev-breaker-"));
process.env.TYPESAFE_API_KEY = "test-key";
process.env.JEV_RETRIES = "0";
process.env.JEV_BREAKER_FAILURES = "3";
process.env.JEV_BREAKER_COOLDOWN_MS = "200";
delete process.env.JEV_LOG;

const { systemOne, noul, JevUnavailable, breakerStatus, resetBreaker } = await import("../lib/client.mjs");
const { guard, ALLOW } = await import("../lib/guard.mjs");

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let now = originalNow();
Date.now = () => now;
test.after(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
});

const question = () => ({ q: noul("Is `text` a greeting?") });
const okResponse = { model: "jev-test", answers: { q: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 0 } };
let calls = 0;
const failing = async () => {
  calls++;
  return { ok: false, status: 503, async text() { return "upstream down"; } };
};
const healthy = async () => {
  calls++;
  return { ok: true, status: 200, async json() { return okResponse; }, async text() { return ""; } };
};
const advance = (ms) => { now += ms; };
const tripBreaker = async () => {
  for (let i = 0; i < 3; i++) await assert.rejects(systemOne({ state: "hi", questions: question() }), /TypeSafe 503/);
};

test("three consecutive provider failures open the circuit; the next call is refused without a request", async () => {
  resetBreaker();
  calls = 0;
  globalThis.fetch = failing;
  await tripBreaker();
  assert.equal(calls, 3);
  assert.equal(breakerStatus().open, true);

  await assert.rejects(
    systemOne({ state: "hi", questions: question() }),
    (error) => error instanceof JevUnavailable && /circuit open after 3 consecutive provider failures/.test(error.message),
  );
  assert.equal(calls, 3, "no request goes out while the circuit is open");
});

test("after the cooldown one trial request goes through, and a success closes the circuit", async () => {
  advance(250);
  assert.equal(breakerStatus().open, false, "the cooldown has passed");
  calls = 0;
  globalThis.fetch = healthy;
  const res = await systemOne({ state: "hi", questions: question() });
  assert.equal(res.answers.q.noul, 0.9);
  assert.equal(calls, 1);
  assert.equal(breakerStatus().failures, 0, "a success forgets the failures");
});

test("a failed trial re-opens the circuit for another cooldown", async () => {
  resetBreaker();
  globalThis.fetch = failing;
  await tripBreaker();
  advance(250);
  calls = 0;
  await assert.rejects(systemOne({ state: "hi", questions: question() }), /TypeSafe 503/);
  assert.equal(calls, 1, "the trial request was made");
  assert.equal(breakerStatus().open, true, "and its failure re-opened the circuit");
  await assert.rejects(systemOne({ state: "hi", questions: question() }), /circuit open/);
  assert.equal(calls, 1);
});

test("client errors and malformed answers are this layer's bugs and do not count", async () => {
  resetBreaker();
  globalThis.fetch = async () => ({ ok: false, status: 422, async text() { return "bad request"; } });
  for (let i = 0; i < 4; i++) await assert.rejects(systemOne({ state: "hi", questions: question() }), /TypeSafe 422/);
  assert.equal(breakerStatus().open, false);

  globalThis.fetch = async () => ({ ok: true, status: 200, async json() { return {}; }, async text() { return ""; } });
  for (let i = 0; i < 4; i++) await assert.rejects(systemOne({ state: "hi", questions: question() }), /Invalid TypeSafe response/);
  assert.equal(breakerStatus().open, false);
});

test("an open circuit fails the guard open, and the reason says so", async () => {
  resetBreaker();
  globalThis.fetch = failing;
  await tripBreaker();
  calls = 0;
  const verdict = await guard({ toolName: "Bash", input: { command: "npm test" }, cwd: "/tmp", task: "run the tests" });
  assert.equal(verdict.decision, ALLOW);
  assert.equal(verdict.by, "code");
  assert.match(verdict.reason, /circuit open/);
  assert.equal(calls, 0);
});
