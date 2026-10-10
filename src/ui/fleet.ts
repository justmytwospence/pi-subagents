// FleetView: Claude Code's panel below the prompt. `main` and the subagents (running, plus failed
// or stopped ones until the user's next message or `x`), then the pills other extensions offer
// (pi-bg's `2 shells`). A run that succeeds leaves at once, and a dim `/tasks to see subagents`
// (or `/subagents ...` without pi-bg) shows for 30 s, as in Claude Code.
// ↓ at the bottom of the prompt (even with a draft in it), `j` in pi-vim's normal mode there, or ←
// at an empty prompt moves into it; ↑/↓ or k/j select; Enter or l opens the selected run's
// conversation viewer (Esc there comes back here) or the pill's dialog; x twice stops the selected
// run, x on an ended run dismisses it; b moves a foreground run to the background; Esc, h, or ↑/k
// past the first row, returns to the prompt. A run whose viewer is open stays until it closes.
// Keys go through `onTerminalInput`, which sees them before the editor and can consume them, so
// nothing changes for normal typing: only arrows at an empty prompt, with the editor focused.
// Adapted from tintinweb/pi-subagents (MIT): https://github.com/tintinweb/pi-subagents
import { type TUI, isKeyRelease, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { type ActivityPill, type ActivitySection, leavesPromptDown } from "../activity.ts";
import type { Run } from "../run.ts";
import { displayTokens } from "../run.ts";
import { type Theme, elapsedMs, formatCost, formatCount, formatElapsed, rightAlign, statusIcon, taskLine } from "./format.ts";
import { type ViewerActions, type ViewerUI, openViewer } from "./viewer.ts";

const FLEET_KEY = "subagents-fleet";
/** Subagent rows shown at once; the rest scroll. */
const MAX_ROWS = 5;
const TICK_MS = 250;
/** How long the hint after a subagent succeeds stays, as in Claude Code. */
export const SUCCESS_HINT_MS = 30_000;

export type FleetEntry = { kind: "main" } | { kind: "run"; run: Run } | { kind: "pill"; section: ActivitySection; pill: ActivityPill };

const entryKey = (e: FleetEntry) => (e.kind === "run" ? `run:${e.run.id}` : e.kind === "pill" ? `pill:${e.section.id}` : "main");

/** A failed or stopped run the user has not seen yet: it ended after their last message and is not dismissed. */
export function held(run: Run, dismissedAt: number, dismissed: ReadonlySet<string>): boolean {
  const s = run.state;
  return s.status !== "running" && s.status !== "done" && s.endedAt !== undefined && s.endedAt > dismissedAt && !dismissed.has(run.id);
}

/**
 * `main` and the runs worth listing (running, being viewed, or failed or stopped and unseen),
 * earliest first, then each section's pill. Without runs there is no `main` row, only the pills.
 */
export function fleetRoster(
  runs: readonly Run[],
  now: number,
  viewing?: string,
  sections: readonly ActivitySection[] = [],
  dismissedAt = Number.POSITIVE_INFINITY,
  dismissed: ReadonlySet<string> = new Set(),
): FleetEntry[] {
  const listed = runs
    .filter((r) => r.state.status === "running" || `run:${r.id}` === viewing || held(r, dismissedAt, dismissed))
    .sort((a, b) => a.state.startedAt - b.state.startedAt);
  const pills = sections.flatMap((section) => {
    let pill: ActivityPill | undefined;
    try {
      pill = section.pill?.(now);
    } catch {
      // Another extension's bug must not break the list.
    }
    return pill ? [{ kind: "pill" as const, section, pill }] : [];
  });
  return [...(listed.length ? [{ kind: "main" as const }] : []), ...listed.map((run) => ({ kind: "run" as const, run })), ...pills];
}

export interface FleetFrame {
  roster: readonly FleetEntry[];
  /** Index into the roster. */
  selected: number;
  active: boolean;
  /** The selected run is one `x` away from being stopped. */
  stopArmed?: boolean;
  /** The selected run is in the foreground and can be moved to the background. */
  canBackground?: boolean;
  /** A dim line under the list: `/tasks to see subagents`. */
  note?: string;
  now: number;
  width: number;
  theme: Theme & { inverse?(text: string): string };
}

export function renderFleet({ roster, selected, active, stopArmed, canBackground, note, now, width, theme }: FleetFrame): string[] {
  if (!roster.length && !note) return [];
  const lines: string[] = [];
  const runs = roster.flatMap((e) => (e.kind === "run" ? [e.run] : []));
  const pills = roster.flatMap((e, i) => (e.kind === "pill" ? [{ e, i }] : []));
  const sel = Math.min(selected, Math.max(0, roster.length - 1));
  const chosen = active ? roster[sel] : undefined;
  const bullet = (i: number) => (active && i === sel ? theme.fg("accent", "●") : theme.fg("dim", "○"));
  if (runs.length) {
    const stoppable = chosen?.kind === "run" && chosen.run.state.status === "running";
    const dismissable = chosen?.kind === "run" && chosen.run.state.status !== "running";
    const hint = !active
      ? theme.fg("dim", "↓ or ← for subagents")
      : stopArmed && stoppable
        ? theme.fg("error", `x again to stop ${chosen.run.agent}`)
        : chosen?.kind === "pill"
          ? theme.fg("dim", "j/k select · l/enter view · h/esc back")
          : theme.fg(
              "dim",
              `j/k select · l/enter view${stoppable ? " · x stop" : ""}${dismissable ? " · x dismiss" : ""}${stoppable && canBackground ? " · b background" : ""} · h/esc back`,
            );
    lines.push(truncateToWidth(`  ${hint}`, width));
    lines.push(truncateToWidth(`  ${bullet(0)} ${active && sel === 0 ? theme.fg("text", "main") : "main"}`, width));
    // Runs are roster rows 1..runs.length; scroll so the selected one shows.
    const visible = Math.min(MAX_ROWS, runs.length);
    const selRun = chosen?.kind === "run" ? sel - 1 : 0;
    const start = selRun < visible ? 0 : selRun - visible + 1;
    if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
    for (let i = start; i < start + visible; i++) {
      const run = runs[i];
      if (!run) continue;
      const on = active && i + 1 === sel;
      const left = `  ${bullet(i + 1)} ${on ? theme.bold(theme.fg("text", run.agent)) : theme.fg("muted", run.agent)}  ${on ? theme.fg("text", taskLine(run.task, 60)) : taskLine(run.task, 60)}`;
      const cost = formatCost(run.state.usage.cost.total);
      const stats = `${formatElapsed(elapsedMs(run, now))} · ↓ ${formatCount(displayTokens(run.state.usage))} tokens${cost ? ` · ${cost}` : ""}`;
      const done = run.state.status === "running" ? "" : `${statusIcon(run.state.status, theme)} `;
      lines.push(rightAlign(left, done + theme.fg(on ? "text" : "dim", stats), width));
    }
    const below = runs.length - (start + visible);
    if (below > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${below} more`), width));
  }
  // The pills: Claude Code's background-tasks indicator, inverse while selected.
  const inverse = (s: string) => (theme.inverse ? theme.inverse(s) : `\x1b[7m${s}\x1b[27m`);
  for (const { e, i } of pills) {
    if (e.kind !== "pill") continue;
    const on = active && i === sel;
    const label = on ? inverse(` ${e.pill.label} `) : theme.fg("muted", ` ${e.pill.label} `);
    const alert = e.pill.alert ? ` ${theme.fg("dim", "·")} ${theme.fg("error", e.pill.alert)}` : "";
    const hint = on && !runs.length ? theme.fg("dim", "  l/enter view · h/esc back") : "";
    lines.push(truncateToWidth(` ${label}${alert}${hint}`, width));
  }
  if (note) lines.push(truncateToWidth(`  ${theme.fg("dim", note)}`, width));
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
  /** Other extensions' sources whose pills end the list (pi-bg). */
  sections?(): readonly ActivitySection[];
  /** When the user last sent a message: failed and stopped runs that ended before it leave the list. */
  dismissedAt?(): number;
  /** Runs dismissed with `x`. */
  dismissed?(): ReadonlySet<string>;
  dismiss?(runId: string): void;
  /** The dim line under the list, if any (`/tasks to see subagents` after a success). */
  note?(now: number): string | undefined;
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
  /** The selected row by identity, so rows coming and going do not move the selection. */
  private selectedKey: string | undefined;
  /** The row one `x` away from being stopped. */
  private armedKey: string | undefined;
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
    return fleetRoster(this.source.runs(), Date.now(), this.viewing, this.source.sections?.() ?? [], this.source.dismissedAt?.(), this.source.dismissed?.());
  }

  /** The first row ↓ selects: the first run, or the first pill when there are no runs. */
  private firstRow(roster: readonly FleetEntry[]): number {
    return roster[0]?.kind === "main" ? 1 : 0;
  }

  /** Follows the selected row to where it is now, or clamps when it left. */
  private reselect(roster: readonly FleetEntry[]): void {
    const at = this.selectedKey ? roster.findIndex((e) => entryKey(e) === this.selectedKey) : -1;
    this.selected = at >= 0 ? at : Math.min(this.selected, Math.max(0, roster.length - 1));
    this.selectedKey = roster[this.selected] ? entryKey(roster[this.selected] as FleetEntry) : undefined;
  }

  private select(roster: readonly FleetEntry[], index: number): void {
    this.selected = index;
    this.selectedKey = roster[index] ? entryKey(roster[index] as FleetEntry) : undefined;
  }

  update(): void {
    if (!this.ui) return;
    const roster = this.roster();
    const note = this.source.note?.(Date.now());
    if (!this.source.enabled() || (!roster.length && !note)) {
      if (this.registered) this.ui.setWidget(FLEET_KEY, undefined);
      this.registered = false;
      this.tui = undefined;
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.active = false;
      this.selected = 0;
      return;
    }
    this.reselect(roster);
    if (!roster.length) this.active = false;
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
          render: (width: number) => {
            const roster = this.roster();
            this.reselect(roster);
            const entry = roster[this.selected];
            const canBackground = entry?.kind === "run" && Boolean(this.source.actions(entry.run).canBackground?.());
            const now = Date.now();
            const stopArmed = this.stopArmed && entry !== undefined && entryKey(entry) === this.armedKey;
            return renderFleet({ roster, selected: this.selected, active: this.active, stopArmed, canBackground, note: this.source.note?.(now), now, width, theme: ui.theme ?? factoryTheme });
          },
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
    if (!this.active) {
      // ↓ (or vim's j) at the bottom of the prompt, ← at an empty one; nothing else needs the list worked out.
      const focused = this.focused();
      // Without a view of the editor, only an empty prompt is safe to leave.
      const down = focused ? leavesPromptDown(focused, data, matchesKey(data, "down"), data === "j") : matchesKey(data, "down") && this.ui.getEditorText() === "";
      const left = matchesKey(data, "left") && this.ui.getEditorText() === "";
      if (!down && !left) return undefined;
      const roster = this.roster();
      if (roster.length > 0) {
        this.active = true;
        this.select(roster, this.firstRow(roster));
        this.update();
        return { consume: true };
      }
      return undefined;
    }
    const roster = this.roster();
    this.reselect(roster);
    const entry = roster[this.selected];
    // Armed only for the row that was selected when x was first pressed.
    const armed = this.stopArmed && entry !== undefined && entryKey(entry) === this.armedKey;
    this.stopArmed = false;
    this.armedKey = undefined;
    if (matchesKey(data, "x") && entry?.kind === "run" && entry.run.state.status === "running") {
      // Two presses, so a stray x cannot kill a run.
      if (armed) this.source.actions(entry.run).stop?.();
      else {
        this.stopArmed = true;
        this.armedKey = entryKey(entry);
      }
    } else if (matchesKey(data, "x") && entry?.kind === "run") {
      // An ended run: dismissed now instead of at the user's next message.
      this.source.dismiss?.(entry.run.id);
      const left = this.roster();
      if (!left.length) this.active = false;
      this.select(left, Math.min(this.selected, Math.max(0, left.length - 1)));
    } else if (matchesKey(data, "b") && entry?.kind === "run" && this.source.actions(entry.run).canBackground?.()) {
      this.source.actions(entry.run).background?.();
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.select(roster, Math.min(roster.length - 1, this.selected + 1));
    } else if (matchesKey(data, "up") || matchesKey(data, "k")) {
      if (this.selected === 0) this.active = false;
      else this.select(roster, this.selected - 1);
    } else if (matchesKey(data, "escape") || matchesKey(data, "h")) {
      this.active = false;
      this.selected = 0;
    } else if (matchesKey(data, "enter") || matchesKey(data, "l")) {
      this.open(roster[this.selected]);
    } else {
      // Anything else goes back to the editor.
      this.deactivate();
      return undefined;
    }
    this.update();
    return { consume: true };
  }

  private focused(): unknown {
    const tui = this.tui as unknown as { getFocusedComponent?: () => unknown; focusedComponent?: unknown } | undefined;
    return typeof tui?.getFocusedComponent === "function" ? tui.getFocusedComponent() : tui?.focusedComponent;
  }

  /** Pi's editor has `getText` and `setText`; its dialogs and overlays do not. Unknown focus counts as the editor. */
  private editorFocused(): boolean {
    const focused = this.focused();
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
    const key = entryKey(entry);
    this.viewing = key;
    const cleared = () => this.viewerClosed(key);
    if (entry.kind === "pill") {
      // The section's own dialog; it owns the keyboard until it closes.
      this.active = false;
      if (!entry.section.openDialog) return cleared();
      this.closeViewer = () => undefined;
      const ui = this.ui;
      const section = entry.section;
      // Never throws here: a bug in another extension must not leave the list owning no keys.
      Promise.resolve()
        .then(() => section.openDialog?.(ui))
        .then(cleared, cleared);
      return;
    }
    const run = entry.run;
    openViewer(this.ui, run, this.source.actions(run), (close) => {
      this.closeViewer = close;
    }).then(cleared, cleared);
  }

  private viewerClosed(key: string) {
    this.closeViewer = undefined;
    this.viewing = undefined;
    // Back on the row just viewed, if it is still listed.
    const roster = this.roster();
    const index = roster.findIndex((e) => entryKey(e) === key);
    if (index >= 0 && this.active) this.select(roster, index);
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
