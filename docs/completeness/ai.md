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

## Count (2026-11-01, round 2)

| Part                    | Items | Done | Open |
| ----------------------- | ----: | ---: | ---: |
| Packages (data)         |   186 |  186 |    0 |
| NPCs, races (data)      |    19 |   14 |    5 |
| Idle markers, furniture |    25 |   21 |    4 |
| Navmeshes (data)        |    12 |   11 |    1 |
| Game settings           |   190 |  182 |    8 |
| Mechanics (by hand)     |    24 |   13 |   11 |
| Total                   |   456 |  427 |   29 |

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
- [ ] Can't Open Doors (60 races: animals, dragons, giants, dwarven centurions): not read; their
      paths pass shut doors. Next: shut doors closed to their paths (pathfinding closedDoors),
      load doors refused (ActorDoors.mayPass).
- [x] Use Head Track Anims (117 races): only these races' look-at is driven (round 2, above).
- [ ] Not Pushable (9 races): declared (RaceFlag.notPushable), not read by the bump and push.
- [ ] Immobile (2), Always Use Proxy Controller (6), Avoids Roads (4): not read.

## Idle markers and furniture

- [x] IDLM: idles, timer, Run In Sequence, Do Once, Ignored By Sandbox, children can use.
- [ ] IDLM flag Loose Only (72 markers): not read.
- [x] FURN: marker types (sit, sleep, lean), entry points (front, behind, left, right, up),
      disabled entries, the can-sit / sleep / lean bits, perch, Ignored By Sandbox, children can
      use (src/shell/actor-furniture.ts, actor-flight.ts).
- [x] FURN Must Exit To Talk (184): the actor gets up to talk with the player (round 2).
- [ ] FURN interaction keyword (KNAM, 467): not read.
- [ ] FURN marker keyword (FNMK, 2): not read.
- [ ] FURN Disables Activation (2): not read.

## Navmeshes

- [x] Edge links (portal, ledge up, ledge down, enable / disable portal), preferred and water
      triangles, No Large Creatures, door triangles, cover (src/ai/pathfinding.ts,
      combat-subtrees.ts, src/world/navmesh.ts). Skyrim's navmeshes have no ladder or jump links
      beyond the ledges.
- [ ] Triangle flag Found (3.15 million triangles): not read. TODO(M13): whether the game reads
      it (xEdit names it; it is set on nearly every triangle).

## Game settings

The load order's AI settings (84: fAI*, fSandbox*, fSneak*, detection, crime, guards, bumps,
comments, head tracking, idle chatter, random scenes, followers, escorts) and 106 built-in ones
the readers ask for by name.

- [x] 76 of 84 plugin settings and all 106 built-in ones (src/ai/ai-settings.ts, detection.ts,
      talk.ts, head-tracking.ts, combat-dialogue.ts, src/gameplay/crime.ts, ...).
- [x] fAISocialchanceForConversation, ...Interior: the spectators' comment chance (round 2).
- [ ] fAIForceGreetingTimer (3), fAIInDialogueModewithPlayerTimer (60): not read.
- [ ] fFurnitureMarkerAngleTolerance (10): not read (furniture entry facing).
- [ ] fActorDefaultTurningSpeed, fJogInterpolationBetweenWalkAndRun: not read (locomotion).
- [ ] fTrackSpeed, fTrackDeadZoneXY, fTrackDeadZoneZ: not read.

## Mechanics (by hand)

- [x] Package evaluation: when, order, must complete, once per day, fallout (package-start.ts,
      package-runtime.ts; tests/conformance/ai/package-evaluation.test.ts).
- [ ] Continue If PC Near's reach; the fallout's radius and options: ours.
- [x] Sandbox: rescan, search radius, hysteresis, meals, idle markers (sandbox.ts).
- [ ] Sandbox: the places the engine gives no radius, extra dialogue range, the delay on arrival.
- [x] Paths: navmesh A\*, edge links, ledges, doors on the way, routes through load doors.
- [ ] Navmesh obstacles cut approximately (no re-triangulation).
- [ ] Avoidance: the engine's way round and who yields (ours: the slower gait).
- [x] Detection: sight, sound, light, line of sight, stealth, detection states (detection.ts).
- [ ] Detection: the light's sum is ours.
- [x] Crime: witnesses, alarms, guards' warnings and arrests, NPC assault alarms.
- [ ] Crime: NPC crimes beyond assault; guards that only hear an NPC's alarm; fCrimeAlarmRespMult.
- [x] Followers, horses, vehicles (followers.ts, mounts.ts, vehicles.ts).
- [ ] Followers: the follow offset and walk zone's built-in values ours; mounting from the right.
- [x] Dialogue-driven AI: greetings, force greet, dialogue activate, conversations (talk.ts).
- [ ] The greeting hold distance chosen by its setting's name.
- [x] Scenes (scene-runtime.ts).
- [x] Travel, escort, flee, follow to, keep an eye on, ambush (procedure-runs.ts).
- [x] Engine packages: get up, avoid player, steal warning, movement blocked (engine-packages.ts).
- [ ] Wear Sleep Outfit has no simulation case.
- [x] Head tracking (head-tracking.ts).
- [ ] Head tracking: the candidates' scores and look-ahead ours.
- [x] Furniture use: entry, exit, idle markers (actor-furniture.ts).
- [x] Process levels and their budget (process-levels.ts).
- [ ] Process levels: the high-process distance ours; actors away keep a schedule (ours).

## Next biggest

1. Can't Open Doors (60 races).
2. FURN interaction keyword (KNAM, 467) and IDLM Loose Only (72).
3. Not Pushable (9 races), Immobile (2), Always Use Proxy Controller (6), Avoids Roads (4).
4. The settings left: fAIForceGreetingTimer, fAIInDialogueModewithPlayerTimer,
   fFurnitureMarkerAngleTolerance, fActorDefaultTurningSpeed, fJogInterpolationBetweenWalkAndRun,
   fTrackSpeed, fTrackDeadZoneXY / Z.
