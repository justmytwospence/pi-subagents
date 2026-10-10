# pi-subagents

A [pi](https://pi.dev) extension for delegating tasks to subagents. Each subagent is a separate
`pi --mode rpc` process with its own context window. When a call leaves the agent, model, or effort
open, [Jev](https://docs.typesafe.ai) (through Pi's own classifier models,
`ctx.modelRegistry.classify`) picks them in one request per task.

## The `subagent` tool

`action: "run"` (the default) takes one of:

- `task` (with optional `label`, `agent`, `model`, `thinking`): a single task;
- `tasks: [{ label?, agent?, task, cwd?, model?, thinking? }]`: up to 8 in parallel, 4 at a time;
- `chain: [...]`: steps in order; `{previous}` in a step's task is replaced by the previous output,
  and the chain stops at the first failed step.

Use headless subagents by default for delegated work that reports back to the parent, even when
long or multistep. An interactive Herdr child is for an explicit request or a clearly persistent,
human-led session or handoff.

`label` is a short task name, not an agent role (for example, `"Audit cache invalidation"` with
`agent: "reviewer"`). Lists, headings and forwarded approval dialogs show the task name first and the role second. Labels are
whitespace-normalized and stripped of terminal controls, without a fixed length cap. FleetView and
widget descriptions use the available width and wrap when necessary instead of dropping task text. A missing
or blank label uses the task’s first nonempty line (without a Markdown heading/list prefix), without
any model call. Each chain step gets its own stable label before `{previous}` is expanded. The full
task is still sent to the child and saved in run records; older records derive a label when opened.

Options: `async` (default false) returns the run ids at once and delivers the results as a
`subagent-result` message that starts a turn; `context: "fork"` starts children from this
conversation (`--fork` of the session file) instead of fresh; `worktree: true` runs each task in a
new checkout from `worktree new subagent/<slug>-<id> --no-open`; `cwd`. Set `worktree` only when the
user requests a worktree or branch isolation; otherwise ask first. The child remains headless.

`action: "status" | "steer" | "stop" | "result"` take an `id` (or unique prefix); `steer` also takes
`message`, delivered to the running child as a steering message. `status` without an id lists runs.

The result is each child's final reply, cut to 2,000 lines or 50 KB, with the full text in
`~/.pi/agent/subagents/<id>/output.md`. Each finished message of the child's conversation is
appended to `messages.jsonl` beside it. The children's token usage and cost are added to the tool
result, so they count in the session totals. The tool row shows each run's task label, agent role, model, effort
(marked "(Jev)" where Jev chose), status, time, turns, cost, and current activity.

Dialogs a child's extensions open (for example a tool gate asking for approval) are forwarded to
your UI, prefixed with the agent's name. Async runs hold `herdr:background` on pi's event bus
while they run, which [pi-herdr](https://github.com/justmytwospence/pi-herdr) shows in herdr's sidebar. Run records are saved as `subagents:run` session entries.

## Watching subagents

The tool row only updates while its call is open, so an async run would otherwise go quiet until
its result arrives. The views follow the children while they work (in the TUI only), laid out as
in Claude Code (2.1.296):

- **FleetView**, Claude Code's subagent panel below the prompt: `main` and every running subagent,
  with elapsed time and tokens. Press `↓` at the bottom of the prompt to move into it, even with a
  draft in it (the first `↓` moves the cursor to the end of the draft, as in Claude Code; `j` in
  pi-vim's normal mode does the same, and `←` works at an empty prompt), `↑`/`↓` or `k`/`j` to
  select, `Enter` or `l` to open the selected run's conversation, `x` twice to stop it, `b` to move a
  foreground run to the background (the tool call returns and the result arrives as a message,
  like `async`), and `Esc` or `h` (or `↑` past `main`) to return to the prompt. As in Claude Code, a run
  that succeeds leaves at once and a dim `/subagents to see subagents` (`/tasks ...` with pi-bg)
  shows for 30 seconds; a failed or stopped run stays until your next message (one you type: a
  message another extension sends does not count), or `x` dismisses it.
  A run whose conversation is open stays until you close it. Selection and stop-arming follow the
  row, not its position, so rows coming and going never move them onto another run.
- **Conversation viewer**, full screen under an accent-colored banner (`◀ esc · Find config · scout ·
  not your main session`), as in Claude Code and Codex: the child's conversation as it streams, with tool calls,
  results, live tool output, queued steering messages and current activity. It follows new output
  until you scroll up (`↑`/`↓`, `PgUp`/`PgDn`, `Home`/`End`). `Enter` opens a composer that steers
  the child, `x` twice stops it, `b` moves a foreground run to the background, `m` cycles Markdown rendering (assistant text, tool results too,
  or none), and `Esc` or `q` closes the viewer. It stays open when the run ends.
- **Widget** above the editor, off by default (Claude Code has none): `"widget": "background"` (async
  runs) or `"all"` turns it on. One row per running subagent with a spinner, the task label and agent role,
  model and effort (Jev's picks marked "(Jev)"), turns, tokens, cost and elapsed time, and its
  current tool or text beneath; queued tasks; a finished run for 8 seconds, a failed or stopped one
  until your next message (several sharing one row). Double-click a row (fullscreen mode) to open
  that run's conversation.

A result that comes due while the agent is working waits for the turn to settle before it is sent
(a follow-up queued mid-turn is dropped when you press Esc); several go out as one message. A run
that ends after its session is gone (`/reload`, `/new`) calls nothing in pi.

`/subagents` lists this session's runs, live or recorded, and opens the one you pick in the viewer;
`/subagents <id>` (or a unique prefix) opens one directly. `/subagents stop <id>` stops a run, and
`/subagents stop all` stops every running one. Runs from before a `/reload` or a
resumed session open from their `messages.jsonl`.

The children stay `pi --mode rpc` processes: the views are rebuilt from their RPC event streams.

## With pi-bg

Both work alone. With [pi-bg](https://github.com/justmytwospence/pi-bg) installed too, they work
as one, as in Claude Code, through pi's event bus (the activity protocol in `src/activity.ts`,
copied into both repos):

- **One list under the prompt.** FleetView ends with pi-bg's pill (`2 shells`, `· 1 failed`); `↓`
  moves through the subagents to it, and Enter opens pi-bg's background-tasks dialog. pi-bg draws
  no pill of its own then. With FleetView off (`"fleetView": false`) or outside the TUI, pi-bg shows
  its own.
  pi-marimo's notebooks work the same way: FleetView ends with their pill (`1 notebook`) too, and
  Enter on it opens the busiest notebook full screen.
- **One list.** pi-bg's `/tasks` view lists this session's runs mixed in with its shells, tagged `agent`: Enter opens a
  run's conversation, `x` twice stops it, `x` on an ended one dismisses it. Task labels are primary;
  agent roles are secondary.
- **Waiting on async runs.** Each async run is outside work pi-bg's `bg_wait subagent:<id>` can
  wait on inside the turn, so the agent shows as working (in pi, herdr and tmux) until the run
  ends; the async result names the ids. A chain's steps say the chain goes on. The result still
  arrives as its own message.

## Agents

Built-in roles work without any agent files:

- `general`: unrestricted general-purpose delegation;
- `explorer`: reconnaissance without changes, returning relevant files and how they fit together;
- `reviewer`: review without changes for bugs, regressions, missing tests and risks.

`explorer` and `reviewer` have `read`, `grep`, `find`, `ls` and `bash`, but no pinned model or effort;
Jev or the usual defaults choose those. Their no-change instructions are not a sandbox: `bash`
can still modify files. Task labels identify the work; these names identify the role.

`~/.pi/agent/agents/*.md` and the nearest `<project>/.pi/agents/*.md` customize the roles
(project files win, and agent files can override built-ins):

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

`tools`, `model`, `thinking` and `maxTurns` are optional; the body is appended to the child's
system prompt. At `maxTurns` (also `max_turns`) turns the child is told to stop calling tools and
answer; if it calls tools again, it is stopped with its output so far, marked as possibly partial.
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
  "widget": "off",
  "fleetView": true,
  "maxDepth": 2
}
```

A tier left out uses the parent's model. `tierDescriptions` overrides what Jev reads for each tier.
`widget` is `"off"` (default), `"background"` (async runs only), or `"all"`; `fleetView: false` turns the
list below the editor off. `maxDepth` is how many levels of subagents may run below the main
session: with 2, a subagent can start subagents of its own, but theirs get no `subagent` tool. Requires Pi 0.99 or newer for classifier models.

## Development

```sh
npm run check   # typecheck and unit tests (a fake RPC child stands in for pi)
npm run eval    # 15 tasks against live Jev through the installed Pi (needs TYPESAFE_API_KEY)
```

## Credits

The widget, FleetView and conversation viewer are adapted from
[@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) by tintinweb (MIT; see
`LICENSE`), ported to this extension's RPC children, run records and Jev picks.
