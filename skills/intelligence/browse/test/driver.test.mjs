import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// jev's client keeps breaker state and logs; keep both out of the way.
process.env.JEV_STATE_DIR = mkdtempSync(join(tmpdir(), "browse-driver-"));
process.env.JEV_RETRIES = "0";
process.env.JEV_BREAKER_FAILURES = "0";
delete process.env.JEV_LOG;

const { choose, loadClient, DriverUnavailable } = await import("../scripts/driver.mjs");
const { parseArgs } = await import("../scripts/browse.mjs");

const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; });

const answer = (next) => ({
  ok: true,
  status: 200,
  async json() { return { model: "jev-test", answers: { next }, usage: { input_tokens: 1000, output_tokens: 0 } }; },
  async text() { return ""; },
});

const OPTIONS = {
  a0: 'Click link "Order 123456789"',
  a1: 'Click link "Order 987654321"',
  a2: 'Type value "email" into textbox "Email"',
  DONE: "The goal's result is visibly present on the page now.",
};

test("the Driver is found beside browse, in jev's lib", async () => {
  const client = await loadClient();
  assert.ok(client, "skills/intelligence/jev/lib/client.mjs should resolve");
  assert.equal(typeof client.pickChoiceStrict, "function");
});

test("option labels reach TypeSafe as given; page text is still redacted", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  let body;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return answer({ type: "choice", choice: "a0", probabilities: { a0: 0.8, a1: 0.1, a2: 0.05, DONE: 0.05 }, confidence: 0.8 });
  };
  const result = await choose({
    goal: "open order 123456789",
    page: { url: "https://shop.example/?token=abc", text: "Your account 123456789", controls: "" },
    history: [],
    options: OPTIONS,
  });
  assert.deepEqual(result, { choice: "a0", confidence: 0.8, cost: 1000 / 1e6 * 0.042 });
  assert.deepEqual(body.questions.next.criteria, OPTIONS, "labels distinguish the options only when unredacted");
  assert.doesNotMatch(body.state.page.text, /123456789/);
});

test("an answer without confidence, or not its own top option, is not acted on", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  globalThis.fetch = async () => answer({ type: "choice", choice: "a1", probabilities: { a0: 0.7, a1: 0.1, a2: 0.1, DONE: 0.1 }, confidence: 0.7 });
  await assert.rejects(choose({ goal: "g", page: {}, history: [], options: OPTIONS }), DriverUnavailable);
  globalThis.fetch = async () => answer({ type: "choice", choice: "a0", probabilities: { a0: 0.7, a1: 0.1, a2: 0.1, DONE: 0.1 } });
  await assert.rejects(choose({ goal: "g", page: {}, history: [], options: OPTIONS }), DriverUnavailable);
});

test("no key or a provider failure makes the Driver unavailable", async () => {
  delete process.env.TYPESAFE_API_KEY;
  await assert.rejects(choose({ goal: "g", page: {}, history: [], options: OPTIONS }), /TYPESAFE_API_KEY/);
  process.env.TYPESAFE_API_KEY = "test-key";
  globalThis.fetch = async () => ({ ok: false, status: 503, async text() { return "down"; } });
  await assert.rejects(choose({ goal: "g", page: {}, history: [], options: OPTIONS }), DriverUnavailable);
});

test("secrets come from the environment, never the command line", () => {
  const args = parseArgs(
    ["run", "--goal", "sign in", "--url", "https://x.test", "--value", "email=a=b@x.test", "--secret", "pw=env:MY_PW", "--allow-origin", "https://cdn.x.test", "--headed"],
    { MY_PW: "hunter2" },
  );
  assert.deepEqual(args.values, [{ name: "email", text: "a=b@x.test", secret: false }, { name: "pw", text: "hunter2", secret: true }]);
  assert.deepEqual(args.allowOrigins, ["https://cdn.x.test"]);
  assert.equal(args.session, "browse");
  assert.equal(args.headed, true);

  assert.throws(() => parseArgs(["run", "--secret", "pw=hunter2"], {}), /environment variable/);
  assert.throws(() => parseArgs(["run", "--secret", "pw=env:UNSET_VAR"], {}), /not set/);
  assert.throws(() => parseArgs(["run", "--value", "a=1", "--value", "a=2"], {}), /distinct/);
  assert.throws(() => parseArgs(["run", "--nope"], {}), /unknown argument/);
  assert.throws(() => parseArgs(["run", "--max-steps", "abc"], {}), /positive whole number/);
  assert.equal(parseArgs(["run", "--max-steps", "4"], {}).maxSteps, 4);
});
