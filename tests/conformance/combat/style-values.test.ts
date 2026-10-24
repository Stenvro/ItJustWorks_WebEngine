// Conformance: combat style values (engine map: Combat > Style values). Every CSTY field, how the
// data uses it, and the scale of game settings the engine reads it on.
//
// Sources:
// - The fields: xEdit wbDefinitionsTES5 CSTY, CommonLibSSE TESCombatStyle: CSGD (offensive,
//   defensive, group offensive mults; the melee, magic, ranged, shout, unarmed and staff score
//   mults; avoid threat chance), CSME (attack staggered, power attack staggered, power attack
//   blocking, bash, bash recoil, bash attack, bash power attack, special attack mults), CSCR
//   (circle, fallback mults, flank distance, stalk time), CSLR (strafe mult), CSFL (hover, dive
//   bomb, ground attack chances; hover, ground attack times; perch attack chance and time;
//   flying attack chance), DATA flags (dueling, flanking, allow dual wielding).
// - The scale, observed in the original (docs/ai.md, Style values): a value v counts as
//   Min + v × (Max − Min) of its settings; the block time, the advance radii and the optimal
//   range on a three-point curve. The settings' defaults: the engine's defaults (combat/settings.ts).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMBAT_AI_DEFAULTS } from '../../../src/ai/combat-ai.ts';
import {
  CombatStyleFlag,
  parseCombatStyle,
  storedFloats,
} from '../../../src/ai/combat-style-records.ts';
import {
  blockAttackChance,
  blockChance,
  blockTime,
  circleChance,
  curve,
  dodgeChance,
  fallbackChance,
  flankDistance,
  maxOptimalRange,
  specialAttackChance,
  stalkTime,
  strafeChance,
} from '../../../src/ai/combat-tactics.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { hasGamedata } from '../../helpers/sim.ts';
import { ENGINE } from './settings.ts';
import { styleWith } from './style.ts';

const settings = COMBAT_AI_DEFAULTS;

describe('each value on its settings’ scale (formula)', () => {
  const half = styleWith(
    { defensiveMult: 0.5, avoidThreatChance: 0.5 },
    {
      melee: { ...styleWith().melee, specialAttackMult: 0.5 },
      closeRange: { circleMult: 0.5, fallbackMult: 0.5, flankDistance: 0.5, stalkTime: 0.5 },
      longRange: { strafeMult: 0.5 },
    },
  );
  const mid = (min: number, max: number): number => min + (max - min) / 2;

  it('CSCR circle mult: fCombatCircleChanceMin .. Max', () => {
    expect(circleChance(half, settings)).toBeCloseTo(
      mid(ENGINE.fCombatCircleChanceMin, ENGINE.fCombatCircleChanceMax),
    );
  });
  it('CSCR fallback mult: fCombatFallbackChanceMin .. Max', () => {
    expect(fallbackChance(half, settings)).toBeCloseTo(
      mid(ENGINE.fCombatFallbackChanceMin, ENGINE.fCombatFallbackChanceMax),
    );
  });
  it('CSCR flank distance: fCombatFlankingDistanceMin .. Max', () => {
    expect(flankDistance(half, settings)).toBeCloseTo(
      mid(ENGINE.fCombatFlankingDistanceMin, ENGINE.fCombatFlankingDistanceMax),
    );
  });
  it('CSCR stalk time: fCombatFlankingStalkTimeMin .. Max', () => {
    expect(stalkTime(half, settings)).toBeCloseTo(
      mid(ENGINE.fCombatFlankingStalkTimeMin, ENGINE.fCombatFlankingStalkTimeMax),
    );
  });
  it('CSLR strafe mult: fCombatStrafeChanceMin .. Max', () => {
    expect(strafeChance(half, settings)).toBeCloseTo(
      mid(ENGINE.fCombatStrafeChanceMin, ENGINE.fCombatStrafeChanceMax),
    );
  });
  it('CSGD avoid threat chance: fCombatDodgeChanceMin .. Max', () => {
    expect(dodgeChance(half, settings)).toBeCloseTo(
      mid(ENGINE.fCombatDodgeChanceMin, ENGINE.fCombatDodgeChanceMax),
    );
  });
  it('CSME special attack mult: fCombatSpecialAttackChanceMin .. Max', () => {
    expect(specialAttackChance(half, settings)).toBeCloseTo(
      mid(ENGINE.fCombatSpecialAttackChanceMin, ENGINE.fCombatSpecialAttackChanceMax),
    );
  });
  it('CSGD defensive mult: block and block attack chances on their settings', () => {
    expect(blockChance(half, true, settings)).toBeCloseTo(
      mid(ENGINE.fCombatBlockChanceMin, ENGINE.fCombatBlockChanceMax),
    );
    expect(blockAttackChance(half, settings)).toBeCloseTo(
      mid(ENGINE.fCombatBlockAttackChanceMin, ENGINE.fCombatBlockAttackChanceMax),
    );
  });
  it('the defensive mult × 2 − 1 on the block time’s curve (4, 8, 10000 s)', () => {
    expect(blockTime(half, settings)).toBe(ENGINE.fCombatBlockTimeMid);
    expect(blockTime(styleWith({ defensiveMult: 0 }), settings)).toBe(ENGINE.fCombatBlockTimeMin);
    expect(blockTime(styleWith({ defensiveMult: 1 }), settings)).toBe(ENGINE.fCombatBlockTimeMax);
  });
  it('the curve: Min at −1, Mid at 0, Max at 1, linear between', () => {
    expect(curve(-1, 1, 2, 4)).toBe(1);
    expect(curve(0.5, 1, 2, 4)).toBe(3);
  });
  it('defensive − offensive on the optimal range’s curve (1024, 1280, 1536)', () => {
    const even = styleWith({ offensiveMult: 0.5, defensiveMult: 0.5 });
    expect(maxOptimalRange(even, { targetIsPlayer: false, allies: 0 }, settings)).toBe(
      ENGINE.fCombatMaximumOptimalRangeMid,
    );
  });

  it.todo(
    'CSFL: each flight chance on its fCombat…ChanceMin .. Max, times on Min .. Max  [docs/ai.md]',
  );
  it.todo('the CSGD score mults weigh each kind of equipment (Inventory)  [original]');
  it.todo('the dueling and flanking flags choose the close movement’s trees  [original]');
  it.todo('Allow Dual Wielding: the left hand’s attacks  [CommonLibSSE TESCombatStyle]');
});

describe.skipIf(!hasGamedata())('the combat styles of the load order (data)', () => {
  let vfs: Vfs;
  let db: RecordDatabase;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
  }, 300_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('counts the styles, the fields they store and their flags', async () => {
    const fields: Record<string, number> = { CSGD: 0, CSME: 0, CSCR: 0, CSLR: 0, CSFL: 0 };
    const full: Record<string, number> = { CSGD: 0, CSME: 0, CSCR: 0, CSLR: 0, CSFL: 0 };
    const sizes = { CSGD: 10, CSME: 8, CSCR: 4, CSLR: 1, CSFL: 8 } as const;
    const flags = { dueling: 0, flanking: 0, allowDualWielding: 0 };
    let styles = 0;
    for (const formId of db.formIdsOfType('CSTY')) {
      const record = await db.get(formId);
      if (!record || record.deleted) continue;
      styles++;
      for (const [type, size] of Object.entries(sizes)) {
        const stored = storedFloats(record, type);
        if (stored > 0) fields[type] = (fields[type] ?? 0) + 1;
        if (stored >= size) full[type] = (full[type] ?? 0) + 1;
      }
      const style = parseCombatStyle(record);
      if ((style.flags & CombatStyleFlag.dueling) !== 0) flags.dueling++;
      if ((style.flags & CombatStyleFlag.flanking) !== 0) flags.flanking++;
      if ((style.flags & CombatStyleFlag.allowDualWielding) !== 0) flags.allowDualWielding++;
    }
    // The maintainer's load order, 2026-10-24: 197 styles; short fields keep the Creation Kit's
    // defaults for the values they leave out (UESP CSTY).
    expect({ styles, fields, full, flags }).toEqual({
      styles: 197,
      fields: { CSGD: 197, CSME: 196, CSCR: 196, CSLR: 196, CSFL: 196 },
      full: { CSGD: 188, CSME: 146, CSCR: 188, CSLR: 196, CSFL: 146 },
      flags: { dueling: 169, flanking: 19, allowDualWielding: 38 },
    });
  }, 300_000);
});
