# Force Run to Cursor (VS Code Extension) — Quickstart

This extension adds a debug command **Debug: Force Run to Cursor** that behaves like PyCharm’s “Force Run to Cursor”: it temporarily disables breakpoints, runs to the caret line, then restores breakpoints when the debugger stops.

## What's in the folder

- `package.json` — extension manifest
  - Declares the command: `extension.forceRunToCursor`
  - Contributes metadata (name/displayName, activationEvents, etc.)
- `src/extension.ts` — extension entry point
  - `activate()` registers:
    - Debug adapter tracking to detect stop/terminate/exited events
    - The command `extension.forceRunToCursor`
  - Includes small exported helpers to enable unit testing:
    - `forceRunToCursorImpl(...)`
    - `maybeRestoreOnAdapterEvent(...)`
- `src/test/suite/extension.test.ts` — unit tests for the core command logic
- `README.md` — user-facing docs (features, usage, keybindings, known limitations)
- `LICENSE` — license file (required for clean packaging/publishing)

## Get up and running (local development)

1. Open this folder in VS Code.
2. Press `F5` (or **Run → Start Debugging**) to launch an **Extension Development Host** window.
3. In the Extension Development Host window:
   - Open any project (or create a small test file).
   - Start debugging (e.g., Python, Node, etc.) and **pause** at a breakpoint.
   - Move the caret to the line you want to stop at.
   - Run the command via Command Palette (`⇧⌘P`):
     - **Debug: Force Run to Cursor**

### Notes

- The command requires an active debug session, and works best when you are already paused.
- VS Code already has a built-in **Run to Cursor** action; this extension adds the “force/ignore breakpoints” behavior.

## Recommended keybindings (PyCharm-style on macOS)

Add these to **Preferences: Open Keyboard Shortcuts (JSON)**:

```json
[
  {
    "key": "alt+f9",
    "command": "editor.debug.action.runToCursor",
    "when": "inDebugMode && editorTextFocus"
  },
  {
    "key": "alt+cmd+f9",
    "command": "extension.forceRunToCursor",
    "when": "inDebugMode && editorTextFocus"
  }
]
```

## Make changes

After editing `src/extension.ts`:

- Rebuild: `npm run compile` (or run watch mode: `npm run watch`)
- In the Extension Development Host window, run **Developer: Reload Window** to pick up changes.

## Run tests

### Option A — Terminal (simplest)

From the repo root:

```bash
npm install
npm run compile
npm test
```

### Option B — VS Code “Extension Tests” debug config

1. Open the **Run and Debug** view.
2. Select **Extension Tests**.
3. Press `F5`.

### About “VS Code Extension Test Runner”

If you installed **VS Code Extension Test Runner**, it’s optional.
You can keep using `npm test` / the **Extension Tests** launch config without it.

## Package locally (VSIX)

To create a `.vsix` without publishing:

```bash
npm run compile
vsce package
```

Then install it via:

**Extensions** view → **...** menu → **Install from VSIX...**

## Go further

- [VS Code Extension API docs](https://code.visualstudio.com/api)
- [Debugging docs](https://code.visualstudio.com/docs/editor/debugging)
- [Publishing docs](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)

### Quick self-check (step by step)

1. `F5` opens **Extension Development Host**
2. You can run **Debug: Force Run to Cursor** from the Command Palette while paused
3. `npm test` runs the unit tests in `src/test/suite/extension.test.ts`
