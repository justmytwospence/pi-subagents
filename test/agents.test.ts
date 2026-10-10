import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BUILTIN_AGENTS, discoverAgents } from "../src/agents.ts";
import { DEFAULT_TIER_DESCRIPTIONS, pickQuestions, resolve } from "../src/pick.ts";

let root: string;
let user: string;
let project: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "pi-agent-defaults-"));
  user = path.join(root, "user");
  project = path.join(root, "project");
  mkdirSync(path.join(user, "agents"), { recursive: true });
  mkdirSync(project);
  vi.stubEnv("PI_CODING_AGENT_DIR", user);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const tiers = { models: {}, descriptions: DEFAULT_TIER_DESCRIPTIONS };
const parent = { model: "provider/model", thinking: "medium" };

test("ships general, explorer, reviewer without pinning model or effort", () => {
  const agents = discoverAgents(project);
  expect(agents.map((agent) => agent.name)).toEqual(["general", "explorer", "reviewer"]);
  expect(agents).toEqual(BUILTIN_AGENTS);
  for (const agent of agents) {
    expect(agent.source).toBe("builtin");
    expect(agent.model).toBeUndefined();
    expect(agent.thinking).toBeUndefined();
    expect(resolve({ agent: agent.name }, agents, undefined, tiers, parent)).toMatchObject(parent);
  }
  expect(agents[0]?.tools).toBeUndefined();
  for (const agent of agents.slice(1)) {
    expect(agent.tools).toEqual(["read", "grep", "find", "ls", "bash"]);
    expect(agent.prompt).toContain("Do not implement fixes or modify files");
    expect(agent.prompt).toContain("not a filesystem sandbox");
  }
  expect(pickQuestions({}, agents, tiers, false).role).toMatchObject({
    criteria: Object.fromEntries(agents.map((agent) => [agent.name, agent.description])),
  });
  expect(resolve({}, agents, undefined, tiers, parent)).toMatchObject({ agent: { name: "general" } });
});

test("user roles override built-ins and nearest project roles override user roles", () => {
  writeFileSync(path.join(user, "agents", "explorer.md"), "---\nname: explorer\ndescription: User explorer\nmodel: user/model\n---\nUser prompt");
  expect(discoverAgents(project).find((agent) => agent.name === "explorer")).toMatchObject({ source: "user", model: "user/model", prompt: "User prompt" });
  const projectAgents = path.join(project, ".pi", "agents");
  mkdirSync(projectAgents, { recursive: true });
  writeFileSync(path.join(projectAgents, "explorer.md"), "---\nname: explorer\ndescription: Project explorer\n---\nProject prompt");
  const nested = path.join(project, "src", "nested");
  mkdirSync(nested, { recursive: true });
  const agents = discoverAgents(nested);
  expect(agents.map((agent) => agent.name)).toEqual(["general", "explorer", "reviewer"]);
  expect(agents.find((agent) => agent.name === "explorer")).toMatchObject({ source: "project", prompt: "Project prompt" });
  expect(agents.find((agent) => agent.name === "explorer")?.model).toBeUndefined();
});
