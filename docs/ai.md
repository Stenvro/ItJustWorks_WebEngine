# AI

What actors do is milestone M10; [m10-plan.md](m10-plan.md) maps it in the order it is built.

## The actors of the loaded area

The viewers show actors through one stage (`src/shell/actor-stage.ts`), the same for exteriors
and interiors. Each actor is drawn in a scene of its own and belongs to the loaded cell it stands
in now, not to the cell it was placed in, so it can walk or be moved out of that cell; it leaves
the stage with the cell it stands in. A cell that loads brings the actors that are in it now:

- its own references (ACHR), unless the game state has them elsewhere (a script's MoveTo into
  another cell or worldspace) or out of the world (deleted, taken into a container); where a
  script moved one within the cell it stands there, its package does not place it again;
- actors a script moved into it from elsewhere, and those the scripts created in it
  (PlaceAtMe of an NPC\_ or a leveled actor);
- the dead lie as ragdolls: those placed dead and those the running game killed (its
  GameState), when their cell loads again.

Actors are set on the ground where they stand once their cell's collision is in place (a moved
one where it was moved to, never back at its editor place). A script's MoveTo of a staged actor
moves it on the stage, to another loaded cell, or off the stage if the place is not loaded; one
moved into a loaded cell from elsewhere comes onto the stage at once, as does an actor a script
creates there. Its enable state is its cell's (enable parents, quest states) or, for created
ones, the scripts'.

## Movement

How actors move (`src/ai/locomotion.ts`, `src/ai/movement-types.ts`, `src/shell/actor-movers.ts`):

- **Character controllers:** a living actor of a race that walks, on its feet (not in
  furniture), near the player gets a character controller as the player has one
  ([physics.md](physics.md#the-character-controller)): its shape from its skeleton's collision
  bound "BBX" scaled by its race's height and its own scale, set where it stands once its
  ground is in place (and out of what it stands in, as the player's). Nearer than one exterior
  cell (4096 units) it is in the engine's high process; beyond 1.25 times that it loses its
  controller. Beyond it, in the loaded area, it is in the middle-high process: its AI runs and
  it walks its paths without a controller, kept on the navmesh (its height there), its graph
  driven as a controlled one's; coming near it gets its controller where it stands (on the
  floor just under or over its feet). TODO(M13): the engine's process levels (CommonLibSSE
  `ProcessLists`: high, middle-high, middle-low, low) and how often each moves its actors are
  not documented. The controllers are in the world the
  player moves in: the player bumps into actors and they into each other; activation and
  line-of-sight rays still take actors by their body's line (TODO(M10) 1.2).
- **What it wants** is a move request: a way to go (horizontal), a gait (walk, run, sprint) and
  optionally a heading to keep (strafing). On every physics step it turns towards the way it
  goes, or the heading it keeps, at its movement type's rate (rotate while moving, else in place
  walking or running) and goes at the speed of that direction against its facing (the ellipse
  through the four directional speeds); not strafing it goes where it faces, its speed falling
  with the cosine of the turn still to make, so a turn of a right angle or more is made standing
  (the engine's NPCs do not walk sideways out of combat).
- **Movement types:** the one its behavior graph tags while a tagged state is active
  (BSiStateTaggingGenerator's iStateToSetAs is bound to an `iState_<name>` variable; the name is
  the MOVT's MNAM: sneaking locomotion tags iState_NPCSneaking, a draugr's blocking
  DraugrBlocking), else its race's walk and run types (RACE WKMV, RNMV, SPMV), else the Default
  Object Manager's (DOBJ DMWL and DMRN: NPC_Default_MT; DMSP: AIControlledNPC_Sprinting_MT); a
  race's MTYP + SPED gives a movement type speeds of its own. Walking and standing, the human
  graph tags nothing (NPC_Default_MT).
- **Its graph** is driven as the engine's graph data channels do (CommonLibSSE
  `ActorSpeedChannel`, `ActorDirectionChannel`, `ActorTurnDeltaChannel`, ...): Speed (its
  measured speed, from physics step to step), Direction, TurnDelta (degrees per second, left
  positive: the unit inferred from bleedoutTurnMult = |TurnDelta| / 20.5 and the horse's
  turnSpeedMult = |TurnDelta / 112.5|, the sign from the graphs that turn left on
  TurnDelta > 0.1: the dragon's, the Falmer's, the dwarven spheres' and centurions'), IsSprinting, IsSneaking, iSyncIdleLocomotion and the
  movement events (moveStart, moveStop, ...). The player's body is driven the same way. The
  graph's BSSpeedSamplerModifier turns Speed into SpeedSampled, the blend parameter of the
  locomotion blends. Measured on Orgnar: walking 80 units per second plays MT_WalkForward,
  running 370 MT_RunForward.
- **Root motion:** the graph adds up, every update, how its playing clips move the actor (the
  behavior project's animation data, [formats/hkx.md](formats/hkx.md#animation-data)), each by
  its weight on the root bone (camera bobs and other partial poses leave it alone). While the
  graph is animation-driven (bAnimationDriven, set by BSIsActiveModifiers in furniture,
  staggers, dialogue, interactions) or while the actor stands and its clips move it (an attack's
  lunge, a canned turn: NPC_TurnRight90 turns Orgnar 90.1°, NPC_TurnLeft180 180.2°), its root
  motion moves and turns it in the next physics steps instead of its request. TODO(M13): the
  engine's rule is not documented.
- **Trigger volumes** see actors with controllers: OnTriggerEnter and OnTriggerLeave with the
  actor, GetTriggerObjectCount counts them.
- **Bodies:** a living actor near the player also has its race's ragdoll in the world (the
  skeleton model's bodies on the main bones, `src/shell/actor-bodies.ts`), keyframed to its
  animated pose, on the BIPED layer: the crosshair's pick (L_ITEMPICKER collides with
  L_CHARCONTROLLER and L_BIPED) meets the actor and finds it by its body; BIPED does not collide
  with the controllers, so the bodies do not push their own actor.
- **Death:** an actor that dies on the stage (Kill, KillSilent, its health taken to 0) stops:
  its controller goes, its graph and face stop, and its bodies are let go from where its pose
  had them, its pose following them (it falls as a ragdoll from the pose it had). Its cell
  lays it down dead when it loads again (the game state's dead). Bodies being made for it as it
  died are made again for the dead (the killing blow's push waits for them). The player dies
  so too ([Combat](#combat), "The player's death").

## Paths

Actors find their way over the navigation meshes of the loaded area (`src/ai/pathfinding.ts`;
the meshes: [formats/esm.md](formats/esm.md#navigation-meshes)):

- **The search** is A\* over triangles, entering each across the middle of the edge it shares
  with the last: within a mesh, through the links into neighbouring meshes (cell borders) and
  over ledges (a jump up or a drop, at a cost of 256 units more). Triangles flagged for no large
  creatures are closed to large and extra large races (RACE DATA size); water costs four times
  its length to those that do not swim, preferred triangles (roads) half. A goal that cannot be
  reached (another island, past 20,000 triangles) gives the path to where the search came
  nearest to it.
- **The way** is pulled tight through the edges the triangles' chain crosses (the simple stupid
  funnel), each edge narrowed by the actor's radius at both ends (its controller's), so it turns
  round corners an actor's width off them.
- **Following it** (`src/ai/path-follower.ts`): the actor goes to the next point; a point is
  passed within 24 units or once the actor is beyond it towards the next; it arrives within its
  arrival radius of the last. With less than 8 units of headway towards the next point in 1.5
  seconds it is stuck and searches again, three times at most, each time farther from the
  edges (its radius times the search's number).
- **Blocked** (`src/physics/character.ts`): an actor's controller that gets less than 60% of
  its way tries the way turned 30, 55 and 80 degrees right and left and takes the first that
  gets it on (at least 30% of that way, still forward). Where the collision and the navmesh
  part, an actor slides into creases it would press into for ever: Mila Valentia on her way to
  the market, between a foundation (WRDrayGoodsBase) and the road's embankment
  (WRMainRoadPlains02), now walks out along the embankment. Still stuck on its second search,
  it is set on its path's next point if that lies within 64 units and has a floor within 48 of
  it (logged; back where it was if that took it off the floor). TODO(M13): the engine's own
  way out is not documented.
- **Others in the way** (`src/ai/avoidance.ts`): an actor on its way goes round the actors
  with controllers and the player that its way would bring within reach (both radii and 8
  units) in the next 1.5 seconds, the first it would meet: on the side away from it (right of
  one straight ahead), two that meet head-on both keeping right, turning just as far as passing
  needs (at most 1.2 radians). TODO(M13): the engine's avoidance is not documented.
- **Bumped** (`src/shell/actor-movers.ts`): the player walking into an actor's controller (at
  40 units a second or more, towards it) is a bump: where the player came from, clockwise from
  the actor's facing (GetLastBumpDirection), and whether it was small (IsSmallBump: walking).
  The actor plays ActionBumpedInto's idle (NPC_BumpFromFront, _BumpedFromLeft, ...: its tree
  picks by the direction), then, if it stood, steps off the player's way to the side it is on
  after the game's fBumpReactionSmallDelayTime (1 s), fBumpReactionIdealMoveDist (125) away or
  at least fBumpReactionMinMoveDist (75) where the navmesh has room, waits
  fBumpReactionSmallWaitTimer (3 s), and its package goes on. It says its ActorCollidewithActor
  line ([Talking](#talking)). TODO(M13): when the engine counts a bump small, and whether
  actors bumping each other react too.
- **Doors** (`src/shell/actor-doors.ts`): the navmeshes mark only load doors (all 1,220 door
  triangles of the interiors' navmeshes are load doors), so an actor finds a door in its way by
  a ray at its chest along its way, 96 units beyond its shape. A door that is shut opens with
  its open sequence and sound and stays open while actors come to it, shutting 3 seconds after
  the last (its close sequence and sound; TODO(M13): when the engine shuts them is not
  documented); one the player opened stays open. The actor waits before it, facing its way,
  until it has opened. A locked door opens to an actor that carries its key or owns its lock
  (the door's owner, else its cell's: the actor's base, or a faction it has the rank in), or
  whose package unlocks the doors on its way (PKDT "Unlock doors at package start" / "at
  package end"; it is left unlocked; TODO(M13): which doors the engine unlocks). To the others
  it is shut: their way is blocked there and they search again with the triangles within 64
  units of it closed, remembering the door for 30 seconds. In the Bannered Mare Saadia (the
  inn's faction) walks through a locked room door; Sinmir stops before it.
- **Load doors**: an actor whose way leads through one walks to it; it swings open with its
  sound (its sequences, where it has them), and the actor is through it after the game's
  fTeleportDoorActivateDelayTimer (0.6 s); the door on the other side swings as it comes out
  there, if that side is loaded. Routes (below) go only through load doors the actor may pass
  (locked ones as above).
- Measured: Orgnar walks from behind the Sleeping Giant's bar round its end to the player, 1,500
  units in 18.8 seconds at 80 units per second.

`node tools/path-audit.ts` searches a path between every two doors' triangles of every interior
and checks the result against a plain search of the triangles' connections: of 1,197 pairs in
the 331 interiors with two doors or more, 972 connect (300 cells connect every pair) and none
that the triangles connect is missed; 0.19 ms a search on average, 5.7 ms the longest. The pairs
that do not connect lie on islands of their own: Apocrypha's moving books, Dwemer ruins' lifts and
gates (Bthardamz, Nchuand-Zel), Blackreach's elevators, and the like.

## Routes

Beyond the loaded area an actor's way runs from navmesh to navmesh through load doors
(`src/ai/routes.ts`, read by `src/ai/route-map.ts`):

- **Areas:** navmeshes joined by their edge links within one worldspace or interior make one
  area (the NAVI's NVMI records hold the same graph; it is built here from the navmeshes). An
  exterior's area spans the cells its navmeshes link.
- **Load doors** (XTEL) lead from the area of the navmesh nearest the door to the area of the
  navmesh nearest its arrival point. A route is the cheapest chain of doors (Dijkstra over the
  doors, 256 units a door on top of the walk between them, straight lines within an area).
- **Roads:** between two points of an exterior the actor follows the NAVI's precomputed paths
  (NVPP) where that is at most 1.5 times the straight way.
- `node tools/route-info.ts <from> <to>` prints the route between two references (Mila Valentia
  from her house to her market stall: 1 door, 4,713 units); `--audit` routes from 40 load doors'
  arrivals to every other door: of the 2,153 load doors 1,334 of 1,560 routes are found, 3.2
  doors a route, 13 ms a search. Those not found start or end where no door leads on: scripted
  places reached by a quest's teleport (Skuldafn, Sovngarde, Japhet's Folly, Blackreach's
  elevators).

## Packages

The living actors near the player run their AI packages once the running game's scripts are
there (`src/ai/package-runtime.ts`, `src/shell/actor-ai.ts`), in Play and in the sandbox:

- **Which package:** the first of its packages, in order, whose schedule fits the game's time
  (as at the start, below), that has not run today if it runs once a day, and whose conditions
  hold on the running game (`ScriptRuntime.conditionsHold`, with the package's data inputs for
  GetNumericPackageData, IsNullPackageData and conditions run on package data): the packages of
  the quest aliases that hold it first (by quest priority), then its own, then its default
  package list (NPC\_ DPLT, a form list; its template's with the Use Def Pack List flag). While
  it talks with the player (the engine's in-game dialogue package) its package waits: it stops
  where it is and faces the player (in furniture it stays seated). An override list its
  situation names (spectator, observe corpse, guard warn: [Detection](#detection)) comes before
  them all; the engine's own reactions hold its package while they run, as do a conversation
  with another actor and a greeting it stops for ([Talking](#talking)); the package's interrupt
  flags say whether it greets, chatters, talks with others and comments. In combat its packages
  wait; its combat override list (ECOR) keeps it to its package's place ([Combat AI](#combat-ai)).
- **When:** as the hour changes, every 2 seconds (TODO(M13): the engine's rate), when its package
  ends, and when a script asks (EvaluatePackage). One that must complete (PKDT flag 0x4) is not
  left before it has. Its scripts hear of it: OnPackageStart (the new package), OnPackageChange
  (the one left), OnPackageEnd (one that ended), and the package's own fragments (begin, change,
  end) run, and its begin, change and end actions: an idle played, a topic said. While it
  runs, the actor plays the package's idles (its IDLA list, else its template's) whenever it
  stands still, one each timer (at least 8 seconds apart). GetCurrentPackage and
  GetIsCurrentPackage answer from it.
- **Its tree** runs from the root (Creation Kit: Procedure Tree; the engine's rules are not
  documented, these are its names'): a Sequence runs its children in order, one whose conditions
  do not hold skipped; a Stacked branch the first child that may run; a Simultaneous branch all
  of them at once, ending as its first ends (those beside it stop then: the Sleep template
  finds a bed while it sandboxes, then sleeps; TODO(M13)); a Random branch one that may run,
  at random. A procedure runs until it
  succeeds or fails; one whose success completes the package (FNAM 0x1) ends it; a branch that
  repeats when complete (PRCB 0x1) starts over. The package's preferred speed (PKDT, with its
  flag) is its gait: jog and run run, walk and fast walk walk.
- **Procedures' parameters:** each procedure takes its inputs by slot (PKC2) in an order of its
  own, which no documentation gives: every template names the inputs it gives a procedure
  (BNAM), and over the 7,633 vanilla packages the names and types agree slot by slot
  (`src/ai/procedures.ts`; `node tools/package-info.ts --procedures` checks the table against
  the data: no slot differs). A slot may take more than one type: a target a SingleRef or the
  ObjectList a Find filled ("Found Bed", "Found Chair"), a place to travel to a Location or a
  reference.
- **Procedures** (`src/ai/procedure-runs.ts`): Travel goes to its place (within its radius) and
  succeeds there; HoldPosition and Guard go to theirs and stay, facing their marker's way; Wait
  stands for its seconds (0: for as long as the package runs); Patrol goes from its start along
  the references each links to (XLKR without a keyword), round again if repeatable, starting at
  the nearest point if so set; Follow keeps within its maximum radius of its target, closing to
  its minimum; Wander goes from one random point of its place to another between pauses;
  Sandbox passes the time in its place (below); Sit, Sleep and UseIdleMarker use their furniture
  (their target, or the first free one a Find found) or idle marker and stay while the package
  runs. Find keeps what its criteria name within its place in its object list (nearest first;
  without Allow Stealing only what the actor may use: below); Acquire picks those up; Activate
  goes to its target and activates it (furniture: uses it); Eat plays its eating idle with food
  it carries (one used up) or, with Create Fake Food, food made for the meal (ActionIdle's
  EatingRoot or DrinkingRoot by GetIsUsedItemType); LockDoors and UnlockDoors lock and unlock
  the load doors of their place (a door without a lock gets a novice one); Say says its topic,
  facing its target; ForceGreet waits at its place until the player comes into its trigger
  area, goes to them and opens the conversation with its topic; DialogueActivate talks to the
  player from its place; KeepAnEyeOn watches its target in its observation area and pursues it
  in its pursuit area; Escort leads its target to the destination, waiting for it where it
  falls behind; FollowTo follows until one of them reaches the destination; Flee runs to its
  place, else away from what it flees. A procedure that does not use furniture gets the actor
  up first. Hover, Orbit and FlightGrab fly a flier ([Flying combat](#flying-combat); one
  that cannot fly holds its place). TODO(M10) 5.1–5.3: UseWeapon, UseMagic, Shout (they hold
  the actor until combat runs); 3.2: Sandbox's eating. Sandbox with Allow Conversation lets
  its actor talk with others; Say says its topic (or a topic subtype's line) to its target,
  waiting for the line itself with Finish Speaking, its subtitle forced with Force Subtitle;
  LockDoors with Warn Before Locking first tells a player inside to go (TimeToGo) and locks
  after fAITrespassWarningTimer (5 s; TODO(M11): trespass if they stay); DialogueActivate with
  another actor as its target talks with it ([Talking](#talking)).
- **Searching** (`src/shell/actor-search.ts`): a criterion names references by object (a base
  object, a form list of them, a faction's members) or by object type
  (`src/ai/object-types.ts`, xEdit's object type enum: food is ALCH with the food flag, beds and
  chairs furniture with sleep or sit markers, melee and ranged weapons by their animation
  type, ...) among the enabled objects, markers and actors of the loaded area. An actor may use
  what it, or a faction it belongs to at the owner's rank (XRNK), owns, or what no one owns: the
  reference's owner (XOWN), else its cell's (UESP, "Crime"). A target named by object or type
  is the nearest within 4096 units.
- **Places:** near a reference (its placement and the radius), near the linked reference of a
  keyword, near the editor location, in a cell (round the actor while it is in it), near self,
  near where the package began, near the reference an alias of the package's quest (QNAM)
  holds; targets also by an alias. TODO(M10) 3.2: an alias's location, objects and object types
  as places (no vanilla package names either). A place outside the loaded area: the actor stays
  while its package runs (TODO(M10) 2.2, 3.4).
- Measured: at 8:00 in Whiterun the Imperial guards walk their patrols (600–800 units in ten
  seconds), the gate guard goes to his chair; in the Bannered Mare Hulda, Mikael and Sinmir run
  their sandbox packages, and Saadia hers from her default list. At 2:00 in Carlotta Valentia's
  house Mila runs her Sleep package: Find finds her bed, she gets into it and sleeps, and the
  house's door is locked.

## Furniture and idle markers

Actors use furniture as the engine's furniture handling does, as far as the data shows it
(`src/shell/actor-furniture.ts`):

- **The marker and the way in:** of the furniture's model markers
  ([nif.md](formats/nif.md#furniture-markers)) the record makes some active (FURN MNAM); the
  actor takes the free one nearest it (of the kinds its procedure uses) and the entry point (the
  record's FNPR, less those NAM0 disables) that faces it: front, behind, left, right, up.
- **The idle:** the enter and exit animations come from the idle tree under ActionActivate
  (`src/ai/idle-records.ts`), its conditions valued on the actor and the furniture: GetSitting /
  GetSleeping (2 about to enter, 3 in it, 4 about to leave), IsFurnitureAnimType,
  IsFurnitureEntryType, HasKeyword on the furniture (isBarStool, FurnitureCounterLeanMarker,
  isJarlChair, ...), IsChild, IsEnteringInteractionQuick. A chair from the front is
  IdleChairFrontEnter, a bar stool (entered from behind) IdleStoolEnter, the bar counter
  IdleBarCounterEnter, a bed IdleBedLeftEnterStart.
- **Where it begins:** a run of a copy of the actor's graph with no pose (`BehaviorRuntime.update
(dt, false)`) sends the idle's event and adds up its clips' root motion until it is still:
  IdleChairFrontEnter moves 55 units forward and turns 184° in 3.8 s, IdleStoolEnter 25 forward,
  IdleBedLeftEnterStart 74 forward and 90° left. The actor walks to where that motion ends at the
  marker, turns to its heading there, and its controller goes; its graph's root motion moves it in,
  and what is left to the marker at the end is made up in a quarter of a second (the engine's
  path tweener; its rule is not documented). Leaving, the exit's root motion takes it out; then
  it stands and its controller is back.
- **The height:** the actor's root stays at the furniture's own height. The furniture clips put
  the body on the seat or the bed themselves: seated on a chair the pelvis is 39 above the root,
  on a bar stool 55, lying in a bed 53, in a bedroll 21, and the feet stay 6 above it; their
  marker heights (34, 49, 37, 7) are the seats the clips were made for, and no clip moves the
  root up or down. The opening's prisoner carriage is no furniture: its riders stand at its root
  (below, "Followers, mounts and vehicles"). TODO(M13): furniture whose markers are high above
  its origin (the carts' seats, 59 and 132; creature alcoves, 114).
- **States and events:** GetSitState / GetSleepState and the conditions above answer from it;
  IsFurnitureInUse and IsFurnitureMarkerInUse; the actor's scripts hear OnSit once it is in and
  OnGetUp once it stands. An actor placed in furniture as its cell loads is in it at once by the
  instant idle (IdleChairEnterInstant, ...), sent after the enter it would have had: the graphs
  take an instant idle only within the furniture's own state, which the enters lead to
  (MT_RootBehavior goes to ChairRoot_State on IdleChairFrontEnter, whose IdleChairEnterInstant
  goes on to ChairIdleState). Its exit is measured after the same events.
- **Idle markers** (IDLM, not drawn; with the furniture markers they are the cells' markers:
  `CellData.markers`): the actor goes to it, faces its way and plays its idles (IDLA), in order or
  one picked each time (IDLF 0x1), once through if so set (0x4), one each time its timer (IDLT)
  runs out. An idle with no event plays the first of its children whose conditions hold. Leaving,
  IdleForceDefaultState ends it. PlayIdle plays an idle the same way.
- **Sandbox** passes the time in its place: it uses the free furniture and idle markers within
  the place's radius and on its floor that sandboxing does not ignore (FURN FNAM 0x2, IDLF 0x10)
  and, for a child, that children may use: chairs, benches and counters to lean on (Allow
  Sitting), beds (Allow Sleeping), furniture with the FurnitureSpecial keyword — workbenches, the
  forge, the wood chopping block (Allow Special Furniture), idle markers (Allow Idle Markers) —
  or wanders (Allow Wandering). One thing at a time, for 15 s plus 0.6 s per point of energy
  below 100 (half to one and a half times that). TODO(M13): the engine's choice and timing.
- **The player** (`src/shell/player-furniture.ts`) sits on chairs and benches ("Sit", sSit) and
  stands at workbenches the same way: the idle tree gives the player's own idles where it has
  them (IdleStoolEnterPlayer, IdleTableEnterPlayer: GetIsID(Player)); the engine slides and turns
  them to where the enter begins (300 units a second, at least 0.15 s) instead of letting them
  walk. In it their controls only look round; a movement key gets them up. A workbench's
  crafting menu opens once they are in it, and closing it gets them up. Furniture with
  FurnitureForce3rdPerson or FurnitureForce1stPerson sets the camera while it is used (the
  cooking spit, the forge), the camera toggle locked. Beds open the sleep menu, as in the game.
- **How actors move**, for their conditions and natives: IsMoving, IsRunning, IsSprinting,
  IsSneaking, IsSwimming, IsPathing and GetMovementSpeed answer from the player's input and an
  actor's controller and travel (`ActorMotion`); GetGraphVariableInt / Float from its graph.
- Measured in the Bannered Mare at 8:00: Hulda leans on the bar counter, Mikael sits on a bar
  stool at it and later leans, Sinmir sits on the bench by the hearth.

## Where packages put actors

An actor's editor placement is often not where the game shows it. Whiterun's Imperial guards
stand in a cluster above the Cloud District until their packages put them on their posts. Draugr,
Falmer and Dwemer spiders are placed 32 to 512 units in front of the alcoves, wall pods and
pipes they wait in. Town people are placed in the houses they sleep in. In the game an actor's
AI decides where it is long before the player arrives, so as its cell loads it is where its
package has it (`src/ai/package-start.ts`; check: `node tools/package-info.ts <reference>` for
one actor, `--audit` for cells):

- **The package that runs:** the first in the actor's list (PKID of the NPC\_ its templates give
  AI packages from, template flag 0x20) whose schedule fits the game's time and whose
  conditions hold. A night that began yesterday counts by yesterday's day of the week.
- **Its first procedure:** a template's tree (else the package's own) is walked in order. Of a
  Sequence or Stacked branch the first child whose conditions hold runs; a Simultaneous
  branch's first child gives the place. The procedure's inputs (PKC2) are the package's data
  inputs over its template's defaults.
- **The place:** the procedure's first input that is a location or a target.
  - A reference: the actor is on it (its position and heading) if it is in the actor's cell or
    worldspace, else in another (not in this cell). Near a reference with a radius (a sandbox's
    area) an actor placed within the radius stays where it was placed; else it stands on the
    navmesh nearest the reference (a sandbox's marker may lie in a hearth's fire). A Sit, Sleep
    or UseIdleMarker on furniture puts it in the furniture, which holds it (no character
    controller), at the furniture's first active marker
    ([nif.md](formats/nif.md#furniture-markers)), facing its heading, by the instant idle
    (above).
  - A linked reference (XLKR of a keyword), "in cell" (here or elsewhere), near the editor
    location, the package start or self (where it was placed).
  - An actor (the player, a follower's leader): it moves, so the actor stays where it was placed.
- **Conditions** are valued where the data decides them: GetIsID, GetInFaction,
  GetFactionRank, GetIsRace, GetIsSex, GetGlobalValue (the global's starting value),
  GetCurrentTime, GetDayOfWeek, IsInInterior, HasLinkedRef, GetNumericPackageData (the
  package's own input) and Variable01..10 actor values (0 until a script sets them). Quests
  that do not start with the game are at stage 0 with no stage done. Those that do (QUST DNAM
  0x01) have their start-up stage done. Where a script fragment runs on that stage, its effects
  are not known, nor are quest aliases' packages (ALPC; they run before the actor's own) until
  the Papyrus VM runs the quests (M8).
- **Not decided** where a condition is not known (random chance, the player's state, package
  data, alias references), a Random branch chooses, a linked reference is missing (the Civil
  War scripts link guards to their posts during sieges) or the place is found by searching
  (objects of a type, the nearest bed). Then the actor stays where it was placed.

The game starts on a Sundas, the 17th of Last Seed 4E 201 (the GameDay, GameMonth and GameYear
globals; UESP gives the day of the week). The clock counts its midnights (`GameSession.gameDaysPassed`)
for the days of the week.

At 10:00 on the first day, of Whiterun's 32 actors 5 guards start on their patrol and post
markers, 11 are elsewhere (asleep in the barracks and the jail, at the main gate in Tamriel), a
cow stays where it was placed, 1 is dead and 14 are not decided (10 garrison guards whose
posts the Civil War scripts link, 4 on conditions about the player and quests). Of 4873 actors in interiors
enabled at a new game, 1088 start on a reference (912 of them in ambush furniture: creature
alcoves, Dwemer pipes, dragon priests' coffins, Falmer wall pods), 169 are elsewhere, 2180
stay, 498 are not decided and 938 are dead.

Once the cell is loaded the packages run (above); the actors away follow this placement (below).
With the running game's scripts, quest state and
globals are theirs, and the packages of the aliases that hold an actor come before its own
(by quest priority, as the Creation Kit stacks them); without them an actor an alias may hold
is not decided.

## Followers, mounts and vehicles

Actors follow the player, ride horses and carts (`src/ai/followers.ts`, `mounts.ts`,
`vehicles.ts`; the stage: `src/shell/actor-followers.ts`, `actor-mounts.ts`,
`actor-vehicles.ts`):

- **Followers:** an actor whose package follows a leader (Follow, FollowTo) keeps within its
  maximum radius, closing to its minimum plus fFollowSpaceBetweenFollowers (192) for each of
  the leader's followers nearer it, so they go one behind another; it runs when more than twice
  its radius behind or when the leader runs. The player's followers (DialogueFollower's
  FollowerPackageTemplate follows while WaitingForPlayer is 0 and waits while it is 1: waiting
  is the scripts') come along through load doors and on fast travel: they are put beside the
  player's arrival (one spacing apart, row behind row) in the game state, and show as that place
  loads; on fast travel to an exterior the player's last ridden horse comes too. Teammates
  (SetPlayerTeammate) sneak while the player sneaks. One more than 2048 units behind and out of
  the player's sight (beyond 55° of their view) for 3 seconds is put 512 units behind them on
  the navmesh. TODO(M13): the engine's catch-up rule, where it puts those coming along, Need
  LOS and Accompany. GetPlayerTeammate and GetPlayerTeammateCount answer from the game state.
- **Mounting** goes through the idle tree as furniture does: under ActionActivate, HorseEvents
  (the horse HasKeyword ActorTypeHorse) gives Mount (HorseEnter) and Dismount (HorseExit,
  HorseExitSwim). Both are paired animations: rider and horse stand at the horse's root while
  they play, the horse's graph gets the event with "pa\_" before it; the rider's graph raises
  NPCpairedStop and NPCHorseExitOut at their end, and is sent pairedStop and HorseExitOut (the
  horse PairEnd). The rider starts at the race's mount offset (HorseRace DATA: 63.5 units to
  the horse's left, facing it: the clip's "NPC" track says the same) and gets off 111.6 units
  to its left (the dismount's end). Riding, its root is on the horse's SaddleBone (its
  HorseRider_State poses its pelvis at the root), its graphs driven by the horse's movement;
  the horse's own AI waits. GetSitting answers 2, 3 and 4 for a rider mounting, riding and
  getting off; IsRidingHorse, IsBeingRidden, IsOnMount, Dismount and IsPlayersLastRiddenHorse
  answer from it.
- **The player** rides a horse by activating it: "Ride" (sRide), "Steal Horse" (sStealHorse)
  for one owned (XOWN) by another that is neither bought (PlayerHorseFaction) nor the last they
  rode (TODO(M11): the crime). Mounted, the movement keys send the horse the way the camera
  looks (it turns as it goes; back alone it backs up), Run and Sprint walk, run and gallop it;
  Activate gets them off. They are carried on the saddle in the physics steps (their shape out
  of the world), so their camera rides with the horse. TODO(M13): the engine's horse controls,
  the path tweener to the mount place, mounting from the right.
- **Actors riding:** a procedure that lets an actor ride ("Ride Horse If Possible": Travel,
  Patrol, Follow, ...) mounts its horse (its ACHR's XHOR: General Tullius' MQ101TulliusHorse)
  within 2048 units before it sets out, and its travel moves the horse; one that does not gets
  it off first, as do using furniture, taking and activating, and load doors
  (sNotAllowedToUseAutoDoorsWhileonHorse).
- **Carts:** TetherToHorse hitches a cart to a horse; a horse standing off the cart's shafts is
  put in them, 210.6 units ahead of its front axle (the opening's first cart stands so in the
  editor, the second 411 behind its horse). The cart is taken out of its cell and towed on every
  physics step: the prisoner carriage's front axle pivot (its model's origin) trails the horse at
  that length, its rear axle (214.85 behind) trails the pivot, on the navmesh's height; the
  FrontBar turns towards the horse within its hinge (±40°) and the wheels roll (49.5 and 59.4
  units). Its bodies are keyframed there. TODO(M13): the engine pulls the simulated bodies by a
  constraint. The cart's travel is its horse's packages (the opening's PatrolStaticPathing along
  58 markers, 29,000 units to Helgen: towed along them its front axle turns at most 25°);
  `ActorVehicles.startTravel` has the horse choose its package again, as the opening's stage 15
  and a scene's package action do.
- **Riding a vehicle** (SetVehicle): the actor's root is the vehicle's (its position, heading and
  pitch); its riding idles seat it there (IdleCartPrisonerASway: the pelvis 200 units behind and
  139 above the cart's origin; the driver's 11 behind) and its exit idle's root motion takes it
  out (CartPrisonerAExit: 380 units out of the back). The idles reach the cart state through
  Master_Behavior's global wildcards. The player rides so too, carried in the physics steps;
  their PlayIdle plays as an actor's. An actor's AI that goes somewhere lets it off.

## Actors away

Actors that are not in the loaded area keep their schedules (the low process,
`src/shell/actors-away.ts`). Their schedules are asked for the actors of the player's space and
of the spaces one load door from it: those placed there (an interior's actors, a worldspace's
persistent ones) and those the game state has there, living and enabled; each where its package
has it now (the placement above, from its packages, factions, race and sex, read once).

- **When the hour changes** an actor its package wants elsewhere sets out from where it is. Its
  trip follows the route (above) door to door at its walk speed (the default movement type's,
  MOVT), along the roads where they serve. The game state has it in each space it comes into
  through a door (a script asking for its cell or worldspace gets that one; TODO(M13): its
  place along the way between). On a cell that is loaded it comes onto the
  stage there and walks on with its package (it comes out of a load door into the loaded area,
  or walks into it).
- **When the game's time jumps** (waiting, sleeping, fast travel, a console `set gamehour`: more
  than 10 game minutes beyond what the clock ran) trips end at once and every actor asked is
  put where its package has it. So too when the player comes into another worldspace or
  interior: what is there is where it should be as it loads.
- An actor of the loaded area on its way through a load door its package takes leaves the stage
  through it, and its trip goes on from the door's arrival point.
- Asked 16 at a time: at Whiterun's plains district 449 actors in 38 spaces in 8 seconds at the
  start (the jump as the game loads), 0.6 seconds at an hour's change. At 9:00 Mila Valentia
  steps out of her house's door and walks to her stall at the market; set to 10:00 she stands
  there at once. TODO(M13): the engine's rule for who keeps a schedule while away (persistent
  references, the low process's reach) and its pace are not documented.

A procedure that would go round without ever waiting (each step ending at once: a patrol of
one point the actor stands on was one) is stopped after 100,000 rounds within one update: its
package ends as failed and is chosen again later, so a fault in one actor's AI does not hang
the game.

## Detection

What the actors notice (`src/ai/detection.ts`, `src/ai/detection-states.ts`,
`src/ai/light-level.ts`, `src/ai/reactions.ts`, wired in `src/shell/actor-senses.ts`; check:
`node tools/detection-info.ts --settings | --records | --level ...`).

- **Who tests whom:** every living actor of the high process tests the player and the other
  actors of the high process, each every fDetectionUpdateTimeMin (1 s) near the player to
  fDetectionUpdateTimeMax (2 s) at detection's reach; scripts' questions (GetDetected,
  IsDetectedBy) test anew when the last test is older than a second (the Construction Set
  wiki: GetDetected runs the formula). Beyond the reach (fSneakMaxDistance 2500, times
  fSneakExteriorDistanceMult 2.1 outside; fSneakFlyingDistanceMult 3 for a target in the air:
  [Flying combat](#flying-combat)) a target is not tested.
- **The formula** (UESP "Skyrim:Sneak" for its terms; the predecessor engine's documented
  formula, The Fallout Wiki "Detection Formula" and the Construction Set wiki "Detection", for
  those UESP leaves open):

  level = fSneakBaseValue + A × (sound + visual) + fSneakSkillMult × (perception × A − the
  target's Sneak while it sneaks out of combat), A = ((reach − distance) / reach) ^
  fSneakDistanceAttenuationExponent;

  sound = fSneakSoundsMult × (moving: (fSneakEquippedWeightBase + fSneakEquippedWeightMult ×
  the weight of the armour worn) × fSneakRunningMult running or sprinting × MovementNoiseMult;
  plus its action's loudness (iSoundLevel\* of the sound level) × fSneakActionMult for
  fDetectionActionTimer), × fSneakSoundLosMult without line of sight, none swimming;

  visual (seen and awake) = fSneakLightMult (× fSneakLightExteriorMult outside) ×
  (fDetectionSneakLightMod + light, × fDetectionNightEyeBonus with night eye) × (1 +
  fSneakLightMoveMult moving + fSneakLightRunMult running) × fSneakDetectionSize\* of its
  race's size × (1 − Blindness / 100), × fSneakStealthBoyMult invisible;

  perception = the observer's Sneak within fSneakPerceptionSkillMin and Max, × (1 +
  fSneakAlertMod alerted + fSneakSleepBonus asleep + fSneakCombatMod in combat with the
  target).

  UESP writes the observer's skill twice (attenuated, and unattenuated against the target's);
  with that an observer of middling skill detects a sneaking target in the dark, unseen and
  unheard, anywhere in reach, so the predecessor's single attenuated term is taken
  (TODO(M13)). Skyrim.esm stores 18 fSneak\* settings and fDetectionSneakLightMod; the others
  are the engine's built-in values (BeermotorWB's "All Skyrim Game Settings", linked from AFK
  Mods): fSneakEquippedWeightBase 12, Mult 0.5, fSneakLightMoveMult 0.01, fSneakLightRunMult
  0.2, fSneakNoticeMin −20, iAICombatMinDetection −50, fDetectionViewCone 190, iSoundLevelLoud
  100, Normal 50, VeryLoud 200 (Silent 10 is Skyrim.esm's), ... TODO(M11): the Stealth perks
  and Muffle. `node tools/detection-info.ts --level sneak=15 light=40 distance=500`: −2.9,
  noticed; Sneak 100 in light 10 at 300: −48.9, unseen.

- **Sight:** a ray on the line-of-sight layer (L_LINEOFSIGHT: static, clutter, props, trees,
  terrain, the actors' BIPED bodies, ...; not the character controllers, not transparent
  collision) from the observer's eyes (92% of its controller's height standing, 62% sitting,
  20% lying) to the target's head or chest, past the observer's own bodies. Seen: in line of
  sight within its sight's reach: the full reach within fDetectionLOSDistanceAngle (60°, 30°
  either side) of its facing, fDetectionLOSDistanceMultInterior 0.75 / Exterior 0.5 of it to
  the edge of the view cone (fDetectionViewCone 190°), none behind. TODO(M13): how the engine
  reads the angles.
- **The light on the target** (GetLightLevel): the luminance of the view's lighting at its
  chest times 100: the mean of the six directional ambients, the directional light where a ray
  to the sun is clear (inside always), each point light within its radius with the renderer's
  falloff 1 − (d / r)²; plus iLightLevelInteriorMod (25) inside or iLightLevelExteriorMod (0),
  at most iLightLevelMax (300). TODO(M13): the engine's own sum (players read 0 to 150 and
  more). TODO(M11): torches carried and spells in hand.
- **States** per observer and target: detected above 0 (in combat with the target above
  iAICombatMinDetection), noticed above fSneakNoticeMin, searching once a noticed or detected
  target is lost (or a noise heard) for fDetectionStateExpireTime (30 s), else unseen. Each
  change is told (`Detections.listen`: detected, noticed, searching, lost; heard, witnessed,
  alarm, attacked, corpse).
- **Noises** (detection events: CreateDetectionEvent, the sound level of an impact that
  sounded, `ActorSenses.noise`): heard by the actors within fDetectEventDistancePlayer (1536)
  of the player's, fDetectEventDistanceNPC (512) of others' (fDetectEventDistanceVeryLoudMult
  2 very loud, fDetectEventSneakDistanceVeryLoud 3072 very loud while sneaking), at
  fSneakBaseValue + the loudness attenuated over that reach (× fSneakSoundLosMult unseen) +
  the attenuated perception; above fSneakNoticeMin the hearer is alerted there (GetIsAlerted)
  and searches. The data: IPCT sound levels normal 659, loud 1, silent 3; every footstep impact
  (10,686) is normal; WEAP VNAM loud 888, normal 1702, silent 738 (`action`: an attack's noise,
  5.1); MGEF casting loud 1307, normal 163, silent 170, very loud 91 (5.3).
- **Reactions:** an actor whose package allows it (PKDT interrupt flags: reactions to the
  player's actions, greeting corpses, observing combat) and that is not talking, in a scene or
  in furniture reacts. Its override list for the situation (the quest aliases' that hold it,
  else its NPC\_'s under template flag 0x400: SPOR spectator, OCOR observe corpse, GWOR guard
  warn) comes before its packages for fDetectionStateExpireTime; vanilla has SPOR on 2 NPC\_
  (Fellglow's prisoners) and 3 aliases, OCOR and GWOR on 2 aliases, and no package of those
  interrupt overrides. Else the engine's reaction holds its package: searching (one sneaking
  it noticed, a noise it heard, one it lost that it is hostile to: 5.2): it turns to the place
  (fCombatSearchLookTime), walks to within fCombatSearchLocationInvestigateDistance (256),
  looks round three times (fCombatSearchInvestigateTime 2.5 s); observing the dead: every
  fCheckDeadBodyTimer (20 s) it looks for one that died within iHoursToClearCorpses (24 game
  hours) in its sight, walks to the body and looks at it for 5 s; spectating (`fight`, 5.2):
  it keeps fAIInteriorSpectatorDistance (200) / Exterior (450) from the fight, facing it, until
  its last blow is fAISpectatorRememberThreatTimer old; a guard's warning (`warn`: trespass) goes to
  the one warned and faces them. Their lines (NormalToAlert, AlertToNormal, NoticeCorpse, the
  warning) are barks ([Talking](#talking)) to what they react to. TODO(M13): the engine's
  steps.
- **Sneaking:** the player's Sneak key; an actor sneaks while its package says Always Sneak
  (PKDT 0x20000, 52 vanilla packages) or after StartSneaking (until its package changes): its
  graph's IsSneaking, its sneaking movement type, IsSneaking.
- **The stealth eye** ([ui.md](ui.md#the-hud)): shut unseen, slightly open noticed (opening as
  the level nears 0), half open searching, open detected, for the actor that knows the player
  best (not teammates, not those SetNotShowOnStealthMeter hides). TODO(M13): the engine's
  mapping.
- **Scripts:** the conditions GetDetected, GetLineOfSight, GetLightLevel, GetAlarmed,
  GetAttacked, GetIsAlerted, IsSneaking; the natives IsDetectedBy, HasLOS, GetLightLevel,
  IsAlarmed, StartSneaking, SetNotShowOnStealthMeter, SendAssaultAlarm, SendTrespassAlarm,
  SendStealAlarm (the actors within iCrimeAlarmRecDistance are alarmed; guards among them pursue:
  [Crime and factions](gameplay.md#crime-and-factions)), StopCombatAlarm, CreateDetectionEvent; OnGainLOS / OnLostLOS for the pairs scripts
  register (every quarter second; the player sees what is on screen with nothing between the
  camera and it; the first look tells how it is).
- **For combat (5.2) and crime (M11):** `ActorSenses.detections` (state, level, detects,
  detectors, known, lastKnown, listen), `noise`, `action`, `attackedBy`, `fight`, `warn`, the
  hooks `inCombat` and `hostile` (the combat AI sets them), `combatOverrides` (ECOR),
  `endReaction` (an actor entering combat), and `Detections.witness` / `offence` (the observers
  that detect an actor seeing it steal, attack, trespass: 'witnessed').

## Scenes

A quest's scenes (SCEN, [formats/esm.md](formats/esm.md#scenes)) play as the running game's
scripts start them (`src/ai/scene-runtime.ts`; the game it asks: `src/scripting/runtime/scene-host.ts`).
The Creation Kit names the fields and CommonLibSSE the structures (BGSScene, BGSSceneAction\*);
how the engine plays them is not documented, so the rules here are read from the 2,131 vanilla
scenes. `node tools/scene-info.ts <scene>` shows what each phase waits for, `--play <scene>`
plays one on a clock (its conditions taken to hold, lines as long as their text, packages done
after `--package-seconds`).

- **Starting:** Scene.Start and ForceStart, and a quest's start for its scenes that begin on
  quest start (a stage fragment or the story manager starting the quest starts them). A scene
  starts if its quest runs, its conditions hold (run on the player) and every actor that is not
  optional is there: the reference its alias holds, alive. Its actors are in it until it ends
  (IsInScene, GetCurrentScene). An actor that plays in another scene leaves that one for a
  forced start or for a start against an interruptible scene (that scene ends, unless the actor
  was optional there); otherwise the start waits until its actors are free: MQ101's stage
  fragment starts Scene4, the execution, before it stops Scene1, the cart ride, whose actors
  Scene4 needs. TODO(M13): whether the engine queues such a start.
- **Phases** run in order. One whose start conditions do not hold is skipped (the actions that
  start in it do not run). A phase that runs starts its actions, then completes when its
  completion conditions hold, whether or not its actions are done: 907 vanilla completion
  conditions are IsSceneActionComplete of an action that ends in that very phase (593 beside
  other actions ending there, often a timer beside packages that never complete), which would
  say nothing if the phase waited for its actions; MQ101Scene1's first phase waits on the
  player's 3D while its look-only lines run. Without completion conditions it completes when the
  actions that end in it are done (1,768 package actions whose package completes end in such
  phases: the actor's walk is waited for); with none ending in it, at once. Its actions that end there
  end with it. Phase conditions run on the scene's first actor (IsInDialogueWithPlayer in
  MS13ArvelStuck, GetDistance in MS14ThonnirFindLaelette: scenes of one actor), else the
  player. TODO(M13): the engine's subject.
- **Lines** (dialogue actions): the actor says the topic's first info whose conditions hold for
  it, run on whom it speaks to (its look target, else the player): the info's begin fragment,
  each response in its voice with its lips moving, the response's emotion (a neutral one takes
  the action's, DEMO / DEVA) on its face, the subtitle with General Subtitles or the info's
  Force Subtitle (`src/shell/scene-lines.ts`), the end fragment. A speaker that is not loaded
  says it silently, as long as its text takes (fAIDefaultSpeechMult a character). Lines of one
  phase are said at once. A line without a topic (3,110: the actor only looks) is done at once:
  31 phases end with only such lines and no completion conditions. A looping line (116) is
  said again every DMIN to DMAX seconds until it ends and is done once said: DLC2WE05Scene's
  second phase, a looping line beside a package and no conditions, would never end otherwise.
  TODO(M13): the engine's rule; Show All Text (FNAM 0x4, 1,394 scenes) is read as the scene
  editor's display and does nothing. Each response is said as the actors' other lines are
  ([Talking](#talking)): gestures, the speaker's and listener's idles, the voice's reach.
- **Looks:** while a dialogue action runs its actor looks at the actor it names (HTID), else,
  with Headtrack Player, at the player (MQ302's council looks at Arngeir, who names himself
  and so looks at the player); a later action of the same actor takes over, and one that names
  nobody clears its head tracking (MS13CamillaEscortPlayerScene's "Clear headtracking" phase).
  The head turns through the world's look-at (WorldBridge.lookAt, as SetLookAt; TODO(M10) 1.5);
  with Face Target the actor turns to its target while it stands (`src/shell/actor-scenes.ts`),
  its package's own facing coming back after.
- **Packages:** while a package action runs, its actor's package stack is that action's
  packages alone (`ActorAi`'s stack asks the scene first); one whose package completes is done,
  and its actor stands where it got to until the action ends: MQ101Scene1's Imperial soldier
  waits at the cart's greeting marker while his action spans six more phases. As the action
  ends, the actor's own packages come back. An actor with Run Only Scene Packages (CommonLibSSE;
  no vanilla actor) runs only scene packages for the whole scene. IsScenePackageRunning,
  GetIsCurrentPackage and GetCurrentPackage answer from it (the scene's package where the
  actor's AI does not run). TODO(M13): the engine's stack during a scene; an actor that is not
  loaded does not run its scene package (the low process: TODO(M13)).
- **Timers** are done after their seconds of the scene's clock (real seconds outside menus, not
  while the scene is paused).
- **Fragments:** the scene's begin and end, each phase's start and completion (a phase
  fragment with neither bit runs never). The scene waits for a fragment up to half a second, so
  a stage it sets is seen by the next phase's conditions while one that waits (Utility.Wait)
  does not hold the scene. TODO(M13): the engine queues them to the Papyrus VM.
- **Behaviour flags** (DNAM): an actor's death, its combat, its conversation with the player
  and a fight it watches end the scene or pause it while they last (its clock, phases and next
  lines wait). A dead actor whose death does not end it is done with. With No Player Activation
  the player cannot talk to the actor while the scene plays: the game says
  sSceneBlockingActorActivation, "This person is busy.". In combat and watching a fight are the
  combat AI's and detection's spectating ([Combat AI](#combat-ai)).
- **Ending:** Scene.Stop, its quest stopping, its last phase completing, an actor's behaviour.
  Its actions end (looks and packages let go), its actors leave it, its end fragment runs; then
  its quest stops if the scene stops it on its end (851 scenes: MS13LucanCamillaScene ends with
  Lucan's "Oh, a customer"), or, having played to its end, it starts again while its conditions
  hold (Repeat Conditions While True: Heimskr's sermon). TODO(M13): a pause before the repeat
  (fRandomSceneAgainMinTime / MaxTime may be it).

Measured with `--play`: Lucan and Camilla argue in the Riverwood Trader (MS13LucanCamillaSceneView)
in four lines, Lucan turns to the player for "Oh, a customer. Sorry you had to hear that." if
they see the player, Camilla goes back to work and the quest stops after 39 seconds of text;
MQ101Scene1 says the cart ride's lines in the game's order, from Ralof's "Hey, you. You're
finally awake." to "And it looks like the Thalmor are with him." After a new game in Node
(`node tools/papyrus-run.ts --new-game`) 8 scenes play: MQ101Scene1 waiting for the player's
3D, and scenes that begin with their quests, whose first phase waits for the player to come near
(MorthalInitialScene, RJBanditScene; in Node, without the player's place, GetDistance is not
valued and holds: TODO(M10) 4.2) or for a script (IvarsteadSSScene).

## Talking

What actors say outside the dialogue menu (`src/ai/talk.ts` for who talks when,
`src/shell/actor-talk.ts` on the stage, `src/shell/world-lines.ts` for how a line is said; the
lines: the dialogue engine's `subtypeLine` and `topicLineTo`). What the engine keeps for it is
CommonLibSSE's HighProcessData (greetingTimer, exclusiveTimer, idleTimer, checkToTalkTimer,
lastSpokenToArray); how it combines them is not documented, so the rules below follow the game
settings' names (TODO(M13) where they are ours). The running package's PKDT interrupt flags
say what an actor may do: hellos to the player (0x1, 4,604 of 7,633 vanilla packages), random
conversations (0x2), idle chatter (0x80), reactions to the player's actions (0x10), world
interactions (0x200, GetAllowWorldInteractions: the WI comment quests); an actor without a
package may do all.

- **A line** of a topic subtype (Hello, Idle, a bark) is the first valid info of the subtype's
  topics of the running quests, by quest priority, then topic priority; its quest's dialogue
  conditions and its own run on the speaker with the one spoken to as their target (the
  player, or another actor), Random runs and Say Once as in the menu, a topic that does all
  before repeating (DIAL 0x1) not repeating one before the others. An info another actor says
  (ANAM), or whose conditions name another actor, voice type or alias's reference (GetIsID,
  GetIsVoiceType, GetIsAliasRef run on the subject), is passed over without valuing the rest
  (`src/scripting/runtime/speaker-filter.ts`): of the 6,542 Hello infos 4,719 name their
  speaker and 699 more their voice types. A line is found in a few milliseconds.
- **How it is said** (`WorldLines.speak`, `sayResponse`; the scenes' lines too): each
  response in the speaker's voice, lips moving (creatures: below), its emotion on the face
  (TRDT emotion type and value; neutral leaves the mood), its gestures (the response's speaker
  idle, else ActionTalking's idle tree, which picks by GetDialogueEmotion: DialogueAngry,
  DialogueHappy, hand gestures; a dog barks) and the listener's idle (LNAM); a voice file is
  followed by fGameplayVoiceFilePadding (0.5 s). The HUD's subtitle shows with General
  Subtitles, or when the info (Force Subtitle) or the package's Say forces it, while the player
  is within the voice's reach (the 3D dialogue output model, DOBJ DOP2 SOMDialogue3DDefault:
  3000 units). One line at a time: a new one ends the one it says; talking with the player ends
  it. IsTalking, IsGreetingPlayer, GetDialogueEmotion and GetDialogueEmotionValue answer from it.
- **Greetings:** as the player comes within 150 units of an actor that detects them
  (TODO(M13): no game setting of the load order gives the distance), whose package allows
  hellos, it says its Hello line to them, the nearest first; one greets at a time
  (fAIExclusiveGreetingTimer, 2.5 s), and it greets again only after the player left (1.25 times
  the distance) and fAIGreetingTimer (5 s) passed. Unless the info lets it move while greeting
  (INFO 0x400) it stops and faces them meanwhile. Not while the player talks with someone.
- **Idle chatter:** every fIdleChatterCommentTimer to fIdleChatterCommentTimerMax (10–20 s) an
  actor whose package allows chatter, within 1,024 units of the player and detecting them,
  says its Idle line to them; one line of chatter at a time (TODO(M13)). The Idle infos weigh
  chance and the player's sneaking themselves (GetRandomPercent, IsSneaking).
- **Conversations between actors:** every fAISocialTimerForConversationsMin to Max (10–30 s)
  an actor that may (its package's random conversations flag; sandboxing, its Allow
  Conversation; not on its way) starts one by fAISocialchanceForConversation (10 %, inside the
  Interior value) with the nearest within fAISocialRadiusToTriggerConversation (500) who may
  too and with whom it has not talked within 120 s (TODO(M13)). Their packages wait; the one
  that starts walks up to within iAISocialDistanceToTriggerEvent (200; one seated stays and
  the other comes), they face each other and take turns: a Hello each, then Idle lines, four
  lines at most, ending when the one whose turn it is has nothing to say (TODO(M13): the
  engine's topics for random conversations are not documented). It breaks off when the player
  talks to one of them, a scene takes one, or one leaves or dies. DialogueActivate between
  actors starts one the same way. `node tools/talk-info.ts HuldaREF SaadiaREF` plays one after
  a new game in Node.
- **Barks:** `ActorTalk.bark(actor, subtype, target?)` says a topic subtype's line (by code or
  name: ObserveCombat, NoticeCorpse, NormalToAlert, Steal, Trespass, PickpocketTopic, TimeToGo,
  ...) to a target (the player without one); the reactions of [Detection](#detection) call
  it, combat and crime do. A package's begin, change and end topics and its Say say theirs.
  The player walking into an actor gets its ActorCollidewithActor line (its infos weigh
  IsSmallBump and a 25 % chance) if its package allows reactions to the player's actions.
- **The player's actions:** `ActorTalk.playerAction(subtype)`: the nearest actor within 1,024
  units that detects them and whose package allows reactions comments, each at most every
  fCommentOnPlayerActionsTimer (20 s; knocking things over fCommentOnPlayerKnockingThings,
  40 s). Jumping (Jump), grabbing an object (ZKeyObject), picking a lock (LockedObject),
  casting (PlayerCastProjectileSpell, PlayerCastSelfSpell) and shouting (PlayerShout: "Magic in
  combat") are told; swinging a weapon, shooting and aiming are combat's (SwingMeleeWeapon,
  ShootBow, PlayerinIronSights: TODO(M10) 5.1), knocking things over and standing on furniture
  TODO(M13) (the physics does not tell who knocked an object).
- **Creatures' lines** (dragons, hagravens, rieklings: 8 lip curves) move the creature's mouth
  through its behavior graph's own lip variables (LipBigAah, LipDST, LipEee, LipFV, LipK, LipL,
  LipR, LipTh; rieklings LipAA ... LipTH), which blend its phoneme poses; the curves are taken
  in the variables' order (TODO(M13)).
- **The dialogue camera** (`src/shell/dialogue-camera.ts`): as the player talks with an actor
  their view turns to its head and zooms in 10 degrees, back as it ends; no game setting
  describes it (TODO(M13)).
- `node tools/talk-info.ts HuldaREF`: after a new game in Node, an actor's line of each subtype
  to the player and the time it took to find; `--survey`: the subtypes' infos and what names
  their speakers.

## Combat

What actors and the player do in a fight (`src/gameplay/combat/`, `src/shell/actor-combat.ts`;
the plan: [m10-plan.md](m10-plan.md) 5.1; the records: `node tools/weapon-info.ts <filter>`).
Who fights whom, and how, is the combat AI's ([Combat AI](#combat-ai)); its packages wait
meanwhile.

- **Actions** go through the idle tree as the engine's do: ActionDraw, ActionSheath,
  ActionRightAttack, ActionLeftAttack, ActionRightPowerAttack, ActionLeftPowerAttack,
  ActionDualAttack, ActionDualPowerAttack, ActionRightRelease, ActionLeftRelease,
  ActionStaggerStart, ActionRecoil(Large), ActionBlockHit, ActionBleedoutStart / Stop: the first
  idle under the action whose conditions hold (run on the actor, its combat target the
  conditions' Target) sends its event to the actor's graphs (the player's first-person graph
  too). A sheathed weapon is drawn by the attack's own tree (DrawWeapon: WeapEquip). The engine
  sets the graphs' iRightHandType / iLeftHandType (GetEquippedItemType's codes),
  iRightHandEquipped, iLeftHandEquipped, weaponSpeedMult and leftWeaponSpeedMult from the equip
  system, and IsAttacking, IsBlocking, IsBashing, iWantBlock, IsEquipping and IsUnequipping as
  the actor acts; the graphs set IsStaggering and IsRecoiling themselves.
- **States** (`combat-state.ts`, CommonLibSSE ActorState): WEAPON_STATE (sheathed, drawing,
  drawn, sheathing), ATTACK_STATE_ENUM (draw; swing at preHitFrame; hit at HitFrame; next
  attack at AttackWinStart; follow-through at AttackWinEnd; bash; for bows draw, attached at
  arrowAttach, drawn at bowDrawn, releasing, released at arrowRelease), staggered, recoiling,
  bleeding out, the knock state and paired animations, moved by the graphs' annotations
  (`tools/behavior-run.ts`: 1HM_Equip raises weaponDraw at 0.6 s and WeapEquip_Out at its end;
  attackStart preHitFrame, weaponSwing, HitFrame, AttackWinStart, attackStop; a bow
  arrowAttach, bowDrawn and, on attackRelease, arrowRelease). The conditions IsWeaponOut,
  IsWeaponMagicOut, IsShieldOut, GetAttackState, IsAttacking, IsPowerAttacking, IsBlocking,
  GetWantBlocking, IsStaggered, IsRecoiling, IsBleedingOut, GetKnockStateEnum, GetKnockedState,
  GetPairedAnimation, GetMovementDirection, GetLastHitCritical, ShouldAttackKill,
  GetTargetHeight, IsLastHostileActor, IsInCombat, GetCombatState, IsPC1stPerson and the
  conditions run on the combat target read it, as do the natives IsWeaponDrawn, DrawWeapon,
  SheatheWeapon, IsBleedingOut, IsInKillMove, IsInCombat, GetCombatState and GetCombatTarget.
- **Weapons on the body** (`src/shell/actor-weapons.ts`): the right hand's weapon model hangs on
  its sheath node (the equip system's: the models' "Prn", WeaponSword, WeaponDagger,
  WeaponAxe, WeaponMace, WeaponBack, WeaponBow) and goes to WEAPON at weaponDraw, back at
  weaponSheathe; its scabbard ("Scb") stays at the sheath; a left-hand weapon is shown drawn
  only, in SHIELD (vanilla's skeleton has no left sheaths); the ammunition hangs in QUIVER (its
  single "Arrow:0" left out) and an arrow is on the bow from arrowAttach to its release. The bow
  animations move the Weapon bone into the left hand (Bow_DrawLight: 19 units beyond it). The
  weapon's sounds: NAM9 at weaponDraw, NAM8 at weaponSheathe, TNAM at weaponSwing (every vanilla
  melee weapon's swing, WPNSwingBladeMediumSD; xEdit names it the attack fail sound), SNAM at
  a shot.
- **Hits** (`hit-test.ts`): at HitFrame the strike reaches fCombatDistance (141) × the weapon's
  reach (fists: the race's unarmed reach, RACE DATA @100; a bash fCombatBashReach) × the
  attacker's size, from its feet to the target's shape, inside the attack data's strike angle
  (ATKD: 50° for attackStart, 35° for power attacks, 85° about ±90° for mounted side swings); it
  hits the nearest such actor (every one with Sweep), each once an attack. With nothing to hit
  but a wall in reach (a ray at the chest on L_WEAPON) the attacker recoils. TODO(M13): the
  engine measures from bounds; its cone's exact shape is not documented.
- **Damage** (`damage.ts`; UESP "Damage", "Block", "Sneak", "Difficulty"): the equip system's
  weapon damage (skill, perks, tempering) × the attack data's damage mult (power attacks 2,
  bashes 0.5; a bash on the weapon's base damage or the shield's base rating × fWeaponBash{PC}
  Min..Max or fShieldBash{PC}Min..Max by Block); a sneak attack × the kind's fCombatSneak*Mult
  (one-handed 3, two-handed and fists 2, bows 2) × fDamageSneakAttackMult; × (1 − the target's
  armour reduction: the equip system's 0.12% a point and 3% a piece, at most fMaxArmorRating);
  critical damage (CRDT; the perks' chance) passes the armour; × (1 − the share blocked);
  × fDiffMultHPByPC<level> for the player's hits, fDiffMultHPToPC<level> for hits on the player
  (Novice 2 / 0.5 .. Legendary 0.25 / 3; [GamePlay] iDifficulty). The perk entry points
  (critical chance, sneak, block, stagger, Sweep, incoming damage) are hooks the perk system
  replaces (`combat-hooks.ts`, TODO(M11)).
- **Blocking**: held, the block covers fCombatHitConeAngle (35°) either side of the blocker's
  facing: a shield blocks fShieldBaseFactor + fShieldScalingFactor × its base rating × (1 + 1.5
  × Block / 100) %, a weapon fBlockWeaponBase + fBlockWeaponScaling × the attacker's weapon
  damage × (1 + 1.5 × Block / 100) %, × fBlockPowerAttackMult against a power attack, at most
  85% (UESP; the plugins' fBlockMax 0.7: TODO(M13)). The blocker's stamina pays (the skill
  progression's blockCost) and its Block skill is used by the damage blocked (a shield's
  twice). A blocked plain attack recoils its attacker (recoilStart; a heavy shield's
  recoilLargeStart); a blocked power attack staggers the blocker by fStaggerBlockBase + the
  damage blocked × fStaggerBlockMult.
- **Staggers** (`stagger.ts`): the weapon's stagger (DNAM: swords 0.75 .. warhammers 1.25;
  bashes and fists 1) × the attack's (ATKD: plain attacks 0, power attacks 1, bashes 0.5),
  weighed against the target's mass (RACE DATA: humans 1, trolls 3.5, giants 4) as
  fStaggerMassOffsetBase / (fStaggerMassOffsetBase + mass − 1), the player's mass ×
  fStaggerPlayerMassMult; the graph gets staggerMagnitude (its blend plays the smallest to the
  largest stagger) and staggerDirection (where the blow came from, clockwise from the facing in
  turns: 0 StaggerBack, 0.5 StaggerForward). TODO(M13): the engine's formula is not documented.
- **Power attacks**: the player's attack button held [Controls] fInitialPowerAttackDelay (0.3 s)
  is a power attack (both buttons: the dual ones); without stamina it is a plain one (the HUD's
  meter blinks). Power attacks and bashes cost the skill progression's powerAttackCost and
  bashCost.
- **Bows** (`projectile.ts`, `src/shell/combat-projectiles.ts`): the bow draws while the button is
  held and looses at arrowRelease; the shot's damage is the equip system's (bow and arrow) × the
  draw (UESP "Archery": 35% before the draw, then linear from 50% to full). The arrow flies at
  its PROJ's speed (iron arrows 3600) × the draw, tilted up by f1PArrowTiltUpAngle (2°) or
  f3PArrowTiltUpAngle (2.5°), under 9.8 m/s² × its gravity (0.35), against what L_PROJECTILE
  meets (actors' bodies; the player's shape), until its range. An actor hit takes the shot;
  hitting the world the arrow sticks fCombatMissileStickDepth deep, a reference of its
  ammunition to pick up (kept still), at most 15 of them. NPCs aim at their target's chest,
  straying fBowNPCSpreadAngle (4°). TODO(M13): how much slower a partly drawn arrow flies.
- **Impacts** (`src/shell/combat-impacts.ts`): the weapon's impact data set (INAM; bashes and
  blocks BIDS; fists the race's NAM5; arrows the bow's) against the target's flesh (its race's
  NAM4: MaterialSkin, MaterialBoneActor, ...) gives the impact: its sound (heavy for power
  attacks) and its decal (DODT and the texture set DNAM: blood) on the floor or wall behind.
  TODO(M13): its effect model (the spray's particles).
- **Health**: a hit takes health (DamageActorValue with its attacker), tells the target's
  scripts (OnHit: aggressor, weapon, projectile, power, sneak, bash, blocked), uses the
  attacker's weapon skill by the weapon's base damage (Sneak by fSneakAttackSkillUsageMelee for
  a sneak attack), and shows the target on the HUD's enemy bar (its name and health) for the
  player's hits. Health run out kills (the ragdoll pushed by fDeathForce{Ranged}Min..Max by the
  damage); an essential actor, and a protected one unless the player dealt the blow, bleeds out
  instead (`bleedout.ts`: bleedOutStart, its enemies leave it, it regains fBleedoutRecover of its
  health a second and gets up (bleedOutStop) at fBleedoutDefault after fBleedoutMin seconds;
  SetNoBleedoutRecovery keeps it down). Actor.Kill (KillSilent, the console's kill) bleeds an
  essential actor out too: the game's KillEssential is a script that clears a unique base's
  Essential flag before it calls Kill (Actor.pex).
- **The player's death** (`player-death.ts`, `src/shell/player-death.ts`; UESP "Skyrim:Death"):
  health run out or Actor.Kill kills the player as any actor (the runtime's dead, OnDying then
  OnDeath to the player, their aliases and the magic effects on them), unless they are
  essential (an alias's flag: they bleed out, as above) or in god mode (the console's tgm,
  Debug.SetGodMode: no damage to health, magicka or stamina, no death; TODO(M13): whether god
  mode also stops Kill, its carry weight and ammunition). The stage then shows it: off a horse
  or a cart and out of furniture at once (no exit played), their casts and fight over (what
  they held goes as the dead's does; a killmove's camera gives way); the avatar stops walking
  and animating and its body gets its ragdoll as an NPC's does (ActorBodies, from the pose it
  had, at the avatar's placement; the killing blow pushes it by fDeathForce\*); the
  controller's shape goes (the body lies there), the player's keys do nothing (no movement,
  activation, attacks or casts; of the menus only the journal's system page and the console
  open; a conversation or menu open at the death closes) and the HUD stays as it was (no
  activation prompt; the SKSE mod Enhanced Death Camera adds hiding it, so the game does not).
  Fighters drop the dead player as their target, and the combat AI finds no target in the dead
  (its candidates leave them out) and ends its fights. The camera is the engine's bleedout
  camera (CommonLibSSE BleedoutCameraState, which the engine starts for the dead player; the
  mod's hooks show it): over [Camera] iBleedoutTransitionMillis (500 ms) from where the view
  was to behind the body as it looked, pitched down at the ragdoll's centre of mass (NPC COM,
  else the pelvis or root), pulling back from fVanityModeMinDist (155) to
  fDefaultAutoVanityZoom (300) and slowly going round it, kept out of walls by a sphere of
  fCameraCasterBleedOutSize (5) on L_CAMERA that passes the body itself. TODO(M13): the
  bleedout camera's pitch, turn speed and zoom are not documented (its state keeps a zoom, a
  pitch, a yaw and a random heading). fPlayerDeathReloadTime (5 s) of game time after the death
  (a menu holds it) the game loads its most recent save; TODO(M12): savegames: until then it
  ends as the system page's Quit to main menu does. The sandbox, with no saves, leaves the
  body lying. TODO(M13): Resurrect on the player; GMST sMiscPlayerDead\* (a message box the
  data still has: "Reloading the most recent save game", Reload / Main Menu) is not known to
  show.
- **Killmoves**: an attack whose idle is a paired one (the tree's killmove branches: their
  conditions ShouldAttackKill, GetGlobalValue(KillMove), the target's race, the weapon, random
  chances) plays "pa_<name>" on the attacker and "<name>" on the target, each its part of the
  paired clip (its tracks named by bone, the target's prefixed "2_": src/animation/paired-clips.ts, the victim's side set by combat as both share a skeleton); the
  target stands 72.8 units before the attacker facing it (Paired_1HMKillMoveB's start;
  TODO(M13): each clip's own offset) and dies at its clip's KillActor. Seen by the player in
  third person, the kill cameras' tree shows it (`src/shell/killmove-camera.ts`: from
  PairedKillTest the first path whose conditions hold, with the kill as their context: the VATS
  sides by rays beside the target or the attacker (the condition's run-on), GetVATSValue's weapon,
  action and distance (docs/scripting.md, "Conditions"); its shots' ExportCam in the attacker's
  frame looking at the target). TODO(M13): the shots' time multipliers (slow motion) and
  image-space modifiers; the ranged and magic kill cameras (the tree's MagicOrBowCams: a bow's
  or a spell's killing blow followed; their conditions are valued).
- **Combat music**: while anyone fights the player the default battle music (DOBJ BTMS) plays,
  ending with its finale as the fight does.

## Magic in combat

Casting in the world, the player's and the NPCs' alike (m10-plan 5.3). The casting engine keeps
the casts, their costs and the voice (docs/gameplay.md, "Casting and shouts"); the stage shows
them: `src/shell/actor-casting.ts` (`ActorStage.casting`) animates casts and sends them on their
way, `src/shell/player-casting.ts` reads the player's buttons, `src/shell/magic-projectiles.ts`
(`ActorStage.projectiles`) flies what they send. `node tools/casting-info.ts <spell|shout>` prints
the projectile and explosion a spell sends.

- **The graph:** a cast begun plays its start as the idle tree's ActionRightAttack /
  ActionLeftAttack leaves pick it by the hand's GetCurrentCastingType, GetCurrentDeliveryType
  and SpellHasKeyword (MRh_SpellAimedStart, MRh_SpellSelfStart, MRh_SpellAimedConcentrationStart,
  MRh_SpellSelfConcentrationStart, MRh_WardStart, MRh_SpellTelekinesisStart; MLh_ for the
  left; a dual cast both); a staff's or a scroll's, or where the tree plays none, the event it
  would pick is sent. Magic is drawn as weapons are ("Combat": ActionDraw plays Magic_Equip,
  whose clip raises weaponDraw and Magic_Equip_Out; put away Magic_Unequip_Out), and with it
  drawn the player's attack buttons whose hands hold a spell, staff or scroll cast
  (`PlayerCombat` hands them to `PlayerCasting`: CastingButtons); IsWeaponMagicOut is any drawn
  state, IsWeaponOut not when the hands hold only magic. An NPC's castAt draws first. While an
  aimed cast lasts its arms aim (the graphs' BSDirectAtModifiers of bows and spells:
  `setDirectAtTarget(2, point)` along the aim). Ready:
  ActionRightReady (MRh_SpellReady_Event); fired or stopped: ActionRightRelease
  (MRh_SpellRelease_Event); let go early: ActionRightInterrupt (MRh_Equipped_Event). Shouts:
  ActionVoice (shoutStart), ActionVoiceRelease as the words go (the Whirlwind Sprint variants by
  GetCurrentShoutVariation), ActionVoiceInterrupt. A ward hit: ActionWardHit (wardAbsorb,
  WardBreak by IsWardState). TODO(M13): the dual-cast animations.
- **Sounds and art:** the costliest effect's sounds (MGEF SNDD) from the hand's magic node (NPC R
  / L MagicNode): charge as it charges, ready once it is, the concentration loop while a
  concentration spell is held, release as it fires (a shout's thu'um); its casting art (MGEF
  casting art, ARTO) drawn on the magic node while the cast lasts. TODO(M11) visuals: the
  dual-cast art and its scale, the hit art and shaders on the target.
- **Projectiles** (the costliest effect's PROJ; docs/formats/esm.md, "Projectiles and
  explosions"): from the source's node (the voice: the head) along the aim — the player's
  camera, an NPC's target's chest, else its facing. Missiles, lobbers and arrow-like bolts fly
  through the frames at their speed, falling by gravity × the world's (9.8 m/s²), drawn as their
  model with their flight sound, until their path (as thick as their collision radius) meets a
  surface (a ray of the spell layer: the caster's own bodies passed through), an actor (its
  ragdoll bodies' owner, or an upright capsule of its controller's height, 24 units wide: the
  player too), their range or lifetime, or with an alternative trigger an actor within their
  proximity or their timer. Beams (and hitscan) reach their range at once; flames are a
  concentration spell's sprays, one every relaunch interval (each carrying that share of the
  spell); cones (Unrelenting Force) sweep every actor within their range and spread that their
  apex can see. Self and Touch spells, and those without a projectile, reach their target at
  once; a held Self spell acts every 0.25 s.
- **Impacts:** the actor hit takes the spell (`deliver`: absorption, the ward if it faces the
  projectile, OnHit, the school's use); a hostile one that took hold makes it search for its
  attacker (detection's `attackedBy`; TODO(M10) 5.2: combat begins). A Target Location spell
  makes its summons and hazards where it landed. The explosion bursts (its sounds, `explode`:
  its enchantment, damage and force within its radius), the area reaches those near (`area`),
  the effect's impact data set sounds on the surface hit; both are noises for detection by their
  sound levels. TODO(M11) visuals: projectile lights and muzzle flashes, explosion and impact
  models and decals, beams and cones drawn.
- **Noise and comments:** a cast or a shout is an action noise as loud as its effect's casting
  sound level (detection's `action`); the player's are commented on (PlayerCastProjectileSpell,
  PlayerCastSelfSpell, PlayerShout).
- **The AI's API** (5.2's combat AI calls it): `castAt(actor, hand, target, {spell, purpose})`
  casts from a hand ('both': dual cast) the given spell (equipped first), what the hand holds,
  or the spell the casting engine chooses for the purpose (`chooseSpell`: attack, heal, summon,
  ward, buff: of its spells and what its hands hold, the costliest it has the magicka for;
  TODO(M10) 5.2: the combat style's magic score); `healSelf(actor)`, `summon(actor, target?)`,
  `drinkPotion(actor, value)` (the carried potion restoring the value most);
  `shoutAt(actor, target, words?)` (Greybeards, draugr; dragons' breath: [Flying
  combat](#flying-combat)): the voice's shout, its
  words let out after their hold time. NPCs release a fire and forget spell once ready and hold
  a concentration spell 2.5 s. An actor that dies or leaves the stage stops casting.
- **Scripts' casts** (Spell.Cast, RemoteCast: WorldBridge.launchSpell) fly the same way from the
  source's right hand or its place; without a play they are delivered at once.

## Combat AI

Who fights whom, and how (`src/ai/combat-ai.ts`, `combat-tactics.ts`, `combat-groups.ts`,
`combat-search.ts`, `combat-reactions.ts`, `combat-profile.ts`; on the stage
`src/shell/actor-combat-ai.ts`, which drives the mechanics of [Combat](#combat); the plan:
[m10-plan.md](m10-plan.md) 5.2; check: `node tools/combat-ai-info.ts <actors>`). The AI values
mean what the Creation Kit says of them (UESP "Skyrim:AI Data"); the load order's game settings
count where it has them (fConfidence\*, fCombatConfidenceModifier\*, fFleeDistance\*,
iFriendHitCombatAllowed, fCombatAdvance\*Radius\*, fCombatBlockChanceWeaponMult,
fCombatDialogue\*); the engine's own (fCombatSelectTargetUpdateTime, fCombatYieldTime,
fCombatInventoryUpdateTimer, ...) are in no plugin, and their values here are ours
(TODO(M13)). CommonLibSSE names the engine's combat behaviour trees but not their arithmetic:
the rules below read each value as its name says (TODO(M13)).

- **Reactions** (`combatReaction`; it stands in for crime's `reaction(actor, other)` until M11
  merges): summons, reanimated and commanded actors are their commander's allies and share its
  reactions; the player's teammates are the player's allies; one scripts set to be attacked on
  sight (SetAttackActorOnSight) is everyone's enemy; a relationship decides next (ally and lover
  ally, friend and confidant friend, foe and worse enemy); else the factions' combat reactions
  (FACT XNAM, scripts' SetAlly / SetEnemy) between the factions each is a member of, the closest
  bond winning (ally, friend, enemy, neutral), the other's view where the actor's names none; a
  crime faction set as the player's enemy is an enemy faction to the player. Vanilla factions
  list themselves (BanditFaction is BanditFaction's ally): faction-mates are not allies by
  themselves. TODO(M11): bounties and guards' hostility to criminals are crime's.
- **Entering combat**, every 0.25 s for each actor of the high process, among those it detects
  (or its group sees): by its aggression (unaggressive never, aggressive its enemies, very
  aggressive enemies and the neutral, frenzied anyone) it attacks on sight; its aggro radius
  (AIDT, where its package has the aggro radius interrupt) first leaves alone those beyond the
  warn radius, warns within it (ActionIdleWarn: the bear's roar, facing them) and attacks within
  the attack radius, or within the warn-or-attack radius once it has warned 2 s (TODO(M13)). The
  radius also has one that would not attack on sight warn and attack the neutral that come close
  (inferred: vanilla's wolves and bears are unaggressive with an aggro radius). It
  helps by its assistance (helps allies; helps friends and allies) one that fights or is
  attacked, against the other; guards (CLAS DATA guard flag) help anyone attacked who did not
  strike first and would not attack on sight (TODO(M11): crime); the player's teammates help
  the player at least as friends and allies, and fight within fCombatTeammateFollowRadiusMult ×
  512 of them. A blow turns its victim on the attacker: an enemy or a neutral at once, a friend
  or ally after iFriendHitCombatAllowed (4) blows in combat (2 out of it,
  iFriendHitNonCombatAllowed: TODO(M13)), each blow let pass a friendly fire comment (its Hit
  line, GetFriendHit) where its package has the friendly fire interrupt; attacked by one it does
  not detect, it searches. A package with Ignore Combat (PKDT) keeps it out of fights it would
  pick; calm keeps it out of all; StartCombat sets it on a target whatever its reaction,
  StopCombat and StopCombatAlarm end it. Entering, it says NormalToCombat (AlertToCombat when
  alerted), gets off its horse (TODO(M13): mounted combat), its detection reaction or override
  package ends, and its package's way stops.
- **Targets** (`selectTarget`): the most threatening (health × its blow's damage), nearest
  first (half as much at 1024 units), its current target counting 1.5 times (it does not switch
  for a little), one attacking it 1.5 times, one it lost a quarter. The odds (its enemies'
  strength against its group's) move its confidence between fCombatConfidenceModifierMin and
  Max every fCombatThreatRatioUpdateTime.
- **Combat groups**: an actor entering combat joins the group of an ally or friend fighting;
  the group shares where its members saw their targets (one sees, all know), counts for the
  style's group offensive mult and GetCombatGroupMemberCount; one dying, another says
  AllyKilled.
- **What it fights with** (`chooseEquipment`, every fCombatInventoryUpdateTimer): the weapons
  it carries (a bow or crossbow only with ammunition) and its fists, each scored by its damage ×
  its combat style's equipment score mult (CSGD melee, ranged, magic, staff, unarmed, shout) ×
  its fit to the distance (melee within its reach, less beyond it to
  fCombatAbsoluteMaxRangeMult × the reach; ranged within its range, the one in hand
  fCombatCurrentWeaponAbsoluteMaxRangeMult farther, falling to a tenth closer than
  fCombatAdvanceOuterRadiusMax) × 1.25 for what is in hand. Another weapon is taken up through
  the equip system (sheathed first, then drawn again; arrows or bolts for a bow or crossbow).
  Its combat style: its combat override package's (PACK CNAM), else its NPC\_ ZNAM (of the
  template that gives its AI data), else DefaultCombatstyle (0x3D). With csHumanMissile
  (ranged 3.2) an archer shoots down to about 250 units and draws its sword closer; a melee
  style keeps its sword at 400. TODO(M10) 5.3: spells, staffs and shouts (`CombatCasting`:
  their options and `castAt`, wired by magic in combat).
- **Movement** (`chooseManeuver`, a maneuver for 1–3 s): more than 512 units beyond its reach
  it chases its target over the navmeshes, running; near, dueling styles fall back (fallback
  mult × 0.5, × (1 + defensive mult) as the target swings), circle (circle mult × 0.5) or
  advance, flanking styles come at it from the side (flank distance; from afar too with allies
  on the target) or stalk round it just out of reach (stalk time); at range it keeps beyond
  fCombatAdvanceOuterRadiusMax (fallback mult), strafes (CSLR strafe mult) or holds, and closes
  beyond its range. Its combat override package list (NPC\_ / alias ECOR: the first package
  whose conditions hold) keeps it within that package's place: back there first, no chase of a
  target beyond it.
- **Attacks** (`chooseAttack`, every (0.4–1.2 s) × (1.5 − offensive)): within reach and facing
  its target within 30°, it attacks by its offensive mult (× group offensive mult with allies on
  the target, × attack staggered mult on a staggered target), a power attack by its attack
  data's chance (ATKD; × power attack staggered mult on a staggered, power attack blocking mult
  on a blocking target), chaining in the attack's window; blocking, it bashes by bash mult ×
  0.25 (× bash attack, bash power attack, bash recoil mult as the target swings, power attacks
  or recoils). A bow is drawn and loosed after 0.3–1.2 s held (TODO(M13): its line of fire).
- **Blocks**: a melee swing coming at it within the swinger's reach it blocks once by its
  defensive mult (× fCombatBlockChanceWeaponMult without a shield), where its left hand blocks
  (a shield, a two-handed weapon, a one-handed weapon with the left hand free); it lets go as
  the swing ends or after 1.2 s.
- **Threats**: an arrow, a spell's projectile (its collision radius) or a breath (a shout
  drawn in or sprayed at a target, from the head: 96 units wide at the breath's 1000 units a
  second; TODO(M13)) whose line passes through it within 1.2 s it sidesteps by its style's
  avoid threat chance, out of the line to the side it stands on, saying AvoidThreat.
- **Fleeing** (`shouldFlee`): below its confidence's share of health (cowardly at once,
  cautious fConfidenceCautious 37.5%, average fConfidenceAverage 15%, brave fConfidenceBrave
  3.75%, foolhardy never) × (1 − the odds' modifier), or with Fear or Turn Undead on it; Rally
  and frenzy keep it in the fight. It says Flee, runs fFleeDistanceExterior (5000) / Interior
  (3000) away from its enemy over the navmeshes, cowers where it can go no farther (ActionIdle:
  the idles IsFleeing picks), fights again cornered (within 192 units, for 10 s), and its combat
  ends once it is that far and detects no enemy. IsFleeing: fleeing in combat, a Flee procedure
  that counts as fleeing, or fear.
- **Searching** (`CombatSearch`): a target no member of its group detects any more is searched
  for (CombatToLost; GetCombatState 2): it runs to where it was last known (within
  fCombatSearchLocationInvestigateDistance), looks round three times
  (fCombatSearchInvestigateTime), walks to points within 768 units round the place, saying its
  LostIdle lines (fCombatDetectionDialogueIdle\*); finding it again (LostToCombat) it fights on;
  after fDetectionStateExpireTime it gives up (LostToNormal; detection's alert ends).
- **Yielding**: an actor fighting the player that does not attack them on sight (the fight is
  a quarrel or a brawl) and would flee yields instead: Yield, weapon away, out of the fight for
  fCombatYieldTime (10 s), not again within fCombatYieldRetryTime (60 s); struck again it
  fights on. The player yields a quarrel their blows started by sheathing and holding off 3 s:
  AcceptYield, and it lets them be. TODO(M13): the engine's rule.
- **The end of combat**: no enemy known (CombatToNormal; dead, bleeding out, gone or left
  behind), StopCombat, calm or a search given up: it leaves its group, stands, sheathes 3 s
  later (unless its package keeps its weapon drawn) and chooses its package again. Its own lines
  in the fight: Taunt every fCombatDialogueTaunt\* (10–30 s); 5.1's Attack, Hit, Block, Death.
- **Spectators**: those detection has watching a fight (their package's observe combat
  interrupt, [Detection](#detection)) say ObserveCombat; a cowardly one runs from the fight
  instead (Flee, IsFleeing) for 10 s. Scenes pause or end on an actor's combat and watching
  (SCEN DNAM).
- **Horses and followers**: a ridden horse is its rider's to move; others fight or flee by their
  own AI values (horses: cowardly). Teammates fight the player's fights (above).
- **Scripts**: IsInCombat (the player: while anyone fights them), GetCombatState (0, 1, 2
  searching), IsFleeing, GetShouldAttack, IsHostileToActor, GetFactionRelation (the reaction;
  without a parameter, to the player: TODO(M13)), IsCombatTarget (the subject is its
  parameter's target: TODO(M13)), GetCombatTargetHasKeyword, GetFriendHit,
  GetCombatGroupMemberCount, IsGuard; the natives StartCombat, StopCombat, StopCombatAlarm,
  IsInCombat, GetCombatState, GetCombatTarget, IsHostileToActor, IsGuard,
  SetAttackActorOnSight. Detection asks it who is in combat (Sneak not counting), who fights
  whom (detected down to iAICombatMinDetection) and who is hostile to whom (searching for one
  noticed or lost before combat).
- `node tools/combat-ai-info.ts dunFaldarsToothBetBandit01 HuldaREF C06WolfSpiritREF`: each
  actor's AI values, combat style, what it carries and fights with at 100, 400 and 1500 units,
  and the reactions between them and to the player (`--new-game`: after a new game).

## Flying combat

Actors of a race that flies (RACE DATA Flies: DragonRace, AlduinRace, UndeadDragonRace,
DragonBlackRace and the DLCs': `src/ai/flight.ts`; on the stage `src/shell/actor-flight.ts`;
the plan: [m10-plan.md](m10-plan.md) 5.4; check: `node tools/flight-info.ts`). No other vanilla
race flies: the dragon priests and the chaurus hunters hover in their animations and move as
walkers.

- **The graph drives it**, as the engine's flight does: the idle tree's ActionFlyStart (off the
  ground TakeOff, off a perch, its idles test GetFlyingState 5), ActionFlyStop (FlyStopDefault,
  FlyStopInjured when hurt, FlyStopHasty and FlyStopCrash as the landing is asked for,
  FlyStopPerch\* by the perch: GetIsID of the action's target), ActionHoverStart and
  ActionHoverStop; a flight grab sends to_Flight_Kill_Grab_Enter and, as the enter clip ends
  (FlightActionEntryEnd), to_Flight_Kill_Grab_Action or \_Action_Failed. The graph tells the
  flying state as its states begin (FlightTakeOff, FlightCruising, FlightHovering,
  FlightLanding, FlightPerching, FlightAction; LandEnd on the ground: CommonLibSSE FLY_STATE 0
  none, 1 take-off, 2 cruising, 3 hovering, 4 landing, 5 perching, 6 action). Offline:
  `node tools/behavior-run.ts meshes\actors\dragon\dragonproject.hkx --motion --at 0.2:TakeOff
--vector-at 6:TweenPosition=0,9000,0,0 --at 6:FlyStopDefault --time 12` takes off (FlightTakeOff
  at 0.67 s, FlightCruising at 5.3 s, 4116 ahead and 2068 up) and lands on the spot
  (FlightLanded, LandEnd).
- **What the engine sets**: TargetSpeed (its flying movement type's: Dragon_Flying_MT forward
  2000 walking, 7400 running), TurnDelta and PitchDelta (degrees a second, left and up
  positive: the graph's PathAngle slows it to MinSpeed at 25° a second), MovementDirection (its
  z the climb and dive blend), DistToGoal, HasTweenSpeed and TweenSpeed near a stop (the graph
  slows and feathers), TweenPosition, TweenRotation and TweenEntryDirection (in turns clockwise:
  the approach blends' 0, 0.25, 0.5, 0.75) for the tweeners, Injured below its race's injured
  health (RACE DATA: 35%). The graph flies at its own Speed: its acceleration (MaxAcc while
  flapping), deceleration and drag.
- **Moving**: in the air a flier has no character controller. Cruising (neither bAnimationDriven
  nor bIsSynced) it steers for its goal (`steerFlight`: turning at its movement type's
  rotate-while-moving rate, 90° a second; pitching at most 45°) at the graph's Speed, kept 512
  units (ours) over the ground under it; taking off, landing, hovering and in the grab its
  clips' root motion (the dragon project's animation data: MTTakeOff45 4096
  ahead, 2048 up) and the graph's BSTweenerModifier carry it ([animation.md](animation.md)).
  A landing begins where the approach clip ends on the spot (2048 ahead, 2048 up); a hover
  within 3584 of its point (the feather-stop clips' way). Drawn level, turned to its heading:
  its clips bank and pitch it. Placed in the air (no ground within 512 under it) it starts
  cruising (FlyStartCruise). Landed (LandEnd) the movers give it its controller again; its size
  for blows and projectiles in the air is its controller's on the ground (its skeleton's bound).
- **In combat** (`ActorFlight.fight`, asked by the combat AI for a flier that may fly) its
  combat style's flight section (CSTY CSFL) decides, each time a maneuver ends, in turn: a dive
  bomb (dive bomb chance: low over its target, 384 over it, and on beyond), a hover (hover
  chance: 1280 before its target, 768 above it, for fCombatHoverTimeMin 5.5 ..
  fCombatHoverTimeMax s by its hover time), a perch attack (perch attack chance, with a free
  perch within 6000 of its target: for fCombatPerchAttackTimeMin 4 .. Max s by its perch time),
  a ground attack (ground attack chance, with a landing spot on the navmesh 1024 from the
  target on its side, or its forced landing marker: it fights there for fCombatGroundAttackTimeMin
  8 .. Max 17 s by its ground attack time, as the combat AI's melee fights, with its race's
  bites, tail and wing attacks), else an orbit round its target at fCombatOrbitDistance (4000),
  1536 above it, for about 8 s. Each maneuver rolls its flying attack chance: it breathes at its
  target before it (within 36°) and within its shout's reach (the last word's projectile's
  range: fire and frost breath 2000, fireball and ice storm 10000); hovering and perched it
  breathes whenever its voice has recovered. Hurt below its injured health it lands to fight on
  the ground (FlyStopInjured). TODO(M13): the engine's order and weighing of the style's
  chances, its times' scale, the heights and distances (ours, `tools/flight-info.ts` lists
  them); vanilla's csDragon chooses a dive bomb 36%, a hover 33%, a perch 16%, a landing 13%.
- **Its breath** (`ActorCasting.shoutAt`): a shout it knows (its spell list's SHOU, one at
  random) in its voice, ActionVoice (shoutStart, or shoutStartFireball for a fireball shout:
  the neck states of its flight, hover, perch or ground), its words let out after their hold
  time (ActionVoiceRelease: shoutRelease, the exhale); a concentration shout (the breaths)
  sprays from its head's magic node ("NPC Head MagicNode [Hmag]") every relaunch interval of its
  flame projectile until the graph's shoutStop or 3 s (the exhale clips' length). Those it
  breathes at may sidestep it ([Combat AI](#combat-ai): Threats).
- **Perches**: the furniture the idle tree's ActionFlyStop lands on (GetIsID of its target:
  DragonPerchTower, DragonPerchWordwall, DragonPerchRockL02, DragonTowerHole01, DragonWaterDive)
  whose interaction keyword (ActorTypeDragon) its race has, one flier each. On it (FlightPerching,
  PerchLandEnd) it has no controller and turns to its target; ActionFlyStart takes it off.
  TODO(M13): the perch furniture's marker offset (it lands on the reference's place).
- **The flight grab** (the FlightGrab procedure): it flies at its victim, the talon grab's enter
  clip tweens it there; as the enter ends it takes the victim within reach (else the grab fails:
  Special_TalonGrabFailExitVert), which hangs from its rear talon ("NPC RLegFoot") at the
  graph's ConstraintOffset (hkbTransformVectorModifier: 100, −7, −0.5) without a controller of
  its own, and lets go at FlightActionRelease, dead. TODO(M13): whether the engine kills it or
  the fall does, and the bone it hangs from.
- **Packages**: Hover flies to its place, Height above it, and hovers facing the place's heading;
  Orbit circles its place between its inner and outer radius (their middle), Height above it;
  FlightGrab grabs its target; a Travel flies when the flier is in the air or its place is 4096
  or more away (TODO(M13)), at 1536 over the ground, and lands there on the navmesh. With
  nothing asked it circles where it began to, 2048 wide.
- **Grounded**: SetAllowFlying(false) (and SetAllowFlyingEx's allow-flying) keeps it on the
  ground and lands it (hastily) if it flies; Dragonrend (its DragonRend actor value above 0)
  crash-lands it (FlyStopCrash) unless SetAllowFlyingEx forbade crashing. Interiors have no
  flying (CanFlyHere).
- **Against fliers**: a target in the air counts as far as it is in three dimensions (bows and
  spells reach it, `chooseEquipment`); a blow from the ground does not reach one whose feet are
  above the attacker's head and half its reach (`withinReach`: melee fighters wait under it);
  observers notice it fSneakFlyingDistanceMult (3) times as far.
- **Scripts and conditions**: IsFlying, GetFlyingState, IsAllowedToFly, CanFlyHere,
  SetAllowFlying, SetAllowFlyingEx, SetForcedLandingMarker (where it lands to fight); the
  conditions GetIsFlying, GetFlyingState, GetIsCrashLandRequest, GetIsHastyLandRequest,
  IsAllowedToFly, CanFlyHere, GetIsInjured. TODO(M11): Dragonborn's dragon riding (Bend Will:
  flying mounts, IsOnFlyingMount).
- `node tools/flight-info.ts`: the races that fly, their movement types, speeds and attacks,
  the flight settings; `node tools/flight-info.ts csDragon EncDragon01Fire`: a combat style's
  flight section with its times and how often each maneuver comes, an actor's shouts and their
  reach; `--perches`: the perch furniture.
