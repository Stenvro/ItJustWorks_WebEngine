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
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

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

// A bandit mage placed in the Bannered Mare (its patrons dead, out of the way) fights the player:
// while it casts its aimed spells, the magic graph's BSDirectAtModifier_Magic (CastingState,
// userInfo 2, enabled by IsNPC) turns its spine toward the engine's aim for spells (the point
// its cast goes to: src/shell/actor-casting.ts aimArms) and says so in bAimActive.
const BANNERED_MARE = 0x1605e;

describe.skipIf(!hasGamedata())('an NPC’s aimed cast (headless simulation)', () => {
  let sim: Sim;
  const aimed: { active: number; heading: number; pitch: number }[] = [];
  let casts = 0;

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(1);
    for (const actor of sim.actors()) {
      if (actor.reference !== PLAYER_REF) await sim.kill(actor.reference);
    }
    const feet = (await sim.position(PLAYER_REF)) ?? [0, 0, 0];
    await sim.moveTo([feet[0] + 300, feet[1], feet[2]]);
    const mage = await sim.place(await sim.formId('NPC_', 'EncBandit01MagicNordM'), PLAYER_REF);
    await sim.moveTo(feet);
    // The player stands and takes it (the fight is the mage's).
    sim.runtime.godMode = true;
    sim.world.stage.combat.startCombat(mage, PLAYER_REF);
    for (let i = 0; i < 300; i++) {
      await sim.step(0.05);
      const graph = sim.actor(mage)?.placed.behavior;
      if (!graph) continue;
      aimed.push({
        active: graph.variable('bAimActive') ?? 0,
        heading: graph.variable('AimHeadingCurrent') ?? 0,
        pitch: graph.variable('AimPitchCurrent') ?? 0,
      });
    }
    casts = sim.world.log.game('spellCast').filter((cast) => cast.caster === mage).length;
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('the arms aim along an aimed cast (BSDirectAtModifier) by the engine’s target  [original]', () => {
    expect(casts).toBeGreaterThan(0);
    const active = aimed.filter((sample) => sample.active === 1);
    expect(active.length).toBeGreaterThan(0);
    // Turned toward the point its spell goes to (the player's upper body, lower than its hand
    // or off to a side): some turn, never past the modifier's limits.
    expect(active.some((sample) => Math.abs(sample.heading) + Math.abs(sample.pitch) > 0.5)).toBe(
      true,
    );
    // Not before its first cast: the aim comes with the cast.
    expect(aimed[0]?.active).toBe(0);
  });
});

describe('weapons and aim (todo)', () => {
  // TODO(M13): the graphs raise PitchOverrideStart / End around equips and scripted first-person
  // idles (1HM_Equip, CrossBow_Equip, TG05_KnockOut); what the camera or the aim does with the
  // flag is not read (ours, inferred: the player's pitch from the view held level while it or
  // the graph's PitchOverride variable is on: src/animation/pitch-override.test.ts). A crossbow's
  // models carry no projectile node (CrossbowRoot, its string, cocking and trigger bones), and
  // which node the original launches its bolt from is not read (ours, inferred: the hand it is
  // nocked in, NPC R MagicNode [RMag]: src/gameplay/combat/aim.test.ts shotLaunchNode).
  it.todo('the player’s casting pitch: the aim reads the camera’s PitchOverride flag  [original]');
  it.todo('a crossbow’s bolt leaves from its launch node (the weapon model’s node)  [original]');
});
