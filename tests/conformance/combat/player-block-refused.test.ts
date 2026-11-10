// The player's block held while the graph refuses it (a stagger, a jump in the air, a sprint, a
// left hand whose tree has no blockStart): src/shell/player-combat.ts asks the graph again once
// what refused it changes (the attack, the stagger or the jump ended, the sprint stopped, the
// graph left its state, the gear changed) or BLOCK_RETRY_SECONDS passed, not on every frame the
// button is held. Our own rule of work (the original's input handling is not documented): a unit
// check with fakes, beside the headless block checks of player-block.test.ts.

import { describe, expect, it } from 'vitest';
import { newCombatState, WeaponState } from '../../../src/gameplay/combat/combat-state.ts';
import { WeaponType } from '../../../src/world/item-records.ts';
import type { ActorCombat } from '../../../src/shell/actor-combat.ts';
import type { Player } from '../../../src/shell/player.ts';
import { BLOCK_RETRY_SECONDS, PlayerCombat } from '../../../src/shell/player-combat.ts';

const LEFT = 'Left Attack/Block';

/** A player with a sword drawn, Left Attack/Block pressed and held, and a graph that refuses. */
function setup(): {
  combat: PlayerCombat;
  state: ReturnType<typeof newCombatState>;
  body: { grounded: boolean; sprinting: boolean; graph: string };
  asked: () => number;
  accept: (on: boolean) => void;
  flush: () => Promise<void>;
  frames: (count: number) => Promise<void>;
  release: () => void;
  press: () => void;
} {
  const state = newCombatState();
  state.weapon = WeaponState.drawn;
  const body = { grounded: true, sprinting: false, graph: 'Root=Locomotion' };
  let blocks = 0;
  let taken = false;
  const pressed = new Set<string>([LEFT]);
  const held = new Set<string>([LEFT]);
  const fake = {
    combatState: () => state,
    hands: () => ({ right: WeaponType.oneHandSword, left: undefined, shield: false }),
    graphStates: () => body.graph,
    block: (_reference: number, on: boolean) => {
      if (on) blocks++;
      return Promise.resolve(on ? taken : true);
    },
    attack: () => Promise.resolve(false),
    release: () => Promise.resolve(),
    weaponOf: () => undefined,
    toggleLevitation: () => false,
  } as unknown as ActorCombat;
  const player = {
    takePressed: (name: string) => pressed.delete(name),
    isHeld: (name: string) => held.has(name),
    bowZoom: 1,
    graphBowZoom: undefined,
    character: {
      get grounded() {
        return body.grounded;
      },
    },
    get motion() {
      return {
        inputX: 0,
        inputY: body.sprinting ? 1 : 0,
        moving: body.sprinting,
        running: body.sprinting,
        sprinting: body.sprinting,
      };
    },
  } as unknown as Player;
  const combat = new PlayerCombat(fake, player, () => true);
  // The block's answer and its then / catch / finally: a few microtasks.
  const flush = async (): Promise<void> => {
    for (let tick = 0; tick < 6; tick++) await Promise.resolve();
  };
  return {
    combat,
    state,
    body,
    asked: () => blocks,
    accept: (on) => {
      taken = on;
    },
    flush,
    frames: async (count) => {
      for (let frame = 0; frame < count; frame++) {
        combat.frame(1 / 60);
        await flush();
      }
    },
    release: () => held.delete(LEFT),
    press: () => {
      pressed.add(LEFT);
      held.add(LEFT);
    },
  };
}

/** Frames within one BLOCK_RETRY_SECONDS (the low-rate retry does not come in them). */
const WITHIN_RETRY = Math.floor(BLOCK_RETRY_SECONDS * 60) - 2;

describe('a block held that the graph refuses', () => {
  it('is asked again once what refused it changes, not every frame', async () => {
    const { combat, state, asked, accept, flush, frames } = setup();
    // Staggered: the graph takes no block.
    state.staggered = true;
    await frames(WITHIN_RETRY);
    expect(asked()).toBe(1);
    // The stagger ends: one try more, and the block goes up.
    state.staggered = false;
    accept(true);
    combat.frame(1 / 60);
    await flush();
    expect(asked()).toBe(2);
    state.blocking = true;
    for (let frame = 0; frame < 60; frame++) combat.frame(1 / 60);
    expect(asked()).toBe(2);
  });

  it('is asked at a low rate while nothing it watches changes', async () => {
    const { asked, frames } = setup();
    // Two seconds held, refused throughout: one try at the press, then one every
    // BLOCK_RETRY_SECONDS (a left hand whose graph has no block start, the combat not ready).
    await frames(120);
    const expected = 1 + Math.floor(2 / BLOCK_RETRY_SECONDS);
    expect(asked()).toBeGreaterThanOrEqual(expected - 1);
    expect(asked()).toBeLessThanOrEqual(expected);
    expect(asked()).toBeLessThan(10);
  });

  it('held through a jump goes up as the player lands', async () => {
    const { body, asked, accept, frames } = setup();
    // In the air: the graph's JumpRoot takes no ActionLeftAttack.
    body.grounded = false;
    body.graph = 'Root=JumpRoot|JumpRoot=JumpFall';
    await frames(WITHIN_RETRY);
    expect(asked()).toBe(1);
    // Landed (the combat state is the same as in the air): the block is asked at once.
    body.grounded = true;
    body.graph = 'Root=Locomotion';
    accept(true);
    await frames(1);
    expect(asked()).toBe(2);
  });

  it('held through a jump goes up as the graph leaves its landing', async () => {
    const { body, asked, accept, frames } = setup();
    // On the ground again, the graph still in its landing (JumpLand): refused.
    body.graph = 'Root=JumpRoot|JumpRoot=JumpLand';
    await frames(WITHIN_RETRY);
    expect(asked()).toBe(1);
    body.graph = 'Root=Locomotion';
    accept(true);
    await frames(1);
    expect(asked()).toBe(2);
  });

  it('held through a sprint goes up as the sprint stops', async () => {
    const { body, asked, accept, frames } = setup();
    body.sprinting = true;
    await frames(WITHIN_RETRY);
    expect(asked()).toBe(1);
    body.sprinting = false;
    accept(true);
    await frames(1);
    expect(asked()).toBe(2);
  });

  it('is asked at once by a new press after a release', async () => {
    const { combat, asked, flush, release, press } = setup();
    combat.frame(1 / 60);
    await flush();
    release();
    combat.frame(1 / 60);
    press();
    combat.frame(1 / 60);
    await flush();
    expect(asked()).toBe(2);
  });
});
