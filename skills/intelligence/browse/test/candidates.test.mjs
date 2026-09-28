import test from "node:test";
import assert from "node:assert/strict";
import { parseSnapshot, buildCandidates, consequentialReason } from "../scripts/candidates.mjs";
import { isTrusted, parseTrustedOrigins, originOf } from "../scripts/origins.mjs";

// Recorded from agent-browser 0.27 (`snapshot -i --urls`) on the test page
// used for the live Runs.
const SNAPSHOT = `- heading "Hotel search" [level=1, ref=e1]
- link "Rooms" [ref=e2, url=http://shop.test/rooms.html]
- link "Partner offers" [ref=e3, url=https://evil.example.com/x]
- textbox "Email " [ref=e11]
- textbox "Password " [ref=e12]
- checkbox " Newsletter" [checked=false, ref=e7]
- combobox [expanded=false, ref=e8]: 1
  - option "1" [selected, ref=e13]
- button "Continue" [ref=e9]
- button "Show details" [ref=e10]
- button "Buy now" [ref=e4]
- button "Rooms" [ref=e5]
- searchbox "Search" [ref=e6]`;

const PAGE = {
  snapshot: SNAPSHOT,
  origin: "http://shop.test",
  formRefs: new Set(["e11", "e12", "e7", "e8", "e9", "e10"]),
  types: new Map([["e9", "submit"], ["e10", "button"], ["e11", "email"], ["e12", "password"], ["e6", "search"]]),
};

const labels = (built) => Object.values(built.options);

test("parseSnapshot reads role, name, ref and attributes, and skips boundary lines", () => {
  const elements = parseSnapshot(`--- AGENT_BROWSER_PAGE_CONTENT nonce=abc origin=x ---\n${SNAPSHOT}\n--- END_AGENT_BROWSER_PAGE_CONTENT ---`);
  assert.equal(elements.length, 13);
  assert.deepEqual(elements[2], { ref: "e3", role: "link", name: "Partner offers", attrs: { ref: "e3", url: "https://evil.example.com/x" }, value: undefined });
  assert.equal(elements.find((e) => e.ref === "e7").attrs.checked, "false");
  assert.equal(elements.find((e) => e.ref === "e8").value, "1");
});

test("on an untrusted origin, consequential controls are withheld with their reason", () => {
  const built = buildCandidates(PAGE, { trusted: false, secretsAllowed: true });
  assert.deepEqual(built.withheld, [
    'link "Partner offers" (leads to another origin)',
    'button "Continue" (submits a form)',
    'button "Buy now" (label)',
  ]);
  assert.ok(labels(built).includes('Click button "Show details"'), "type=button inside a form is not a submit");
  assert.ok(labels(built).includes('Click link "Rooms"'), "a same-origin link is fine");
  assert.match(built.options.CONSEQUENTIAL, /Buy now/);
  assert.equal(built.options.ENTER, undefined, "Enter can submit a form, so it is trusted-only");
});

test("on a trusted origin, nothing is withheld and Enter is offered", () => {
  const built = buildCandidates(PAGE, { trusted: true, secretsAllowed: true });
  assert.deepEqual(built.withheld, []);
  assert.ok(labels(built).includes('Click button "Buy now"'));
  assert.ok(labels(built).includes('Click link "Partner offers"'));
  assert.equal(built.options.CONSEQUENTIAL, undefined);
  assert.ok(built.options.ENTER);
});

test("an untyped button in a form submits it; a script link is consequential", () => {
  const ctx = { pageOrigin: "http://shop.test", formRefs: new Set(["e1"]), types: new Map([["e1", null]]) };
  assert.equal(consequentialReason({ role: "button", name: "Next", ref: "e1", attrs: {} }, ctx), "submits a form");
  assert.equal(consequentialReason({ role: "button", name: "Next", ref: "e2", attrs: {} }, ctx), null);
  assert.equal(consequentialReason({ role: "link", name: "Go", ref: "e3", attrs: { url: "javascript:void(0)" } }, ctx), "script link");
  assert.equal(consequentialReason({ role: "link", name: "Go", ref: "e4", attrs: { url: "/relative" } }, ctx), null);
});

test("a secret value goes only into a password field, and only where secrets are allowed", () => {
  const values = [{ name: "email", secret: false }, { name: "pw", secret: true }];
  const allowed = labels(buildCandidates(PAGE, { trusted: false, secretsAllowed: true, values }));
  assert.ok(allowed.includes('Type value "pw" into textbox "Password"'));
  assert.ok(!allowed.includes('Type value "pw" into textbox "Email"'));
  assert.ok(!allowed.includes('Type value "email" into textbox "Password"'));
  assert.ok(allowed.includes('Type value "email" into searchbox "Search"'));

  const elsewhere = buildCandidates(PAGE, { trusted: false, secretsAllowed: false, values });
  assert.ok(!labels(elsewhere).some((l) => l.includes('"pw"')));
  assert.match(elsewhere.options.NEEDS_INPUT, /textbox "Password"/, "a field with nothing to type in it is named");
});

test("NEEDS_INPUT is offered only when some field has no value to type", () => {
  const values = [{ name: "email", secret: false }, { name: "pw", secret: true }];
  const built = buildCandidates(PAGE, { trusted: false, secretsAllowed: true, values });
  assert.equal(built.options.NEEDS_INPUT, undefined);
  assert.ok(buildCandidates(PAGE, { trusted: false, secretsAllowed: true }).options.NEEDS_INPUT);
});

test("identical labels are dropped, since the Driver cannot tell them apart", () => {
  const page = { ...PAGE, snapshot: `- button "Edit" [ref=e1]\n- button "Edit" [ref=e2]\n- button "Save" [ref=e3]\n- link "Edit" [ref=e4]`, formRefs: new Set(), types: new Map() };
  const built = buildCandidates(page, { trusted: true, secretsAllowed: true });
  assert.deepEqual(Object.values(built.actions).map((a) => a.ref), ["e3", "e4"]);
});

test("the option cap keeps every control and says how many actions were left out", () => {
  const snapshot = Array.from({ length: 40 }, (_, i) => `- link "Item ${i}" [ref=e${i}, url=http://shop.test/${i}]`).join("\n");
  const built = buildCandidates({ ...PAGE, snapshot }, { trusted: false, secretsAllowed: true, limit: 20 });
  assert.ok(Object.keys(built.options).length <= 20);
  assert.ok(built.options.DONE && built.options.BLOCKED && built.options.WAIT);
  assert.equal(built.omitted, 40 - Object.keys(built.actions).length);
  assert.match(built.options.SCROLL_DOWN, new RegExp(`${built.omitted} further actions`));
  assert.equal(built.actions.a0.ref, "e0", "the cap keeps actions in page order");
});

test("trusted origins are localhost or listed exactly, never by wildcard", () => {
  assert.ok(isTrusted("http://localhost:3000"));
  assert.ok(isTrusted("http://127.0.0.1:8080"));
  assert.ok(isTrusted("http://app.localhost"));
  assert.ok(!isTrusted("https://localhost.evil.com"));
  assert.ok(!isTrusted("https://my-app.vercel.app"));
  assert.ok(isTrusted("https://my-app.vercel.app", ["https://my-app.vercel.app"]));
  assert.ok(!isTrusted(null));

  const parsed = parseTrustedOrigins("https://my-app.vercel.app/path, *.vercel.app, example.com, http://intranet:8080");
  assert.deepEqual(parsed.origins, ["https://my-app.vercel.app", "http://intranet:8080"]);
  assert.deepEqual(parsed.rejected, ["*.vercel.app", "example.com"]);
  assert.equal(originOf("about:blank"), null);
});
