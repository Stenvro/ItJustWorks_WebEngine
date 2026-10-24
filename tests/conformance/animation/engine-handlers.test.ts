// Conformance: the engine handlers (engine map: Animation and bodies > Engine handlers): the
// classes that answer the events actors' behaviour graphs raise, one case per class.
//
// Sources:
// - The data: meshes\responses\actorresponse.txt (88 entries) and playercharacterresponse.txt
//   (13 and BackupResponse : ActorResponse) map 102 event names to 93 handler classes.
// - The engine's rule per class, observed in the original (each class's handler functor; docs/
//   animation.md, "Graph events", and the notes below). StopHorseCameraHandler and
//   RemoveCharacterControllerHandler are named by the files, but the executable has no class of
//   either name (no RTTI type), so their events do nothing.
// - Our implementations: src/shell/actor-graph-events.ts registers every class (a system's own,
//   or heard by name from a system's listener: dispatch.heardBy).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

/** Every handler class of the response files, with what the engine does (observed in the original). */
const ANSWERED: readonly (readonly [string, string])[] = [
  ['ActionActivateDoneHandler', 'activates the object the process holds (ActivationDone)'],
  ['AddRagdollHandler', 'adds the ragdoll to the world (AddRagdollToWorld)'],
  ['AllowRotationHandler', 'movement animation-driven, the controller turning it'],
  ['AnimatedCameraDeltaStartHandler', 'the third-person camera adds the payload node’s motion'],
  ['AnimatedCameraEndHandler', 'the animated camera ends (EndAnimatedCamera, GraphDeleting)'],
  ['AnimatedCameraStartHandler', 'the camera rides the node the payload names'],
  ['AnimationDrivenHandler', 'movement animation-driven at once'],
  ['AnimationObjectDrawHandler', 'shows the animation object the payload names'],
  ['AnimationObjectLoadHandler', 'loads the animation object the payload names'],
  ['AnticipateAttackHandler', 'the target anticipates the attack (preHitFrame)'],
  ['ArrowAttachHandler', 'the arrow to the bow hand (arrowAttach)'],
  ['ArrowDetachHandler', 'the arrow goes (arrowDetach, bowReset)'],
  ['ArrowReleaseHandler', 'the arrow is released (arrowRelease)'],
  ['AttackStopHandler', 'the attack state ends (attackStop, bashStop)'],
  ['AttackWinEndHandler', 'the next attack’s window closes'],
  ['AttackWinStartHandler', 'the next attack’s window opens'],
  ['BedEnterHandler', 'the sleep state becomes sleeping'],
  ['BedFurnitureExitHandler', 'out of the bed'],
  ['BowDrawnHandler', 'the bow is drawn'],
  ['BowReleaseHandler', 'the bow released'],
  ['CameraShakeHandler', 'shakes the camera by the payload’s strength'],
  ['ChairEnterHandler', 'the sit state becomes sitting'],
  ['ChairFurnitureExitHandler', 'out of the chair'],
  ['DeathEmoteHandler', 'queues the Death line, once a death'],
  ['DeathStopHandler', 'the dying ends (dead)'],
  ['DecapitateHandler', 'the head comes off'],
  ['DisableCharacterBumperHandler', 'the controller’s bumper off'],
  ['DisableCharacterPitchHandler', 'the controller’s pitch off, zeroed'],
  ['EnableCharacterBumperHandler', 'the controller’s bumper on'],
  ['EnableCharacterPitchHandler', 'the controller may pitch the actor'],
  ['EndSummonAnimationHandler', 'a summon takes its commander’s target'],
  ['ExitCartBeginHandler', 'the rider lets go of the cart'],
  ['ExitCartEndHandler', 'the ride ends'],
  ['FlightActionEntryEndHandler', 'the flight action’s entry ended (the grab’s reach)'],
  ['FlightActionGrabHandler', 'the flight action’s grab'],
  ['FlightActionHandler', 'flying state 6, the flight action begins'],
  ['FlightActionReleaseHandler', 'the flight action’s release'],
  ['FlightCruisingHandler', 'flying state cruising'],
  ['FlightHoveringHandler', 'flying state hovering'],
  ['FlightLandHandler', 'flying state 0 (FlightLanded)'],
  ['FlightLandingHandler', 'flying state landing'],
  ['FlightPerchingHandler', 'flying state perching'],
  ['FlightTakeOffHandler', 'flying state 1 (take-off)'],
  ['GetUpEndHandler', 'the get-up ends: the controller is back'],
  ['GetUpStartHandler', 'the get-up from the ragdoll begins'],
  ['HeadTrackingOffHandler', 'head tracking off'],
  ['HeadTrackingOnHandler', 'head tracking on'],
  ['HitFrameHandler', 'the melee hit'],
  ['IdleDialogueEnterHandler', 'dialogue idles held'],
  ['IdleDialogueExitHandler', 'the held dialogue idle plays'],
  ['InterruptCastHandler', 'every hand’s and the voice’s cast interrupted'],
  ['KillActorHandler', 'the actor dies by its killmove’s leader'],
  ['KillMoveEndHandler', 'out of the killmove; one done to it dies'],
  ['KillMoveStartHandler', 'nothing'],
  ['LeftHandSpellFireHandler', 'the left hand’s spell released'],
  ['MotionDrivenHandler', 'movement controller-driven at once'],
  ['MountDismountEndHandler', 'the mount or dismount ends'],
  ['NPCAttachHandler', 'attached to the payload node of its furniture'],
  ['NPCDetachHandler', 'detached'],
  ['PairedStopHandler', 'the paired animation ends'],
  ['PickNewIdleHandler', 'the process wants a new idle'],
  ['PitchOverrideEndHandler', 'the camera’s pitch override off'],
  ['PitchOverrideStartHandler', 'the camera’s pitch override on'],
  ['PlayerBedEnterHandler', 'the player sleeps (camera, controls)'],
  ['PlayerChairEnterHandler', 'the player sits (camera, controls)'],
  ['PlayerFurnitureExitHandler', 'the player out of furniture'],
  ['RecoilStopHandler', 'the recoil ends'],
  ['RemoveRagdollHandler', 'the ragdoll leaves the world'],
  ['RightHandSpellFireHandler', 'the right hand’s spell released'],
  ['RightHandWeaponDrawHandler', 'the weapon drawn (weaponDraw)'],
  ['RightHandWeaponSheatheHandler', 'the weapon sheathed (weaponSheathe)'],
  ['StaggeredStopHandler', 'the stagger ends'],
  ['VampireFeedEndHandler', 'a vampire feeding procedure is done'],
  ['VoiceSpellCastHandler', 'the voice’s cast begins charging'],
  ['VoiceSpellFireHandler', 'the voice’s cast released'],
  ['WeaponBeginDrawRightHandler', 'the right weapon’s draw sound'],
  ['WeaponBeginSheatheRightHandler', 'the right weapon’s sheathe sound'],
  ['WeaponLeftSwingHandler', 'the left attack swings'],
  ['WeaponRightSwingHandler', 'the right attack swings'],
  ['ZeroPitchHandler', 'the camera’s pitch to level (ZeroOutCameraPitch)'],
];

/**
 * Classes we do not answer yet, with the engine's rule (observed in the original). TODO(M13) each: the
 * systems named implement them.
 */
const NOT_ANSWERED: readonly (readonly [string, string])[] = [
  [
    'LeftHandSpellCastHandler',
    'BeginCastLeft: the left hand’s caster waiting to start begins its cast (charging), if it ' +
      'can cast (casting starts its charge at the action instead)',
  ],
  ['RightHandSpellCastHandler', 'BeginCastRight: as the left, for the right hand'],
  [
    'CameraOverrideStartHandler',
    'CameraOverrideStart: for the camera’s target, a flag of its third-person state set (camera)',
  ],
  ['CameraOverrideStopHandler', 'CameraOverrideStop: that flag cleared (camera)'],
  [
    'JumpAnimEventHandler',
    'JumpBegin: the character controller jumps fJumpHeightMin × the actor’s jump height mult ' +
      'high, × fJumpSwimmingMult in water (physics: our controller jumps at the input)',
  ],
  ['MTStateHandler', 'MTState: a flag of the actor’s middle-high process set (its use not read)'],
  [
    'BowZoomStartHandler',
    'BowZoomStart: the player’s bow zoom by the Mod Bow Zoom perk entry, its sound, controls ' +
      'flag 8 off (camera, perks)',
  ],
  ['BowZoomStopHandler', 'BowZoomStop: the zoom back to 1, controls flag 8 on'],
  ['FlightLandEndHandler', 'FlightLandEnd: the landing’s end flag cleared (flight)'],
  ['FlightActionEndHandler', 'FlightActionEnd: the flier’s flight action over (flight)'],
  [
    'FlightCrashLandStartHandler',
    'FlightCrashLandStart: a crash landing begins where the flier’s target was (flight)',
  ],
];

/** Named by the response files, but the executable has no class of these names. */
const NOT_IN_THE_EXECUTABLE = ['StopHorseCameraHandler', 'RemoveCharacterControllerHandler'];

describe.skipIf(!hasGamedata())('the handler classes of the response files (data)', () => {
  let sim: Sim;
  let classes = new Map<string, string[]>();
  let actorEntries = 0;
  let playerEntries = 0;
  let backup: string | undefined;

  beforeAll(async () => {
    sim = await openSim({ interior: 0x1605e, hour: 10 });
    const library = await sim.world.session.animation.animationData();
    classes = new Map();
    for (const responses of [library.actorResponses, library.playerResponses]) {
      for (const [event, handler] of responses?.handlers ?? []) {
        classes.set(handler, [...(classes.get(handler) ?? []), event]);
      }
    }
    actorEntries = library.actorResponses?.handlers.size ?? 0;
    playerEntries = library.playerResponses?.handlers.size ?? 0;
    backup = library.playerResponses?.backup;
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('map 101 events to 93 classes; the player’s list falls back to ActorResponse', () => {
    expect(actorEntries).toBe(88);
    expect(playerEntries).toBe(13);
    expect(backup).toBe('ActorResponse');
    expect(classes.size).toBe(93);
  });

  it('are the classes of this suite, every one', () => {
    const listed = [...ANSWERED, ...NOT_ANSWERED].map(([name]) => name);
    expect(new Set([...listed, ...NOT_IN_THE_EXECUTABLE])).toEqual(new Set(classes.keys()));
  });

  for (const [handler, rule] of ANSWERED) {
    it(`${handler}: ${rule}  [original]`, () => {
      expect(sim.world.stage.graphEvents.dispatch.answered(handler)).toBe(true);
    });
  }

  for (const [handler, rule] of NOT_ANSWERED) {
    // TODO(M13): the class's rule is read; the system named does not answer it yet.
    it.fails(`${handler}: ${rule}  [original]`, () => {
      expect(sim.world.stage.graphEvents.dispatch.answered(handler)).toBe(true);
    });
  }

  for (const handler of NOT_IN_THE_EXECUTABLE) {
    it(`${handler}: no such class in the executable, its event does nothing  [original]`, () => {
      expect(sim.world.stage.graphEvents.dispatch.answered(handler)).toBe(false);
    });
  }
});

describe('graph events (todo)', () => {
  it.todo('the player’s first-person graph’s events reach the same handlers as its body’s  [original]');
  it.todo('a handler run off the main thread is queued to the task queue (flight)  [original]');
});
