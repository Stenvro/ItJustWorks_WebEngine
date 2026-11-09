// The player's block held while the graph refuses it (a stagger, a left hand whose tree has no
// blockStart): src/shell/player-combat.ts asks the graph again only once what refused it changes
// (the attack or the stagger ended, the gear changed), not on every frame the button is held.
// Our own rule of work (the original's input handling is not documented): a unit check with fakes,
// beside the headless block checks of player-block.test.ts.

import { describe, expect, it } from 'vitest';
import { newCombatState, WeaponState } from '../../../src/gameplay/combat/combat-state.ts';
import { WeaponType } from '../../../src/world/item-records.ts';
import type { ActorCombat } from '../../../src/shell/actor-combat.ts';
import type { Player } from '../../../src/shell/player.ts';
import { PlayerCombat } from '../../../src/shell/player-combat.ts';

const LEFT = 'Left Attack/Block';

/** A player with a sword drawn, Left Attack/Block pressed and held, and a graph that refuses. */
function setup(): {
  combat: PlayerCombat;
  state: ReturnType<typeof newCombatState>;
  asked: () => number;
  accept: (on: boolean) => void;
  flush: () => Promise<void>;
  release: () => void;
  press: () => void;
} {
  const state = newCombatState();
  state.weapon = WeaponState.drawn;
  let blocks = 0;
  let taken = false;
  const pressed = new Set<string>([LEFT]);
  const held = new Set<string>([LEFT]);
  const fake = {
    combatState: () => state,
    hands: () => ({ right: WeaponType.oneHandSword, left: undefined, shield: false }),
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
  } as unknown as Player;
  return {
    combat: new PlayerCombat(fake, player, () => true),
    state,
    asked: () => blocks,
    accept: (on) => {
      taken = on;
    },
    // The block's answer and its then / catch / finally: a few microtasks.
    flush: async () => {
      for (let tick = 0; tick < 6; tick++) await Promise.resolve();
    },
    release: () => held.delete(LEFT),
    press: () => {
      pressed.add(LEFT);
      held.add(LEFT);
    },
  };
}

describe('a block held that the graph refuses', () => {
  it('is asked again only once what refused it changes, not every frame', async () => {
    const { combat, state, asked, accept, flush } = setup();
    // Staggered: the graph takes no block.
    state.staggered = true;
    for (let frame = 0; frame < 120; frame++) {
      combat.frame(1 / 60);
      await flush();
    }
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

  it('a left hand whose graph has no block start is asked once while held', async () => {
    const { combat, asked, flush } = setup();
    for (let frame = 0; frame < 120; frame++) {
      combat.frame(1 / 60);
      await flush();
    }
    expect(asked()).toBe(1);
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
