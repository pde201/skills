#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function usage() {
  console.log(`Install the Acuity effective-html skill.

Usage:
  npx --yes github:pde201/skills/skills/cognition/effective-html [agents|codex|claude] [--force]
  npx --yes github:pde201/skills/skills/cognition/effective-html --dest /path/to/skills-dir [--force]

Targets:
  agents  Install to \${AGENTS_HOME:-$HOME/.agents}/skills (default)
  codex   Install to \${CODEX_HOME:-$HOME/.codex}/skills
  claude  Install to \${CLAUDE_HOME:-$HOME/.claude}/skills

Options:
  --dest DIR  Install into a custom skills directory
  --force     Replace an existing create-html-artifacts install
  -h, --help  Show this help`);
}

function parseArgs(argv) {
  const args = [...argv];
  let target = "agents";
  let destBase = "";
  let force = false;

  while (args.length) {
    const arg = args.shift();
    if (arg === "agents" || arg === "generic" || arg === "codex" || arg === "claude") {
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

function copyDir(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
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

function defaultDestBase(target) {
  if (target === "claude") {
    return path.join(process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude"), "skills");
  }
  if (target === "codex") {
    return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "skills");
  }
  return path.join(process.env.AGENTS_HOME || path.join(os.homedir(), ".agents"), "skills");
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
  const sourceDir = path.join(repoRoot, "create-html-artifacts");
  if (!fs.existsSync(path.join(sourceDir, "SKILL.md"))) {
    console.error(`error: cannot find skill source at ${sourceDir}`);
    process.exit(1);
  }

  const destBase = options.destBase || defaultDestBase(options.target);
  const destDir = path.join(destBase, "create-html-artifacts");
  const tempDir = path.join(destBase, `.create-html-artifacts.tmp.${process.pid}`);

  if (fs.existsSync(destDir) && !options.force) {
    console.error(`error: ${destDir} already exists

Run with --force to replace it:
  npx --yes github:pde201/skills/skills/cognition/effective-html ${options.target} --force`);
    process.exit(1);
  }

  fs.mkdirSync(destBase, { recursive: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
  copyDir(sourceDir, tempDir);

  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  fs.renameSync(tempDir, destDir);

  console.log("Installed create-html-artifacts to:");
  console.log(`  ${destDir}`);
  console.log("");
  console.log("Restart your agent to pick up the new skill.");
}

main();
