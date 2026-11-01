// Conformance: a dying actor's weapons (engine map: Combat > Damage, stagger). The weapon in its
// hand falls from it as it dies and lies in the world for anyone to pick up; a weapon still in
// its sheath stays with the body.
//
// Sources: iDeathDropWeaponChance (Skyrim.esm: 100, the percent chance its weapons drop). Only
// the weapons in its hands fall (drawing, drawn, sheathing): inferred, TODO(M13) to be observed
// in the original (docs/ai.md, Death).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WeaponState } from '../../../src/gameplay/combat/combat-state.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';
import { LOAD_ORDER } from './settings.ts';

const BANNERED_MARE = 0x1605e;
/** Hulda (Skyrim.esm), the innkeeper: her weapon sheathed, she leans at the counter. */
const HULDA = 0x1a66e;

describe.skipIf(!hasGamedata())(
  'a bandit killed in the Bannered Mare (headless simulation)',
  () => {
    let sim: Sim;
    let weapon: number | undefined;
    let before = 0;
    let after = 0;
    const dropped: number[] = [];
    let hulda: { weapon: number | undefined; sheathed: boolean; before: number; after: number } = {
      weapon: undefined,
      sheathed: false,
      before: 0,
      after: 0,
    };

    beforeAll(async () => {
      sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
      await sim.step(2);
      const runtime = sim.runtime;
      const drop = runtime.dropped.bind(runtime);
      runtime.dropped = (reference, health) => {
        dropped.push(reference);
        drop(reference, health);
      };
      // Hulda, her weapon sheathed, killed first: nothing falls.
      const hers = (await runtime.equipment.of(HULDA)).right;
      const count = async (): Promise<number> =>
        hers === undefined ? 0 : runtime.itemCount(HULDA, hers);
      hulda = {
        weapon: hers,
        sheathed: sim.world.stage.combat.weaponState(HULDA) === WeaponState.sheathed,
        before: await count(),
        after: 0,
      };
      await sim.kill(HULDA, PLAYER_REF);
      await sim.step(1);
      hulda.after = await count();
      const sheathedDrops = dropped.length;
      const bandit = await sim.place(
        await sim.formId('NPC_', 'EncBandit01Melee1HNordM'),
        PLAYER_REF,
      );
      await sim.step(2);
      weapon = (await runtime.equipment.of(bandit)).right;
      if (weapon !== undefined) before = await runtime.itemCount(bandit, weapon);
      dropped.splice(0, sheathedDrops);
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

    it('one killed with its weapon sheathed keeps it (Hulda at her counter)', () => {
      expect(hulda.weapon).toBeDefined();
      expect(hulda.sheathed).toBe(true);
      expect(hulda.before).toBeGreaterThan(0);
      expect(hulda.after).toBe(hulda.before);
    });
  },
);
