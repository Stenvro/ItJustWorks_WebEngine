// Conformance: a dying actor's weapons (engine map: Combat > Damage, stagger). The weapon in its
// hand falls from it as it dies and lies in the world for anyone to pick up.
//
// Sources: iDeathDropWeaponChance (Skyrim.esm: 100, the percent chance its weapons drop); UESP
// "Skyrim:Weapons" (a dead actor's weapons lie by its body).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';
import { LOAD_ORDER } from './settings.ts';

const BANNERED_MARE = 0x1605e;

describe.skipIf(!hasGamedata())(
  'a bandit killed in the Bannered Mare (headless simulation)',
  () => {
    let sim: Sim;
    let weapon: number | undefined;
    let before = 0;
    let after = 0;
    const dropped: number[] = [];

    beforeAll(async () => {
      sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
      const bandit = await sim.place(
        await sim.formId('NPC_', 'EncBandit01Melee1HNordM'),
        PLAYER_REF,
      );
      await sim.step(2);
      const runtime = sim.runtime;
      weapon = (await runtime.equipment.of(bandit)).right;
      if (weapon !== undefined) before = await runtime.itemCount(bandit, weapon);
      const drop = runtime.dropped.bind(runtime);
      runtime.dropped = (reference, health) => {
        dropped.push(reference);
        drop(reference, health);
      };
      await sim.kill(bandit, PLAYER_REF);
      await sim.step(1);
      if (weapon !== undefined) after = await runtime.itemCount(bandit, weapon);
    }, 600_000);
    afterAll(async () => {
      await sim.close();
    });

    it('every dying actor drops its weapons (iDeathDropWeaponChance 100)', () => {
      expect(LOAD_ORDER.iDeathDropWeaponChance).toBe(100);
    });

    it('its weapon leaves its items and lies in the world', () => {
      expect(weapon).toBeDefined();
      expect(after).toBe(before - 1);
      expect(dropped).toHaveLength(1);
    });
  },
);
