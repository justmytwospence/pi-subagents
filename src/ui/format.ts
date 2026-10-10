// Shared formatting for the subagent widget, FleetView and conversation viewer.
// Adapted from tintinweb/pi-subagents (MIT): https://github.com/tintinweb/pi-subagents
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ChildStatus } from "../child.ts";
import { type Run, displayTokens } from "../run.ts";

/** The part of Pi's theme the UI uses. */
export interface Theme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** `850`, `12.3k`, `1.2M`. */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

export function formatTokens(n: number): string {
  return `${formatCount(n)} token${n === 1 ? "" : "s"}`;
}

/** `$0.012`; empty for a model without pricing. */
export function formatCost(cost: number): string {
  return cost > 0 ? `$${cost.toFixed(3)}` : "";
}

/** `14s`, `2m05s`, `1h02m`. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function elapsedMs(run: Run, now = Date.now()): number {
  return (run.state.endedAt ?? now) - run.state.startedAt;
}

/** The model id without its provider: `anthropic/claude-haiku-5` to `claude-haiku-5`. */
export function shortModel(model: string): string {
  return model.slice(model.lastIndexOf("/") + 1);
}

export function statusIcon(status: ChildStatus, theme: Theme): string {
  if (status === "running") return theme.fg("accent", "●");
  if (status === "done") return theme.fg("success", "✓");
  if (status === "stopped") return theme.fg("muted", "■");
  return theme.fg("error", "✗");
}

/** ` (Jev)` after a value Jev picked. */
export function jev(on: boolean, theme: Theme): string {
  return on ? theme.fg("dim", " (Jev)") : "";
}

/** `claude-haiku-5 (Jev) · low (Jev)`: the model and effort, marking Jev's picks. */
export function modelAndEffort(run: Run, theme: Theme, full = false): string {
  const model = run.state.model ?? run.model;
  return `${full ? model : shortModel(model)}${jev(run.byJev.model, theme)} · ${run.thinking}${jev(run.byJev.thinking, theme)}`;
}

/** The task's first line, whitespace collapsed, clipped. */
export function taskLine(task: string, max = 40): string {
  const flat = task.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `↻3 · 12.3k tokens · $0.012 · 14s`, leaving out what is zero. */
export function runStats(run: Run, now = Date.now()): string {
  const parts: string[] = [];
  if (run.state.turns) parts.push(`↻${run.state.turns}`);
  const tokens = displayTokens(run.state.usage);
  if (tokens) parts.push(formatTokens(tokens));
  const cost = formatCost(run.state.usage.cost.total);
  if (cost) parts.push(cost);
  parts.push(formatElapsed(elapsedMs(run, now)));
  return parts.join(" · ");
}

/** Put `right` flush to `width`, cutting `left` first so the stats survive. */
export function rightAlign(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  const leftClamped = truncateToWidth(left, Math.max(0, width - rightWidth - 1));
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightWidth);
  return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}

/** Restore a dim run after nested color resets, so `(Jev)` inside dim stats stays dim. */
export function dimAll(text: string, theme: Theme, color = "dim"): string {
  const start = theme.fg(color, "").replace(/\u001b\[(?:0|39)m/gu, "");
  return theme.fg(color, text.replace(/\u001b\[(?:0|39)m/gu, (reset) => `${reset}${start}`));
}
