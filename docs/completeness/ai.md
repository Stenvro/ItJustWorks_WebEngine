# AI: completeness

What "100" means here: everything the load order (Skyrim.esm, Update, the three DLCs and the
Creation Club files of the install) gives the actors' AI outside combat is read and run as the
original does: every package's procedures, flags, data, places, targets, schedule and conditions;
the NPCs' AI data and package lists; the races' AI flags; idle markers and furniture; the
navmeshes; detection, crime, followers, dialogue-driven AI; and every game setting the AI reads.
Combat has its own list (docs/completeness/combat.md).

The data part comes from the sweep `node tools/ai-combat-completeness.ts` (`--all` for every
item with where it is read). An item is done when the engine reads it: a field or flag is named
outside the file that parses it (the file named is the first reader found, the AI's and the
stage's first), a procedure has a runner, a condition function is valued (the condition audit,
tests/condition-audit.int.test.ts), a setting is asked for by a settings reader or named in the
code (comments left out), or the sweep's own table says why nothing more reads it. The count after
each item is how many records (triangles, attacks) use it. The mechanics part is kept by hand
against docs/ai.md and the conformance suites (tests/conformance/ai/).

## Count (2026-11-03, round 4b)

| Part                    | Items | Done | Open |
| ----------------------- | ----: | ---: | ---: |
| Packages (data)         |   186 |  186 |    0 |
| NPCs, races (data)      |    19 |   19 |    0 |
| Idle markers, furniture |    25 |   24 |    1 |
| Navmeshes (data)        |    12 |   11 |    1 |
| Game settings           |   190 |  190 |    0 |
| Mechanics (by hand)     |    37 |   26 |   11 |
| Total                   |   469 |  456 |   13 |

Round 1 wrote the sweep and this list; Can Pickup Items (RACE DATA) became read: only a race that
can pick up items runs the combat tree's Acquire Weapon.

Round 2 built down:

- World Interactions (3915 packages): read by name where the original reads it, the condition
  GetAllowWorldInteractions (the 39 world interaction quests' aliases: WICommentDiseased,
  WICraftItem01, ...), true while the actor's package has the flag.
- The unnamed bits are the earlier games' flags kept in records made from theirs (xEdit's TES4,
  FO3 and FNV definitions): interrupt bit 0x100 (1682 packages) Avoid Radiation, PKDT bits 0x10,
  0x20, 0x100 (33, 2, 5) Lock Doors At Package End, Lock Doors At Location, Unlock Doors At
  Location. This game's references (xEdit, CommonLibSSE) name none of them: inert.
- Location type 11 (18 inputs, all in Hearthfire's urchin runner packages): Target (location),
  as xEdit's later game's definition names it ("Target: %s, radius %u"): the reference another
  data input of the package names, within the radius (package-start.ts placeOf, actor-ai.ts
  place; PackageContext carries the inputs).
- Use Head Track Anims (117 races): only such a race has its graph's look-at driven
  (head-tracking.ts raceHeadTracks; trolls, spiders, the dwarven machines, the dremora keep
  their graphs' own looks). TODO(M13): what else the flag gates.
- Must Exit To Talk (184 furniture): an actor the player talks to gets out of such furniture (a
  bed, a chopping block) first (talk.ts getsUpToTalk, actor-ai.ts).
- fAISocialchanceForConversation (10) and its Interior twin: the chance a spectator who begins
  watching a fight says its ObserveCombat line (combat-dialogue.ts spectatorComments).

Round 3 built down (the race flags' readers: src/ai/race-ai-flags.ts):

- Can't Open Doors (60 races): such an actor passes a door standing open and no other; a shut
  one closes its paths (pathfinding.ts closedDoor, actor-doors.ts closedTo) and it takes no load
  door, staged or away (ActorDoors.mayPass; tests/conformance/ai/race-doors.test.ts). Followers
  still come along through load doors with the player (they are put there, as the original's).
- Not Pushable (9 races: the dragons, the Forgemaster, Miraak, the ghost frost giant): bumped
  into, it does not flinch and step aside, and it never gives way on a narrow way
  (avoidance.ts givesWay).
- Immobile (the mannequins, the Midden's empty actor): its travels fail at once and it stands,
  keeping its facing (actor-movers.ts). TODO(M13): whether it still turns to face.
- Avoids Roads (giants, mammoths, the ghost frost giant, lurkers): the navmeshes' preferred
  triangles (roads) cost it twice their length instead of half (ROAD_AVOID_COST, TODO(M13)).
- Always Use Proxy Controller (the six dragon races): every actor here moves by the character
  proxy controller (src/physics/character.ts), which the flag keeps the dragons on; when the
  original moves the other races to the rigid body controller is TODO(M13).
- FURN interaction keyword (467: ActorTypeNPC on 457, ActorTypeDragon on the perches, Miraak's,
  the rieklings'): furniture with one is found for sandboxing and Sit / Sleep only by an actor
  with that keyword (actor-furniture.ts spots).
- fActorDefaultTurningSpeed (a full turn a second): the turn rate where a movement type gives
  none (the cows' swimming type turns at 0 while moving; movement-types.ts withTurning).
- fJogInterpolationBetweenWalkAndRun (0.65): a package's preferred speed Jog runs at 0.65 of the
  way from its walk to its run (package-runtime.ts jogPace; it ran at a full run before).
- fFurnitureMarkerAngleTolerance (10°): one about to enter furniture begins once it faces the
  enter's way within it (actor-furniture.ts).
- fAIForceGreetingTimer (3): a force greeter at the player whose greeting could not begin tries
  again after it (procedure-runs.ts forceGreet).

The last three are their names' plain readings (TODO(M13)). Left open: IDLM Loose Only (CommonLibSSE
names it kLooseOnly, xEdit only for a later game; 72 of 89 markers; its meaning is not
documented), and fTrackSpeed, fTrackDeadZoneXY / Z: the earlier game's head tracking set (it had
eleven fTrack\* settings; Skyrim.esm keeps three); this game's head tracking reads fHeadTrack\*.
Round 4 (2026-11-02) read them from the original: fTrackSpeed is the face's eye tracking (the
eyes turn to their look at most this many radians a second on each axis: src/animation/face.ts,
docs/animation.md "Faces"); fTrackDeadZoneXY / Z are registered and never read (inert).

Round 4b (2026-11-03; docs/ai.md, "Marker keywords, Disables Activation, Loose Only, Found"):

- FURN marker keyword (FNMK: the two chopping blocks): a marker with a keyword is only for an
  actor with it, who takes it before the others (src/ai/furniture-markers.ts markerRank; the
  headsmen carry isExecutioner, MQ101's officer isExecutionerGuard).
- FURN Disables Activation (the dragon priest's coffin marker, the Tentacle Word burn marker):
  no prompt, the player does not use it (activation-prompt.ts).
- Both are their names' plain readings and the data's (TODO(M13)): the original's furniture
  activation and prompt text read neither, where it does was not found.
- Still open: IDLM Loose Only (the original's Use Idle Marker procedure, the walk onto a marker
  and the sandbox's marker search read no such bit) and the navmesh flag Found (its path search
  set-up and step cost, which reads Water and Preferred, read no such bit).

## Packages

- [x] Procedures (30 of 30 the data runs): every one has a runner (src/ai/procedure-runs.ts
      PROCEDURES): Travel 1043 packages, Sandbox 879, Activate 482, Follow 312, Hold Position,
      Wait, Patrol, Sit, Sleep, Use Idle Marker, Find, Acquire, Escort, Follow To, Flee, Guard,
      Wander, Say, Force Greet, Dialogue Activate, Keep An Eye On, Lock and Unlock Doors, Eat,
      Hover, Orbit, Flight Grab, Use Weapon, Use Magic, Shout.
- [x] Procedure tree branches: Procedure, Sequence, Simultaneous, Stacked, Random and the flag
      overrides (PFO2 / PFOR) (src/ai/package-runtime.ts).
- [x] Package data values (8 of 8: Bool, Int, Float, Object List, Location, Single Ref, Target
      Selector, Topic) (src/ai/package-start.ts, package-runtime.ts).
- [x] Locations (8 of 9 types): near reference, in cell, near package start, near editor
      location, near linked reference, alias reference, alias location, near self.
- [x] Location type 11 (18 packages): Target (location), the reference another input names
      (round 2, above).
- [x] Targets (6 of 6 types): specific reference, object id, object type, linked reference,
      reference alias, self.
- [x] Schedule (PSDT): month, day of week, date, hour, minute, duration (package-start.ts).
- [x] Idles (IDLF, IDLT, IDLA), begin / end / change events (POBA, POEA, POCA), the package's
      combat style (CNAM, combat-profile.ts).
- [x] Conditions: all 89 functions the packages use are valued (condition-values.ts; GetStage
      1574 packages, GetVMQuestVariable 615, ...).
- [x] PKDT general flags: all 16 named ones (Offers Services .. Wear Sleep Outfit).
- [x] PKDT flag 0x10 (33 packages), 0x20 (2), 0x100 (5): the earlier games' door locking flags
      (round 2, above); inert.
- [x] PKDT interrupt flags: hellos to player, random conversations, observe combat, greet
      corpse, reaction to player actions, friendly fire comments, aggro radius, idle chatter.
- [x] Interrupt flag World Interactions (3915 packages): GetAllowWorldInteractions, the world
      interaction quests' casting (round 2, above).
- [x] Interrupt flag 0x100 (1682 packages): the earlier games' Avoid Radiation; inert.
- [x] Interrupt override (none 7222, combat 285): the override lists decide
      (src/shell/actor-senses.ts: SPOR, OCOR, GWOR; ECOR in actor-combat-ai.ts); the byte sorts a
      package into such a list.

## NPCs and races

- [x] AIDT: aggression, confidence, energy, morality, mood, assistance, the aggro radii.
- [x] Package lists: default package list (DPLT), spectator, observe corpse, guard warn, combat
      override (src/shell/actor-ai.ts, actor-senses.ts, actor-combat-ai.ts).
- [x] Race flags read: Allow PC Dialogue, Allow Pickpocket (activation-facts.ts), Can Pickup Items
      (actor-combat-ai.ts: Acquire Weapon).
- [x] Can't Open Doors (60 races: animals, dragons, giants, dwarven centurions): open doors
      only; shut ones close their paths, no load doors (round 3, above).
- [x] Use Head Track Anims (117 races): only these races' look-at is driven (round 2, above).
- [x] Not Pushable (9 races): no bump reaction, never gives way (round 3, above).
- [x] Immobile (2), Always Use Proxy Controller (6), Avoids Roads (4) (round 3, above).

## Idle markers and furniture

- [x] IDLM: idles, timer, Run In Sequence, Do Once, Ignored By Sandbox, children can use.
- [ ] IDLM flag Loose Only (72 markers): open; its meaning is not documented, and the code
      looked at in the original does not read it (round 4b, above).
- [x] FURN: marker types (sit, sleep, lean), entry points (front, behind, left, right, up),
      disabled entries, the can-sit / sleep / lean bits, perch, Ignored By Sandbox, children can
      use (src/shell/actor-furniture.ts, actor-flight.ts).
- [x] FURN Must Exit To Talk (184): the actor gets up to talk with the player (round 2).
- [x] FURN interaction keyword (KNAM, 467): only actors with the keyword use it (round 3).
- [x] FURN marker keyword (FNMK, 2): a marker only for actors with its keyword (round 4b).
- [x] FURN Disables Activation (2): no prompt for the player (round 4b).

## Navmeshes

- [x] Edge links (portal, ledge up, ledge down, enable / disable portal), preferred and water
      triangles, No Large Creatures, door triangles, cover (src/ai/pathfinding.ts,
      combat-subtrees.ts, src/world/navmesh.ts). Skyrim's navmeshes have no ladder or jump links
      beyond the ledges.
- [ ] Triangle flag Found (3.15 million triangles): not read. TODO(M13): whether the game reads
      it (xEdit names it; it is set on nearly every triangle; the original's path search set-up
      and step cost do not: round 4b).

## Game settings

The load order's AI settings (84: fAI*, fSandbox*, fSneak*, detection, crime, guards, bumps,
comments, head tracking, idle chatter, random scenes, followers, escorts) and 106 built-in ones
the readers ask for by name.

- [x] 81 of 84 plugin settings and all 106 built-in ones (src/ai/ai-settings.ts, detection.ts,
      talk.ts, head-tracking.ts, combat-dialogue.ts, src/gameplay/crime.ts, ...).
- [x] fAISocialchanceForConversation, ...Interior: the spectators' comment chance (round 2).
- [x] fAIForceGreetingTimer (3),
      fFurnitureMarkerAngleTolerance (10), fActorDefaultTurningSpeed,
      fJogInterpolationBetweenWalkAndRun (round 3, above).
- [x] fTrackSpeed: the eyes' turn speed (face.ts); fTrackDeadZoneXY, fTrackDeadZoneZ:
      registered, never read (inert; round 4, above).

## Mechanics (by hand)

- [x] Package evaluation: when, order, must complete, once per day, fallout (package-start.ts,
      package-runtime.ts; tests/conformance/ai/package-evaluation.test.ts).
- [x] Continue If PC Near's reach: the player in the actor's parent cell, no distance (observed in
      the original; tests/conformance/ai/package-evaluation.test.ts). Inferred: the kept package goes
      on as it was (the original sets it up again).
- [x] fEvaluateProcedureTimer: a running tree's branches checked again every 3 s (observed; same suite).
- [x] Allow Swimming: by the package, by the race alone fighting, in an Alarm or with no package
      (observed; swimsNow). Offers Services, Maintain Speed At Goal: tested (same suite).
- [ ] The fallout's radius and options: ours. Its reader was not found in the original (the flag's
      usual test forms, the Done procedure state, the package's end): that it sandboxes is inferred.
- [x] Sandbox: rescan, search radius, hysteresis, meals, idle markers (sandbox.ts).
- [x] Sandbox: the delay on arrival: at its activity the next package and procedure evaluations
      wait at least fSandBoxDelayEvalSeconds (observed; tests/conformance/ai/sandbox.test.ts).
      Inferred: the field the engine caps it by, taken as the stay, which is longer in vanilla.
- [ ] Sandbox: the places the engine gives no radius: open (near itself and near its start: done).
- [x] fSandBoxExtraDialogueRange: observed to size only the second place of the engine's In Game
      Dialogue package (the first's radius plus it); ours holds two actors talking in their scene
      (talk.ts inGameDialoguePlaces, src/shell/actor-talk.ts): one drawn beyond the second place
      walks back within the first (inferred; tests/conformance/ai/sandbox.test.ts).
- [x] Paths: navmesh A\*, edge links, ledges, doors on the way, routes through load doors.
- [x] Navmesh obstacles: the ground under one cut out of each triangle by the rule's footprint and
      height band, its free parts stay open; a moving body's cut (5 units, 5°, the update delta)
      (navmesh-obstacles.ts; tests/conformance/ai/movement-paths.test.ts, a real hall's triangles).
      Ours in form: convex parts for the original's new triangles, which were not read.
- [x] Avoidance: whom it lays avoid nodes on, standing or moving, by the advanced avoidance
      (avoidance.ts layAvoidNode; the flag read: it is the velocity obstacles' switch).
- [ ] Avoidance: the velocity obstacles' steering (ours: foresee and keep right; that only those
      races steer is inferred); who yields: the original's avoider has no such rule, it reports
      its way blocked; what its path manager does then is not read (ours: the slower gait).
- [x] Detection: sight, sound, light, line of sight, stealth, detection states (detection.ts).
- [x] Detection: the light's sum: each light's mean channel × its fade × (1 − (d / r)²), the
      directional light's ambient and diffuse means, × 100; worked out every fLightRecalcTimer, the
      player's every fLightRecalcTimerPlayer; only the player's light asks for a line to the sun
      (src/ai/light-level.ts, tested there).
- [ ] Detection: which lights count (the original: those its renderer gave the body; here a ray to
      each), the factor on the diffuse part (a renderer value not read), the ambient part's source.
- [ ] Detection: an Ambush package's own target. Observed: the running package is asked whether the
      target is its own; no plugin of the load order has an Ambush package, so its data is unread.
- [x] Crime: witnesses, alarms, guards' warnings and arrests, NPC assault alarms.
- [x] Crime: guards that only hear an NPC's alarm: the first in reach of the crime's group, not
      fighting, answers; iNumberGuardsCrimeResponse at most (tests/conformance/ai/crime.test.ts).
- [x] Crime: fKillWitnessesTimerSetting (a crime stands 30 s after it, guard or no guard),
      iCrimeEnemyCoolDownTimer, iCrimeMaxNumberofDaysinJail, fCrimeGoldSkillPenaltyMult, only assault
      and murder violent, all the original's and tested.
- [x] Crime settings never read by the original (registered only; the sweep's INERT):
      fCrimeAlarmRespMult, fCrimeSoundBase / Mult, iCrimeGoldMinValue, the fCrimeDisp*, fCrimeRegardMult,
      fCrimePersonalRegardMult, fCrimeWitnessRegardMult, iCrimeRegardBaseValue.
- [ ] Crime: the NPC criminal not fighting flees the guard that answers (observed; the stage starts
      no flee from here); the answering guard attacks at once (inferred; the original's Alarm
      package); a guard of another faction taking the crime over; which witnesses of an NPC's crime
      report it (inferred).
- [x] fCrimeFavorMult, iCrimeFavorBaseValue: the favor check, a favor's price (the base value plus
      the cost × the mult) within the favor points of the relationship rank (factions.ts doesFavor,
      inferred in form); a commanded follower refuses a reference whose favor cost (XFVC) is beyond
      it (src/shell/actor-favors.ts; tests/conformance/ai/crime.test.ts).
- [x] Followers, horses, vehicles (followers.ts, mounts.ts, vehicles.ts).
- [x] Followers: the follow offset (their places by distance, both radii and the spacing between:
      followOffset), the path to the leader itself, the walk zone (the middle of the radii,
      fFollowWalkZoneMult built-in 1) and the gait: observed; src/ai/followers.test.ts. Inferred: a
      follower's radius is a human's.
- [ ] Mounting from the right: the data has one Mount idle and one paired clip, from the left. That
      there is no mount from the right is read from the data, not from the code.
- [x] Dialogue-driven AI: greetings, force greet, dialogue activate, conversations (talk.ts).
- [x] The greeting hold: as long as its line lasts, wherever the player goes.
      fAIInDialogueModeWithPlayerDistance is registered and never read by the original;
      fAIInDialogueModewithPlayerTimer is read for a conversation with the player, not a greeting
      (the conversation's use is not built).
- [x] Scenes (scene-runtime.ts).
- [x] Travel, escort, flee, follow to, keep an eye on, ambush (procedure-runs.ts). Flee from
      something is done once safe: fFleeIsSafeTimer beyond fFleeDoneDistance* (fleeSafe, the count
      inferred; tests/conformance/combat/flee.test.ts).
- [x] Asking the player who stands in the way to move (avoidance.ts blockedByActor, the movers'
      rule: after fMaxTimeBlockedByActors, once a travel, its ActorCollidewithActor line; the line
      and the wait inferred; tests/conformance/ai/procedures.test.ts).
- [x] Engine packages: get up, avoid player, steal warning, movement blocked (engine-packages.ts).
- [x] Wear Sleep Outfit: Asbjorn in his bed's package (tests/conformance/ai/procedures.test.ts).
- [x] Head tracking (head-tracking.ts): no favourites (the player asked first, else the first it may
      look at), who may be looked at (distance, 100 units, 120° or the one it has, two in
      furniture), the hold (fAIHoldDefaultHeadTrackTimer), the look along the way
      (fMin/fMaxPathLookAtPointDist, fPathLookAtPointTime) only with no one to look at.
- [ ] A package target's look: read (only Use Weapon, Use Magic and Shout ask the Procedure look;
      actor-practice.ts asks it so), no test has it.
- [ ] Head tracking: which fields a commanded actor's and a teammate's exceptions read; what
      ends a look that may no longer be chosen (ours: at the next look).
- [x] Furniture use: entry, exit, idle markers (actor-furniture.ts).
- [x] Process levels and their budget (process-levels.ts).
- [ ] Process levels: the high-process distance ours; actors away keep a schedule (ours). Not read
      in this round: no setting names either.

## Next biggest

1. Avoidance: the velocity obstacles' steering, and what the path manager does with a way
   reported blocked by actors.
2. IDLM Loose Only (72 markers) and the navmesh flag Found: where the original reads them
   (round 4b ruled out the idle marker procedure, the sandbox's search and the path cost).
3. The mechanics left by hand (Continue If PC Near's reach, sandbox radii, the light's sum, NPC
   crimes, the follow offset).
