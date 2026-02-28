import * as assert from 'assert';
import {
  forceRunToCursorImpl,
  maybeRestoreOnAdapterEvent,
  cancelAllPendingRestores,
  cacheExceptionFilters,
  ExceptionFilterState,
  SessionLike,
  ForceRunContext,
  DapMessage,
} from '../src/extension';

/** Fake breakpoint for testing (mirrors vscode.Breakpoint shape). */
function fakeBp(id: string) {
  return { id } as any;
}

/** Creates a fresh ForceRunContext for test isolation. */
function makeCtx(): ForceRunContext {
  return {
    activeRuns: new Map(),
    exceptionCache: new Map(),
  };
}

/** Creates a mock RestoreDeps that tracks add/remove calls and warning messages. */
function makeRestoreDeps(currentBreakpoints: any[] = []) {
  const added: any[] = [];
  const removed: any[] = [];
  const warnings: string[] = [];
  const deps = {
    debug: {
      breakpoints: currentBreakpoints,
      addBreakpoints: (b: readonly any[]) => { added.push(...b); },
      removeBreakpoints: (b: readonly any[]) => { removed.push(...b); },
    },
    window: {
      showWarningMessage: (msg: string) => { warnings.push(msg); },
    },
  };
  return { deps, added, removed, warnings };
}

/** Creates a mock ForceDeps that tracks command and breakpoint calls. */
function makeForceDeps(breakpoints: any[] = []) {
  const calls: string[] = [];
  const messages: string[] = [];
  const removed: any[] = [];
  const deps = {
    commands: { executeCommand: async (cmd: string) => { calls.push(cmd); } },
    window: { showInformationMessage: async (msg: string) => { messages.push(msg); } },
    debug: {
      breakpoints,
      removeBreakpoints: (b: readonly any[]) => { removed.push(...b); },
    },
  };
  return { deps, calls, messages, removed };
}

/** Creates a mock SessionLike that records customRequest calls. */
function fakeSession(id: string) {
  const customRequests: { command: string; args: any }[] = [];
  const session: SessionLike = {
    id,
    customRequest: async (command: string, args?: unknown) => {
      customRequests.push({ command, args });
    },
  };
  return { session, customRequests };
}

/** Creates a mock SessionLike that throws on customRequest. */
function failingSession(id: string) {
  const session: SessionLike = {
    id,
    customRequest: async () => {
      throw new Error('adapter crashed');
    },
  };
  return { session };
}

suite('Force Run to Cursor - unit tests', () => {
  test('no active session -> shows message and does not run debug commands', async () => {
    const { deps, calls, messages } = makeForceDeps();
    const ctx = makeCtx();

    await forceRunToCursorImpl(undefined, deps, ctx);

    assert.strictEqual(calls.length, 0, 'Should not execute any debug commands without a session');
    assert.strictEqual(messages.length, 1, 'Should show exactly one info message');
    assert.ok(messages[0].toLowerCase().includes('start debugging'));
    assert.strictEqual(ctx.activeRuns.size, 0, 'Should not mark restore pending');
  });

  test('active session -> removes breakpoints then runs to cursor and saves them for restore', async () => {
    const bps = [fakeBp('bp-1'), fakeBp('bp-2')];
    const { deps, calls, removed } = makeForceDeps(bps);
    const ctx = makeCtx();

    await forceRunToCursorImpl({ id: 'sess-1' }, deps, ctx);

    assert.deepStrictEqual(removed, bps, 'Should remove all existing breakpoints');
    assert.deepStrictEqual(calls, ['editor.debug.action.runToCursor']);
    const runState = ctx.activeRuns.get('sess-1');
    assert.ok(runState, 'Should have active run state');
    assert.deepStrictEqual(runState!.savedBreakpoints, bps, 'Should save breakpoints for restoration');
  });

  test("restore happens on 'stopped' event and re-adds saved breakpoints", async () => {
    const bps = [fakeBp('bp-a'), fakeBp('bp-b')];
    const { deps, added } = makeRestoreDeps();
    const ctx = makeCtx();
    ctx.activeRuns.set('sess-2', { savedBreakpoints: bps, continueCount: 0 });

    const restored = await maybeRestoreOnAdapterEvent('sess-2', { type: 'event', event: 'stopped' }, undefined, deps, ctx);

    assert.strictEqual(restored, true);
    assert.deepStrictEqual(added, bps, 'Should re-add the saved breakpoints');
    assert.ok(!ctx.activeRuns.has('sess-2'), 'Should clear pending restore');
  });

  test('restore cleans up orphaned temp breakpoints before re-adding saved ones', async () => {
    const savedBps = [fakeBp('bp-orig')];
    const tempBp = fakeBp('temp-bp');
    const { deps, added, removed } = makeRestoreDeps([tempBp]);
    const ctx = makeCtx();
    ctx.activeRuns.set('sess-orphan', { savedBreakpoints: savedBps, continueCount: 0 });

    await maybeRestoreOnAdapterEvent('sess-orphan', { type: 'event', event: 'stopped' }, undefined, deps, ctx);

    assert.deepStrictEqual(removed, [tempBp], 'Should remove orphaned temp breakpoint');
    assert.deepStrictEqual(added, savedBps, 'Should re-add only the saved breakpoints');
  });

  test('no restore on non-stopped events (terminated, exited, output)', async () => {
    for (const event of ['terminated', 'exited', 'output']) {
      const { deps, added } = makeRestoreDeps();
      const ctx = makeCtx();
      ctx.activeRuns.set('sess', { savedBreakpoints: [fakeBp('bp')], continueCount: 0 });

      const restored = await maybeRestoreOnAdapterEvent('sess', { type: 'event', event }, undefined, deps, ctx);

      assert.strictEqual(restored, false, `Should not restore on '${event}'`);
      assert.strictEqual(added.length, 0, `Should not add breakpoints on '${event}'`);
      assert.ok(ctx.activeRuns.has('sess'), `Should keep pending restore on '${event}'`);
    }
  });

  test('no restore for an untracked session (normal debugging unaffected)', async () => {
    const { deps, added } = makeRestoreDeps();
    const ctx = makeCtx();

    const restored = await maybeRestoreOnAdapterEvent('sess-normal', { type: 'event', event: 'stopped' }, undefined, deps, ctx);

    assert.strictEqual(restored, false);
    assert.strictEqual(added.length, 0, 'Should not touch breakpoints during normal debugging');
  });

  test('force-run on same line (no-op) can be detected via didContinue flag', async () => {
    const bps = [fakeBp('bp-stale')];
    const { deps } = makeForceDeps(bps);
    const ctx = makeCtx();

    await forceRunToCursorImpl({ id: 'sess-stale' }, deps, ctx);

    const runState = ctx.activeRuns.get('sess-stale');
    assert.ok(runState, 'Should have active run state');
    assert.strictEqual(runState!.didContinue, undefined, 'didContinue should not be set (no continue request observed)');

    // Simulate the tracker detecting a continue request.
    runState!.didContinue = true;
    assert.strictEqual(runState!.didContinue, true, 'didContinue should be true after continue request');
  });

  test('rapid repeated calls do not overwrite saved breakpoints', async () => {
    const originalBps = [fakeBp('bp-orig-1'), fakeBp('bp-orig-2')];
    const { deps, calls } = makeForceDeps(originalBps);
    const ctx = makeCtx();
    const session = { id: 'sess-rapid' };

    await forceRunToCursorImpl(session, deps, ctx);
    deps.debug.breakpoints = [];
    await forceRunToCursorImpl(session, deps, ctx);

    const runState = ctx.activeRuns.get('sess-rapid');
    assert.ok(runState, 'Should have active run state');
    assert.deepStrictEqual(runState!.savedBreakpoints, originalBps, 'Saved breakpoints must not be overwritten');
    assert.strictEqual(calls.filter(c => c === 'editor.debug.action.runToCursor').length, 1);
  });

  test('double stop only restores once (idempotent)', async () => {
    const bps = [fakeBp('bp-dup')];
    const { deps, added } = makeRestoreDeps();
    const ctx = makeCtx();
    ctx.activeRuns.set('sess-dup', { savedBreakpoints: bps, continueCount: 0 });

    await maybeRestoreOnAdapterEvent('sess-dup', { type: 'event', event: 'stopped' }, undefined, deps, ctx);
    await maybeRestoreOnAdapterEvent('sess-dup', { type: 'event', event: 'stopped' }, undefined, deps, ctx);

    assert.deepStrictEqual(added, bps, 'Should add breakpoints exactly once');
  });

  test('cancelAllPendingRestores restores breakpoints from all sessions and clears state', async () => {
    const bps1 = [fakeBp('bp-c1'), fakeBp('bp-c2')];
    const bps2 = [fakeBp('bp-c3')];

    const ctx = makeCtx();
    ctx.activeRuns.set('sess-cancel-1', { savedBreakpoints: bps1, continueCount: 0 });
    ctx.activeRuns.set('sess-cancel-2', { savedBreakpoints: bps2, continueCount: 0 });

    const { deps, added } = makeRestoreDeps();

    await cancelAllPendingRestores(deps, ctx);

    assert.strictEqual(ctx.activeRuns.size, 0, 'Should clear all pending restores');
    assert.deepStrictEqual(added, [...bps1, ...bps2], 'Should restore breakpoints from all sessions');
  });

  test('cancelAllPendingRestores is a no-op when nothing is pending', async () => {
    const ctx = makeCtx();
    const { deps, added, removed } = makeRestoreDeps();

    await cancelAllPendingRestores(deps, ctx);

    assert.strictEqual(ctx.activeRuns.size, 0, 'Map should remain empty');
    assert.strictEqual(added.length, 0, 'Should not add any breakpoints');
    assert.strictEqual(removed.length, 0, 'Should not remove any breakpoints');
  });
});

// --- Exception breakpoint caching tests ---

suite('Exception breakpoint caching', () => {
  test('caches setExceptionBreakpoints request args (filters + filterOptions)', () => {
    const ctx = makeCtx();

    cacheExceptionFilters('sess-1', {
      type: 'request',
      command: 'setExceptionBreakpoints',
      arguments: {
        filters: ['uncaught', 'caught'],
        filterOptions: [{ filterId: 'uncaught', condition: 'Uncaught' }],
      },
    }, ctx);

    assert.ok(ctx.exceptionCache.has('sess-1'), 'Should cache the session');
    const cached = ctx.exceptionCache.get('sess-1')!;
    assert.deepStrictEqual(cached.filters, ['uncaught', 'caught']);
    assert.deepStrictEqual(cached.filterOptions, [{ filterId: 'uncaught', condition: 'Uncaught' }]);
  });

  test('ignores non-setExceptionBreakpoints messages', () => {
    const ctx = makeCtx();

    cacheExceptionFilters('sess-1', {
      type: 'request',
      command: 'setBreakpoints',
    }, ctx);

    assert.strictEqual(ctx.exceptionCache.size, 0, 'Should not cache non-exception breakpoint requests');
  });

  test('skips caching when force-run active (activeRuns.has)', () => {
    const ctx = makeCtx();
    ctx.activeRuns.set('sess-1', { savedBreakpoints: [], continueCount: 0 });

    cacheExceptionFilters('sess-1', {
      type: 'request',
      command: 'setExceptionBreakpoints',
      arguments: { filters: ['uncaught'] },
    }, ctx);

    assert.strictEqual(ctx.exceptionCache.size, 0, 'Should skip caching during active force-run');
  });

  test('overwrites old cache on new request', () => {
    const ctx = makeCtx();

    cacheExceptionFilters('sess-1', {
      type: 'request',
      command: 'setExceptionBreakpoints',
      arguments: { filters: ['uncaught'] },
    }, ctx);

    cacheExceptionFilters('sess-1', {
      type: 'request',
      command: 'setExceptionBreakpoints',
      arguments: { filters: ['caught'] },
    }, ctx);

    assert.deepStrictEqual(ctx.exceptionCache.get('sess-1')!.filters, ['caught'], 'Should overwrite with latest');
  });
});

// --- Exception breakpoint suppression tests ---

suite('Exception breakpoint suppression', () => {
  test('forceRunToCursorImpl calls setExceptionBreakpoints({ filters: [] }) when cache exists', async () => {
    const { session, customRequests } = fakeSession('sess-exc');
    const { deps } = makeForceDeps([fakeBp('bp-1')]);
    const ctx = makeCtx();
    ctx.exceptionCache.set('sess-exc', { filters: ['uncaught'] });

    await forceRunToCursorImpl(session, deps, ctx);

    assert.strictEqual(customRequests.length, 1);
    assert.strictEqual(customRequests[0].command, 'setExceptionBreakpoints');
    assert.deepStrictEqual(customRequests[0].args, { filters: [] });
    const runState = ctx.activeRuns.get('sess-exc');
    assert.ok(runState?.sessionRef, 'Should store session ref in run state');
  });

  test('forceRunToCursorImpl works without customRequest (backward compat)', async () => {
    const { deps, calls } = makeForceDeps([fakeBp('bp-1')]);
    const ctx = makeCtx();
    ctx.exceptionCache.set('sess-no-cr', { filters: ['uncaught'] });

    await forceRunToCursorImpl({ id: 'sess-no-cr' }, deps, ctx);

    assert.deepStrictEqual(calls, ['editor.debug.action.runToCursor']);
    assert.ok(ctx.activeRuns.has('sess-no-cr'));
    const runState = ctx.activeRuns.get('sess-no-cr')!;
    assert.strictEqual(runState.sessionRef, undefined, 'Should not store session ref without customRequest');
  });
});

// --- Exception breakpoint restoration tests ---

suite('Exception breakpoint restoration', () => {
  test('maybeRestoreOnAdapterEvent restores exception filters on normal stop', async () => {
    const bps = [fakeBp('bp-r1')];
    const { deps, added } = makeRestoreDeps();
    const { session, customRequests } = fakeSession('sess-r1');

    const ctx = makeCtx();
    ctx.activeRuns.set('sess-r1', { savedBreakpoints: bps, continueCount: 0, sessionRef: session });
    ctx.exceptionCache.set('sess-r1', { filters: ['uncaught', 'caught'] });

    const restored = await maybeRestoreOnAdapterEvent(
      'sess-r1',
      { type: 'event', event: 'stopped', body: { reason: 'breakpoint' } },
      session, deps, ctx,
    );

    assert.strictEqual(restored, true);
    assert.deepStrictEqual(added, bps, 'Should restore breakpoints');
    assert.strictEqual(customRequests.length, 1, 'Should call customRequest to restore exception filters');
    assert.strictEqual(customRequests[0].command, 'setExceptionBreakpoints');
    assert.deepStrictEqual(customRequests[0].args, { filters: ['uncaught', 'caught'] });
  });

  test('skips exception restoration when no cache entry', async () => {
    const bps = [fakeBp('bp-r2')];
    const { deps, added } = makeRestoreDeps();
    const { session, customRequests } = fakeSession('sess-r2');

    const ctx = makeCtx();
    ctx.activeRuns.set('sess-r2', { savedBreakpoints: bps, continueCount: 0 });

    const restored = await maybeRestoreOnAdapterEvent(
      'sess-r2',
      { type: 'event', event: 'stopped', body: { reason: 'breakpoint' } },
      session, deps, ctx,
    );

    assert.strictEqual(restored, true);
    assert.deepStrictEqual(added, bps, 'Should still restore breakpoints');
    assert.strictEqual(customRequests.length, 0, 'Should not call customRequest without cache');
  });

  test('skips exception restoration when no session ref', async () => {
    const bps = [fakeBp('bp-r3')];
    const { deps, added } = makeRestoreDeps();

    const ctx = makeCtx();
    ctx.activeRuns.set('sess-r3', { savedBreakpoints: bps, continueCount: 0 });
    ctx.exceptionCache.set('sess-r3', { filters: ['uncaught'] });

    const restored = await maybeRestoreOnAdapterEvent(
      'sess-r3',
      { type: 'event', event: 'stopped', body: { reason: 'breakpoint' } },
      undefined, deps, ctx,
    );

    assert.strictEqual(restored, true);
    assert.deepStrictEqual(added, bps, 'Should still restore breakpoints');
  });

  test('cancelAllPendingRestores restores exception filters for all sessions', async () => {
    const bps = [fakeBp('bp-c')];
    const { deps, added } = makeRestoreDeps();
    const { session: sess1, customRequests: cr1 } = fakeSession('sess-c1');
    const { session: sess2, customRequests: cr2 } = fakeSession('sess-c2');

    const ctx = makeCtx();
    ctx.activeRuns.set('sess-c1', { savedBreakpoints: bps, continueCount: 0, sessionRef: sess1 });
    ctx.activeRuns.set('sess-c2', { savedBreakpoints: bps, continueCount: 0, sessionRef: sess2 });
    ctx.exceptionCache.set('sess-c1', { filters: ['uncaught'] });
    ctx.exceptionCache.set('sess-c2', { filters: ['caught'] });

    await cancelAllPendingRestores(deps, ctx);

    assert.strictEqual(ctx.activeRuns.size, 0, 'Should clear activeRuns');
    assert.strictEqual(cr1.length, 1, 'Should restore exception filters for session 1');
    assert.deepStrictEqual(cr1[0].args, { filters: ['uncaught'] });
    assert.strictEqual(cr2.length, 1, 'Should restore exception filters for session 2');
    assert.deepStrictEqual(cr2[0].args, { filters: ['caught'] });
  });
});

// --- Exception auto-continue tests ---

suite('Exception auto-continue (defense-in-depth)', () => {
  test('exception stop during force-run -> auto-continue, returns false', async () => {
    const bps = [fakeBp('bp-ac1')];
    const { deps, added } = makeRestoreDeps();
    const { session, customRequests } = fakeSession('sess-ac1');

    const ctx = makeCtx();
    ctx.activeRuns.set('sess-ac1', { savedBreakpoints: bps, continueCount: 0 });

    const restored = await maybeRestoreOnAdapterEvent(
      'sess-ac1',
      { type: 'event', event: 'stopped', body: { reason: 'exception', threadId: 42 } },
      session, deps, ctx,
    );

    assert.strictEqual(restored, false, 'Should NOT restore on exception stop (auto-continue)');
    assert.strictEqual(added.length, 0, 'Should not add breakpoints');
    assert.ok(ctx.activeRuns.has('sess-ac1'), 'Should keep force-run active');
    assert.strictEqual(customRequests.length, 1, 'Should call continue');
    assert.strictEqual(customRequests[0].command, 'continue');
    assert.deepStrictEqual(customRequests[0].args, { threadId: 42 });
    assert.strictEqual(ctx.activeRuns.get('sess-ac1')!.continueCount, 1, 'Should increment counter');
  });

  test('non-exception stop during force-run -> normal restore, returns true', async () => {
    const bps = [fakeBp('bp-ac2')];
    const { deps, added } = makeRestoreDeps();
    const { session, customRequests } = fakeSession('sess-ac2');

    const ctx = makeCtx();
    ctx.activeRuns.set('sess-ac2', { savedBreakpoints: bps, continueCount: 0 });

    const restored = await maybeRestoreOnAdapterEvent(
      'sess-ac2',
      { type: 'event', event: 'stopped', body: { reason: 'breakpoint' } },
      session, deps, ctx,
    );

    assert.strictEqual(restored, true, 'Should restore on non-exception stop');
    assert.deepStrictEqual(added, bps, 'Should restore breakpoints');
    assert.ok(!ctx.activeRuns.has('sess-ac2'), 'Should clear pending restore');
    assert.strictEqual(customRequests.length, 0, 'Should not call continue for non-exception');
  });

  test('exception stop with counter at max -> falls through to normal restore and warns user', async () => {
    const bps = [fakeBp('bp-ac3')];
    const { deps, added, warnings } = makeRestoreDeps();
    const { session, customRequests } = fakeSession('sess-ac3');

    const ctx = makeCtx();
    ctx.activeRuns.set('sess-ac3', { savedBreakpoints: bps, continueCount: 3 }); // at max

    const restored = await maybeRestoreOnAdapterEvent(
      'sess-ac3',
      { type: 'event', event: 'stopped', body: { reason: 'exception', threadId: 7 } },
      session, deps, ctx,
    );

    assert.strictEqual(restored, true, 'Should fall through to restore when counter at max');
    assert.deepStrictEqual(added, bps, 'Should restore breakpoints');
    assert.ok(!ctx.activeRuns.has('sess-ac3'), 'Should clear pending restore');
    assert.strictEqual(customRequests.length, 0, 'Should not auto-continue when counter exceeded');
    assert.strictEqual(warnings.length, 1, 'Should warn user about exception limit');
    assert.ok(warnings[0].includes('too many exceptions'), 'Warning should mention too many exceptions');
  });

  test('counter resets on successful restore', async () => {
    const bps = [fakeBp('bp-ac4')];
    const { deps } = makeRestoreDeps();
    const { session } = fakeSession('sess-ac4');

    const ctx = makeCtx();
    ctx.activeRuns.set('sess-ac4', { savedBreakpoints: bps, continueCount: 2 });

    await maybeRestoreOnAdapterEvent(
      'sess-ac4',
      { type: 'event', event: 'stopped', body: { reason: 'step' } },
      session, deps, ctx,
    );

    assert.ok(!ctx.activeRuns.has('sess-ac4'), 'Run state should be cleared after restore');
  });
});

// --- Error-path tests (customRequest failure handling) ---

suite('Error handling (customRequest failures)', () => {
  test('customRequest throws during exception suppression -> force-run still executes', async () => {
    const { session } = failingSession('sess-err1');
    const { deps, calls } = makeForceDeps([fakeBp('bp-1')]);
    const ctx = makeCtx();
    ctx.exceptionCache.set('sess-err1', { filters: ['uncaught'] });

    await forceRunToCursorImpl(session, deps, ctx);

    assert.deepStrictEqual(calls, ['editor.debug.action.runToCursor'], 'Should still run to cursor');
    assert.ok(ctx.activeRuns.has('sess-err1'), 'Should still track active run');
    const runState = ctx.activeRuns.get('sess-err1')!;
    assert.strictEqual(runState.sessionRef, undefined, 'Should not store session ref on suppression failure');
  });

  test('customRequest throws during restore -> breakpoints still restored', async () => {
    const bps = [fakeBp('bp-err2')];
    const { deps, added } = makeRestoreDeps();
    const { session } = failingSession('sess-err2');

    const ctx = makeCtx();
    ctx.activeRuns.set('sess-err2', { savedBreakpoints: bps, continueCount: 0 });
    ctx.exceptionCache.set('sess-err2', { filters: ['uncaught'] });

    const restored = await maybeRestoreOnAdapterEvent(
      'sess-err2',
      { type: 'event', event: 'stopped', body: { reason: 'breakpoint' } },
      session, deps, ctx,
    );

    assert.strictEqual(restored, true, 'Should still report restored');
    assert.deepStrictEqual(added, bps, 'Breakpoints should be restored despite customRequest failure');
    assert.ok(!ctx.activeRuns.has('sess-err2'), 'Should clear active run');
  });

  test('customRequest throws during auto-continue -> returns false (does not crash)', async () => {
    const bps = [fakeBp('bp-err3')];
    const { deps, added } = makeRestoreDeps();
    const { session } = failingSession('sess-err3');

    const ctx = makeCtx();
    ctx.activeRuns.set('sess-err3', { savedBreakpoints: bps, continueCount: 0 });

    const restored = await maybeRestoreOnAdapterEvent(
      'sess-err3',
      { type: 'event', event: 'stopped', body: { reason: 'exception', threadId: 1 } },
      session, deps, ctx,
    );

    assert.strictEqual(restored, false, 'Should return false (auto-continue path)');
    assert.strictEqual(added.length, 0, 'Should not restore breakpoints on auto-continue path');
    assert.ok(ctx.activeRuns.has('sess-err3'), 'Should keep force-run active');
  });

  test('customRequest throws during cancelAllPendingRestores -> breakpoints still restored', async () => {
    const bps = [fakeBp('bp-err4')];
    const { deps, added } = makeRestoreDeps();
    const { session } = failingSession('sess-err4');

    const ctx = makeCtx();
    ctx.activeRuns.set('sess-err4', { savedBreakpoints: bps, continueCount: 0, sessionRef: session });
    ctx.exceptionCache.set('sess-err4', { filters: ['uncaught'] });

    await cancelAllPendingRestores(deps, ctx);

    assert.strictEqual(ctx.activeRuns.size, 0, 'Should clear all active runs');
    assert.deepStrictEqual(added, bps, 'Breakpoints should be restored despite customRequest failure');
  });
});
