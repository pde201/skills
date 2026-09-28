# browse

Browser use for Claude Code. [agent-browser](https://github.com/vercel-labs/agent-browser) drives Chrome; TypeSafe's Jev model, through the [jev](../jev) skill's client, chooses each next action; Claude sets the goal, supplies text and verifies the result.

The words used here (Driver, Run, Handback, Candidate, Consequential control, Named value, trusted origin) are defined in [CONTEXT.md](./CONTEXT.md). Why Jev drives instead of guarding, and why it never sees typed text, are in [docs/adr](./docs/adr).

## Install

```bash
npm i -g agent-browser && agent-browser install     # the browser
../jev/install-skill.sh                             # jev's client, beside browse
./install.sh                                        # this skill, into ~/.claude/skills
export TYPESAFE_API_KEY=...
```

`install.sh` checks all three and says what is missing. browse finds jev at `../jev` relative to its own directory (both in this repository and in a skills directory), or at `BROWSE_JEV_LIB`.

## How a Run works

Each step (`scripts/run.mjs`):

1. Read the page: its visible text, its interactive elements (`snapshot -i --urls`), which of them sit inside a form, and the `type` of buttons and fields that need it.
2. Build the Candidates (`scripts/candidates.mjs`): visible, named, interactive elements, minus duplicates. On an untrusted origin, Consequential controls are withheld: labels like buy, send or delete; buttons that submit a form; links to another origin. Named values become `Type value "email" into textbox "Email"`; a Secret value is offered only for a password field on the starting or a trusted origin. At most 255 options, controls included.
3. Ask Jev one `choice` question (`scripts/driver.mjs`). Option labels are sent unredacted; the page state goes through jev's redaction.
4. Check the answer: it must carry a confidence and pick its own most probable option; a click needs 0.55, typing 0.75 (`BROWSE_MIN_CONFIDENCE`, `BROWSE_MIN_TYPE_CONFIDENCE`).
5. Re-read the page. If it changed while Jev decided, choose again rather than act on a stale ref.
6. Act, or hand back.

A Run whose origins are all trusted launches agent-browser with only an output cap. Any other Run is strict: `--content-boundaries`, a domain allowlist (unless `--profile`), and an action policy denying `evaluate`, uploads, downloads, cookie and storage access, network routing, state export and the clipboard. agent-browser's policy matches its internal action names, which are not the documented category names (`evaluate`, not `eval`); `scripts/agent-browser.mjs` lists the ones verified against 0.27.

Session metadata (tier, starting origin, the last ten steps) lives in `~/.browse` (`BROWSE_STATE_DIR`), owner-only. Values are never written there.

## Tests

```bash
npm test          # offline: candidates, the Run loop against a fake browser, the Driver against a mocked API
npm run eval:live # real agent-browser and Jev on a local fixture site; skips without a key
```

The live eval serves `evals/site` on `localhost` (trusted) and `0.0.0.0` (untrusted) and checks three Runs: navigating to a fact, filling a login form and stopping at its submit despite injected page text, and handing back a withheld purchase.

## Limits

- Page text can still steer which allowed Candidate Jev picks. The filter bounds what a steered choice can do; it does not stop the steering.
- Consequential controls are recognised by label, form membership and link target. A control that does something lasting through script, with an innocent label and outside a form, is not caught.
- Selects, uploads, drag and drop, iframes and canvas are not offered to the Driver; Claude handles them directly.
- Claude Code only.
