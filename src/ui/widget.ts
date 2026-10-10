// The live subagent widget above the editor: one row per running subagent (spinner, agent, task,
// model and effort, turns, tokens, cost, elapsed) with its current activity beneath, then finished
// runs for a few seconds with a status icon. It registers once and refreshes with requestRender(),
// like rpiv-todo's Todos widget, and hides itself when nothing is left to show.
// Adapted from tintinweb/pi-subagents (MIT): https://github.com/tintinweb/pi-subagents
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { describeActivity } from "../conversation.ts";
import type { Run } from "../run.ts";
import { type Theme, SPINNER, dimAll, jev, modelAndEffort, runStats, statusIcon, taskLine } from "./format.ts";

export type WidgetMode = "background" | "all" | "off";
export const WIDGET_MODES: readonly WidgetMode[] = ["background", "all", "off"];

const WIDGET_KEY = "subagents";
/** Content rows (before the trailing blank) before the rest collapse into `+N more`. */
const MAX_LINES = 12;
const FRAME_MS = 100;
/** How long a finished run stays: a success briefly, a failure or stop a little longer. */
export const LINGER_MS = { done: 8_000, other: 20_000 };

export function lingers(run: Run, now: number): boolean {
  const ended = run.state.endedAt;
  if (run.state.status === "running" || ended === undefined) return false;
  return now - ended < (run.state.status === "done" ? LINGER_MS.done : LINGER_MS.other);
}

/** The runs the widget shows: by mode (background = async only), running or lingering. */
export function widgetRuns(runs: readonly Run[], mode: WidgetMode, now: number): Run[] {
  if (mode === "off") return [];
  return runs.filter((r) => (mode === "all" || r.async) && (r.state.status === "running" || lingers(r, now)));
}

export interface WidgetFrame {
  runs: readonly Run[];
  /** Tasks waiting for a free slot. */
  queued: number;
  now: number;
  frame: number;
  width: number;
  theme: Theme;
}

/** The widget's lines, or [] when there is nothing to show. */
export function renderWidget({ runs, queued, now, frame, width, theme }: WidgetFrame): string[] {
  const running = runs.filter((r) => r.state.status === "running");
  const finished = runs.filter((r) => r.state.status !== "running");
  if (!running.length && !finished.length && !queued) return [];
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
    return cut(`${theme.fg("dim", "├─")} ${statusIcon(s.status, theme)} ${theme.fg("muted", r.agent)}  ${theme.fg("dim", `${taskLine(r.task)} · ${runStats(r, now)}`)}${note}`);
  });
  const queuedRow = queued ? cut(`${theme.fg("dim", "├─")} ${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued} queued`)}`) : undefined;

  const counts = [running.length ? `${running.length} running` : "", queued ? `${queued} queued` : ""].filter(Boolean).join(", ");
  const lines = [cut(`${theme.fg(color, active ? "●" : "○")} ${theme.fg(color, "Subagents")}${counts ? theme.fg("dim", `  ${counts}`) : ""}`)];
  const body = runningRows.length * 2 + (queuedRow ? 1 : 0) + finishedRows.length;
  if (body <= MAX_LINES - 1) {
    for (const pair of runningRows) lines.push(...pair);
    if (queuedRow) lines.push(queuedRow);
    lines.push(...finishedRows);
    closeTree(lines, !queuedRow && !finishedRows.length && runningRows.length > 0);
    return withSpacer(lines);
  }
  // Too many: running first, then the queue, then finished; the rest becomes `+N more`.
  let budget = MAX_LINES - 2 - (queuedRow ? 1 : 0);
  let hiddenRunning = 0;
  let hiddenFinished = 0;
  for (const pair of runningRows) {
    if (budget >= 2) {
      lines.push(...pair);
      budget -= 2;
    } else hiddenRunning++;
  }
  if (queuedRow) lines.push(queuedRow);
  for (const row of finishedRows) {
    if (budget >= 1) {
      lines.push(row);
      budget--;
    } else hiddenFinished++;
  }
  const hidden = [hiddenRunning ? `${hiddenRunning} running` : "", hiddenFinished ? `${hiddenFinished} finished` : ""].filter(Boolean).join(", ");
  lines.push(cut(`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${hiddenRunning + hiddenFinished} more (${hidden})`)}`));
  return withSpacer(lines);
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
  setWidget(key: string, content: ((tui: TUI, theme: any) => { render(width: number): string[]; invalidate(): void }) | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
  readonly theme?: Theme;
}

export interface WidgetSource {
  runs(): readonly Run[];
  queued(mode: WidgetMode): number;
  mode(): WidgetMode;
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
    return { runs: widgetRuns(this.source.runs(), mode, now), queued: mode === "off" ? 0 : this.source.queued(mode) };
  }

  update(): void {
    if (!this.ui) return;
    const { runs, queued } = this.visible(Date.now());
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
    ui.setWidget(
      WIDGET_KEY,
      (tui, factoryTheme: Theme) => {
        this.tui = tui;
        return {
          render: (width: number) => {
            const now = Date.now();
            return renderWidget({ ...this.visible(now), now, frame: this.frame, width, theme: ui.theme ?? factoryTheme });
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
