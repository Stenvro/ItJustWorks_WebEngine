// Conformance: the kill camera's shots (engine map: Rendering and camera > Cameras).
//
// Sources, observed in the original (docs/animation.md, "Killmoves"): a shot's lead actor is
// the target where it leads its paired clip, else the attacker; a shot whose own spot comes
// within fVATSCameraCutAwayDistance of its look hands the view to the player's first person
// unless the player is dead; each shot starts by its path's DATA, never dollying into a Shoot
// shot, the first one from the player's view.

import { describe, expect, it } from 'vitest';
import {
  CameraAction,
  CameraSubject,
  type CameraShot,
} from '../../../src/gameplay/combat/combat-records.ts';
import type { PhysicsWorld } from '../../../src/physics/physics-world.ts';
import type { Vec3 } from '../../../src/render/math.ts';
import { KillmoveCamera, type KillmoveSubjects } from '../../../src/shell/killmove-camera.ts';

/** A shot without a model (its camera 200 behind and 80 above its location). */
const shot = (overrides: Partial<CameraShot>): CameraShot => ({
  formId: 1,
  editorId: 'Shot',
  model: undefined,
  action: CameraAction.hit,
  location: CameraSubject.attacker,
  target: CameraSubject.target,
  flags: 0,
  playerTimeMult: 1,
  targetTimeMult: 1,
  globalTimeMult: 1,
  maxTime: 1,
  minTime: 0,
  targetPercentBetweenActors: 0,
  nearTargetDistance: 0,
  imageSpaceModifier: undefined,
  ...overrides,
});

const subjects = (target: Vec3, extra: Partial<KillmoveSubjects> = {}): KillmoveSubjects => ({
  attacker: () => [0, 0, 0],
  attackerHeading: () => 0,
  target: () => target,
  targetHeading: () => 0,
  attackerRef: 1,
  targetRef: 2,
  physics: {} as PhysicsWorld,
  ...extra,
});

describe('the kill camera', () => {
  it("measures a lead actor's shot from the target when the target leads its pair", () => {
    const lead = shot({ location: CameraSubject.leadActor, target: CameraSubject.attacker });
    const target: Vec3 = [1000, 0, 0];
    // Without a skeleton, a subject's point is 72 over its feet; the camera 200 behind it, 80 up.
    const theirs = KillmoveCamera.ofShots([lead], subjects(target, { leads: (r) => r === 2 }));
    expect(theirs.position).toEqual([1000, -200, 152]);
    const ours = KillmoveCamera.ofShots([lead], subjects(target, { leads: () => false }));
    expect(ours.position).toEqual([0, -200, 152]);
  });

  it('cuts away to the player when its spot comes within the cut-away distance of its look', () => {
    // The target stands where the shot's camera is: the camera looks at its own spot.
    const at: Vec3 = [0, -200, 80];
    const near = shot({ maxTime: 5 });
    const camera = KillmoveCamera.ofShots([near], subjects(at));
    expect(camera.cutAway).toBe(false);
    camera.update(0.1);
    expect(camera.cutAway).toBe(true);
    // Not while the player is dead: the camera goes on.
    const dead = KillmoveCamera.ofShots([near], subjects(at, { playerDead: () => true }));
    dead.update(0.1);
    expect(dead.cutAway).toBe(false);
    // Far enough, it never does.
    const far = KillmoveCamera.ofShots([near], subjects([0, 500, 0]));
    far.update(0.1);
    expect(far.cutAway).toBe(false);
  });

  it("dollies into a shot by its path's start mode, never into a Shoot shot", () => {
    const from = (): Vec3 => [0, -2000, 152];
    const first = shot({});
    // Default (DATA 0): from the player's view over fVATSCameraDollyTime (1 s).
    const dolly = KillmoveCamera.ofShots([first], subjects([0, 500, 0], { from }));
    expect(dolly.position).toEqual([0, -2000, 152]);
    dolly.update(0.5);
    expect(dolly.position[1]).toBeCloseTo(-1100);
    expect(dolly.radialBlur).toBeCloseTo(0.25);
    // Disable (DATA 1): it cuts.
    const cut = KillmoveCamera.ofShots([first], subjects([0, 500, 0], { from }), 1);
    expect(cut.position).toEqual([0, -200, 152]);
    // A Shoot shot is never dollied into.
    const shoot = shot({ action: CameraAction.shoot });
    const shooting = KillmoveCamera.ofShots([shoot], subjects([0, 500, 0], { from }));
    expect(shooting.position).toEqual([0, -200, 152]);
  });
});
