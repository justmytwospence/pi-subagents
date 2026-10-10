// The live subagent widget above the editor: one row per running subagent (spinner, agent, task,
// model and effort, turns, tokens, cost, elapsed) with its current activity beneath, then finished
// runs for a few seconds with a status icon. It registers once and refreshes with requestRender(),
// like rpiv-todo's Todos widget, and hides itself when nothing is left to show. Double-clicking a
// run's row (fullscreen mode, where pi passes mouse events to widgets) opens its conversation.
//
// Off by default: like Claude Code, running subagents show in the panel below the prompt
// (FleetView); `"widget": "background"` or `"all"` in the settings brings this one back.
// Adapted from tintinweb/pi-subagents (MIT): https://github.com/tintinweb/pi-subagents
import type { TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { describeActivity } from "../conversation.ts";
import type { Run } from "../run.ts";
import { type Theme, SPINNER, dimAll, jev, modelAndEffort, runStats, statusIcon, taskLine } from "./format.ts";

export type WidgetMode = "background" | "all" | "off";
export const WIDGET_MODES: readonly WidgetMode[] = ["background", "all", "off"];

const WIDGET_KEY = "subagents";
/** Content rows (before the trailing blank) before the rest collapse into `+N more`. */
export const MAX_LINES = 12;
const FRAME_MS = 100;
/** How long a run that succeeded stays. A failed or stopped run stays until the user's next message. */
export const LINGER_MS = { done: 8_000 };

/** Whether a finished run still shows: a success for 8 s; anything else until a message after it ended (`dismissedAt`). */
export function lingers(run: Run, now: number, dismissedAt: number): boolean {
  const ended = run.state.endedAt;
  if (run.state.status === "running" || ended === undefined) return false;
  return run.state.status === "done" ? now - ended < LINGER_MS.done : ended > dismissedAt;
}

/** The runs the widget shows: by mode (background = async only), running or lingering. */
export function widgetRuns(runs: readonly Run[], mode: WidgetMode, now: number, dismissedAt: number): Run[] {
  if (mode === "off") return [];
  return runs.filter((r) => (mode === "all" || r.async) && (r.state.status === "running" || lingers(r, now, dismissedAt)));
}

export interface WidgetFrame {
  runs: readonly Run[];
  /** Tasks waiting for a free slot. */
  queued: number;
  now: number;
  frame: number;
  width: number;
  theme: Theme;
  /** Rows at most, header included (default 12). */
  maxLines?: number;
}

/** The widget's lines, or [] when there is nothing to show. */
export function renderWidget(f: WidgetFrame): string[] {
  const { lines } = renderSection(f);
  return lines.length ? withSpacer(lines) : lines;
}

/** The rows without the trailing blank, and which run each line belongs to. */
export function renderSection({ runs, queued, now, frame, width, theme, maxLines = MAX_LINES }: WidgetFrame): { lines: string[]; targets: (string | undefined)[] } {
  const running = runs.filter((r) => r.state.status === "running");
  // Successes one row each; failures and stops share one row, the latest, with a count of the rest.
  const held = runs.filter((r) => r.state.status !== "running" && r.state.status !== "done").sort((a, b) => (a.state.endedAt ?? 0) - (b.state.endedAt ?? 0));
  const latest = held.at(-1);
  const finished = [...runs.filter((r) => r.state.status === "done"), ...(latest ? [latest] : [])];
  const moreEnded = held.length - 1;
  if (!running.length && !finished.length && !queued) return { lines: [], targets: [] };
  const max = Math.max(2, maxLines);
  const cut = (line: string) => truncateToWidth(line, width);
  const active = running.length > 0 || queued > 0;
  const color = active ? "accent" : "dim";
  const spinner = SPINNER[frame % SPINNER.length] ?? "●";

  const runningRows = running.map((r) => [
    cut(`${theme.fg("dim", "├─")} ${theme.fg("accent", spinner)} ${theme.bold(r.agent)}${jev(r.byJev.agent, theme)}  ${theme.fg("muted", taskLine(r.task))} ${theme.fg("dim", "·")} ${dimAll(`${modelAndEffort(r, theme)} · ${runStats(r, now)}`, theme)}`),
    cut(theme.fg("dim", `│    ⎿  ${describeActivity(r.conversation)}`)),
  ]);
  const finishedRows = finished.map((r) => {
    const s = r.state;
    const note = s.status === "failed" ? theme.fg("error", ` failed${s.error ? `: ${taskLine(s.error, 60)}` : ""}`) : s.status === "stopped" ? theme.fg("muted", " stopped") : "";
    const more = r === latest && moreEnded > 0 ? theme.fg("dim", ` · +${moreEnded} more ended`) : "";
    return cut(`${theme.fg("dim", "├─")} ${statusIcon(s.status, theme)} ${theme.fg("muted", r.agent)}  ${theme.fg("dim", `${taskLine(r.task)} · ${runStats(r, now)}`)}${note}${more}`);
  });
  const queuedRow = queued ? cut(`${theme.fg("dim", "├─")} ${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued} queued`)}`) : undefined;

  const counts = [running.length ? `${running.length} running` : "", queued ? `${queued} queued` : ""].filter(Boolean).join(", ");
  const lines = [cut(`${theme.fg(color, active ? "●" : "○")} ${theme.fg(color, "Subagents")}${counts ? theme.fg("dim", `  ${counts}`) : ""}`)];
  const targets: (string | undefined)[] = [undefined];
  const body = runningRows.length * 2 + (queuedRow ? 1 : 0) + finishedRows.length;
  if (body <= max - 1) {
    running.forEach((r, i) => {
      lines.push(...(runningRows[i] as string[]));
      targets.push(r.id, r.id);
    });
    if (queuedRow) {
      lines.push(queuedRow);
      targets.push(undefined);
    }
    finished.forEach((r, i) => {
      lines.push(finishedRows[i] as string);
      targets.push(r.id);
    });
    closeTree(lines, !queuedRow && !finishedRows.length && runningRows.length > 0);
    return { lines, targets };
  }
  // Too many: running first, then the queue, then finished; the rest becomes `+N more`.
  let budget = max - 2 - (queuedRow ? 1 : 0);
  let hiddenRunning = 0;
  let hiddenFinished = 0;
  running.forEach((r, i) => {
    if (budget >= 2) {
      lines.push(...(runningRows[i] as string[]));
      targets.push(r.id, r.id);
      budget -= 2;
    } else hiddenRunning++;
  });
  if (queuedRow) {
    lines.push(queuedRow);
    targets.push(undefined);
  }
  finished.forEach((r, i) => {
    if (budget >= 1) {
      lines.push(finishedRows[i] as string);
      targets.push(r.id);
      budget--;
    } else hiddenFinished++;
  });
  const hidden = [hiddenRunning ? `${hiddenRunning} running` : "", hiddenFinished ? `${hiddenFinished} finished` : ""].filter(Boolean).join(", ");
  lines.push(cut(`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${hiddenRunning + hiddenFinished} more (${hidden})`)}`));
  targets.push(undefined);
  return { lines, targets };
}

/** A double-click of the left button (pi passes mouse events only in fullscreen mode). */
export function isDoubleClick(e: TuiMouseEvent): boolean {
  return e.type === "click" && e.button === "left" && (e.clickCount ?? 1) >= 2;
}

/** A blank row below, so the tree does not touch the editor's border (Pi adds one above only). */
function withSpacer(lines: string[]): string[] {
  lines.push("");
  return lines;
}

/** Turn the last item's `├─` into `└─` (and its activity line's `│` into a space). */
function closeTree(lines: string[], lastIsRunning: boolean) {
  const last = lines.length - 1;
  if (last < 1) return;
  if (lastIsRunning && last >= 2) {
    lines[last - 1] = (lines[last - 1] ?? "").replace("├─", "└─");
    lines[last] = (lines[last] ?? "").replace("│  ", "   ");
  } else lines[last] = (lines[last] ?? "").replace("├─", "└─");
}

/** The part of `ctx.ui` the widget uses. */
export interface WidgetUI {
  setWidget(
    key: string,
    content: ((tui: TUI, theme: any) => { render(width: number): string[]; invalidate(): void; handleMouse?(e: TuiMouseEvent): TuiMouseEventResult | undefined }) | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  readonly theme?: Theme;
}

export interface WidgetSource {
  runs(): readonly Run[];
  queued(mode: WidgetMode): number;
  mode(): WidgetMode;
  /** When the user last sent a message: failed and stopped runs that ended before it are hidden. */
  dismissedAt?(): number;
  /** A run's row was double-clicked: open its conversation. */
  open?(runId: string): void;
}

export class RunsWidget {
  private ui: WidgetUI | undefined;
  private tui: TUI | undefined;
  private registered = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;

  constructor(private readonly source: WidgetSource) {}

  /** Bind to a session's UI; a new UI (after /reload) re-registers on the next update. */
  setUI(ui: WidgetUI): void {
    if (ui === this.ui) return;
    this.ui = ui;
    this.registered = false;
    this.tui = undefined;
  }

  private visible(now: number) {
    const mode = this.source.mode();
    return { runs: widgetRuns(this.source.runs(), mode, now, this.source.dismissedAt?.() ?? 0), queued: mode === "off" ? 0 : this.source.queued(mode) };
  }

  update(): void {
    if (!this.ui) return;
    const now = Date.now();
    const { runs, queued } = this.visible(now);
    if (!runs.length && !queued) {
      this.hide();
      return;
    }
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.frame++;
        this.update();
      }, FRAME_MS);
      this.timer.unref?.();
    }
    if (this.registered) {
      this.tui?.requestRender();
      return;
    }
    const ui = this.ui;
    let targets: (string | undefined)[] = [];
    ui.setWidget(
      WIDGET_KEY,
      (tui, factoryTheme: Theme) => {
        this.tui = tui;
        return {
          render: (width: number) => {
            const now = Date.now();
            const panel = renderSection({ ...this.visible(now), now, frame: this.frame, width, theme: ui.theme ?? factoryTheme });
            targets = panel.targets;
            return panel.lines.length ? withSpacer(panel.lines) : panel.lines;
          },
          handleMouse: (e: TuiMouseEvent): TuiMouseEventResult | undefined => {
            const target = targets[e.y];
            if (!target || !this.source.open) return undefined;
            // pi turns a press and release into a click only for the component that took the press.
            if (e.type === "press" && e.button === "left") return { handled: true, render: false };
            if (!isDoubleClick(e)) return undefined;
            this.source.open(target);
            return { handled: true };
          },
          // Nothing is cached; the next render reads the current theme.
          invalidate: () => undefined,
        };
      },
      { placement: "aboveEditor" },
    );
    this.registered = true;
  }

  private hide() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.registered) this.ui?.setWidget(WIDGET_KEY, undefined);
    this.registered = false;
    this.tui = undefined;
  }

  dispose(): void {
    try {
      this.hide();
    } finally {
      this.ui = undefined;
    }
  }
}
