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

1. Read the page: its visible text, its interactive elements (`snapshot -i --urls`), which buttons would submit a form, and which fields take passwords. Form submits are marked in the page by `scripts/mark-page.js`, an init script that asks the browser itself (`el.form`, `el.type`); a CSS-scoped snapshot only ever sees a page's first form.
2. Build the Candidates (`scripts/candidates.mjs`): visible, named, interactive elements, minus duplicates. On an untrusted origin, Consequential controls are withheld: labels like buy, send or delete; controls that submit a form; links to another origin. Named values become `Type value "email" into textbox "Email"`; a Secret value is offered only for a password field on the starting or a trusted origin. At most 255 options, controls included.
   A **Site search** is offered even on untrusted origins: `Search for value "…" in searchbox "…" and open the results` for a field `mark-page.js` marked (search-like, in a form that GETs this origin), and `Search this site for value "…" and open the results` when the page links an OpenSearch description whose HTML template is a GET on this origin (`scripts/opensearch.mjs`, fetched from Node and cached). Never with a Secret value; the typing floor applies.
3. Ask Jev one `choice` question (`scripts/driver.mjs`). Option labels are sent unredacted; the page state goes through jev's redaction.
4. Check the answer: it must carry a confidence and pick its own most probable option; a click needs 0.55, typing 0.75 (`BROWSE_MIN_CONFIDENCE`, `BROWSE_MIN_TYPE_CONFIDENCE`).
5. Re-read the page. If the chosen element changed or disappeared while Jev decided, or anything new appeared (snapshots do not show dialogs, but an overlay brings controls of its own), choose again. Refs stay bound to one element, so other changes — a clock, a removed banner — do not move the click and do not cost a re-decide.
6. Act, or hand back. The action and the next step's page read go in one agent-browser call.

Every agent-browser call costs about 160 ms however little it does, while a batch of commands costs about the same as one, so `scripts/agent-browser.mjs` makes each method one call and sends commands as JSON on stdin (which also keeps typed values off the command line). A step is two or three calls plus one Jev request (~130 ms).

A new Run relaunches Chrome (~1 s) unless it passes `--reuse` and the running session was launched with the same tier, allowed origins and profile; then it only opens the URL. Reuse keeps cookies and logins, so it is opt-in.

A Run whose origins are all trusted launches agent-browser with only an output cap. Any other Run is strict: `--content-boundaries`, a domain allowlist (unless `--profile`), and an action policy denying `evaluate`, uploads, downloads, cookie and storage access, network routing, state export and the clipboard. agent-browser's policy matches its internal action names, which are not the documented category names (`evaluate`, not `eval`); `scripts/agent-browser.mjs` lists the ones verified against 0.27.

Session metadata (tier, starting origin, the last ten steps) lives in `~/.browse` (`BROWSE_STATE_DIR`), owner-only. Values are never written there.

## Tests

```bash
npm test          # offline: candidates, the Run loop against a fake browser, the Driver against a mocked API
npm run eval:live # real agent-browser and Jev on a local fixture site; skips without a key
```

The live eval serves `evals/site` on `localhost` (trusted) and `0.0.0.0` (untrusted) and checks six Runs: navigating to a fact; filling a login form and stopping at its submit despite injected page text; withholding the submit button of a page's second form; a Site search through a GET search form; a Site search through a published OpenSearch template on a script-driven page; and handing back a withheld purchase.

## Limits

- Page text can still steer which allowed Candidate Jev picks. The filter bounds what a steered choice can do; it does not stop the steering.
- Consequential controls are recognised by label, form membership and link target. A control that does something lasting through script, with an innocent label and outside a form, is not caught.
- A Site search is verified from the markup: the field's form, and the form's default button, submit by GET to the same origin. A page script that handles Enter itself, or an autocomplete suggestion, can still do something else; the domain allowlist bounds where that can go, and with `--profile` there is no allowlist.
- Selects, uploads, drag and drop, iframes and canvas are not offered to the Driver; Claude handles them directly.
- Claude Code only.
