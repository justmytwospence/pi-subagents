// One subagent: a `pi --mode rpc` child process with its own context window. The task is sent as a
// prompt; the run ends at `agent_settled`, when stdin is closed so Pi shuts down in order. RPC keeps
// the child steerable, and its extension dialogs (for example a tool gate asking for approval) are
// forwarded to the parent. Every event also feeds the child's `Conversation`, which the viewer shows.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Conversation, type Message, describeTool } from "./conversation.ts";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export function addUsage(a: Usage, b: Partial<Usage> | undefined): Usage {
  if (!b) return a;
  const c = (b.cost ?? {}) as Partial<Usage["cost"]>;
  return {
    input: a.input + (b.input ?? 0),
    output: a.output + (b.output ?? 0),
    cacheRead: a.cacheRead + (b.cacheRead ?? 0),
    cacheWrite: a.cacheWrite + (b.cacheWrite ?? 0),
    totalTokens: a.totalTokens + (b.totalTokens ?? 0),
    cost: {
      input: a.cost.input + (c.input ?? 0),
      output: a.cost.output + (c.output ?? 0),
      cacheRead: a.cost.cacheRead + (c.cacheRead ?? 0),
      cacheWrite: a.cost.cacheWrite + (c.cacheWrite ?? 0),
      total: a.cost.total + (c.total ?? 0),
    },
  };
}

export type ChildStatus = "running" | "done" | "failed" | "stopped";

export interface ChildState {
  status: ChildStatus;
  /** The child's last assistant text. */
  output: string;
  usage: Usage;
  turns: number;
  /** The model that answered, as Pi reports it. */
  model?: string;
  /** What the child is doing now, e.g. `bash: npm test`. */
  activity?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface DialogRequest {
  method: "select" | "confirm" | "input" | "editor";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

/** The value for an `extension_ui_response`, or undefined to cancel. */
export type DialogAnswer = { value: string } | { confirmed: boolean } | undefined;

export interface ChildOptions {
  task: string;
  cwd: string;
  model: string;
  thinking: string;
  tools?: string[];
  systemPrompt?: string;
  /** At this many turns the child is told to wrap up; if it calls tools again, it is stopped. */
  maxTurns?: number;
  /** Session file to fork, for `context: "fork"`. */
  forkSession?: string;
  sessionDir: string;
  onUpdate?: (state: ChildState) => void;
  onDialog?: (request: DialogRequest) => Promise<DialogAnswer>;
  /** Each finished message, for example to save it. */
  onMessage?: (message: Message) => void;
  /** Command and leading args to run Pi; defaults to the running Pi. */
  invocation?: { command: string; args: string[] };
}

/** How deep this Pi is in a tree of subagents: 0 for a top-level session, 1 for its children. */
export function subagentDepth(env: NodeJS.ProcessEnv = process.env): number {
  const depth = Number(env.PI_SUBAGENT_DEPTH);
  if (Number.isInteger(depth) && depth >= 0) return depth;
  return env.PI_SUBAGENT ? 1 : 0;
}

/** How to run the same Pi that is running this extension. */
export function piInvocation(): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/") && existsSync(script)) return { command: process.execPath, args: [script] };
  const exec = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/u.test(exec)) return { command: process.execPath, args: [] };
  return { command: "pi", args: [] };
}

export function childArgs(options: ChildOptions, promptFile?: string): string[] {
  const args = ["--mode", "rpc"];
  if (options.forkSession) args.push("--fork", options.forkSession, "--session-dir", options.sessionDir);
  else args.push("--no-session");
  args.push("--model", options.model, "--thinking", options.thinking);
  if (options.tools?.length) args.push("--tools", options.tools.join(","));
  if (promptFile) args.push("--append-system-prompt", promptFile);
  return args;
}

export class Child {
  readonly state: ChildState;
  readonly done: Promise<ChildState>;
  readonly conversation: Conversation;
  private proc: ChildProcess | undefined;
  private settle!: (state: ChildState) => void;
  private stderr = "";
  private stopping = false;

  constructor(private readonly options: ChildOptions) {
    this.state = { status: "running", output: "", usage: emptyUsage(), turns: 0, startedAt: Date.now() };
    this.conversation = new Conversation(options.onMessage);
    this.done = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  start(): this {
    let promptFile: string | undefined;
    if (this.options.systemPrompt?.trim()) {
      const dir = mkdtempSync(path.join(tmpdir(), "pi-subagent-"));
      promptFile = path.join(dir, "agent.md");
      writeFileSync(promptFile, this.options.systemPrompt, { mode: 0o600 });
    }
    const invocation = this.options.invocation ?? piInvocation();
    const proc = spawn(invocation.command, [...invocation.args, ...childArgs(this.options, promptFile)], {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_SUBAGENT: "1", PI_SUBAGENT_DEPTH: String(subagentDepth() + 1) },
    });
    this.proc = proc;
    let buffer = "";
    proc.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) this.onLine(line);
    });
    proc.stderr?.on("data", (data: Buffer) => {
      this.stderr = (this.stderr + data.toString()).slice(-4_000);
    });
    proc.on("error", (error) => this.finish("failed", error.message));
    proc.on("close", (code) => {
      if (buffer.trim()) this.onLine(buffer);
      if (this.state.status === "running") {
        this.finish(this.stopping ? "stopped" : "failed", this.stopping ? undefined : `pi exited (${code ?? "signal"})${this.stderr.trim() ? `: ${this.stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`);
      }
    });
    this.send({ type: "prompt", message: this.options.task });
    return this;
  }

  steer(message: string): boolean {
    if (this.state.status !== "running") return false;
    this.send({ type: "steer", message });
    return true;
  }

  stop() {
    if (this.state.status !== "running") return;
    this.stopping = true;
    this.send({ type: "abort" });
    this.proc?.stdin?.end();
    const proc = this.proc;
    setTimeout(() => {
      if (proc && proc.exitCode === null) proc.kill("SIGTERM");
    }, 3_000).unref?.();
  }

  private send(command: Record<string, unknown>) {
    const stdin = this.proc?.stdin;
    if (stdin && !stdin.destroyed && stdin.writable) stdin.write(`${JSON.stringify(command)}\n`);
  }

  private update() {
    this.options.onUpdate?.(this.state);
  }

  private finish(status: ChildStatus, error?: string) {
    if (this.state.status !== "running") return;
    this.state.status = status;
    this.state.endedAt = Date.now();
    this.state.activity = undefined;
    if (error) this.state.error = error;
    this.conversation.close();
    this.update();
    this.settle(this.state);
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    let event: Record<string, any>;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    this.conversation.apply(event);
    switch (event.type) {
      case "message_end": {
        const message = event.message;
        if (message?.role !== "assistant") break;
        this.state.turns++;
        this.state.usage = addUsage(this.state.usage, message.usage);
        if (message.model) this.state.model = `${message.provider ? `${message.provider}/` : ""}${message.model}`;
        const text = Array.isArray(message.content)
          ? message.content.filter((b: { type?: string }) => b.type === "text").map((b: { text?: string }) => b.text ?? "").join("\n").trim()
          : "";
        if (text) this.state.output = text;
        if (message.stopReason === "error" && message.errorMessage) this.state.error = message.errorMessage;
        this.update();
        this.checkTurnLimit(message.stopReason);
        break;
      }
      case "tool_execution_start":
        this.state.activity = describeTool(event.toolName, event.args);
        this.update();
        break;
      case "tool_execution_end": {
        // Another tool may still be running in parallel.
        const still = [...this.conversation.activeTools.values()].at(-1);
        this.state.activity = still ? describeTool(still.name, still.args) : undefined;
        this.update();
        break;
      }
      case "response":
        if (event.command === "prompt" && event.success === false) this.finishAndClose("failed", String(event.error ?? "the prompt was rejected"));
        else if (event.command === "prompt" && event.data?.disposition === "handled") this.finishAndClose("done");
        break;
      case "agent_settled":
        // After stop(), Pi settles the aborted run before it exits.
        this.finishAndClose(this.stopping ? "stopped" : this.state.error && !this.state.output ? "failed" : "done");
        break;
      case "extension_ui_request":
        void this.answerDialog(event);
        break;
    }
  }

  /** At the limit, ask for a final answer; a turn later, if it still calls tools, stop with what it has. */
  private checkTurnLimit(stopReason: unknown) {
    const max = this.options.maxTurns;
    if (!max || stopReason !== "toolUse" || this.state.status !== "running") return;
    if (this.state.turns === max) {
      this.send({
        type: "steer",
        message: `You have used your ${max} turns. Do not call any more tools: reply now with your final answer, including what you found and what is left undone.`,
      });
    } else if (this.state.turns > max) {
      this.state.error = `stopped at the turn limit (${max}); the output may be partial`;
      this.stop();
    }
  }

  private finishAndClose(status: ChildStatus, error?: string) {
    this.finish(status, error);
    this.proc?.stdin?.end();
    const proc = this.proc;
    setTimeout(() => {
      if (proc && proc.exitCode === null) proc.kill("SIGTERM");
    }, 10_000).unref?.();
  }

  private async answerDialog(event: Record<string, any>) {
    const method = event.method;
    if (!["select", "confirm", "input", "editor"].includes(method)) return;
    let answer: DialogAnswer;
    try {
      answer = await this.options.onDialog?.({
        method,
        title: event.title,
        message: event.message,
        options: event.options,
        placeholder: event.placeholder,
        prefill: event.prefill,
      });
    } catch {
      answer = undefined;
    }
    this.send({ type: "extension_ui_response", id: event.id, ...(answer ?? { cancelled: true }) });
  }
}
