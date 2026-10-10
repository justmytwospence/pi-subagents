import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { ACTIVITY_SECTION, type ActivitySection } from "../src/activity.ts";
import { setPiInvocation } from "../src/child.ts";
import subagents, { recordedRun } from "../src/index.ts";
import { runLabel, taskLabel } from "../src/label.ts";
import { fleetRoster, renderFleet } from "../src/ui/fleet.ts";
import { ConversationViewer } from "../src/ui/viewer.ts";
import { renderSection, renderWidget } from "../src/ui/widget.ts";
import { harness } from "./harness.ts";
import { fakeRun, fakeTui, fakeUI, plain } from "./ui-helpers.ts";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "subagents-labels-"));

test("labels are plain, compact and deterministic, with a task fallback for blanks and old runs", () => {
  expect(taskLabel("Do something", "  Audit\tcache\n invalidation  ")).toBe("Audit cache invalidation");
  expect(taskLabel("\n\n## Find config\nFull instructions", " \n ")).toBe("Find config");
  expect(taskLabel("- Review the diff\nMore details")).toBe("Review the diff");
  expect(taskLabel("{previous}\nSummarize findings")).toBe("Summarize findings");
  expect(taskLabel("", "\x1b[31m\x07\x1b[0m")).toBe("Task");
  expect(taskLabel("unused", "\x1b[31mAudit\x1b[0m\x07 cache")).toBe("Audit cache");
  expect(runLabel({ task: "Legacy task\nDetails" })).toBe("Legacy task");
  const wide = taskLabel("界".repeat(100));
  expect(wide).toBe("界".repeat(100));
  expect(wide).not.toContain("\x1b");
  expect(taskLabel("界".repeat(100))).toBe(wide);
});

test("same-role runs show distinct primary labels, with width-safe FleetView, widget and viewer rows", () => {
  const runs = [fakeRun({ agent: "reviewer", label: "Audit cache", task: "Full cache instructions" }), fakeRun({ agent: "reviewer", label: "Audit auth", task: "Full auth instructions" })];
  for (const width of [24, 80, 160]) {
    const fleet = renderFleet({ roster: fleetRoster(runs, 1_000), selected: 1, active: true, now: 1_000, width, theme: plain });
    if (width >= 80) {
      expect(fleet[2]).toContain("Audit cache");
      expect(fleet[3]).toContain("Audit auth");
    }
    expect(fleet.every((line) => visibleWidth(line) <= width)).toBe(true);
    const widget = renderWidget({ runs, queued: 0, now: 1_000, frame: 0, width, theme: plain });
    expect(widget.join("\n")).toContain("Audit cache");
    expect(widget.join("\n")).toContain("Audit auth");
    expect(widget.every((line) => visibleWidth(line) <= width)).toBe(true);
    const viewer = new ConversationViewer(fakeTui(), runs[0]!, plain, () => undefined);
    const lines = viewer.render(width);
    expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
    if (width >= 80) {
      expect(fleet[2]).toContain("Audit cache  reviewer");
      expect(widget[1]).toContain("Audit cache  reviewer");
      expect(lines[0]).toContain("Audit cache · reviewer · not your main session");
      expect(lines[1]).toContain("Audit cache  reviewer");
    }
    viewer.dispose();
  }
});

test("long descriptions use the available width and wrap intact instead of being clipped for metadata", () => {
  const label = "Investigate authentication failures after session renewal and identify the precise source of stale cached credentials";
  const run = fakeRun({ label, agent: "general" });
  expect(taskLabel("unused", label)).toBe(label);
  for (const width of [24, 50, 200]) {
    const fleet = renderFleet({ roster: fleetRoster([run], 1_000), selected: 1, active: true, now: 1_000, width, theme: plain });
    expect(fleet.join("\n").replace(/\s+/gu, " ")).toContain(label);
    expect(fleet.every((line) => visibleWidth(line) <= width)).toBe(true);
    const widget = renderSection({ runs: [run], queued: 0, now: 1_000, frame: 0, width, theme: plain, maxLines: 3 });
    expect(widget.lines.join("\n").replace(/\s+/gu, " ")).toContain(label);
    expect(widget.lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(widget.lines.join("\n")).not.toContain("+0 more");
    expect(widget.targets.slice(1).every((target) => target === run.id)).toBe(true);
    if (width === 200) expect(fleet[2]).toContain(label);
  }
  const wide = fakeRun({ label: "界".repeat(90) });
  const fleet = renderFleet({ roster: fleetRoster([wide], 0), selected: 1, active: true, now: 0, width: 50, theme: plain });
  expect(fleet.join("").match(/界/gu)).toHaveLength(90);
  expect(fleet.every((line) => visibleWidth(line) <= 50)).toBe(true);
});

test("single, parallel and chain labels survive records and appear before roles everywhere", async () => {
  setPiInvocation({ command: process.execPath, args: [path.join(import.meta.dirname, "fixtures", "fake-pi.mjs")] });
  const h = harness();
  let tool: any;
  let source: ActivitySection | undefined;
  h.pi.registerTool = (t: unknown) => void (tool = t);
  h.pi.events.emit = (channel: string, data: any) => {
    if (channel === ACTIVITY_SECTION) source = data.section;
  };
  subagents(h.pi);
  const ui = fakeUI();
  let modelCalls = 0;
  const ctx = h.ctx({
    ui,
    cwd: mkdtempSync(path.join(tmpdir(), "subagents-labels-cwd-")),
    model: { provider: "p", id: "m" },
    modelRegistry: { classify: () => { modelCalls++; throw new Error("Labels must not call a model"); } },
  });
  const explicit = { agent: "general", model: "p/m", thinking: "low" };
  await h.emit("session_start", { type: "session_start" }, ctx);
  try {
    expect(tool.parameters.properties.label.type).toBe("string");
    expect(tool.parameters.properties.tasks.items.properties.label.type).toBe("string");
    expect(tool.parameters.properties.chain.items.properties.label.type).toBe("string");
    const task = `Find config\n${"Full instructions. ".repeat(50)}`;
    const single = await tool.execute("single", { ...explicit, task, label: "  Config\n audit " }, undefined, undefined, ctx);
    expect(single.details.runs[0]).toMatchObject({ label: "Config audit", task, agent: "general" });
    expect(single.content[0].text).toMatch(/^\[Config audit · general ·/u);
    expect(single.content[0].text).toContain(`task=${task}`);
    expect(ui.selects[0]?.title).toBe("[subagent Config audit · general] Allow?");
    expect(source?.entries(Date.now())[0]).toMatchObject({ label: "Config audit", detail: "general" });
    const record = h.entries.at(-1)?.data as any;
    expect(record).toMatchObject({ task, label: "Config audit" });
    expect(recordedRun(record)).toMatchObject({ task, label: "Config audit" });
    expect(tool.renderCall({ task, label: "Config audit", agent: "general" }, plain).render(160).join("\n")).toContain("Config audit · general");
    expect(tool.renderResult(single, { expanded: false }, plain).render(200).join("\n")).toContain("Config audit · general");
    const result = await tool.execute("result", { action: "result", id: record.id }, undefined, undefined, ctx);
    expect(result.content[0].text).toMatch(/^\[Config audit · general · done\]/u);

    const tasks = [{ ...explicit, task: "First task", label: "First label" }, { ...explicit, task: "Second task\nDetails" }];
    const parallel = await tool.execute("parallel", { tasks }, undefined, undefined, ctx);
    expect(parallel.details.runs.map((r: any) => r.label)).toEqual(["First label", "Second task"]);
    expect(tasks[1]).not.toHaveProperty("label");
    expect(parallel.content[0].text).toContain("[First label · general ·");
    expect(parallel.content[0].text).toContain("[Second task · general ·");

    const chain = await tool.execute("chain", { chain: [{ ...explicit, task: "Collect facts", label: "Gather" }, { ...explicit, task: "{previous}\nSummarize findings" }] }, undefined, undefined, ctx);
    expect(chain.details.runs.map((r: any) => r.label)).toEqual(["Gather", "Summarize findings"]);
    expect(chain.details.runs[1].task).toContain("task=Collect facts");
    expect(chain.details.runs[1].task).not.toContain("{previous}");
    expect(chain.content[0].text).toMatch(/^\[Summarize findings · general ·/u);
    const status = await tool.execute("status", { action: "status" }, undefined, undefined, ctx);
    expect(status.content[0].text).toContain("Config audit · general");
    expect(modelCalls).toBe(0);
  } finally {
    await h.emit("session_shutdown", { type: "session_shutdown" }, ctx);
    setPiInvocation(undefined);
  }
});
