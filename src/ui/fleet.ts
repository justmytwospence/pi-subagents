// FleetView: a Claude Code-style list of `main` and the running subagents below the editor. ↓ or
// ← at an empty prompt moves into it; ↑/↓ select; Enter opens the selected run's conversation
// viewer (Esc there comes back here); x twice stops the selected run; Esc, or ↑ past `main`,
// returns to the prompt. Finished runs
// stay a few seconds, and a run whose viewer is open stays until it closes.
// Keys go through `onTerminalInput`, which sees them before the editor and can consume them, so
// nothing changes for normal typing: only arrows at an empty prompt, with the editor focused.
// Adapted from tintinweb/pi-subagents (MIT): https://github.com/tintinweb/pi-subagents
import { type TUI, isKeyRelease, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Run } from "../run.ts";
import { displayTokens } from "../run.ts";
import { type Theme, elapsedMs, formatCost, formatCount, formatElapsed, rightAlign, statusIcon, taskLine } from "./format.ts";
import { type ViewerActions, type ViewerUI, openViewer } from "./viewer.ts";

const FLEET_KEY = "subagents-fleet";
/** Subagent rows shown at once; the rest scroll. */
const MAX_ROWS = 5;
const TICK_MS = 250;
/** How long a finished run stays in the list. */
export const FLEET_LINGER_MS = 5_000;

export type FleetEntry = { kind: "main" } | { kind: "run"; run: Run };

/** `main`, then the runs worth listing, earliest first: running, being viewed, or just finished. */
export function fleetRoster(runs: readonly Run[], now: number, viewing?: string): FleetEntry[] {
  const listed = runs
    .filter((r) => r.state.status === "running" || r.id === viewing || (r.state.endedAt !== undefined && now - r.state.endedAt < FLEET_LINGER_MS))
    .sort((a, b) => a.state.startedAt - b.state.startedAt);
  return [{ kind: "main" }, ...listed.map((run) => ({ kind: "run" as const, run }))];
}

export interface FleetFrame {
  roster: readonly FleetEntry[];
  /** Index into the roster; 0 is `main`. */
  selected: number;
  active: boolean;
  /** The selected run is one `x` away from being stopped. */
  stopArmed?: boolean;
  now: number;
  width: number;
  theme: Theme;
}

export function renderFleet({ roster, selected, active, stopArmed, now, width, theme }: FleetFrame): string[] {
  const rows = roster.slice(1).flatMap((e) => (e.kind === "run" ? [e.run] : []));
  if (!rows.length) return [];
  const sel = Math.min(selected, rows.length);
  const bullet = (i: number) => (i === sel ? theme.fg("accent", "●") : theme.fg("dim", "○"));
  const chosen = rows[sel - 1];
  const stoppable = chosen?.state.status === "running";
  const hint = !active
    ? theme.fg("dim", "↓ or ← for subagents")
    : stopArmed && stoppable
      ? theme.fg("error", `x again to stop ${chosen.agent}`)
      : theme.fg("dim", `↑↓ select · enter view${stoppable ? " · x stop" : ""} · esc back`);
  const lines = [truncateToWidth(`  ${hint}`, width), "", truncateToWidth(`  ${bullet(0)} ${sel === 0 ? theme.fg("text", "main") : "main"}`, width)];
  const visible = Math.min(MAX_ROWS, rows.length);
  const selRow = Math.max(0, sel - 1);
  const start = selRow < visible ? 0 : selRow - visible + 1;
  if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
  for (let i = start; i < start + visible; i++) {
    const run = rows[i];
    if (!run) continue;
    const on = i + 1 === sel;
    const left = `  ${bullet(i + 1)} ${on ? theme.bold(theme.fg("text", run.agent)) : theme.fg("muted", run.agent)}  ${on ? theme.fg("text", taskLine(run.task, 60)) : taskLine(run.task, 60)}`;
    const cost = formatCost(run.state.usage.cost.total);
    const stats = `${formatElapsed(elapsedMs(run, now))} · ↓ ${formatCount(displayTokens(run.state.usage))} tokens${cost ? ` · ${cost}` : ""}`;
    const done = run.state.status === "running" ? "" : `${statusIcon(run.state.status, theme)} `;
    lines.push(rightAlign(left, done + theme.fg(on ? "text" : "dim", stats), width));
  }
  const below = rows.length - (start + visible);
  if (below > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${below} more`), width));
  // Pi puts the footer right under below-editor widgets.
  lines.push("");
  return lines;
}

/** The part of `ctx.ui` FleetView uses. */
export interface FleetUI extends ViewerUI {
  setWidget(key: string, content: ((tui: TUI, theme: any) => { render(width: number): string[]; invalidate(): void }) | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
  onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  getEditorText(): string;
  readonly theme?: Theme;
}

export interface FleetSource {
  runs(): readonly Run[];
  enabled(): boolean;
  actions(run: Run): ViewerActions;
}

type KeyResult = { consume?: boolean; data?: string } | undefined;

export class FleetView {
  private ui: FleetUI | undefined;
  private tui: TUI | undefined;
  private unsubscribeInput: (() => void) | undefined;
  private registered = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private active = false;
  private selected = 0;
  private viewing: string | undefined;
  private stopArmed = false;
  private closeViewer: (() => void) | undefined;

  constructor(private readonly source: FleetSource) {}

  setUI(ui: FleetUI): void {
    if (ui === this.ui) return;
    this.unsubscribeInput?.();
    this.ui = ui;
    this.registered = false;
    this.tui = undefined;
    this.unsubscribeInput = ui.onTerminalInput((data) => this.handleKey(data));
  }

  private roster() {
    return fleetRoster(this.source.runs(), Date.now(), this.viewing);
  }

  update(): void {
    if (!this.ui) return;
    const roster = this.roster();
    if (!this.source.enabled() || roster.length < 2) {
      if (this.registered) this.ui.setWidget(FLEET_KEY, undefined);
      this.registered = false;
      this.tui = undefined;
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.active = false;
      this.selected = 0;
      return;
    }
    this.selected = Math.min(this.selected, roster.length - 1);
    if (!this.timer) {
      this.timer = setInterval(() => this.update(), TICK_MS);
      this.timer.unref?.();
    }
    if (this.registered) {
      this.tui?.requestRender();
      return;
    }
    const ui = this.ui;
    ui.setWidget(
      FLEET_KEY,
      (tui, factoryTheme: Theme) => {
        this.tui = tui;
        return {
          render: (width: number) => renderFleet({ roster: this.roster(), selected: this.selected, active: this.active, stopArmed: this.stopArmed, now: Date.now(), width, theme: ui.theme ?? factoryTheme }),
          invalidate: () => undefined,
        };
      },
      { placement: "belowEditor" },
    );
    this.registered = true;
  }

  /** `{ consume: true }` for the keys the list takes; undefined lets a key through. */
  handleKey(data: string): KeyResult {
    if (!this.ui || !this.source.enabled() || isKeyRelease(data)) return undefined;
    // The viewer owns the keyboard while it is open.
    if (this.closeViewer) return undefined;
    // A dialog or another overlay has the keyboard; the editor's text is not what it seems.
    if (!this.editorFocused()) {
      if (this.active) this.deactivate();
      return undefined;
    }
    const roster = this.roster();
    if (!this.active) {
      if ((matchesKey(data, "down") || matchesKey(data, "left")) && roster.length > 1 && this.ui.getEditorText() === "") {
        this.active = true;
        this.selected = 1;
        this.update();
        return { consume: true };
      }
      return undefined;
    }
    const entry = roster[this.selected];
    const armed = this.stopArmed;
    this.stopArmed = false;
    if (matchesKey(data, "x") && entry?.kind === "run" && entry.run.state.status === "running") {
      // Two presses, so a stray x cannot kill a run.
      if (armed) this.source.actions(entry.run).stop?.();
      else this.stopArmed = true;
    } else if (matchesKey(data, "down")) {
      this.selected = Math.min(roster.length - 1, this.selected + 1);
    } else if (matchesKey(data, "up")) {
      if (this.selected === 0) this.active = false;
      else this.selected--;
    } else if (matchesKey(data, "escape")) {
      this.active = false;
      this.selected = 0;
    } else if (matchesKey(data, "enter")) {
      this.open(roster[this.selected]);
    } else {
      // Anything else goes back to the editor.
      this.deactivate();
      return undefined;
    }
    this.update();
    return { consume: true };
  }

  /** Pi's editor has `getText` and `setText`; its dialogs and overlays do not. Unknown focus counts as the editor. */
  private editorFocused(): boolean {
    const tui = this.tui as unknown as { getFocusedComponent?: () => unknown; focusedComponent?: unknown } | undefined;
    const focused = typeof tui?.getFocusedComponent === "function" ? tui.getFocusedComponent() : tui?.focusedComponent;
    if (focused == null) return true;
    const c = focused as { getText?: unknown; setText?: unknown };
    return typeof c.getText === "function" && typeof c.setText === "function";
  }

  private deactivate() {
    this.active = false;
    this.stopArmed = false;
    this.selected = 0;
    this.update();
  }

  private open(entry: FleetEntry | undefined) {
    if (!entry || entry.kind === "main" || !this.ui) {
      this.active = false;
      this.selected = 0;
      return;
    }
    const run = entry.run;
    this.viewing = run.id;
    const cleared = () => this.viewerClosed(run.id);
    openViewer(this.ui, run, this.source.actions(run), (close) => {
      this.closeViewer = close;
    }).then(cleared, cleared);
  }

  private viewerClosed(id: string) {
    this.closeViewer = undefined;
    this.viewing = undefined;
    // Back on the row just viewed, if it is still listed.
    const index = this.roster().findIndex((e) => e.kind === "run" && e.run.id === id);
    if (index > 0) this.selected = index;
    this.update();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribeInput?.();
    this.unsubscribeInput = undefined;
    const close = this.closeViewer;
    this.closeViewer = undefined;
    this.viewing = undefined;
    try {
      close?.();
      if (this.registered) this.ui?.setWidget(FLEET_KEY, undefined);
    } finally {
      this.registered = false;
      this.tui = undefined;
      this.active = false;
      this.ui = undefined;
    }
  }
}
