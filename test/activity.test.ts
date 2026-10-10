// Hosting another extension's section (pi-bg's background tasks): the shared panel, FleetView
// entries, double-clicks, and the event-bus handshake.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ACTIVITY_CHANGED, ACTIVITY_GONE, ACTIVITY_HOST, ACTIVITY_SECTION, type ActivityEntry, type ActivitySection } from "../src/activity.ts";
import subagents from "../src/index.ts";
import { FleetView, fleetRoster, renderFleet } from "../src/ui/fleet.ts";
import { PANEL_LINES, RunsWidget, renderPanel, shareLines } from "../src/ui/widget.ts";
import { harness } from "./harness.ts";
import { KEY, fakeRun, fakeUI, plain } from "./ui-helpers.ts";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "subagents-agent-"));
afterEach(() => vi.useRealTimers());

/** A section like pi-bg's: a header, then one row per entry. */
function fakeSection(entries: Partial<ActivityEntry>[] = [{}]) {
  const list: ActivityEntry[] = entries.map((e, i) => ({ key: `t${i}`, label: `task${i}`, detail: "npm test", status: "running", stats: "0:12", startedAt: i, ...e }));
  const calls = { opened: [] as string[], stopped: [] as string[], hosted: [] as boolean[] };
  const section: ActivitySection = {
    id: "bg",
    title: "background tasks",
    hasContent: () => list.length > 0,
    render: ({ maxLines }) => {
      const rows = list.slice(0, Math.max(0, maxLines - 1));
      return { lines: ["● Background", ...rows.map((e) => `└─ ${e.label}`)], targets: [undefined, ...rows.map((e) => e.key)] };
    },
    entries: () => list,
    open: async (key) => void calls.opened.push(key),
    stop: (key) => void calls.stopped.push(key),
    setHosted: (on) => void calls.hosted.push(on),
  };
  return { section, calls, list };
}

test("shareLines: what needs less than a share keeps it, the rest split what is left", () => {
  expect(shareLines([20, 3], 16)).toEqual([13, 3]);
  expect(shareLines([20, 20], 16)).toEqual([8, 8]);
  expect(shareLines([0, 5], 16)).toEqual([0, 5]);
  expect(shareLines([4, 4], 16)).toEqual([4, 4]);
  expect(shareLines([9, 30, 30], 16)).toEqual([6, 5, 5]);
});

test("the panel: subagents first, then the hosted section, under one budget, one blank row at the end", () => {
  const { section } = fakeSection([{}, {}]);
  const run = fakeRun({ state: { startedAt: 0 } });
  const panel = renderPanel({ runs: [run], queued: 0, sections: [section], now: 1_000, frame: 0, width: 100, theme: plain });
  expect(panel.lines).toEqual(["● Subagents  1 running", expect.stringContaining("└─ ⠋ scout"), expect.stringContaining("⎿"), "● Background", "└─ task0", "└─ task1", ""]);
  expect(panel.targets.map((t) => (t?.kind === "run" ? "run" : t?.kind === "section" ? t.key : "-"))).toEqual(["-", "run", "run", "-", "t0", "t1", "-"]);
  // Many rows of each: the budget is shared.
  const many = fakeSection(Array.from({ length: 30 }, () => ({})));
  const runs = Array.from({ length: 10 }, () => fakeRun());
  const full = renderPanel({ runs, queued: 0, sections: [many.section], now: 1_000, frame: 0, width: 100, theme: plain });
  expect(full.lines).toHaveLength(PANEL_LINES + 1);
  // Only the section has something: the panel is just that section.
  const alone = renderPanel({ runs: [], queued: 0, sections: [section], now: 0, frame: 0, width: 100, theme: plain });
  expect(alone.lines).toEqual(["● Background", "└─ task0", "└─ task1", ""]);
});

test("FleetView lists the section's entries after the runs: enter opens, x twice stops", async () => {
  const { section, calls } = fakeSection([{ label: "tests" }]);
  const run = fakeRun({ agent: "scout" });
  const roster = fleetRoster([run], 0, undefined, [section]);
  const idle = renderFleet({ roster, selected: 0, active: false, now: 0, width: 80, theme: plain });
  expect(idle[0]).toBe("  ↓ or ← for subagents and background tasks");
  expect(idle[4]).toMatch(/^ {2}○ tests {2}npm test +0:12$/u);

  const ui = fakeUI();
  const fleet = new FleetView({ runs: () => [run], enabled: () => true, actions: () => ({}), sections: () => [section] });
  fleet.setUI(ui);
  fleet.update();
  expect(ui.press(KEY.down)).toBe(true);
  expect(ui.press(KEY.down)).toBe(true);
  expect(ui.press("x")).toBe(true);
  expect(ui.render("subagents-fleet")[0]).toContain("x again to stop tests");
  expect(ui.press("x")).toBe(true);
  expect(calls.stopped).toEqual(["t0"]);
  expect(ui.press(KEY.enter)).toBe(true);
  await new Promise((r) => setTimeout(r, 0));
  expect(calls.opened).toEqual(["t0"]);
  fleet.dispose();
});

test("a double-click on a row opens it: a run's conversation, or the section's entry", () => {
  vi.useFakeTimers({ now: 0 });
  const { section } = fakeSection([{}]);
  const run = fakeRun();
  const opened: unknown[] = [];
  const ui = fakeUI();
  const widget = new RunsWidget({ runs: () => [run], queued: () => 0, mode: () => "background", sections: () => [section], open: (t) => void opened.push(t.kind === "run" ? t.id : t.key) });
  widget.setUI(ui);
  widget.update();
  const component = ui.widgets.get("subagents")?.component;
  component.render(100);
  const click = (y: number, clickCount = 2) => component.handleMouse({ type: "click", button: "left", x: 3, y, clickCount, screenX: 0, screenY: 0, width: 100, height: 6, shift: false, alt: false, ctrl: false });
  expect(click(1, 1)).toBeUndefined();
  expect(click(0)).toBeUndefined();
  expect(component.handleMouse({ type: "press", button: "left", x: 3, y: 1, screenX: 0, screenY: 0, width: 100, height: 6, shift: false, alt: false, ctrl: false })).toEqual({ handled: true, render: false });
  expect(click(2)).toEqual({ handled: true });
  expect(click(4)).toEqual({ handled: true });
  expect(opened).toEqual([run.id, "t0"]);
  widget.dispose();
});

/** The harness with a working event bus. */
function withBus() {
  const h = harness();
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const emitted: Array<[string, unknown]> = [];
  h.pi.events = {
    emit: (channel: string, data: unknown) => {
      emitted.push([channel, data]);
      for (const fn of listeners.get(channel) ?? []) fn(data);
    },
    on: (channel: string, fn: (data: unknown) => void) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), fn]);
      return () => undefined;
    },
  } as any;
  return { h, emitted };
}

test("the handshake: hosting in the TUI, a section offered before or after, and letting go at the end", async () => {
  const { h, emitted } = withBus();
  subagents(h.pi);
  const early = fakeSection([{ label: "early" }]);
  // Offered before we host: ignored, until our session start asks again.
  h.pi.events.emit(ACTIVITY_SECTION, { section: early.section });
  expect(early.calls.hosted).toEqual([]);
  h.pi.events.on(ACTIVITY_HOST, () => h.pi.events.emit(ACTIVITY_SECTION, { section: early.section }));
  const ui = fakeUI();
  const ctx = h.ctx({ ui, sessionManager: { getBranch: () => [], getSessionId: () => "s" } });
  await h.emit("session_start", { type: "session_start" }, ctx);
  expect(emitted.some(([c]) => c === ACTIVITY_HOST)).toBe(true);
  expect(early.calls.hosted).toEqual([true]);
  expect(ui.render("subagents")).toEqual(["● Background", "└─ early", ""]);
  // A changed section redraws; a gone one leaves the panel.
  h.pi.events.emit(ACTIVITY_CHANGED, { id: "bg" });
  h.pi.events.emit(ACTIVITY_GONE, { id: "bg" });
  expect(ui.widgets.has("subagents")).toBe(false);
  // Offered again, then our session ends: it gets its own panel back.
  h.pi.events.emit(ACTIVITY_SECTION, { section: early.section });
  expect(early.calls.hosted).toEqual([true, true]);
  await h.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  expect(early.calls.hosted).toEqual([true, true, false]);
});

test("no panel to host in (RPC mode, or the widget off): sections are left to show their own", async () => {
  const { h } = withBus();
  subagents(h.pi);
  const s = fakeSection();
  h.pi.events.on(ACTIVITY_HOST, () => h.pi.events.emit(ACTIVITY_SECTION, { section: s.section }));
  await h.emit("session_start", { type: "session_start" }, h.ctx({ ui: fakeUI(), mode: "rpc" }));
  h.pi.events.emit(ACTIVITY_SECTION, { section: s.section });
  expect(s.calls.hosted).toEqual([]);
});
