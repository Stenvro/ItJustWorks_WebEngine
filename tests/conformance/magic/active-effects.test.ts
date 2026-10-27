// Conformance: active effects (engine map: Magic, effects, perks > Active effects): their
// strength (dual casting), how a value effect acts over its duration, and the taper that follows
// it.
//
// Sources:
// - The engine's rule, observed in the original: an active effect lasts its effect item's duration plus the
//   magic effect's taper duration (none with No Magnitude or No Duration); its magnitude is whole
//   until the last taper seconds, then magnitude × taper weight × (remaining / taper
//   duration)^taper curve; a Recover effect does not taper. A value effect at once (no duration)
//   acts at once, then each frame of its taper by the tapered magnitude × the frame's time.
// - The records: FireDamageFFAimed (Firebolt's effect: weight 0.3, curve 2, 1 s),
//   EnchFireDamageFFContact (0.2, 2, 1 s), FireDamageConcAimed (Flames: 0.3, 2, 0.1 s);
//   `node tools/magic-census.ts` for the class.
// - fMagicDualCastingEffectivenessBase 2.2 (Skyrim.esm); UESP "Skyrim:Dual Casting".

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  castStrength,
  DUAL_CASTING_POWER,
  magnitudeOver,
  taperedMagnitude,
  tapers,
  taperSeconds,
} from '../../../src/gameplay/magic/effect-rules.ts';
import { PLAYER_REF } from '../../../src/scripting/runtime/forms.ts';
import { ScriptRuntime } from '../../../src/scripting/runtime/runtime.ts';
import { ScriptLibrary } from '../../../src/scripting/script-library.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { ActorValue } from '../../../src/world/actor-values.ts';
import { EffectFlag } from '../../../src/world/magic-effects.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { magicCensus, type MagicCensus } from '../../../tools/magic-census.ts';
import { hasGamedata } from '../../helpers/sim.ts';

/** FireDamageFFAimed's DATA (Skyrim.esm 00012F03): hostile, detrimental, FX persist, ... */
const FIRE = { flags: 0x10221805, taperWeight: 0.3, taperCurve: 2, taperDuration: 1 };

describe('the taper', () => {
  it('adds the taper duration to the effect’s, not with No Magnitude or No Duration', () => {
    expect(taperSeconds(FIRE)).toBe(1);
    expect(taperSeconds({ ...FIRE, flags: FIRE.flags | EffectFlag.noDuration })).toBe(0);
    expect(taperSeconds({ ...FIRE, flags: FIRE.flags | EffectFlag.noMagnitude })).toBe(0);
  });

  it('keeps a Recover effect whole through its taper', () => {
    const recover = { ...FIRE, flags: EffectFlag.recover };
    expect(tapers(recover)).toBe(false);
    expect(taperedMagnitude(10, 0.5, recover)).toBe(10);
  });

  it('weakens Firebolt’s burn to 0.3 × (remaining / 1 s)² of its 25 points', () => {
    expect(taperedMagnitude(25, 1, FIRE)).toBe(25);
    expect(taperedMagnitude(25, 0.5, FIRE)).toBeCloseTo(25 * 0.3 * 0.25, 9);
    expect(taperedMagnitude(25, 0, FIRE)).toBe(0);
  });

  it('burns 2.5 more over Firebolt’s second of taper (25 × 0.3 × 1 s / 3)', () => {
    expect(magnitudeOver(25, 1, FIRE, 0, 1)).toBeCloseTo(2.5, 9);
    // The frames' sum the engine makes comes to the same within a frame's share.
    let frames = 0;
    for (let k = 1; k <= 60; k++) frames += taperedMagnitude(25, 1 - k / 60, FIRE) / 60;
    expect(Math.abs(frames - 2.5)).toBeLessThan((25 * 0.3) / 60);
  });

  it('burns a lasting fire effect whole for its duration, then tapers', () => {
    // 5 points a second for 4 s, then the 1 s taper: 20 + 5 × 0.3 / 3.
    expect(magnitudeOver(5, 5, FIRE, 0, 5)).toBeCloseTo(20.5, 9);
    expect(magnitudeOver(5, 5, FIRE, 0, 4)).toBeCloseTo(20, 9);
  });
});

describe('strength', () => {
  it('dual casts at fMagicDualCastingEffectivenessBase (2.2) where the effect says', () => {
    expect(DUAL_CASTING_POWER).toBe(2.2);
    const both = EffectFlag.powerAffectsMagnitude | EffectFlag.powerAffectsDuration;
    expect(castStrength({ magnitude: 10, duration: 5 }, { flags: both }, 2.2)).toEqual({
      magnitude: 22,
      duration: 11,
    });
    expect(castStrength({ magnitude: 10, duration: 5 }, { flags: 0 }, 2.2)).toEqual({
      magnitude: 10,
      duration: 5,
    });
  });
});

describe.skipIf(!hasGamedata())('the effects across the load order (data)', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let census: MagicCensus;
  let runtime: ScriptRuntime;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    census = await magicCensus(db);
    const library = new ScriptLibrary(async (name) => {
      const path = `scripts\\${name}.pex`;
      return vfs.has(path) ? vfs.read(path) : undefined;
    });
    runtime = new ScriptRuntime(db, library);
    await runtime.magic.prepare(PLAYER_REF);
  }, 300_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('counts the 187 effects that taper, by what resists them', () => {
    expect(census.tapering).toBe(187);
    expect(census.taperingRecover).toBe(2);
    // 41 FireResist, -1 none, 40 PoisonResist, 42 ElectricResist, 44 MagicResist, 39 DamageResist?,
    // 43 FrostResist.
    expect(Object.fromEntries(census.taperingByResist)).toEqual({
      41: 86,
      '-1': 68,
      40: 10,
      42: 9,
      44: 7,
      39: 4,
      43: 3,
    });
  });

  it('counts the casting types, deliveries and flags of the 1,731 magic effects', () => {
    expect(census.effects).toBe(1731);
    expect(Object.fromEntries(census.castingTypes)).toEqual({ 0: 577, 1: 1014, 2: 140 });
    expect(Object.fromEntries(census.deliveries)).toEqual({ 0: 980, 1: 257, 2: 365, 3: 41, 4: 88 });
    expect(Object.fromEntries([...census.flags].map(([bit, n]) => [bit.toString(16), n]))).toEqual({
      1: 549,
      2: 778,
      4: 579,
      8: 92,
      10: 162,
      100: 162,
      200: 366,
      400: 291,
      800: 1062,
      1000: 927,
      4000: 19,
      8000: 340,
      20000: 352,
      40000: 9,
      200000: 964,
      400000: 424,
      4000000: 228,
      8000000: 119,
      10000000: 415,
      40000000: 6,
    });
  });

  it('burns the player with Firebolt for 25, then 2.5 more over its taper, then it is gone', async () => {
    const health = async (): Promise<number> =>
      (await runtime.actors.value(PLAYER_REF, ActorValue.health)).current;
    runtime.progression.holdRegeneration(PLAYER_REF, ActorValue.health, 60);
    let firebolt = 0;
    for (const formId of db.formIdsOfType('SPEL'))
      if ((await db.get(formId))?.editorId === 'Firebolt') firebolt = formId;
    const before = await health();
    expect(await runtime.magic.cast(firebolt, PLAYER_REF, PLAYER_REF)).toBe(true);
    await runtime.vm.idle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(before - (await health())).toBeCloseTo(25, 6);
    for (let t = 0; t < 1.5; t += 0.05) {
      runtime.update(0.05, 0);
      await runtime.vm.idle();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(before - (await health())).toBeCloseTo(27.5, 3);
    expect(
      runtime.magic
        .effectsOn(PLAYER_REF)
        .filter(([, e]) => e.item === firebolt && e.index === 0)
        .map(([, e]) => e),
    ).toEqual([]);
    runtime.actors.restore(PLAYER_REF, ActorValue.health, 100);
  }, 60_000);

  it('burns a frame at a time while a concentration spell without a duration is held', async () => {
    // Observed in the original: a concentration spell's value effect is modified each frame
    // (its magnitude × the frame's time) even without a duration; it lasts while held.
    const health = async (): Promise<number> =>
      (await runtime.actors.value(PLAYER_REF, ActorValue.health)).current;
    const settle = async (): Promise<void> => {
      await runtime.vm.idle();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    runtime.progression.holdRegeneration(PLAYER_REF, ActorValue.health, 60);
    let flames = 0;
    for (const formId of db.formIdsOfType('SPEL'))
      if ((await db.get(formId))?.editorId === 'Flames') flames = formId;
    const record = await runtime.magic.item(flames);
    const first = record?.effects[0];
    if (!record || !first) throw new Error('Flames not read');
    // Flames' 8 a second, its effect item's 1 s taken away (as a mod's effect without one).
    const item = { ...record, effects: [{ ...first, duration: 0 }] };
    const before = await health();
    expect(
      await runtime.magic.apply(item, PLAYER_REF, { caster: PLAYER_REF, effects: [0], hold: 0.5 }),
    ).toBe(1);
    await settle();
    expect(await health()).toBe(before);
    for (let frame = 0; frame < 8; frame++) {
      runtime.update(0.05, 0);
      await settle();
    }
    expect(before - (await health())).toBeCloseTo(8 * 0.4, 3);
    // The spell stops: the effect ends after its taper (0.1 s), not the rest of its hold.
    runtime.magic.endHeld(PLAYER_REF, flames);
    for (let frame = 0; frame < 4; frame++) {
      runtime.update(0.05, 0);
      await settle();
    }
    expect(before - (await health())).toBeLessThan(8 * 0.4 + 0.2);
    expect(runtime.magic.effectsOn(PLAYER_REF).filter(([, e]) => e.item === flames)).toEqual([]);
    runtime.actors.restore(PLAYER_REF, ActorValue.health, 100);
  }, 60_000);
});

describe('what the original does that we do not yet', () => {
  it.todo(
    'displacement: an effect of a spell that displaces another (SPEL’s displacement spell, ' +
      'CommonLibSSE ActiveEffect::displacementSpell) ends it (original)',
  );
  it.todo('conditions are checked at the engine’s interval (we check about each second)');
});
