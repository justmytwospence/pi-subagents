import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { transcriptWriter } from "../src/conversation.ts";
import { recordedRun } from "../src/index.ts";
import { ConversationViewer, openViewer } from "../src/ui/viewer.ts";
import { KEY, fakeRun, fakeTui, fakeUI, plain } from "./ui-helpers.ts";

function liveRun() {
  const run = fakeRun({ child: {} as never, byJev: { agent: false, model: true, thinking: false }, state: { turns: 1, startedAt: Date.now() } });
  const c = run.conversation;
  c.apply({ type: "message_end", message: { role: "user", content: "Find where the config is loaded" } });
  c.apply({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Looking with **rg**." }, { type: "toolCall", id: "t", name: "bash", arguments: { command: "rg loadConfig" } }] } });
  c.apply({ type: "message_end", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "src/config.ts:8" }] } });
  return run;
}

function viewer(run = liveRun(), rows = 40) {
  const tui = fakeTui(rows);
  const calls = { done: 0, steer: [] as string[], stop: 0 };
  const v = new ConversationViewer(tui, run, plain, () => void calls.done++, {
    steer: (m) => {
      calls.steer.push(m);
      return true;
    },
    stop: () => void calls.stop++,
  });
  return { v, tui, calls, run };
}

const text = (lines: string[]) => lines.map((l) => l.trimEnd()).join("\n");

test("the viewer frames the header, the conversation and the live activity", () => {
  const { v, run } = viewer();
  run.conversation.apply({ type: "tool_execution_start", toolCallId: "u", toolName: "read", args: { path: "src/config.ts" } });
  const lines = v.render(80);
  // The whole screen (40 rows), under a banner that says it is not the main session.
  expect(lines).toHaveLength(40);
  expect(lines[0]).toContain("◀ esc · Subagent scout · not your main session");
  expect(lines.every((l) => visibleWidth(l) === 80)).toBe(true);
  const out = text(lines);
  expect(out).toContain("│ ● scout  Find where the config is loaded · ↻1 · 0s");
  expect(out).toContain("↳ anthropic/claude-haiku-5 (Jev) · low · async · r");
  expect(out).toMatch(/\[User\][^]*Find where the config is loaded[^]*\[Assistant\][^]*Looking with rg\.[^]*▸ bash: rg loadConfig[^]*\[Result: bash\][^]*src\/config\.ts:8/u);
  expect(out).toContain("▍ read: src/config.ts");
  expect(out).toContain("Enter steer · x stop");
  expect(out).toContain("esc back");
  v.dispose();
});

test("it follows new output until scrolled up, and again from the end", () => {
  const { v, run } = viewer(liveRun(), 20);
  for (let i = 0; i < 40; i++) run.conversation.apply({ type: "message_end", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: `line ${i}` }] } });
  expect(text(v.render(60))).toContain("line 39");
  v.handleInput(KEY.up);
  v.handleInput(KEY.up);
  run.conversation.apply({ type: "message_end", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "line 40" }] } });
  expect(text(v.render(60))).not.toContain("line 40");
  v.handleInput("\x1b[F"); // End
  expect(text(v.render(60))).toContain("line 40");
  v.dispose();
});

test("Enter steers through a composer; x twice stops; esc backs", () => {
  const { v, calls, tui } = viewer();
  v.render(80);
  v.handleInput(KEY.enter);
  expect(text(v.render(80))).toContain("✎ steer");
  for (const ch of "focus on tests") v.handleInput(ch);
  v.handleInput(KEY.enter);
  expect(calls.steer).toEqual(["focus on tests"]);
  v.handleInput(KEY.enter);
  v.handleInput(KEY.escape);
  expect(calls.steer).toHaveLength(1);
  expect(calls.done).toBe(0);
  v.handleInput("x");
  expect(text(v.render(80))).toContain("x again to stop");
  v.handleInput(KEY.down);
  expect(text(v.render(80))).toContain("x stop");
  v.handleInput("x");
  v.handleInput("x");
  expect(calls.stop).toBe(1);
  expect(tui.renders).toBeGreaterThan(0);
  v.handleInput(KEY.escape);
  expect(calls.done).toBe(1);
  v.dispose();
});

test("b moves a foreground run to the background, when offered", () => {
  let moved = 0;
  let offered = true;
  const v = new ConversationViewer(fakeTui(), liveRun(), plain, () => undefined, { background: () => void moved++, canBackground: () => offered });
  expect(text(v.render(120))).toContain("b background");
  v.handleInput("b");
  expect(moved).toBe(1);
  offered = false;
  expect(text(v.render(120))).not.toContain("b background");
  v.handleInput("b");
  expect(moved).toBe(1);
  v.dispose();
});

test("m cycles Markdown: assistant text, then tool results too, then nothing", () => {
  const { v, run } = viewer();
  run.conversation.apply({ type: "message_end", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "# Heading" }] } });
  const out = () => text(v.render(100));
  expect(out()).toContain("m md ·");
  expect(out()).toContain("Looking with rg.");
  expect(out()).toContain("# Heading");
  v.handleInput("m");
  expect(out()).toContain("m md+ ·");
  expect(out()).not.toContain("# Heading");
  v.handleInput("m");
  expect(out()).toContain("m raw ·");
  expect(out()).toContain("Looking with **rg**.");
  expect(out()).toContain("# Heading");
  v.handleInput("m");
  expect(out()).toContain("m md ·");
  v.dispose();
});

test("a finished run offers no steer or stop and shows how it ended", () => {
  const run = liveRun();
  run.state = { ...run.state, status: "failed", error: "pi exited (1)", endedAt: run.state.startedAt + 3_000 };
  run.child = undefined;
  run.conversation.close();
  const { v, calls } = viewer(run);
  const out = text(v.render(80));
  expect(out).toContain("✗ scout");
  expect(out).toContain("failed: pi exited (1)");
  expect(out).not.toContain("Enter steer");
  expect(out).not.toContain("▍");
  v.handleInput(KEY.enter);
  v.handleInput("x");
  v.handleInput("x");
  expect(calls).toMatchObject({ steer: [], stop: 0 });
  v.dispose();
});

test("openViewer shows an overlay that re-renders on new messages and resolves on close", async () => {
  const ui = fakeUI();
  const run = liveRun();
  const closed = openViewer(ui, run);
  expect(ui.customs[0]?.options).toMatchObject({ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" } });
  const before = ui.tui.renders;
  run.conversation.apply({ type: "message_start", message: { role: "assistant", content: [] } });
  expect(ui.tui.renders).toBe(before + 1);
  ui.customs[0]?.component.handleInput("q");
  await closed;
  run.conversation.apply({ type: "message_end", message: { role: "assistant", content: [] } });
  expect(ui.tui.renders).toBe(before + 1);
});

test("a recorded run opens from its saved conversation, or else its task and output", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "subagents-test-"));
  const record = { id: "abc123", agent: "scout", task: "t", model: "m/x", thinking: "low", byJev: { agent: true, model: false, thinking: false }, status: "running" as const, turns: 2, tokens: 1_500, cost: 0.01, seconds: 9, outputPath: path.join(dir, "abc123", "output.md"), async: true };
  mkdirSync(path.dirname(record.outputPath), { recursive: true });
  writeFileSync(record.outputPath, "the answer");
  const fallback = recordedRun(record);
  expect(fallback.conversation.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(fallback.state).toMatchObject({ status: "stopped", turns: 2, endedAt: 9_000 });
  const save = transcriptWriter(path.join(dir, "abc123", "messages.jsonl"));
  save({ role: "user", content: [{ type: "text", text: "t" }] });
  save({ role: "assistant", content: [{ type: "text", text: "a" }] });
  save({ role: "toolResult", content: [{ type: "text", text: "r" }] });
  expect(recordedRun(record).conversation.messages).toHaveLength(3);
});
