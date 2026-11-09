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

/** ScriptRuntime.voiceType on a runtime holding the Player base and the Khajiit race. */
function voiceOf(state: GameState, reference: number): Promise<number | undefined> {
  const records = new Map<number, unknown>([
    [PLAYER_BASE, record('NPC_', 'VTCK', [MALE_EVEN_TONED])],
    [KHAJIIT, record('RACE', 'VTCK', [MALE_KHAJIIT, FEMALE_KHAJIIT])],
  ]);
  const runtime = {
    state,
    forms: { record: (formId: number) => Promise.resolve(records.get(formId)) },
    baseOf: (ref: number) => Promise.resolve(ref === PLAYER_REF ? PLAYER_BASE : undefined),
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
