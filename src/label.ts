// Stable task names, independent of the agent role and any model calls.
import { stripVTControlCharacters } from "node:util";

function plain(text: string): string {
  return stripVTControlCharacters(text).replace(/\s+/gu, " ").replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").trim();
}

/** Normalize a supplied label, or derive one from the task's first nonempty line. */
export function taskLabel(task: string, label?: string): string {
  let text = label ? plain(label) : "";
  if (!text) {
    const first = task.replaceAll("{previous}", "").split(/\r?\n/u).map(plain).find(Boolean) ?? "";
    text = first.replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/u, "").trim();
  }
  return text || "Task";
}

/** Records from before labels existed get the same deterministic fallback. */
export function runLabel(run: { task: string; label?: string }): string {
  return taskLabel(run.task, run.label);
}
