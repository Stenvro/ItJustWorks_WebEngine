// Conformance: combat inventory (engine map: Combat > Inventory) on the local game data: the shout
// in an actor's voice as one of its options against a target.
//
// Sources: the game data (AlduinFirestormShout's word DragonVoiceStormCall, a self spell with the
// hostile DragonVoiceStormCallEffect, the storm's hazard and VoiceStormCallEmptyAIScriptEffect,
// "Script Effect for AI use of Storm Call": a Script effect with an AI score of 50 and an AI delay
// of 60 s; DLC1VQ05DurnehviirShout's DLC1VQ05RaiseDeadShout, a self spell of one Script effect
// with an AI score of 10,000, an AI delay of 30 s and a second's duration; Clear Skies'
// VoiceClearSkiesSelf1-3 and the dragons' DragonVoiceUnrelentingForce, each one Script effect
// without an AI score). Observed in the original: a shout's item is made as a spell's, by the
// spell's score and its caster; a self spell's hostile Stagger and its hazard are of no kind; a
// Script effect adds its AI score as it stands and gives the Script caster, also where it adds
// nothing; only items scoring more than nothing are weighed; the Script caster notes the time
// and its effect's AI delay as its cast starts (one note for all an actor's Script casts) and
// casts again once more than that delay has passed and not while the one the spell lands on
// carries it (docs/ai.md, Shouts and the voice's recovery).
//
// Ours: src/shell/combat-casting.ts, src/gameplay/combat/spell-score.ts (combatSpellScore,
// shoutOffered, scriptCasterDelay, scriptCasterReady), src/scripting/runtime/casting-engine.ts
// (scriptCastBegan, scriptCastReady), in a script runtime without a world: the stage's part of a
// shout (it begins, goes out with all its words and, a self spell, lands on its shouter) is
// stood in for here. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAYER_REF } from '../../../src/scripting/runtime/forms.ts';
import { ScriptRuntime } from '../../../src/scripting/runtime/runtime.ts';
import { ScriptLibrary } from '../../../src/scripting/script-library.ts';
import { combatCasting, type CombatStage } from '../../../src/shell/combat-casting.ts';
import type { CombatCasting } from '../../../src/shell/actor-combat-ai.ts';
import { Delivery } from '../../../src/world/magic-records.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../../../tools/gamedata-path.ts';

/** Skyrim.esm: MQ304Alduin, the Alduin of Sovngarde (MQ305's Alduin alias). */
const ALDUIN = 0x4e9bd;
/** GormlaithGoldenHilt, one of the heroes who fight him there. */
const GORMLAITH = 0xcd9f8;
/** Two more to shout: HousecarlWhiterunRef (Lydia) and IrilethREF. */
const LYDIA = 0xa2c94;
const IRILETH = 0x1a67f;

describe.skipIf(!hasGamedata())('the combat AI shouts on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let runtime: ScriptRuntime;
  let casting: CombatCasting;
  const shouts = new Map<string, number>();
  const spell = async (editorId: string): Promise<number> => {
    for (const formId of db.formIdsOfType('SPEL')) {
      if ((await db.get(formId))?.editorId === editorId) return formId;
    }
    throw new Error(`No SPEL ${editorId}`);
  };
  const shout = (editorId: string): number => {
    const formId = shouts.get(editorId.toLowerCase());
    if (formId === undefined) throw new Error(`No SHOU ${editorId}`);
    return formId;
  };
  /** The shout options the combat inventory offers an actor against a target, a shout in its voice. */
  const shoutOptions = async (editorId: string, target: number, actor = ALDUIN) => {
    expect(await runtime.equipment.equipShout(actor, shout(editorId))).toBe(true);
    expect((await runtime.equipment.of(actor)).voice).toBe(shout(editorId));
    const options = await casting.options(actor, target);
    return options.filter((one) => one.kind === 'shout');
  };
  const offered = async (editorId: string, target: number, actor = ALDUIN) =>
    (await shoutOptions(editorId, target, actor)).map((one) => one.id);
  /** The combat AI shouts the shout in an actor's voice at a target (its option's cast). */
  const shoutAt = async (editorId: string, target: number, actor = ALDUIN): Promise<void> => {
    const [option] = await shoutOptions(editorId, target, actor);
    expect(option).toBeDefined();
    if (!option) return;
    expect(await casting.castAt(actor, 'voice', target, option)).toBe(true);
  };
  const pass = async (seconds: number): Promise<void> => {
    for (let second = 0; second < seconds; second++) {
      for (let frame = 0; frame < 10; frame++) runtime.update(0.1, 0);
      await runtime.vm.idle();
    }
  };
  const carries = (actor: number, item: number): boolean =>
    runtime.magic.effectsOn(actor).some(([, entry]) => entry.item === item);

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    const library = new ScriptLibrary(async (name) => {
      const path = `scripts\\${name}.pex`;
      return vfs.has(path) ? vfs.read(path) : undefined;
    });
    runtime = new ScriptRuntime(db, library);
    for (const formId of db.formIdsOfType('SHOU')) {
      const editorId = (await db.get(formId))?.editorId;
      if (editorId) shouts.set(editorId.toLowerCase(), formId);
    }
    // The stage's part of a shout, without a world: it begins, goes out with all its words and,
    // a self spell, lands on its shouter.
    const stage: CombatStage = {
      shoutAt: async (actor) => {
        if ((await runtime.casting.beginShout(actor)) !== 'started') return false;
        const delivered = await runtime.casting.releaseShout(actor, 3);
        if (delivered?.item.delivery === Delivery.self)
          await runtime.casting.deliver(delivered, actor);
        return delivered !== undefined;
      },
      castAt: () => Promise.resolve(false),
      drinkPotion: () => Promise.resolve(false),
      healSelf: () => Promise.resolve(false),
      summon: () => Promise.resolve(false),
      reanimate: () => Promise.resolve(false),
    };
    casting = combatCasting({ scriptsReady: runtime }, () => stage);
  }, 120_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('a self spell by its Script effect for the AI: Firestorm and Storm Call', async () => {
    // AlduinFirestormShout's words are DragonVoiceStormCall: self, with the hostile
    // DragonVoiceStormCallEffect (a 600-unit Stagger), the storm's hazard on the shouter and
    // VoiceStormCallEmptyAIScriptEffect.
    const firestorm = shout('AlduinFirestormShout');
    expect(await offered('AlduinFirestormShout', PLAYER_REF)).toEqual([firestorm]);
    expect(await offered('AlduinFirestormShout', GORMLAITH)).toEqual([firestorm]);
    // Storm Call's words (VoiceStormCall1-3): self, a hostile 150-unit Stagger, the storm (a
    // script effect, or its hazard CallStormHazard01, on the shouter) and the same script effect
    // for the AI.
    expect(await offered('StormCallShout', GORMLAITH)).toEqual([shout('StormCallShout')]);
  }, 60_000);

  it('Firestorm scores its script effect’s AI score (50), by the Script caster', async () => {
    const word = await runtime.magic.item(await spell('DragonVoiceStormCall'));
    expect(word).toBeDefined();
    if (!word) return;
    // Neither the hostile Stagger (magnitude 100, 30 s) nor the hazard adds to it; against
    // whomever, as the script effect is not weighed by a target's resistances.
    for (const target of [PLAYER_REF, GORMLAITH]) {
      expect(await runtime.casting.spellScore(ALDUIN, word, 'attack', target)).toEqual({
        score: 50,
        caster: 'script',
      });
    }
  }, 60_000);

  it('Firestorm shouted: not again while the storm is on him, nor within its AI delay', async () => {
    const firestorm = shout('AlduinFirestormShout');
    const word = await runtime.magic.item(await spell('DragonVoiceStormCall'));
    expect(word).toBeDefined();
    if (!word) return;
    expect(runtime.casting.scriptCastReady(ALDUIN, word, PLAYER_REF)).toBe(true);
    // His combat AI shouts it: it lands on him, its script effect and the storm last 30 s.
    await shoutAt('AlduinFirestormShout', PLAYER_REF);
    expect(carries(ALDUIN, word.formId)).toBe(true);
    expect(runtime.casting.scriptCastReady(ALDUIN, word, PLAYER_REF)).toBe(false);
    expect(await offered('AlduinFirestormShout', PLAYER_REF)).toEqual([]);
    // The storm has run out after 30 s; the script effect's AI delay is 60 s since the shout.
    await pass(40);
    expect(carries(ALDUIN, word.formId)).toBe(false);
    expect(runtime.casting.scriptCastReady(ALDUIN, word, PLAYER_REF)).toBe(false);
    expect(await offered('AlduinFirestormShout', PLAYER_REF)).toEqual([]);
    // The note is one for all his Script casts: another word by the Script caster waits out
    // the delay noted with the Firestorm (60 s), not its own (Durnehviir's: 30 s).
    expect(await offered('DLC1VQ05DurnehviirShout', PLAYER_REF)).toEqual([]);
    expect(await offered('DLC1VQ05DurnehviirShout', PLAYER_REF, GORMLAITH)).toEqual([
      shout('DLC1VQ05DurnehviirShout'),
    ]);
    await pass(21);
    expect(await offered('DLC1VQ05DurnehviirShout', PLAYER_REF)).toEqual([
      shout('DLC1VQ05DurnehviirShout'),
    ]);
    expect(await offered('AlduinFirestormShout', PLAYER_REF)).toEqual([firestorm]);
  }, 180_000);

  it('a word whose effect has run out waits out its AI delay: Durnehviir’s', async () => {
    // DLC1VQ05RaiseDeadShout: one self Script effect, AI score 10,000, AI delay 30 s, lasting a
    // second.
    const durnehviir = shout('DLC1VQ05DurnehviirShout');
    const word = await runtime.magic.item(await spell('DLC1VQ05RaiseDeadShout'));
    expect(word).toBeDefined();
    if (!word) return;
    expect(await runtime.casting.spellScore(LYDIA, word, 'attack', PLAYER_REF)).toEqual({
      score: 10_000,
      caster: 'script',
    });
    await shoutAt('DLC1VQ05DurnehviirShout', PLAYER_REF, LYDIA);
    await pass(5);
    expect(carries(LYDIA, word.formId)).toBe(false);
    expect(await offered('DLC1VQ05DurnehviirShout', PLAYER_REF, LYDIA)).toEqual([]);
    await pass(24);
    expect(await offered('DLC1VQ05DurnehviirShout', PLAYER_REF, LYDIA)).toEqual([]);
    await pass(2);
    expect(await offered('DLC1VQ05DurnehviirShout', PLAYER_REF, LYDIA)).toEqual([durnehviir]);
  }, 180_000);

  it('a shout not his combat AI’s (a package’s) notes nothing', async () => {
    // A package's Shout begins it unchecked and lets it out; the Script caster has not cast.
    const storm = shout('StormCallShout');
    expect(await runtime.equipment.equipShout(IRILETH, storm)).toBe(true);
    expect(await runtime.casting.beginShout(IRILETH, true)).toBe('started');
    expect(await runtime.casting.releaseShout(IRILETH, 3)).toBeDefined();
    expect(await offered('StormCallShout', PLAYER_REF, IRILETH)).toEqual([storm]);
  }, 60_000);

  it('an aimed one: Unrelenting Force', async () => {
    const force = shout('UnrelentingForceShout');
    expect(await offered('UnrelentingForceShout', PLAYER_REF)).toEqual([force]);
  }, 60_000);

  it('not the dragons’ Unrelenting Force: a Script effect without an AI score', async () => {
    // DragonUnrelentingForceShout is in MQ304Alduin's spell list; its words' spell
    // DragonVoiceUnrelentingForce is one aimed, hostile Script effect with no AI score: the
    // item has the Script caster and scores nothing, and an item scoring nothing is not weighed.
    const force = shout('DragonUnrelentingForceShout');
    expect(await runtime.actors.spells(ALDUIN)).toContain(force);
    const word = await runtime.magic.item(await spell('DragonVoiceUnrelentingForce'));
    expect(word).toBeDefined();
    if (!word) return;
    expect(await runtime.casting.spellScore(ALDUIN, word, 'attack', PLAYER_REF)).toEqual({
      score: 0,
      caster: 'script',
    });
    expect(await offered('DragonUnrelentingForceShout', PLAYER_REF)).toEqual([]);
    expect(await offered('DragonUnrelentingForceShout', GORMLAITH)).toEqual([]);
  }, 60_000);

  it('not a self spell whose script effect has no AI score: Clear Skies', async () => {
    const word = await runtime.magic.item(await spell('VoiceClearSkiesSelf3'));
    expect(word).toBeDefined();
    if (!word) return;
    expect(await runtime.casting.spellScore(GORMLAITH, word, 'attack', ALDUIN)).toEqual({
      score: 0,
      caster: 'script',
    });
    expect(await offered('ClearSkiesShout', PLAYER_REF)).toEqual([]);
    expect(await offered('ClearSkiesShout', GORMLAITH)).toEqual([]);
  }, 60_000);
});
