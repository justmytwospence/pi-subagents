// Tasks routed by live Jev through Pi's model registry: `npm run eval`.
import { beforeAll, describe, expect, test } from "vitest";
import { GENERAL, parseAgent } from "../src/agents.ts";
import { DEFAULT_CONFIG } from "../src/index.ts";
import { askJev } from "../src/jev.ts";
import { DEFAULT_TIER_DESCRIPTIONS, pickQuestions, readPicks } from "../src/pick.ts";
import { hasCredentials, installedRegistry } from "./registry.ts";

const agent = (name: string, description: string) => parseAgent(`---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n`, "user")!;
const AGENTS = [
  GENERAL,
  agent("scout", "Fast read-only codebase recon: finds the relevant files, types, and functions and returns compressed context for another agent"),
  agent("planner", "Writes an implementation plan for a change, without editing code"),
  agent("reviewer", "Reviews a diff or change for bugs, risks, and style, without editing code"),
  agent("worker", "Implements a well-specified change: edits code, runs tests, and fixes failures"),
  agent("researcher", "Searches the web and documentation to answer questions about libraries, APIs, and tools"),
];

const CASES: Array<{ task: string; role: string }> = [
  { task: "Find where the HTTP retry policy is configured and list the files and functions involved.", role: "scout" },
  { task: "Map out how authentication flows through the codebase: which modules, which middleware.", role: "scout" },
  { task: "Which files import the legacy logger? Return paths with line numbers.", role: "scout" },
  { task: "Write a step-by-step implementation plan for adding rate limiting to the public API.", role: "planner" },
  { task: "Plan how to migrate the job queue from Redis to Postgres, with phases and risks.", role: "planner" },
  { task: "Review the changes in `git diff main` for bugs and security issues.", role: "reviewer" },
  { task: "Check this pull request's diff for race conditions and missing error handling.", role: "reviewer" },
  { task: "Implement the plan in PLAN.md: add the --dry-run flag and make the tests pass.", role: "worker" },
  { task: "Fix the failing test in test/parser.test.ts and make sure the whole suite passes.", role: "worker" },
  { task: "Rename the `fetchUser` function to `getUser` across the codebase and update the tests.", role: "worker" },
  { task: "What is the latest stable version of Vite and what changed in its config API?", role: "researcher" },
  { task: "Find out how Stripe recommends handling idempotency keys for retries, with links.", role: "researcher" },
  { task: "Compare zod and valibot bundle sizes and APIs using their documentation.", role: "researcher" },
  { task: "Summarize the README for me in five bullet points.", role: "general" },
  { task: "Explain the difference between a mutex and a semaphore with a short example.", role: "general" },
];

describe.skipIf(!hasCredentials)("pi-subagents live eval", () => {
  let registry: unknown;
  beforeAll(async () => {
    registry = await installedRegistry();
  });

  test.each(CASES)("$role: $task", async (c) => {
    const questions = pickQuestions({}, AGENTS, { models: { fast: "x", strong: "y" }, descriptions: DEFAULT_TIER_DESCRIPTIONS }, true);
    const outcome = await askJev(registry, { ...DEFAULT_CONFIG.jev, timeoutMs: 15_000 }, { task: c.task, parent_request: "(none)" }, questions);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const picks = readPicks(outcome.answers);
    const role = outcome.answers.role;
    console.log(`${c.role.padEnd(10)} got ${String(picks.agent ?? "general").padEnd(10)} conf ${role?.type === "choice" ? role.confidence.toFixed(2) : "-"} tier ${picks.tier} effort ${picks.thinking}  ${c.task.slice(0, 60)}`);
    expect(picks.agent ?? "general").toBe(c.role);
  });
});
