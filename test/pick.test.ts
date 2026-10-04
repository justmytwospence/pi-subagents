import { expect, test } from "vitest";
import { GENERAL, parseAgent } from "../src/agents.ts";
import { DEFAULT_TIER_DESCRIPTIONS, pickQuestions, readPicks, resolve } from "../src/pick.ts";

const scout = parseAgent("---\nname: scout\ndescription: Fast recon\ntools: read, grep\nmodel: anthropic/claude-haiku-5\n---\nYou are a scout.", "user")!;
const reviewer = parseAgent("---\nname: reviewer\ndescription: Code review\nthinking: high\n---\nReview carefully.", "project")!;
const agents = [GENERAL, scout, reviewer];
const tiers = { models: { fast: "anthropic/claude-haiku-5", strong: "anthropic/claude-opus-5-5" }, descriptions: DEFAULT_TIER_DESCRIPTIONS };
const parent = { model: "anthropic/claude-sonnet-5-5", thinking: "medium" };

test("parseAgent reads frontmatter", () => {
  expect(scout).toMatchObject({ name: "scout", tools: ["read", "grep"], model: "anthropic/claude-haiku-5", prompt: "You are a scout.", source: "user" });
  expect(reviewer.thinking).toBe("high");
  expect(parseAgent("no frontmatter", "user")).toBeUndefined();
});

test("questions only for the gaps", () => {
  expect(Object.keys(pickQuestions({}, agents, tiers, true))).toEqual(["role", "tier", "effort"]);
  expect(Object.keys(pickQuestions({ agent: "scout", model: "x", thinking: "low" }, agents, tiers, true))).toEqual([]);
  expect(Object.keys(pickQuestions({}, [GENERAL], tiers, false))).toEqual(["effort"]);
});

test("readPicks applies the confidence floors", () => {
  expect(
    readPicks({
      role: { type: "choice", choice: "reviewer", probabilities: {}, confidence: 0.7 },
      tier: { type: "choice", choice: "strong", probabilities: {}, confidence: 0.3 },
      effort: { type: "score", score: 2.6, confidence: 0.9 },
    }),
  ).toEqual({ agent: "reviewer", tier: "balanced", thinking: "xhigh" });
  expect(readPicks({ role: { type: "choice", choice: "scout", probabilities: {}, confidence: 0.2 } })).toEqual({});
});

test("precedence: arguments, agent file, Jev, defaults", () => {
  const jev = { agent: "reviewer", tier: "strong" as const, thinking: "low" };
  expect(resolve({}, agents, jev, tiers, parent)).toMatchObject({ agent: { name: "reviewer" }, model: "anthropic/claude-opus-5-5", thinking: "high", byJev: { agent: true, model: true, thinking: false } });
  expect(resolve({ agent: "scout" }, agents, jev, tiers, parent)).toMatchObject({ model: "anthropic/claude-haiku-5", thinking: "low", byJev: { agent: false, model: false, thinking: true } });
  expect(resolve({ agent: "scout", model: "x/y", thinking: "max" }, agents, jev, tiers, parent)).toMatchObject({ model: "x/y", thinking: "max" });
  expect(resolve({}, agents, undefined, tiers, parent)).toMatchObject({ agent: { name: "general" }, model: parent.model, thinking: "medium" });
  expect(resolve({ agent: "nope" }, agents, undefined, tiers, parent)).toEqual({ error: expect.stringMatching(/Unknown agent "nope"/u) });
});
