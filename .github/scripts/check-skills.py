#!/usr/bin/env python3
"""Check every skill's metadata and the repository's install instructions.

- SKILL.md frontmatter parses as YAML and has a name and description
- the name matches the directory holding SKILL.md
- the description fits the 1024-character limit
- no document tells people to run `npx github:pde201/skills/...`, which npm
  cannot install (it has no way to install from a repo subdirectory)
"""
import pathlib
import re
import subprocess
import sys

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
errors = []

skill_files = sorted(ROOT.glob("skills/*/*/SKILL.md")) + sorted(ROOT.glob("skills/*/*/*/SKILL.md"))
if not skill_files:
    errors.append("no SKILL.md files found")

for path in skill_files:
    rel = path.relative_to(ROOT)
    text = path.read_text(encoding="utf-8")
    match = re.match(r"---\n(.*?)\n---\n", text, re.S)
    if not match:
        errors.append(f"{rel}: missing frontmatter")
        continue
    try:
        meta = yaml.safe_load(match.group(1))
    except yaml.YAMLError as error:
        errors.append(f"{rel}: frontmatter is not valid YAML: {error}")
        continue
    name = meta.get("name") if isinstance(meta, dict) else None
    description = meta.get("description") if isinstance(meta, dict) else None
    if not name or not description:
        errors.append(f"{rel}: frontmatter needs a name and a description")
        continue
    if name != path.parent.name:
        errors.append(f"{rel}: name '{name}' does not match its directory '{path.parent.name}'")
    if len(description) > 1024:
        errors.append(f"{rel}: description is {len(description)} characters (limit 1024)")
    print(f"ok  {name}  ({len(description)}-char description)")

tracked = subprocess.run(
    ["git", "ls-files", "*.md", "*.js", "*.mjs", "*.sh", "*.py", "*.html"],
    cwd=ROOT, capture_output=True, text=True, check=True,
).stdout.split()
dead_install = re.compile(r"npx (--yes |-y )?github:pde201/skills/")
for rel in tracked:
    if rel == ".github/scripts/check-skills.py":
        continue
    for number, line in enumerate((ROOT / rel).read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        if dead_install.search(line):
            errors.append(f"{rel}:{number}: `npx github:` cannot install from a subdirectory; use skills.sh or ./install.sh")

if errors:
    print("\n".join(errors), file=sys.stderr)
    sys.exit(1)
