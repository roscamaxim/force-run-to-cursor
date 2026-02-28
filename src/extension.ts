import * as vscode from 'vscode';

// --- DAP message types ---

/** Typed representation of the DAP message fields we inspect. */
export interface DapMessage {
  type?: string;
  command?: string;
  event?: string;
  arguments?: {
    filters?: string[];
    filterOptions?: ExceptionFilterOption[];
  };
  body?: {
    reason?: string;
    threadId?: number;
  };
}

/** A single exception filter option in a DAP `setExceptionBreakpoints` request. */
export interface ExceptionFilterOption {
  filterId: string;
  condition?: string;
}

// --- State types ---

/** Cached exception breakpoint filter configuration for a debug session. */
export type ExceptionFilterState = {
  filters: string[];
  filterOptions?: ExceptionFilterOption[];
};

/** Minimal session interface for DAP custom requests (testable without full vscode.DebugSession). */
export type SessionLike = {
  id: string;
  customRequest?: (command: string, args?: any) => Thenable<any>;
};

/** Per-force-run state: saved breakpoints, auto-continue counter, and session reference. */
type ForceRunState = {
  savedBreakpoints: readonly vscode.Breakpoint[];
  continueCount: number;
  sessionRef?: SessionLike;
  /** Set to true when a DAP `continue` request is observed after starting the force-run. */
  didContinue?: boolean;
};

/**
 * Consolidated context for all force-run state. Two maps with distinct lifecycles:
 *
 * - `activeRuns`: exists only while a force-run is in progress; cleaned up on restore or cancel.
 * - `exceptionCache`: persists across force-runs within a session. Cleared only on session
 *   termination because the user's exception filter configuration doesn't change between
 *   force-runs — we just need to know the last config to restore it.
 */
export type ForceRunContext = {
  activeRuns: Map<string, ForceRunState>;
  exceptionCache: Map<string, ExceptionFilterState>;
};

/**
 * Maximum number of auto-continues on exception stops before falling through to normal restore.
 *
 * When exception breakpoints fail to suppress (non-compliant adapters), we auto-continue up to
 * this many times. 3 is chosen as a reasonable balance: high enough to handle cascading exceptions
 * during a short run-to-cursor, low enough to avoid infinite loops if something is truly broken.
 */
const MAX_EXCEPTION_CONTINUES = 3;

// Module-level state (defaults used by activate/deactivate; tests inject their own).
const activeRuns = new Map<string, ForceRunState>();
const exceptionCache = new Map<string, ExceptionFilterState>();
const defaultCtx: ForceRunContext = { activeRuns, exceptionCache };
let outputChannel: vscode.LogOutputChannel | undefined;

/**
 * Cache exception breakpoint filter configuration from a DAP `setExceptionBreakpoints` request.
 *
 * Called from `onWillReceiveMessage` in the tracker. Skips caching when a force-run is active
 * (the request is our own suppression call).
 */
export function cacheExceptionFilters(
  sessionId: string,
  msg: DapMessage,
  ctx: ForceRunContext = defaultCtx,
): void {
  if (msg?.type !== 'request' || msg.command !== 'setExceptionBreakpoints') {
    return;
  }
  // Skip caching our own suppression request during an active force-run.
  if (ctx.activeRuns.has(sessionId)) {
    return;
  }
  const args = msg.arguments;
  const state: ExceptionFilterState = { filters: [...(args?.filters ?? [])] };
  if (args?.filterOptions) {
    state.filterOptions = args.filterOptions;
  }
  ctx.exceptionCache.set(sessionId, state);
}

/** Dependency injection for {@link forceRunToCursorImpl}. */
export type ForceDeps = {
  commands: { executeCommand: (cmd: string, ...args: unknown[]) => Thenable<unknown> };
  window: { showInformationMessage: (msg: string) => Thenable<unknown> | void };
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
  window?: { showWarningMessage: (msg: string) => Thenable<unknown> | void };
};

/**
 * Remove any leftover breakpoints (orphaned temp BPs), then re-add the saved set.
 *
 * This "nuke all + re-add" approach is correct for force-run: the operation is transient
 * (milliseconds to seconds), so users can't practically add breakpoints during that window.
 * A diff-based approach would add complexity for a scenario that doesn't happen in practice.
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
 * Restore breakpoints and exception filters for a session after a force-run.
 */
async function fullRestore(
  sessionId: string,
  runState: ForceRunState,
  session: SessionLike | undefined,
  deps: RestoreDeps,
  ctx: ForceRunContext,
): Promise<void> {
  restoreBreakpoints(deps.debug, runState.savedBreakpoints);
  const cachedFilters = ctx.exceptionCache.get(sessionId);
  if (cachedFilters && session?.customRequest) {
    try {
      await session.customRequest('setExceptionBreakpoints', cachedFilters);
    } catch (e) {
      outputChannel?.warn(`Exception BP restore failed: ${e}`);
    }
  }
}

/**
 * Remove all breakpoints, then run to cursor.
 *
 * Breakpoints are removed (not disabled) so that "Run to Cursor" can set a
 * fresh temp breakpoint even on lines that already have one.
 */
export async function forceRunToCursorImpl(
  session: SessionLike | undefined,
  deps: ForceDeps = { commands: vscode.commands, window: vscode.window, debug: vscode.debug },
  ctx: ForceRunContext = defaultCtx,
): Promise<void> {
  if (!session) {
    deps.window.showInformationMessage(
      'Start debugging and pause first, then use Force Run to Cursor.',
    );
    return;
  }

  // Ignore if already mid-force-run to avoid overwriting saved breakpoints.
  if (ctx.activeRuns.has(session.id)) {
    return;
  }

  const saved = [...deps.debug.breakpoints];
  deps.debug.removeBreakpoints(saved);

  const runState: ForceRunState = { savedBreakpoints: saved, continueCount: 0 };

  // Suppress exception breakpoints if we have a cached config and the session supports customRequest.
  if (session.customRequest && ctx.exceptionCache.has(session.id)) {
    try {
      await session.customRequest('setExceptionBreakpoints', { filters: [] });
      runState.sessionRef = { id: session.id, customRequest: session.customRequest };
    } catch (e) {
      outputChannel?.warn(`Exception BP suppression failed: ${e}`);
    }
  }

  ctx.activeRuns.set(session.id, runState);
  outputChannel?.info('Force run started');

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
  msg: DapMessage,
  session: SessionLike | undefined,
  deps: RestoreDeps = { debug: vscode.debug, window: vscode.window },
  ctx: ForceRunContext = defaultCtx,
): Promise<boolean> {
  const runState = ctx.activeRuns.get(sessionId);
  if (!runState || msg?.type !== 'event' || msg.event !== 'stopped') {
    return false;
  }

  const effectiveSession = session ?? runState.sessionRef;

  // Auto-continue on exception stops (defense-in-depth for non-compliant adapters).
  if (msg.body?.reason === 'exception' && effectiveSession?.customRequest) {
    if (runState.continueCount < MAX_EXCEPTION_CONTINUES) {
      runState.continueCount++;
      try {
        await effectiveSession.customRequest('continue', { threadId: msg.body.threadId });
      } catch (e) {
        outputChannel?.warn(`Auto-continue failed: ${e}`);
      }
      return false;
    }
    // Counter exceeded — fall through to normal restore, warn the user.
    outputChannel?.warn(`Auto-continue limit (${MAX_EXCEPTION_CONTINUES}) reached, restoring breakpoints`);
    deps.window?.showWarningMessage(
      `Force Run to Cursor stopped early — too many exceptions (${MAX_EXCEPTION_CONTINUES}) encountered during run.`,
    );
  }

  ctx.activeRuns.delete(sessionId);
  await fullRestore(sessionId, runState, effectiveSession, deps, ctx);

  return true;
}

/**
 * Cancel all pending force-runs, restoring breakpoints for every tracked session.
 */
export async function cancelAllPendingRestores(
  deps: RestoreDeps = { debug: vscode.debug, window: vscode.window },
  ctx: ForceRunContext = defaultCtx,
): Promise<void> {
  for (const [sessionId, runState] of ctx.activeRuns) {
    await fullRestore(sessionId, runState, runState.sessionRef, deps, ctx);
  }
  ctx.activeRuns.clear();
}

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Force Run to Cursor', { log: true });
  context.subscriptions.push(outputChannel);

  // Status bar item shown while a force-run is active.
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusBarItem.text = '$(debug-stop) Force Run Active';
  statusBarItem.tooltip = 'Click to cancel and restore breakpoints';
  statusBarItem.command = 'runToCursor.cancelForceRun';
  statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  context.subscriptions.push(statusBarItem);

  // Track previous state to skip redundant setContext calls.
  let statusBarActive = false;

  function updateStatusBar() {
    const isActive = defaultCtx.activeRuns.size > 0;
    if (isActive === statusBarActive) { return; }
    statusBarActive = isActive;
    if (isActive) {
      statusBarItem.show();
    } else {
      statusBarItem.hide();
    }
    vscode.commands.executeCommand('setContext', 'forceRunToCursor.isActive', isActive);
  }

  // Track exception breakpoint configuration and restore breakpoints on stop.
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory('*', {
      createDebugAdapterTracker(session) {
        return {
          onWillReceiveMessage: (msg: DapMessage) => {
            cacheExceptionFilters(session.id, msg);
            // Track continue requests to detect no-op run-to-cursor.
            if (msg?.type === 'request' && msg.command === 'continue') {
              const runState = defaultCtx.activeRuns.get(session.id);
              if (runState) {
                runState.didContinue = true;
              }
            }
          },
          onDidSendMessage: async (msg: DapMessage) => {
            await maybeRestoreOnAdapterEvent(
              session.id,
              msg,
              session,
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
      const runState = defaultCtx.activeRuns.get(session.id);
      if (runState) {
        defaultCtx.activeRuns.delete(session.id);
        restoreBreakpoints(vscode.debug, runState.savedBreakpoints);
      }
      // Clean up per-session state. Don't restore exception filters — session is dead.
      defaultCtx.exceptionCache.delete(session.id);
      updateStatusBar();
    }),
  );

  // Cancel all pending force-runs.
  context.subscriptions.push(
    vscode.commands.registerCommand('runToCursor.cancelForceRun', async () => {
      await cancelAllPendingRestores();
      updateStatusBar();
    }),
  );

  // Wrapper for built-in Run to Cursor (for custom toolbar icon).
  context.subscriptions.push(
    vscode.commands.registerCommand('runToCursor.run', () =>
      vscode.commands.executeCommand('editor.debug.action.runToCursor'),
    ),
  );

  // No-op: greyed-out toolbar icon shown while a force-run is in progress.
  context.subscriptions.push(
    vscode.commands.registerCommand('runToCursor.forceRunning', () => {}),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('runToCursor.force', async () => {
      const session = vscode.debug.activeDebugSession ?? undefined;
      await forceRunToCursorImpl(session);
      updateStatusBar();

      // Safety net: if run-to-cursor was a no-op (e.g., cursor already on the current
      // execution line), no DAP `continue` request will have been sent. Detect this and
      // restore breakpoints instead of leaving the extension stuck.
      if (session && defaultCtx.activeRuns.has(session.id)) {
        const sessionId = session.id;
        setTimeout(async () => {
          const runState = defaultCtx.activeRuns.get(sessionId);
          if (runState && !runState.didContinue) {
            outputChannel?.warn('Run-to-cursor appears to be a no-op (no continue request sent), restoring');
            defaultCtx.activeRuns.delete(sessionId);
            await fullRestore(sessionId, runState, runState.sessionRef,
              { debug: vscode.debug, window: vscode.window }, defaultCtx);
            updateStatusBar();
          }
        }, 500);
      }
    }),
  );
}

export function deactivate() {
  // Restore breakpoints synchronously; skip exception filter restoration (sessions are ending).
  for (const [, runState] of defaultCtx.activeRuns) {
    restoreBreakpoints(vscode.debug, runState.savedBreakpoints);
  }
  defaultCtx.activeRuns.clear();
  defaultCtx.exceptionCache.clear();
}
