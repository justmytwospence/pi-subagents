import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import subagents, { truncateOutput } from "../src/index.ts";
import { harness } from "./harness.ts";
import { fakeUI } from "./ui-helpers.ts";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "subagents-agent-"));

test("truncateOutput keeps the start and points at the full output", () => {
  expect(truncateOutput("short", "/f")).toBe("short");
  const long = Array.from({ length: 2_500 }, (_, i) => `line ${i}`).join("\n");
  const out = truncateOutput(long, "/full.md");
  expect(out.split("\n").length).toBeLessThan(2_010);
  expect(out).toMatch(/Full output: \/full\.md\]$/u);
});

test("the UI binds in the TUI only; /subagents lists recorded runs and opens one", async () => {
  const h = harness();
  subagents(h.pi);
  const rpc = fakeUI();
  await h.emit("session_start", { type: "session_start" }, h.ctx({ ui: rpc, mode: "rpc" }));
  expect(rpc.inputHandlers.size).toBe(0);

  const ui = fakeUI();
  const entries: unknown[] = [];
  const ctx = h.ctx({ ui, sessionManager: { getBranch: () => entries, getSessionId: () => "s" } });
  await h.emit("session_start", { type: "session_start" }, ctx);
  expect(ui.inputHandlers.size).toBe(1);
  const command = h.commands.get("subagents");
  await command.handler("", ctx);
  expect(ui.notes).toEqual(["No subagent runs in this session."]);

  const record = { id: "abc123", agent: "scout", task: "look around", model: "m/x", thinking: "low", byJev: { agent: true, model: false, thinking: false }, status: "done", turns: 1, tokens: 10, cost: 0, seconds: 4, outputPath: "/nonexistent/abc123/output.md", async: true };
  entries.push({ type: "custom", customType: "subagents:run", data: { ...record, status: "running" } }, { type: "custom", customType: "subagents:run", data: record });
  ui.selectAnswers.push((options) => options[0]);
  const done = command.handler("", ctx);
  await new Promise((r) => setTimeout(r, 0));
  expect(ui.selects[0]?.options).toEqual(["1. abc123  done    look around · scout · m/x · low"]);
  expect(ui.customs).toHaveLength(1);
  ui.customs[0]?.component.handleInput("\x1b");
  await done;
  expect(ui.selects).toHaveLength(2);

  await command.handler("zzz", ctx);
  expect(ui.notes.at(-1)).toMatch(/No single run matches "zzz"/u);
  void command.handler("abc", ctx);
  await new Promise((r) => setTimeout(r, 0));
  expect(ui.customs).toHaveLength(1);
  ui.customs[0]?.component.handleInput("q");

  await command.handler("stop", ctx);
  expect(ui.notes.at(-1)).toBe("No subagents are running.");

  await h.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  expect(ui.inputHandlers.size).toBe(0);
});

test("at the deepest allowed level a subagent gets no subagent tool", () => {
  const registered = (depth: string | undefined) => {
    const h = harness();
    const tools: string[] = [];
    h.pi.registerTool = (tool: { name: string }) => void tools.push(tool.name);
    if (depth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
    else process.env.PI_SUBAGENT_DEPTH = depth;
    try {
      subagents(h.pi);
    } finally {
      delete process.env.PI_SUBAGENT_DEPTH;
    }
    return tools;
  };
  expect(registered(undefined)).toEqual(["subagent"]);
  expect(registered("1")).toEqual(["subagent"]);
  expect(registered("2")).toEqual([]);
});

test("b in FleetView moves a foreground call to the background; its result arrives as a message", async () => {
  const { setPiInvocation } = await import("../src/child.ts");
  setPiInvocation({ command: process.execPath, args: [path.join(import.meta.dirname, "fixtures", "fake-pi-loop.mjs")] });
  try {
    const h = harness();
    let tool: any;
    h.pi.registerTool = (t: unknown) => void (tool = t);
    subagents(h.pi);
    const ui = fakeUI();
    const cwd = mkdtempSync(path.join(tmpdir(), "subagents-cwd-"));
    const ctx = h.ctx({ ui, cwd, model: { provider: "p", id: "m" } });
    await h.emit("session_start", { type: "session_start" }, ctx);
    const call = tool.execute("t1", { task: "loop forever" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 100));
    expect(ui.press("\x1b[B")).toBe(true);
    expect(ui.render("subagents-fleet")[0]).toContain("b background");
    expect(ui.widgets.has("subagents")).toBe(false);
    expect(ui.press("b")).toBe(true);
    const result = await call;
    expect(result.content[0].text).toMatch(/^The user moved this single to the background: \w+ \(loop forever · general, p\/m, high\)/u);
    // Now a background run: still listed below the prompt (no widget above it by default), and b is no longer offered.
    expect(ui.widgets.has("subagents")).toBe(false);
    expect(ui.render("subagents-fleet")[0]).not.toContain("b background");
    expect(h.messages).toHaveLength(0);
    await h.commands.get("subagents").handler("stop all", ctx);
    await new Promise((r) => setTimeout(r, 200));
    expect(h.messages[0]?.message.content).toMatch(/^Subagent single finished:\n\n\[loop forever · general · p\/m · high · stopped\]/u);
    await h.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  } finally {
    setPiInvocation(undefined);
  }
});

test("a foreground call returns the child's answer and usage, and offers no detach after", async () => {
  const { setPiInvocation } = await import("../src/child.ts");
  setPiInvocation({ command: process.execPath, args: [path.join(import.meta.dirname, "fixtures", "fake-pi.mjs")] });
  try {
    const h = harness();
    let tool: any;
    h.pi.registerTool = (t: unknown) => void (tool = t);
    subagents(h.pi);
    const ui = fakeUI();
    const ctx = h.ctx({ ui, cwd: mkdtempSync(path.join(tmpdir(), "subagents-cwd-")), model: { provider: "p", id: "m" } });
    await h.emit("session_start", { type: "session_start" }, ctx);
    const result = await tool.execute("t1", { task: "count" }, undefined, undefined, ctx);
    expect(result.content[0].text).toMatch(/^\[count · general · anthropic\/fake · high · done\]\ntask=count answer=cancelled/u);
    expect(result.usage.cost.total).toBeCloseTo(0.03);
    expect(ui.selects[0]?.title).toBe("[subagent count · general] Allow?");
    await h.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  } finally {
    setPiInvocation(undefined);
  }
});

test("a run that ends after its session is gone calls no pi API (a stale runtime throws, which would take pi down)", async () => {
  const { setPiInvocation } = await import("../src/child.ts");
  setPiInvocation({ command: process.execPath, args: [path.join(import.meta.dirname, "fixtures", "fake-pi-loop.mjs")] });
  try {
    const h = harness();
    let tool: any;
    h.pi.registerTool = (t: unknown) => void (tool = t);
    subagents(h.pi);
    const ctx = h.ctx({ ui: fakeUI(), cwd: mkdtempSync(path.join(tmpdir(), "subagents-cwd-")), model: { provider: "p", id: "m" } });
    await h.emit("session_start", { type: "session_start" }, ctx);
    await tool.execute("t1", { task: "loop forever", async: true }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 100));
    await h.emit("session_shutdown", { type: "session_shutdown" }, ctx);
    // pi marks the runtime stale: every call throws from now on.
    const stale = () => {
      throw new Error("This extension ctx is stale");
    };
    h.pi.appendEntry = stale as never;
    h.pi.sendMessage = stale as never;
    h.pi.events.emit = stale as never;
    // The stopped child ends now; nothing may throw (an unhandled rejection fails this test).
    await new Promise((r) => setTimeout(r, 300));
    expect(h.messages).toHaveLength(0);
  } finally {
    setPiInvocation(undefined);
  }
});
