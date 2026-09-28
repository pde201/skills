#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────
//  browse — start or continue a Run, print its Handback as JSON.
//
//    browse run --goal TEXT [--url URL] [--session NAME]
//               [--value NAME=TEXT]... [--secret NAME=env:VAR]...
//               [--allow-origin ORIGIN]... [--max-steps N]
//               [--profile NAME] [--headed]
//    browse close [--session NAME]
//
//  A Secret value is read from the environment, never the command line,
//  so it stays out of the transcript and shell history.
// ──────────────────────────────────────────────────────────────────────

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { agentBrowser } from "./agent-browser.mjs";
import { choose, loadClient, MAX_OPTIONS } from "./driver.mjs";
import { parseTrustedOrigins } from "./origins.mjs";
import { runBrowse } from "./run.mjs";

const USAGE = `usage:
  browse run --goal TEXT [--url URL] [--session NAME] [--value NAME=TEXT]...
             [--secret NAME=env:VAR]... [--allow-origin ORIGIN]... [--max-steps N]
             [--profile NAME] [--headed]
  browse close [--session NAME]

Trusted origins: localhost, plus exact origins in BROWSE_TRUSTED_ORIGINS (comma-separated).`;

const MULTI = new Set(["--value", "--secret", "--allow-origin"]);
const FLAGS = new Set(["--headed"]);
const SINGLE = new Set(["--goal", "--url", "--session", "--max-steps", "--profile"]);

export function parseArgs(argv, env = process.env) {
  const [command, ...rest] = argv;
  const opts = { command, value: [], secret: [], "allow-origin": [] };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const key = flag.slice(2);
    if (FLAGS.has(flag)) opts[key] = true;
    else if (MULTI.has(flag) || SINGLE.has(flag)) {
      if (i + 1 >= rest.length) throw new Error(`${flag} needs a value`);
      if (MULTI.has(flag)) opts[key].push(rest[++i]);
      else opts[key] = rest[++i];
    } else throw new Error(`unknown argument ${flag}`);
  }

  const named = (entry, flag) => {
    const eq = entry.indexOf("=");
    if (eq < 1) throw new Error(`${flag} expects NAME=…, got ${entry}`);
    return [entry.slice(0, eq), entry.slice(eq + 1)];
  };
  const values = opts.value.map((entry) => {
    const [name, text] = named(entry, "--value");
    return { name, text, secret: false };
  });
  for (const entry of opts.secret) {
    const [name, ref] = named(entry, "--secret");
    const variable = /^env:(\w+)$/.exec(ref)?.[1];
    if (!variable) throw new Error(`--secret ${name} must name an environment variable: ${name}=env:VAR`);
    if (!env[variable]) throw new Error(`--secret ${name}: ${variable} is not set`);
    values.push({ name, text: env[variable], secret: true });
  }
  if (opts["max-steps"] !== undefined && !/^[1-9]\d*$/.test(opts["max-steps"])) {
    throw new Error(`--max-steps must be a positive whole number, got ${opts["max-steps"]}`);
  }
  const names = values.map((v) => v.name);
  if (new Set(names).size !== names.length) throw new Error("each value needs a distinct name");

  return {
    command,
    goal: opts.goal,
    url: opts.url,
    session: opts.session || "browse",
    values,
    allowOrigins: opts["allow-origin"],
    maxSteps: opts["max-steps"] ? Number(opts["max-steps"]) : undefined,
    profile: opts.profile,
    headed: Boolean(opts.headed),
  };
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
    if (args.command === "run" && !args.goal) throw new Error("run needs --goal");
    if (!["run", "close"].includes(args.command)) throw new Error(args.command ? `unknown command ${args.command}` : "no command");
  } catch (err) {
    process.stderr.write(`browse: ${err.message}\n${USAGE}\n`);
    return 2;
  }

  const browser = agentBrowser({ session: args.session });
  if (args.command === "close") {
    browser.close();
    return 0;
  }

  const trusted = parseTrustedOrigins(process.env.BROWSE_TRUSTED_ORIGINS);
  if (trusted.rejected.length) {
    process.stderr.write(`browse: ignoring BROWSE_TRUSTED_ORIGINS entries that are not exact origins: ${trusted.rejected.join(", ")}\n`);
  }
  const limit = (await loadClient())?.MAX_CHOICE_OPTIONS ?? MAX_OPTIONS;
  const handback = await runBrowse({ ...args, trustedOrigins: trusted.origins }, { browser, choose, limit });
  process.stdout.write(`${JSON.stringify(handback, null, 2)}\n`);
  return 0;
}

const invokedDirectly = () => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
