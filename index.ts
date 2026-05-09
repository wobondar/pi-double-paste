import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const LONG_PASTE_MIN_LINES = 10;
const LONG_PASTE_MIN_CHARS = 1000;

type PasteRecord = {
  id: number;
  marker: string;
  content: string;
};

type PrivateEditorAccess = {
  state?: {
    lines: string[];
    cursorLine: number;
    cursorCol: number;
  };
  pastes?: Map<number, string>;
  pasteCounter?: number;
  historyIndex?: number;
  lastAction?: unknown;
  scrollOffset?: number;
  preferredVisualCol?: number | null;
  snappedFromCursorCol?: number | null;
  cancelAutocomplete?: () => void;
  pushUndoSnapshot?: () => void;
  insertTextAtCursorInternal?: (text: string) => void;
};

function decodePasteControlBytes(text: string): string {
  // Same workaround as pi's built-in editor: some terminals/tmux setups encode
  // Ctrl+<letter> bytes inside bracketed paste as CSI-u sequences.
  // oxlint-disable-next-line no-control-regex
  return text.replace(/\x1b\[(\d+);5u/g, (match, code) => {
    const cp = Number(code);
    if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
    if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
    return match;
  });
}

function normalizePasteText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
}

function filterPasteText(text: string): string {
  return normalizePasteText(decodePasteControlBytes(text))
    .split("")
    .filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
    .join("");
}

function isLongPaste(text: string): boolean {
  return text.split("\n").length > LONG_PASTE_MIN_LINES || text.length > LONG_PASTE_MIN_CHARS;
}

function markerFor(id: number, content: string): string {
  const lineCount = content.split("\n").length;
  return lineCount > LONG_PASTE_MIN_LINES
    ? `[paste #${id} +${lineCount} lines]`
    : `[paste #${id} ${content.length} chars]`;
}

function offsetToCursor(text: string, offset: number): { line: number; col: number } {
  let line = 0;
  let lineStart = 0;
  const clamped = Math.max(0, Math.min(offset, text.length));

  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }

  return { line, col: clamped - lineStart };
}

export class DoublePasteEditor extends CustomEditor {
  private isCollectingPaste = false;
  private pasteTextBuffer = "";
  private records: PasteRecord[] = [];

  handleInput(data: string): void {
    if (this.isCollectingPaste || data.includes(PASTE_START)) {
      this.handleBracketedPasteInput(data);
      return;
    }

    super.handleInput(data);
  }

  private handleBracketedPasteInput(data: string): void {
    let chunk = data;

    if (!this.isCollectingPaste) {
      const startIndex = chunk.indexOf(PASTE_START);
      if (startIndex === -1) {
        super.handleInput(chunk);
        return;
      }

      const beforePaste = chunk.slice(0, startIndex);
      if (beforePaste.length > 0) {
        super.handleInput(beforePaste);
      }

      chunk = chunk.slice(startIndex + PASTE_START.length);
      this.isCollectingPaste = true;
      this.pasteTextBuffer = "";
    }

    this.pasteTextBuffer += chunk;
    const endIndex = this.pasteTextBuffer.indexOf(PASTE_END);
    if (endIndex === -1) return;

    const pastedText = this.pasteTextBuffer.slice(0, endIndex);
    const remaining = this.pasteTextBuffer.slice(endIndex + PASTE_END.length);
    this.isCollectingPaste = false;
    this.pasteTextBuffer = "";

    this.handleCompletedPaste(pastedText);

    if (remaining.length > 0) {
      this.handleInput(remaining);
    }
  }

  private handleCompletedPaste(rawPastedText: string): void {
    const filteredText = this.applyPiPasteCleaning(rawPastedText);

    // Preserve pi's stock behavior for short paste input.
    if (!isLongPaste(filteredText)) {
      super.handleInput(`${PASTE_START}${rawPastedText}${PASTE_END}`);
      return;
    }

    const existing = this.findExpandableRecord(filteredText);
    if (existing) {
      this.expandMarker(existing);
      return;
    }

    this.insertLongPasteMarker(filteredText);
  }

  private applyPiPasteCleaning(rawPastedText: string): string {
    let filteredText = filterPasteText(rawPastedText);

    // Match pi's convenience behavior for pasted paths.
    if (/^[/~.]/.test(filteredText)) {
      const priv = this as unknown as PrivateEditorAccess;
      const state = priv.state;
      const currentLine = state?.lines[state.cursorLine] ?? "";
      const cursorCol = state?.cursorCol ?? 0;
      const charBeforeCursor = cursorCol > 0 ? currentLine[cursorCol - 1] : "";
      if (charBeforeCursor && /\w/.test(charBeforeCursor)) {
        filteredText = ` ${filteredText}`;
      }
    }

    return filteredText;
  }

  private insertLongPasteMarker(content: string): void {
    const priv = this as unknown as PrivateEditorAccess;

    // If pi internals change, fall back to the stock long-paste behavior instead
    // of risking a broken editor.
    if (!(priv.pastes instanceof Map)) {
      super.handleInput(`${PASTE_START}${content}${PASTE_END}`);
      return;
    }

    this.beginAtomicEdit();

    const id = (typeof priv.pasteCounter === "number" ? priv.pasteCounter : 0) + 1;
    priv.pasteCounter = id;
    priv.pastes.set(id, content);

    const marker = markerFor(id, content);
    if (typeof priv.insertTextAtCursorInternal === "function") {
      priv.insertTextAtCursorInternal(marker);
    } else {
      this.insertTextAtCursor(marker);
    }

    this.records.push({ id, marker, content });
  }

  private findExpandableRecord(content: string): PasteRecord | undefined {
    const text = this.getText();
    const cursorOffset = this.getAbsoluteCursorOffset();

    for (const record of this.records) {
      if (!this.samePastedContent(record.content, content)) continue;

      let searchFrom = 0;
      while (true) {
        const markerOffset = text.indexOf(record.marker, searchFrom);
        if (markerOffset === -1) break;

        const markerEnd = markerOffset + record.marker.length;
        if (cursorOffset >= markerOffset && cursorOffset <= markerEnd) {
          return record;
        }

        searchFrom = markerEnd;
      }
    }
  }

  private samePastedContent(storedContent: string, currentContent: string): boolean {
    // Pi prepends a readability space when pasted path-like text follows a word
    // character. On the second paste the cursor is usually after the marker (`]`),
    // so the same raw paste may not receive that synthetic leading space. Treat
    // those two cleaned forms as equivalent and expand the original stored text.
    return (
      storedContent === currentContent ||
      (storedContent.startsWith(" ") && storedContent.slice(1) === currentContent)
    );
  }

  private expandMarker(record: PasteRecord): void {
    const text = this.getText();
    const markerOffset = this.findBestMarkerOffset(text, record.marker);
    if (markerOffset === -1) {
      this.insertLongPasteMarker(record.content);
      return;
    }

    this.beginAtomicEdit();

    const nextText =
      text.slice(0, markerOffset) +
      record.content +
      text.slice(markerOffset + record.marker.length);
    const nextCursorOffset = markerOffset + record.content.length;
    this.setTextAndCursor(nextText, nextCursorOffset);

    // Keep the paste record and pi's internal paste map entry around. That makes
    // undo work naturally: if the user undoes the expansion back to the marker,
    // submitting or pasting the same content again still understands it.
  }

  private findBestMarkerOffset(text: string, marker: string): number {
    const cursorOffset = this.getAbsoluteCursorOffset();
    let bestOffset = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    let searchFrom = 0;

    while (true) {
      const markerOffset = text.indexOf(marker, searchFrom);
      if (markerOffset === -1) return bestOffset;

      const markerEnd = markerOffset + marker.length;
      const score =
        cursorOffset >= markerOffset && cursorOffset <= markerEnd
          ? 0
          : Math.abs(markerEnd - cursorOffset);
      if (score < bestScore) {
        bestOffset = markerOffset;
        bestScore = score;
      }

      searchFrom = markerEnd;
    }
  }

  private getAbsoluteCursorOffset(): number {
    const priv = this as unknown as PrivateEditorAccess;
    const state = priv.state;
    if (!state) return this.getText().length;

    let offset = 0;
    for (let line = 0; line < state.cursorLine; line++) {
      offset += (state.lines[line] ?? "").length + 1;
    }
    return offset + state.cursorCol;
  }

  private beginAtomicEdit(): void {
    const priv = this as unknown as PrivateEditorAccess;
    priv.cancelAutocomplete?.();
    priv.historyIndex = -1;
    priv.lastAction = null;
    priv.pushUndoSnapshot?.();
  }

  private setTextAndCursor(text: string, cursorOffset: number): void {
    const priv = this as unknown as PrivateEditorAccess;
    const state = priv.state;

    if (!state) {
      this.setText(text);
      return;
    }

    const lines = text.split("\n");
    state.lines = lines.length === 0 ? [""] : lines;

    const cursor = offsetToCursor(text, cursorOffset);
    state.cursorLine = Math.min(cursor.line, state.lines.length - 1);
    state.cursorCol = Math.min(cursor.col, state.lines[state.cursorLine]?.length ?? 0);

    priv.scrollOffset = 0;
    priv.preferredVisualCol = null;
    priv.snappedFromCursorCol = null;

    this.onChange?.(this.getText());
    this.tui.requestRender();
  }
}

export default function piDoublePaste(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) => new DoublePasteEditor(tui, theme, keybindings),
    );
    ctx.ui.notify(
      "pi-double-paste loaded: paste the same long text twice to expand it in the editor.",
      "info",
    );
  });
}
