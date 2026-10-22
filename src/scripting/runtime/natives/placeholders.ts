// Natives registered that do not do (all) the game does yet, by lowercase "script.function":
// what they lack, each with the milestone that brings it. tools/papyrus-natives.ts
// --placeholders lists them with how often the vanilla scripts call each; the integration test
// (tests/papyrus-runtime.int.test.ts) holds every one to a milestone. Natives that rightly do
// nothing here (profiling, the console's debug helpers, achievements, preloading) are not
// placeholders. Platform-independent.

export const PLACEHOLDER_NATIVES: ReadonlyMap<string, string> = new Map([
  // The player's forms, the first-person view.
  ['game.setbeastform', 'TODO(M11): the werewolf and vampire lord forms'],
  ['game.showfirstpersongeometry', 'TODO(M11): the first-person arms and weapon'],
  ['actor.sendlycanthropystatechanged', 'TODO(M11): lycanthropy (the werewolf forms)'],
  ['actor.sendvampirismstatechanged', 'TODO(M11): vampirism (its stages)'],
  ['actor.seteyetexture', "TODO(M11): vampirism (the vampire's eyes)"],
  ['game.setallowflyingmountlandingrequests', "TODO(M11): Dragonborn's dragon riding"],
  // Saves.
  ['game.requestsave', 'TODO(M12): saves'],
  ['game.requestautosave', 'TODO(M12): saves'],
  // Effects, physics and controllers the engine does not show yet.
  ['game.shakecontroller', 'TODO(M13): gamepads (no controller support: nothing rumbles)'],
  ['game.triggerscreenblood', "TODO(M13): the HUD's screen blood"],
  ['game.cleartempeffects', 'TODO(M13): temporary effects (decals, shaders) cleared at once'],
  ['game.setsittingrotation', "TODO(M13): the seated player's camera turn"],
  ['game.setsungazeimagespacemodifier', "TODO(M13): the sun gaze's image-space modifier"],
  ['game.isplayersungazing', 'TODO(M13): the sun gaze'],
  ['game.setcameratarget', "TODO(M13): the camera's target other than the player"],
  ['game.addhavokballandsocketconstraint', 'TODO(M13): Havok constraints between references'],
  ['game.removehavokconstraints', 'TODO(M13): Havok constraints between references'],
  ['actor.clearextraarrows', 'TODO(M13): arrows stuck in bodies (not shown yet)'],
  ['objectreference.forceaddragdolltoworld', 'TODO(M13): ragdolls a script adds and removes'],
  ['objectreference.forceremoveragdollfromworld', 'TODO(M13): ragdolls a script adds and removes'],
  ['objectreference.playterraineffect', "TODO(M13): the terrain's effects at a node"],
  ['objectreference.playsyncedanimationss', 'TODO(M13): synced animations of two references'],
  [
    'objectreference.playsyncedanimationandwaitss',
    'TODO(M13): synced animations of two references',
  ],
  ['objectreference.movetointeractionlocation', "TODO(M13): the furniture's entry point"],
  // Movement controller overrides (no vanilla script calls them).
  ['actor.keepoffsetfromactor', "TODO(M13): the movement controller's offsets"],
  ['actor.clearkeepoffsetfromactor', "TODO(M13): the movement controller's offsets"],
  ['actor.forcemovementdirection', "TODO(M13): the movement controller's forced movement"],
  ['actor.forcemovementdirectionramp', "TODO(M13): the movement controller's forced movement"],
  ['actor.forcemovementrotationspeed', "TODO(M13): the movement controller's forced movement"],
  ['actor.forcemovementrotationspeedramp', "TODO(M13): the movement controller's forced movement"],
  ['actor.forcemovementspeed', "TODO(M13): the movement controller's forced movement"],
  ['actor.forcemovementspeedramp', "TODO(M13): the movement controller's forced movement"],
  ['actor.forcetargetangle', "TODO(M13): the movement controller's forced movement"],
  ['actor.forcetargetdirection', "TODO(M13): the movement controller's forced movement"],
  ['actor.forcetargetspeed', "TODO(M13): the movement controller's forced movement"],
  ['actor.clearforcedmovement', "TODO(M13): the movement controller's forced movement"],
  ['actor.setplayercontrols', 'TODO(M13): actors other than the player under player controls'],
]);
