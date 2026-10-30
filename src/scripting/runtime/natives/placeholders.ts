// Natives registered that do not do (all) the game does yet, by lowercase "script.function":
// what they lack, each with the milestone that brings it. tools/papyrus-natives.ts
// --placeholders lists them with how often the vanilla scripts call each; the integration test
// (tests/papyrus-runtime.int.test.ts) holds every one to a milestone. Natives that rightly do
// nothing here (profiling, the console's debug helpers, achievements, preloading) are not
// placeholders. Platform-independent.

export const PLACEHOLDER_NATIVES: ReadonlyMap<string, string> = new Map<string, string>([]);

/**
 * Natives Actor.psc declares that the original binds to nothing (observed in the original: no
 * native of these names is registered), by lowercase "script.function": their names as
 * declared. A call is the VM's error 'error: Unbound native function "<name>" called' on the
 * calling stack, and returns None (natives/actor.ts). No vanilla script calls them.
 */
export const UNBOUND_NATIVES: ReadonlyMap<string, string> = new Map([
  ['actor.forcemovementdirection', 'ForceMovementDirection'],
  ['actor.forcemovementdirectionramp', 'ForceMovementDirectionRamp'],
  ['actor.forcemovementrotationspeed', 'ForceMovementRotationSpeed'],
  ['actor.forcemovementrotationspeedramp', 'ForceMovementRotationSpeedRamp'],
  ['actor.forcemovementspeed', 'ForceMovementSpeed'],
  ['actor.forcemovementspeedramp', 'ForceMovementSpeedRamp'],
  ['actor.forcetargetangle', 'ForceTargetAngle'],
  ['actor.forcetargetdirection', 'ForceTargetDirection'],
  ['actor.forcetargetspeed', 'ForceTargetSpeed'],
  ['actor.clearforcedmovement', 'ClearForcedMovement'],
]);

// Natives registered as a bare constant because the game does nothing there either (or nothing a
// player of the PC game sees): each with why. tools/papyrus-completeness.ts counts a constant
// native as done only when it is listed here.
export const INERT_NATIVES: ReadonlyMap<string, string> = new Map([
  ['utility.getcurrentmemory', 'profiling: the release game reports no script memory'],
  ['utility.getbudgetcount', 'profiling: the release game keeps no script budgets'],
  ['utility.getcurrentbudget', 'profiling: the release game keeps no script budgets'],
  ['utility.overbudget', 'profiling: the release game keeps no script budgets'],
  ['utility.getbudgetname', 'profiling: the release game keeps no script budgets'],
  ['utility.captureframerate', 'profiling: the release game captures no frame rates'],
  ['utility.startframeratecapture', 'profiling: the release game captures no frame rates'],
  ['utility.endframeratecapture', 'profiling: the release game captures no frame rates'],
  ['debug.openuserlog', "the user logs: kept with the Papyrus log (Debug.TraceUser's)"],
  ['debug.closeuserlog', "the user logs: kept with the Papyrus log (Debug.TraceUser's)"],
  ['debug.centeroncellandwait', "the console's coc: a debug helper"],
  ['debug.playermovetoandwait', "the console's player.moveto: a debug helper"],
  ['form.startobjectprofiling', 'profiling'],
  ['form.stopobjectprofiling', 'profiling'],
  ['activemagiceffect.startobjectprofiling', 'profiling'],
  ['activemagiceffect.stopobjectprofiling', 'profiling'],
  ['alias.startobjectprofiling', 'profiling'],
  ['alias.stopobjectprofiling', 'profiling'],
  ['spell.preload', 'preloading: our assets stream on demand'],
  ['spell.unload', 'preloading: our assets stream on demand'],
  ['game.precachechargen', 'preloading: our assets stream on demand'],
  ['game.precachechargenclear', 'preloading: our assets stream on demand'],
  ['game.requestmodel', 'preloading: our assets stream on demand'],
  ['game.addachievement', 'achievements: a platform service the web build has none of'],
  ['topic.add', 'Skyrim keeps no list of known topics (nothing in DIAL or INFO gates on one)'],
]);
