// The player's death in the simulation (docs/ai.md, "Combat": The player's death): a fall from
// high up and a blow both kill them. Dead, their keys move them no more, their health does not
// come back, the death events go out (OnDying, OnDeath) and fPlayerDeathReloadTime later the
// reload comes due. Found 2026-10-29: a player who fell to their death walked on once a load
// door had taken them into a new cell (the new play knew nothing of the death); the death is
// now the runtime's and every play shows it. An essential player (a script's alias: a brawl)
// bleeds out instead: their keys do nothing until they get up.

import { afterEach, describe, expect, it } from 'vitest';
import { ActorValue } from '../src/world/actor-values.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const TAMRIEL = 0x3c;
const NAZEEM = 0x00013bbf;
/** The Player actor base (Skyrim.esm). */
const PLAYER_BASE = 0x7;

/** A quiet spot by Whiterun's walls (the falls' case's). */
function open(): Promise<Sim> {
  return openSim({ exterior: { world: TAMRIEL, cell: [4, -11] }, hour: 10, gridRadius: 1 });
}

async function health(sim: Sim): Promise<number> {
  return (await sim.runtime.actors.value(PLAYER_REF, ActorValue.health)).current;
}

/** How far across the player gets holding Forward for `seconds`. */
async function walked(sim: Sim, seconds: number): Promise<number> {
  const [x, y] = sim.world.player.feet;
  sim.world.press('Forward', true);
  try {
    await sim.step(seconds);
  } finally {
    sim.world.press('Forward', false);
  }
  const [x2, y2] = sim.world.player.feet;
  return Math.hypot(x2 - x, y2 - y);
}

/** The player's death events so far: dying (OnDying) and dead (OnDeath), with the killer. */
function playerDeaths(sim: Sim): { readonly dead: boolean; readonly killer?: number }[] {
  return sim.events('death').filter((event) => event.actor === PLAYER_REF);
}

describe.skipIf(!hasGamedata())('the player’s death in the simulation', () => {
  let sim: Sim | undefined;
  afterEach(async () => {
    await sim?.close();
    sim = undefined;
  });

  it('dies from a fall: no moving, no regeneration, the death events, the reload due', async () => {
    const s = await open();
    sim = s;
    await s.step(2);
    expect(await walked(s, 1)).toBeGreaterThan(50);
    const feet = s.world.player.feet;
    await s.moveTo([feet[0], feet[1], feet[2] + 6000]);
    expect(await s.until(() => s.world.playerView?.play.dead === true, 15)).toBe(true);
    expect(await s.runtime.actors.isDead(PLAYER_REF)).toBe(true);
    expect(await health(s)).toBeLessThanOrEqual(0);
    expect(playerDeaths(s).map((event) => event.dead)).toEqual([false, true]);
    // Dead: Forward moves them no more, and their health stays gone.
    await s.step(1);
    expect(await walked(s, 2)).toBeLessThan(1);
    expect(await s.runtime.actors.isDead(PLAYER_REF)).toBe(true);
    expect(s.world.stage.playerDeath.reloadDue).toBe(false);
    await s.step(10);
    expect(await health(s)).toBeLessThanOrEqual(0);
    // fPlayerDeathReloadTime (5 s) after the death the reload is due.
    expect(s.world.stage.playerDeath.reloadDue).toBe(true);
    // A new play (a load door, fast travel, a script's move to another place) shows them dead.
    await s.world.openExterior(TAMRIEL, { cell: [5, -11] });
    await s.step(0.5);
    expect(s.world.playerView?.play.dead).toBe(true);
    expect(await walked(s, 2)).toBeLessThan(1);
  }, 300_000);

  it('dies from a blow, by whoever dealt it', async () => {
    const s = await open();
    sim = s;
    await s.step(2);
    const nazeem = await s.place(NAZEEM, PLAYER_REF);
    await s.runtime.actors.damage(PLAYER_REF, ActorValue.health, 1000, nazeem);
    await s.step(0.5);
    expect(s.world.playerView?.play.dead).toBe(true);
    expect(playerDeaths(s)).toEqual([
      { actor: PLAYER_REF, killer: nazeem, dead: false },
      { actor: PLAYER_REF, killer: nazeem, dead: true },
    ]);
    expect(await walked(s, 2)).toBeLessThan(1);
    await s.step(10);
    expect(await health(s)).toBeLessThanOrEqual(0);
  }, 300_000);

  it('bleeds out instead where a script made them essential, then gets up', async () => {
    const s = await open();
    sim = s;
    await s.step(2);
    // Actor.SetEssential on the player's base, as a brawl's alias makes them.
    s.runtime.state.actorBase(PLAYER_BASE).essential = true;
    await s.runtime.actors.damage(PLAYER_REF, ActorValue.health, 1000);
    await s.step(0.5);
    const play = s.world.playerView?.play;
    expect(await s.runtime.actors.isDead(PLAYER_REF)).toBe(false);
    expect(play?.dead).toBe(false);
    expect(play?.bleedingOut).toBe(true);
    expect(s.events('enterBleedout').some((event) => event.actor === PLAYER_REF)).toBe(true);
    expect(await walked(s, 2)).toBeLessThan(1);
    // Their health comes back while they are down, and they get up.
    expect(await s.until(() => play?.bleedingOut === false, 90)).toBe(true);
    expect(await health(s)).toBeGreaterThan(0);
    // Their graph's getting up (BleedOut_TransOut) holds them a moment, then they walk.
    await s.step(3);
    expect(await walked(s, 1)).toBeGreaterThan(50);
  }, 300_000);
});
