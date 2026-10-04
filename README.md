# pi-subagents

A [pi](https://pi.dev) extension for delegating tasks to subagents. Each subagent is a separate
`pi --mode rpc` process with its own context window. When a call leaves the agent, model, or effort
open, [Jev](https://docs.typesafe.ai) (through Pi's own classifier models,
`ctx.modelRegistry.classify`) picks them in one request per task.

## The `subagent` tool

`action: "run"` (the default) takes one of:

- `task` (with optional `agent`, `model`, `thinking`): a single task;
- `tasks: [{ agent?, task, cwd?, model?, thinking? }]`: up to 8 in parallel, 4 at a time;
- `chain: [...]`: steps in order; `{previous}` in a step's task is replaced by the previous output,
  and the chain stops at the first failed step.

Options: `async` (default false) returns the run ids at once and delivers the results as a
`subagent-result` message that starts a turn; `context: "fork"` starts children from this
conversation (`--fork` of the session file) instead of fresh; `worktree: true` runs each task in a
new checkout from `worktree new subagent/<slug>-<id> --no-open`; `cwd`.

`action: "status" | "steer" | "stop" | "result"` take an `id` (or unique prefix); `steer` also takes
`message`, delivered to the running child as a steering message. `status` without an id lists runs.

The result is each child's final reply, cut to 2,000 lines or 50 KB, with the full text in
`~/.pi/agent/subagents/<id>/output.md`. The children's token usage and cost are added to the tool
result, so they count in the session totals. The tool row shows each run's agent, model, effort
(marked "(Jev)" where Jev chose), status, time, turns, cost, and current activity.

Dialogs a child's extensions open (for example a tool gate asking for approval) are forwarded to
your UI, prefixed with the agent's name. Async runs report to herdr-attention-queue through
`herdr:background` events. Run records are saved as `subagents:run` session entries; `/subagents`
lists them.

## Agents

`~/.pi/agent/agents/*.md` and the nearest `<project>/.pi/agents/*.md` (project files win), plus a
built-in `general`:

```markdown
---
name: scout
description: "Fast read-only recon: returns the relevant files, types, and functions"
tools: read, grep, find, ls, bash
model: anthropic/claude-haiku-5
thinking: low
---
You are a scout. ...
```

`tools`, `model`, and `thinking` are optional; the body is appended to the child's system prompt.
Quote descriptions that contain a colon.

## How each choice is made

For the agent, the model, and the thinking level separately: explicit arguments, then the agent
file, then Jev, then the defaults (`general`, the balanced tier, the parent's model and thinking
level). Jev picks the agent when its confidence is at least 0.5, a model tier (fast, balanced,
strong) when tiers are configured (below 0.4 confidence: balanced), and the effort (0-3 to low,
medium, high, xhigh). Children always get an explicit `--thinking`, so pi-auto-effort stays off in
them. Without Jev, the defaults apply.

On 15 tasks across six agents, Jev picked the expected agent every time, in about 100-300 ms
(`npm run eval`).

## Settings

`~/.pi/agent/pi-subagents.json`, with `<project>/.pi/pi-subagents.json` merged on top:

```json
{
  "tiers": {
    "fast": "anthropic/claude-haiku-5",
    "balanced": "anthropic/claude-sonnet-5-5",
    "strong": "anthropic/claude-opus-5-5"
  },
  "jev": { "enabled": true, "provider": "typesafe", "model": "jev-latest", "timeoutMs": 3000 },
  "maxParallel": 8,
  "concurrency": 4
}
```

A tier left out uses the parent's model. `tierDescriptions` overrides what Jev reads for each tier.
Requires Pi 0.99 or newer for classifier models.

## Development

```sh
npm run check   # typecheck and unit tests (a fake RPC child stands in for pi)
npm run eval    # 15 tasks against live Jev through the installed Pi (needs TYPESAFE_API_KEY)
```
