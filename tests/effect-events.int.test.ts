// Integration test: an active magic effect's scripts hear it start and finish (OnEffectStart,
// OnEffectFinish: akTarget, akCaster; Creation Kit, ActiveMagicEffect Script), on the local
// game data with no world. Skipped without game data.
//
// From the data (Skyrim.esm): BladesPotion [000E6DF5] (ALCH) has one effect, BladesAlchPotion
// [000E6DF4] (MGEF with a script), for 1 s; the player drinks it, so the player is target and
// caster.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAYER_REF } from '../src/scripting/runtime/forms.ts';
import { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
import { ObjectHandle, type Value } from '../src/scripting/values.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const BLADES_POTION = 0xe6df5;
const DURATION = 1;

describe.skipIf(!hasGamedata())('an active magic effect’s start and finish', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let runtime: ScriptRuntime;
  const sent: { event: string; type: string; args: Value[]; at: number }[] = [];
  let clock = 0;
  const run = async (seconds: number): Promise<void> => {
    for (let t = 0; t < seconds; t += 0.1) {
      clock += 0.1;
      runtime.update(0.1, 0);
      await runtime.vm.idle();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    const library = new ScriptLibrary(async (name) => {
      const path = `scripts\\${name}.pex`;
      return vfs.has(path) ? vfs.read(path) : undefined;
    });
    runtime = new ScriptRuntime(db, library);
    await runtime.magic.prepare(PLAYER_REF);
    const send = runtime.vm.sendEvent.bind(runtime.vm);
    runtime.vm.sendEvent = (target: ObjectHandle, event: string, args: readonly Value[]) => {
      if (event === 'OnEffectStart' || event === 'OnEffectFinish')
        sent.push({ event, type: target.type, args: [...args], at: clock });
      return send(target, event, args);
    };
    await runtime.addItem(PLAYER_REF, runtime.formHandle(BLADES_POTION), 1, true);
    expect(await runtime.magic.useItem(PLAYER_REF, BLADES_POTION)).toBe('used');
    await run(DURATION + 1);
  }, 120_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  const player = (value: Value): boolean =>
    value instanceof ObjectHandle && value.formId === PLAYER_REF;

  it('sends OnEffectStart(the player, the player) to the effect’s scripts', () => {
    const start = sent.find((entry) => entry.event === 'OnEffectStart');
    expect(start?.type).toBe('activemagiceffect');
    expect(start?.args.map(player)).toEqual([true, true]);
  });

  it('sends OnEffectFinish(the player, the player) once, as its duration ends', () => {
    const finish = sent.filter((entry) => entry.event === 'OnEffectFinish');
    expect(finish).toHaveLength(1);
    expect(finish[0]?.args.map(player)).toEqual([true, true]);
    expect(finish[0]?.at).toBeGreaterThanOrEqual(DURATION - 0.05);
    expect(finish[0]?.at).toBeLessThanOrEqual(DURATION + 0.25);
  });
});
