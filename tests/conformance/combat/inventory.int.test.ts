// Conformance: combat inventory (engine map: Combat > Inventory) on the local game data: the shout
// in an actor's voice as one of its options against a target.
//
// Sources: the game data (AlduinFirestormShout's word DragonVoiceStormCall, a self spell with the
// hostile DragonVoiceStormCallEffect and VoiceStormCallEmptyAIScriptEffect, "Script Effect for AI
// use of Storm Call"; Clear Skies' VoiceClearSkiesSelf1-3 without a hostile effect); the rule that
// a word is an attack by its spell's hostile effect is inferred (docs/ai.md, Shouts and the
// voice's recovery; TODO(M13)).
//
// Ours: src/shell/combat-casting.ts, src/gameplay/combat/spell-score.ts (shoutAttacks), in a
// script runtime without a world. Skipped without game data.

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

  it('a self spell with a hostile area: Firestorm and Storm Call', async () => {
    // AlduinFirestormShout's words are DragonVoiceStormCall: self, with the hostile
    // DragonVoiceStormCallEffect (a 600-unit Stagger) and VoiceStormCallEmptyAIScriptEffect.
    const firestorm = shout('AlduinFirestormShout');
    expect(await shoutOptions('AlduinFirestormShout', PLAYER_REF)).toEqual([firestorm]);
    expect(await shoutOptions('AlduinFirestormShout', GORMLAITH)).toEqual([firestorm]);
    // Storm Call's words (VoiceStormCall1-3): self, a hostile 150-unit Stagger and the storm's
    // hazard (CallStormHazard01) on the shouter.
    expect(await shoutOptions('StormCallShout', GORMLAITH)).toEqual([shout('StormCallShout')]);
  }, 60_000);

  it('an aimed one: Unrelenting Force', async () => {
    const force = shout('UnrelentingForceShout');
    expect(await shoutOptions('UnrelentingForceShout', PLAYER_REF)).toEqual([force]);
  }, 60_000);

  it('not a self spell without a hostile effect: Clear Skies', async () => {
    expect(await shoutOptions('ClearSkiesShout', PLAYER_REF)).toEqual([]);
    expect(await shoutOptions('ClearSkiesShout', GORMLAITH)).toEqual([]);
  }, 60_000);
});
