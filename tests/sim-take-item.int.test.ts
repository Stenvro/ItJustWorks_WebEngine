// Integration test: the player takes an item lying in the world by activating it (the
// crosshair's Take), on the headless simulation. Skipped without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, openSim, PLAYER_REF } from './helpers/sim.ts';

/** Korvanjund02, its Ebony Claw (dunKorvanjundEbonyDragonClaw) where it lies, and its base. */
const KORVANJUND_02 = 0x2954d;
const CLAW = 0x5af49;
const CLAW_BASE = 0x5af48;

describe.skipIf(!hasGamedata())('Taking an item', () => {
  // Found 2026-11-18 (The Jagged Crown): the simulation's player activated the Ebony Claw and it
  // stayed where it lay; Play's object uses take it, and the headless world had none.
  it('puts an item the player activates into their inventory and out of the world', async () => {
    const sim = await openSim({
      interior: KORVANJUND_02,
      arrival: { position: [27, 3480, -660], heading: 0 },
    });
    try {
      await sim.step(2);
      expect(await sim.distance(CLAW, PLAYER_REF)).toBeLessThan(150);
      expect(await sim.runtime.itemCount(PLAYER_REF, CLAW_BASE)).toBe(0);
      expect(sim.activate(CLAW)).toBe(true);
      await sim.step(1);
      expect(await sim.runtime.itemCount(PLAYER_REF, CLAW_BASE)).toBe(1);
      expect(sim.runtime.state.references.get(CLAW)?.container?.holder).toBe(PLAYER_REF);
      expect(await sim.enabled(CLAW)).toBe(false);
    } finally {
      await sim.close();
    }
  }, 300_000);
});
