// A subagent's conversation, rebuilt from its RPC event stream: the messages so far (the one
// streaming included, grown from `message_update` deltas), the tools running now, and the steering
// messages still queued. The viewer reads it live; each finished message is also handed to
// `onMessage`, which appends it to the run's `messages.jsonl` so finished runs can be viewed later.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; partialJson?: string }
  | { type: "image" };

export interface Message {
  role: string;
  content: Block[];
  /** Characters cut from a long tool result. */
  elided?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  customType?: string;
  command?: string;
  timestamp?: number;
}

export interface ActiveTool {
  id: string;
  name: string;
  args: unknown;
  startedAt: number;
  /** The tail of the tool's latest partial output. */
  partial?: string;
}

/** Longest tool result kept; the rest is counted in `elided`. */
export const RESULT_MAX_CHARS = 16_000;
const PARTIAL_MAX_CHARS = 2_000;

type RawEvent = Record<string, any>;

function blocks(content: unknown): Block[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((b): Block[] => {
    if (!b || typeof b !== "object") return [];
    switch (b.type) {
      case "text":
        return [{ type: "text", text: String(b.text ?? "") }];
      case "thinking":
        return [{ type: "thinking", thinking: String(b.thinking ?? "") }];
      case "toolCall":
        return [{ type: "toolCall", id: String(b.id ?? ""), name: String(b.name ?? "tool"), arguments: isObject(b.arguments) ? b.arguments : {} }];
      case "image":
        return [{ type: "image" }];
      default:
        return [];
    }
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep what the viewer shows; drop signatures, details, image data, and the tail of long results. */
export function normalizeMessage(raw: unknown): Message {
  const m = (isObject(raw) ? raw : {}) as Record<string, any>;
  const role = typeof m.role === "string" ? m.role : "unknown";
  let content = blocks(m.content);
  if (role === "bashExecution" && typeof m.output === "string") content = [{ type: "text", text: m.output }];
  const out: Message = { role, content };
  if (role === "toolResult" || role === "bashExecution") {
    let budget = RESULT_MAX_CHARS;
    let elided = typeof m.elided === "number" ? m.elided : 0;
    out.content = content.map((b) => {
      if (b.type !== "text") return b;
      const keep = b.text.slice(0, Math.max(0, budget));
      elided += b.text.length - keep.length;
      budget -= keep.length;
      return { type: "text", text: keep };
    });
    if (elided) out.elided = elided;
  }
  for (const key of ["toolCallId", "toolName", "provider", "model", "stopReason", "errorMessage", "customType", "command"] as const) {
    if (typeof m[key] === "string") out[key] = m[key];
  }
  if (typeof m.isError === "boolean") out.isError = m.isError;
  if (typeof m.timestamp === "number") out.timestamp = m.timestamp;
  return out;
}

export function messageText(message: Message): string {
  return message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
}

export class Conversation {
  readonly messages: Message[] = [];
  readonly activeTools = new Map<string, ActiveTool>();
  /** Steering messages the child has queued but not yet read. */
  queued: string[] = [];
  toolUses = 0;
  /** Bumped on every change, so renderers can tell when to rebuild. */
  version = 0;
  private open: Message | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly onMessage?: (message: Message) => void) {}

  static from(messages: readonly Message[]): Conversation {
    const conversation = new Conversation();
    conversation.messages.push(...messages);
    return conversation;
  }

  /** The message between its `message_start` and `message_end`, if any. */
  get streaming(): Message | undefined {
    return this.open;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Apply one RPC event; events that are not about the conversation are ignored. */
  apply(event: RawEvent): void {
    switch (event.type) {
      case "message_start": {
        const message = normalizeMessage(event.message);
        this.messages.push(message);
        this.open = message;
        break;
      }
      case "message_update":
        this.applyUpdate(event);
        break;
      case "message_end": {
        const message = normalizeMessage(event.message);
        const index = this.open && this.open.role === message.role ? this.messages.lastIndexOf(this.open) : -1;
        if (index >= 0) this.messages[index] = message;
        else this.messages.push(message);
        this.open = undefined;
        this.onMessage?.(message);
        break;
      }
      case "tool_execution_start":
        this.toolUses++;
        this.activeTools.set(String(event.toolCallId ?? this.toolUses), {
          id: String(event.toolCallId ?? this.toolUses),
          name: String(event.toolName ?? "tool"),
          args: event.args,
          startedAt: Date.now(),
        });
        break;
      case "tool_execution_update": {
        const tool = this.activeTools.get(String(event.toolCallId));
        if (!tool) return;
        const text = blocks(event.partialResult?.content).flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
        tool.partial = text.length > PARTIAL_MAX_CHARS ? text.slice(-PARTIAL_MAX_CHARS) : text;
        break;
      }
      case "tool_execution_end":
        this.activeTools.delete(String(event.toolCallId));
        break;
      case "queue_update":
        this.queued = Array.isArray(event.steering) ? event.steering.map(String) : [];
        break;
      case "agent_settled":
        this.activeTools.clear();
        this.open = undefined;
        break;
      default:
        return;
    }
    this.changed();
  }

  /** The run is over: nothing streams, runs, or waits any more. */
  close(): void {
    this.activeTools.clear();
    this.open = undefined;
    this.queued = [];
    this.changed();
  }

  private applyUpdate(event: RawEvent) {
    let message = this.open;
    if (!message || message.role !== "assistant") {
      message = { role: "assistant", content: [] };
      this.messages.push(message);
      this.open = message;
    }
    // Older Pi sent the whole partial message with each update.
    if (isObject(event.message)) {
      message.content = blocks(event.message.content);
      return;
    }
    const e = event.assistantMessageEvent;
    if (!isObject(e)) return;
    const i = typeof e.contentIndex === "number" ? e.contentIndex : message.content.length;
    const at = message.content[i];
    switch (e.type) {
      case "text_start":
        message.content[i] = { type: "text", text: "" };
        break;
      case "text_delta":
        message.content[i] = { type: "text", text: (at?.type === "text" ? at.text : "") + String(e.delta ?? "") };
        break;
      case "text_end":
        message.content[i] = { type: "text", text: String(e.content ?? (at?.type === "text" ? at.text : "")) };
        break;
      case "thinking_start":
        message.content[i] = { type: "thinking", thinking: "" };
        break;
      case "thinking_delta":
        message.content[i] = { type: "thinking", thinking: (at?.type === "thinking" ? at.thinking : "") + String(e.delta ?? "") };
        break;
      case "thinking_end":
        message.content[i] = { type: "thinking", thinking: String(e.content ?? (at?.type === "thinking" ? at.thinking : "")) };
        break;
      case "toolcall_start":
        message.content[i] = { type: "toolCall", id: String(e.id ?? ""), name: String(e.toolName ?? "tool"), arguments: {}, partialJson: "" };
        break;
      case "toolcall_delta":
        if (at?.type === "toolCall") at.partialJson = (at.partialJson ?? "") + String(e.delta ?? "");
        break;
      case "toolcall_end": {
        const [call] = blocks([e.toolCall]);
        if (call) message.content[i] = call;
        break;
      }
    }
  }

  private changed() {
    this.version++;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A broken listener must not break the child's event loop.
      }
    }
  }
}

/** `bash: npm test`, from a tool name and its arguments. */
export function describeTool(name: unknown, args: unknown, max = 60): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const detail = typeof a.command === "string" ? a.command : typeof a.path === "string" ? a.path : typeof a.pattern === "string" ? a.pattern : typeof a.url === "string" ? a.url : "";
  const flat = detail.replace(/\s+/gu, " ").trim();
  return `${String(name ?? "tool")}${flat ? `: ${flat.length > max ? `${flat.slice(0, max - 1)}…` : flat}` : ""}`;
}

/** What the child is doing now: its running tools, else what it is streaming. */
export function describeActivity(conversation: Conversation): string {
  const tools = [...conversation.activeTools.values()];
  if (tools.length === 1) return describeTool(tools[0]?.name, tools[0]?.args);
  if (tools.length > 1) return `${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`;
  const last = conversation.streaming?.content.at(-1);
  if (last?.type === "toolCall") return `calling ${last.name}…`;
  if (last?.type === "text" && last.text.trim()) {
    const line = last.text.trim().split("\n").at(-1)?.trim() ?? "";
    return line.length > 60 ? `${line.slice(0, 59)}…` : line;
  }
  return "thinking…";
}

/** Append each finished message to `file` as JSONL; failures only cost the saved copy. */
export function transcriptWriter(file: string): (message: Message) => void {
  let ready = false;
  return (message) => {
    try {
      if (!ready) {
        mkdirSync(path.dirname(file), { recursive: true });
        ready = true;
      }
      appendFileSync(file, `${JSON.stringify(message)}\n`);
    } catch {
      // The conversation stays in memory.
    }
  };
}

export function readTranscript(file: string): Message[] | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [normalizeMessage(JSON.parse(line))];
    } catch {
      return [];
    }
  });
}
