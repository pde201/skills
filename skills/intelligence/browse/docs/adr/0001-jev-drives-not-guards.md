# Jev drives the browser rather than guarding it

Everywhere else in this repository Jev is a guard: it scores a call the agent already chose and allows, asks or blocks it. In Browse, Jev is the Driver instead. It chooses each next action from the Candidates offered to it, and the agent sets the goal, supplies text and verifies the result. We chose driving because a small, fast, non-generative model picking among a filtered set is quicker and cheaper per step than the agent reasoning about every click, and because the prior art (`wy-coliney/jev-browser-use`, `browser-use/jev-ultrafast`) shows the step works. Safety therefore comes from what the Driver is allowed to choose, not from a second opinion on what it chose: Consequential controls are never Candidates on an Untrusted origin, typing has a stricter confidence floor than clicking, and agent-browser's own action policy and domain allowlist stay on.

## Considered Options

- **Guard** (jev's existing role, applied to `agent-browser` calls). Rejected for now: nobody has built it, but it leaves the agent doing all the slow per-step reasoning.
- **Drive and guard.** Rejected as two model roles to tune at once before either is measured.

## Consequences

- Page text can still steer which allowed Candidate the Driver picks (TypeSafe documents that injected state "can move the answer"). The Candidate filter bounds what a steered choice can do; it does not prevent the steering.
- A Handback with status `done` is a claim, not a result. The agent must verify it.
