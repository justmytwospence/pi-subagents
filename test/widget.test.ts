import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, test, vi } from "vitest";
import { emptyUsage } from "../src/child.ts";
import { LINGER_MS, RunsWidget, type WidgetMode, renderWidget, widgetRuns } from "../src/ui/widget.ts";
import { fakeRun, fakeUI, plain } from "./ui-helpers.ts";

afterEach(() => vi.useRealTimers());

const usage = () => ({ ...emptyUsage(), input: 10_000, output: 2_000, cacheWrite: 300, cacheRead: 90_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 } });

test("background mode shows only async runs; successes linger briefly, failures until the next message", () => {
  const now = 100_000;
  const running = fakeRun();
  const sync = fakeRun({ async: false });
  const done = fakeRun({ state: { status: "done", endedAt: now - LINGER_MS.done + 1 } });
  const doneLong = fakeRun({ state: { status: "done", endedAt: now - LINGER_MS.done } });
  const failed = fakeRun({ state: { status: "failed", endedAt: now - LINGER_MS.done - 1 } });
  const all = [running, sync, done, doneLong, failed];
  expect(widgetRuns(all, "background", now, 0)).toEqual([running, done, failed]);
  expect(widgetRuns(all, "all", now, 0)).toEqual([running, sync, done, failed]);
  expect(widgetRuns(all, "off", now, 0)).toEqual([]);
  // A failure stays until the user's next message after it ended.
  expect(widgetRuns([failed], "background", now + 3_600_000, now - LINGER_MS.done - 2)).toEqual([failed]);
  expect(widgetRuns([failed], "background", now, now)).toEqual([]);
});

test("a running row: spinner, agent, Jev marks, model, effort, stats; activity beneath", () => {
  const r = fakeRun({ byJev: { agent: true, model: false, thinking: true }, state: { turns: 3, usage: usage(), startedAt: 0 } });
  r.conversation.apply({ type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: { command: "npm test" } });
  const lines = renderWidget({ runs: [r], queued: 0, now: 14_200, frame: 1, width: 200, theme: plain });
  expect(lines).toEqual([
    "● Subagents  1 running",
    "└─ ⠙ Find where the config is loaded  scout (Jev) · claude-haiku-5 · low (Jev) · ↻3 · 12.3k tokens · $0.012 · 14s",
    "     ⎿  bash: npm test",
    "",
  ]);
});

test("finished rows show a status icon; the queue gets a row; nothing to show is empty", () => {
  const ok = fakeRun({ agent: "reviewer", state: { status: "done", turns: 5, startedAt: 0, endedAt: 52_000 } });
  const bad = fakeRun({ agent: "worker", state: { status: "failed", error: "pi exited (1)", startedAt: 0, endedAt: 3_000 } });
  const stopped = fakeRun({ state: { status: "stopped", startedAt: 0, endedAt: 1_000 } });
  stopped.maxTurns = 10;
  const lines = renderWidget({ runs: [ok, bad, stopped], queued: 2, now: 60_000, frame: 0, width: 200, theme: plain });
  expect(lines).toEqual([
    "● Subagents  2 queued",
    "├─ ◦ 2 queued",
    "├─ ✓ Find where the config is loaded  reviewer · ↻5 · 52s",
    // Failures and stops share one row: the latest, with a count of the rest.
    "└─ ✗ Find where the config is loaded  worker · 3s failed: pi exited (1) · +1 more ended",
    "",
  ]);
  expect(renderWidget({ runs: [ok], queued: 0, now: 60_000, frame: 0, width: 200, theme: plain })[0]).toBe("○ Subagents");
  expect(renderWidget({ runs: [], queued: 0, now: 0, frame: 0, width: 80, theme: plain })).toEqual([]);
});

test("too many runs collapse into +N more, running first; lines fit the width", () => {
  const runs = [...Array.from({ length: 6 }, () => fakeRun({ label: "Task" })), fakeRun({ label: "Done", state: { status: "done", endedAt: 1 } })];
  const lines = renderWidget({ runs, queued: 0, now: 2, frame: 0, width: 40, theme: plain });
  expect(lines).toHaveLength(13);
  expect(lines.at(-2)).toBe("└─ +2 more (1 running, 1 finished)");
  expect(lines.at(-1)).toBe("");
  expect(lines.every((l) => visibleWidth(l) <= 40)).toBe(true);
});

test("the widget registers once, re-renders through the TUI, and hides when runs are gone", () => {
  vi.useFakeTimers({ now: 0 });
  const ui = fakeUI();
  let runs = [fakeRun()];
  let mode: WidgetMode = "background";
  const widget = new RunsWidget({ runs: () => runs, queued: () => 0, mode: () => mode });
  widget.update();
  expect(ui.calls).toEqual([]);
  widget.setUI(ui);
  widget.update();
  widget.update();
  expect(ui.calls).toEqual([["subagents", true]]);
  expect(ui.widgets.get("subagents")?.placement).toBe("aboveEditor");
  expect(ui.tui.renders).toBe(1);
  expect(ui.render("subagents")[1]).toContain("⠋ Find where the config is loaded");
  vi.advanceTimersByTime(100);
  expect(ui.render("subagents")[1]).toContain("⠙ Find where the config is loaded");
  runs[0]!.state = { ...runs[0]!.state, status: "done", endedAt: Date.now() };
  vi.advanceTimersByTime(LINGER_MS.done - 100);
  expect(ui.widgets.has("subagents")).toBe(true);
  vi.advanceTimersByTime(200);
  expect(ui.calls.at(-1)).toEqual(["subagents", false]);
  // Hidden with its timer stopped; a new run brings it back, unless the mode is off.
  const renders = ui.tui.renders;
  vi.advanceTimersByTime(1_000);
  expect(ui.tui.renders).toBe(renders);
  runs = [fakeRun()];
  mode = "off";
  widget.update();
  expect(ui.widgets.has("subagents")).toBe(false);
  mode = "all";
  widget.update();
  expect(ui.widgets.has("subagents")).toBe(true);
  widget.dispose();
  expect(ui.widgets.has("subagents")).toBe(false);
});
