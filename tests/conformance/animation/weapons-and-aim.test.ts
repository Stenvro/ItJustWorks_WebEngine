// Conformance: weapons and aim (engine map: Animation and bodies > Weapons and aim): the weapon
// events of the graphs and the aim of shots.
//
// Sources:
// - The data: meshes\responses\actorresponse.txt gives the weapons' events their handlers
//   (weaponSwing : WeaponRightSwingHandler, weaponLeftSwing : WeaponLeftSwingHandler, weaponDraw
//   : RightHandWeaponDrawHandler, BeginWeaponDraw : WeaponBeginDrawRightHandler, arrowAttach,
//   arrowRelease, BowDrawn, BowRelease).
// - The engine, observed in the original: PitchOverrideStart / End set a flag of the player's camera that
//   the aim reads (docs/animation.md, "Graph events").

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

const WEAPON_EVENTS: readonly (readonly [string, string])[] = [
  ['weaponSwing', 'WeaponRightSwingHandler'],
  ['weaponLeftSwing', 'WeaponLeftSwingHandler'],
  ['weaponDraw', 'RightHandWeaponDrawHandler'],
  ['weaponSheathe', 'RightHandWeaponSheatheHandler'],
  ['BeginWeaponDraw', 'WeaponBeginDrawRightHandler'],
  ['BeginWeaponSheathe', 'WeaponBeginSheatheRightHandler'],
  ['arrowAttach', 'ArrowAttachHandler'],
  ['arrowRelease', 'ArrowReleaseHandler'],
  ['BowDrawn', 'BowDrawnHandler'],
  ['BowRelease', 'BowReleaseHandler'],
];

describe.skipIf(!hasGamedata())('the weapons’ graph events (data)', () => {
  let sim: Sim;
  beforeAll(async () => {
    sim = await openSim();
    await sim.world.session.animation.animationData();
    // The dispatch reads the response files as the session's animation data comes in.
    await sim.step(0.1);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  for (const [event, handler] of WEAPON_EVENTS) {
    it(`${event} goes to ${handler}, which is answered`, () => {
      const dispatch = sim.world.stage.graphEvents.dispatch;
      expect(dispatch.handlerOf(event, false)).toBe(handler);
      expect(dispatch.answered(handler)).toBe(true);
    });
  }
});

describe('weapons and aim (todo)', () => {
  it.todo('the player’s casting pitch: the aim reads the camera’s PitchOverride flag  [original]');
  it.todo('a crossbow’s bolt leaves from its launch node (the weapon model’s node)  [original]');
  it.todo('the arms aim along an aimed cast (BSDirectAtModifier) by the engine’s target  [original]');
});
