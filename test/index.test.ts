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
  expect(ui.selects[0]?.options).toEqual(["1. abc123  done    scout · m/x · low  look around"]);
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
