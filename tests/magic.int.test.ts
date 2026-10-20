// Integration test: the magic system on the local game data (no new game, no world): potions,
// a spell, a worn enchantment, a disease and its cure, an ingredient on the player, and the
// player's racial ability. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAYER_REF } from '../src/scripting/runtime/forms.ts';
import { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
import { actorValueIndex } from '../src/world/actor-values.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const HEALTH = 24;
/** Skyrim.esm: RestoreHealth01, FortifyHealth01, FlamesRightHand, EnchRingTwoHanded05 (Ring of Extreme Sure Grip),
 * DiseaseRockjoint, CureDisease, Wheat. */
const MINOR_HEALING = 0x3eadd;
const FORTIFY_HEALTH = 0x3eaf2;
const FLAMES = 0xc969a;
const RING_TWO_HANDED = 0x100e50;
const ROCKJOINT = 0xb8782;
const CURE_DISEASE = 0xae723;
const WHEAT = 0x4b0ba;

describe.skipIf(!hasGamedata())('the magic system on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let runtime: ScriptRuntime;
  const value = async (name: string): Promise<number> =>
    (await runtime.actors.value(PLAYER_REF, actorValueIndex(name) ?? HEALTH)).current;
  const run = async (seconds: number): Promise<void> => {
    for (let t = 0; t < seconds; t += 0.1) {
      runtime.update(0.1, 0);
      await runtime.vm.idle();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  const use = async (item: number): Promise<void> => {
    await runtime.addItem(PLAYER_REF, runtime.formHandle(item), 1, true);
    expect(await runtime.magic.useItem(PLAYER_REF, item)).toBe('used');
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
  }, 120_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it("gives the player its race's abilities", async () => {
    expect(await value('FrostResist')).toBe(50);
  });

  it('heals with a potion and fortifies for its duration', async () => {
    await runtime.actors.damage(PLAYER_REF, HEALTH, 50);
    await use(MINOR_HEALING);
    expect(await value('Health')).toBe(75);
    await use(FORTIFY_HEALTH);
    expect(await value('Health')).toBe(95);
    await run(61);
    expect(await value('Health')).toBe(75);
    runtime.actors.restore(PLAYER_REF, HEALTH, 100);
  }, 120_000);

  it('burns with Flames each second of its duration', async () => {
    expect(await runtime.magic.cast(FLAMES, PLAYER_REF, PLAYER_REF)).toBe(true);
    await run(1.5);
    expect(await value('Health')).toBeCloseTo(92, 0);
    runtime.actors.restore(PLAYER_REF, HEALTH, 100);
  }, 60_000);

  it("fortifies with a worn ring's constant effect, until it is taken off", async () => {
    await runtime.equipment.equip(PLAYER_REF, RING_TWO_HANDED, { silent: true });
    await runtime.magic.syncLasting(PLAYER_REF);
    expect(await value('TwoHandedMod')).toBeGreaterThan(0);
    await runtime.equipment.unequip(PLAYER_REF, RING_TWO_HANDED);
    await runtime.magic.syncLasting(PLAYER_REF);
    expect(await value('TwoHandedMod')).toBe(0);
  });

  it('weakens with a disease that Cure Disease takes away', async () => {
    await runtime.actors.addSpell(PLAYER_REF, ROCKJOINT);
    await runtime.magic.syncLasting(PLAYER_REF);
    expect(await value('OneHandedMod')).toBe(-25);
    expect(runtime.magic.isSpellTarget(PLAYER_REF, ROCKJOINT)).toBe(true);
    await use(CURE_DISEASE);
    expect(await value('OneHandedMod')).toBe(0);
    expect(await runtime.actors.hasSpell(PLAYER_REF, ROCKJOINT)).toBe(false);
  });

  it("eats an ingredient's first effect and learns it", async () => {
    await runtime.actors.damage(PLAYER_REF, HEALTH, 20);
    await use(WHEAT);
    expect(await value('Health')).toBe(85);
    expect(runtime.state.ingredientEffects.get(WHEAT)?.has(0)).toBe(true);
    runtime.actors.restore(PLAYER_REF, HEALTH, 100);
  });
});
