import { describe, expect, it } from 'vitest';
import type { PlayerAppearance } from '../../gameplay/chargen.ts';
import { ActorValue } from '../../world/actor-values.ts';
import { AliasFlag } from '../../world/quest-records.ts';
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

/** What a death tells the world and the scripts, in order. */
interface DeathLog {
  readonly calls: string[];
  readonly runtime: { godMode: boolean };
}

/**
 * A runtime for the player's death: the player's health 100, an alias (quest 0x100, alias 1)
 * holding them, essential if `essentialAlias`.
 */
function dyingEngine(essentialAlias = false): { actors: ActorEngine; log: DeathLog } {
  const state = new GameState();
  const calls: string[] = [];
  const runtime = {
    state,
    godMode: false,
    forms: {
      record: () => Promise.resolve(undefined),
      alias: () => Promise.resolve({ flags: essentialAlias ? AliasFlag.essential : 0 }),
    },
    baseOf: () => Promise.resolve(undefined),
    indexedFlags: () => undefined,
    aliasesHolding: () => [{ quest: 0x100, alias: 1 }],
    actorHandle: (reference: number) => `actor ${reference.toString(16)}`,
    world: {
      killed: (actor: number, killer: number | undefined) => {
        calls.push(`killed ${actor.toString(16)} by ${String(killer?.toString(16))}`);
      },
      bleedout: (actor: number) => {
        calls.push(`bleedout ${actor.toString(16)}`);
      },
    },
    magic: { died: () => Promise.resolve() },
    crime: { killed: () => Promise.resolve() },
    // The runtime sends an actor's events to it and its aliases (ScriptRuntime.sendEvent).
    sendEvent: (target: number, event: string, args: readonly unknown[]) => {
      calls.push(`${event} ${target.toString(16)} (${String(args[0])})`);
      return Promise.resolve();
    },
  };
  const actors = new ActorEngine(runtime as unknown as ScriptRuntime);
  actors.setBase(PLAYER_REF, ActorValue.health, 100);
  return { actors, log: { calls, runtime } };
}

describe("the player's death", () => {
  it('kills the player at no health: the world shows it, OnDying then OnDeath', async () => {
    const { actors, log } = dyingEngine();
    await actors.damage(PLAYER_REF, ActorValue.health, 60, 0x1234);
    expect(await actors.isDead(PLAYER_REF)).toBe(false);
    await actors.damage(PLAYER_REF, ActorValue.health, 60, 0x1234);
    expect(await actors.isDead(PLAYER_REF)).toBe(true);
    expect(log.calls).toEqual([
      'killed 14 by 1234',
      'OnDying 14 (actor 1234)',
      'OnDeath 14 (actor 1234)',
    ]);
    expect((await actors.value(PLAYER_REF, ActorValue.health)).current).toBeLessThanOrEqual(0);
    // Dead once: more blows do nothing.
    await actors.damage(PLAYER_REF, ActorValue.health, 10, 0x1234);
    expect(log.calls).toHaveLength(3);
  });

  it('kills the player by a script (Actor.Kill), without a killer', async () => {
    const { actors, log } = dyingEngine();
    await actors.scriptKill(PLAYER_REF, undefined);
    expect(await actors.isDead(PLAYER_REF)).toBe(true);
    expect(log.calls).toEqual(['killed 14 by undefined', 'OnDying 14 (null)', 'OnDeath 14 (null)']);
  });

  it('lets an essential player (an alias) bleed out instead, from blows and Kill', async () => {
    const blows = dyingEngine(true);
    await blows.actors.damage(PLAYER_REF, ActorValue.health, 200, 0x1234);
    expect(await blows.actors.isDead(PLAYER_REF)).toBe(false);
    expect(blows.log.calls).toEqual(['bleedout 14']);
    const kill = dyingEngine(true);
    await kill.actors.scriptKill(PLAYER_REF, 0x1234);
    expect(await kill.actors.isDead(PLAYER_REF)).toBe(false);
    expect(kill.log.calls).toEqual(['bleedout 14']);
    // KillEssential: Kill once Essential is cleared (here: the engine's kill).
    await kill.actors.kill(PLAYER_REF, 0x1234);
    expect(await kill.actors.isDead(PLAYER_REF)).toBe(true);
  });

  it('keeps the player from harm and death in god mode', async () => {
    const { actors, log } = dyingEngine();
    log.runtime.godMode = true;
    await actors.damage(PLAYER_REF, ActorValue.health, 500, 0x1234);
    await actors.damage(PLAYER_REF, ActorValue.stamina, 50);
    expect((await actors.value(PLAYER_REF, ActorValue.health)).current).toBe(100);
    await actors.scriptKill(PLAYER_REF, undefined);
    expect(await actors.isDead(PLAYER_REF)).toBe(false);
    expect(log.calls).toEqual([]);
    log.runtime.godMode = false;
    await actors.damage(PLAYER_REF, ActorValue.health, 500, 0x1234);
    expect(await actors.isDead(PLAYER_REF)).toBe(true);
  });
});
