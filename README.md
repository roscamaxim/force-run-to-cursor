# Force Run to Cursor

A tiny VS Code extension that adds **Debug: Force Run to Cursor** — run until the caret line is reached while **skipping breakpoints in between** (similar to JetBrains's "Force Run to Cursor").

![Force Run to Cursor demo](media/demo.gif)

## Features

- **Debug: Force Run to Cursor** — temporarily removes all breakpoints, runs to cursor, then restores breakpoints when the debugger stops or the session terminates.
- **Debug: Run to Cursor** — a thin wrapper around VS Code's built-in Run to Cursor, exposed so it can appear in the debug toolbar with a custom icon.
- **Debug toolbar buttons** — both commands appear as icon buttons in the debug toolbar during active debug sessions.
- **Right-click context menu** — "Force Run to Cursor" is available in the editor context menu while debugging.
- **Cancellation support** — while the debugger is running toward the cursor (e.g. during a long-running operation), a "Force Run Active" status bar item appears. Click it or use the Command Palette to cancel and restore breakpoints immediately.
- **All breakpoint types** — correctly saves and restores source breakpoints, function breakpoints, inline breakpoints, and data breakpoints.
- **PyCharm-inspired icons** — uses the same color scheme as JetBrains IDEs (blue for Run to Cursor, red for Force Run to Cursor) for cross-IDE familiarity.

## Requirements

- A running debug session (works with any debug adapter that supports VS Code's **Run to Cursor**).

## Usage

1. Start debugging and **pause** (hit any breakpoint).
2. Put the caret on the line where you want execution to stop.
3. Use any of:
   - Click the **toolbar button** in the debug toolbar
   - **Right-click** in the editor and select **Force Run to Cursor**
   - **Command Palette** → `Debug: Force Run to Cursor`

To cancel a force-run in progress and restore breakpoints immediately:
   - Click the **Force Run Active** status bar item
   - **Command Palette** → `Debug: Cancel Force Run (Restore Breakpoints)`

### Optional: Keybinding

Add a shortcut in `keybindings.json`:

```json
{
  "key": "cmd+alt+f9",
  "command": "runToCursor.force",
  "when": "inDebugMode && editorTextFocus"
}
```

## Extension Settings

This extension does not contribute any settings.

## Known Issues/Limitations

- Does not suppress exception breaks or explicit pause triggers (breakpoint(), etc.).
- Execution may stop before the cursor line for other reasons; if it does, breakpoints are restored at that stop.
- Toolbar buttons appear before the built-in debug buttons (VS Code does not allow intermixing extension buttons with built-in ones).

## Release Notes

### 0.2.0

- Add status bar indicator with cancellation support during active force-runs
- Add `Debug: Cancel Force Run (Restore Breakpoints)` command
- Switch to esbuild bundler for smaller and faster builds
- Improve breakpoint type handling with explicit support for all subtypes

### 0.1.3

- Improve extension description

### 0.1.0

- Add "Run to Cursor" and "Force Run to Cursor" buttons to the debug toolbar
- Add "Force Run to Cursor" to the editor right-click context menu
- Add PyCharm-inspired icons with light/dark theme support

### 0.0.1

Initial release with `Debug: Force Run to Cursor` command.
