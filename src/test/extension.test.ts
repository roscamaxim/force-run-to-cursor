import * as assert from 'assert';
import { forceRunToCursorImpl, maybeRestoreOnAdapterEvent } from '../extension';

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
    };

    const restoreSet = new Set<string>();

    await forceRunToCursorImpl(undefined, deps, restoreSet);

    assert.strictEqual(calls.length, 0, 'Should not execute any debug commands without a session');
    assert.strictEqual(messages.length, 1, 'Should show exactly one info message');
    assert.ok(
      messages[0].toLowerCase().includes('start debugging'),
      'Message should guide the user to start debugging',
    );
    assert.strictEqual(restoreSet.size, 0, 'Should not mark restore pending');
  });

  test('active session -> disables breakpoints then runs to cursor and marks restore pending', async () => {
    const calls: string[] = [];

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
    };

    const restoreSet = new Set<string>();
    const session = { id: 'sess-1' };

    await forceRunToCursorImpl(session, deps, restoreSet);

    assert.deepStrictEqual(
      calls,
      ['workbench.debug.viewlet.action.disableAllBreakpoints', 'editor.debug.action.runToCursor'],
      'Should disable all breakpoints before running to cursor',
    );
    assert.ok(restoreSet.has('sess-1'), 'Should mark session as pending restore');
  });

  test("restore happens on 'stopped' event and enables all breakpoints", async () => {
    const calls: string[] = [];
    const deps = {
      commands: {
        executeCommand: async (cmd: string) => {
          calls.push(cmd);
        },
      },
    };

    const restoreSet = new Set<string>(['sess-2']);

    const restored = await maybeRestoreOnAdapterEvent(
      'sess-2',
      { type: 'event', event: 'stopped' },
      deps,
      restoreSet,
    );

    assert.strictEqual(restored, true, 'Should report that it restored');
    assert.deepStrictEqual(calls, ['workbench.debug.viewlet.action.enableAllBreakpoints']);
    assert.ok(!restoreSet.has('sess-2'), 'Should clear pending restore after restoring');
  });

  test("restore happens on 'terminated' event", async () => {
    const calls: string[] = [];
    const deps = {
      commands: {
        executeCommand: async (cmd: string) => {
          calls.push(cmd);
        },
      },
    };

    const restoreSet = new Set<string>(['sess-3']);

    const restored = await maybeRestoreOnAdapterEvent(
      'sess-3',
      { type: 'event', event: 'terminated' },
      deps,
      restoreSet,
    );

    assert.strictEqual(restored, true, 'Should restore on terminated');
    assert.deepStrictEqual(calls, ['workbench.debug.viewlet.action.enableAllBreakpoints']);
    assert.ok(!restoreSet.has('sess-3'), 'Should clear pending restore after restoring');
  });

  test('no restore on unrelated event', async () => {
    const calls: string[] = [];
    const deps = {
      commands: {
        executeCommand: async (cmd: string) => {
          calls.push(cmd);
        },
      },
    };

    const restoreSet = new Set<string>(['sess-4']);

    const restored = await maybeRestoreOnAdapterEvent(
      'sess-4',
      { type: 'event', event: 'output' }, // not stopped/terminated/exited
      deps,
      restoreSet,
    );

    assert.strictEqual(restored, false, 'Should not restore on unrelated events');
    assert.strictEqual(calls.length, 0, 'Should not enable breakpoints on unrelated events');
    assert.ok(
      restoreSet.has('sess-4'),
      'Should keep pending restore if no stop-like event occurred',
    );
  });
});
