// Conformance: the player's line of sight for RegisterForLOS (engine map: Scripting > Event
// sources). Observed in the original: the player sees a reference when its bound is in the
// camera's view frustum and a ray on the line-of-sight layer from the camera to one of three
// points over its origin (3/4, 1/2 and 1/4 of its bound's height) meets nothing or the
// reference itself; no distance limits it, and the first look after the registration tells how
// it is (OnGainLOS or OnLostLOS), then each change.
//
// The Horn of Jurgen Windcaller's tomb (MQ105 180 registers the quest for the player's sight
// of MQ105TombActivator): mq105questscript's OnGainLOS sets 190 only while the player stands
// in MQ105UstengravTombTrigger and is not in combat. Seen first from the hall (the tomb is in
// sight from its door, 2,500 units off), the event comes outside the trigger and sets nothing;
// it comes again only once the tomb has been out of sight, so the player who walked up to it
// looks away and back.

import { describe, expect, it } from 'vitest';
import { hasGamedata, openSim, PLAYER_REF } from '../../helpers/sim.ts';

const MQ105 = 0x242ba;
/** Ustengrav's depths, the hall's MQ105SetStage180, the tomb and its trigger. */
const USTENGRAV_02 = 0x152aa;
const SET_STAGE_180 = 0x7a507;
const TOMB = 0xc65ad;
const TOMB_TRIGGER = 0x7a506;

describe.skipIf(!hasGamedata())("the player's line of sight (RegisterForLOS)", () => {
  it('tells the Horn quest of the tomb in sight: from the hall, then from its trigger (MQ105 190)', async () => {
    const sim = await openSim({ interior: USTENGRAV_02 });
    try {
      const hall = await sim.position(SET_STAGE_180);
      const tomb = await sim.position(TOMB);
      const trigger = await sim.position(TOMB_TRIGGER);
      expect(hall && tomb && trigger).toBeTruthy();
      if (!hall || !tomb || !trigger) return;
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
      if (me) sim.look([2 * me[0] - tomb[0], 2 * me[1] - tomb[1], me[2] + 110]);
      expect(await sim.until(() => lost() === 2, 5)).toBe(true);
      sim.look(tomb);
      expect(await sim.until(() => sim.stageDone(MQ105, 190), 5)).toBe(true);
      expect(gained()).toBe(2);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
