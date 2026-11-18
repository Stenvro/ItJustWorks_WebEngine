// Conformance: the ForceGreet procedure (engine map: AI > Procedures). Its package stays current
// through the conversation its greeting opens, so the lines chosen in it may ask for the package:
// in A Blade in the Dark, Delphine follows the player into the Sleeping Giant's attic room and
// force greets them (MQ106DelphineIntroGreet, her intro scene's package action); the greeting of
// MQ106DelphineIntroTopic asks GetIsCurrentPackage(MQ106DelphineIntroGreet) == 1, and its line
// sets MQ106 30. Found 2026-10-29: the procedure was done as the conversation opened, so its
// package had ended before the line was chosen and no greeting passed.

import { describe, expect, it } from 'vitest';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

/** A Blade in the Dark, its Delphine alias, and the inn's room trigger (InnRoomTrigger). */
const MQ106 = 0x32926;
const DELPHINE = 44;
const ROOM_TRIGGER = 0x3fb03;
/** The Sleeping Giant Inn. */
const SLEEPING_GIANT = 0x133c6;

/** The topic an actor's ForceGreet opened the dialogue menu with (undefined: none yet). */
function greeting(sim: Sim, actor: number): number | undefined {
  return sim.menus().find((menu) => menu.menu === 'Dialogue Menu' && menu.reference === actor)
    ?.opening;
}

describe.skipIf(!hasGamedata())('the ForceGreet procedure', () => {
  it("keeps its package current through its conversation (Delphine's MQ106 30)", async () => {
    const sim = await openSim({ interior: SLEEPING_GIANT });
    try {
      // Not awaited: the quest's start and fragments wait for frames.
      void sim.runtime.quests.setStage(MQ106, 10);
      expect(await sim.until(() => sim.stageDone(MQ106, 10), 60)).toBe(true);
      const delphine = sim.runtime.state.quest(MQ106).aliases.get(DELPHINE) ?? 0;
      expect(delphine).not.toBe(0);
      const room = await sim.position(ROOM_TRIGGER);
      expect(room).toBeDefined();
      if (!room) return;
      // In at the room (20): her intro scene starts; she follows (25) and force greets.
      expect(await sim.walkPath(room, 60, 30)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ106, 20), 10)).toBe(true);
      expect(await sim.until(() => greeting(sim, delphine) !== undefined, 90)).toBe(true);
      // Her ForceGreet's package is still hers as the conversation's first line is chosen.
      const introGreet = await sim.formId('PACK', 'MQ106DelphineIntroGreet');
      await sim.step(1);
      expect(sim.package(delphine)?.id).toBe(introGreet);
      await sim.converse(delphine, [], greeting(sim, delphine));
      expect(await sim.until(() => sim.stageDone(MQ106, 30), 10)).toBe(true);
      expect(await sim.position(PLAYER_REF)).toBeDefined();
    } finally {
      await sim.close();
    }
  }, 600_000);
});
