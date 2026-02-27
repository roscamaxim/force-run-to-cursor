import * as vscode from 'vscode';

/**
 * Tracks which debug sessions are currently in a "force run" window,
 * meaning we temporarily disabled breakpoints and must restore them
 * when the debugger next stops/terminates/exits.
 */
export const pendingRestore = new Set<string>();

export type ForceDeps = {
  commands: { executeCommand: (cmd: string, ...args: any[]) => Thenable<any> };
  window: { showInformationMessage: (msg: string) => Thenable<any> | void };
};

export type RestoreDeps = {
  commands: { executeCommand: (cmd: string, ...args: any[]) => Thenable<any> };
};

/**
 * Core implementation: disable all breakpoints, mark restore pending,
 * then run to cursor.
 *
 * Exported for unit testing.
 */
export async function forceRunToCursorImpl(
  session: { id: string } | undefined,
  deps: ForceDeps = { commands: vscode.commands, window: vscode.window },
  restoreSet: Set<string> = pendingRestore,
): Promise<void> {
  if (!session) {
    await Promise.resolve(
      deps.window.showInformationMessage(
        'Start debugging and pause first, then use Force Run to Cursor.',
      ),
    );
    return;
  }

  // 1) Disable all breakpoints (this does NOT delete them)
  await deps.commands.executeCommand('workbench.debug.viewlet.action.disableAllBreakpoints');

  // 2) Mark that we need to restore later (after next stop/terminate/exited)
  restoreSet.add(session.id);

  // 3) Run to cursor (caret line)
  await deps.commands.executeCommand('editor.debug.action.runToCursor');
}

/**
 * Restore helper: if we're pending restore for this session, and we see a stop-like
 * debug adapter event, re-enable all breakpoints and clear the pending flag.
 *
 * Returns true if a restore happened.
 *
 * Exported for unit testing.
 */
export async function maybeRestoreOnAdapterEvent(
  sessionId: string,
  msg: any,
  deps: RestoreDeps = { commands: vscode.commands },
  restoreSet: Set<string> = pendingRestore,
): Promise<boolean> {
  if (!restoreSet.has(sessionId)) {
    return false;
  }

  const isStopLike =
    msg?.type === 'event' &&
    (msg.event === 'stopped' || msg.event === 'terminated' || msg.event === 'exited');

  if (!isStopLike) {
    return false;
  }

  restoreSet.delete(sessionId);
  await deps.commands.executeCommand('workbench.debug.viewlet.action.enableAllBreakpoints');
  return true;
}

export function activate(context: vscode.ExtensionContext) {
  // Observe debug adapter events so we can restore breakpoints when execution stops.
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory('*', {
      createDebugAdapterTracker(session) {
        return {
          onDidSendMessage: async (msg: any) => {
            await maybeRestoreOnAdapterEvent(session.id, msg);
          },
        };
      },
    }),
  );

  // Safety net: if the session terminates without us seeing the expected adapter event,
  // restore breakpoints anyway.
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(async session => {
      if (!pendingRestore.has(session.id)) {
        return;
      }

      pendingRestore.delete(session.id);
      await vscode.commands.executeCommand('workbench.debug.viewlet.action.enableAllBreakpoints');
    }),
  );

  // Command entry point.
  context.subscriptions.push(
    vscode.commands.registerCommand('extension.forceRunToCursor', async () => {
      await forceRunToCursorImpl(vscode.debug.activeDebugSession ?? undefined);
    }),
  );
}

export function deactivate() {}
