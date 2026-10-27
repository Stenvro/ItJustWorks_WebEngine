import { describe, expect, it } from 'vitest';
import type { RecordDatabase } from '../../../world/record-db.ts';
import type { NativeCall } from '../../papyrus-vm.ts';
import { ScriptLibrary } from '../../script-library.ts';
import type { Value } from '../../values.ts';
import { ScriptRuntime, type WorldBridge } from '../runtime.ts';

/** A runtime without plugins, its world the given hooks. */
function runtime(world: WorldBridge): ScriptRuntime {
  const db = {
    plugins: [],
    get: () => Promise.resolve(undefined),
    worldOfCell: () => undefined,
    cellOfReference: () => undefined,
    formIdsOfType: () => [],
  } as unknown as RecordDatabase;
  return new ScriptRuntime(db, new ScriptLibrary(() => Promise.resolve(undefined)), { world });
}

/** Calls a Game native with arguments. */
async function call(scripts: ScriptRuntime, name: string, args: Value[] = []): Promise<Value> {
  const native = scripts.native('game', name);
  if (!native) throw new Error(`no native game.${name}`);
  return native({
    vm: scripts.vm,
    self: null,
    args,
    name: `game.${name}`,
  } as unknown as NativeCall);
}

describe('Game natives that ask the shell', () => {
  it('queues a save and an autosave with the save manager (RequestSave, RequestAutoSave)', async () => {
    const asked: string[] = [];
    const scripts = runtime({ requestSave: (kind) => asked.push(kind) });
    await call(scripts, 'requestsave');
    await call(scripts, 'requestautosave');
    expect(asked).toEqual(['save', 'autosave']);
  });

  it('rumbles the gamepad with strengths kept within 0 and 1 (ShakeController)', async () => {
    const shaken: number[][] = [];
    const scripts = runtime({
      shakeController: (small, big, seconds) => shaken.push([small, big, seconds]),
    });
    await call(scripts, 'shakecontroller', [0.5, 1.5, 2]);
    await call(scripts, 'shakecontroller', [-1, 0.25, -3]);
    expect(shaken).toEqual([
      [0.5, 1, 2],
      [0, 0.25, 0],
    ]);
  });
});
