// Conformance: triggers (engine map: Physics > Triggers). What enters a trigger volume and what it
// is told: OnTriggerEnter (597 vanilla scripts), OnTriggerLeave (123), OnTrigger (38). Skipped
// without game data.
//
// Sources:
// - The engine's rule, observed in the original (src/scripting/runtime/trigger-volumes.ts): a volume tells
//   each reference inside it as it finds it there and again once [Havok] fTriggerEventDelayMS
//   (500 ms) has passed since it last told any; entering and leaving are told apart
//   (TESTriggerEnterEvent, TESTriggerLeaveEvent).
// - The collision layers (COLL records): which layers L_TRIGGER collides with: what can be in a
//   trigger volume (its phantom reports what its layer collides with).
// - The data: a trigger is an activator placed with a primitive (REFR XPRM, its volume on
//   L_TRIGGER: src/world/cell-loader.ts).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Layer,
  readCollisionMatrix,
  type CollisionMatrix,
} from '../../../src/physics/collision-layers.ts';
import {
  TRIGGER_EVENT_DELAY_MS,
  TriggerVolumes,
} from '../../../src/scripting/runtime/trigger-volumes.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { scriptEventUsage } from '../../../tools/script-event-usage.ts';
import { hasGamedata } from '../../helpers/sim.ts';

describe('trigger volumes (the engine’s rule)', () => {
  it('tells everyone inside once fTriggerEventDelayMS (500 ms) has passed, again and again', () => {
    const volumes = new TriggerVolumes();
    const told: string[] = [];
    volumes.enter(1, 20);
    volumes.enter(1, 21);
    for (let step = 0; step < 4; step++) {
      volumes.update(0.3, (trigger, reference) =>
        told.push(`${String(trigger)}:${String(reference)}`),
      );
    }
    // At once (never told yet), then after 600 ms (the delay passed at the third step).
    expect(told).toEqual(['1:20', '1:21', '1:20', '1:21']);
    expect(TRIGGER_EVENT_DELAY_MS).toBe(500);
  });

  it('stops telling one that left', () => {
    const volumes = new TriggerVolumes();
    const told: number[] = [];
    volumes.enter(1, 20);
    volumes.leave(1, 20);
    volumes.update(1, (_, reference) => told.push(reference));
    expect(told).toEqual([]);
  });
});

describe.skipIf(!hasGamedata())('what can be in a trigger (data)', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let matrix: CollisionMatrix;
  let handlers: ReadonlyMap<string, readonly string[]>;
  let triggers = 0;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    matrix = await readCollisionMatrix(db);
    handlers = (await scriptEventUsage(vfs)).handlers;
    const activators = new Set(db.formIdsOfType('ACTI'));
    await db.scan(
      ['REFR'],
      () => true,
      (record) => {
        const base = record.formIdField('NAME');
        if (
          !record.deleted &&
          base !== undefined &&
          activators.has(base) &&
          record.fields.has('XPRM')
        )
          triggers++;
      },
    );
  }, 300_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('counts the scripts that handle the trigger events (597, 123, 38)', () => {
    expect(handlers.get('ontriggerenter')?.length).toBe(597);
    expect(handlers.get('ontriggerleave')?.length).toBe(123);
    expect(handlers.get('ontrigger')?.length).toBe(38);
  });

  it('counts the 5,286 activators placed with a primitive (trigger volumes)', () => {
    expect(triggers).toBe(5286);
  });

  it('lets L_TRIGGER take in 14 layers (COLL): actors, clutter, weapons, projectiles, spells, …', () => {
    const takes = Object.entries(Layer)
      .filter(([, index]) => matrix.collides(Layer.trigger, index))
      .map(([name]) => name);
    expect(takes).toEqual([
      'unidentified',
      'clutter',
      'weapon',
      'projectile',
      'spell',
      'biped',
      'trap',
      'debrisLarge',
      'invisibleWall',
      'charController',
      'deadBip',
      'coneProjectile',
      'customPick1',
      'customPick2',
    ]);
  });
});

describe('what enters a trigger', () => {
  it.todo(
    'tells a trigger a clutter object thrown or pushed into it (L_CLUTTER collides with ' +
      'L_TRIGGER; TrapTriggerBase pressure plates)  [COLL] (sim)',
  );
  it.todo('tells a trigger an arrow or spell flying through it (L_PROJECTILE)  [COLL] (sim)');
  it.todo('tells a trigger a dead body in it (L_DEADBIP)  [COLL] (sim)');
  it.todo('tells a trigger a weapon dropped into it (L_WEAPON)  [COLL] (sim)');
  it.todo(
    'tells a trigger a spell’s or a flame’s projectile in it (L_SPELL, L_CONEPROJECTILE)  [COLL] (sim)',
  );
  it.todo(
    'tells a trigger a trap’s moving body in it (L_TRAP) and large debris (L_DEBRIS_LARGE)  [COLL] (sim)',
  );
  it.todo(
    'checks the layer matrix for every trigger: a layer that does not collide with the ' +
      'trigger’s is not told (the trigger’s own layer: XTRI)  [COLL] (sim)',
  );
  it.todo(
    'tells what was inside a trigger when it is enabled or its cell loads (OnTriggerEnter on ' +
      'what stands in it)  [original] (sim)',
  );
  it.todo('tells OnTriggerLeave as something inside is disabled or deleted  [original] (sim)');
});
