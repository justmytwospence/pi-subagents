// A stand-in for `pi --mode rpc`: answers one prompt, asking one dialog first.
import { createInterface } from "node:readline";
const out = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
const args = process.argv.slice(2);
const rl = createInterface({ input: process.stdin });
let steered = "";
rl.on("line", (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "prompt") {
    out({ type: "response", command: "prompt", success: true, data: { disposition: "started" } });
    out({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } });
    out({ type: "extension_ui_request", id: "d1", method: "select", title: "Allow?", options: ["Allow once", "Block"] });
    globalThis.task = cmd.message;
  } else if (cmd.type === "steer") {
    steered = cmd.message;
  } else if (cmd.type === "extension_ui_response") {
    out({ type: "tool_execution_end", toolName: "bash" });
    const text = `task=${globalThis.task} answer=${cmd.value ?? "cancelled"} args=${args.join(" ")}${steered ? ` steered=${steered}` : ""}`;
    out({ type: "message_end", message: { role: "assistant", provider: "anthropic", model: "fake", content: [{ type: "text", text }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } }, stopReason: "stop" } });
    out({ type: "agent_settled" });
  }
});
rl.on("close", () => process.exit(0));
