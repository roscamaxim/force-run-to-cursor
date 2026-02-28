import * as assert from 'assert';
import {
  forceRunToCursorImpl,
  maybeRestoreOnAdapterEvent,
  cancelAllPendingRestores,
  cacheExceptionFilters,
  ExceptionFilterState,
  SessionLike,
} from '../src/extension';

/** Fake breakpoint for testing (mirrors vscode.Breakpoint shape). */
function fakeBp(id: string) {
  return { id } as any;
}

/** Creates a mock RestoreDeps that tracks add/remove calls. */
function makeRestoreDeps(currentBreakpoints: any[] = []) {
  const added: any[] = [];
  const removed: any[] = [];
  const deps = {
    debug: {
      breakpoints: currentBreakpoints,
      addBreakpoints: (b: readonly any[]) => { added.push(...b); },
      removeBreakpoints: (b: readonly any[]) => { removed.push(...b); },
    },
  };
  return { deps, added, removed };
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

suite('Force Run to Cursor - unit tests', () => {
  test('no active session -> shows message and does not run debug commands', async () => {
    const { deps, calls, messages } = makeForceDeps();
    const restoreMap = new Map<string, readonly any[]>();

    await forceRunToCursorImpl(undefined, deps, restoreMap);

    assert.strictEqual(calls.length, 0, 'Should not execute any debug commands without a session');
    assert.strictEqual(messages.length, 1, 'Should show exactly one info message');
    assert.ok(messages[0].toLowerCase().includes('start debugging'));
    assert.strictEqual(restoreMap.size, 0, 'Should not mark restore pending');
  });

  test('active session -> removes breakpoints then runs to cursor and saves them for restore', async () => {
    const bps = [fakeBp('bp-1'), fakeBp('bp-2')];
    const { deps, calls, removed } = makeForceDeps(bps);
    const restoreMap = new Map<string, readonly any[]>();

    await forceRunToCursorImpl({ id: 'sess-1' }, deps, restoreMap);

    assert.deepStrictEqual(removed, bps, 'Should remove all existing breakpoints');
    assert.deepStrictEqual(calls, ['editor.debug.action.runToCursor']);
    assert.deepStrictEqual(restoreMap.get('sess-1'), bps, 'Should save breakpoints for restoration');
  });

  test("restore happens on 'stopped' event and re-adds saved breakpoints", async () => {
    const bps = [fakeBp('bp-a'), fakeBp('bp-b')];
    const { deps, added } = makeRestoreDeps();
    const restoreMap = new Map<string, readonly any[]>([['sess-2', bps]]);

    const restored = await maybeRestoreOnAdapterEvent('sess-2', { type: 'event', event: 'stopped' }, deps, restoreMap);

    assert.strictEqual(restored, true);
    assert.deepStrictEqual(added, bps, 'Should re-add the saved breakpoints');
    assert.ok(!restoreMap.has('sess-2'), 'Should clear pending restore');
  });

  test('restore cleans up orphaned temp breakpoints before re-adding saved ones', async () => {
    const savedBps = [fakeBp('bp-orig')];
    const tempBp = fakeBp('temp-bp');
    const { deps, added, removed } = makeRestoreDeps([tempBp]);
    const restoreMap = new Map<string, readonly any[]>([['sess-orphan', savedBps]]);

    await maybeRestoreOnAdapterEvent('sess-orphan', { type: 'event', event: 'stopped' }, deps, restoreMap);

    assert.deepStrictEqual(removed, [tempBp], 'Should remove orphaned temp breakpoint');
    assert.deepStrictEqual(added, savedBps, 'Should re-add only the saved breakpoints');
  });

  test('no restore on non-stopped events (terminated, exited, output)', async () => {
    for (const event of ['terminated', 'exited', 'output']) {
      const { deps, added } = makeRestoreDeps();
      const restoreMap = new Map<string, readonly any[]>([['sess', [fakeBp('bp')]]]);

      const restored = await maybeRestoreOnAdapterEvent('sess', { type: 'event', event }, deps, restoreMap);

      assert.strictEqual(restored, false, `Should not restore on '${event}'`);
      assert.strictEqual(added.length, 0, `Should not add breakpoints on '${event}'`);
      assert.ok(restoreMap.has('sess'), `Should keep pending restore on '${event}'`);
    }
  });

  test('no restore for an untracked session (normal debugging unaffected)', async () => {
    const { deps, added } = makeRestoreDeps();
    const restoreMap = new Map<string, readonly any[]>();

    const restored = await maybeRestoreOnAdapterEvent('sess-normal', { type: 'event', event: 'stopped' }, deps, restoreMap);

    assert.strictEqual(restored, false);
    assert.strictEqual(added.length, 0, 'Should not touch breakpoints during normal debugging');
  });

  test('rapid repeated calls do not overwrite saved breakpoints', async () => {
    const originalBps = [fakeBp('bp-orig-1'), fakeBp('bp-orig-2')];
    const { deps, calls } = makeForceDeps(originalBps);
    const restoreMap = new Map<string, readonly any[]>();
    const session = { id: 'sess-rapid' };

    await forceRunToCursorImpl(session, deps, restoreMap);
    deps.debug.breakpoints = [];
    await forceRunToCursorImpl(session, deps, restoreMap);

    assert.deepStrictEqual(restoreMap.get('sess-rapid'), originalBps, 'Saved breakpoints must not be overwritten');
    assert.strictEqual(calls.filter(c => c === 'editor.debug.action.runToCursor').length, 1);
  });

  test('double stop only restores once (idempotent)', async () => {
    const bps = [fakeBp('bp-dup')];
    const { deps, added } = makeRestoreDeps();
    const restoreMap = new Map<string, readonly any[]>([['sess-dup', bps]]);

    await maybeRestoreOnAdapterEvent('sess-dup', { type: 'event', event: 'stopped' }, deps, restoreMap);
    await maybeRestoreOnAdapterEvent('sess-dup', { type: 'event', event: 'stopped' }, deps, restoreMap);

    assert.deepStrictEqual(added, bps, 'Should add breakpoints exactly once');
  });

  test('cancelAllPendingRestores restores breakpoints from all sessions and clears state', async () => {
    const bps1 = [fakeBp('bp-c1'), fakeBp('bp-c2')];
    const bps2 = [fakeBp('bp-c3')];

    const restoreMap = new Map<string, readonly any[]>([
      ['sess-cancel-1', bps1],
      ['sess-cancel-2', bps2],
    ]);

    const { deps, added } = makeRestoreDeps();

    await cancelAllPendingRestores(deps, restoreMap);

    assert.strictEqual(restoreMap.size, 0, 'Should clear all pending restores');
    assert.deepStrictEqual(added, [...bps1, ...bps2], 'Should restore breakpoints from all sessions');
  });

  test('cancelAllPendingRestores is a no-op when nothing is pending', async () => {
    const restoreMap = new Map<string, readonly any[]>();
    const { deps, added, removed } = makeRestoreDeps();

    await cancelAllPendingRestores(deps, restoreMap);

    assert.strictEqual(restoreMap.size, 0, 'Map should remain empty');
    assert.strictEqual(added.length, 0, 'Should not add any breakpoints');
    assert.strictEqual(removed.length, 0, 'Should not remove any breakpoints');
  });
});

// --- Exception breakpoint suppression & auto-continue tests ---

/** Creates a mock SessionLike that records customRequest calls. */
function fakeSession(id: string) {
  const customRequests: { command: string; args: any }[] = [];
  const session: SessionLike = {
    id,
    customRequest: async (command: string, args?: any) => {
      customRequests.push({ command, args });
    },
  };
  return { session, customRequests };
}

suite('Exception breakpoint caching', () => {
  test('caches setExceptionBreakpoints request args (filters + filterOptions)', () => {
    const cache = new Map<string, ExceptionFilterState>();
    const restoreMap = new Map<string, readonly any[]>();

    cacheExceptionFilters('sess-1', {
      type: 'request',
      command: 'setExceptionBreakpoints',
      arguments: {
        filters: ['uncaught', 'caught'],
        filterOptions: [{ filterId: 'uncaught', label: 'Uncaught' }],
      },
    }, restoreMap, cache);

    assert.ok(cache.has('sess-1'), 'Should cache the session');
    const cached = cache.get('sess-1')!;
    assert.deepStrictEqual(cached.filters, ['uncaught', 'caught']);
    assert.deepStrictEqual(cached.filterOptions, [{ filterId: 'uncaught', label: 'Uncaught' }]);
  });

  test('ignores non-setExceptionBreakpoints messages', () => {
    const cache = new Map<string, ExceptionFilterState>();
    const restoreMap = new Map<string, readonly any[]>();

    cacheExceptionFilters('sess-1', {
      type: 'request',
      command: 'setBreakpoints',
      arguments: { breakpoints: [] },
    }, restoreMap, cache);

    assert.strictEqual(cache.size, 0, 'Should not cache non-exception breakpoint requests');
  });

  test('skips caching when force-run active (restoreMap.has)', () => {
    const cache = new Map<string, ExceptionFilterState>();
    const restoreMap = new Map<string, readonly any[]>([['sess-1', []]]);

    cacheExceptionFilters('sess-1', {
      type: 'request',
      command: 'setExceptionBreakpoints',
      arguments: { filters: ['uncaught'] },
    }, restoreMap, cache);

    assert.strictEqual(cache.size, 0, 'Should skip caching during active force-run');
  });

  test('overwrites old cache on new request', () => {
    const cache = new Map<string, ExceptionFilterState>();
    const restoreMap = new Map<string, readonly any[]>();

    cacheExceptionFilters('sess-1', {
      type: 'request',
      command: 'setExceptionBreakpoints',
      arguments: { filters: ['uncaught'] },
    }, restoreMap, cache);

    cacheExceptionFilters('sess-1', {
      type: 'request',
      command: 'setExceptionBreakpoints',
      arguments: { filters: ['caught'] },
    }, restoreMap, cache);

    assert.deepStrictEqual(cache.get('sess-1')!.filters, ['caught'], 'Should overwrite with latest');
  });
});

suite('Exception breakpoint suppression', () => {
  test('forceRunToCursorImpl calls setExceptionBreakpoints({ filters: [] }) when cache exists', async () => {
    const { session, customRequests } = fakeSession('sess-exc');
    const { deps } = makeForceDeps([fakeBp('bp-1')]);
    const restoreMap = new Map<string, readonly any[]>();
    const exceptionCache = new Map<string, ExceptionFilterState>([
      ['sess-exc', { filters: ['uncaught'] }],
    ]);
    const sessionRefMap = new Map<string, SessionLike>();

    await forceRunToCursorImpl(session, deps, restoreMap, exceptionCache, sessionRefMap);

    assert.strictEqual(customRequests.length, 1);
    assert.strictEqual(customRequests[0].command, 'setExceptionBreakpoints');
    assert.deepStrictEqual(customRequests[0].args, { filters: [] });
    assert.ok(sessionRefMap.has('sess-exc'), 'Should store session ref');
  });

  test('forceRunToCursorImpl works without customRequest (backward compat)', async () => {
    const { deps, calls } = makeForceDeps([fakeBp('bp-1')]);
    const restoreMap = new Map<string, readonly any[]>();
    const exceptionCache = new Map<string, ExceptionFilterState>([
      ['sess-no-cr', { filters: ['uncaught'] }],
    ]);
    const sessionRefMap = new Map<string, SessionLike>();

    await forceRunToCursorImpl({ id: 'sess-no-cr' }, deps, restoreMap, exceptionCache, sessionRefMap);

    assert.deepStrictEqual(calls, ['editor.debug.action.runToCursor']);
    assert.ok(restoreMap.has('sess-no-cr'));
    assert.strictEqual(sessionRefMap.size, 0, 'Should not store session ref without customRequest');
  });
});

suite('Exception breakpoint restoration', () => {
  test('maybeRestoreOnAdapterEvent restores exception filters on normal stop', async () => {
    const bps = [fakeBp('bp-r1')];
    const { deps, added } = makeRestoreDeps();
    const { session, customRequests } = fakeSession('sess-r1');

    const restoreMap = new Map<string, readonly any[]>([['sess-r1', bps]]);
    const exceptionCache = new Map<string, ExceptionFilterState>([
      ['sess-r1', { filters: ['uncaught', 'caught'] }],
    ]);
    const continueCount = new Map<string, number>();

    const restored = await maybeRestoreOnAdapterEvent(
      'sess-r1',
      { type: 'event', event: 'stopped', body: { reason: 'breakpoint' } },
      deps, restoreMap, session, exceptionCache, continueCount,
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

    const restoreMap = new Map<string, readonly any[]>([['sess-r2', bps]]);
    const exceptionCache = new Map<string, ExceptionFilterState>(); // empty
    const continueCount = new Map<string, number>();

    const restored = await maybeRestoreOnAdapterEvent(
      'sess-r2',
      { type: 'event', event: 'stopped', body: { reason: 'breakpoint' } },
      deps, restoreMap, session, exceptionCache, continueCount,
    );

    assert.strictEqual(restored, true);
    assert.deepStrictEqual(added, bps, 'Should still restore breakpoints');
    assert.strictEqual(customRequests.length, 0, 'Should not call customRequest without cache');
  });

  test('skips exception restoration when no session ref', async () => {
    const bps = [fakeBp('bp-r3')];
    const { deps, added } = makeRestoreDeps();

    const restoreMap = new Map<string, readonly any[]>([['sess-r3', bps]]);
    const exceptionCache = new Map<string, ExceptionFilterState>([
      ['sess-r3', { filters: ['uncaught'] }],
    ]);
    const continueCount = new Map<string, number>();

    const restored = await maybeRestoreOnAdapterEvent(
      'sess-r3',
      { type: 'event', event: 'stopped', body: { reason: 'breakpoint' } },
      deps, restoreMap, undefined, exceptionCache, continueCount,
    );

    assert.strictEqual(restored, true);
    assert.deepStrictEqual(added, bps, 'Should still restore breakpoints');
  });

  test('cancelAllPendingRestores restores exception filters for all sessions', async () => {
    const bps = [fakeBp('bp-c')];
    const { deps, added } = makeRestoreDeps();
    const { session: sess1, customRequests: cr1 } = fakeSession('sess-c1');
    const { session: sess2, customRequests: cr2 } = fakeSession('sess-c2');

    const restoreMap = new Map<string, readonly any[]>([
      ['sess-c1', bps],
      ['sess-c2', bps],
    ]);
    const sessionRefMap = new Map<string, SessionLike>([
      ['sess-c1', sess1],
      ['sess-c2', sess2],
    ]);
    const exceptionCache = new Map<string, ExceptionFilterState>([
      ['sess-c1', { filters: ['uncaught'] }],
      ['sess-c2', { filters: ['caught'] }],
    ]);
    const continueCount = new Map<string, number>([['sess-c1', 1]]);

    await cancelAllPendingRestores(deps, restoreMap, sessionRefMap, exceptionCache, continueCount);

    assert.strictEqual(restoreMap.size, 0, 'Should clear restoreMap');
    assert.strictEqual(sessionRefMap.size, 0, 'Should clear sessionRefMap');
    assert.strictEqual(continueCount.size, 0, 'Should clear continueCount');
    assert.strictEqual(cr1.length, 1, 'Should restore exception filters for session 1');
    assert.deepStrictEqual(cr1[0].args, { filters: ['uncaught'] });
    assert.strictEqual(cr2.length, 1, 'Should restore exception filters for session 2');
    assert.deepStrictEqual(cr2[0].args, { filters: ['caught'] });
  });
});

suite('Exception auto-continue (defense-in-depth)', () => {
  test('exception stop during force-run → auto-continue, returns false', async () => {
    const bps = [fakeBp('bp-ac1')];
    const { deps, added } = makeRestoreDeps();
    const { session, customRequests } = fakeSession('sess-ac1');

    const restoreMap = new Map<string, readonly any[]>([['sess-ac1', bps]]);
    const exceptionCache = new Map<string, ExceptionFilterState>();
    const continueCount = new Map<string, number>();

    const restored = await maybeRestoreOnAdapterEvent(
      'sess-ac1',
      { type: 'event', event: 'stopped', body: { reason: 'exception', threadId: 42 } },
      deps, restoreMap, session, exceptionCache, continueCount,
    );

    assert.strictEqual(restored, false, 'Should NOT restore on exception stop (auto-continue)');
    assert.strictEqual(added.length, 0, 'Should not add breakpoints');
    assert.ok(restoreMap.has('sess-ac1'), 'Should keep force-run active');
    assert.strictEqual(customRequests.length, 1, 'Should call continue');
    assert.strictEqual(customRequests[0].command, 'continue');
    assert.deepStrictEqual(customRequests[0].args, { threadId: 42 });
    assert.strictEqual(continueCount.get('sess-ac1'), 1, 'Should increment counter');
  });

  test('non-exception stop during force-run → normal restore, returns true', async () => {
    const bps = [fakeBp('bp-ac2')];
    const { deps, added } = makeRestoreDeps();
    const { session, customRequests } = fakeSession('sess-ac2');

    const restoreMap = new Map<string, readonly any[]>([['sess-ac2', bps]]);
    const exceptionCache = new Map<string, ExceptionFilterState>();
    const continueCount = new Map<string, number>();

    const restored = await maybeRestoreOnAdapterEvent(
      'sess-ac2',
      { type: 'event', event: 'stopped', body: { reason: 'breakpoint' } },
      deps, restoreMap, session, exceptionCache, continueCount,
    );

    assert.strictEqual(restored, true, 'Should restore on non-exception stop');
    assert.deepStrictEqual(added, bps, 'Should restore breakpoints');
    assert.ok(!restoreMap.has('sess-ac2'), 'Should clear pending restore');
    assert.strictEqual(customRequests.length, 0, 'Should not call continue for non-exception');
  });

  test('exception stop with counter at max → falls through to normal restore', async () => {
    const bps = [fakeBp('bp-ac3')];
    const { deps, added } = makeRestoreDeps();
    const { session, customRequests } = fakeSession('sess-ac3');

    const restoreMap = new Map<string, readonly any[]>([['sess-ac3', bps]]);
    const exceptionCache = new Map<string, ExceptionFilterState>();
    const continueCount = new Map<string, number>([['sess-ac3', 3]]); // at max

    const restored = await maybeRestoreOnAdapterEvent(
      'sess-ac3',
      { type: 'event', event: 'stopped', body: { reason: 'exception', threadId: 7 } },
      deps, restoreMap, session, exceptionCache, continueCount,
    );

    assert.strictEqual(restored, true, 'Should fall through to restore when counter at max');
    assert.deepStrictEqual(added, bps, 'Should restore breakpoints');
    assert.ok(!restoreMap.has('sess-ac3'), 'Should clear pending restore');
    assert.strictEqual(customRequests.length, 0, 'Should not auto-continue when counter exceeded');
  });

  test('counter resets on successful restore', async () => {
    const bps = [fakeBp('bp-ac4')];
    const { deps } = makeRestoreDeps();
    const { session } = fakeSession('sess-ac4');

    const restoreMap = new Map<string, readonly any[]>([['sess-ac4', bps]]);
    const exceptionCache = new Map<string, ExceptionFilterState>();
    const continueCount = new Map<string, number>([['sess-ac4', 2]]);

    await maybeRestoreOnAdapterEvent(
      'sess-ac4',
      { type: 'event', event: 'stopped', body: { reason: 'step' } },
      deps, restoreMap, session, exceptionCache, continueCount,
    );

    assert.ok(!continueCount.has('sess-ac4'), 'Counter should be cleared after restore');
  });
});
