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
`~/.pi/agent/subagents/<id>/output.md`. Each finished message of the child's conversation is
appended to `messages.jsonl` beside it. The children's token usage and cost are added to the tool
result, so they count in the session totals. The tool row shows each run's agent, model, effort
(marked "(Jev)" where Jev chose), status, time, turns, cost, and current activity.

Dialogs a child's extensions open (for example a tool gate asking for approval) are forwarded to
your UI, prefixed with the agent's name. Async runs report to herdr-attention-queue through
`herdr:background` events. Run records are saved as `subagents:run` session entries.

## Watching subagents

The tool row only updates while its call is open, so an async run would otherwise go quiet until
its result arrives. Three views follow the children while they work (in the TUI only):

- **Widget** (above the editor): one row per running subagent with a spinner, the agent, its task,
  model and effort (Jev's picks marked "(Jev)"), turns, tokens, cost and elapsed time, and its
  current tool or text beneath. Tasks waiting for a slot show as queued. A finished run stays 8
  seconds with a status icon (20 if it failed or was stopped), then the widget hides. By default it
  shows async runs only, since a foreground run already renders in its tool row.
- **FleetView** (below the editor): `main` and every running subagent, with elapsed time and
  tokens. Press `↓` (or `←`) at an empty prompt to move into it, `↑`/`↓` to select, `Enter` to open
  the selected run's conversation, `x` twice to stop it, and `Esc` (or `↑` past `main`) to return
  to the prompt. Finished
  runs stay 5 seconds; a run whose conversation is open stays until you close it.
- **Conversation viewer** (an overlay): the child's conversation as it streams, with tool calls,
  results, live tool output, queued steering messages and current activity. It follows new output
  until you scroll up (`↑`/`↓`, `PgUp`/`PgDn`, `Home`/`End`). `Enter` opens a composer that steers
  the child, `x` twice stops it, and `Esc` or `q` closes the viewer. It stays open when the run
  ends.

`/subagents` lists this session's runs, live or recorded, and opens the one you pick in the viewer;
`/subagents <id>` (or a unique prefix) opens one directly. `/subagents stop <id>` stops a run, and
`/subagents stop all` stops every running one. Runs from before a `/reload` or a
resumed session open from their `messages.jsonl`.

The children stay `pi --mode rpc` processes: the views are rebuilt from their RPC event streams.

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
  "concurrency": 4,
  "widget": "background",
  "fleetView": true
}
```

A tier left out uses the parent's model. `tierDescriptions` overrides what Jev reads for each tier.
`widget` is `"background"` (async runs only), `"all"`, or `"off"`; `fleetView: false` turns the
list below the editor off. Requires Pi 0.99 or newer for classifier models.

## Development

```sh
npm run check   # typecheck and unit tests (a fake RPC child stands in for pi)
npm run eval    # 15 tasks against live Jev through the installed Pi (needs TYPESAFE_API_KEY)
```

## Credits

The widget, FleetView and conversation viewer are adapted from
[@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) by tintinweb (MIT; see
`LICENSE`), ported to this extension's RPC children, run records and Jev picks.
