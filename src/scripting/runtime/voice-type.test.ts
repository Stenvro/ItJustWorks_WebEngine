import { describe, expect, it } from 'vitest';
import type { PlayerAppearance } from '../../gameplay/chargen.ts';
import { PLAYER_BASE, PLAYER_REF } from './forms.ts';
import { GameState } from './game-state.ts';
import { ScriptRuntime } from './runtime.ts';

const KHAJIIT = 0x13745;
const MALE_EVEN_TONED = 0x13ad2;
const MALE_KHAJIIT = 0x13aec;
const FEMALE_KHAJIIT = 0x13aed;

const appearance: PlayerAppearance = {
  race: KHAJIIT,
  sex: 1,
  weight: 50,
  headParts: [],
  hairColor: undefined,
  skinTone: [1, 1, 1],
  faceMorphs: [],
  faceParts: [0, -1, 0, 0],
  tints: [],
  complexion: undefined,
};

/** A record with one form id field, or a RACE's VTCK pair (male, female). */
function record(type: string, field: string, ids: number[]) {
  const data = new Uint8Array(ids.length * 4);
  const view = new DataView(data.buffer);
  ids.forEach((id, i) => {
    view.setUint32(i * 4, id, true);
  });
  return {
    type,
    fields: { first: (name: string) => (name === field ? data : undefined) },
    formIdAt: (bytes: Uint8Array, offset = 0) =>
      new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset, true),
    formIdField: (name: string) => (name === field ? ids[0] : undefined),
  };
}

/** A leveled cultist (LVLN), the NPC_ it comes down to, and the template that NPC_ takes its
 * traits from (the voice is the template's). */
const LEVELED_CULTIST = 0x4035475;
const PICKED_CULTIST = 0x4035470;
const CULTIST_TEMPLATE = 0x4035471;
const CULTIST_REF = 0xff000864;
const CULTIST_VOICE = 0x4034e60;

/**
 * ScriptRuntime.voiceType on a runtime holding the Player base and the Khajiit race, and a
 * leveled cultist whose traits come from a template.
 */
function voiceOf(state: GameState, reference: number): Promise<number | undefined> {
  const records = new Map<number, unknown>([
    [PLAYER_BASE, record('NPC_', 'VTCK', [MALE_EVEN_TONED])],
    [KHAJIIT, record('RACE', 'VTCK', [MALE_KHAJIIT, FEMALE_KHAJIIT])],
    [LEVELED_CULTIST, record('LVLN', 'LVLO', [PICKED_CULTIST])],
    [PICKED_CULTIST, record('NPC_', 'TPLT', [CULTIST_TEMPLATE])],
    [CULTIST_TEMPLATE, record('NPC_', 'VTCK', [CULTIST_VOICE])],
  ]);
  const bases = new Map([
    [PLAYER_REF, PLAYER_BASE],
    [CULTIST_REF, LEVELED_CULTIST],
  ]);
  const traits = new Map([
    [PLAYER_REF, PLAYER_BASE],
    [CULTIST_REF, CULTIST_TEMPLATE],
  ]);
  const runtime = {
    state,
    forms: { record: (formId: number) => Promise.resolve(records.get(formId)) },
    baseOf: (ref: number) => Promise.resolve(bases.get(ref)),
    actors: {
      info: (ref: number) => {
        const formId = traits.get(ref);
        return Promise.resolve(formId === undefined ? undefined : { traits: { formId } });
      },
    },
  };
  return ScriptRuntime.prototype.voiceType.call(runtime as unknown as ScriptRuntime, reference);
}

describe("the player's voice type", () => {
  it("is the Player base's until the race menu has chosen", async () => {
    expect(await voiceOf(new GameState(), PLAYER_REF)).toBe(MALE_EVEN_TONED);
  });

  it("is the chosen race's default voice for the chosen sex", async () => {
    const state = new GameState();
    state.playerAppearance = appearance;
    expect(await voiceOf(state, PLAYER_REF)).toBe(FEMALE_KHAJIIT);
    state.playerAppearance = { ...appearance, sex: 0 };
    expect(await voiceOf(state, PLAYER_REF)).toBe(MALE_KHAJIIT);
  });
});

describe("an actor's voice type", () => {
  // Found 2026-11-18: the Dragonborn cultists' ambush (DLC2CultistAmbush) has dialogue only for
  // their voice type, and its leveled actors had none: the voice was read off the LVLN.
  it('is the voice of the NPC_ that gives its traits: a leveled pick, through its template', async () => {
    expect(await voiceOf(new GameState(), CULTIST_REF)).toBe(CULTIST_VOICE);
  });
});
