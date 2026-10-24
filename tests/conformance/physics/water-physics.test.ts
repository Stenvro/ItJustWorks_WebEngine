// Conformance: water physics (engine map: Physics > Water physics). What water does to bodies:
// buoyancy, currents, damage, splashes. Skipped without game data where it needs it.
//
// Sources:
// - The data (every WATR of the load order): TNAM, its material (MATT); DATA, damage a second;
//   XNAM, the spell it casts on what is in it; NAM0 and NAM1, the water's linear and angular
//   velocity (its current); FNAM's flags (UESP "Skyrim Mod:Mod File Format/WATR"; xEdit's WATR).
// - The settings' built-in values (the engine's defaults): fBuoyancyMultBody 1,
//   fBuoyancyMultExtremity −0.3 (a ragdoll's trunk floats, its limbs sink), [HAVOK]
//   fDefaultWaterfallCurrentVelocity 6, fWaterKnockdownVelocity 10 (Skyrim.esm 5).
// - The engine's rule, observed in the original: TODO(M13): the buoyancy action (which bodies float, by
//   what density) is not read yet.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { hasGamedata } from '../../helpers/sim.ts';

/** What the water types of the load order carry that acts on bodies. */
interface WaterCensus {
  types: number;
  withMaterial: number;
  withDamage: number;
  withSpell: number;
  withCurrent: number;
}

describe.skipIf(!hasGamedata())('the water types of the load order (data)', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  const census: WaterCensus = {
    types: 0,
    withMaterial: 0,
    withDamage: 0,
    withSpell: 0,
    withCurrent: 0,
  };

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    for (const formId of db.formIdsOfType('WATR')) {
      const record = await db.get(formId);
      if (!record) continue;
      const fields = record.fields;
      census.types++;
      if ((fields.first('TNAM')?.length ?? 0) >= 4) census.withMaterial++;
      const damage = fields.first('DATA');
      if (damage && damage.length >= 2 && (damage[0] ?? 0) + (damage[1] ?? 0) > 0)
        census.withDamage++;
      const spell = fields.first('XNAM');
      if (spell?.some((byte) => byte !== 0) === true) census.withSpell++;
      const velocity = fields.first('NAM0');
      if (velocity && velocity.length >= 12) {
        const view = new DataView(velocity.buffer, velocity.byteOffset, velocity.byteLength);
        const speed = Math.hypot(
          view.getFloat32(0, true),
          view.getFloat32(4, true),
          view.getFloat32(8, true),
        );
        if (speed > 0) census.withCurrent++;
      }
    }
  }, 300_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('counts 58 water types: 35 with a current, 7 with a material, none that damages or casts', () => {
    expect(census).toEqual({
      types: 58,
      withMaterial: 7,
      withDamage: 0,
      withSpell: 0,
      withCurrent: 35,
    });
  });

  it.todo(
    'pushes what floats in a water with a current along its linear velocity (NAM0)  [data] (sim: a crate in a river)',
  );
  it.todo(
    'damages what stands in a water with damage (DATA) each second, and casts its spell (XNAM) ' +
      '(no vanilla water has either; a mod’s may)  [data] (sim)',
  );
  it.todo('sounds and splashes a water by its material (TNAM)  [data] (sim)');
});

describe('buoyancy', () => {
  it.todo(
    'floats a loose object dropped into water at the surface (a crate floats in a river)  [original] (sim)',
  );
  it.todo(
    'floats a ragdoll’s trunk (fBuoyancyMultBody 1) and sinks its limbs (fBuoyancyMultExtremity ' +
      '−0.3)  [settings; original]',
  );
  it.todo(
    'carries what floats over a waterfall at fDefaultWaterfallCurrentVelocity (6)  [settings; original]',
  );
});

describe('splashes', () => {
  it.todo(
    'splashes where a body or an actor enters water (its material’s impact data)  [data; original] (sim)',
  );
  it.todo('slows what enters water (water drag)  [original: unread]');
});
