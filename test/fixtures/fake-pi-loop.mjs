// A stand-in for `pi --mode rpc` that keeps calling tools, turn after turn, until it is steered
// (then it answers), unless FAKE_IGNORE_STEER is set; abort settles the run.
import { createInterface } from "node:readline";
const out = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
const rl = createInterface({ input: process.stdin });
let steered = false;
let timer;
let turn = 0;
const next = () => {
  turn++;
  if (steered && !process.env.FAKE_IGNORE_STEER) {
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `final after ${turn} turns` }], stopReason: "stop" } });
    out({ type: "agent_settled" });
    return;
  }
  out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `turn ${turn}` }, { type: "toolCall", id: `c${turn}`, name: "bash", arguments: {} }], stopReason: "toolUse" } });
  timer = setTimeout(next, 5);
};
rl.on("line", (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "prompt") {
    out({ type: "response", command: "prompt", success: true, data: { disposition: "started" } });
    timer = setTimeout(next, 5);
  } else if (cmd.type === "steer") {
    steered = true;
  } else if (cmd.type === "abort") {
    clearTimeout(timer);
    out({ type: "agent_settled", aborted: true });
  }
});
rl.on("close", () => process.exit(0));
