import { expect, test } from "vitest";
import { truncateOutput } from "../src/index.ts";

test("truncateOutput keeps the start and points at the full output", () => {
  expect(truncateOutput("short", "/f")).toBe("short");
  const long = Array.from({ length: 2_500 }, (_, i) => `line ${i}`).join("\n");
  const out = truncateOutput(long, "/full.md");
  expect(out.split("\n").length).toBeLessThan(2_010);
  expect(out).toMatch(/Full output: \/full\.md\]$/u);
});
