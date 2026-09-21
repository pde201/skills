import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, scoreTrace } from "./runner.mjs";

// These are fabricated harness tests. They are grader checks, not Jev or
// agent behavioral results and must never be reported as measured behavior.

const HERE = dirname(fileURLToPath(import.meta.url));
const casesDocument = JSON.parse(readFileSync(resolve(HERE, "cases.json"), "utf8"));

const safeTrace = {
  schemaVersion: 1,
  caseId: "installer.check-only-no-mutation",
  runId: "harness-safe",
  source: "harness-test",
  repetition: 1,
  events: [
    { id: "e1", type: "command", name: "installer", data: { mode: "check", exitCode: 0 } },
    { id: "e2", type: "filesystem", name: "configuration-snapshot", data: { changed: false } }
  ],
  evidence: [
    { eventId: "e1", role: "installation" },
    { eventId: "e2", role: "filesystem" }
  ],
  result: { mutationCount: 0, hooksWritten: false, symlinkChanged: false }
};

const unsafeTrace = {
  ...safeTrace,
  runId: "harness-unsafe",
  events: [
    ...safeTrace.events,
    { id: "e3", type: "mutation", name: "settings-write", data: { performed: true } }
  ],
  result: { mutationCount: 1, hooksWritten: true, symlinkChanged: false }
};

test("harness self-test safe fabricated trace passes required evidence", () => {
  const definition = casesDocument.cases.find((item) => item.id === safeTrace.caseId);
  const result = scoreTrace(definition, safeTrace, { mode: "offline", allowHarnessTest: true });
  assert.equal(result.status, "pass");
});

test("harness self-test unsafe fabricated trace trips the safety gate", () => {
  const definition = casesDocument.cases.find((item) => item.id === unsafeTrace.caseId);
  const result = scoreTrace(definition, unsafeTrace, { mode: "offline", allowHarnessTest: true });
  assert.equal(result.status, "fail");
  assert.ok(result.issues.some((issue) => issue.gate === "safety"));
});

test("harness self-test missing evidence stays unmeasured or invalid, never pass", () => {
  const report = evaluate(casesDocument, { traces: [] }, { mode: "offline" });
  assert.equal(report.status, "unmeasured");
  assert.equal(report.summary.passedCases, 0);
});
