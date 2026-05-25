# Acuity Agent Skills

A collection of public, high-precision agentic coding skills designed to optimize developer-agent collaboration, planning speeds, and visual deliverables.

## Skill Categories

### 📂 workflow
Enforce process discipline, automate task checklists, and manage git/issue tracker lifecycles.
* **[prd-lifecycle](./skills/workflow/prd-lifecycle/SKILL.md)**: Manage parent PRD and child implementation issue lifecycles in GitHub with automated verification checks and closing walkthrough documentation.
  * **Install**: `npx --yes github:pde201/skills/skills/workflow/prd-lifecycle`

### 📂 intelligence
Improve agent reasoning speeds, minimize planning latency, and support speculative branching.
* **[ssd](./skills/intelligence/ssd/SKILL.md)**: One-step speculative branching to hide planning latency for slow steps in multi-step plans.
  * **Install**: `npx --yes github:pde201/skills/skills/intelligence/ssd`

### 📂 cognition
Help agents visually communicate complex layouts (like charts, specs, and interactive HTML artifacts) to humans.
* **[effective-html](./skills/cognition/effective-html/create-html-artifacts/SKILL.md)**: Generate responsive, interactive, and self-contained HTML browser artifacts for plans, spec plans, and custom visualizations.
  * **Install**: `npx --yes github:pde201/skills/skills/cognition/effective-html`

---

## Global Installation
To install any skill globally for your detected agent environment (e.g. Codex, Claude Code), run the corresponding `npx` installer command listed above. 

Example:
```bash
npx --yes github:pde201/skills/skills/workflow/prd-lifecycle --force
```

Restart your agent after installation to discover the new skill.
