// With pi-bg (activity.ts): its pill ends FleetView, our runs are a source for its dialog, and the
// event-bus handshake in either load order.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ACTIVITY_CHANGED, ACTIVITY_GONE, ACTIVITY_HOST, ACTIVITY_SECTION, type ActivitySection } from "../src/activity.ts";
import subagents from "../src/index.ts";
import { RunsWidget } from "../src/ui/widget.ts";
import { harness } from "./harness.ts";
import { fakeRun, fakeUI } from "./ui-helpers.ts";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "subagents-agent-"));
afterEach(() => vi.useRealTimers());

/** A source like pi-bg's: a pill, a dialog. */
function fakeShells(label = "2 shells") {
  const calls = { hosted: [] as boolean[], dialogs: 0 };
  const section: ActivitySection = {
    id: "bg",
    title: "shells",
    entries: () => [],
    open: async () => undefined,
    pill: () => ({ label }),
    openDialog: async () => void calls.dialogs++,
    setHosted: (on) => void calls.hosted.push(on),
  };
  return { section, calls };
}

/** The harness with a working event bus. */
function withBus() {
  const h = harness();
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const emitted: Array<[string, any]> = [];
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

test("hosting: a source offered before or after our session start ends FleetView with its pill; it is let go at the end", async () => {
  const { h, emitted } = withBus();
  subagents(h.pi);
  const shells = fakeShells();
  // Offered before we host: ignored, until our session start asks again.
  h.pi.events.emit(ACTIVITY_SECTION, { section: shells.section });
  expect(shells.calls.hosted).toEqual([]);
  h.pi.events.on(ACTIVITY_HOST, () => h.pi.events.emit(ACTIVITY_SECTION, { section: shells.section }));
  const ui = fakeUI();
  const ctx = h.ctx({ ui, sessionManager: { getBranch: () => [], getSessionId: () => "s" } });
  await h.emit("session_start", { type: "session_start" }, ctx);
  expect(emitted.some(([c]) => c === ACTIVITY_HOST)).toBe(true);
  expect(shells.calls.hosted).toEqual([true]);
  // No runs: FleetView is just the pill.
  expect(ui.render("subagents-fleet")).toEqual([" 2 shells ", ""]);
  // Offered again: still shown, not toggled.
  h.pi.events.emit(ACTIVITY_SECTION, { section: shells.section });
  expect(shells.calls.hosted).toEqual([true]);
  h.pi.events.emit(ACTIVITY_CHANGED, { id: "bg" });
  h.pi.events.emit(ACTIVITY_GONE, { id: "bg" });
  expect(ui.widgets.has("subagents-fleet")).toBe(false);
  h.pi.events.emit(ACTIVITY_SECTION, { section: shells.section });
  expect(shells.calls.hosted).toEqual([true, true]);
  await h.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  expect(shells.calls.hosted).toEqual([true, true, false]);
  expect(emitted.some(([c, d]) => c === ACTIVITY_GONE && d.id === "subagents")).toBe(true);
});

test("our runs are a source for pi-bg's dialog: entries, open, stop, dismiss", async () => {
  const { h, emitted } = withBus();
  subagents(h.pi);
  const ui = fakeUI();
  await h.emit("session_start", { type: "session_start" }, h.ctx({ ui, sessionManager: { getBranch: () => [], getSessionId: () => "s" } }));
  const offered = emitted.find(([c, d]) => c === ACTIVITY_SECTION && d.section.id === "subagents")?.[1].section as ActivitySection;
  expect(offered.title).toBe("subagents");
  expect(offered.entries(0)).toEqual([]);
});

test("no FleetView to host in (RPC mode, or fleetView off): sources are left to show their own pill", async () => {
  const { h } = withBus();
  subagents(h.pi);
  const s = fakeShells();
  h.pi.events.on(ACTIVITY_HOST, () => h.pi.events.emit(ACTIVITY_SECTION, { section: s.section }));
  await h.emit("session_start", { type: "session_start" }, h.ctx({ ui: fakeUI(), mode: "rpc" }));
  h.pi.events.emit(ACTIVITY_SECTION, { section: s.section });
  expect(s.calls.hosted).toEqual([]);
});

test("the widget above the prompt is off by default; on, a double-click on a run's row opens it", () => {
  vi.useFakeTimers({ now: 0 });
  const run = fakeRun();
  const opened: string[] = [];
  const ui = fakeUI();
  const widget = new RunsWidget({ runs: () => [run], queued: () => 0, mode: () => "background", open: (id) => void opened.push(id) });
  widget.setUI(ui);
  widget.update();
  const component = ui.widgets.get("subagents")?.component;
  component.render(100);
  const mouse = (type: string, y: number, clickCount = 2) => component.handleMouse({ type, button: "left", x: 3, y, clickCount, screenX: 0, screenY: 0, width: 100, height: 4, shift: false, alt: false, ctrl: false });
  expect(mouse("click", 1, 1)).toBeUndefined();
  expect(mouse("click", 0)).toBeUndefined();
  expect(mouse("press", 1)).toEqual({ handled: true, render: false });
  expect(mouse("click", 2)).toEqual({ handled: true });
  expect(opened).toEqual([run.id]);
  widget.dispose();
});
