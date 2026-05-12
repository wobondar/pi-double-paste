# pi-double-paste

A [pi](https://pi.dev) extension that keeps pi's existing long-paste placeholder behavior, but lets you expand a placeholder into editable text by pasting the same content again.

## Usage

1. Install extension from npm:

```bash
pi install npm:pi-double-paste
```

2. Paste long text into the `pi` input editor. `pi` collapses it to a placeholder as usual. Paste the same long text again while the cursor is at/inside that placeholder, and a placeholder will be replaced with the full text available for editing before submission.

## Why

Pi collapses long pastes in the input editor to markers such as:

```text
[paste #1 +123 lines]
[paste #2 1234 chars]
```

That is great for keeping the editor readable, but sometimes you want to edit the pasted text before sending it to the LLM. This extension makes that possible without changing short-paste behavior.

## Behavior

### Long paste

1. Paste long text once.
2. Pi shows the usual placeholder, for example `[paste #1 +123 lines]` or `[paste #2 1234 chars]`.
3. Paste the same text again while the cursor is at/inside that placeholder.
4. The placeholder is replaced with the full pasted text in the editor buffer.
5. Edit the pasted text normally before submitting.

### Short paste

Short pastes are unchanged from stock pi:

- short text is inserted directly
- no `[paste ...]` placeholder is created
- the inserted text is immediately editable

### Multiple copies of the same long text

If the cursor has moved away from an existing placeholder, pasting the same long text creates a new placeholder instead of expanding the old one.

This supports workflows like:

```text
[paste #1 +123 lines]

compare with:

[paste #2 +123 lines]
```

Then paste the same long text again while the cursor is at the second placeholder to expand only the second copy:

```text
[paste #1 +123 lines]

compare with:

EXPANDED_LONG_TEXT     <- [paste #2 +123 lines] is replaced with the full text here
```

When submitted, any remaining pi paste placeholders are still expanded by pi as usual.

## Install / try

```bash
pi install npm:pi-double-paste
```

Try it temporarily without installing:

```bash
pi -e npm:pi-double-paste
```

From this repository:

```bash
pi -e ./index.ts
```

Install the package locally:

```bash
pi install /absolute/path/to/pi-double-paste
```

### Requirements

- pi 0.71.0 or newer.

## Development

```bash
npm install
npm test
npm run test:pi
npm run fmt
npm run lint
```

## Notes

- When no custom editor is configured, this extension replaces pi's default interactive editor with a `CustomEditor` subclass.
- If another extension already configured a custom editor, this extension replaces the active editor component and wraps the previous editor via `ctx.ui.getEditorComponent()`.
- It preserves pi's built-in editor keybindings and delegates normal input handling to the base editor.
- Pi currently treats long paste as more than 10 lines or more than 1000 characters; this extension mirrors those thresholds.
