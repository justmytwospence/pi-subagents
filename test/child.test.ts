import path from "node:path";
import { expect, test } from "vitest";
import { Child, childArgs } from "../src/child.ts";

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
