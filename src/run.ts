// One subagent run as the extension and its UI see it.
import path from "node:path";
import type { Child, ChildState, Usage } from "./child.ts";
import type { Conversation } from "./conversation.ts";
import type { Resolved, Tier } from "./pick.ts";

export interface Run {
  id: string;
  agent: string;
  task: string;
  model: string;
  thinking: string;
  byJev: Resolved["byJev"];
  tier?: Tier;
  cwd: string;
  async: boolean;
  state: ChildState;
  /** Set while the child process runs. */
  child?: Child;
  /** The agent's turn limit, if it has one. */
  maxTurns?: number;
  /** The child's conversation; outlives the process. */
  conversation: Conversation;
  outputPath: string;
}

/** Tokens to show for a run: input, output and cache writes. Cache reads re-count the same prefix every turn. */
export function displayTokens(usage: Usage): number {
  return usage.input + usage.output + usage.cacheWrite;
}

/** `messages.jsonl` beside the run's `output.md`. */
export function transcriptPath(outputPath: string): string {
  return path.join(path.dirname(outputPath), "messages.jsonl");
}
