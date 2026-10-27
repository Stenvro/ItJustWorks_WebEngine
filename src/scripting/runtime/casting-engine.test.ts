import { describe, expect, it } from 'vitest';
import { Fields } from '../../formats/esm/fields.ts';
import { ActorValue } from '../../world/actor-values.ts';
import { EntryPoint } from '../../gameplay/perk-entry-points.ts';
import { EffectArchetype, EffectFlag } from '../../world/magic-effects.ts';
import { Delivery, type MagicItemRecord } from '../../world/magic-records.ts';
import { CastType } from '../../world/spell-records.ts';
import { CastingEngine, CastingSource, type CastEvent } from './casting-engine.ts';
import { EventHub } from './event-hub.ts';
import { PLAYER_REF } from './forms.ts';
import { GameState } from './game-state.ts';
import type { ScriptRuntime } from './runtime.ts';

const DESTRUCTION = 20;
const FIRE = 0x100;
const HEAL = 0x101;
const FIREBOLT = 0x200;
const FLAMES = 0x201;
const POWER = 0x202;
const SHOUT = 0x300;
const WORDS = [0x310, 0x311, 0x312];
const SPELLS = [0x320, 0x321, 0x322];
const NPC = 0x5000;
/** The default object Magic Fail Sound (MFSN). */
const FAIL_SOUND = 0x9001;

const spell = (
  formId: number,
  castType: number,
  options: Partial<MagicItemRecord> = {},
): MagicItemRecord => ({
  formId,
  type: 'SPEL',
  editorId: '',
  name: '',
  kind: 'spell',
  castType,
  delivery: Delivery.aimed,
  flags: 0x1,
  effects: [{ effect: FIRE, magnitude: 25, area: 0, duration: 0, conditions: [] }],
  keywords: [],
  cost: 40,
  chargeTime: 0.5,
  ...options,
});

const ITEMS = new Map<number, MagicItemRecord>([
  [FIREBOLT, spell(FIREBOLT, CastType.fireAndForget)],
  [FLAMES, spell(FLAMES, CastType.concentration, { cost: 10, chargeTime: 0 })],
  [POWER, spell(POWER, CastType.fireAndForget, { kind: 'power', delivery: Delivery.self })],
  ...SPELLS.map((id): [number, MagicItemRecord] => [
    id,
    spell(id, CastType.fireAndForget, { kind: 'voice', cost: 0 }),
  ]),
]);

/** A shout's record (SNAM: word, spell, recovery). */
function shoutRecord() {
  const snams = WORDS.map((word, index) => {
    const view = new DataView(new ArrayBuffer(12));
    view.setUint32(0, word, true);
    view.setUint32(4, SPELLS[index] ?? 0, true);
    view.setFloat32(8, [20, 30, 45][index] ?? 0, true);
    return { type: 'SNAM', data: new Uint8Array(view.buffer) };
  });
  return {
    formId: SHOUT,
    type: 'SHOU',
    editorId: 'Fus',
    fields: new Fields(snams),
    formIdAt: (data: Uint8Array, offset = 0) =>
      new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true),
    formIdField: () => undefined,
    text: () => undefined,
  };
}

/** A runtime with one player and one NPC, their values, and the records above. */
function world() {
  const state = new GameState();
  const values = new Map<string, number>();
  const value = (actor: number, index: number): number =>
    values.get(`${String(actor)}:${String(index)}`) ?? 0;
  const set = (actor: number, index: number, amount: number): void => {
    values.set(`${String(actor)}:${String(index)}`, amount);
  };
  const loadouts = new Map<number, { left?: number; right?: number; voice?: number }>();
  const applied: {
    item: number;
    target: number;
    scale: number | undefined;
    trains: boolean | undefined;
    seconds: number | undefined;
  }[] = [];
  const blinks: number[] = [];
  const hits: number[] = [];
  const used: number[] = [];
  const wardsHeld: number[] = [];
  const sounds: number[] = [];
  const endedHeld: number[] = [];
  const wordsLearned = new Map<number, boolean>();
  const runtime = {
    state,
    world: {
      playSound: (sound: number) => {
        sounds.push(sound);
        return 0;
      },
    },
    incrementStat: () => 0,
    wordsLearned,
    // The perk system: no perk changes a value; the actors may dual cast (the schools' Dual
    // Casting) and shout (AllowShoutingPerk).
    perks: {
      apply: (entryPoint: number, _owner: number, value: number) =>
        Promise.resolve(
          entryPoint === EntryPoint.canDualCastSpell || entryPoint === EntryPoint.modShoutOk
            ? 1
            : value,
        ),
    },
    gameSetting: () => Promise.resolve(undefined),
    forms: {
      db: { formIdsOfType: (type: string) => (type === 'SHOU' ? [SHOUT] : []) },
      record: (formId: number) =>
        Promise.resolve(
          formId === SHOUT ? shoutRecord() : ITEMS.has(formId) ? { type: 'SPEL' } : undefined,
        ),
    },
    equipment: {
      of: (actor: number) => Promise.resolve(loadouts.get(actor) ?? {}),
    },
    magic: {
      item: (formId: number) => Promise.resolve(ITEMS.get(formId)),
      effect: (formId: number) =>
        Promise.resolve(
          formId === FIRE
            ? {
                formId: FIRE,
                baseCost: 1,
                skill: DESTRUCTION,
                flags: EffectFlag.hostile | EffectFlag.detrimental,
                actorValue: ActorValue.health,
                archetype: EffectArchetype.valueModifier,
              }
            : formId === HEAL
              ? { formId: HEAL, baseCost: 1, skill: 22, flags: 0, actorValue: ActorValue.health }
              : undefined,
        ),
      acted: () => undefined,
      holdWards: (actor: number) => {
        wardsHeld.push(actor);
      },
      defaultObject: (use: string) => Promise.resolve(use === 'MFSN' ? FAIL_SOUND : undefined),
      endHeld: (_caster: number, item: number) => {
        endedHeld.push(item);
      },
      hostile: (item: MagicItemRecord) =>
        Promise.resolve(item.effects.some((entry) => entry.effect === FIRE)),
      extendHeld: () => new Set<number>(),
      apply: (
        item: MagicItemRecord,
        target: number,
        options: { scale?: number; trains?: boolean; seconds?: number },
      ) => {
        applied.push({
          item: item.formId,
          target,
          scale: options.scale,
          trains: options.trains,
          seconds: options.seconds,
        });
        return Promise.resolve(item.effects.length);
      },
    },
    actors: {
      value: (actor: number, index: number) => {
        const current = value(actor, index);
        return Promise.resolve({ base: current, max: current, current });
      },
      isActor: () => Promise.resolve(true),
      isDead: () => Promise.resolve(false),
      addSpell: (actor: number, spell: number) => {
        const spells = state.actor(actor).spells;
        if (spells.get(spell) === true) return Promise.resolve(false);
        spells.set(spell, true);
        return Promise.resolve(true);
      },
      restore: (actor: number, index: number, amount: number) => {
        set(actor, index, value(actor, index) + amount);
      },
      damage: (actor: number, index: number, amount: number) => {
        set(actor, index, value(actor, index) - amount);
        return Promise.resolve();
      },
      modify: (actor: number, index: number, amount: number) => {
        set(actor, index, value(actor, index) + amount);
      },
    },
    progression: {
      refused: (actor: number) => {
        blinks.push(actor);
      },
      holdRegeneration: () => undefined,
      spend: (actor: number, index: number, amount: number) => {
        set(actor, index, Math.max(0, value(actor, index) - amount));
        return Promise.resolve();
      },
      useSkill: (_actor: number, _skill: number, uses: number) => {
        used.push(uses);
        return Promise.resolve();
      },
    },
    itemCount: () => Promise.resolve(1),
    removeItem: () => Promise.resolve(),
    events: new EventHub(),
    referenceHandle: () => null,
    formHandle: () => null,
    detach: (work: Promise<unknown>) => {
      void work;
    },
    // The story manager's Cast Magic each cast raises.
    storyEvents: {
      castMagic: (caster: number, _target: number | undefined, spell: number) => {
        castMagic.push({ caster, spell });
        return Promise.resolve(false);
      },
      newVoicePower: (actor: number, power: number) => {
        voicePowers.push({ actor, power });
        return Promise.resolve(false);
      },
    },
  };
  // The hits the hub hears (TESHitEvent: the target's OnHit).
  runtime.events.on('hit', (event) => {
    hits.push(event.target);
  });
  const castMagic: { caster: number; spell: number }[] = [];
  const voicePowers: { actor: number; power: number }[] = [];
  const engine = new CastingEngine(runtime as unknown as ScriptRuntime);
  const events: CastEvent[] = [];
  engine.listeners.add((event) => events.push(event));
  return {
    engine,
    state,
    set,
    value,
    loadouts,
    applied,
    blinks,
    hits,
    used,
    wardsHeld,
    sounds,
    endedHeld,
    events,
    wordsLearned,
    castMagic,
    voicePowers,
  };
}

/** A value the test needs to be there. */
function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing');
  return value;
}

/** Lets the engine's detached work (a concentration spell's spending) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('casting a spell', () => {
  it('charges, fires once ready, and spends its cost by the skill', async () => {
    const w = world();
    w.loadouts.set(PLAYER_REF, { right: FIREBOLT });
    w.set(PLAYER_REF, ActorValue.magicka, 100);
    w.set(PLAYER_REF, DESTRUCTION, 100);
    expect(await w.engine.begin(PLAYER_REF, CastingSource.right)).toBe('started');
    expect(w.engine.isCasting(PLAYER_REF)).toBe(true);
    // The story manager's Cast Magic as the cast begins.
    expect(w.castMagic).toEqual([{ caster: PLAYER_REF, spell: FIREBOLT }]);
    expect(await w.engine.castingType(PLAYER_REF, CastingSource.right)).toBe(
      CastType.fireAndForget,
    );
    w.engine.update(0.6);
    expect(w.events.map((event) => event.kind)).toEqual(['ready']);
    const fired = await w.engine.release(PLAYER_REF, CastingSource.right);
    expect(fired?.item.formId).toBe(FIREBOLT);
    const cost = 40 * (1 - 0.25 ** 0.65);
    expect(w.value(PLAYER_REF, ActorValue.magicka)).toBeCloseTo(100 - cost, 6);
    // It hits: the target's OnHit; the magic system trains the school by what took hold.
    expect(await w.engine.deliver(need(fired), NPC)).toBe(1);
    expect(w.hits).toEqual([NPC]);
    expect(w.applied.at(-1)).toMatchObject({ trains: true, seconds: undefined });
  });

  it('is refused without the magicka (the meter blinks), and let go before it was ready', async () => {
    const w = world();
    w.loadouts.set(PLAYER_REF, { right: FIREBOLT });
    w.set(PLAYER_REF, ActorValue.magicka, 10);
    expect(await w.engine.begin(PLAYER_REF, CastingSource.right)).toBe('magicka');
    expect(w.blinks).toEqual([PLAYER_REF]);
    // The player hears the magic system's failure sound (DOBJ Magic Fail Sound).
    expect(w.sounds).toEqual([FAIL_SOUND]);
    // A refused cast is no Cast Magic.
    expect(w.castMagic).toEqual([]);
    w.set(PLAYER_REF, ActorValue.magicka, 100);
    await w.engine.begin(PLAYER_REF, CastingSource.right);
    w.engine.update(0.2);
    expect(await w.engine.release(PLAYER_REF, CastingSource.right)).toBeUndefined();
    expect(w.events.at(-1)?.kind).toBe('cancel');
    expect(w.value(PLAYER_REF, ActorValue.magicka)).toBe(100);
  });

  it('spends a concentration spell each second until the magicka runs out', async () => {
    const w = world();
    w.loadouts.set(PLAYER_REF, { left: FLAMES });
    w.set(PLAYER_REF, ActorValue.magicka, 25);
    expect(await w.engine.begin(PLAYER_REF, CastingSource.left)).toBe('started');
    expect(w.engine.held(PLAYER_REF, CastingSource.left)?.item.formId).toBe(FLAMES);
    w.engine.update(1);
    await settle();
    expect(w.value(PLAYER_REF, ActorValue.magicka)).toBeCloseTo(15, 6);
    // A spray's hit puts the spell on while it is held (its effects act each frame: not scaled
    // by the hit's share); its skill trains by the seconds.
    const held = w.engine.held(PLAYER_REF, CastingSource.left);
    await w.engine.deliver(need(held), NPC, { seconds: 0.25 });
    expect(w.applied.at(-1)?.scale).toBeUndefined();
    expect(w.applied.at(-1)).toMatchObject({ trains: true, seconds: 0.25 });
    w.engine.update(2);
    await settle();
    expect(w.value(PLAYER_REF, ActorValue.magicka)).toBe(0);
    expect(w.events.at(-1)).toMatchObject({ kind: 'stop', reason: 'magicka' });
    expect(w.engine.isCasting(PLAYER_REF)).toBe(false);
    // Out of magicka: the failure sound, and what it held ends with it.
    expect(w.sounds).toEqual([FAIL_SOUND]);
    expect(w.endedHeld).toEqual([FLAMES]);
  });

  it('counts a charge from the graph’s BeginCast (the engine’s SpellCast handlers), once', async () => {
    const w = world();
    w.loadouts.set(PLAYER_REF, { right: FIREBOLT });
    w.set(PLAYER_REF, ActorValue.magicka, 100);
    expect(await w.engine.begin(PLAYER_REF, CastingSource.right)).toBe('started');
    w.engine.update(0.2);
    w.engine.graphBegan(PLAYER_REF, CastingSource.right);
    const cast = need(w.engine.casting(PLAYER_REF, CastingSource.right));
    expect(cast.hand.elapsed).toBe(0);
    w.engine.update(0.1);
    w.engine.graphBegan(PLAYER_REF, CastingSource.right);
    expect(cast.hand.elapsed).toBeCloseTo(0.1, 9);
  });

  it('dual casts at fMagicDualCastingCostMult times the cost', async () => {
    const w = world();
    w.loadouts.set(PLAYER_REF, { left: FIREBOLT, right: FIREBOLT });
    w.set(PLAYER_REF, ActorValue.magicka, 500);
    await w.engine.begin(PLAYER_REF, CastingSource.right, { dual: true });
    expect(w.engine.isDualCasting(PLAYER_REF)).toBe(true);
    w.engine.update(1);
    await w.engine.release(PLAYER_REF, CastingSource.right);
    expect(w.value(PLAYER_REF, ActorValue.magicka)).toBeCloseTo(500 - 40 * 2.8, 6);
  });

  it('uses a power once a day', async () => {
    const w = world();
    w.loadouts.set(PLAYER_REF, { voice: POWER });
    w.state.gameDaysPassed = 3;
    expect(await w.engine.begin(PLAYER_REF, CastingSource.voice)).toBe('started');
    w.engine.update(1);
    expect(await w.engine.release(PLAYER_REF, CastingSource.voice)).toBeDefined();
    w.state.gameDaysPassed = 3.5;
    expect(await w.engine.begin(PLAYER_REF, CastingSource.voice)).toBe('power');
    w.state.gameDaysPassed = 4.01;
    expect(await w.engine.begin(PLAYER_REF, CastingSource.voice)).toBe('started');
  });
});

describe('wards and absorption', () => {
  it("absorb a hostile spell up to the ward's strength, break above it", async () => {
    const w = world();
    const firebolt = {
      caster: NPC,
      item: need(ITEMS.get(FIREBOLT)),
      via: 'spell' as const,
      dual: false,
      cost: { base: 40, magicka: 40, charge: 0, school: undefined, chargeTime: 0.5 },
    };
    w.set(PLAYER_REF, 63, 40);
    expect(await w.engine.deliver(firebolt, PLAYER_REF)).toBe(0);
    expect(w.engine.wardState(PLAYER_REF)).toBe(1);
    expect(w.value(PLAYER_REF, 63)).toBe(15);
    // Lowered, not broken: the wards hold still a while.
    expect(w.wardsHeld).toEqual([PLAYER_REF]);
    // 25 against 15: it breaks, 10 of 25 passes.
    await w.engine.deliver(firebolt, PLAYER_REF);
    expect(w.engine.wardState(PLAYER_REF)).toBe(2);
    expect(w.applied.at(-1)?.scale).toBeCloseTo(0.4, 9);
    // From behind no ward meets it.
    await w.engine.deliver(firebolt, PLAYER_REF, { facing: false });
    expect(w.applied.at(-1)?.scale).toBeUndefined();
    // Spell Absorption at 100 %: absorbed, its cost the target's magicka.
    w.set(PLAYER_REF, 83, 100);
    expect(await w.engine.deliver(firebolt, PLAYER_REF)).toBe(0);
    expect(w.value(PLAYER_REF, ActorValue.magicka)).toBe(40);
  });
});

describe('shouting', () => {
  it("shouts the words known, and the voice recovers by the last word's time", async () => {
    const w = world();
    w.loadouts.set(PLAYER_REF, { voice: SHOUT });
    expect(await w.engine.beginShout(PLAYER_REF)).toBe('nothing');
    w.wordsLearned.set(need(WORDS[0]), true);
    w.wordsLearned.set(need(WORDS[1]), false);
    expect(await w.engine.beginShout(PLAYER_REF)).toBe('started');
    // Held for three words, only one is unlocked.
    const shouted = await w.engine.releaseShout(PLAYER_REF, 3);
    expect(shouted?.item.formId).toBe(SPELLS[0]);
    // Cast Magic with the word's spell.
    expect(w.castMagic).toEqual([{ caster: PLAYER_REF, spell: SPELLS[0] }]);
    expect(w.state.actors.get(PLAYER_REF)?.voiceRecoveryTime).toBe(20);
    expect(w.engine.shoutVariation(PLAYER_REF)).toBe(0);
    expect(w.engine.voiceMeter(PLAYER_REF)).toBe(0);
    w.engine.update(5);
    expect(w.engine.voiceMeter(PLAYER_REF)).toBeCloseTo(25, 9);
    // While it recovers the meter flashes.
    expect(await w.engine.beginShout(PLAYER_REF)).toBe('voice');
    expect(w.events.at(-1)).toMatchObject({ kind: 'refused', reason: 'voice' });
    w.engine.update(15);
    expect(w.engine.voiceMeter(PLAYER_REF)).toBe(100);
    // A dragon soul unlocks the second word.
    expect(await w.engine.unlockWord(SHOUT)).toBe('noSoul');
    w.set(PLAYER_REF, ActorValue.dragonSouls, 1);
    expect(await w.engine.unlockWord(SHOUT)).toBe('unlocked');
    expect(w.wordsLearned.get(need(WORDS[1]))).toBe(true);
    expect(w.value(PLAYER_REF, ActorValue.dragonSouls)).toBe(0);
    await w.engine.beginShout(PLAYER_REF);
    expect((await w.engine.releaseShout(PLAYER_REF, 2))?.item.formId).toBe(SPELLS[1]);
    expect(w.state.actors.get(PLAYER_REF)?.voiceRecoveryTime).toBe(30);
  });

  it('gives the player a shout as TeachWord teaches its first word: a New Voice Power', async () => {
    const w = world();
    // The second word first: the shout is not theirs yet.
    await w.engine.teachWord(need(WORDS[1]));
    expect(w.state.actors.get(PLAYER_REF)?.spells.get(SHOUT)).toBeUndefined();
    await w.engine.teachWord(need(WORDS[0]));
    expect(w.wordsLearned.get(need(WORDS[0]))).toBe(false);
    expect(w.state.actors.get(PLAYER_REF)?.spells.get(SHOUT)).toBe(true);
    await w.engine.teachWord(need(WORDS[2]));
    expect(w.voicePowers).toEqual([{ actor: PLAYER_REF, power: SHOUT }]);
  });

  it('lets NPCs shout every word', async () => {
    const w = world();
    w.loadouts.set(NPC, { voice: SHOUT });
    expect(await w.engine.beginShout(NPC)).toBe('started');
    expect((await w.engine.releaseShout(NPC, 3))?.item.formId).toBe(SPELLS[2]);
    expect(w.state.actors.get(NPC)?.voiceRecoveryTime).toBe(45);
  });

  it("lets an AI package's shout skip the voice's recovery, which it sets again", async () => {
    const w = world();
    w.loadouts.set(NPC, { voice: SHOUT });
    expect(await w.engine.beginShout(NPC)).toBe('started');
    await w.engine.releaseShout(NPC, 1);
    w.engine.update(5);
    expect(await w.engine.beginShout(NPC)).toBe('voice');
    expect(await w.engine.beginShout(NPC, true)).toBe('started');
    await w.engine.releaseShout(NPC, 1);
    expect(w.state.actors.get(NPC)?.voiceRecoveryTime).toBe(20);
  });
});
