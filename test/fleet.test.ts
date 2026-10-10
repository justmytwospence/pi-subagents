import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, test, vi } from "vitest";
import { emptyUsage } from "../src/child.ts";
import { FleetView, SUCCESS_HINT_MS, fleetRoster, renderFleet } from "../src/ui/fleet.ts";
import { KEY, fakeRun, fakeUI, plain } from "./ui-helpers.ts";

afterEach(() => vi.useRealTimers());

const names = (roster: ReturnType<typeof fleetRoster>) => roster.map((e) => (e.kind === "main" ? "main" : e.kind === "run" ? e.run.agent : e.pill.label));

test("the roster: main, running and viewed runs earliest first, failures until the next message or x; then pills", () => {
  const now = 100_000;
  const late = fakeRun({ agent: "late", state: { startedAt: 50 } });
  const early = fakeRun({ agent: "early", state: { startedAt: 10 } });
  const done = fakeRun({ agent: "done", state: { status: "done", startedAt: 20, endedAt: now - 1 } });
  const failed = fakeRun({ agent: "failed", state: { status: "failed", startedAt: 30, endedAt: now - 60_000 } });
  // A success leaves at once (Claude Code); a failure stays while it ended after the last message.
  expect(names(fleetRoster([late, early, done, failed], now))).toEqual(["main", "early", "late"]);
  expect(names(fleetRoster([late, early, done, failed], now, undefined, [], 0))).toEqual(["main", "early", "failed", "late"]);
  expect(names(fleetRoster([late, early, done, failed], now, undefined, [], 0, new Set([failed.id])))).toEqual(["main", "early", "late"]);
  expect(names(fleetRoster([late, early, done, failed], now, `run:${done.id}`))).toEqual(["main", "early", "done", "late"]);
  // Pills end the list; with no runs there is no main row.
  const shells = { id: "bg", title: "shells", entries: () => [], open: async () => undefined, pill: () => ({ label: "2 shells" }) };
  expect(names(fleetRoster([early], now, undefined, [shells]))).toEqual(["main", "early", "2 shells"]);
  expect(names(fleetRoster([done], now, undefined, [shells]))).toEqual(["2 shells"]);
  expect(fleetRoster([done], now)).toEqual([]);
});

test("rows: the selection, stats flush right, a status icon once finished, and scrolling", () => {
  const usage = { ...emptyUsage(), input: 13_100 };
  const a = fakeRun({ agent: "scout", state: { startedAt: 0, usage } });
  const b = fakeRun({ agent: "reviewer", task: "Review the diff", state: { status: "failed", startedAt: 5_000, endedAt: 57_000 } });
  const roster = fleetRoster([a, b], 60_000, undefined, [], 0);
  const idle = renderFleet({ roster, selected: 0, active: false, now: 60_000, width: 80, theme: plain });
  expect(idle).toHaveLength(5);
  expect(idle.slice(0, 2)).toEqual([" ↓ or ← for subagents", " ○ main"]);
  expect(idle[2]).toMatch(/^ ○ Find where the config is loaded {2}scout +1m00s · ↓ 13\.1k tokens$/u);
  expect(idle[3]).toMatch(/^ ○ Review the diff {2}reviewer +✗ 52s · ↓ 0 tokens$/u);
  expect(idle[4]).toBe("");
  expect(idle.slice(2, 4).map(visibleWidth)).toEqual([80, 80]);
  const active = renderFleet({ roster, selected: 2, active: true, now: 60_000, width: 80, theme: plain });
  expect(active[0]).toContain("j/k select · l/enter view · x dismiss · h/esc back");
  expect(active[1]).toBe(" ○ main");
  expect(active[3]).toMatch(/^ ● Review the diff {2}reviewer/u);
  // A pill, and the note after a success.
  const shells = { id: "bg", title: "shells", entries: () => [], open: async () => undefined, pill: () => ({ label: "2 shells", alert: "1 failed" }) };
  const withPill = fleetRoster([a], 60_000, undefined, [shells]);
  expect(renderFleet({ roster: withPill, selected: 1, active: true, now: 60_000, width: 80, theme: plain, note: "/tasks to see subagents" }).slice(-3)).toEqual([
    " 2 shells  · 1 failed",
    " /tasks to see subagents",
    "",
  ]);
  expect(renderFleet({ roster: fleetRoster([], 0, undefined, [shells]), selected: 0, active: false, now: 0, width: 80, theme: plain })).toEqual([" 2 shells  · 1 failed", ""]);

  const many = fleetRoster(Array.from({ length: 8 }, (_, i) => fakeRun({ agent: `a${i}`, label: `Task ${i}`, state: { startedAt: i } })), 0);
  const top = renderFleet({ roster: many, selected: 0, active: true, now: 0, width: 60, theme: plain });
  expect(top.at(-2)?.trim()).toBe("↓ 3 more");
  const bottom = renderFleet({ roster: many, selected: 8, active: true, now: 0, width: 60, theme: plain });
  expect(bottom[2]?.trim()).toBe("↑ 3 more");
  expect(bottom.some((l) => l.includes("● Task 7  a7"))).toBe(true);
  expect(renderFleet({ roster: [], selected: 0, active: false, now: 0, width: 60, theme: plain })).toEqual([]);
});

function setup() {
  const ui = fakeUI();
  const runs = [fakeRun({ agent: "scout", label: "Find config", child: {} as never, state: { startedAt: Date.now() } }), fakeRun({ agent: "worker", label: "Fix config", child: {} as never, state: { startedAt: Date.now() + 1 } })];
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
  expect(ui.render("subagents-fleet")[0]).toContain("j/k select");
  expect(ui.render("subagents-fleet")[2]).toMatch(/● Find config {2}scout/u);
  expect(ui.press(KEY.down)).toBe(true);
  expect(ui.press(KEY.down)).toBe(true);
  expect(ui.render("subagents-fleet")[3]).toMatch(/● Fix config {2}worker/u);
  expect(ui.press(KEY.up)).toBe(true);
  expect(ui.press(KEY.up)).toBe(true);
  expect(ui.render("subagents-fleet")[1]).toBe(" ● main");
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
  runs[1]!.state = { ...runs[1]!.state, status: "done", endedAt: Date.now() - 1 };
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
  expect(ui.render("subagents-fleet")[1]).toBe(" ● main");
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
  expect(ui.render("subagents-fleet")[0]).toContain("l/enter view · x stop · h/esc back");
  expect(ui.press("x")).toBe(true);
  expect(ui.render("subagents-fleet")[0]).toContain("x again to stop Find config");
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

test("stop arming follows the row: if it leaves, the second x does not stop the row that took its place", () => {
  const { ui, runs, fleet, stopped } = setup();
  ui.press(KEY.down);
  expect(ui.press("x")).toBe(true);
  expect(ui.render("subagents-fleet")[0]).toContain("x again to stop Find config");
  // scout ends (a success leaves the list); worker moves up under the cursor.
  runs[0]!.state = { ...runs[0]!.state, status: "done", endedAt: Date.now() };
  fleet.update();
  expect(ui.render("subagents-fleet")[0]).not.toContain("x again");
  expect(ui.press("x")).toBe(true);
  expect(stopped).toEqual([]);
  expect(ui.render("subagents-fleet")[0]).toContain("x again to stop Fix config");
  fleet.dispose();
});

test("a success leaves at once with a note for 30 s; a failure stays until x; disabled, it never shows", () => {
  vi.useFakeTimers({ now: 1_000 });
  const ui = fakeUI();
  const runs = [fakeRun({ agent: "scout", child: {} as never, state: { startedAt: 0 } }), fakeRun({ agent: "worker", child: {} as never, state: { startedAt: 1 } })];
  let enabled = true;
  const dismissed = new Set<string>();
  const note = (now: number) => {
    const latest = Math.max(0, ...runs.filter((r) => r.state.status === "done").map((r) => r.state.endedAt ?? 0));
    return latest && now - latest < SUCCESS_HINT_MS ? "/tasks to see subagents" : undefined;
  };
  const fleet = new FleetView({ runs: () => runs, enabled: () => enabled, actions: () => ({}), dismissedAt: () => 0, dismissed: () => dismissed, dismiss: (id) => void dismissed.add(id), note });
  fleet.setUI(ui);
  fleet.update();
  runs[0]!.state = { ...runs[0]!.state, status: "done", endedAt: Date.now() };
  runs[1]!.state = { ...runs[1]!.state, status: "failed", endedAt: Date.now() };
  vi.advanceTimersByTime(300);
  const lines = ui.render("subagents-fleet");
  expect(lines.some((l) => l.includes("scout"))).toBe(false);
  expect(lines.some((l) => l.includes("worker"))).toBe(true);
  expect(lines.at(-2)).toBe(" /tasks to see subagents");
  // x on the failed run dismisses it; the note alone stays until its 30 s are up.
  ui.press(KEY.down);
  expect(ui.render("subagents-fleet")[0]).toContain("x dismiss");
  expect(ui.press("x")).toBe(true);
  expect(ui.render("subagents-fleet")).toEqual([" /tasks to see subagents", ""]);
  vi.advanceTimersByTime(SUCCESS_HINT_MS);
  expect(ui.widgets.has("subagents-fleet")).toBe(false);
  expect(ui.press(KEY.down)).toBe(false);
  runs.push({ ...runs[0]!, id: "new", state: { ...runs[0]!.state, status: "running", endedAt: undefined } } as never);
  enabled = false;
  fleet.update();
  expect(ui.widgets.has("subagents-fleet")).toBe(false);
  expect(ui.press(KEY.down)).toBe(false);
  fleet.dispose();
});

test("a pill: ↓ selects it when there are no runs; Enter opens its dialog, which owns the keys", async () => {
  const ui = fakeUI();
  let opened = 0;
  let close: () => void = () => undefined;
  const shells = {
    id: "bg",
    title: "shells",
    entries: () => [],
    open: async () => undefined,
    pill: () => ({ label: "2 shells" }),
    openDialog: () => {
      opened++;
      return new Promise<void>((resolve) => {
        close = resolve;
      });
    },
  };
  const fleet = new FleetView({ runs: () => [], enabled: () => true, actions: () => ({}), sections: () => [shells] });
  fleet.setUI(ui);
  fleet.update();
  expect(ui.render("subagents-fleet")).toEqual([" 2 shells ", ""]);
  expect(ui.press(KEY.down)).toBe(true);
  expect(ui.render("subagents-fleet")[0]).toBe("\x1b[7m 2 shells \x1b[27m  l/enter view · h/esc back");
  expect(ui.press(KEY.enter)).toBe(true);
  await Promise.resolve();
  expect(opened).toBe(1);
  expect(ui.press(KEY.down)).toBe(false);
  close();
  await new Promise((r) => setTimeout(r, 0));
  expect(ui.press(KEY.down)).toBe(true);
  expect(ui.press(KEY.escape)).toBe(true);
  fleet.dispose();
});

test("↓ leaves a draft for the list once the cursor is at its end; vim's j does in normal mode; hjkl move, open and go back", () => {
  const { ui, fleet } = setup();
  const editor = { text: "a draft", cursor: { line: 0, col: 3 }, mode: "insert", historyIndex: -1 };
  ui.tui.focused = {
    getText: () => editor.text,
    setText: () => undefined,
    getLines: () => editor.text.split("\n"),
    getCursor: () => editor.cursor,
    historyIndex: -1,
    getMode: () => editor.mode,
  };
  ui.editorText = editor.text;
  // Mid-line: the editor moves the cursor first.
  expect(ui.press(KEY.down)).toBe(false);
  editor.cursor = { line: 0, col: 7 };
  expect(ui.press(KEY.down)).toBe(true);
  expect(ui.render("subagents-fleet")[2]).toMatch(/● Find config {2}scout/u);
  // h goes back; ← with a draft stays in the editor.
  expect(ui.press("h")).toBe(true);
  expect(ui.press(KEY.left)).toBe(false);
  // vim: j in insert mode is typing; in normal mode at the last character it enters.
  expect(ui.press("j")).toBe(false);
  editor.mode = "normal";
  editor.cursor = { line: 0, col: 6 };
  expect(ui.press("j")).toBe(true);
  expect(ui.press("j")).toBe(true);
  expect(ui.render("subagents-fleet")[3]).toMatch(/● Fix config {2}worker/u);
  expect(ui.press("k")).toBe(true);
  expect(ui.render("subagents-fleet")[2]).toMatch(/● Find config {2}scout/u);
  expect(ui.press("l")).toBe(true);
  expect(ui.customs).toHaveLength(1);
  fleet.dispose();
});
