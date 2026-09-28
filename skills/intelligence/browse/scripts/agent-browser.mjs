// ──────────────────────────────────────────────────────────────────────
//  The only module that runs agent-browser. Everything above it sees a
//  page as plain data, so the Run can be tested without a browser.
// ──────────────────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hostsOf } from "./origins.mjs";

const MARK_SUBMITS = fileURLToPath(new URL("./mark-submits.js", import.meta.url));

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
  const flags = ["--max-output", String(MAX_OUTPUT), "--init-script", MARK_SUBMITS];
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

const PAGE_READS = [["get", "text", "body"], ["snapshot", "-i", "--urls"], ["get", "url"]];

function readPage([text, snap, url]) {
  if (!snap?.success) throw new BrowserError(snap?.error ?? "snapshot failed");
  return {
    snapshot: withoutBoundaries(snap.result?.snapshot ?? ""),
    // The interactive snapshot has no prose, and the result a goal asks
    // for is usually prose: without it the Driver can never see `done`.
    text: withoutBoundaries(text?.success ? text.result?.text ?? "" : "").slice(0, PAGE_TEXT_CHARS),
    url: url?.result?.url ?? null,
  };
}

/**
 * Every call to agent-browser costs ~160 ms however little it does, and a
 * batch of several commands costs about the same as one. So each method
 * here is one call, and an action carries the next page read with it.
 *
 * @param {object} opts
 * @param {string} opts.session
 * @param {string} [opts.bin]
 */
export function agentBrowser({ session, bin = process.env.BROWSE_AGENT_BROWSER || "agent-browser" }) {
  const run = (args, input) => {
    let out;
    try {
      out = execFileSync(bin, ["--session", session, "--json", ...args], {
        encoding: "utf8",
        timeout: 30000,
        input,
        stdio: ["pipe", "pipe", "pipe"],
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
  // Commands go as argv arrays on stdin: no quoting, and a typed value
  // never appears on a command line other processes can read.
  const batch = (commands, bail = false) =>
    (commands.length ? run(["batch", ...(bail ? ["--bail"] : [])], JSON.stringify(commands)) : []);

  return {
    close() {
      try { run(["close"]); } catch { /* nothing open */ }
    },

    launch(url, flags) {
      run([...flags, "open", url]);
    },

    /** The page as the Run sees it: visible text, interactive elements, URL. */
    page() {
      return readPage(batch(PAGE_READS));
    },

    /**
     * Which of `buttons` would submit a form, and the `type` of each of
     * `fields` (null where it has none). One call for both.
     */
    attrs(buttons, fields) {
      const results = batch([
        ...buttons.map((ref) => ["get", "attr", `@${ref}`, "data-browse-submits"]),
        ...fields.map((ref) => ["get", "attr", `@${ref}`, "type"]),
      ]);
      const value = (i) => (results[i]?.success ? results[i].result?.value ?? null : null);
      return {
        submits: new Set(buttons.filter((_, i) => value(i) !== null)),
        types: new Map(fields.map((ref, i) => [ref, value(buttons.length + i)])),
      };
    },

    /** Perform one action and read the page it leaves, in one call. */
    act(command) {
      const [result, ...reads] = batch([command, ...PAGE_READS], true);
      if (!result?.success) throw new BrowserError(result?.error ?? `${command[0]} failed`);
      return readPage(reads);
    },
  };
}
