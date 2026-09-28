// ──────────────────────────────────────────────────────────────────────
//  A Run: bounded steps toward one goal, ending in a Handback.
//
//  Each step: look at the page, build the Candidates, ask the Driver,
//  check the answer, look again, act. Any doubt ends the Run rather than
//  guessing — a Handback costs the agent one turn, a wrong click can cost
//  anything.
// ──────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { originOf, isTrusted } from "./origins.mjs";
import { buildCandidates, parseSnapshot, HANDBACK_CONTROLS } from "./candidates.mjs";
import { launchFlags, STRICT_DENY, BrowserError } from "./agent-browser.mjs";
import { DriverUnavailable } from "./driver.mjs";

// TypeSafe: thresholds scale with risk. Typing puts the agent's text into
// the page, so it needs more certainty than a click.
export const CLICK_FLOOR = Number(process.env.BROWSE_MIN_CONFIDENCE || 0.55);
export const TYPE_FLOOR = Number(process.env.BROWSE_MIN_TYPE_CONFIDENCE || 0.75);
export const MAX_STEPS = 30;
const HISTORY = 10;
const MAX_WAITS = 3;

const STATUS = { DONE: "done", BLOCKED: "blocked", NEEDS_INPUT: "needs_input", CONSEQUENTIAL: "consequential" };

const NEXT = {
  done: "Not yet verified. Take a fresh snapshot or screenshot and confirm the goal's evidence is on the page before reporting success.",
  needs_input: "Type the missing text yourself, or start another Run with a --value that fits.",
  consequential: "Only you may use the controls in `withheld`. Ask the user before any of them unless they already asked for exactly that.",
  low_confidence: "Look at the page yourself and take the next step, or start another Run with a more specific goal.",
  blocked: "Look at the page yourself; the Driver found no offered action that helps.",
  no_progress: "The last action changed nothing. Look at the page yourself before trying again.",
  step_limit: "Check progress with a snapshot, then start another Run if more steps are needed.",
  error: "See `reason`. If the Driver is unavailable, drive agent-browser directly on this session and ask the user before any consequential control.",
};

export const stateDir = () => process.env.BROWSE_STATE_DIR || join(homedir(), ".browse");

function privateDir() {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

const safeName = (session) => session.replace(/[^\w.-]/g, "_");
const metaPath = (session) => join(privateDir(), `${safeName(session)}.json`);

function loadMeta(session) {
  try {
    return JSON.parse(readFileSync(metaPath(session), "utf8"));
  } catch {
    return null;
  }
}

const saveMeta = (session, meta) => writeFileSync(metaPath(session), JSON.stringify(meta, null, 2), { mode: 0o600 });

function writePolicy() {
  const path = join(privateDir(), "strict-policy.json");
  writeFileSync(path, JSON.stringify({ default: "allow", deny: STRICT_DENY }, null, 2), { mode: 0o600 });
  return path;
}

/**
 * Why acting on `ref` is no longer safe after the page went from `before`
 * to `after`, or null. Refs stay bound to one element, so a change
 * elsewhere does not move the click; the chosen element changing does,
 * and so does anything new appearing — snapshots do not show dialogs,
 * but an overlay always brings controls of its own.
 */
export function staleReason(ref, before, after) {
  const was = new Map(parseSnapshot(before).map((e) => [e.ref, e]));
  const now = new Map(parseSnapshot(after).map((e) => [e.ref, e]));
  const a = was.get(ref);
  const b = now.get(ref);
  if (!b) return "the chosen element is gone";
  if (a && (a.role !== b.role || a.name !== b.name || a.attrs.url !== b.attrs.url || a.attrs.checked !== b.attrs.checked)) {
    return "the chosen element changed";
  }
  if ([...now.keys()].some((r) => !was.has(r))) return "new elements appeared";
  return null;
}

const sameLaunch = (a, b) =>
  a.tier === b.tier && (a.profile ?? null) === (b.profile ?? null)
  && [...a.allowOrigins].sort().join() === [...b.allowOrigins].sort().join();

const digest = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const round = (n) => Math.round(n * 100) / 100;

/**
 * @param {object} opts
 * @param {string} opts.goal
 * @param {string} [opts.url]           start a fresh session here; omit to continue the session
 * @param {string} opts.session
 * @param {{name: string, text: string, secret: boolean}[]} [opts.values]
 * @param {string[]} [opts.allowOrigins] further origins a strict Run may visit
 * @param {string[]} [opts.trustedOrigins]
 * @param {number} [opts.maxSteps]
 * @param {string} [opts.profile]
 * @param {boolean} [opts.headed]
 * @param {boolean} [opts.reuse]   open --url in the running session when its launch settings match
 * @param {object} deps
 * @param {object} deps.browser  from agentBrowser()
 * @param {Function} deps.choose from driver.mjs
 * @param {number} [deps.limit]  most options one question may carry
 */
export async function runBrowse(opts, { browser, choose, limit = 255 }) {
  const { goal, session, values = [], trustedOrigins = [], profile, headed } = opts;
  const maxSteps = Math.min(Math.max(1, opts.maxSteps ?? 10), MAX_STEPS);
  const byName = new Map(values.map((v) => [v.name, v]));
  const runHistory = [];
  let cost = 0;
  let meta;
  let page = null;
  let reused = null;

  const handback = (status, reason, extra = {}) => {
    if (meta) {
      meta.history = [...(meta.history ?? []), ...runHistory].slice(-HISTORY);
      saveMeta(session, meta);
    }
    return {
      status,
      reason,
      next: NEXT[status],
      session,
      ...(meta ? { tier: meta.tier } : {}),
      ...(page ? { url: page.url } : {}),
      steps: runHistory.length,
      cost_usd: round(cost * 1e4) / 1e4,
      history: runHistory,
      ...extra,
    };
  };

  if (opts.url) {
    const startOrigin = originOf(opts.url);
    if (!startOrigin) return handback("error", `${opts.url} has no origin to start from`);
    const allowOrigins = [startOrigin, ...(opts.allowOrigins ?? []).map(originOf).filter(Boolean)];
    const tier = allowOrigins.every((o) => isTrusted(o, trustedOrigins)) ? "trusted" : "strict";
    const previous = opts.reuse ? loadMeta(session) : null;
    meta = { tier, startOrigin, allowOrigins, profile: profile ?? null, history: [] };
    // --reuse skips Chrome's ~1 s start when the open session was launched
    // with the same settings. Its cookies and logins carry over, which is
    // why it is opt-in: the default is a fresh, logged-out session.
    if (previous && sameLaunch(previous, meta)) {
      try {
        reused = browser.act(["open", opts.url]);
      } catch {
        reused = null; // the session is gone; launch a fresh one
      }
    }
    if (!reused) {
      try {
        browser.close();
        browser.launch(opts.url, launchFlags({ tier, allowOrigins, policyPath: writePolicy(), profile, headed }));
      } catch (err) {
        return handback("error", `could not open ${opts.url}: ${err.message}`);
      }
    }
  } else {
    meta = loadMeta(session);
    if (!meta) return handback("error", `no Run has opened session "${session}"; pass --url to start one`);
  }

  // Adds what a snapshot does not say: the origin, and which buttons
  // submit a form and which fields take passwords (one call, when needed).
  const observe = (seen) => {
    const origin = originOf(seen.url);
    const trusted = isTrusted(origin, trustedOrigins);
    const elements = parseSnapshot(seen.snapshot);
    const buttons = trusted ? [] : elements.filter((e) => e.role === "button").map((e) => e.ref);
    const fields = values.length ? elements.filter((e) => e.role === "textbox" || e.role === "searchbox").map((e) => e.ref) : [];
    return { ...seen, origin, trusted, ...browser.attrs(buttons, fields) };
  };

  let waits = 0;
  const tried = new Set();
  let seen = reused;
  try {
    seen ??= browser.page();
  } catch (err) {
    return handback("error", `could not read the page: ${err.message}`);
  }

  for (let step = 1; step <= maxSteps; step++) {
    try {
      page = observe(seen);
    } catch (err) {
      return handback("error", `could not read the page: ${err.message}`);
    }
    if (meta.tier === "trusted" && !page.trusted) {
      return handback("error", `the page left trusted origins (${page.origin}); start a new Run with --url to browse it in strict mode`);
    }

    const secretsAllowed = page.trusted || page.origin === meta.startOrigin;
    const built = buildCandidates(page, {
      trusted: page.trusted,
      secretsAllowed,
      values: values.map(({ name, secret }) => ({ name, secret })),
      limit,
    });

    let decision;
    try {
      decision = await choose({
        goal,
        page: { url: page.url, text: page.text, controls: page.snapshot },
        history: [...(meta.history ?? []), ...runHistory].slice(-HISTORY),
        options: built.options,
      });
    } catch (err) {
      if (err instanceof DriverUnavailable) return handback("error", `driver_unavailable: ${err.message}`, { driver_unavailable: true });
      throw err;
    }
    cost += decision.cost ?? 0;
    const { choice, confidence } = decision;
    const label = built.options[choice] ?? choice;
    const record = (outcome) => runHistory.push({ step, action: label, confidence: round(confidence), outcome });
    const withheld = built.withheld.length ? { withheld: built.withheld } : {};

    if (HANDBACK_CONTROLS.has(choice)) {
      record("handback");
      if (choice === "DONE" && confidence < CLICK_FLOOR) {
        return handback("low_confidence", `the Driver leaned toward done at ${round(confidence)}`, withheld);
      }
      return handback(STATUS[choice], `the Driver chose ${choice} at ${round(confidence)}`, withheld);
    }

    const action = built.actions[choice] ?? { kind: choice };
    const floor = action.kind === "type" ? TYPE_FLOOR : CLICK_FLOOR;
    if (confidence < floor) {
      record("not taken: below the confidence floor");
      return handback("low_confidence", `${label} at ${round(confidence)} is below ${floor}`, withheld);
    }

    const key = `${label}\n${digest(page.snapshot)}`;
    if (tried.has(key)) {
      record("not taken: already tried on this same page");
      return handback("no_progress", `"${label}" was already tried on this same page`);
    }

    let command;
    if (choice === "WAIT") {
      if (++waits >= MAX_WAITS) {
        record("not taken: waited too often");
        return handback("no_progress", `the page was still loading after ${MAX_WAITS} waits`);
      }
      command = ["wait", "1000"];
    } else {
      waits = 0;
      if (action.kind === "click") command = ["click", `@${action.ref}`];
      else if (action.kind === "type") {
        const value = byName.get(action.value);
        // buildCandidates already enforces this; checked again where the
        // text actually leaves, because this is the rule that matters most.
        if (value.secret && !(secretsAllowed && page.types.get(action.ref) === "password")) {
          record("not taken: secret value outside a password field on an allowed origin");
          return handback("needs_input", "a secret value may only be typed into a password field on the starting or a trusted origin");
        }
        command = ["fill", `@${action.ref}`, value.text];
      } else if (choice === "SCROLL_DOWN") command = ["scroll", "down", "600"];
      else if (choice === "SCROLL_UP") command = ["scroll", "up", "600"];
      else if (choice === "ESCAPE") command = ["press", "Escape"];
      else if (choice === "ENTER") command = ["press", "Enter"];
      else return handback("error", `unknown option ${choice}`);
    }

    try {
      if (action.ref) {
        // The page may have changed while the Driver was deciding; a ref
        // chosen on the old page may now point somewhere else. If it did,
        // this read is the next step's page.
        const now = browser.page();
        const stale = now.snapshot === page.snapshot ? null : staleReason(action.ref, page.snapshot, now.snapshot);
        if (stale) {
          record(`not taken: ${stale} before acting`);
          seen = now;
          continue;
        }
      }
      seen = browser.act(command);
    } catch (err) {
      if (!(err instanceof BrowserError)) throw err;
      record(`failed: ${err.message}`);
      return handback("error", `${label} failed: ${err.message}`);
    }
    // Only an action that ran counts as tried: one skipped because the page
    // changed may be exactly right on the page as it is now.
    tried.add(key);
    record(choice === "WAIT" ? "waited" : "taken");
  }

  return handback("step_limit", `stopped after ${maxSteps} steps`);
}
