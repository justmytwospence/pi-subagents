import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { Conversation, RESULT_MAX_CHARS, describeActivity, messageText, readTranscript, transcriptWriter } from "../src/conversation.ts";

const update = (assistantMessageEvent: Record<string, unknown>) => ({ type: "message_update", usage: {}, assistantMessageEvent });

test("streaming deltas grow the open message; message_end replaces it", () => {
  const finished: string[] = [];
  const c = new Conversation((m) => finished.push(m.role));
  let changes = 0;
  c.subscribe(() => changes++);
  c.apply({ type: "message_start", message: { role: "user", content: "do it" } });
  c.apply({ type: "message_end", message: { role: "user", content: "do it" } });
  c.apply({ type: "message_start", message: { role: "assistant", content: [] } });
  c.apply(update({ type: "thinking_start", contentIndex: 0 }));
  c.apply(update({ type: "thinking_delta", contentIndex: 0, delta: "hmm" }));
  expect(describeActivity(c)).toBe("thinking…");
  c.apply(update({ type: "text_start", contentIndex: 1 }));
  c.apply(update({ type: "text_delta", contentIndex: 1, delta: "Hello " }));
  c.apply(update({ type: "text_delta", contentIndex: 1, delta: "world" }));
  expect(c.streaming?.content[1]).toEqual({ type: "text", text: "Hello world" });
  expect(describeActivity(c)).toBe("Hello world");
  c.apply(update({ type: "toolcall_start", contentIndex: 2, id: "t1", toolName: "read" }));
  c.apply(update({ type: "toolcall_delta", contentIndex: 2, delta: '{"pa' }));
  expect(describeActivity(c)).toBe("calling read…");
  c.apply({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm", thinkingSignature: "x" }, { type: "text", text: "Hello world", textSignature: "y" }, { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } }], stopReason: "toolUse" },
  });
  expect(c.streaming).toBeUndefined();
  expect(c.messages).toHaveLength(2);
  expect(c.messages[1]?.content).toEqual([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Hello world" }, { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } }]);
  expect(finished).toEqual(["user", "assistant"]);
  expect(changes).toBe(11);
  // Events that are not about the conversation change nothing.
  c.apply({ type: "turn_end" });
  expect(changes).toBe(11);
});

test("an update without message_start opens an assistant message; old cumulative updates replace it", () => {
  const c = new Conversation();
  c.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } });
  expect(messageText(c.messages[0]!)).toBe("partial");
  c.apply({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final" }] } });
  expect(c.messages.map(messageText)).toEqual(["final"]);
});

test("tools: active set, partial output, use count; long results are cut", () => {
  const c = new Conversation();
  c.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "npm   test" } });
  c.apply({ type: "tool_execution_start", toolCallId: "b", toolName: "grep", args: { pattern: "x" } });
  expect(describeActivity(c)).toBe("2 tools: bash, grep");
  c.apply({ type: "tool_execution_update", toolCallId: "a", partialResult: { content: [{ type: "text", text: "line 1" }] } });
  expect(c.activeTools.get("a")?.partial).toBe("line 1");
  c.apply({ type: "tool_execution_end", toolCallId: "b" });
  expect(describeActivity(c)).toBe("bash: npm test");
  expect(c.toolUses).toBe(2);
  const long = "x".repeat(RESULT_MAX_CHARS + 50);
  c.apply({ type: "message_start", message: { role: "toolResult", toolCallId: "a", toolName: "bash", content: [{ type: "text", text: long }, { type: "image", data: "AAAA", mimeType: "image/png" }], details: { diff: "big" }, isError: false } });
  c.apply({ type: "message_end", message: { role: "toolResult", toolCallId: "a", toolName: "bash", content: [{ type: "text", text: long }, { type: "image", data: "AAAA", mimeType: "image/png" }], details: { diff: "big" }, isError: false } });
  const result = c.messages[0]!;
  expect(messageText(result)).toHaveLength(RESULT_MAX_CHARS);
  expect(result.elided).toBe(50);
  expect(result.content[1]).toEqual({ type: "image" });
  expect(result).not.toHaveProperty("details");
  c.apply({ type: "queue_update", steering: ["focus"], followUp: [] });
  expect(c.queued).toEqual(["focus"]);
  c.close();
  expect(c.activeTools.size).toBe(0);
  expect(c.queued).toEqual([]);
});

test("the transcript file round-trips finished messages", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "subagents-test-")), "run", "messages.jsonl");
  const c = new Conversation(transcriptWriter(file));
  c.apply({ type: "message_end", message: { role: "user", content: "task" } });
  c.apply({ type: "message_end", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "y".repeat(RESULT_MAX_CHARS + 5) }] } });
  const back = readTranscript(file);
  expect(back).toEqual(c.messages);
  expect(back?.[1]?.elided).toBe(5);
  expect(readTranscript(path.join(file, "missing"))).toBeUndefined();
});
