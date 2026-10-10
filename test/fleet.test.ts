import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, test, vi } from "vitest";
import { emptyUsage } from "../src/child.ts";
import { FLEET_LINGER_MS, FleetView, fleetRoster, renderFleet } from "../src/ui/fleet.ts";
import { KEY, fakeRun, fakeUI, plain } from "./ui-helpers.ts";

afterEach(() => vi.useRealTimers());

const names = (roster: ReturnType<typeof fleetRoster>) => roster.map((e) => (e.kind === "main" ? "main" : e.kind === "run" ? e.run.agent : e.entry.label));

test("the roster: main, then running, viewed and just-finished runs, earliest first", () => {
  const now = 100_000;
  const late = fakeRun({ agent: "late", state: { startedAt: 50 } });
  const early = fakeRun({ agent: "early", state: { startedAt: 10 } });
  const fresh = fakeRun({ agent: "fresh", state: { status: "done", startedAt: 20, endedAt: now - FLEET_LINGER_MS + 1 } });
  const stale = fakeRun({ agent: "stale", state: { status: "failed", startedAt: 30, endedAt: now - FLEET_LINGER_MS } });
  expect(names(fleetRoster([late, early, fresh, stale], now))).toEqual(["main", "early", "fresh", "late"]);
  expect(names(fleetRoster([late, early, fresh, stale], now, `run:${stale.id}`))).toEqual(["main", "early", "fresh", "stale", "late"]);
  expect(fleetRoster([stale], now)).toHaveLength(1);
});

test("rows: the selection, stats flush right, a status icon once finished, and scrolling", () => {
  const usage = { ...emptyUsage(), input: 13_100 };
  const a = fakeRun({ agent: "scout", state: { startedAt: 0, usage } });
  const b = fakeRun({ agent: "reviewer", task: "Review the diff", state: { status: "done", startedAt: 5_000, endedAt: 57_000 } });
  const roster = fleetRoster([a, b], 60_000);
  const idle = renderFleet({ roster, selected: 0, active: false, now: 60_000, width: 80, theme: plain });
  expect(idle).toHaveLength(6);
  expect(idle.slice(0, 3)).toEqual(["  ↓ or ← for subagents", "", "  ● main"]);
  expect(idle[3]).toMatch(/^ {2}○ scout {2}Find where the config is loaded +1m00s · ↓ 13\.1k tokens$/u);
  expect(idle[4]).toMatch(/^ {2}○ reviewer {2}Review the diff +✓ 52s · ↓ 0 tokens$/u);
  expect(idle[5]).toBe("");
  expect(idle.slice(3, 5).map(visibleWidth)).toEqual([80, 80]);
  const active = renderFleet({ roster, selected: 2, active: true, now: 60_000, width: 80, theme: plain });
  expect(active[0]).toContain("↑↓ select · enter view · esc back");
  expect(active[2]).toBe("  ○ main");
  expect(active[4]).toMatch(/^ {2}● reviewer/u);

  const many = fleetRoster(Array.from({ length: 8 }, (_, i) => fakeRun({ agent: `a${i}`, state: { startedAt: i } })), 0);
  const top = renderFleet({ roster: many, selected: 0, active: true, now: 0, width: 60, theme: plain });
  expect(top.at(-2)?.trim()).toBe("↓ 3 more");
  const bottom = renderFleet({ roster: many, selected: 8, active: true, now: 0, width: 60, theme: plain });
  expect(bottom[3]?.trim()).toBe("↑ 3 more");
  expect(bottom.some((l) => l.includes("● a7"))).toBe(true);
  expect(renderFleet({ roster: [{ kind: "main" }], selected: 0, active: false, now: 0, width: 60, theme: plain })).toEqual([]);
});

function setup() {
  const ui = fakeUI();
  const runs = [fakeRun({ agent: "scout", child: {} as never, state: { startedAt: Date.now() } }), fakeRun({ agent: "worker", child: {} as never, state: { startedAt: Date.now() + 1 } })];
  let enabled = true;
  const steered: string[] = [];
  const stopped: string[] = [];
  const fleet = new FleetView({ runs: () => runs, enabled: () => enabled, actions: (run) => ({ steer: (m) => steered.push(m) > 0, stop: () => void stopped.push(run.agent) }) });
  fleet.setUI(ui);
  fleet.update();
  return { ui, runs, fleet, steered, stopped, disable: () => (enabled = false) };
}

test("↓ at an empty prompt enters the list; arrows select; Esc or ↑ past main leaves", () => {
  const { ui, fleet } = setup();
  expect(ui.widgets.get("subagents-fleet")?.placement).toBe("belowEditor");
  ui.editorText = "draft";
  expect(ui.press(KEY.down)).toBe(false);
  ui.editorText = "";
  expect(ui.press(KEY.down)).toBe(true);
  expect(ui.render("subagents-fleet")[0]).toContain("↑↓ select");
  expect(ui.render("subagents-fleet")[3]).toMatch(/● scout/u);
  expect(ui.press(KEY.down)).toBe(true);
  expect(ui.press(KEY.down)).toBe(true);
  expect(ui.render("subagents-fleet")[4]).toMatch(/● worker/u);
  expect(ui.press(KEY.up)).toBe(true);
  expect(ui.press(KEY.up)).toBe(true);
  expect(ui.render("subagents-fleet")[2]).toBe("  ● main");
  expect(ui.press(KEY.up)).toBe(true);
  expect(ui.render("subagents-fleet")[0]).toContain("↓ or ← for subagents");
  expect(ui.press(KEY.up)).toBe(false);
  // ← also enters; Esc leaves; typing leaves and reaches the editor.
  expect(ui.press(KEY.left)).toBe(true);
  expect(ui.press(KEY.escape)).toBe(true);
  expect(ui.press(KEY.escape)).toBe(false);
  expect(ui.press(KEY.left)).toBe(true);
  expect(ui.press("a")).toBe(false);
  expect(ui.render("subagents-fleet")[0]).toContain("↓ or ←");
  // A dialog has the keyboard: hands off.
  ui.tui.focused = { handleInput: () => undefined };
  expect(ui.press(KEY.down)).toBe(false);
  ui.tui.focused = { getText: () => "", setText: () => undefined };
  expect(ui.press(KEY.down)).toBe(true);
  fleet.dispose();
  expect(ui.widgets.has("subagents-fleet")).toBe(false);
  expect(ui.inputHandlers.size).toBe(0);
});

test("Enter opens the viewer, which owns the keys; closing it returns to the same row", async () => {
  const { ui, fleet, steered, runs } = setup();
  ui.press(KEY.down);
  ui.press(KEY.down);
  ui.press(KEY.enter);
  expect(ui.customs).toHaveLength(1);
  const viewer = ui.customs[0]!.component;
  // The run finishes while viewed; the viewer and its row stay.
  runs[1]!.state = { ...runs[1]!.state, status: "done", endedAt: Date.now() - FLEET_LINGER_MS * 2 };
  runs[1]!.child = undefined;
  expect(ui.press(KEY.down)).toBe(false);
  viewer.render(80);
  viewer.handleInput(KEY.enter);
  expect(steered).toEqual([]);
  viewer.handleInput(KEY.escape);
  await Promise.resolve();
  await Promise.resolve();
  expect(ui.customs).toHaveLength(0);
  // Back in the list; the finished run has now dropped out, so the selection clamps.
  expect(ui.press(KEY.up)).toBe(true);
  expect(ui.render("subagents-fleet")[2]).toBe("  ● main");
  ui.press(KEY.down);
  ui.press(KEY.enter);
  ui.customs[0]!.component.handleInput(KEY.enter);
  for (const ch of "hi") ui.customs[0]!.component.handleInput(ch);
  ui.customs[0]!.component.handleInput(KEY.enter);
  expect(steered).toEqual(["hi"]);
  fleet.dispose();
  expect(ui.customs).toHaveLength(0);
});

test("x twice stops the selected run; any other key disarms; x on main goes to the editor", () => {
  const { ui, fleet, stopped } = setup();
  ui.press(KEY.down);
  expect(ui.render("subagents-fleet")[0]).toContain("enter view · x stop · esc back");
  expect(ui.press("x")).toBe(true);
  expect(ui.render("subagents-fleet")[0]).toContain("x again to stop scout");
  expect(ui.press(KEY.down)).toBe(true);
  expect(ui.press("x")).toBe(true);
  expect(stopped).toEqual([]);
  expect(ui.press("x")).toBe(true);
  expect(stopped).toEqual(["worker"]);
  ui.press(KEY.up);
  ui.press(KEY.up);
  expect(ui.press("x")).toBe(false);
  fleet.dispose();
});

test("finished runs linger, then the list hides; disabled, it never shows", () => {
  vi.useFakeTimers({ now: 1_000 });
  const { ui, runs, fleet, disable } = setup();
  for (const r of runs) r.state = { ...r.state, status: "done", endedAt: Date.now() };
  vi.advanceTimersByTime(FLEET_LINGER_MS - 500);
  expect(ui.widgets.has("subagents-fleet")).toBe(true);
  vi.advanceTimersByTime(1_000);
  expect(ui.widgets.has("subagents-fleet")).toBe(false);
  expect(ui.press(KEY.down)).toBe(false);
  runs.push({ ...runs[0]!, id: "new", state: { ...runs[0]!.state, status: "running", endedAt: undefined } } as never);
  disable();
  fleet.update();
  expect(ui.widgets.has("subagents-fleet")).toBe(false);
  expect(ui.press(KEY.down)).toBe(false);
  fleet.dispose();
});
