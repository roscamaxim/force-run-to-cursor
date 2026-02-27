import * as assert from 'assert';
import { forceRunToCursorImpl, maybeRestoreOnAdapterEvent } from '../extension';

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
      addBreakpoints: (b: readonly any[]) => {
        added.push(...b);
      },
      removeBreakpoints: (b: readonly any[]) => {
        removed.push(...b);
      },
    },
  };
  return { deps, added, removed };
}

suite('Force Run to Cursor - unit tests', () => {
  test('no active session -> shows message and does not run debug commands', async () => {
    const calls: string[] = [];
    const messages: string[] = [];

    const deps = {
      commands: {
        executeCommand: async (cmd: string) => {
          calls.push(cmd);
        },
      },
      window: {
        showInformationMessage: async (msg: string) => {
          messages.push(msg);
        },
      },
      debug: {
        breakpoints: [] as any[],
        removeBreakpoints: () => {},
      },
    };

    const restoreMap = new Map<string, readonly any[]>();

    await forceRunToCursorImpl(undefined, deps, restoreMap);

    assert.strictEqual(calls.length, 0, 'Should not execute any debug commands without a session');
    assert.strictEqual(messages.length, 1, 'Should show exactly one info message');
    assert.ok(
      messages[0].toLowerCase().includes('start debugging'),
      'Message should guide the user to start debugging',
    );
    assert.strictEqual(restoreMap.size, 0, 'Should not mark restore pending');
  });

  test('active session -> removes breakpoints then runs to cursor and saves them for restore', async () => {
    const calls: string[] = [];
    const removed: any[] = [];
    const bps = [fakeBp('bp-1'), fakeBp('bp-2')];

    const deps = {
      commands: {
        executeCommand: async (cmd: string) => {
          calls.push(cmd);
        },
      },
      window: {
        showInformationMessage: async (_msg: string) => {
          throw new Error('Should not show message when session exists');
        },
      },
      debug: {
        breakpoints: bps,
        removeBreakpoints: (b: readonly any[]) => {
          removed.push(...b);
        },
      },
    };

    const restoreMap = new Map<string, readonly any[]>();
    const session = { id: 'sess-1' };

    await forceRunToCursorImpl(session, deps, restoreMap);

    assert.deepStrictEqual(removed, bps, 'Should remove all existing breakpoints');
    assert.deepStrictEqual(
      calls,
      ['editor.debug.action.runToCursor'],
      'Should run to cursor after removing breakpoints',
    );
    assert.ok(restoreMap.has('sess-1'), 'Should mark session as pending restore');
    assert.deepStrictEqual(
      restoreMap.get('sess-1'),
      bps,
      'Should save removed breakpoints for later restoration',
    );
  });

  test("restore happens on 'stopped' event and re-adds saved breakpoints", async () => {
    const bps = [fakeBp('bp-a'), fakeBp('bp-b')];
    const { deps, added } = makeRestoreDeps();

    const restoreMap = new Map<string, readonly any[]>([['sess-2', bps]]);

    const restored = await maybeRestoreOnAdapterEvent(
      'sess-2',
      { type: 'event', event: 'stopped' },
      deps,
      restoreMap,
    );

    assert.strictEqual(restored, true, 'Should report that it restored');
    assert.deepStrictEqual(added, bps, 'Should re-add the saved breakpoints');
    assert.ok(!restoreMap.has('sess-2'), 'Should clear pending restore after restoring');
  });

  test('restore cleans up orphaned temp breakpoints before re-adding saved ones', async () => {
    const savedBps = [fakeBp('bp-orig')];
    const tempBp = fakeBp('temp-bp-from-runToCursor');
    const { deps, added, removed } = makeRestoreDeps([tempBp]);

    const restoreMap = new Map<string, readonly any[]>([['sess-orphan', savedBps]]);

    await maybeRestoreOnAdapterEvent(
      'sess-orphan',
      { type: 'event', event: 'stopped' },
      deps,
      restoreMap,
    );

    assert.deepStrictEqual(removed, [tempBp], 'Should remove orphaned temp breakpoint');
    assert.deepStrictEqual(added, savedBps, 'Should re-add only the saved breakpoints');
  });

  test("no restore on 'terminated' event (deferred to onDidTerminateDebugSession)", async () => {
    const { deps, added } = makeRestoreDeps();

    const restoreMap = new Map<string, readonly any[]>([['sess-3', [fakeBp('bp-x')]]]);

    const restored = await maybeRestoreOnAdapterEvent(
      'sess-3',
      { type: 'event', event: 'terminated' },
      deps,
      restoreMap,
    );

    assert.strictEqual(restored, false, 'Should NOT restore on terminated (handled by safety net)');
    assert.strictEqual(added.length, 0, 'Should not add breakpoints on terminated');
    assert.ok(restoreMap.has('sess-3'), 'Should keep pending restore for safety net to handle');
  });

  test("no restore on 'exited' event (deferred to onDidTerminateDebugSession)", async () => {
    const { deps, added } = makeRestoreDeps();

    const restoreMap = new Map<string, readonly any[]>([['sess-exit', [fakeBp('bp-y')]]]);

    const restored = await maybeRestoreOnAdapterEvent(
      'sess-exit',
      { type: 'event', event: 'exited' },
      deps,
      restoreMap,
    );

    assert.strictEqual(restored, false, 'Should NOT restore on exited (handled by safety net)');
    assert.strictEqual(added.length, 0, 'Should not add breakpoints on exited');
    assert.ok(restoreMap.has('sess-exit'), 'Should keep pending restore for safety net to handle');
  });

  test('no restore on unrelated event', async () => {
    const { deps, added } = makeRestoreDeps();

    const restoreMap = new Map<string, readonly any[]>([['sess-4', [fakeBp('bp-z')]]]);

    const restored = await maybeRestoreOnAdapterEvent(
      'sess-4',
      { type: 'event', event: 'output' }, // not stopped
      deps,
      restoreMap,
    );

    assert.strictEqual(restored, false, 'Should not restore on unrelated events');
    assert.strictEqual(added.length, 0, 'Should not add breakpoints on unrelated events');
    assert.ok(
      restoreMap.has('sess-4'),
      'Should keep pending restore if no stop event occurred',
    );
  });

  test('no restore for an untracked session (normal debugging unaffected)', async () => {
    const { deps, added } = makeRestoreDeps();

    const restoreMap = new Map<string, readonly any[]>(); // empty — no Force Run was used

    const restored = await maybeRestoreOnAdapterEvent(
      'sess-normal',
      { type: 'event', event: 'stopped' },
      deps,
      restoreMap,
    );

    assert.strictEqual(restored, false, 'Should not restore for sessions that never used Force Run');
    assert.strictEqual(added.length, 0, 'Should not touch breakpoints during normal debugging');
  });

  test('rapid repeated calls do not overwrite saved breakpoints', async () => {
    const calls: string[] = [];
    const removed: any[] = [];
    const originalBps = [fakeBp('bp-orig-1'), fakeBp('bp-orig-2')];

    const deps = {
      commands: {
        executeCommand: async (cmd: string) => {
          calls.push(cmd);
        },
      },
      window: {
        showInformationMessage: async (_msg: string) => {},
      },
      debug: {
        breakpoints: originalBps,
        removeBreakpoints: (b: readonly any[]) => {
          removed.push(...b);
        },
      },
    };

    const restoreMap = new Map<string, readonly any[]>();
    const session = { id: 'sess-rapid' };

    // First call — saves and removes breakpoints
    await forceRunToCursorImpl(session, deps, restoreMap);

    // Simulate breakpoints now being empty (they were removed)
    deps.debug.breakpoints = [];

    // Second call — should be ignored because a force-run is already pending
    await forceRunToCursorImpl(session, deps, restoreMap);

    assert.deepStrictEqual(
      restoreMap.get('sess-rapid'),
      originalBps,
      'Saved breakpoints must not be overwritten by a second call',
    );
    assert.strictEqual(
      calls.filter(c => c === 'editor.debug.action.runToCursor').length,
      1,
      'Should only run to cursor once',
    );
  });

  test('double stop only restores once (idempotent)', async () => {
    const bps = [fakeBp('bp-dup')];
    const { deps, added } = makeRestoreDeps();

    const restoreMap = new Map<string, readonly any[]>([['sess-dup', bps]]);

    await maybeRestoreOnAdapterEvent('sess-dup', { type: 'event', event: 'stopped' }, deps, restoreMap);
    await maybeRestoreOnAdapterEvent('sess-dup', { type: 'event', event: 'stopped' }, deps, restoreMap);

    assert.strictEqual(added.length, 1, 'Should add breakpoints exactly once despite duplicate stops');
    assert.deepStrictEqual(added, bps);
  });
});
