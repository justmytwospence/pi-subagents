// Fakes for the UI tests: runs, a plain theme, a TUI and a ctx.ui.
import { type ChildState, emptyUsage } from "../src/child.ts";
import { Conversation } from "../src/conversation.ts";
import type { Run } from "../src/run.ts";

export const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

let next = 0;

export function fakeRun(over: { state?: Partial<ChildState> } & Partial<Omit<Run, "state">> = {}): Run {
  const { state, ...rest } = over;
  return {
    id: `r${++next}`,
    agent: "scout",
    task: "Find where the config is loaded",
    model: "anthropic/claude-haiku-5",
    thinking: "low",
    byJev: { agent: false, model: false, thinking: false },
    cwd: "/tmp",
    async: true,
    conversation: new Conversation(),
    outputPath: "/tmp/none/output.md",
    ...rest,
    state: { status: "running", output: "", usage: emptyUsage(), turns: 0, startedAt: 0, ...state },
  };
}

export function fakeTui(rows = 40, columns = 100) {
  const tui = { renders: 0, focused: undefined as unknown, terminal: { rows, columns }, requestRender: () => void tui.renders++, getFocusedComponent: () => tui.focused };
  return tui;
}

export type Factory = (tui: any, theme: any) => any;
export type CustomFactory = (tui: any, theme: any, keybindings: any, done: (v: any) => void) => any;

export function fakeUI(tui = fakeTui()) {
  const widgets = new Map<string, { factory: Factory; component: any; placement?: string }>();
  const ui = {
    calls: [] as Array<[string, boolean]>,
    widgets,
    tui,
    editorText: "",
    notes: [] as string[],
    selects: [] as Array<{ title: string; options: string[] }>,
    selectAnswers: [] as Array<(options: string[]) => string | undefined>,
    inputHandlers: new Set<(data: string) => { consume?: boolean; data?: string } | undefined>(),
    customs: [] as Array<{ component: any; options: any; close: () => void }>,
    theme: plain,
    setWidget(key: string, content: Factory | undefined, options?: { placement?: string }) {
      ui.calls.push([key, Boolean(content)]);
      if (!content) widgets.delete(key);
      else widgets.set(key, { factory: content, component: content(tui, plain), ...(options?.placement ? { placement: options.placement } : {}) });
    },
    onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined) {
      ui.inputHandlers.add(handler);
      return () => ui.inputHandlers.delete(handler);
    },
    getEditorText: () => ui.editorText,
    select: async (title: string, options: string[]) => {
      ui.selects.push({ title, options });
      return ui.selectAnswers.shift()?.(options);
    },
    notify: (message: string) => void ui.notes.push(message),
    custom(factory: CustomFactory, options: any): Promise<any> {
      return new Promise((resolve) => {
        const close = (value?: unknown) => {
          ui.customs.splice(ui.customs.indexOf(entry), 1);
          entry.component.dispose?.();
          resolve(value);
        };
        const entry = { component: undefined as any, options, close };
        ui.customs.push(entry);
        entry.component = factory(tui, plain, undefined, close);
      });
    },
    /** Feed a key through the input listeners; true when one consumed it. */
    press(data: string): boolean {
      for (const handler of ui.inputHandlers) if (handler(data)?.consume) return true;
      return false;
    },
    render(key: string, width = 100): string[] {
      return widgets.get(key)?.component.render(width) ?? [];
    },
  };
  return ui;
}

export const KEY = { up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", enter: "\r", escape: "\x1b", backspace: "\x7f" };
