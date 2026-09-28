// ──────────────────────────────────────────────────────────────────────
//  The only module that runs agent-browser. Everything above it sees a
//  page as plain data, so the Run can be tested without a browser.
// ──────────────────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";
import { hostsOf } from "./origins.mjs";

// agent-browser's own names for the actions strict mode denies. These are
// the names its policy matches (`evaluate`, not the documented `eval`);
// names it does not know are ignored, so the list may run ahead of it.
export const STRICT_DENY = [
  "evaluate", "upload", "download",
  "cookies_get", "cookies_set", "cookies_clear",
  "storage_get", "storage_set", "storage_clear",
  "route", "unroute", "har_start", "har_stop",
  "state_save", "state_load", "clipboard", "credentials",
];

export const MAX_OUTPUT = 20000;
const PAGE_TEXT_CHARS = 6000;

/**
 * Launch flags for a Run's session. Strict mode turns on every guard
 * agent-browser has; a profile rules out the domain allowlist, which
 * agent-browser refuses to combine with one.
 */
export function launchFlags({ tier, allowOrigins, policyPath, profile, headed }) {
  const flags = ["--max-output", String(MAX_OUTPUT)];
  if (tier === "strict") {
    flags.push("--content-boundaries", "--action-policy", policyPath);
    if (!profile) flags.push("--allowed-domains", hostsOf(allowOrigins).join(","));
  }
  if (profile) flags.push("--profile", profile);
  if (headed) flags.push("--headed");
  return flags;
}

export class BrowserError extends Error {}

// Content-boundary markers carry a fresh nonce on every read. They protect
// an agent reading the page; to the Run they would make every snapshot
// look like a changed page.
const withoutBoundaries = (text) => text.split("\n").filter((line) => !/^--- .*AGENT_BROWSER/.test(line)).join("\n");

/**
 * @param {object} opts
 * @param {string} opts.session
 * @param {string} [opts.bin]
 */
export function agentBrowser({ session, bin = process.env.BROWSE_AGENT_BROWSER || "agent-browser" }) {
  const run = (args) => {
    let out;
    try {
      out = execFileSync(bin, ["--session", session, "--json", ...args], {
        encoding: "utf8",
        timeout: 30000,
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (err) {
      if (err.code === "ENOENT") throw new BrowserError(`${bin} is not installed`);
      out = err.stdout;
      if (!out) throw new BrowserError(String(err.stderr || err.message).trim().slice(0, 300));
    }
    let parsed;
    try {
      parsed = JSON.parse(out);
    } catch {
      throw new BrowserError(`unreadable agent-browser output: ${String(out).slice(0, 200)}`);
    }
    if (!Array.isArray(parsed) && parsed.success === false) throw new BrowserError(parsed.error ?? "agent-browser failed");
    return parsed;
  };
  const batch = (commands) => (commands.length ? run(["batch", ...commands]) : []);

  return {
    close() {
      try { run(["close"]); } catch { /* nothing open */ }
    },

    launch(url, flags) {
      run([...flags, "open", url]);
    },

    /** One step's view of the page: snapshot, form membership, attributes. */
    page() {
      // The full snapshot goes last: each snapshot replaces agent-browser's
      // ref table, and the refs the Run acts on must come from the full one.
      const [text, form, snap, url] = batch(["get text body", "snapshot -i -s form", "snapshot -i --urls", "get url"]);
      if (!snap?.success) throw new BrowserError(snap?.error ?? "snapshot failed");
      const formText = form?.success ? form.result?.snapshot ?? "" : "";
      const formRefs = new Set([...formText.matchAll(/ref=(e\d+)/g)].map((m) => m[1]));
      return {
        snapshot: withoutBoundaries(snap.result?.snapshot ?? ""),
        // The interactive snapshot has no prose, and the result a goal asks
        // for is usually prose: without it the Driver can never see `done`.
        text: withoutBoundaries(text?.success ? text.result?.text ?? "" : "").slice(0, PAGE_TEXT_CHARS),
        formRefs,
        url: url?.result?.url ?? null,
      };
    },

    /** The `type` attribute of each ref; null where it has none. */
    types(refs) {
      const results = batch(refs.map((ref) => `get attr @${ref} type`));
      return new Map(refs.map((ref, i) => [ref, results[i]?.success ? results[i].result?.value ?? null : null]));
    },

    click: (ref) => run(["click", `@${ref}`]),
    fill: (ref, text) => run(["fill", `@${ref}`, text]),
    press: (key) => run(["press", key]),
    scroll: (direction) => run(["scroll", direction, "600"]),
    wait: (ms) => run(["wait", String(ms)]),
  };
}
