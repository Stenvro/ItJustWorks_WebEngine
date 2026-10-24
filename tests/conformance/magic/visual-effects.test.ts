// Conformance: visual effects (engine map: Magic, effects, perks > Visual effects): the shaders,
// art and visuals magic effects put on what they reach.
//
// Sources:
// - The magic effects of the load order (MGEF DATA: hit and enchant shaders, casting, hit and
//   enchant art, hit and enchant visuals; xEdit, CommonLibSSE EffectSettingData), counted here.
// - The FX Persist flag (0x1000): the visuals last as long as the effect (Creation Kit "Magic
//   Effect").

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { EffectFlag, parseMagicEffect } from '../../../src/world/magic-effects.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { hasGamedata } from '../../helpers/sim.ts';

describe.skipIf(!hasGamedata())('the effects’ visuals across the load order (data)', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  const counts = {
    hitShader: 0,
    enchantShader: 0,
    castingArt: 0,
    hitArt: 0,
    enchantArt: 0,
    hitVisuals: 0,
    enchantVisuals: 0,
    imageSpace: 0,
    fxPersist: 0,
  };

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    for (const formId of db.formIdsOfType('MGEF')) {
      const record = await db.get(formId);
      if (!record || record.deleted) continue;
      const e = parseMagicEffect(record);
      if (e.hitShader !== undefined) counts.hitShader++;
      if (e.enchantShader !== undefined) counts.enchantShader++;
      if (e.castingArt !== undefined) counts.castingArt++;
      if (e.hitEffectArt !== undefined) counts.hitArt++;
      if (e.enchantArt !== undefined) counts.enchantArt++;
      if (e.hitVisuals !== undefined) counts.hitVisuals++;
      if (e.enchantVisuals !== undefined) counts.enchantVisuals++;
      if (e.imageSpaceModifier !== undefined) counts.imageSpace++;
      if ((e.flags & EffectFlag.fxPersist) !== 0) counts.fxPersist++;
    }
  }, 300_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('counts the visuals the 1,731 magic effects carry', () => {
    expect(counts.fxPersist).toBe(927);
    expect(counts).toMatchObject({
      hitShader: 765,
      enchantShader: 191,
      castingArt: 731,
      hitArt: 359,
      enchantArt: 21,
      imageSpace: 260,
    });
  });
});

describe('what the original shows that we do not yet', () => {
  it.todo('an effect’s hit shader and hit art on an object it reaches, not only on actors');
  it.todo('an enchanted item’s enchant shader and enchant art on it, in the world and in the hand');
  it.todo('an effect shader’s colour keys animated over their times (EFSH)');
  it.todo('an effect shader’s holes (NAM7), addon models and ambient sound');
  it.todo(
    'the hit and enchant visuals (RFCT): none read from the 1,731 effects (xEdit: DATA @120, @124)',
  );
  it.todo('Particle Animated’s frame runs in a membrane’s particles');
});
