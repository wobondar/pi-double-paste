import { describe, expect, it, vi } from "vitest";
import piDoublePaste, { DoublePasteEditor } from "../src/index";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

function createEditor(): DoublePasteEditor {
  const tui = {
    terminal: { rows: 40, columns: 120 },
    requestRender: vi.fn<() => void>(),
  };

  const theme = {
    borderColor: (str: string) => str,
    selectList: {},
  };

  const keybindings = {
    matches: vi.fn<(data: string, action: string) => boolean>(() => false),
    getKeys: vi.fn<(action: string) => string[]>(() => []),
  };

  return new DoublePasteEditor(tui as any, theme as any, keybindings as any);
}

function paste(editor: DoublePasteEditor, text: string): void {
  editor.handleInput(`${PASTE_START}${text}${PASTE_END}`);
}

function longLines(count = 12): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
}

describe("pi-double-paste extension registration", () => {
  it("installs a custom editor on session_start when UI is available", () => {
    const handlers = new Map<string, Function>();
    const pi = {
      on: vi.fn<(event: string, handler: Function) => void>((event, handler) => {
        handlers.set(event, handler);
      }),
    };
    const setEditorComponent = vi.fn<(component: Function) => void>();
    const notify = vi.fn<(message: string, level: string) => void>();

    piDoublePaste(pi as any);
    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));

    handlers.get("session_start")?.({}, { hasUI: true, ui: { setEditorComponent, notify } });

    expect(setEditorComponent).toHaveBeenCalledWith(expect.any(Function));
    expect(notify).toHaveBeenCalledWith(
      "pi-double-paste loaded: paste the same long text twice to expand it in the editor.",
      "info",
    );
  });

  it("does not install a custom editor without UI", () => {
    const handlers = new Map<string, Function>();
    const pi = {
      on: vi.fn<(event: string, handler: Function) => void>((event, handler) => {
        handlers.set(event, handler);
      }),
    };
    const setEditorComponent = vi.fn<(component: Function) => void>();
    const notify = vi.fn<(message: string, level: string) => void>();

    piDoublePaste(pi as any);
    handlers.get("session_start")?.({}, { hasUI: false, ui: { setEditorComponent, notify } });

    expect(setEditorComponent).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("DoublePasteEditor", () => {
  it("preserves stock behavior for short pastes", () => {
    const editor = createEditor();

    paste(editor, "hello world");

    expect(editor.getText()).toBe("hello world");
    expect(editor.getExpandedText()).toBe("hello world");
  });

  it("collapses a long multiline paste to pi's normal marker on first paste", () => {
    const editor = createEditor();
    const content = longLines(12);

    paste(editor, content);

    expect(editor.getText()).toBe("[paste #1 +12 lines]");
    expect(editor.getExpandedText()).toBe(content);
  });

  it("collapses a long single-line paste to pi's normal char-count marker on first paste", () => {
    const editor = createEditor();
    const content = "x".repeat(1001);

    paste(editor, content);

    expect(editor.getText()).toBe("[paste #1 1001 chars]");
    expect(editor.getExpandedText()).toBe(content);
  });

  it("expands the marker when the same long content is pasted a second time", () => {
    const editor = createEditor();
    const content = longLines(12);

    paste(editor, content);
    paste(editor, content);

    expect(editor.getText()).toBe(content);
    expect(editor.getExpandedText()).toBe(content);
  });

  it("keeps expanded long paste editable", () => {
    const editor = createEditor();
    const content = longLines(12);

    paste(editor, content);
    paste(editor, content);
    editor.handleInput("!");

    expect(editor.getText()).toBe(`${content}!`);
  });

  it("does not expand when a different long text is pasted", () => {
    const editor = createEditor();
    const first = longLines(12);
    const second = Array.from({ length: 12 }, (_, index) => `different ${index + 1}`).join("\n");

    paste(editor, first);
    paste(editor, second);

    expect(editor.getText()).toBe("[paste #1 +12 lines][paste #2 +12 lines]");
    expect(editor.getExpandedText()).toBe(`${first}${second}`);
  });

  it("preserves surrounding short text when expanding a long-paste marker at the cursor", () => {
    const editor = createEditor();
    const content = longLines(12);

    editor.handleInput("prefix ");
    paste(editor, content);
    paste(editor, content);
    editor.handleInput(" suffix");

    expect(editor.getText()).toBe(`prefix ${content} suffix`);
  });

  it("handles bracketed paste split across multiple input chunks", () => {
    const editor = createEditor();
    const content = longLines(12);
    const firstChunk = content.slice(0, 15);
    const secondChunk = content.slice(15);

    editor.handleInput(`${PASTE_START}${firstChunk}`);
    expect(editor.getText()).toBe("");

    editor.handleInput(`${secondChunk}${PASTE_END}`);
    expect(editor.getText()).toBe("[paste #1 +12 lines]");
  });

  it("normalizes, filters, and expands the same cleaned long content", () => {
    const editor = createEditor();
    const raw =
      Array.from({ length: 12 }, (_, index) => `line\t${index + 1}\r`).join("\n") + "\u0000";
    const cleaned = `${Array.from({ length: 12 }, (_, index) => `line    ${index + 1}`).join("\n")}\n`;

    paste(editor, raw);
    paste(editor, raw);

    expect(editor.getText()).toBe(cleaned);
  });

  it("submits the expanded content when the user only pasted once and left the marker", () => {
    const editor = createEditor();
    const onSubmit = vi.fn<(text: string) => void>();
    const content = longLines(12);
    editor.onSubmit = onSubmit;

    paste(editor, content);
    (editor as any).submitValue();

    expect(onSubmit).toHaveBeenCalledWith(content);
    expect(editor.getText()).toBe("");
  });

  it("submits the editable full content after a second paste expanded the marker", () => {
    const editor = createEditor();
    const onSubmit = vi.fn<(text: string) => void>();
    const content = longLines(12);
    editor.onSubmit = onSubmit;

    paste(editor, content);
    paste(editor, content);
    editor.handleInput(" edited");
    (editor as any).submitValue();

    expect(onSubmit).toHaveBeenCalledWith(`${content} edited`);
    expect(editor.getText()).toBe("");
  });

  it("undo after expansion restores a working marker that can be expanded again", () => {
    const editor = createEditor();
    const content = longLines(12);

    paste(editor, content);
    paste(editor, content);
    expect(editor.getText()).toBe(content);

    (editor as any).undo();
    expect(editor.getText()).toBe("[paste #1 +12 lines]");
    expect(editor.getExpandedText()).toBe(content);

    paste(editor, content);
    expect(editor.getText()).toBe(content);
  });

  it("handles multiple bracketed paste sequences delivered in one terminal input chunk", () => {
    const editor = createEditor();
    const content = longLines(12);

    editor.handleInput(
      `prefix ${PASTE_START}${content}${PASTE_END}${PASTE_START}${content}${PASTE_END}`,
    );

    expect(editor.getText()).toBe(`prefix ${content}`);
  });

  it("does not expand an earlier same-content marker after the cursor has moved on to new user text", () => {
    const editor = createEditor();
    const content = longLines(12);

    paste(editor, content);
    editor.handleInput("\n");
    editor.handleInput("\n");
    editor.handleInput("compare with:");
    editor.handleInput("\n");
    editor.handleInput("\n");
    paste(editor, content);
    expect(editor.getText()).toBe(`[paste #1 +12 lines]\n\ncompare with:\n\n[paste #2 +12 lines]`);

    paste(editor, content);
    editor.handleInput(" edited");

    expect(editor.getText()).toBe(`[paste #1 +12 lines]\n\ncompare with:\n\n${content} edited`);
    expect(editor.getExpandedText()).toBe(`${content}\n\ncompare with:\n\n${content} edited`);
  });

  it("expands path-like long pastes after a word even though pi adds a synthetic readability space", () => {
    const editor = createEditor();
    const pathLikeLongText = `/${longLines(12)}`;

    editor.handleInput("see");
    paste(editor, pathLikeLongText);
    expect(editor.getText()).toBe("see[paste #1 +12 lines]");
    expect(editor.getExpandedText()).toBe(`see ${pathLikeLongText}`);

    paste(editor, pathLikeLongText);
    expect(editor.getText()).toBe(`see ${pathLikeLongText}`);
  });
});
