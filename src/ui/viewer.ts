// A live, auto-scrolling view of one subagent's conversation, full screen under a banner. Enter opens a composer
// that steers the child; `x` twice stops it; `b` moves a foreground run to the background; `m` cycles what renders as Markdown; Esc (or q)
// closes. It stays open when the run ends.
// Adapted from tintinweb/pi-subagents (MIT): https://github.com/tintinweb/pi-subagents
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type Component, Input, Markdown, type MarkdownTheme, type TUI, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Message, describeActivity, describeTool, messageText } from "../conversation.ts";
import type { Run } from "../run.ts";
import { type Theme, dimAll, jev, modelAndEffort, runStats, statusIcon, taskLine } from "./format.ts";

/** Share of the terminal height the view takes: all of it, like Claude Code's and Codex's subagent views. */
export const VIEWER_HEIGHT_PCT = 100;
/** Border, header, invocation line, two separators, footer, border. */
const CHROME_LINES = 7;
const MIN_VIEWPORT = 3;
/** Lines of a running tool's partial output shown live. */
const PARTIAL_LINES = 6;

/** How much renders as Markdown: assistant text (default), tool results too, or nothing. */
export type MarkdownMode = "assistant" | "all" | "off";
const MARKDOWN_MODES: readonly MarkdownMode[] = ["assistant", "all", "off"];
const MARKDOWN_LABELS: Record<MarkdownMode, string> = { assistant: "md", all: "md+", off: "raw" };

export interface ViewerActions {
  /** Send a steering message; false when the run can no longer be steered. */
  steer?: (message: string) => boolean;
  stop?: () => void;
  /** Move a foreground run's tool call to the background, so the main agent can go on. */
  background?: () => void;
  canBackground?: () => boolean;
}

/** Pi's KeybindingsManager, structurally. */
export interface Keybindings {
  matches(data: string, id: string): boolean;
}

type TuiLike = Pick<TUI, "requestRender"> & { terminal: { rows: number } };

function markdownTheme(theme: Theme): MarkdownTheme {
  // Pi's theme highlights code; it throws only when no theme was initialized (tests, embedding).
  try {
    const pi = getMarkdownTheme();
    pi.heading("probe");
    return pi;
  } catch {
    const sgr = (on: number, off: number) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;
    return {
      heading: (t) => theme.bold(theme.fg("accent", t)),
      link: (t) => theme.fg("accent", t),
      linkUrl: (t) => theme.fg("muted", t),
      code: (t) => theme.fg("muted", t),
      codeBlock: (t) => theme.fg("muted", t),
      codeBlockBorder: (t) => theme.fg("dim", t),
      quote: (t) => theme.fg("muted", t),
      quoteBorder: (t) => theme.fg("dim", t),
      hr: (t) => theme.fg("dim", t),
      listBullet: (t) => theme.fg("accent", t),
      bold: (t) => theme.bold(t),
      italic: sgr(3, 23),
      underline: sgr(4, 24),
      strikethrough: sgr(9, 29),
    };
  }
}

export class ConversationViewer implements Component {
  /** Shared by every viewer in this Pi, so `m` sticks for the session. */
  static markdownMode: MarkdownMode = "assistant";
  private scroll = 0;
  private follow = true;
  private stopArmed = false;
  private composer: Input | undefined;
  private width = 80;
  private closed = false;
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly md: MarkdownTheme;
  private readonly markdown = new WeakMap<Message, { component: Markdown; text: string; failed?: boolean }>();
  private readonly lineCache = new WeakMap<Message, { width: number; mode: MarkdownMode; lines: string[] }>();

  constructor(
    private readonly tui: TuiLike,
    private readonly run: Run,
    private readonly theme: Theme,
    private readonly done: () => void,
    private readonly actions: ViewerActions = {},
    private readonly keybindings?: Keybindings,
  ) {
    this.md = markdownTheme(theme);
    this.unsubscribe = run.conversation.subscribe(() => {
      if (!this.closed) this.tui.requestRender();
    });
    // Elapsed time ticks even when the child is quiet.
    this.timer = setInterval(() => {
      if (!this.closed && this.running()) this.tui.requestRender();
    }, 1_000);
    this.timer.unref?.();
  }

  private running() {
    return this.run.state.status === "running";
  }

  private canSteer() {
    return Boolean(this.actions.steer) && this.running() && Boolean(this.run.child);
  }

  private canBackground() {
    return this.running() && Boolean(this.actions.canBackground?.());
  }

  private canStop() {
    return Boolean(this.actions.stop) && this.running() && Boolean(this.run.child);
  }

  private key(data: string, id: string, fallback: string) {
    return this.keybindings ? this.keybindings.matches(data, id) : matchesKey(data, fallback as never);
  }

  handleInput(data: string): void {
    if (this.composer) {
      this.composer.handleInput(data);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q") || matchesKey(data, "h")) {
      this.close();
      return;
    }
    if (matchesKey(data, "enter") && this.canSteer()) {
      this.stopArmed = false;
      this.openComposer();
      return;
    }
    if (matchesKey(data, "b") && this.canBackground()) {
      this.stopArmed = false;
      this.actions.background?.();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "m")) {
      // The escape hatch for output that Markdown would reshape (diffs, logs, # comments).
      const mode = ConversationViewer.markdownMode;
      ConversationViewer.markdownMode = MARKDOWN_MODES[(MARKDOWN_MODES.indexOf(mode) + 1) % MARKDOWN_MODES.length] ?? "assistant";
      this.stopArmed = false;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "x")) {
      if (this.canStop()) {
        if (this.stopArmed) {
          this.stopArmed = false;
          this.actions.stop?.();
        } else this.stopArmed = true;
        this.tui.requestRender();
      }
      return;
    }
    this.stopArmed = false;
    const total = this.contentLines(this.width).length;
    const page = this.viewport();
    const max = Math.max(0, total - page);
    if (this.key(data, "tui.select.up", "up") || matchesKey(data, "k")) this.scroll = Math.max(0, Math.min(this.scroll, max) - 1);
    else if (this.key(data, "tui.select.down", "down") || matchesKey(data, "j")) this.scroll = Math.min(max, this.scroll + 1);
    else if (this.key(data, "tui.select.pageUp", "pageUp") || matchesKey(data, "shift+up")) this.scroll = Math.max(0, Math.min(this.scroll, max) - page);
    else if (this.key(data, "tui.select.pageDown", "pageDown") || matchesKey(data, "shift+down")) this.scroll = Math.min(max, this.scroll + page);
    else if (matchesKey(data, "home")) this.scroll = 0;
    else if (matchesKey(data, "end")) this.scroll = max;
    else return;
    this.follow = this.scroll >= max;
    this.tui.requestRender();
  }

  private close() {
    if (this.closed) return;
    this.closed = true;
    this.done();
  }

  private openComposer() {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value) => {
      this.composer = undefined;
      const message = value.trim();
      if (message) this.actions.steer?.(message);
      this.follow = true;
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.composer = undefined;
      this.tui.requestRender();
    };
    this.composer = input;
    this.tui.requestRender();
  }

  private viewport() {
    const rows = Math.floor((this.tui.terminal.rows * VIEWER_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, rows - CHROME_LINES - (this.composer ? 1 : 0));
  }

  render(width: number): string[] {
    if (width < 8) return [];
    const th = this.theme;
    const inner = width - 4;
    this.width = inner;
    const row = (content: string) => `${th.fg("accent", "│")} ${truncateToWidth(content, inner, "…", true)} ${th.fg("accent", "│")}`;
    const rule = row(th.fg("dim", "─".repeat(inner)));
    const run = this.run;
    const s = run.state;

    // A banner in the accent color says this is not the main session, and how to get back.
    const label = ` ◀ esc · Subagent ${run.agent} · not your main session `;
    const lines = [th.fg("accent", `╭─${th.bold(truncateToWidth(label, Math.max(4, width - 3)))}${"─".repeat(Math.max(0, width - 3 - visibleWidth(label)))}╮`)];
    lines.push(row(`${statusIcon(s.status, th)} ${th.bold(run.agent)}${jev(run.byJev.agent, th)}  ${th.fg("muted", taskLine(run.task, 80))} ${th.fg("dim", "·")} ${th.fg("dim", runStats(run))}`));
    const status = s.status === "running" ? "" : ` · ${s.status}`;
    lines.push(row(dimAll(`  ↳ ${modelAndEffort(run, th, true)} · ${run.async ? "async" : "sync"} · ${run.id}${status}`, th)));
    lines.push(rule);

    const content = this.contentLines(inner);
    const page = this.viewport();
    const max = Math.max(0, content.length - page);
    if (this.follow) this.scroll = max;
    const start = Math.min(this.scroll, max);
    for (let i = 0; i < page; i++) lines.push(row(content[start + i] ?? ""));

    lines.push(rule);
    if (this.composer) {
      lines.push(row(this.composer.render(inner)[0] ?? ""));
      lines.push(row(spread(th.fg("accent", "✎ steer"), th.fg("dim", "Enter send · Esc cancel"), inner)));
    } else {
      const actions: string[] = [];
      if (this.canSteer()) actions.push(th.fg("dim", "Enter steer"));
      if (this.canStop()) actions.push(this.stopArmed ? th.fg("error", "x again to stop") : th.fg("dim", "x stop"));
      if (this.canBackground()) actions.push(th.fg("dim", "b background"));
      const position = content.length <= page ? "all" : `${Math.round(((start + page) / content.length) * 100)}%`;
      actions.push(th.fg("dim", `m ${MARKDOWN_LABELS[ConversationViewer.markdownMode]}`));
      const sep = th.fg("dim", " · ");
      const nav = th.fg("dim", "j/k scroll · PgUp/PgDn · h/esc back");
      // The line count goes first when the footer is short of room.
      const withCount = [...actions, th.fg("dim", `${content.length} lines · ${position}`)].join(sep);
      const left = visibleWidth(withCount) + visibleWidth(nav) + 1 <= inner ? withCount : actions.join(sep);
      lines.push(row(spread(left, nav, inner)));
    }
    lines.push(th.fg("accent", `╰${"─".repeat(width - 2)}╯`));
    return lines;
  }

  /** The conversation as display lines at `width`; finished messages are cached. */
  contentLines(width: number): string[] {
    const th = this.theme;
    const c = this.run.conversation;
    const out: string[] = [];
    for (const message of c.messages) {
      const streaming = message === c.streaming;
      const mode = ConversationViewer.markdownMode;
      const cached = streaming ? undefined : this.lineCache.get(message);
      let lines = cached?.width === width && cached.mode === mode ? cached.lines : undefined;
      if (!lines) {
        lines = this.messageLines(message, width).map((l) => truncateToWidth(l, width));
        if (!streaming) this.lineCache.set(message, { width, mode, lines });
      }
      if (!lines.length) continue;
      if (out.length) out.push("");
      out.push(...lines);
    }
    if (!out.length) out.push(th.fg("dim", "(waiting for the first message…)"));
    const s = this.run.state;
    if (s.status !== "running" && s.error) out.push("", ...wrapTextWithAnsi(th.fg("error", `✗ ${s.status}: ${s.error}`), width));
    if (this.running()) {
      for (const tool of c.activeTools.values()) {
        const partial = tool.partial?.trimEnd();
        if (!partial) continue;
        out.push("");
        out.push(th.fg("muted", `  ${describeTool(tool.name, tool.args)}`));
        for (const l of partial.split("\n").slice(-PARTIAL_LINES)) out.push(truncateToWidth(th.fg("dim", `    ${l}`), width));
      }
      for (const q of c.queued) out.push(truncateToWidth(th.fg("dim", `  ⏳ queued steer: ${q.replace(/\s+/gu, " ")}`), width));
      out.push("");
      out.push(truncateToWidth(`${th.fg("accent", "▍ ")}${th.fg("dim", describeActivity(c))}`, width));
    }
    return out;
  }

  private messageLines(message: Message, width: number): string[] {
    const th = this.theme;
    const text = messageText(message).trim();
    switch (message.role) {
      case "user":
        return text ? [th.fg("accent", "[User]"), ...wrapTextWithAnsi(text, width)] : [];
      case "assistant": {
        const lines = [th.bold("[Assistant]")];
        if (text) lines.push(...(ConversationViewer.markdownMode === "off" ? wrapTextWithAnsi(text, width) : this.markdownLines(message, text, width)));
        for (const block of message.content) {
          if (block.type === "toolCall") lines.push(th.fg("muted", `  ▸ ${describeTool(block.name, block.arguments, Math.max(20, width - 20))}`));
        }
        if (message.stopReason === "error" && message.errorMessage) lines.push(...wrapTextWithAnsi(th.fg("error", message.errorMessage), width));
        if (message.stopReason === "aborted") lines.push(th.fg("muted", "(aborted)"));
        return lines.length > 1 ? lines : [];
      }
      case "toolResult": {
        if (!text && !message.isError) return [];
        const label = `[${message.isError ? "Error" : "Result"}${message.toolName ? `: ${message.toolName}` : ""}]`;
        const body = ConversationViewer.markdownMode === "all" ? this.markdownLines(message, text, width, true) : wrapTextWithAnsi(text, width).map((l) => th.fg("dim", l));
        const lines = [th.fg(message.isError ? "error" : "dim", label), ...body];
        if (message.elided) lines.push(th.fg("dim", `… (${message.elided} more characters)`));
        return lines;
      }
      case "bashExecution":
        return [th.fg("muted", `$ ${message.command ?? ""}`), ...wrapTextWithAnsi(text, width).map((l) => th.fg("dim", l))];
      default:
        return text ? [th.fg("dim", `[${message.customType ?? message.role}]`), ...wrapTextWithAnsi(text, width).map((l) => th.fg("dim", l))] : [];
    }
  }

  private markdownLines(message: Message, text: string, width: number, dim = false): string[] {
    let entry = this.markdown.get(message);
    if (!entry) {
      const style = dim ? { color: (t: string) => this.theme.fg("dim", t) } : undefined;
      entry = { component: new Markdown(text, 0, 0, this.md, style, { preserveOrderedListMarkers: true, preserveBackslashEscapes: true }), text };
      this.markdown.set(message, entry);
    } else if (entry.text !== text) {
      entry.component.setText(text);
      if (!text.startsWith(entry.text)) entry.failed = false;
      entry.text = text;
    }
    if (!entry.failed) {
      try {
        return entry.component.render(width);
      } catch {
        // Deeply nested input can overflow the parser; show it raw instead.
        entry.failed = true;
      }
    }
    const raw = wrapTextWithAnsi(text, width);
    return dim ? raw.map((l) => this.theme.fg("dim", l)) : raw;
  }

  invalidate(): void {
    // Lines are cached per width only; a theme change re-creates the overlay.
  }

  dispose(): void {
    this.closed = true;
    this.unsubscribe();
    clearInterval(this.timer);
  }
}

function spread(left: string, right: string, width: number): string {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  return gap >= 1 ? `${left}${" ".repeat(gap)}${right}` : left;
}

/** The part of `ctx.ui` the viewer uses. */
export interface ViewerUI {
  custom<T>(
    factory: (tui: TUI, theme: any, keybindings: any, done: (result: T) => void) => Component & { dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: { anchor?: "center" | "top-left"; width?: `${number}%`; maxHeight?: `${number}%` } },
  ): Promise<T>;
}

/** Show `run`'s conversation full screen until the user goes back; `onOpen` gets a way to close it. */
export function openViewer(ui: ViewerUI, run: Run, actions: ViewerActions = {}, onOpen?: (close: () => void) => void): Promise<void> {
  return ui.custom<void>(
    (tui, theme, keybindings, done) => {
      onOpen?.(() => done(undefined));
      return new ConversationViewer(tui, run, theme, () => done(undefined), actions, keybindings);
    },
    { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: `${VIEWER_HEIGHT_PCT}%` } },
  );
}
