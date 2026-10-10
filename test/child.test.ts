import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { Child, childArgs } from "../src/child.ts";
import { messageText, readTranscript, transcriptWriter } from "../src/conversation.ts";

const fake = { command: process.execPath, args: [path.join(import.meta.dirname, "fixtures", "fake-pi.mjs")] };

test("a child runs the task over RPC, forwards its dialog, and reports usage", async () => {
  const dialogs: string[] = [];
  const updates: string[] = [];
  const child = new Child({
    task: "count lines",
    cwd: process.cwd(),
    model: "anthropic/claude-sonnet-5-5",
    thinking: "low",
    tools: ["read", "bash"],
    sessionDir: "/tmp",
    invocation: fake,
    onUpdate: (s) => updates.push(s.activity ?? s.status),
    onDialog: async (request) => {
      dialogs.push(`${request.title}: ${request.options?.join("/")}`);
      return { value: "Allow once" };
    },
  }).start();
  const state = await child.done;
  expect(state.status).toBe("done");
  expect(state.output).toBe("task=count lines answer=Allow once args=--mode rpc --no-session --model anthropic/claude-sonnet-5-5 --thinking low --tools read,bash");
  expect(dialogs).toEqual(["Allow?: Allow once/Block"]);
  expect(updates).toContain("bash: npm test");
  expect(state.usage.cost.total).toBeCloseTo(0.03);
  expect(state.model).toBe("anthropic/fake");
});

test("a child keeps its conversation and saves each finished message", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "subagents-test-")), "messages.jsonl");
  const child = new Child({ task: "t", cwd: process.cwd(), model: "m", thinking: "low", sessionDir: "/tmp", invocation: fake, onMessage: transcriptWriter(file) }).start();
  const seen: string[] = [];
  child.conversation.subscribe(() => {
    const open = child.conversation.streaming;
    if (open?.role === "assistant" && messageText(open)) seen.push(messageText(open));
  });
  await child.done;
  const c = child.conversation;
  expect(c.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
  expect(seen).toContain("Running the tests");
  expect(c.messages[1]?.content[1]).toEqual({ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } });
  expect(c.toolUses).toBe(1);
  expect(c.activeTools.size).toBe(0);
  expect(readTranscript(file)).toEqual(c.messages);
});

test("dialogs are cancelled without a handler; steering reaches the child", async () => {
  const child = new Child({ task: "t", cwd: process.cwd(), model: "m", thinking: "high", sessionDir: "/tmp", invocation: fake }).start();
  child.steer("focus on tests");
  const state = await child.done;
  expect(state.output).toMatch(/answer=cancelled/u);
  expect(state.output).toMatch(/steered=focus on tests/u);
});

test("childArgs: fork and system prompt", () => {
  expect(childArgs({ task: "t", cwd: "/", model: "m", thinking: "low", sessionDir: "/s", forkSession: "/x.jsonl" }, "/p.md")).toEqual([
    "--mode", "rpc", "--fork", "/x.jsonl", "--session-dir", "/s", "--model", "m", "--thinking", "low", "--append-system-prompt", "/p.md",
  ]);
});
