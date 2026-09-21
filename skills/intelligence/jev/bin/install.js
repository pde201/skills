#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// Packaging only — this copies the skill into a skills directory. It is not
// the Jev hook installer; that is install.sh inside the skill, run after.
//
// Note the two different meanings of "codex" and "claude" here: this script's
// argument picks which skills *directory* to copy into, while install.sh's
// argument picks which agent's *hooks* to register. One installed copy can
// serve every agent on the machine.
const SELF = "install.js";
const SELF_PATH = __filename;

function usage() {
  console.log(`Install the Acuity jev skill.

Usage (npm's npx cannot resolve a git subdirectory's manifest before
installing, so fetch via a sparse clone instead of "npx github:..."):
  git clone --filter=blob:none --sparse --depth 1 https://github.com/pde201/skills.git /tmp/jev-install
  git -C /tmp/jev-install sparse-checkout set skills/intelligence/jev
  node /tmp/jev-install/skills/intelligence/jev/bin/install.js [codex|claude|antigravity] [--force]
  node /tmp/jev-install/skills/intelligence/jev/bin/install.js --dest /path/to/skills-dir [--force]

Targets:
  codex        Install to \${CODEX_HOME:-$HOME/.codex}/skills
  claude       Install to \${CLAUDE_HOME:-$HOME/.claude}/skills
  antigravity  Install to \${ANTIGRAVITY_HOME:-$HOME/.gemini/config}/skills

Options:
  --dest DIR  Install into a custom skills directory
  --force     Replace an existing jev install
  -h, --help  Show this help

This copies the skill into a skills directory. The agent hooks are registered
separately, by running install.sh from the installed skill directory:

  install.sh              Claude Code
  install.sh codex        Codex
  install.sh antigravity  Antigravity
  install.sh all          all three`);
}

function parseArgs(argv) {
  const args = [...argv];
  let target = "codex";
  let destBase = "";
  let force = false;

  while (args.length) {
    const arg = args.shift();
    if (arg === "codex" || arg === "claude" || arg === "antigravity") {
      target = arg;
    } else if (arg === "--dest") {
      if (!args.length) {
        throw new Error("--dest requires a directory");
      }
      destBase = args.shift();
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return { target, destBase, force };
}

function copyDir(source, destination, skip = new Set()) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (skip.has(entry.name)) {
      continue;
    }
    const sourcePath = path.join(source, entry.name);
    const destPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDir(sourcePath, destPath);
    } else if (entry.isSymbolicLink()) {
      const link = fs.readlinkSync(sourcePath);
      fs.symlinkSync(link, destPath);
    } else {
      fs.copyFileSync(sourcePath, destPath);
      fs.chmodSync(destPath, fs.statSync(sourcePath).mode);
    }
  }
}

function copyFile(source, destination) {
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, fs.statSync(source).mode);
}

function defaultDestBase(target) {
  if (target === "claude") {
    return path.join(process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude"), "skills");
  }
  if (target === "antigravity") {
    return path.join(process.env.ANTIGRAVITY_HOME || path.join(os.homedir(), ".gemini", "config"), "skills");
  }
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "skills");
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}`);
    usage();
    process.exit(2);
  }

  const repoRoot = path.resolve(__dirname, "..");
  const skillFile = path.join(repoRoot, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    console.error(`error: cannot find skill source at ${skillFile}`);
    process.exit(1);
  }

  const destBase = options.destBase || defaultDestBase(options.target);
  const destDir = path.join(destBase, "jev");
  const tempDir = path.join(destBase, `.jev.tmp.${process.pid}`);

  if (fs.existsSync(destDir) && !options.force) {
    console.error(`error: ${destDir} already exists

Run with --force to replace it:
  node ${SELF_PATH} ${options.target} --force`);
    process.exit(1);
  }

  fs.mkdirSync(destBase, { recursive: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });

  // The hook scripts, the engine and the tests are the skill's supporting
  // files: each installer points its agent at a bin/jev-hook*.mjs by absolute
  // path, so bin/ and lib/ have to travel with SKILL.md.
  for (const name of [
    "SKILL.md",
    "README.md",
    "package.json",
    "install.sh",
    "install-codex.sh",
    "install-antigravity.sh",
    "install-skill.sh",
  ]) {
    const source = path.join(repoRoot, name);
    if (fs.existsSync(source)) {
      copyFile(source, path.join(tempDir, name));
    }
  }

  copyDir(path.join(repoRoot, "bin"), path.join(tempDir, "bin"), new Set([SELF]));

  for (const name of ["lib", "test", "references", "evals"]) {
    const source = path.join(repoRoot, name);
    if (fs.existsSync(source)) {
      copyDir(source, path.join(tempDir, name));
    }
  }

  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  fs.renameSync(tempDir, destDir);

  console.log("Installed jev to:");
  console.log(`  ${destDir}`);
  console.log("");
  console.log("The skill is installed; the agent hooks are not yet registered.");
  console.log("To register them:");
  const installer = path.join(destDir, "install.sh");
  console.log(`  ${installer}              # Claude Code`);
  console.log(`  ${installer} codex        # Codex`);
  console.log(`  ${installer} antigravity  # Antigravity`);
  console.log("");
  console.log("Restart your agent to pick up the new skill.");
}

main();
