import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { agentDir } from "./config.ts";

export interface AgentDef {
  name: string;
  description: string;
  /** Tool names for the child (`--tools`); undefined keeps Pi's defaults. */
  tools?: string[];
  /** `provider/model` or a model pattern Pi resolves. */
  model?: string;
  thinking?: string;
  /** Turns before the agent is told to wrap up; one turn later it is stopped. */
  maxTurns?: number;
  /** Appended to the child's system prompt. */
  prompt: string;
  source: "builtin" | "user" | "project";
  file?: string;
}

export const GENERAL: AgentDef = {
  name: "general",
  description: "General-purpose agent with Pi's default tools, for any self-contained task",
  prompt: "",
  source: "builtin",
};

export const EXPLORER: AgentDef = {
  name: "explorer",
  description: "Codebase exploration without changes: locate files, trace behavior, and return concise findings with references",
  tools: ["read", "grep", "find", "ls", "bash"],
  prompt: "You are a codebase explorer. Locate the relevant files and symbols, trace actual behavior, and return concise findings with file paths and line references. Distinguish evidence from assumptions and identify anything unresolved. Do not implement fixes or modify files. Use bash only for inspection, never for commands that change files or repository state. Your no-change policy is an instruction, not a filesystem sandbox.",
  source: "builtin",
};

export const REVIEWER: AgentDef = {
  name: "reviewer",
  description: "Independent review of changes for actionable bugs, regressions, security risks, and test gaps; report evidence without implementing fixes",
  tools: ["read", "grep", "find", "ls", "bash"],
  prompt: "You are an independent code reviewer. Inspect the requested changes and surrounding execution paths for actionable bugs, regressions, security risks, and missing tests. Prioritize concrete correctness issues over stylistic preferences. For each finding, give severity, a file and line reference, the failing scenario, and supporting evidence. Distinguish confirmed issues from uncertainty; say explicitly when no actionable issues were found. Do not implement fixes or modify files. Use bash only for inspection, never for commands that change files or repository state. Your no-change policy is an instruction, not a filesystem sandbox.",
  source: "builtin",
};

export const BUILTIN_AGENTS: readonly AgentDef[] = [GENERAL, EXPLORER, REVIEWER];

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function list(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const items = raw.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

export function parseAgent(content: string, source: AgentDef["source"], file?: string): AgentDef | undefined {
  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter<Record<string, unknown>>(content);
  } catch {
    return undefined;
  }
  const fm = parsed.frontmatter;
  if (typeof fm.name !== "string" || typeof fm.description !== "string") return undefined;
  const tools = list(fm.tools);
  const turns = Number(fm.maxTurns ?? fm.max_turns);
  const maxTurns = Number.isInteger(turns) && turns > 0 ? turns : undefined;
  return {
    name: fm.name.trim(),
    description: fm.description.trim(),
    ...(tools ? { tools } : {}),
    ...(typeof fm.model === "string" && fm.model.trim() ? { model: fm.model.trim() } : {}),
    ...(typeof fm.thinking === "string" && THINKING.has(fm.thinking.trim()) ? { thinking: fm.thinking.trim() } : {}),
    ...(maxTurns ? { maxTurns } : {}),
    prompt: parsed.body.trim(),
    source,
    ...(file ? { file } : {}),
  };
}

function loadDir(dir: string, source: "user" | "project"): AgentDef[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const file = path.join(dir, name);
    try {
      const agent = parseAgent(readFileSync(file, "utf8"), source, file);
      return agent ? [agent] : [];
    } catch {
      return [];
    }
  });
}

function projectAgentsDir(cwd: string): string | undefined {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, ".pi", "agents");
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // keep walking
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** Built-ins, then `~/.pi/agent/agents/*.md`, then the nearest `<repo>/.pi/agents/*.md`; later names win. */
export function discoverAgents(cwd: string): AgentDef[] {
  const byName = new Map<string, AgentDef>(BUILTIN_AGENTS.map((agent) => [agent.name, agent]));
  for (const agent of loadDir(path.join(agentDir(), "agents"), "user")) byName.set(agent.name, agent);
  const project = projectAgentsDir(cwd);
  if (project) for (const agent of loadDir(project, "project")) byName.set(agent.name, agent);
  return [...byName.values()];
}
