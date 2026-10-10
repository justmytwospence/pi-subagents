// pi-subagents: delegate tasks to Pi subagents, each a `pi --mode rpc` child with its own context.
// One tool, `subagent`: run a single task, parallel tasks, or a chain (with `{previous}`), in the
// foreground or async, with fresh or forked context, optionally in a new worktree; then status,
// steer, stop, and result by run id. When the call leaves the agent, model, or effort open, Jev
// (through Pi's own classifier models) picks them: the agent definition, a model tier from your
// settings, and a thinking level.
//
// With pi-bg installed the two work as one (activity.ts): pi-bg's background tasks are a section of
// the subagents panel and are listed in FleetView, and async runs are outside work pi-bg's bg_wait
// can wait on (`subagent:<id>`). Each works alone without the other.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ACTIVITY_CHANGED, ACTIVITY_GONE, ACTIVITY_HOST, ACTIVITY_SECTION, type ActivityEntry, type ActivitySection } from "./activity.ts";
import { type AgentDef, discoverAgents } from "./agents.ts";
import { Child, type ChildState, subagentDepth, type DialogAnswer, type DialogRequest, type Usage, addUsage, emptyUsage } from "./child.ts";
import { agentDir, loadConfig } from "./config.ts";
import { Conversation, type Message, readTranscript, transcriptWriter } from "./conversation.ts";
import { type JevConfig, askJev } from "./jev.ts";
import { DEFAULT_TIER_DESCRIPTIONS, type Given, type Resolved, type Tier, pickQuestions, readPicks, resolve } from "./pick.ts";
import { type Run, displayTokens, transcriptPath } from "./run.ts";
import { clip, recentTexts } from "./transcript.ts";
import { FleetView, SUCCESS_HINT_MS } from "./ui/fleet.ts";
import { type ViewerActions, openViewer } from "./ui/viewer.ts";
import { elapsedMs, formatCount, formatElapsed, taskLine } from "./ui/format.ts";
import { RunsWidget, WIDGET_MODES, type WidgetMode } from "./ui/widget.ts";

export interface SubagentsConfig extends Record<string, unknown> {
  jev: JevConfig;
  /** `provider/model` per tier; unset tiers use the parent's model. */
  tiers: Partial<Record<Tier, string>>;
  tierDescriptions: Record<Tier, string>;
  maxParallel: number;
  concurrency: number;
  /** Which runs the widget above the editor shows: none (default; FleetView below the prompt shows them, as in Claude Code), async ones, or all. */
  widget: WidgetMode;
  /** The list of subagents below the editor that ↓ at an empty prompt moves into. */
  fleetView: boolean;
  /** Levels of subagents below the main session: 2 lets a child start children of its own, 1 does not. */
  maxDepth: number;
}

export const DEFAULT_CONFIG: SubagentsConfig = {
  jev: { enabled: true, provider: "typesafe", model: "jev-latest", timeoutMs: 3_000 },
  tiers: {},
  tierDescriptions: DEFAULT_TIER_DESCRIPTIONS,
  maxParallel: 8,
  concurrency: 4,
  widget: "off",
  fleetView: true,
  maxDepth: 2,
};

const MAX_LINES = 2_000;
const MAX_BYTES = 50 * 1024;
const RUN_ENTRY = "subagents:run";

const TaskItem = Type.Object({
  agent: Type.Optional(Type.String({ description: "Agent name; omit to let Jev choose" })),
  task: Type.String({ description: "The complete, self-contained task" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for this task" })),
  model: Type.Optional(Type.String({ description: "provider/model; omit to use the agent's or Jev's tier" })),
  thinking: Type.Optional(Type.String({ description: "off|minimal|low|medium|high|xhigh|max; omit to let Jev choose" })),
});

const Params = Type.Object({
  action: Type.Optional(
    Type.Union([Type.Literal("run"), Type.Literal("status"), Type.Literal("steer"), Type.Literal("stop"), Type.Literal("result")], {
      description: "run (default), status, steer, stop, or result",
    }),
  ),
  agent: Type.Optional(Type.String({ description: "Agent for a single task; omit to let Jev choose" })),
  task: Type.Optional(Type.String({ description: "A single task" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks (up to 8, 4 at a time)" })),
  chain: Type.Optional(Type.Array(TaskItem, { description: "Sequential steps; {previous} in a task is replaced by the previous step's output" })),
  async: Type.Optional(Type.Boolean({ description: "Return at once and deliver results as messages when done (default false)" })),
  context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")], { description: "fresh (default) or fork this conversation" })),
  worktree: Type.Optional(Type.Boolean({ description: "Run each task in a new git worktree (default false)" })),
  cwd: Type.Optional(Type.String({ description: "Working directory (default: the session's)" })),
  model: Type.Optional(Type.String({ description: "provider/model for a single task" })),
  thinking: Type.Optional(Type.String({ description: "Thinking level for a single task" })),
  id: Type.Optional(Type.String({ description: "Run id (or prefix) for status, steer, stop, result" })),
  message: Type.Optional(Type.String({ description: "Steering message for steer" })),
});

type Item = { agent?: string; task: string; cwd?: string; model?: string; thinking?: string };

export interface RunView {
  id: string;
  agent: string;
  task: string;
  model: string;
  thinking: string;
  byJev: Resolved["byJev"];
  status: ChildState["status"];
  activity?: string;
  turns: number;
  tokens: number;
  cost: number;
  seconds: number;
  error?: string;
  output?: string;
}

interface Details {
  mode: "single" | "parallel" | "chain";
  runs: RunView[];
}

function view(run: Run, withOutput = false): RunView {
  const s = run.state;
  return {
    id: run.id,
    agent: run.agent,
    task: clip(run.task, 300),
    model: s.model ?? run.model,
    thinking: run.thinking,
    byJev: run.byJev,
    status: s.status,
    ...(s.activity ? { activity: s.activity } : {}),
    turns: s.turns,
    tokens: displayTokens(s.usage),
    cost: s.usage.cost.total,
    seconds: Math.round(((s.endedAt ?? Date.now()) - s.startedAt) / 1000),
    ...(s.error ? { error: clip(s.error, 400) } : {}),
    ...(withOutput && s.output ? { output: clip(s.output, 2_000) } : {}),
  };
}

/** A run record as saved in the session. */
type RecordedRun = RunView & { outputPath: string; async: boolean };

/** A run known only from its record: its saved conversation, or else its task and output. */
export function recordedRun(v: RecordedRun): Run {
  let messages: Message[] | undefined = readTranscript(transcriptPath(v.outputPath));
  if (!messages?.length) {
    let output = v.output ?? "";
    try {
      output = readFileSync(v.outputPath, "utf8");
    } catch {
      // Only the record is left.
    }
    messages = [{ role: "user", content: [{ type: "text", text: v.task }] }, ...(output ? [{ role: "assistant", content: [{ type: "text" as const, text: output }] }] : [])];
  }
  const usage = emptyUsage();
  usage.input = v.tokens ?? 0;
  usage.cost.total = v.cost ?? 0;
  return {
    id: v.id,
    agent: v.agent,
    task: v.task,
    model: v.model,
    thinking: v.thinking,
    byJev: v.byJev ?? { agent: false, model: false, thinking: false },
    cwd: "",
    async: Boolean(v.async),
    // A record still "running" belongs to a process that is gone.
    state: { status: v.status === "running" ? "stopped" : v.status, output: "", usage, turns: v.turns ?? 0, startedAt: 0, endedAt: (v.seconds ?? 0) * 1000, ...(v.error ? { error: v.error } : {}) },
    conversation: Conversation.from(messages),
    outputPath: v.outputPath,
  };
}

/** Cut to 2,000 lines or 50 KB, keeping the start; say where the rest is. */
export function truncateOutput(text: string, fullPath: string): string {
  let lines = text.split("\n");
  let cut = false;
  if (lines.length > MAX_LINES) {
    lines = lines.slice(0, MAX_LINES);
    cut = true;
  }
  let out = lines.join("\n");
  if (Buffer.byteLength(out) > MAX_BYTES) {
    out = Buffer.from(out).subarray(0, MAX_BYTES).toString().replace(/\uFFFD$/u, "");
    cut = true;
  }
  return cut ? `${out}\n\n[Output truncated. Full output: ${fullPath}]` : out;
}

function shortId() {
  return Math.random().toString(36).slice(2, 8);
}

function slug(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 24) || "task";
}

export default function subagents(pi: ExtensionAPI) {
  // At the deepest level allowed, a subagent gets no subagent tool, so nesting cannot run away.
  if (subagentDepth() >= loadConfig("pi-subagents", DEFAULT_CONFIG, process.cwd()).maxDepth) return;
  const runs = new Map<string, Run>();
  let config: SubagentsConfig = DEFAULT_CONFIG;
  let backgroundCount = 0;
  /** Numbers each async call's herdr:background hold. */
  let holdCount = 0;
  /** Tasks waiting for a free slot (parallel) or their turn (chain), by sync/async. */
  const queued = { async: 0, sync: 0 };
  /** For each foreground run: move its whole call to the background. */
  const detachers = new Map<string, () => void>();

  const widgetMode = (): WidgetMode => (WIDGET_MODES.includes(config.widget) ? config.widget : "off");
  /** Other extensions' sources whose pills end FleetView (pi-bg's shells), while we host them. */
  const sections = new Map<string, ActivitySection>();
  let hosting = false;
  const hostedSections = () => [...sections.values()];
  /** When the user last sent a message: failed and stopped runs that ended before it leave the views. */
  let dismissedAt = 0;
  /** Runs dismissed with `x` (in FleetView or pi-bg's dialog). */
  const dismissed = new Set<string>();
  const widget = new RunsWidget({
    runs: () => [...runs.values()],
    queued: (mode) => queued.async + (mode === "all" ? queued.sync : 0),
    mode: widgetMode,
    dismissedAt: () => dismissedAt,
    open: (runId) => {
      const ui = boundUI;
      const run = runs.get(runId);
      if (ui && run) void openViewer(ui, run, viewerActions(run, ui));
    },
  });
  /** Steer and stop for the viewer; only a live child takes either. */
  const viewerActions = (run: Run, ui: Pick<ExtensionContext["ui"], "notify">): ViewerActions => ({
    steer: (message) => run.child?.steer(message) ?? false,
    background: () => detachers.get(run.id)?.(),
    canBackground: () => detachers.has(run.id),
    stop: () => {
      run.child?.stop();
      ui.notify(`Stopping subagent ${run.agent} (${run.id}).`, "info");
    },
  });
  let boundUI: ExtensionContext["ui"] | undefined;
  const fleet = new FleetView({
    runs: () => [...runs.values()],
    enabled: () => config.fleetView !== false,
    actions: (run) => viewerActions(run, boundUI ?? { notify: () => undefined }),
    sections: hostedSections,
    dismissedAt: () => dismissedAt,
    dismissed: () => dismissed,
    dismiss: (runId) => {
      dismissed.add(runId);
      refreshUI();
    },
    // Claude Code: a background subagent that succeeds leaves the panel at once, with this for 30 s.
    note: (now) => {
      const latest = Math.max(0, ...[...runs.values()].filter((r) => r.async && r.state.status === "done").map((r) => r.state.endedAt ?? 0));
      if (!latest || now - latest >= SUCCESS_HINT_MS) return undefined;
      return `${sections.has("bg") ? "/tasks" : "/subagents"} to see subagents`;
    },
  });
  // The user's next message dismisses failures and stops they have had a chance to see.
  pi.on("input", (event) => {
    if ((event as { source?: string }).source !== "interactive") return;
    dismissedAt = Date.now();
    refreshUI();
  });

  /** Our runs as a source for pi-bg's background-tasks dialog (activity.ts). */
  const runStatus = (r: Run): ActivityEntry["status"] =>
    r.state.status === "running" ? "running" : r.state.status === "done" ? "done" : r.state.status === "stopped" ? "stopped" : "failed";
  const ownSource: ActivitySection = {
    id: "subagents",
    title: "subagents",
    noun: "agent",
    entries: (now) => {
      const all = [...runs.values()].filter((r) => !dismissed.has(r.id));
      const running = all.filter((r) => r.state.status === "running").sort((a, b) => a.state.startedAt - b.state.startedAt);
      const ended = all.filter((r) => r.state.status !== "running").sort((a, b) => (b.state.endedAt ?? 0) - (a.state.endedAt ?? 0));
      return [...running, ...ended].map((r) => ({
        key: r.id,
        label: r.agent,
        detail: taskLine(r.task, 80),
        status: runStatus(r),
        stats: `${r.state.status === "running" ? "" : `${r.state.status} · `}${formatElapsed(elapsedMs(r, now))} · ↓ ${formatCount(displayTokens(r.state.usage))} tokens`,
        startedAt: r.state.startedAt,
        ...(r.state.endedAt ? { endedAt: r.state.endedAt } : {}),
      }));
    },
    open: (key, ui) => {
      const run = runs.get(key);
      const u = ui as ExtensionContext["ui"];
      return run ? openViewer(u, run, viewerActions(run, u)) : Promise.resolve();
    },
    stop: (key) => runs.get(key)?.child?.stop(),
    dismiss: (key) => {
      dismissed.add(key);
      refreshUI();
    },
  };

  /** Show a source's pill at the end of FleetView, if we host (an interactive session with FleetView on). */
  const accept = (section: ActivitySection) => {
    if (!hosting || section.id === ownSource.id) return;
    const previous = sections.get(section.id);
    // The same source offered again (it re-offers when a host announces itself) is already shown.
    if (previous === section) return;
    previous?.setHosted?.(false);
    sections.set(section.id, section);
    section.setHosted?.(true);
    refreshUI();
  };
  const stopHosting = () => {
    hosting = false;
    for (const section of sections.values()) {
      try {
        section.setHosted?.(false);
      } catch {
        // Its session may already be gone.
      }
    }
    sections.clear();
  };
  pi.events.on(ACTIVITY_SECTION, (data) => {
    const section = (data as { section?: ActivitySection } | undefined)?.section;
    if (section && typeof section.pill === "function" && typeof section.setHosted === "function") accept(section);
  });
  pi.events.on(ACTIVITY_CHANGED, (data) => {
    if (sections.has((data as { id?: string } | undefined)?.id ?? "")) refreshUI();
  });
  pi.events.on(ACTIVITY_GONE, (data) => {
    const id = (data as { id?: string } | undefined)?.id ?? "";
    if (sections.delete(id)) refreshUI();
  });
  /**
   * Whether this runtime's session is live. After `session_shutdown` (a reload, /new, /resume) pi
   * marks the runtime stale and every pi.* call throws; a child that ends later must not call it,
   * or the unhandled rejection takes pi down.
   */
  let live = false;
  let sessionCtx: ExtensionContext | undefined;
  const safely = (fn: () => void) => {
    if (!live) return;
    try {
      fn();
    } catch {
      // The runtime went stale between the check and the call.
    }
  };
  /**
   * Results owed to the agent. Sent only while pi is idle: a follow-up queued during a turn is
   * dropped when the user presses Esc. Several that pile up go out as one message.
   */
  const owedResults: { content: string; details: unknown }[] = [];
  const deliverResult = (content: string, details?: unknown) => {
    if (!live) return;
    owedResults.push({ content, details });
    flushResults(sessionCtx);
  };
  const flushResults = (c: Pick<ExtensionContext, "isIdle"> | undefined) => {
    if (!live || !owedResults.length || c?.isIdle?.() === false) return;
    const items = owedResults.splice(0);
    safely(() =>
      pi.sendMessage(
        { customType: "subagent-result", content: items.map((i) => i.content).join("\n\n---\n\n"), display: true, details: items.length === 1 ? items[0]?.details : { batches: items.map((i) => i.details) } },
        { triggerTurn: true, deliverAs: "followUp" },
      ),
    );
  };
  pi.on("agent_settled", (_event, c) => flushResults(c));

  /** Async runs as outside work pi-bg's bg_wait can wait on; nothing listens without pi-bg. */
  const external = (run: Run, chain?: { step: number; of: number }) => {
    const done = run.state.status !== "running";
    const elapsed = Math.round(((run.state.endedAt ?? Date.now()) - run.state.startedAt) / 1000);
    // A chain's result message comes only after its last step.
    const after =
      chain && chain.step < chain.of ? `; step ${chain.step} of ${chain.of} in a chain, which goes on (its result arrives after the last step)` : "; its result arrives as a message";
    safely(() =>
      pi.events.emit("bg:external", {
        id: `subagent:${run.id}`,
        label: `${run.agent}: ${taskLine(run.task, 60)}`,
        state: !done ? "running" : run.state.status === "done" ? "done" : "failed",
        ...(done ? { summary: `${run.state.status} after ${elapsed}s${after}` } : {}),
      }),
    );
  };
  /** Whether pi-bg is loaded (it answers bg:probe). */
  const hasBg = () => {
    let yes = false;
    pi.events.emit("bg:probe", { reply: () => (yes = true) });
    return yes;
  };
  const bindUI = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    boundUI = ctx.ui;
    widget.setUI(ctx.ui);
    fleet.setUI(ctx.ui);
  };
  const refreshUI = () => {
    widget.update();
    fleet.update();
  };

  const findRun = (id: string | undefined) => {
    if (!id) return undefined;
    const exact = runs.get(id);
    if (exact) return exact;
    const matches = [...runs.values()].filter((r) => r.id.startsWith(id));
    return matches.length === 1 ? matches[0] : undefined;
  };

  const record = (run: Run) => {
    safely(() => pi.appendEntry(RUN_ENTRY, { ...view(run), outputPath: run.outputPath, async: run.async }));
  };

  /** Forward a child's dialog (for example a tool gate's approval) to the parent's UI. */
  const dialogFor = (ctx: ExtensionContext, agent: string) => async (request: DialogRequest): Promise<DialogAnswer> => {
    if (!ctx.hasUI) return undefined;
    const title = `[subagent ${agent}] ${request.title ?? ""}`.trim();
    try {
      if (request.method === "select") {
        const value = await ctx.ui.select(title, request.options ?? []);
        return value === undefined ? undefined : { value };
      }
      if (request.method === "confirm") return { confirmed: await ctx.ui.confirm(title, request.message ?? "") };
      const value = await ctx.ui.input(title, request.placeholder);
      return value === undefined ? undefined : { value };
    } catch {
      return undefined;
    }
  };

  /** Jev's picks for the gaps in each item, one request per item, in parallel. */
  const plan = async (ctx: ExtensionContext, items: Item[], agents: AgentDef[], signal: AbortSignal | undefined) => {
    const parent = { model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "", thinking: pi.getThinkingLevel() };
    const tiers = { models: config.tiers, descriptions: config.tierDescriptions };
    const askTier = Object.values(config.tiers).some(Boolean);
    const parentRequest = clip(recentTexts(ctx.sessionManager.getBranch()).user, 2_000);
    return Promise.all(
      items.map(async (item) => {
        const given: Given = { ...(item.agent ? { agent: item.agent } : {}), ...(item.model ? { model: item.model } : {}), ...(item.thinking ? { thinking: item.thinking } : {}) };
        const questions = pickQuestions(given, agents, tiers, askTier);
        let picks: ReturnType<typeof readPicks> | undefined;
        if (Object.keys(questions).length) {
          const outcome = await askJev(ctx.modelRegistry, config.jev, { task: clip(item.task, 6_000), parent_request: parentRequest || "(none)" }, questions, signal);
          if (outcome.ok) picks = readPicks(outcome.answers);
        }
        const resolved = resolve(given, agents, picks, tiers, parent);
        if ("error" in resolved) return resolved;
        if (!resolved.model) return { error: "No model: the session has no model selected; pass `model`." };
        return resolved;
      }),
    );
  };

  const worktreeFor = async (cwd: string, task: string): Promise<string> => {
    const branch = `subagent/${slug(task)}-${shortId()}`;
    const result = await pi.exec("worktree", ["new", branch, "--no-open"], { cwd, timeout: 60_000 });
    const dir = result.stdout.trim().split("\n").at(-1)?.trim();
    if (result.code !== 0 || !dir) throw new Error(`worktree new ${branch} failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
    return dir;
  };

  const startRun = (
    ctx: ExtensionContext,
    item: Item,
    resolved: Resolved,
    options: { cwd: string; fork?: string; async: boolean; onUpdate: () => void },
  ): Run => {
    const id = shortId();
    const outputPath = path.join(agentDir(), "subagents", id, "output.md");
    const child = new Child({
      task: item.task,
      cwd: options.cwd,
      model: resolved.model,
      thinking: resolved.thinking,
      ...(resolved.agent.tools ? { tools: resolved.agent.tools } : {}),
      ...(resolved.agent.prompt ? { systemPrompt: resolved.agent.prompt } : {}),
      ...(resolved.agent.maxTurns ? { maxTurns: resolved.agent.maxTurns } : {}),
      ...(options.fork ? { forkSession: options.fork } : {}),
      sessionDir: path.join(agentDir(), "subagents", "sessions"),
      onUpdate: (state) => {
        run.state = state;
        options.onUpdate();
      },
      onDialog: dialogFor(ctx, resolved.agent.name),
      onMessage: transcriptWriter(transcriptPath(outputPath)),
    });
    const run: Run = {
      id,
      agent: resolved.agent.name,
      task: item.task,
      model: resolved.model,
      thinking: resolved.thinking,
      byJev: resolved.byJev,
      ...(resolved.tier ? { tier: resolved.tier } : {}),
      ...(resolved.agent.maxTurns ? { maxTurns: resolved.agent.maxTurns } : {}),
      cwd: options.cwd,
      async: options.async,
      state: child.state,
      child,
      conversation: child.conversation,
      outputPath,
    };
    runs.set(id, run);
    child.start();
    record(run);
    refreshUI();
    void child.done.then((state) => {
      run.state = state;
      try {
        mkdirSync(path.dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, state.output || state.error || "(no output)");
      } catch {
        // The output stays in memory.
      }
      run.child = undefined;
      record(run);
      refreshUI();
    });
    return run;
  };

  const resultText = (run: Run) => {
    const s = run.state;
    const head = `[${run.agent} · ${s.model ?? run.model} · ${run.thinking} · ${s.status}${s.error ? `: ${clip(s.error, 300)}` : ""}]`;
    return `${head}\n${truncateOutput(s.output || "(no output)", run.outputPath)}`;
  };

  const usageOf = (list: Run[]): Usage => list.reduce((sum, r) => addUsage(sum, r.state.usage), emptyUsage());

  pi.on("session_start", (_event, ctx) => {
    live = true;
    sessionCtx = ctx;
    config = loadConfig("pi-subagents", DEFAULT_CONFIG, ctx.cwd);
    bindUI(ctx);
    // Host other extensions' pills at the end of FleetView, when it is on.
    hosting = Boolean(boundUI) && config.fleetView !== false;
    if (hosting) pi.events.emit(ACTIVITY_HOST, {});
    // Our runs, for pi-bg's background-tasks dialog.
    if (boundUI) pi.events.emit(ACTIVITY_SECTION, { section: ownSource });
    refreshUI();
  });

  pi.on("session_shutdown", () => {
    for (const run of runs.values()) run.child?.stop();
    stopHosting();
    safely(() => pi.events.emit(ACTIVITY_GONE, { id: ownSource.id }));
    live = false;
    sessionCtx = undefined;
    boundUI = undefined;
    // The UI may already be gone; each part still lets go of its timers and listeners.
    for (const part of [widget, fleet]) {
      try {
        part.dispose();
      } catch {
        // stale UI
      }
    }
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate tasks to subagents, each a separate Pi with its own context window. action=run (default): a single `task`, parallel `tasks`, or a `chain` whose steps can use {previous}. Omit agent, model, or thinking to let Jev choose them. `async: true` returns run ids at once and delivers each result as a message. action=status|steer|stop|result take `id` (steer also `message`).",
    promptSnippet: "Delegate self-contained tasks to subagents with their own context windows",
    promptGuidelines: [
      "Give each subagent a complete, self-contained task: it cannot see this conversation unless context is fork.",
      "Use parallel tasks for independent work and a chain when a step needs the previous step's output.",
    ],
    parameters: Params,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      config = loadConfig("pi-subagents", DEFAULT_CONFIG, ctx.cwd);
      bindUI(ctx);
      const action = params.action ?? "run";

      if (action !== "run") {
        if (action === "status" && !params.id) {
          const all = [...runs.values()];
          const text = all.length ? all.map((r) => `${r.id}  ${r.state.status.padEnd(7)} ${r.agent}  ${clip(r.task.replace(/\s+/gu, " "), 80)}`).join("\n") : "No subagent runs in this session.";
          return { content: [{ type: "text", text }], details: { mode: "single", runs: all.map((r) => view(r)) } as Details };
        }
        const run = findRun(params.id);
        if (!run) throw new Error(`No run ${params.id ?? "(missing id)"}. Use action=status to list runs.`);
        if (action === "steer") {
          if (!params.message?.trim()) throw new Error("steer needs `message`.");
          if (!run.child?.steer(params.message)) throw new Error(`Run ${run.id} is ${run.state.status}; only running runs can be steered.`);
          return { content: [{ type: "text", text: `Steered ${run.id}.` }], details: { mode: "single", runs: [view(run)] } as Details };
        }
        if (action === "stop") {
          run.child?.stop();
          return { content: [{ type: "text", text: `Stopping ${run.id}.` }], details: { mode: "single", runs: [view(run)] } as Details };
        }
        if (action === "result") {
          let output = run.state.output;
          try {
            output = readFileSync(run.outputPath, "utf8");
          } catch {
            // still running or not written
          }
          const text = `[${run.agent} · ${run.state.status}]\n${truncateOutput(output || "(no output yet)", run.outputPath)}`;
          return { content: [{ type: "text", text }], details: { mode: "single", runs: [view(run, true)] } as Details };
        }
        return { content: [{ type: "text", text: JSON.stringify(view(run, true), null, 2) }], details: { mode: "single", runs: [view(run, true)] } as Details };
      }

      const mode: Details["mode"] = params.tasks?.length ? "parallel" : params.chain?.length ? "chain" : "single";
      const items: Item[] =
        mode === "parallel"
          ? (params.tasks as Item[])
          : mode === "chain"
            ? (params.chain as Item[])
            : params.task
              ? [{ task: params.task, ...(params.agent ? { agent: params.agent } : {}), ...(params.model ? { model: params.model } : {}), ...(params.thinking ? { thinking: params.thinking } : {}) }]
              : [];
      if (!items.length) throw new Error("run needs `task`, `tasks`, or `chain`.");
      if (mode === "parallel" && items.length > config.maxParallel) throw new Error(`At most ${config.maxParallel} parallel tasks.`);
      const fork = params.context === "fork" ? ctx.sessionManager.getSessionFile() : undefined;
      if (params.context === "fork" && !fork) throw new Error("context: fork needs a saved session; this one is not persisted.");

      const agents = discoverAgents(ctx.cwd);
      const resolvedAll = await plan(ctx, items, agents, signal);
      const failed = resolvedAll.find((r): r is { error: string } => "error" in r);
      if (failed) throw new Error(failed.error);
      const resolved = resolvedAll as Resolved[];

      const started: Run[] = [];
      const details = (): Details => ({ mode, runs: started.map((r) => view(r)) });
      const update = () => onUpdate?.({ content: [{ type: "text", text: `${started.filter((r) => r.state.status === "running").length} running` }], details: details() });

      const cwdFor = async (item: Item) => {
        const base = path.resolve(ctx.cwd, item.cwd ?? params.cwd ?? ".");
        return params.worktree ? worktreeFor(base, item.task) : base;
      };

      /** Whether this call's runs are in the background: from the start (`async`), or once detached. */
      const call = { async: Boolean(params.async), detach: undefined as (() => void) | undefined };

      const runOne = async (item: Item, r: Resolved, dequeue: () => void, chain?: { step: number; of: number }): Promise<Run> => {
        const cwd = await cwdFor(item);
        dequeue();
        const run = startRun(ctx, item, r, { cwd, ...(fork ? { fork } : {}), async: call.async, onUpdate: update });
        started.push(run);
        if (call.async) external(run, chain);
        update();
        // A foreground run stops with the call, unless it has been moved to the background.
        const abort = () => {
          if (!call.async) run.child?.stop();
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (!call.async && call.detach) detachers.set(run.id, call.detach);
        await run.child?.done;
        signal?.removeEventListener("abort", abort);
        detachers.delete(run.id);
        // The chain stops at a step that did not succeed: that step is its last.
        if (call.async) external(run, chain && run.state.status === "done" ? chain : undefined);
        return run;
      };

      let waiting = items.length;
      const kind = () => (call.async ? "async" : "sync");
      const execute = async (): Promise<Run[]> => {
        queued[kind()] += waiting;
        const dequeue = () => {
          if (waiting <= 0) return;
          waiting--;
          queued[kind()]--;
        };
        try {
          if (mode === "chain") {
            let previous = "";
            const done: Run[] = [];
            for (const [index, item] of items.entries()) {
              const run = await runOne({ ...item, task: item.task.replaceAll("{previous}", previous) }, resolved[index] as Resolved, dequeue, { step: index + 1, of: items.length });
              done.push(run);
              if (run.state.status !== "done") break;
              previous = run.state.output;
            }
            return done;
          }
          const queue = items.map((item, index) => ({ item, index }));
          const done: Run[] = new Array(items.length);
          const worker = async () => {
            for (let next = queue.shift(); next; next = queue.shift()) done[next.index] = await runOne(next.item, resolved[next.index] as Resolved, dequeue);
          };
          await Promise.all(Array.from({ length: Math.min(config.concurrency, items.length) }, worker));
          return done;
        } finally {
          // A chain that stopped early leaves steps that will never run.
          queued[kind()] -= waiting;
          waiting = 0;
          refreshUI();
        }
      };

      /** Report `work` as a message when it ends; meanwhile herdr shows background work. */
      const deliverLater = (work: Promise<Run[]>) => {
        backgroundCount++;
        // Released by id: without one, pi-herdr ends the oldest hold, which may be another extension's.
        const hold = `subagents:${++holdCount}`;
        safely(() => pi.events.emit("herdr:background", { active: true, label: `subagents (${items.length})`, id: hold }));
        void work
          .then((list) => {
            backgroundCount--;
            safely(() => pi.events.emit("herdr:background", { active: false, id: hold }));
            const text = list.filter(Boolean).map(resultText).join("\n\n---\n\n");
            deliverResult(`Subagent ${mode} finished:\n\n${text}`, { mode, runs: list.filter(Boolean).map((r) => view(r, true)) });
          })
          .catch((error: unknown) => {
            backgroundCount--;
            safely(() => pi.events.emit("herdr:background", { active: false, id: hold }));
            deliverResult(`Subagent ${mode} failed: ${error instanceof Error ? error.message : String(error)}`);
          });
      };

      const ids = () => started.map((r) => `${r.id} (${r.agent}, ${r.model}, ${r.thinking})`).join(", ");

      if (call.async) {
        deliverLater(execute());
        // Let the runs start so their ids exist.
        await new Promise((r) => setTimeout(r, 50));
        return {
          content: [{ type: "text", text: `Started ${mode} in the background${started.length ? `: ${ids()}` : ""}. Results arrive as messages; use action=status, steer, stop, or result with an id meanwhile.${hasBg() && started.length ? ` If nothing else is left to do, bg_wait ${started.map((r) => `subagent:${r.id}`).join(" or ")} waits inside your turn until it ends.` : ""}` }],
          details: details(),
        };
      }

      // In the foreground until the user moves the call to the background (b in FleetView or the viewer).
      const detached = new Promise<"detached">((resolve) => {
        call.detach = () => {
          if (call.async) return;
          queued.sync -= waiting;
          queued.async += waiting;
          call.async = true;
          for (const r of started) {
            r.async = true;
            detachers.delete(r.id);
            if (r.state.status === "running") external(r);
          }
          refreshUI();
          resolve("detached");
        };
      });
      const work = execute();
      const done = await Promise.race([work, detached]);
      if (done === "detached") {
        deliverLater(work);
        return {
          content: [{ type: "text", text: `The user moved this ${mode} to the background: ${ids()}. Results arrive as messages; use action=status, steer, stop, or result with an id meanwhile.` }],
          details: details(),
        };
      }
      for (const r of started) detachers.delete(r.id);
      const text = mode === "chain" ? resultText(done.at(-1) as Run) : done.map(resultText).join("\n\n---\n\n");
      const allFailed = done.every((r) => r.state.status !== "done");
      return {
        content: [{ type: "text", text }],
        details: { mode, runs: done.map((r) => view(r, true)) } as Details,
        usage: usageOf(done) as never,
        ...(allFailed ? { isError: true } : {}),
      };
    },

    renderCall(args, theme) {
      const a = args as { action?: string; agent?: string; task?: string; tasks?: unknown[]; chain?: unknown[]; async?: boolean; id?: string };
      const action = a.action ?? "run";
      const what =
        action !== "run"
          ? `${action}${a.id ? ` ${a.id}` : ""}`
          : a.tasks?.length
            ? `${a.tasks.length} parallel tasks`
            : a.chain?.length
              ? `chain of ${a.chain.length}`
              : `${a.agent ?? "auto"}: ${clip((a.task ?? "").replace(/\s+/gu, " "), 80)}`;
      return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("muted", what)}${a.async ? theme.fg("dim", " (async)") : ""}`, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const d = result.details as Details | undefined;
      if (!d?.runs?.length) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }
      const icon = (s: RunView["status"]) =>
        s === "running" ? theme.fg("warning", "●") : s === "done" ? theme.fg("success", "✓") : s === "stopped" ? theme.fg("muted", "■") : theme.fg("error", "✗");
      const jev = (on: boolean) => (on ? theme.fg("dim", " (Jev)") : "");
      const lines: string[] = [];
      for (const r of d.runs) {
        lines.push(
          `${icon(r.status)} ${theme.fg("accent", r.agent)}${jev(r.byJev.agent)} ${theme.fg("muted", "·")} ${r.model}${jev(r.byJev.model)} ${theme.fg("muted", "·")} ${r.thinking}${jev(r.byJev.thinking)} ${theme.fg("dim", `· ${r.seconds}s · ${r.turns} turns${r.cost ? ` · $${r.cost.toFixed(3)}` : ""} · ${r.id}`)}`,
        );
        if (r.status === "running" && r.activity) lines.push(`  ${theme.fg("dim", r.activity)}`);
        if (r.error) lines.push(`  ${theme.fg("error", clip(r.error, 200))}`);
        if (expanded && r.output) for (const line of r.output.split("\n").slice(0, 40)) lines.push(`  ${line}`);
      }
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  /** This session's runs, newest first: live ones, then those known only from their records (before a reload). */
  const allRuns = (ctx: ExtensionContext): Array<{ view: RunView; run: () => Run }> => {
    const latest = new Map<string, RecordedRun>();
    for (const e of ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: RecordedRun }>) {
      if (e.type === "custom" && e.customType === RUN_ENTRY && e.data && !runs.has(e.data.id)) latest.set(e.data.id, e.data);
    }
    return [
      ...[...latest.values()].map((v) => ({ view: v, run: () => recordedRun(v) })),
      ...[...runs.values()].map((r) => ({ view: view(r), run: () => r })),
    ].reverse();
  };

  pi.registerCommand("subagents", {
    description: "Browse this session's subagent runs and view their conversations (/subagents [id], /subagents stop [id|all])",
    handler: async (args, ctx) => {
      const [verb, target] = args.trim().split(/\s+/u);
      if (verb === "stop") {
        const running = [...runs.values()].filter((r) => r.child && r.state.status === "running");
        const chosen = target === "all" || (!target && running.length === 1) ? running : target ? running.filter((r) => r.id.startsWith(target)) : [];
        if (!chosen.length) {
          const which = running.map((r) => `${r.id} ${r.agent}`).join(", ");
          ctx.ui.notify(!running.length ? "No subagents are running." : target ? `No running run matches "${target}". Running: ${which}.` : `Say which: /subagents stop <id> or all. Running: ${which}.`, "info");
          return;
        }
        for (const r of chosen) r.child?.stop();
        ctx.ui.notify(`Stopping ${chosen.map((r) => `${r.agent} (${r.id})`).join(", ")}.`, "info");
        return;
      }
      const label = (r: RunView) => `${r.id}  ${r.status.padEnd(7)} ${r.agent} · ${r.model} · ${r.thinking}  ${clip(r.task.replace(/\s+/gu, " "), 60)}`;
      let list = allRuns(ctx);
      if (!list.length) {
        ctx.ui.notify("No subagent runs in this session.", "info");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify(list.map((e) => label(e.view)).join("\n"), "info");
        return;
      }
      const id = args.trim();
      if (id) {
        const matches = list.filter((e) => e.view.id.startsWith(id));
        const only = matches.length === 1 ? matches[0] : list.find((e) => e.view.id === id);
        if (!only) {
          ctx.ui.notify(`No single run matches "${id}".`, "warning");
          return;
        }
        const run = only.run();
        await openViewer(ctx.ui, run, viewerActions(run, ctx.ui));
        return;
      }
      for (;;) {
        const width = String(list.length).length;
        const labels = list.map((e, i) => `${String(i + 1).padStart(width)}. ${label(e.view)}`);
        const choice = await ctx.ui.select("Subagent runs", labels);
        const entry = choice === undefined ? undefined : list[labels.indexOf(choice)];
        if (!entry) return;
        const run = entry.run();
        await openViewer(ctx.ui, run, viewerActions(run, ctx.ui));
        list = allRuns(ctx);
      }
    },
  });
}
