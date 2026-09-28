import test from "node:test";
import assert from "node:assert/strict";
import { parseSnapshot, buildCandidates, consequentialReason } from "../scripts/candidates.mjs";
import { isTrusted, parseTrustedOrigins, originOf } from "../scripts/origins.mjs";
import { parseTemplate, searchUrl, templateFinder } from "../scripts/opensearch.mjs";

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
  submits: new Set(["e9"]),
  types: new Map([["e11", "email"], ["e12", "password"], ["e6", "search"]]),
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

test("a marked submit control is consequential wherever its form is; a script link is too", () => {
  // Two forms: a CSS-scoped snapshot only ever saw the first one.
  const ctx = { pageOrigin: "http://shop.test", submits: new Set(["e2", "e3"]) };
  assert.equal(consequentialReason({ role: "button", name: "Go", ref: "e2", attrs: {} }, ctx), "submits a form");
  assert.equal(consequentialReason({ role: "button", name: "Next", ref: "e3", attrs: {} }, ctx), "submits a form");
  assert.equal(consequentialReason({ role: "button", name: "Outside", ref: "e1", attrs: {} }, ctx), null);
  assert.equal(consequentialReason({ role: "link", name: "Go", ref: "e4", attrs: { url: "javascript:void(0)" } }, ctx), "script link");
  assert.equal(consequentialReason({ role: "link", name: "Go", ref: "e5", attrs: { url: "/relative" } }, ctx), null);
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
  const page = { ...PAGE, snapshot: `- button "Edit" [ref=e1]\n- button "Edit" [ref=e2]\n- button "Save" [ref=e3]\n- link "Edit" [ref=e4]`, submits: new Set(), types: new Map() };
  const built = buildCandidates(page, { trusted: true, secretsAllowed: true });
  assert.deepEqual(Object.values(built.actions).map((a) => a.ref), ["e3", "e4"]);
});

test("the option cap keeps every control and says how many actions were left out", () => {
  const snapshot = Array.from({ length: 40 }, (_, i) => `- link "Item ${i}" [ref=e${i}, url=http://shop.test/${i}]`).join("\n");
  const built = buildCandidates({ ...PAGE, snapshot, submits: new Set() }, { trusted: false, secretsAllowed: true, limit: 20 });
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

test("a marked search field offers a Site search; a combobox only when marked", () => {
  const page = {
    snapshot: `- searchbox "Search" [ref=e1]\n- combobox "Search with Duck" [ref=e2]\n- combobox "Rooms" [ref=e3]: 1\n- textbox "Name" [ref=e4]`,
    origin: "https://duck.example",
    submits: new Set(),
    types: new Map([["e1", "search"]]),
    searchable: new Set(["e1", "e2"]),
  };
  const values = [{ name: "query", secret: false }, { name: "pw", secret: true }];
  const built = buildCandidates(page, { trusted: false, secretsAllowed: true, values });
  const all = Object.values(built.options);
  assert.ok(all.includes('Search for value "query" in searchbox "Search" and open the results'));
  assert.ok(all.includes('Search for value "query" in combobox "Search with Duck" and open the results'));
  assert.ok(!all.some((l) => l.includes('combobox "Rooms"')), "an unmarked combobox is a select");
  assert.ok(!all.some((l) => l.startsWith('Type value "query"') && /Search/.test(l)), "a search field is only ever searched");
  assert.ok(!all.some((l) => l.startsWith("Search") && l.includes('"pw"')));
  assert.equal(built.options.ENTER, undefined, "a bare Enter stays trusted-only");
});

test("a usable search template offers one page-level Site search per ordinary value", () => {
  const page = {
    snapshot: `- link "Home" [ref=e1, url=https://code.example/]\n- button "Search or jump to" [ref=e2]`,
    origin: "https://code.example", submits: new Set(), types: new Map(), siteSearch: true,
  };
  const built = buildCandidates(page, { trusted: false, secretsAllowed: true, values: [{ name: "query", secret: false }, { name: "pw", secret: true }] });
  assert.equal(built.options.a0, 'Search this site for value "query" and open the results');
  assert.ok(!Object.values(built.options).some((l) => l.includes('for value "pw"')));
  // Opening the site's search box first measurably raises the Driver's
  // confidence in the search itself (GitHub: 0.72-0.75 without, 0.88-0.90 with).
  assert.ok(Object.values(built.options).includes('Click button "Search or jump to"'));
});

test("an OpenSearch template is used only as a GET on the page's own origin", async () => {
  const github = `<OpenSearchDescription><Url type="text/html" method="get" template="https://github.com/search?q={searchTerms}&amp;ref=opensearch"/></OpenSearchDescription>`;
  assert.equal(parseTemplate(github), "https://github.com/search?q={searchTerms}&ref=opensearch");
  assert.equal(parseTemplate(`<Url type="application/x-suggestions+json" template="https://x/s?q={searchTerms}"/><Url type="text/html" method="post" template="https://x/p"/>`), null);
  assert.equal(parseTemplate(`<Url type="text/html" template="https://x/s?q={searchTerms}&amp;note=&amp;lt;b&amp;gt;"/>`), "https://x/s?q={searchTerms}&note=&lt;b&gt;", "entities decode once");

  assert.equal(searchUrl("https://github.com/search?q={searchTerms}&ref=opensearch", "is:pr a&b", "https://github.com"), "https://github.com/search?q=is%3Apr%20a%26b&ref=opensearch");
  assert.equal(searchUrl("https://evil.example/?q={searchTerms}", "x", "https://github.com"), null, "another origin");
  assert.equal(searchUrl("https://github.com/?q={searchTerms}&page={startPage}", "x", "https://github.com"), null, "a required parameter it cannot fill");
  assert.equal(searchUrl("https://github.com/?q={searchTerms}&page={startPage?}", "x", "https://github.com"), "https://github.com/?q=x&page=");

  let fetched = 0;
  const find = templateFinder(async () => { fetched++; return { ok: true, text: async () => github }; });
  assert.equal(await find("/opensearch.xml", "https://github.com/"), "https://github.com/search?q={searchTerms}&ref=opensearch");
  await find("/opensearch.xml", "https://github.com/other");
  assert.equal(fetched, 1, "cached per description URL");
  assert.equal(await find("https://evil.example/os.xml", "https://github.com/"), null, "a description on another origin is not fetched");
  assert.equal(fetched, 1);
});
