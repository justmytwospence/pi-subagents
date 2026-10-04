import type { AgentDef } from "./agents.ts";
import { type ClassifierAnswer, type ClassifierQuestion, choice, score } from "./jev.ts";

export type Tier = "fast" | "balanced" | "strong";
export const EFFORTS = ["low", "medium", "high", "xhigh"] as const;

export interface TierConfig {
  /** `provider/model` per tier; a missing tier uses the parent's model. */
  models: Partial<Record<Tier, string>>;
  descriptions: Record<Tier, string>;
}

export const DEFAULT_TIER_DESCRIPTIONS: Record<Tier, string> = {
  fast: "Quick lookups, searches, mechanical edits, summarizing, simple scripted work",
  balanced: "Ordinary implementation, debugging with clear symptoms, reviews, research",
  strong: "Subtle design, hard debugging, cross-cutting changes, correctness-critical work",
};

/** What the caller or the agent file already decided; Jev fills only the gaps. */
export interface Given {
  agent?: string;
  model?: string;
  thinking?: string;
}

/** The Jev questions for the gaps in `given`, or {} when nothing is left to decide. */
export function pickQuestions(given: Given, agents: readonly AgentDef[], tiers: TierConfig, askTier: boolean): Record<string, ClassifierQuestion> {
  const questions: Record<string, ClassifierQuestion> = {};
  if (!given.agent && agents.length > 1) {
    questions.role = {
      type: "choice",
      instructions: "Which agent is best suited to carry out `task`?",
      criteria: Object.fromEntries(agents.map((a) => [a.name, a.description])),
    };
  }
  if (!given.model && askTier) {
    questions.tier = {
      type: "choice",
      instructions: "How capable a model does `task` need?",
      criteria: tiers.descriptions,
    };
  }
  if (!given.thinking) {
    questions.effort = {
      type: "score",
      instructions: "How much careful reasoning does `task` need from the agent doing it?",
      criteria: [
        "A lookup, a search, or a mechanical change",
        "A routine change or a clear question",
        "A multi-step change, debugging with clear symptoms, or design in a known pattern",
        "Subtle design, a cross-cutting change, hard debugging, or correctness-critical work",
      ],
    };
  }
  return questions;
}

export interface Picks {
  agent?: string;
  tier?: Tier;
  thinking?: string;
}

/** Read Jev's answers: a role at confidence >= 0.5, a tier at >= 0.4 (else balanced), effort by score. */
export function readPicks(answers: Record<string, ClassifierAnswer>): Picks {
  const picks: Picks = {};
  const role = choice(answers, "role");
  if (role && role.confidence >= 0.5) picks.agent = role.choice;
  const tier = choice(answers, "tier");
  if (tier) picks.tier = tier.confidence >= 0.4 && ["fast", "balanced", "strong"].includes(tier.choice) ? (tier.choice as Tier) : "balanced";
  const effort = score(answers, "effort");
  if (effort) picks.thinking = EFFORTS[Math.min(3, Math.max(0, Math.round(effort.score)))];
  return picks;
}

export interface Resolved {
  agent: AgentDef;
  model: string;
  thinking: string;
  /** Which choices Jev made, for display. */
  byJev: { agent: boolean; model: boolean; thinking: boolean };
  tier?: Tier;
}

/**
 * Precedence for each choice: explicit arguments, then the agent file, then Jev, then defaults
 * (`general`, the balanced tier, the parent's model and thinking level).
 */
export function resolve(
  given: Given,
  agents: readonly AgentDef[],
  picks: Picks | undefined,
  tiers: TierConfig,
  parent: { model: string; thinking: string },
): Resolved | { error: string } {
  const byJev = { agent: false, model: false, thinking: false };
  let agentName = given.agent;
  if (!agentName && picks?.agent && agents.some((a) => a.name === picks.agent)) {
    agentName = picks.agent;
    byJev.agent = true;
  }
  agentName ??= "general";
  const agent = agents.find((a) => a.name === agentName);
  if (!agent) return { error: `Unknown agent "${agentName}". Available: ${agents.map((a) => a.name).join(", ")}.` };

  let model = given.model ?? agent.model;
  let tier: Tier | undefined;
  if (!model) {
    tier = picks?.tier ?? "balanced";
    model = tiers.models[tier] ?? parent.model;
    byJev.model = picks?.tier !== undefined && tiers.models[tier] !== undefined;
  }
  let thinking = given.thinking ?? agent.thinking;
  if (!thinking && picks?.thinking) {
    thinking = picks.thinking;
    byJev.thinking = true;
  }
  thinking ??= parent.thinking;
  return { agent, model, thinking, byJev, ...(tier ? { tier } : {}) };
}
