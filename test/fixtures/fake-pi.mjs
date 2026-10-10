// A stand-in for `pi --mode rpc`: answers one prompt with one tool call, asking one dialog first.
import { createInterface } from "node:readline";
const out = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
const args = process.argv.slice(2);
const rl = createInterface({ input: process.stdin });
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const call = { type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } };
let steered = "";
rl.on("line", (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "prompt") {
    out({ type: "response", command: "prompt", success: true, data: { disposition: "started" } });
    const user = { role: "user", content: cmd.message, timestamp: 1 };
    out({ type: "message_start", message: user });
    out({ type: "message_end", message: user });
    out({ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } });
    out({ type: "message_update", usage: zero, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    out({ type: "message_update", usage: zero, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Running " } });
    out({ type: "message_update", usage: zero, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "the tests" } });
    out({ type: "message_update", usage: zero, assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "c1", toolName: "bash" } });
    out({ type: "message_update", usage: zero, assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: call } });
    out({ type: "message_end", message: { role: "assistant", provider: "anthropic", model: "fake", content: [{ type: "text", text: "Running the tests" }, call], usage: zero, stopReason: "toolUse" } });
    out({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "npm test" } });
    out({ type: "extension_ui_request", id: "d1", method: "select", title: "Allow?", options: ["Allow once", "Block"] });
    globalThis.task = cmd.message;
  } else if (cmd.type === "steer") {
    steered = cmd.message;
  } else if (cmd.type === "extension_ui_response") {
    out({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
    const result = { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "ok" }], details: { big: true }, isError: false };
    out({ type: "message_start", message: result });
    out({ type: "message_end", message: result });
    const text = `task=${globalThis.task} answer=${cmd.value ?? "cancelled"} args=${args.join(" ")}${steered ? ` steered=${steered}` : ""}`;
    out({ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } });
    out({ type: "message_end", message: { role: "assistant", provider: "anthropic", model: "fake", content: [{ type: "text", text }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } }, stopReason: "stop" } });
    out({ type: "agent_settled" });
  }
});
rl.on("close", () => process.exit(0));
