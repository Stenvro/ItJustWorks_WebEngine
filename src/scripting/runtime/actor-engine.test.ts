import { describe, expect, it } from 'vitest';
import type { PlayerAppearance } from '../../gameplay/chargen.ts';
import { ActorEngine } from './actor-engine.ts';
import { PLAYER_BASE, PLAYER_REF } from './forms.ts';
import { GameState } from './game-state.ts';
import type { ScriptRuntime } from './runtime.ts';

const NORD = 0x13746;
const ARGONIAN = 0x13740;
const WEREWOLF = 0xcdd84;

const appearance: PlayerAppearance = {
  race: ARGONIAN,
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

/** A runtime with the game state and a Player record named "Prisoner". */
function engine(state: GameState): ActorEngine {
  return new ActorEngine({
    state,
    forms: {
      record: (formId: number) =>
        Promise.resolve(
          formId === PLAYER_BASE ? { type: 'NPC_', text: () => 'Prisoner' } : undefined,
        ),
    },
  } as unknown as ScriptRuntime);
}

describe("the player's race, sex and name", () => {
  it('are the race menu choices once made', async () => {
    const state = new GameState();
    state.playerAppearance = appearance;
    state.playerName = 'Big E';
    const actors = engine(state);
    expect(await actors.raceOf(PLAYER_REF)).toBe(ARGONIAN);
    expect(await actors.baseRace(PLAYER_BASE)).toBe(ARGONIAN);
    expect(await actors.baseSex(PLAYER_BASE)).toBe(1);
    expect(await actors.isFemale(PLAYER_REF)).toBe(true);
    expect(await actors.playerName()).toBe('Big E');
  });

  it("keep the base's race when Actor.SetRace changes the actor's", async () => {
    const state = new GameState();
    state.playerAppearance = { ...appearance, race: NORD };
    state.actor(PLAYER_REF).race = WEREWOLF;
    const actors = engine(state);
    expect(await actors.raceOf(PLAYER_REF)).toBe(WEREWOLF);
    expect(await actors.baseRace(PLAYER_BASE)).toBe(NORD);
  });

  it("take the Player record's name before one is chosen", async () => {
    expect(await engine(new GameState()).playerName()).toBe('Prisoner');
  });
});
