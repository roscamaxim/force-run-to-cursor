import * as vscode from 'vscode';

/** Maps session ID → breakpoints removed during a force-run, pending restoration. */
const pendingRestore = new Map<string, readonly vscode.Breakpoint[]>();

/** Type guard: checks if a breakpoint is a SourceBreakpoint (has a `location` property). */
export function isSourceBreakpoint(bp: vscode.Breakpoint): bp is vscode.SourceBreakpoint {
  return 'location' in bp;
}

/** Type guard: checks if a breakpoint is a FunctionBreakpoint (has a `functionName` property). */
export function isFunctionBreakpoint(bp: vscode.Breakpoint): bp is vscode.FunctionBreakpoint {
  return 'functionName' in bp;
}

/** Dependency injection for {@link forceRunToCursorImpl}. */
export type ForceDeps = {
  commands: { executeCommand: (cmd: string, ...args: any[]) => Thenable<any> };
  window: { showInformationMessage: (msg: string) => Thenable<any> | void };
  debug: {
    breakpoints: readonly vscode.Breakpoint[];
    removeBreakpoints: (bps: readonly vscode.Breakpoint[]) => void;
  };
};

/** Dependency injection for {@link maybeRestoreOnAdapterEvent}. */
export type RestoreDeps = {
  debug: {
    breakpoints: readonly vscode.Breakpoint[];
    addBreakpoints: (bps: readonly vscode.Breakpoint[]) => void;
    removeBreakpoints: (bps: readonly vscode.Breakpoint[]) => void;
  };
};

/**
 * Wipe any current breakpoints (orphaned temp BPs from `runToCursor`)
 * then re-add the saved set.
 *
 * Supports all breakpoint subtypes: SourceBreakpoint, FunctionBreakpoint,
 * InlineBreakpoint, and DataBreakpoint. Each is saved and restored as-is
 * since `addBreakpoints`/`removeBreakpoints` accept the base `Breakpoint` type.
 */
function restoreBreakpoints(
  debug: RestoreDeps['debug'],
  saved: readonly vscode.Breakpoint[],
): void {
  const leftover = debug.breakpoints;
  if (leftover.length > 0) {
    debug.removeBreakpoints(leftover);
  }
  debug.addBreakpoints(saved);
}

/**
 * Remove all breakpoints, then run to cursor.
 *
 * Breakpoints are removed (not disabled) so that "Run to Cursor" can set a
 * fresh temp breakpoint even on lines that already have one.
 */
export async function forceRunToCursorImpl(
  session: { id: string } | undefined,
  deps: ForceDeps = { commands: vscode.commands, window: vscode.window, debug: vscode.debug },
  restoreMap: Map<string, readonly vscode.Breakpoint[]> = pendingRestore,
): Promise<void> {
  if (!session) {
    deps.window.showInformationMessage(
      'Start debugging and pause first, then use Force Run to Cursor.',
    );
    return;
  }

  // Ignore if already mid-force-run to avoid overwriting saved breakpoints.
  if (restoreMap.has(session.id)) {
    return;
  }

  const saved = [...deps.debug.breakpoints];
  deps.debug.removeBreakpoints(saved);
  restoreMap.set(session.id, saved);

  await deps.commands.executeCommand('editor.debug.action.runToCursor');
}

/**
 * On a DAP `stopped` event, restore saved breakpoints for this session.
 *
 * Only triggers on `stopped` (adapter still alive). Terminal events are
 * handled by the `onDidTerminateDebugSession` safety net in {@link activate}.
 *
 * @returns `true` if breakpoints were restored.
 */
export async function maybeRestoreOnAdapterEvent(
  sessionId: string,
  msg: any,
  deps: RestoreDeps = { debug: vscode.debug },
  restoreMap: Map<string, readonly vscode.Breakpoint[]> = pendingRestore,
): Promise<boolean> {
  const saved = restoreMap.get(sessionId);
  if (!saved || msg?.type !== 'event' || msg.event !== 'stopped') {
    return false;
  }

  restoreMap.delete(sessionId);
  restoreBreakpoints(deps.debug, saved);
  return true;
}

/**
 * Cancel all pending force-runs, restoring breakpoints for every tracked session.
 */
export function cancelAllPendingRestores(
  deps: RestoreDeps = { debug: vscode.debug },
  restoreMap: Map<string, readonly vscode.Breakpoint[]> = pendingRestore,
): void {
  for (const [, saved] of restoreMap) {
    restoreBreakpoints(deps.debug, saved);
  }
  restoreMap.clear();
}

export function activate(context: vscode.ExtensionContext) {
  // Status bar item shown while a force-run is active.
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusBarItem.text = '$(debug-stop) Force Run Active';
  statusBarItem.tooltip = 'Click to cancel and restore breakpoints';
  statusBarItem.command = 'runToCursor.cancelForceRun';
  statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  context.subscriptions.push(statusBarItem);

  function updateStatusBar() {
    if (pendingRestore.size > 0) {
      statusBarItem.show();
      vscode.commands.executeCommand('setContext', 'forceRunToCursor.isActive', true);
    } else {
      statusBarItem.hide();
      vscode.commands.executeCommand('setContext', 'forceRunToCursor.isActive', false);
    }
  }

  // Restore breakpoints when the debugger stops (primary path).
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory('*', {
      createDebugAdapterTracker(session) {
        return {
          onDidSendMessage: async (msg: any) => {
            await maybeRestoreOnAdapterEvent(session.id, msg);
            updateStatusBar();
          },
        };
      },
    }),
  );

  // Safety net: restore if the session ends without a `stopped` event
  // (e.g. program finishes or crashes).
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(session => {
      const saved = pendingRestore.get(session.id);
      if (!saved) {
        return;
      }
      pendingRestore.delete(session.id);
      restoreBreakpoints(vscode.debug, saved);
      updateStatusBar();
    }),
  );

  // Cancel all pending force-runs.
  context.subscriptions.push(
    vscode.commands.registerCommand('runToCursor.cancelForceRun', () => {
      cancelAllPendingRestores();
      updateStatusBar();
    }),
  );

  // Wrapper for built-in Run to Cursor (for custom toolbar icon).
  context.subscriptions.push(
    vscode.commands.registerCommand('runToCursor.run', () =>
      vscode.commands.executeCommand('editor.debug.action.runToCursor'),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('runToCursor.force', async () => {
      await forceRunToCursorImpl(vscode.debug.activeDebugSession ?? undefined);
      updateStatusBar();
    }),
  );
}

export function deactivate() {}
