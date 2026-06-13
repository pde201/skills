#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function usage() {
  console.log(`Install the Acuity xiaohei-illustrations skill.

Usage:
  npx --yes github:pde201/skills/skills/cognition/xiaohei-illustrations [codex|claude] [--force]
  npx --yes github:pde201/skills/skills/cognition/xiaohei-illustrations --dest /path/to/skills-dir [--force]

Targets:
  codex   Install to \${CODEX_HOME:-$HOME/.codex}/skills
  claude  Install to \${CLAUDE_HOME:-$HOME/.claude}/skills

Options:
  --dest DIR  Install into a custom skills directory
  --force     Replace an existing xiaohei-illustrations install
  -h, --help  Show this help`);
}

function parseArgs(argv) {
  const args = [...argv];
  let target = "codex";
  let destBase = "";
  let force = false;

  while (args.length) {
    const arg = args.shift();
    if (arg === "codex" || arg === "claude") {
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

function copyFileIfExists(source, destination) {
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, destination);
  }
}

function defaultDestBase(target) {
  if (target === "claude") {
    return path.join(process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude"), "skills");
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
  const destDir = path.join(destBase, "xiaohei-illustrations");
  const tempDir = path.join(destBase, `.xiaohei-illustrations.tmp.${process.pid}`);

  if (fs.existsSync(destDir) && !options.force) {
    console.error(`error: ${destDir} already exists

Run with --force to replace it:
  npx --yes github:pde201/skills/skills/cognition/xiaohei-illustrations ${options.target} --force`);
    process.exit(1);
  }

  fs.mkdirSync(destBase, { recursive: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });
  fs.copyFileSync(skillFile, path.join(tempDir, "SKILL.md"));

  const referencesDir = path.join(repoRoot, "references");
  if (fs.existsSync(referencesDir)) {
    copyDir(referencesDir, path.join(tempDir, "references"));
  }

  const examplesDir = path.join(repoRoot, "examples");
  if (fs.existsSync(examplesDir)) {
    copyDir(examplesDir, path.join(tempDir, "examples"));
  }

  copyFileIfExists(path.join(repoRoot, "LICENSE"), path.join(tempDir, "LICENSE"));
  copyFileIfExists(path.join(repoRoot, "NOTICE.md"), path.join(tempDir, "NOTICE.md"));

  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  fs.renameSync(tempDir, destDir);

  console.log("Installed xiaohei-illustrations to:");
  console.log(`  ${destDir}`);
  console.log("");
  console.log("Restart your agent to pick up the new skill.");
}

main();
