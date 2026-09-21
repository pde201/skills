import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const stateRoot = mkdtempSync(join(tmpdir(), "jev-client-privacy-"));
process.env.JEV_STATE_DIR = join(stateRoot, "state");
delete process.env.JEV_LOG;
process.env.TYPESAFE_API_KEY = "test-key";
process.env.JEV_RETRIES = "0";

const { JevUnavailable, choice, noul, score, systemOne } = await import("../lib/client.mjs");
const { SHAPES, slim } = await import("../lib/slim.mjs");
const { logDecision, stateDir } = await import("../lib/log.mjs");

const originalFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
});

const response = (payload) => ({
  ok: true,
  status: 200,
  async json() {
    return payload;
  },
  async text() {
    return JSON.stringify(payload);
  },
});

const slimQuestionIds = (lineCount) => Array.from({ length: lineCount }, (_, index) => `B${String(index).padStart(3, "0")}`);

function validSlimResponse(lineCount) {
  const blockIds = slimQuestionIds(lineCount);
  const shapeProbabilities = Object.fromEntries(Object.keys(SHAPES).map((id) => [id, id === "test_results" ? 1 : 0]));
  const relevance = Object.fromEntries(blockIds.map((id, index) => [id, index === 40 ? 1 : 0]));
  const secondRelevance = Object.fromEntries(blockIds.map((id, index) => [id, index === 60 ? 1 : 0]));
  return {
    model: "jev-test",
    answers: {
      shape: { type: "choice", choice: "test_results", probabilities: shapeProbabilities, confidence: 1 },
      failed: { type: "noul", noul: 0 },
      actionable: { type: "noul", noul: 0 },
      detail_needed: {
        type: "score",
        score: 0,
        legend: { "0": "short", "1": "some", "2": "diagnostic", "3": "full" },
        probabilities: { "0": 1, "1": 0, "2": 0, "3": 0 },
        confidence: 1,
      },
      relevance: { type: "choice", choice: "B040", probabilities: relevance, confidence: 1 },
      second_relevance: { type: "choice", choice: "B060", probabilities: secondRelevance, confidence: 1 },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function installMock(payload, onRequest = () => {}) {
  globalThis.fetch = async (url, options) => {
    onRequest(url, options);
    return response(typeof payload === "function" ? payload(url, options) : payload);
  };
}

const hundredLines = Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n");

test("an empty API response leaves the complete 100-line output untouched", async () => {
  installMock({});
  const result = await slim(hundredLines, { task: "inspect test output", command: "npm test" });
  assert.equal(result.changed, false);
  assert.equal(result.text, hundredLines);
  assert.match(result.reason, /jev unavailable/);
  assert.equal("fullPath" in result, false);
});

test("malformed typed answers fail closed for slimming", async () => {
  const variants = [
    {},
    {
      answers: {
        shape: { type: "choice", choice: "not-a-shape", probabilities: {}, confidence: 1 },
      },
    },
    {
      answers: {
        shape: { type: "choice", choice: "test_results", probabilities: Object.fromEntries(Object.keys(SHAPES).map((id) => [id, 0])), confidence: 1 },
        failed: { type: "noul", noul: Number.POSITIVE_INFINITY },
      },
    },
    {
      answers: {
        shape: { type: "choice", choice: "test_results", probabilities: Object.fromEntries(Object.keys(SHAPES).map((id) => [id, 0])), confidence: 1 },
        failed: { type: "noul", noul: 0 },
        actionable: { type: "noul", noul: 0 },
        detail_needed: {
          type: "score",
          score: 99,
          legend: { "0": "short", "1": "some", "2": "diagnostic", "3": "full" },
          probabilities: { "0": 1, "1": 0, "2": 0, "3": 0 },
          confidence: 1,
        },
      },
    },
  ];

  for (const payload of variants) {
    installMock(payload);
    const result = await slim(hundredLines, { task: "inspect test output", command: "npm test" });
    assert.equal(result.changed, false, JSON.stringify(payload));
    assert.equal(result.text, hundredLines, JSON.stringify(payload));
    assert.match(result.reason, /jev unavailable/, JSON.stringify(payload));
  }
});

test("a valid typed response still slims and preserves the full output privately", async () => {
  installMock(validSlimResponse(100));
  const result = await slim(hundredLines, { task: "inspect test output", command: "npm test" });
  assert.equal(result.changed, true);
  assert.notEqual(result.text, hundredLines);
  assert.match(result.text, /lines hidden/);
  assert.equal(readFileSync(result.fullPath, "utf8"), hundredLines);
  assert.equal(statSync(result.fullPath).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(result.fullPath)).mode & 0o777, 0o700);
});

test("outbound state redacts fields, credential blocks, SSNs, and free text", async () => {
  let request;
  const question = noul("Does this text mention a password?");
  installMock({
    model: "jev-test",
    answers: { answer: { type: "noul", noul: 0 } },
    usage: { input_tokens: 1, output_tokens: 1 },
  }, (_url, options) => {
    request = JSON.parse(options.body);
  });

  await systemOne({
    state: {
      apiKey: "api-secret",
      ssn: "123-45-6789",
      pem: "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
      text: "Authorization: Bearer bearer-secret; ssn 987-65-4321",
    },
    questions: { answer: question },
  });

  const encoded = JSON.stringify(request);
  assert.doesNotMatch(encoded, /api-secret|123-45-6789|private-material|bearer-secret|987-65-4321/);
  assert.equal(request.state.apiKey, "[REDACTED]");
  assert.equal(request.state.ssn, "[REDACTED]");
  assert.match(request.state.text, /\[REDACTED\]/);
});

test("typed response validation rejects missing answers and invalid identifiers", async () => {
  const questions = {
    shape: choice("Pick a shape", { alpha: null, beta: null }),
    level: score("Pick a level", ["low", "high"]),
  };
  const valid = {
    model: "jev-test",
    answers: {
      shape: { type: "choice", choice: "alpha", probabilities: { alpha: 1, beta: 0 }, confidence: 1 },
      level: { type: "score", score: 0, legend: { "0": "low", "1": "high" }, probabilities: { "0": 1, "1": 0 }, confidence: 1 },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  installMock({ ...valid, answers: { shape: valid.answers.shape } });
  await assert.rejects(systemOne({ state: "x", questions }), (error) => error instanceof JevUnavailable);

  installMock({
    ...valid,
    answers: {
      ...valid.answers,
      shape: { ...valid.answers.shape, choice: "gamma" },
    },
  });
  await assert.rejects(systemOne({ state: "x", questions }), (error) => error instanceof JevUnavailable);
});

test("decision logs are redacted and private", () => {
  logDecision({ token: "log-secret", ssn: "123-45-6789", message: "password=log-password" });
  const path = join(stateDir(), "jev-log.jsonl");
  const content = readFileSync(path, "utf8");
  assert.doesNotMatch(content, /log-secret|123-45-6789|log-password/);
  assert.equal(statSync(stateDir()).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});
