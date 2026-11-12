// Conformance: combat inventory (engine map: Combat > Inventory) on the local game data: the shout
// in an actor's voice as one of its options against a target.
//
// Sources: the game data (AlduinFirestormShout's word DragonVoiceStormCall, a self spell with the
// hostile DragonVoiceStormCallEffect, the storm's hazard and VoiceStormCallEmptyAIScriptEffect,
// "Script Effect for AI use of Storm Call": a Script effect with an AI score of 50 and an AI delay
// of 60 s; Clear Skies' VoiceClearSkiesSelf1-3, one script effect without an AI score). Observed
// in the original: a shout's item is made as a spell's, by the spell's score and its caster; a
// self spell's hostile Stagger and its hazard are of no kind, a Script effect adds its AI score
// and gives the Script caster, which casts once its effect's AI delay has passed since its last
// cast and not while the one the spell lands on carries it (docs/ai.md, Shouts and the voice's
// recovery).
//
// Ours: src/shell/combat-casting.ts, src/gameplay/combat/spell-score.ts (combatSpellScore,
// shoutOffered, scriptCasterReady), in a script runtime without a world. Skipped without game
// data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAYER_REF } from '../../../src/scripting/runtime/forms.ts';
import { ScriptRuntime } from '../../../src/scripting/runtime/runtime.ts';
import { ScriptLibrary } from '../../../src/scripting/script-library.ts';
import { combatCasting } from '../../../src/shell/combat-casting.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../../../tools/gamedata-path.ts';

/** Skyrim.esm: MQ304Alduin, the Alduin of Sovngarde (MQ305's Alduin alias). */
const ALDUIN = 0x4e9bd;
/** GormlaithGoldenHilt, one of the heroes who fight him there. */
const GORMLAITH = 0xcd9f8;

describe.skipIf(!hasGamedata())('the combat AI shouts on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let runtime: ScriptRuntime;
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
  /** The shout options the combat inventory offers Alduin against a target, a shout in his voice. */
  const shoutOptions = async (
    editorId: string,
    target: number,
  ): Promise<(number | undefined)[]> => {
    expect(await runtime.equipment.equipShout(ALDUIN, shout(editorId))).toBe(true);
    expect((await runtime.equipment.of(ALDUIN)).voice).toBe(shout(editorId));
    const casting = combatCasting({ scriptsReady: runtime }, () => undefined);
    const options = await casting.options(ALDUIN, target);
    return options.filter((one) => one.kind === 'shout').map((one) => one.id);
  };

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
    expect(await shoutOptions('AlduinFirestormShout', PLAYER_REF)).toEqual([firestorm]);
    expect(await shoutOptions('AlduinFirestormShout', GORMLAITH)).toEqual([firestorm]);
    // Storm Call's words (VoiceStormCall1-3): self, a hostile 150-unit Stagger, the storm (a
    // script effect, or its hazard CallStormHazard01, on the shouter) and the same script effect
    // for the AI.
    expect(await shoutOptions('StormCallShout', GORMLAITH)).toEqual([shout('StormCallShout')]);
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

  it('not again while the storm is on the shouter', async () => {
    const firestorm = shout('AlduinFirestormShout');
    const word = await runtime.magic.item(await spell('DragonVoiceStormCall'));
    expect(word).toBeDefined();
    if (!word) return;
    expect(await runtime.casting.scriptCastReady(ALDUIN, word, PLAYER_REF)).toBe(true);
    // The shout lands on Alduin: its script effect and the storm last 30 s on him.
    expect(await runtime.magic.apply(word, ALDUIN, { caster: ALDUIN })).toBeGreaterThan(0);
    expect(runtime.magic.effectsOn(ALDUIN).some(([, entry]) => entry.item === word.formId)).toBe(
      true,
    );
    expect(await runtime.casting.scriptCastReady(ALDUIN, word, PLAYER_REF)).toBe(false);
    expect(await shoutOptions('AlduinFirestormShout', PLAYER_REF)).toEqual([]);
    // Once they have run out, it is his option again.
    for (let second = 0; second < 32; second++) {
      for (let frame = 0; frame < 10; frame++) runtime.update(0.1, 0);
      await runtime.vm.idle();
    }
    expect(runtime.magic.effectsOn(ALDUIN).some(([, entry]) => entry.item === word.formId)).toBe(
      false,
    );
    expect(await shoutOptions('AlduinFirestormShout', PLAYER_REF)).toEqual([firestorm]);
  }, 120_000);

  it('an aimed one: Unrelenting Force', async () => {
    const force = shout('UnrelentingForceShout');
    expect(await shoutOptions('UnrelentingForceShout', PLAYER_REF)).toEqual([force]);
  }, 60_000);

  it('not a self spell whose script effect has no AI score: Clear Skies', async () => {
    expect(await shoutOptions('ClearSkiesShout', PLAYER_REF)).toEqual([]);
    expect(await shoutOptions('ClearSkiesShout', GORMLAITH)).toEqual([]);
  }, 60_000);
});
