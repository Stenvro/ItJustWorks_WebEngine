// The magic kill camera's prediction on the local game data (docs/gameplay.md, "Killmoves"):
// a self spell's kill is predicted by the effects whose area reaches the actor (Fire Storm's
// three fire effects of areas 100, 65 and 25 feet: "more damage to closer targets").

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UNITS_PER_FOOT } from '../src/gameplay/magic/effect-rules.ts';
import { PLAYER_REF } from '../src/scripting/runtime/forms.ts';
import { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

/** SPEL FireStorm (Skyrim.esm): self, fire and forget, areas 100, 65 and 25 feet. */
const FIRE_STORM = 0x7a82b;

describe.skipIf(!hasGamedata())('the magic kill camera on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let runtime: ScriptRuntime;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    const library = new ScriptLibrary(async (name) => {
      const path = `scripts\\${name}.pex`;
      return vfs.has(path) ? vfs.read(path) : undefined;
    });
    runtime = new ScriptRuntime(db, library);
    await runtime.magic.prepare(PLAYER_REF);
  }, 120_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it("predicts a self spell's kill by the effects whose area reaches that far", async () => {
    const storm = await runtime.magic.item(FIRE_STORM);
    if (!storm) throw new Error('no Fire Storm');
    const at = (feet: number | undefined): Promise<number> =>
      runtime.casting.predictedDamage(
        PLAYER_REF,
        storm,
        PLAYER_REF,
        feet === undefined ? undefined : feet * UNITS_PER_FOOT,
      );
    const whole = await at(undefined);
    const close = await at(20);
    const middle = await at(50);
    const far = await at(90);
    const beyond = await at(120);
    expect(whole).toBeGreaterThan(0);
    // Within 25 feet all three (100 + 75 + 50), within 65 two, within 100 the widest alone.
    expect(close).toBeCloseTo(whole, 5);
    expect(middle / close).toBeCloseTo(175 / 225, 3);
    expect(far / close).toBeCloseTo(100 / 225, 3);
    expect(beyond).toBe(0);
  });
});
