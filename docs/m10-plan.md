# M10 plan: AI

Milestone M10 makes Skyrim's actors live: they move, use furniture, keep their schedules, see
and hear, talk, play scenes and fight, as in the game. This file is the map of the whole
milestone in the order it is built, so that nothing is built twice: every layer is built once,
on the layers below it, and the player uses the same layers as the NPCs where the game does
(locomotion, furniture, attacks, hits, death). Check the boxes as steps land; the finished parts
are described in [ai.md](ai.md) and the other docs, and this file goes when M10 is done.

## Where it starts (October 2026)

- **Data:** PACK is parsed in depth and decides where an actor stands as its cell loads
  (`src/ai/package-start.ts`). NAVM (NVNM) is read to the last byte, used only for the
  player's step-up test. Not parsed: NAVI, IDLE, AACT, IDLM data, CSTY, SCEN, RACE attack and
  movement data, NPC\_ attack data and override package lists, PACK combat style, idle lists,
  event topics and fragments, SCEN and PACK VMAD fragments, the animation data text files
  (root motion, attack sets).
- **Actors** are render bundles of their cell (`PlacedActor`, `src/shell/actors.ts`): drawn in
  the cell's scene, unloaded with it, position only in the draw matrix, no collision, no
  per-actor state, no update hook; the two viewers (exterior, interior) each have their own
  copy of the actor logic. A killed actor keeps standing; an actor a script moves into a loaded
  cell is not shown; regrounding snaps moved actors back to their editor place.
- **Scripts:** the AI natives keep flags or return constants; the WorldBridge's AI methods
  (evaluatePackage, startCombat, lookAt, playIdle, killed, ...) are not implemented; condition
  functions that are not valued (IsInCombat, GetDetected, GetSitting, ...) **hold**, so every
  condition on them passes. Scenes are a set of names; no SCEN is read.

## The architecture (built once, used by every step after it)

- **One live actor per reference, owned by the game session** (`src/ai/` for the platform-free
  model, `src/shell/` for drawing): position, heading, cell or worldspace, process level, and
  the state the engine keeps (alive / bleeding out / dead, sitting / sleeping and in what,
  weapon drawn, sneaking, running, combat state and target, current package and procedure,
  detection, look-at target). It survives cell changes and journeys; viewers only attach and
  detach it as the loaded area changes. Plain data, so M12 saves it as it is.
- **Process levels** as the engine's (CommonLibSSE `PROCESS_TYPE`): high (loaded and near:
  character controller, behavior graph, full AI), middle-high (loaded, far: AI at a lower rate,
  no controller, moved along its path), middle-low and low (not loaded: packages run on game
  time, persistent actors carried between cells by their schedules).
- **Actors are drawn in a scene of their own**, not in their editor cell's, so they can walk
  out of it; script moves, enable state, created actors and the dead state come from the game
  state when they are placed.
- **Movement** runs on the physics' fixed step (many subscribers: the player and every
  high-process actor), separate from the animation's throttled update.
- **Locomotion driver** shared by the player and NPCs: a wanted velocity and facing go to the
  character controller; the behavior graph gets Speed (measured), Direction, TurnDelta,
  IsSprinting, IsSneaking, ... and its events; animation-driven states (furniture, attacks,
  turns, staggers) move the actor by their root motion (animation data).
- **Actions** go through the game's idle tree: an action (AACT: ActionDraw, ActionRightAttack,
  ActionIdle, ...) picks the first IDLE under it whose conditions hold, whose animation event
  goes to the graph. The player's actions take the same way.
- **Conditions are always valued:** no AI condition function is left to hold by default.

## Phase 0: data (parsers, CLIs, docs)

Each parser is platform-independent, has unit tests, a Node CLI in `tools/` checked against
every vanilla record, and a section in [formats/esm.md](formats/esm.md) or
[formats/hkx.md](formats/hkx.md).

- [x] **0.1 NAVI and the navmesh graph:** the navmesh info map (NVMI: edge-linked and preferred
      meshes, door links, islands, pathing cell; NVPP precomputed paths and road markers; NVSI),
      the meaning of NVNM edge values on linked edges and of the link and door types; a graph of
      every navmesh of the load order (`navmesh-info.ts`).
- [x] **0.2 Idles and actions:** IDLE (conditions, animation event, parent / previous, flags),
      AACT, the idle tree and action → idle resolution; IDLM (flags, idle list, timer); PACK
      idle lists (IDLF, IDLC, IDLT, IDLA); FURN fields AI needs (FNAM, KNAM, the per-marker
      entry data).
- [x] **0.3 Combat data:** CSTY; RACE attack data (ATKD / ATKE), movement types (WKMV ... SPMV)
      and the DATA fields not read yet (acceleration, deceleration, angular and aim
      tolerances); NPC\_ attack data and override package lists (SPOR, OCOR, GWOR, ECOR, DPLT);
      the AI game settings (fCombat\*, fSneak\*, fDetection\*, fAI\*) listed with their values.
- [x] **0.4 Scenes and the rest of PACK:** SCEN (phases, actors, actions: dialogue, package,
      timer); PACK combat style, event topics and fragments; the VMAD fragments of SCEN and
      PACK; DIAL subtypes by use (Hello, Idle, combat and detection barks).
- [x] **0.5 Animation data:** `meshes\animationdatasinglefile.txt` (clip root motion and
      lengths per project), `animationsetdatasinglefile.txt` (attack sets per weapon equip
      state), `speeddatasinglefile.txt`, `meshes\responses\*.txt`.

## Phase 1: the actor's body

- [x] **1.1 Live actors:** the session-owned actor registry and process lists; an actor scene
      apart from the cells; one code path for both viewers; placed from the game state (script
      moves, enable state, created actors, dead); no snap-back.
- [x] **1.2 Physics presence:** character controllers for high-process actors (the player
      bumps into them, they into each other), the fixed-step hook, the living actors' ragdoll
      bodies keyframed to their pose on the BIPED layer (what hits, picks and sees them);
      trigger volumes see actors (OnTriggerEnter for NPCs).
- [x] **1.3 Locomotion:** the shared driver (above), race and MOVT speeds, turning in place,
      root motion from the animation data, measured speed for the graph.
- [x] **1.4 Death at run time:** Kill and death in combat switch the actor to its ragdoll from
      the pose it has; the dead stay dead when their cell loads again. (Bleedout: 5.1.)
- [ ] **1.5 Procedural animation:** look-at and head tracking (BSLookAtModifier), eyes, foot
      IK, twists, keyframed bones; SetLookAt, the player looked at when near.

## Phase 2: navigation

- [x] **2.1 Paths in the loaded area:** point → triangle (the NVNM search grid), A\* over
      triangles across linked meshes, string pulling, the actor's radius, triangle flags (no
      large creatures, water for swimmers, preferred), door triangles.
- [x] **2.2 Paths across cells:** the NAVI graph through load doors and between interiors and
      worldspaces; precomputed paths for roads; low-process travel along them by game time;
      the exteriors' audit (door to door across cells). docs/ai.md, "Routes";
      `tools/route-info.ts` (`--audit`). Actors of the loaded area take load doors their
      packages' ways lead through; the door's open animation and sound for them: 2.3.
- [x] **2.3 Following a path:** steering, avoidance of other actors and the player, stuck
      detection and new paths, doors on the way (opened, waited for, locked ones avoided or
      unlocked by package), load doors taken (the actor leaves the loaded area or arrives).
      With it the engine's movement blocked and avoid-the-player behaviour: blocked controllers
      seek a way round; the player bumping into an actor (ActionBumpedInto, fBumpReaction*).
      docs/ai.md, "Paths". Moved on: the bumped actor's ActorCollidewithActor line to 4.3.
- [x] **2.4 Audit:** `tools/path-audit.ts`: a path between every two doors of every interior,
      checked against the triangles' connections; what does not connect is listed (exteriors:
      2.2).

## Phase 3: packages

- [x] **3.1 The package stack:** alias packages by quest priority, the actor's own, the default
      list (DPLT); schedules and conditions on the live game; evaluation when the engine does
      it (EvaluatePackage, the hour, cell attach, a package's end), must complete, once per
      day; OnPackageStart / Change / End; begin, end and change actions (idles, topics,
      fragments); the package's idle list; places near the package start and alias
      references; the in-game dialogue package (the actor waits and faces the player). Moved
      on: the override lists (spectator, observe dead, guard warn, combat) and interrupts to
      4.1–4.3 and 5.2, where the situations they answer exist.
- [x] **3.2 Procedures:** the 24 that need no combat (Travel, Sandbox, HoldPosition, Wait,
      Guard, Sit, Patrol, UnlockDoors, Find, Follow, Activate, Sleep, Say, Eat, LockDoors,
      Acquire, Flee, ForceGreet, Escort, Wander, UseIdleMarker, KeepAnEyeOn, FollowTo,
      DialogueActivate), searches by object and object type with ownership, object lists.
      Moved on: UseWeapon, UseMagic, Shout to 5.1–5.3; Hover, Orbit, FlightGrab to 5.4; the
      engine's own alarm, flee, observe combat, react to the dead, search for an attacker to
      4.1 and 5.2; avoid the player and movement blocked to 2.3; landing to 5.4; mount and
      dismount to 3.5.
- [x] **3.3 Furniture and idle markers:** entry points, entering and leaving through the idle
      tree, sit and sleep states, OnSit / OnGetUp, GetSitState; idle markers' idles; sandbox
      idles; the player sits, sleeps in the bed and stands at workbenches the same way.
      docs/ai.md, "Furniture and idle markers".
- [x] **3.4 Actors away:** low process: persistent actors keep their schedules in unloaded
      cells, come into the loaded area through doors, and after waiting, sleeping and fast
      travel are where their packages have them (`package-start.ts` becomes the low-process
      placement). With it the middle-high process: actors of the loaded area beyond the high
      process run their AI and walk without a controller. docs/ai.md, "Actors away".
- [x] **3.5 Followers, horses, carts:** following through doors, teammates, mounts and
      riding, the carts of the opening (horse, cart, seated passengers). docs/ai.md,
      "Followers, mounts and vehicles". Moved on: horses fleeing and fighting to 5.2.

## Phase 4: senses and the social layer

- [x] **4.1 Detection:** the spectator, observe-dead and guard-warn override lists (NPC\_
      SPOR, OCOR, GWOR) and the engine's alarm and react-to-the-dead packages;
      line of sight (eye to eye and body against the world), view cone,
      the light on the target, distance, sound (movement, armour weight, sneaking, impacts'
      detection levels, combat), the sneak skill; detection states per observer and target, NPC
      against NPC; the stealth meter on the HUD; OnGainLOS / OnLostLOS and the detection
      natives and conditions. docs/ai.md, "Detection"; `tools/detection-info.ts`. Moved on:
      the reactions' lines to 4.3; attacks' and spells' noises (`action`), being attacked,
      the fights spectators watch (`fight`), hostility and combat's detection to 5.1–5.3;
      flying targets' reach to 5.4; what alarmed actors do, guards' warnings and witnesses
      (`warn`, `witness`, `offence`), the Stealth perks, Muffle, torches and spells' glow to
      M11.
- [ ] **4.2 Every AI condition and native valued:** the full list from the recon (IsInCombat,
      GetDetected, GetSitting, GetCurrentAIPackage, IsWeaponOut, ...); an unknown function is an
      error in the audit, not a pass.
- [ ] **4.3 Talking:** greetings as the player passes, idle chatter, actors talking to each
      other (DialogueActivate between actors, Sandbox's conversations), barks by subtype (a
      package's topic subtype), LockDoors' warning, Say's own line length and forced
      subtitles, the dialogue camera, emotions on the face, creatures' jaw lines; the
      packages' hello and chatter interrupts; a bumped actor's ActorCollidewithActor line.
- [x] **4.4 Scenes:** phases, actions, the actors' behaviour flags, fragments, the Scene
      natives, IsInScene, IsScenePackageRunning. docs/ai.md, "Scenes"; `tools/scene-info.ts`
      (`--play`). Moved on: combat and watching combat pausing or ending a scene to 5.2, the
      head's turn to 1.5, the responses' speaker and listener idles to 4.3.

## Phase 5: combat

- [ ] **5.1 Combat mechanics (player and NPCs):** drawing and sheathing, attacks from the
      attack data and sets, hits at the hit frame by reach and angle, damage (UESP's weapon
      formula with skill and armour), blocking, bashing, staggers and recoils, power attacks,
      unarmed, bows and arrows (projectiles), killmoves (paired animations and their camera),
      hit reactions, impacts on actors, bleedout for essential and protected actors (and its
      recovery), the enemy health bar, combat music.
- [ ] **5.2 Combat AI:** entering combat (aggression and relationships, assistance, being
      attacked, detection), target choice and threat, combat groups, the combat style's
      movement (circling, flanking, fallback, stalking, strafing), equipment choice by score,
      dodging threats, fleeing (confidence), searching for a lost target, yielding, the end of
      combat, spectators, guards, followers; the combat override package list (NPC\_ ECOR) and
      the packages' combat interrupts (aggro radius, observe combat, friendly fire comments).
- [ ] **5.3 Magic and shouts in combat:** casting (hands, concentration, fire and forget,
      delivery), projectiles, the effects the magic system has, staffs, potions, summons,
      shouts and their recovery. M11 completes the effect archetypes and perks behind it.
- [ ] **5.4 Flying combat:** dragons' hover, orbit, dive, perch, landing, flight grab and
      breath; other fliers.

## Phase 6: the game plays (acceptance)

- [ ] **6.1 Whiterun's day:** 24 game hours in which every actor goes where its packages
      have it, nobody stuck or walking through walls, at 60 fps.
- [ ] **6.2 The opening (MQ101):** the cart ride, the scenes in the cart and in Helgen,
      chargen, Alduin, the escape with Ralof or Hadvar, the keep's fights, out of the cave.
- [ ] **6.3 Fights:** Bleak Falls Barrow's draugr, bandit camps, wolves, the dragon at the
      Western Watchtower, giants, mages.
- [ ] **6.4 Waiting, sleeping and fast travel** with enemies near and in combat.
- [ ] **6.5 The open observations:** an NPC standing in a fire; the carts not moving.

## What is not M10

- **M11:** skill progression from combat, perks, the full magic effect archetypes and shouts'
  effects, crime (bounties, arrests, guards' crime dialogue; M10 gives detection and alarms),
  factions as gameplay.
- **M12:** saving the live actors (their state is plain data from 1.1 on).
- **M13:** tuning where the game's values are not documented (marked TODO(M13) as found).
