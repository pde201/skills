# Acuity Agent Skills

A collection of public, high-precision agentic coding skills designed to optimize developer-agent collaboration, planning speeds, and visual deliverables.

## Skill Categories

### 📂 workflow
Enforce process discipline, automate task checklists, and manage git/issue tracker lifecycles.
* **[prd-lifecycle](./skills/workflow/prd-lifecycle/SKILL.md)**: Manage parent PRD and child implementation issue lifecycles in GitHub with automated verification checks and closing walkthrough documentation.
  * **Install**: `npx --yes skills add pde201/skills --skill prd-lifecycle --global`

### 📂 intelligence
Improve agent reasoning speeds, spend less of the context window, minimize planning latency, and support speculative branching.
* **[jev](./skills/intelligence/jev/SKILL.md)**: Hooks for Claude Code, Codex and Antigravity that slim bloated tool output, guard risky tool calls, and carry a brief across compaction, using TypeSafe's Jev for the judgments.
  * **Install**: `npx --yes skills add pde201/skills --skill jev --global`, then run `install.sh` from the installed copy to register the hooks (see its [README](./skills/intelligence/jev/README.md))
* **[ssd](./skills/intelligence/ssd/SKILL.md)**: One-step speculative branching to hide planning latency for slow steps in multi-step plans.
  * **Install**: `npx --yes skills add pde201/skills --skill ssd --global`

### 📂 cognition
Help agents visually communicate ideas, layouts, and illustrations (charts, specs, interactive HTML artifacts, hand-drawn figures) to humans.
* **[effective-html](./skills/cognition/effective-html/effective-html/SKILL.md)**: Generate responsive, interactive, and self-contained HTML browser artifacts for plans, spec plans, and custom visualizations.
  * **Install**: `npx --yes skills add pde201/skills --skill effective-html --global`
* **[xiaohei-illustrations](./skills/cognition/xiaohei-illustrations/SKILL.md)**: Generate quirky, hand-drawn "Xiaohei" explanatory illustrations (16:9, pure-white, sparse English labels) for articles, blog posts, and docs.
  * **Install**: `npx --yes skills add pde201/skills --skill xiaohei-illustrations --global`

---

## Installation
Each skill installs with the [skills.sh](https://skills.sh) CLI, using the command listed above. It detects your agent (Claude Code, Codex and others); pass `--agent claude-code` or `--agent codex` to choose one, or drop `--global` to install into the current project.

To see every skill in this repo:
```bash
npx --yes skills add pde201/skills --list
```

Without the skills CLI, clone the repo and run a skill's own installer:
```bash
git clone https://github.com/pde201/skills.git
./skills/skills/workflow/prd-lifecycle/install.sh claude    # or codex; --force replaces an existing install
```

`npx github:pde201/skills/...` does not work: npm cannot install a package from a subdirectory of a git repository.

Restart your agent after installation to discover the new skill.
