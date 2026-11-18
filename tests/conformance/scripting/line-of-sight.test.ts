// Conformance: the player's line of sight for RegisterForLOS (engine map: Scripting > Event
// sources). Observed in the original: the player sees a reference when its bound is in the
// camera's view frustum and a ray on the line-of-sight layer from the camera to one of three
// points over its origin (3/4, 1/2 and 1/4 of its bound's height) meets nothing or the
// reference itself; no distance limits it, and the first look after the registration tells how
// it is (OnGainLOS or OnLostLOS), then each change. The frustum is the camera's: half its
// vertical field of view up and down, wider across by the screen's aspect (the headless
// screen is 1920 x 1080). The bound stands in as a sphere around the base object's OBND
// (inferred: the game tests its 3D's own bound).
//
// The Horn of Jurgen Windcaller's tomb (MQ105 180 registers the quest for the player's sight
// of MQ105TombActivator): mq105questscript's OnGainLOS sets 190 only while the player stands
// in MQ105UstengravTombTrigger and is not in combat. Seen first from the hall (the tomb is in
// sight from its door, 2,500 units off), the event comes outside the trigger and sets nothing;
// it comes again only once the tomb has been out of sight, so the player who walked up to it
// looks away and back.

import { describe, expect, it } from 'vitest';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

const MQ105 = 0x242ba;
/** Ustengrav's depths, the hall's MQ105SetStage180, the tomb and its trigger. */
const USTENGRAV_02 = 0x152aa;
const SET_STAGE_180 = 0x7a507;
const TOMB = 0xc65ad;
const TOMB_TRIGGER = 0x7a506;
const DEGREE = Math.PI / 180;

type Vec3 = readonly [number, number, number];

/** The tomb's bound as a sphere (its OBND at its scale, turned as it stands). */
async function tombSphere(sim: Sim): Promise<{ center: Vec3; radius: number }> {
  const placed = await sim.runtime.placement(TOMB);
  const bounds = await sim.runtime.objectBounds(TOMB);
  if (!placed || !bounds) throw new Error('the tomb has no place or bounds');
  const { min, max } = bounds;
  const yaw = placed.rotation[2];
  const cx = (min[0] + max[0]) / 2;
  const cy = (min[1] + max[1]) / 2;
  const at = placed.position;
  return {
    center: [
      at[0] + cx * Math.cos(yaw) + cy * Math.sin(yaw),
      at[1] - cx * Math.sin(yaw) + cy * Math.cos(yaw),
      at[2] + (min[2] + max[2]) / 2,
    ],
    radius: Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2,
  };
}

/** The camera, with the heading and pitch from it to a point and the angle a sphere spans. */
function aim(sim: Sim, center: Vec3, radius: number) {
  const camera = sim.world.session.render.view?.camera;
  if (!camera?.fovY) throw new Error('no camera with a field of view');
  const [dx, dy, dz] = [0, 1, 2].map((i) => (center[i] ?? 0) - (camera.position[i] ?? 0));
  const across = Math.hypot(dx ?? 0, dy ?? 0);
  const [width, height] = sim.world.session.render.size;
  const halfHeight = camera.fovY / 2;
  return {
    yaw: Math.atan2(dx ?? 0, dy ?? 0),
    pitch: Math.atan2(dz ?? 0, across),
    spans: Math.asin(Math.min(1, radius / Math.hypot(across, dz ?? 0))),
    halfHeight,
    halfWidth: Math.atan(Math.tan(halfHeight) * (width / height)),
  };
}

describe.skipIf(!hasGamedata())("the player's line of sight (RegisterForLOS)", () => {
  it('tells the Horn quest of the tomb in sight: from the hall, then from its trigger (MQ105 190)', async () => {
    const sim = await openSim({ interior: USTENGRAV_02 });
    try {
      const hall = await sim.position(SET_STAGE_180);
      const tomb = await sim.position(TOMB);
      const trigger = await sim.position(TOMB_TRIGGER);
      expect(hall && tomb && trigger).toBeTruthy();
      if (!hall || !tomb || !trigger) return;
      const sphere = await tombSphere(sim);
      // In at the hall's door, looking back the way the player came.
      await sim.moveTo(hall, Math.atan2(hall[0] - tomb[0], hall[1] - tomb[1]));
      await sim.step(1);
      // Not awaited: the quest's start and fragments wait for frames.
      void sim.runtime.quests.setStage(MQ105, 180);
      expect(await sim.until(() => sim.stageDone(MQ105, 180), 60)).toBe(true);
      await sim.step(1);
      const gained = (): number => sim.scriptEvents({ event: 'OnGainLOS', target: MQ105 }).length;
      const lost = (): number => sim.scriptEvents({ event: 'OnLostLOS', target: MQ105 }).length;
      // The first look: out of sight.
      expect(lost()).toBe(1);
      expect(gained()).toBe(0);
      // Looking up over the tomb, its bound a few degrees under the bottom of the screen,
      // though within the frame's half width of it: the frustum is not a cone, so not in sight.
      const far = aim(sim, sphere.center, sphere.radius);
      const over = far.halfHeight + far.spans + 6 * DEGREE;
      expect(over).toBeLessThan(far.halfWidth - 2 * DEGREE);
      sim.world.look(far.yaw, far.pitch + over);
      await sim.step(3);
      expect(gained()).toBe(0);
      // Turned to the tomb across the hall: in sight, outside its trigger: nothing set.
      sim.look(tomb);
      expect(await sim.until(() => gained() === 1, 5)).toBe(true);
      await sim.step(1);
      expect(sim.stageDone(MQ105, 190)).toBe(false);
      // At the tomb, in its trigger, looking at it: no new event while it stays in sight.
      expect(await sim.walkPath(tomb, 60, 300)).toBe(true);
      sim.look(tomb);
      await sim.step(1);
      expect(gained()).toBe(1);
      expect(sim.stageDone(MQ105, 190)).toBe(false);
      // Looking away and back: gained in the trigger, 190.
      const me = await sim.position(PLAYER_REF);
      const away = (): void => {
        if (me) sim.look([2 * me[0] - tomb[0], 2 * me[1] - tomb[1], me[2] + 110]);
      };
      away();
      expect(await sim.until(() => lost() === 2, 5)).toBe(true);
      sim.look(tomb);
      expect(await sim.until(() => sim.stageDone(MQ105, 190), 5)).toBe(true);
      expect(gained()).toBe(2);
      // 190 ends the quest's registration (its fragment unregisters); registered again, looking
      // away, the first look tells it out of sight.
      away();
      await sim.step(1);
      const runtime = sim.runtime;
      runtime.registerLineOfSight(
        runtime.formHandle(MQ105),
        runtime.referenceHandle(PLAYER_REF),
        runtime.referenceHandle(TOMB),
        'registerforlos',
      );
      expect(await sim.until(() => lost() === 3, 5)).toBe(true);
      // Turned so the tomb's middle is off the side of the screen with a part of its bound
      // still on it: in sight (its middle alone would be out of view).
      const near = aim(sim, sphere.center, sphere.radius);
      expect(near.spans).toBeGreaterThan(8 * DEGREE);
      sim.world.look(near.yaw + near.halfWidth + near.spans / 2, near.pitch);
      expect(await sim.until(() => gained() === 3, 5)).toBe(true);
      // Turned a little further, the whole bound off the screen: out of sight again.
      sim.world.look(near.yaw + near.halfWidth + near.spans + 4 * DEGREE, near.pitch);
      expect(await sim.until(() => lost() === 4, 5)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
