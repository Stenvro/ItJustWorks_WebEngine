// Conformance: the reaction to a dead body (engine map: AI > Detection, reactions), in the
// headless simulation. An actor not in combat looks for the dead every fCheckDeadBodyTimer
// (20 s); it reacts to a body it sees (it walks to it and looks at it), and the story manager's
// Dead Body event is raised with that reaction, only when the body is within
// fDeadReactionDistance of it. A body it sees farther away is left as it is and reacted to once
// the actor comes that near. Skipped without game data.
//
// Sources:
// - The engine's rule (docs/scripting.md, the DEAD row: an NPC not in combat reacts to a dead
//   actor it detects, within fDeadReactionDistance (400), once per body).
// - Inferred (TODO(M13) in src/ai/detection.ts): fDeadReactionDistance's built-in value 400; no
//   plugin stores the setting.
// - Known to differ (it.fails): an actor's first reaction is lost while the senses still read
//   its package's record, so this actor raises the event but does not walk to the body.
// - The data (Skyrim.esm): DB09Noble1 [0005A92D] runs DefaultStayAtEditorLocation, whose
//   interrupt flags allow greeting corpses (PKDT 0x8); Brenuin [00013BA7] is the dead. Tamriel
//   2,-3 is open tundra west of Whiterun (its land rises no more than 424 units over the cell).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectionReach, readDetectionSettings, sightReach } from '../../../src/ai/detection.ts';
import { Layer } from '../../../src/physics/collision-layers.ts';
import { CELL_SIZE } from '../../../src/world/land.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

type Vec3 = [number, number, number];

const TAMRIEL = 0x3c;
const CELL: readonly [number, number] = [2, -3];
const OBSERVER = 0x5a92d;
const BRENUIN = 0x13ba7;
/** How far the body lies at first, and where the actor is put later (units). */
const FAR = 1000;
const NEAR = 250;
/** A human's eyes above its feet, a little low (a clear view from there is clear from its eyes). */
const EYES = 100;

interface Look {
  /** The actor's distance to the body as the look began, and the least while it went on. */
  from: number;
  least: number;
  /** The actor reacted to the body ('corpse'). */
  reacted: boolean;
  /** Dead Body events (DEAD) raised for it and the body. */
  told: number;
}

describe.skipIf(!hasGamedata())(
  'a dead body is reacted to within fDeadReactionDistance (headless simulation)',
  () => {
    let sim: Sim;
    let observer = 0;
    let dead = 0;
    let clear = false;
    let settings = readDetectionSettings();
    const far: Look = { from: NaN, least: Infinity, reacted: false, told: 0 };
    const near: Look = { from: NaN, least: Infinity, reacted: false, told: 0 };

    beforeAll(async () => {
      sim = await openSim({ hour: 10 });
      const land = await (await sim.world.session.worldspace(TAMRIEL)).land(CELL[0], CELL[1]);
      const x = (CELL[0] + 0.5) * CELL_SIZE;
      const y = (CELL[1] + 0.5) * CELL_SIZE;
      const middle = land ? land.heights[Math.floor(land.heights.length / 2)] : undefined;
      await sim.world.openExterior(TAMRIEL, {
        arrival: { position: [x, y, (middle ?? 0) + 10], heading: 0 },
      });
      await sim.step(2);
      settings = readDetectionSettings(await sim.world.session.settings());
      const physics = sim.world.play?.physics;
      if (!physics) throw new Error('no physics');
      const ground = (at: readonly [number, number]): number | undefined =>
        physics.raycast([at[0], at[1], 10_000], [0, 0, -1], 20_000, Layer.charController)?.point[2];

      observer = await sim.place(OBSERVER, PLAYER_REF);
      await sim.step(2);
      const feet = await sim.position(observer);
      if (!feet) throw new Error('the observer has no place');
      // A way 1000 units off with a clear view of the ground (the senses' line of sight).
      const eyes: Vec3 = [feet[0], feet[1], feet[2] + EYES];
      let lying: Vec3 | undefined;
      for (let step = 0; step < 16 && !lying; step++) {
        const angle = (step / 16) * 2 * Math.PI;
        const at: [number, number] = [
          feet[0] + Math.cos(angle) * FAR,
          feet[1] + Math.sin(angle) * FAR,
        ];
        const z = ground(at);
        if (z === undefined) continue;
        const to: Vec3 = [at[0], at[1], z + 16];
        const length = Math.hypot(to[0] - eyes[0], to[1] - eyes[1], to[2] - eyes[2]);
        const toward: Vec3 = [
          (to[0] - eyes[0]) / length,
          (to[1] - eyes[1]) / length,
          (to[2] - eyes[2]) / length,
        ];
        const hit = physics.raycast(eyes, toward, length, Layer.lineOfSight, undefined, observer);
        if (!hit || hit.distance >= length - 8) lying = [at[0], at[1], z];
      }
      clear = lying !== undefined;
      if (!lying) return;
      await sim.moveTo([lying[0], lying[1], lying[2] + 5]);
      dead = await sim.place(BRENUIN, PLAYER_REF);
      await sim.step(1);
      await sim.kill(dead);

      const told = (): number =>
        sim
          .storyEvents('DEAD')
          .filter((event) => event.forms.R1 === observer && event.forms.R2 === dead).length;
      const apart = async (): Promise<number> => (await sim.distance(observer, dead)) ?? NaN;
      const watch = async (look: Look, seconds: number, keepNear: boolean): Promise<void> => {
        look.from = await apart();
        for (let time = 0; time < seconds; time += 0.5) {
          if (keepNear && (await apart()) > NEAR + 50) {
            // The actor is put back beside the body (its package takes it back to its place).
            const body = await sim.position(dead);
            const actor = await sim.position(observer);
            if (body && actor) {
              const off = Math.hypot(actor[0] - body[0], actor[1] - body[1]) || 1;
              const at: [number, number] = [
                body[0] + ((actor[0] - body[0]) / off) * NEAR,
                body[1] + ((actor[1] - body[1]) / off) * NEAR,
              ];
              const z = ground(at) ?? body[2];
              await sim.native(
                sim.runtime.referenceHandle(observer),
                'ObjectReference',
                'SetPosition',
                [at[0], at[1], z + 5],
              );
            }
          }
          await sim.step(0.5);
          look.least = Math.min(look.least, await apart());
          if (sim.world.stage.senses.reacting(observer) === 'corpse') look.reacted = true;
          look.told = told();
          if (look.reacted && look.told > 0) return;
        }
      };
      // Seen from afar: the first look comes within a detection update of the death; the next
      // one fCheckDeadBodyTimer later.
      await watch(far, 15, false);
      // Near: the next look finds the body within the distance.
      await watch(near, 45, true);
    }, 600_000);
    afterAll(async () => {
      await sim.close();
    });

    it('the body lies about 1000 units away in the actor’s view, within its sight reach outdoors', () => {
      expect(clear).toBe(true);
      // Even behind the actor its sight reaches farther outdoors (the load order's
      // fSneakMaxDistance × fSneakExteriorDistanceMult × fDetectionLOSDistanceMultExterior).
      const behind = sightReach(settings, Math.PI, detectionReach(settings, true), true);
      expect(far.from).toBeGreaterThan(FAR - 150);
      expect(far.from).toBeLessThan(behind);
      expect(far.least).toBeGreaterThan(settings.deadReactionDistance + 100);
    });

    it('seen farther than fDeadReactionDistance (400): no reaction, no Dead Body event', () => {
      expect(far.reacted).toBe(false);
      expect(far.told).toBe(0);
    });

    it('the same body within it later: the Dead Body event is raised, once for the body', () => {
      expect(near.least).toBeLessThan(settings.deadReactionDistance);
      expect(near.told).toBe(1);
    });

    it.fails(
      'the same body within it later: the actor walks to it and looks at it (the corpse reaction) ' +
        'TODO(M13): the first reaction of an actor whose package record is not read yet is lost',
      () => {
        expect(near.reacted).toBe(true);
      },
    );
  },
);
