// Whiterun's gate guards (src/shell/actors-away.ts, #locationActors): two temporary actors placed
// in WhiterunWorld (by the barracks), in no quest alias, whose packages (WhiterunGateGuardForcegreet,
// WhiterunGateGuard2Travel) wait by the gate's other side in Tamriel. WhiterunLocation lists them
// (CWSoldier references), and the plains outside the gate belong to it: the actors away ask them
// as the player comes there, so they stand by the gate, and the first comes to stop the player.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const TAMRIEL = 0x3c;
/** GuardWhiterunImperialGate1REF and 2REF (cell 6,0 of WhiterunWorld). */
const GATE_GUARD = 0xdc9e4;
const GATE_GUARD_2 = 0xdc9e5;
/** WhiterunGateGuard: the forcegreet package's wait marker, outside the gate in Tamriel. */
const WAIT_MARKER = 0xd1986;
/** DialogueWhiterunGuardGateStopBranchTopic: the forcegreet's topic. */
const GATE_STOP_TOPIC = 0xd197a;

describe.skipIf(!hasGamedata())('Whiterun’s gate guards', () => {
  let sim: Sim;
  beforeAll(async () => {
    // On the road up to the gate, some 3,500 units below it.
    sim = await openSim({
      exterior: { world: TAMRIEL, cell: [4, -2] },
      arrival: { position: [16638, -9647, -4600], heading: 0 },
      hour: 10,
    });
  }, 180_000);
  afterAll(async () => {
    await sim.close();
  });

  it('stand by the gate in Tamriel as the player comes there', async () => {
    const away = sim.world.stage.away;
    // The actors away are asked as the player comes into the space.
    await sim.until(() => !away.scheduling.busy && away.scheduling.last !== undefined, 20);
    await sim.step(1);
    for (const guard of [GATE_GUARD, GATE_GUARD_2]) {
      expect((await sim.runtime.placement(guard))?.world).toBe(TAMRIEL);
      expect(sim.actor(guard)).toBeDefined();
    }
    expect(await sim.distance(GATE_GUARD, WAIT_MARKER)).toBeLessThan(200);
  }, 60_000);

  it('the first comes to the player in his trigger and stops them with the city closed', async () => {
    const marker = await sim.position(WAIT_MARKER);
    if (!marker) throw new Error('no wait marker');
    // Into the forcegreet's trigger (2,000 units round the marker), on the road below the gate.
    const near: [number, number, number] = [marker[0] - 700, marker[1] - 700, marker[2]];
    const ground = sim.world.navmeshes.nearest?.(near, 1024);
    await sim.moveTo(ground ? [ground[0], ground[1], ground[2]] : near);
    const topics = await sim.listen(GATE_GUARD, 60);
    // The conversation opens with DialogueWhiterunGuardGateStopBranchTopic ("Halt! City's
    // closed with the dragons about."), then the player's ways in.
    const opened = sim.menus().filter((menu) => menu.menu === 'Dialogue Menu');
    expect(opened.at(-1)).toMatchObject({ reference: GATE_GUARD, opening: GATE_STOP_TOPIC });
    expect(topics).toContain("I'll come back later.");
    expect(await sim.distance(GATE_GUARD, PLAYER_REF)).toBeLessThan(200);
  }, 120_000);
});
