# Force Run to Cursor

A tiny VS Code extension that adds **Debug: Force Run to Cursor** — run until the caret line is reached while **skipping breakpoints in between** (similar to PyCharm’s “Force Run to Cursor”).

## Features

- **Debug: Force Run to Cursor**
  - Temporarily disables all breakpoints
  - Executes VS Code’s built-in **Run to Cursor**
  - Re-enables breakpoints when the debugger stops/terminates

## Requirements

- A running debug session (works with any debug adapter that supports VS Code’s **Run to Cursor**).

## Usage

1. Start debugging and **pause** (hit any breakpoint).
2. Put the caret on the line where you want execution to stop.
3. Run **Command Palette** → `Debug: Force Run to Cursor`.

### Optional: Keybinding

Add a shortcut in `keybindings.json`:

```json
{
  "key": "cmd+alt+f10",
  "command": "extension.forceRunToCursor",
  "when": "inDebugMode && editorTextFocus"
}
```

## Extension Settings

This extension does not contribute any settings.

## Known Issues/Limitations

- Previously-disabled breakpoints may become enabled after the command completes.
- Does not suppress exception breaks or explicit pause triggers (breakpoint(), etc.).
- Execution may stop before the cursor line for other reasons; if it does, breakpoints are restored at that stop.

## Release Notes

### 1.0.0

Initial release.

---

## Following extension guidelines

Ensure that you've read through the extensions guidelines and follow the best practices for creating your extension.

- [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## Working with Markdown

You can author your README using Visual Studio Code. Here are some useful editor keyboard shortcuts:

- Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux).
- Toggle preview (`Shift+Cmd+V` on macOS or `Shift+Ctrl+V` on Windows and Linux).
- Press `Ctrl+Space` (Windows, Linux, macOS) to see a list of Markdown snippets.

## For more information

- [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
- [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy!**
