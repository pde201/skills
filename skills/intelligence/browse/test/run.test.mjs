import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BROWSE_STATE_DIR = mkdtempSync(join(tmpdir(), "browse-run-"));

const { runBrowse, CLICK_FLOOR, TYPE_FLOOR } = await import("../scripts/run.mjs");
const { launchFlags, BrowserError } = await import("../scripts/agent-browser.mjs");
const { DriverUnavailable } = await import("../scripts/driver.mjs");

// A tiny site: each page is a snapshot plus where its links lead.
const SITE = {
  "http://localhost:4000/": {
    snapshot: `- link "Rooms" [ref=e1, url=http://localhost:4000/rooms]\n- link "Elsewhere" [ref=e2, url=https://other.example/]`,
    text: "Welcome",
    go: { e1: "http://localhost:4000/rooms", e2: "https://other.example/" },
  },
  "http://localhost:4000/rooms": { snapshot: `- link "Deluxe" [ref=e1, url=http://localhost:4000/deluxe]`, text: "Rooms", go: { e1: "http://localhost:4000/deluxe" } },
  "http://localhost:4000/deluxe": { snapshot: `- button "Book" [ref=e1]`, text: "Deluxe $240", go: {} },
  "https://other.example/": { snapshot: `- button "Next" [ref=e1]`, text: "Other", go: {} },
  "https://shop.example/login": {
    snapshot: `- textbox "Email" [ref=e1]\n- textbox "Password" [ref=e2]\n- button "Sign in" [ref=e3]\n- link "Help" [ref=e4, url=https://shop.example/help]`,
    text: "Sign in",
    formRefs: ["e1", "e2", "e3"],
    types: { e1: "email", e2: "password", e3: "submit" },
    go: { e4: "https://shop.example/help" },
  },
  "https://shop.example/help": { snapshot: `- link "Back" [ref=e1, url=https://shop.example/login]`, text: "Help", go: {} },
};

function fakeBrowser({ changeOnce = false, failClick = false } = {}) {
  const log = [];
  let url = null;
  let flicker = changeOnce;
  const current = () => SITE[url];
  return {
    log,
    close: () => log.push(["close"]),
    launch: (to, flags) => { url = to; log.push(["launch", to, flags]); },
    page() {
      const p = current();
      let snapshot = p.snapshot;
      // The first freshness check after a decision sees a changed page.
      if (flicker && log.some((e) => e[0] === "page")) { snapshot += `\n- button "Ad" [ref=e99]`; flicker = false; }
      log.push(["page"]);
      return { snapshot, text: p.text, url, formRefs: new Set(p.formRefs ?? []) };
    },
    types: (refs) => new Map(refs.map((r) => [r, current().types?.[r] ?? null])),
    click(ref) {
      if (failClick) throw new BrowserError("Unknown ref");
      log.push(["click", ref]);
      if (current().go[ref]) url = current().go[ref];
    },
    fill: (ref, text) => log.push(["fill", ref, text]),
    press: (key) => log.push(["press", key]),
    scroll: (dir) => log.push(["scroll", dir]),
    wait: (ms) => log.push(["wait", ms]),
  };
}

/** A Driver that answers from a script of [label-or-control, confidence]. */
function scriptedDriver(script) {
  const asked = [];
  return {
    asked,
    async choose({ options, ...rest }) {
      asked.push({ options, ...rest });
      const [want, confidence] = script[Math.min(asked.length - 1, script.length - 1)];
      const id = Object.keys(options).find((k) => k === want || options[k] === want);
      assert.ok(id, `option ${want} was not offered: ${JSON.stringify(options)}`);
      return { choice: id, confidence, cost: 0.00001 };
    },
  };
}

let n = 0;
const run = (opts, browser, driver) =>
  runBrowse({ session: `t${++n}`, goal: "find the deluxe price", maxSteps: 10, ...opts }, { browser, choose: driver.choose });

test("a Run follows the Driver to done and hands back for verification", async () => {
  const browser = fakeBrowser();
  const driver = scriptedDriver([['Click link "Rooms"', 0.9], ['Click link "Deluxe"', 0.95], ["DONE", 0.9]]);
  const result = await run({ url: "http://localhost:4000/" }, browser, driver);
  assert.equal(result.status, "done");
  assert.equal(result.tier, "trusted");
  assert.equal(result.url, "http://localhost:4000/deluxe");
  assert.equal(result.steps, 3);
  assert.match(result.next, /fresh snapshot/);
  assert.deepEqual(driver.asked[2].page, { url: "http://localhost:4000/deluxe", text: "Deluxe $240", controls: `- button "Book" [ref=e1]` });
  assert.deepEqual(driver.asked[2].history.map((h) => h.outcome), ["taken", "taken"]);
});

test("a trusted launch uses only the output cap; a strict one turns every guard on", async () => {
  const browser = fakeBrowser();
  await run({ url: "http://localhost:4000/" }, browser, scriptedDriver([["DONE", 0.9]]));
  assert.deepEqual(browser.log.find((e) => e[0] === "launch")[2], ["--max-output", "20000"]);

  const strict = launchFlags({ tier: "strict", allowOrigins: ["https://shop.example", "https://cdn.shop.example:8443"], policyPath: "/p.json" });
  assert.deepEqual(strict, ["--max-output", "20000", "--content-boundaries", "--action-policy", "/p.json", "--allowed-domains", "shop.example,cdn.shop.example"]);
  const withProfile = launchFlags({ tier: "strict", allowOrigins: ["https://shop.example"], policyPath: "/p.json", profile: "Default" });
  assert.ok(!withProfile.includes("--allowed-domains"), "agent-browser refuses an allowlist with a profile");
  assert.ok(withProfile.includes("--action-policy"));
});

test("the strict policy file denies evaluate and state export, and is private", async () => {
  await run({ url: "https://shop.example/login" }, fakeBrowser(), scriptedDriver([["BLOCKED", 0.9]]));
  const path = join(process.env.BROWSE_STATE_DIR, "strict-policy.json");
  const policy = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(policy.default, "allow");
  for (const action of ["evaluate", "upload", "download", "cookies_get", "storage_get", "route", "state_save"]) {
    assert.ok(policy.deny.includes(action), action);
  }
  assert.equal(statSync(path).mode & 0o077, 0);
});

test("a click below the floor, or a type below the stricter one, hands back unperformed", async () => {
  const browser = fakeBrowser();
  const result = await run({ url: "http://localhost:4000/" }, browser, scriptedDriver([['Click link "Rooms"', CLICK_FLOOR - 0.01]]));
  assert.equal(result.status, "low_confidence");
  assert.ok(!browser.log.some((e) => e[0] === "click"));

  const typing = fakeBrowser();
  const typed = await run(
    { url: "https://shop.example/login", values: [{ name: "email", text: "me@x.test", secret: false }] },
    typing,
    scriptedDriver([['Type value "email" into textbox "Email"', TYPE_FLOOR - 0.01]]),
  );
  assert.equal(typed.status, "low_confidence");
  assert.ok(!typing.log.some((e) => e[0] === "fill"));
  assert.ok(TYPE_FLOOR > CLICK_FLOOR);
});

test("a DONE below the floor is reported as low confidence, not done", async () => {
  const result = await run({ url: "http://localhost:4000/" }, fakeBrowser(), scriptedDriver([["DONE", 0.4]]));
  assert.equal(result.status, "low_confidence");
});

test("on an untrusted origin the Run types values, then hands back at the withheld submit", async () => {
  const browser = fakeBrowser();
  const values = [{ name: "email", text: "me@x.test", secret: false }, { name: "pw", text: "hunter2", secret: true }];
  const driver = scriptedDriver([
    ['Type value "email" into textbox "Email"', 0.9],
    ['Type value "pw" into textbox "Password"', 0.9],
    ["CONSEQUENTIAL", 0.9],
  ]);
  const result = await run({ url: "https://shop.example/login", values }, browser, driver);
  assert.equal(result.status, "consequential");
  assert.equal(result.tier, "strict");
  assert.deepEqual(result.withheld, ['button "Sign in" (submits a form)']);
  assert.deepEqual(browser.log.filter((e) => e[0] === "fill"), [["fill", "e1", "me@x.test"], ["fill", "e2", "hunter2"]]);
  assert.ok(!JSON.stringify(driver.asked).includes("hunter2"), "the Driver never sees a value's text");
  assert.ok(!JSON.stringify(result).includes("hunter2"), "nor does the Handback");
});

test("a secret is not offered once the page has left the starting origin", async () => {
  // A harmless-looking button that redirects to another origin's password form.
  SITE["https://shop.example/help"] = {
    snapshot: `- button "Next" [ref=e1]`, text: "Help", go: { e1: "https://other.example/login" },
  };
  SITE["https://other.example/login"] = {
    snapshot: `- textbox "Password" [ref=e1]`, text: "Sign in", types: { e1: "password" }, go: {},
  };
  const values = [{ name: "pw", text: "hunter2", secret: true }];
  const driver = scriptedDriver([['Click link "Help"', 0.9], ['Click button "Next"', 0.9], ["BLOCKED", 0.9]]);
  const result = await run({ url: "https://shop.example/login", values, allowOrigins: ["https://other.example"] }, fakeBrowser(), driver);
  assert.equal(result.status, "blocked");
  assert.ok(Object.values(driver.asked[0].options).includes('Type value "pw" into textbox "Password"'));
  assert.ok(!Object.values(driver.asked[2].options).some((l) => l.includes('"pw"')));
  assert.match(driver.asked[2].options.NEEDS_INPUT, /textbox "Password"/);
});

test("repeating an action on an unchanged page ends the Run as no_progress", async () => {
  SITE["http://localhost:4000/deluxe"].go = {};
  const browser = fakeBrowser();
  const result = await run({ url: "http://localhost:4000/deluxe" }, browser, scriptedDriver([['Click button "Book"', 0.9]]));
  assert.equal(result.status, "no_progress");
  assert.equal(browser.log.filter((e) => e[0] === "click").length, 1);
});

test("three waits in a row end the Run as no_progress", async () => {
  const browser = fakeBrowser();
  const result = await run({ url: "http://localhost:4000/" }, browser, scriptedDriver([["WAIT", 0.9]]));
  // The same WAIT on the same page is also a repeat; either way it stops early.
  assert.equal(result.status, "no_progress");
  assert.ok(browser.log.filter((e) => e[0] === "wait").length <= 2);
});

test("a page that changes while the Driver decides is looked at again, not clicked blind", async () => {
  const browser = fakeBrowser({ changeOnce: true });
  const driver = scriptedDriver([['Click link "Rooms"', 0.9], ['Click link "Rooms"', 0.9], ["DONE", 0.9]]);
  const result = await run({ url: "http://localhost:4000/" }, browser, driver);
  assert.equal(result.history[0].outcome, "not taken: the page changed before acting");
  assert.equal(result.history[1].outcome, "taken");
});

test("a trusted Run that reaches an untrusted origin stops there", async () => {
  const result = await run({ url: "http://localhost:4000/" }, fakeBrowser(), scriptedDriver([['Click link "Elsewhere"', 0.9]]));
  assert.equal(result.status, "error");
  assert.match(result.reason, /left trusted origins/);
});

test("an unavailable Driver hands back with driver_unavailable", async () => {
  const failing = { choose: async () => { throw new DriverUnavailable("TYPESAFE_API_KEY is not set"); } };
  const result = await run({ url: "http://localhost:4000/" }, fakeBrowser(), failing);
  assert.equal(result.status, "error");
  assert.equal(result.driver_unavailable, true);
  assert.match(result.next, /drive agent-browser directly/);
});

test("a failed browser action hands back its error", async () => {
  const result = await run({ url: "http://localhost:4000/" }, fakeBrowser({ failClick: true }), scriptedDriver([['Click link "Rooms"', 0.9]]));
  assert.equal(result.status, "error");
  assert.match(result.reason, /Unknown ref/);
});

test("the step limit ends a Run, and a later Run continues the session with its history", async () => {
  const browser = fakeBrowser();
  const first = await runBrowse(
    { session: "cont", goal: "g", url: "http://localhost:4000/", maxSteps: 1 },
    { browser, choose: scriptedDriver([['Click link "Rooms"', 0.9]]).choose },
  );
  assert.equal(first.status, "step_limit");
  const driver = scriptedDriver([["DONE", 0.9]]);
  const second = await runBrowse({ session: "cont", goal: "g" }, { browser, choose: driver.choose });
  assert.equal(second.status, "done");
  assert.equal(second.tier, "trusted");
  assert.equal(driver.asked[0].history[0].action, 'Click link "Rooms"');
});

test("continuing a session no Run opened is an error, not a guess", async () => {
  const result = await runBrowse({ session: "never-opened", goal: "g" }, { browser: fakeBrowser(), choose: async () => assert.fail() });
  assert.equal(result.status, "error");
  assert.match(result.reason, /pass --url/);
});
