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

/** `general`, then `~/.pi/agent/agents/*.md`, then the nearest `<repo>/.pi/agents/*.md`; later names win. */
export function discoverAgents(cwd: string): AgentDef[] {
  const byName = new Map<string, AgentDef>([[GENERAL.name, GENERAL]]);
  for (const agent of loadDir(path.join(agentDir(), "agents"), "user")) byName.set(agent.name, agent);
  const project = projectAgentsDir(cwd);
  if (project) for (const agent of loadDir(project, "project")) byName.set(agent.name, agent);
  return [...byName.values()];
}
