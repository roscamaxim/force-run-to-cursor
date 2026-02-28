import * as vscode from 'vscode';

/** Cached exception breakpoint filter configuration for a debug session. */
export type ExceptionFilterState = {
  filters: string[];
  filterOptions?: any[];
};

/** Minimal session interface for DAP custom requests (testable without full vscode.DebugSession). */
export type SessionLike = {
  id: string;
  customRequest(command: string, args?: any): Thenable<any>;
};

/** Maps session ID → breakpoints removed during a force-run, pending restoration. */
const pendingRestore = new Map<string, readonly vscode.Breakpoint[]>();

/** Maps session ID → last known exception breakpoint filter config. */
const cachedExceptionFilters = new Map<string, ExceptionFilterState>();

/** Maps session ID → count of auto-continues on exception stops during active force-run. */
const exceptionContinueCount = new Map<string, number>();

/** Maximum number of auto-continues on exception stops before falling through to normal restore. */
const MAX_EXCEPTION_CONTINUES = 3;

/** Maps session ID → session reference for custom requests (exception filter restore, continue). */
const sessionRefs = new Map<string, SessionLike>();

/**
 * Cache exception breakpoint filter configuration from a DAP `setExceptionBreakpoints` request.
 *
 * Called from `onWillReceiveMessage` in the tracker. Skips caching when a force-run is active
 * (the request is our own suppression call).
 */
export function cacheExceptionFilters(
  sessionId: string,
  msg: any,
  restoreMap: Map<string, readonly any[]> = pendingRestore,
  cache: Map<string, ExceptionFilterState> = cachedExceptionFilters,
): void {
  if (msg?.type !== 'request' || msg.command !== 'setExceptionBreakpoints') {
    return;
  }
  // Skip caching our own suppression request during an active force-run.
  if (restoreMap.has(sessionId)) {
    return;
  }
  const args = msg.arguments;
  const state: ExceptionFilterState = { filters: [...(args?.filters ?? [])] };
  if (args?.filterOptions) {
    state.filterOptions = args.filterOptions;
  }
  cache.set(sessionId, state);
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

/** Remove any leftover breakpoints (orphaned temp BPs), then re-add the saved set. */
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
  session: { id: string; customRequest?: (cmd: string, args?: any) => Thenable<any> } | undefined,
  deps: ForceDeps = { commands: vscode.commands, window: vscode.window, debug: vscode.debug },
  restoreMap: Map<string, readonly vscode.Breakpoint[]> = pendingRestore,
  exceptionCacheMap: Map<string, ExceptionFilterState> = cachedExceptionFilters,
  sessionRefMap: Map<string, SessionLike> = sessionRefs,
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

  // Suppress exception breakpoints if we have a cached config and the session supports customRequest.
  if (session.customRequest && exceptionCacheMap.has(session.id)) {
    await session.customRequest('setExceptionBreakpoints', { filters: [] });
    sessionRefMap.set(session.id, session as SessionLike);
  }

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
  session?: SessionLike,
  exceptionCacheMap: Map<string, ExceptionFilterState> = cachedExceptionFilters,
  continueCountMap: Map<string, number> = exceptionContinueCount,
): Promise<boolean> {
  const saved = restoreMap.get(sessionId);
  if (!saved || msg?.type !== 'event' || msg.event !== 'stopped') {
    return false;
  }

  // Auto-continue on exception stops (defense-in-depth for non-compliant adapters).
  if (msg.body?.reason === 'exception' && session) {
    const count = continueCountMap.get(sessionId) ?? 0;
    if (count < MAX_EXCEPTION_CONTINUES) {
      continueCountMap.set(sessionId, count + 1);
      await session.customRequest('continue', { threadId: msg.body.threadId });
      return false;
    }
    // Counter exceeded — fall through to normal restore.
  }

  restoreMap.delete(sessionId);
  restoreBreakpoints(deps.debug, saved);

  // Restore exception breakpoint filters if we suppressed them.
  const cachedFilters = exceptionCacheMap.get(sessionId);
  if (cachedFilters && session) {
    await session.customRequest('setExceptionBreakpoints', cachedFilters);
  }

  continueCountMap.delete(sessionId);
  return true;
}

/**
 * Cancel all pending force-runs, restoring breakpoints for every tracked session.
 */
export async function cancelAllPendingRestores(
  deps: RestoreDeps = { debug: vscode.debug },
  restoreMap: Map<string, readonly vscode.Breakpoint[]> = pendingRestore,
  sessionRefMap: Map<string, SessionLike> = sessionRefs,
  exceptionCacheMap: Map<string, ExceptionFilterState> = cachedExceptionFilters,
  continueCountMap: Map<string, number> = exceptionContinueCount,
): Promise<void> {
  for (const [sessionId, saved] of restoreMap) {
    restoreBreakpoints(deps.debug, saved);

    // Restore exception breakpoint filters if we suppressed them.
    const cachedFilters = exceptionCacheMap.get(sessionId);
    const session = sessionRefMap.get(sessionId);
    if (cachedFilters && session) {
      await session.customRequest('setExceptionBreakpoints', cachedFilters);
    }
  }
  restoreMap.clear();
  sessionRefMap.clear();
  continueCountMap.clear();
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

  // Track exception breakpoint configuration and restore breakpoints on stop.
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory('*', {
      createDebugAdapterTracker(session) {
        return {
          onWillReceiveMessage: (msg: any) => {
            cacheExceptionFilters(session.id, msg);
          },
          onDidSendMessage: async (msg: any) => {
            const sessionRef = sessionRefs.get(session.id) ??
              (session as unknown as SessionLike);
            await maybeRestoreOnAdapterEvent(
              session.id,
              msg,
              undefined,
              undefined,
              sessionRef,
            );
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
      if (saved) {
        pendingRestore.delete(session.id);
        restoreBreakpoints(vscode.debug, saved);
      }
      // Clean up per-session state. Don't restore exception filters — session is dead.
      cachedExceptionFilters.delete(session.id);
      exceptionContinueCount.delete(session.id);
      sessionRefs.delete(session.id);
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
      const session = vscode.debug.activeDebugSession ?? undefined;
      await forceRunToCursorImpl(session);
      updateStatusBar();
    }),
  );
}

export function deactivate() {}
