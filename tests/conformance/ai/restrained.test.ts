// Conformance: a restrained actor goes nowhere (engine map: AI > Paths), in the headless
// simulation. Skipped without game data.
//
// Sources:
// - Actor.SetRestrained (the Creation Kit's Papyrus reference): a restrained actor cannot move;
//   it still turns and talks. Its life state is the restrained one (ACTOR_LIFE_STATE 6,
//   CommonLibSSE), which the original's saves keep (docs/formats/ess.md).
// - The data (Skyrim.esm): DBEntranceQuest's stage 20 restrains DB02's three captives in the
//   Abandoned Shack (AbandonedShackInterior [00050F1E]) before the player wakes there, to kill
//   one. Struck, a captive that walked away from the blows left the shack through its door.

import { describe, expect, it } from 'vitest';
import { WeaponState } from '../../../src/gameplay/combat/combat-state.ts';
import { hasGamedata, openSim, PLAYER_REF, SIM_STEP } from '../../helpers/sim.ts';

const SHACK = 0x50f1e;
/** DB02Captive1Ref (Fultheim: 50 health), and an iron dagger. */
const CAPTIVE = 0x2e3f1;
const IRON_DAGGER = 0x1397e;

describe.skipIf(!hasGamedata())('a restrained actor goes nowhere (headless simulation)', () => {
  it('stays where it kneels while the player strikes it', async () => {
    const sim = await openSim({ interior: SHACK, hour: 10 });
    try {
      await sim.step(2);
      await sim.native(sim.runtime.formHandle(CAPTIVE), 'Actor', 'SetRestrained', [true]);
      expect(sim.runtime.state.actor(CAPTIVE).restrained).toBe(true);
      const from = await sim.position(CAPTIVE);
      if (!from) throw new Error('no captive');
      await sim.runtime.addItem(PLAYER_REF, sim.runtime.formHandle(IRON_DAGGER), 1, true);
      expect(await sim.equip(IRON_DAGGER)).toBe(true);
      await sim.step(1);
      sim.press('Ready Weapon', true);
      await sim.step(SIM_STEP);
      sim.press('Ready Weapon', false);
      await sim.step(1.5);
      expect(sim.world.stage.combat.weaponState(PLAYER_REF)).toBe(WeaponState.drawn);
      await sim.walkPath(from, 20, 100);
      let landed = 0;
      for (let swing = 0; swing < 6; swing++) {
        if ((await sim.swingAt(CAPTIVE, 90)).landed) landed++;
      }
      expect(landed).toBeGreaterThan(0);
      expect(sim.actor(CAPTIVE)?.dead).not.toBe(true);
      // A while on, it is still in the shack, where it was (the blows' staggers aside).
      await sim.step(20);
      const at = await sim.runtime.placement(CAPTIVE);
      expect(at?.cell).toBe(SHACK);
      const [x = 0, y = 0] = at?.position ?? [];
      expect(Math.hypot(x - from[0], y - from[1])).toBeLessThan(200);
    } finally {
      await sim.close();
    }
  }, 300_000);
});
