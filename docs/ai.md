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
  floor just under or over its feet). What its graph was told goes on from one to the other: a
  deer that fled past the high process at a run is told it stopped as it stops (before, its
  graph ran on the spot for minutes, never told). Held there by an animation-driven idle while
  its AI sends it away, its idle is stopped as a moved actor's is (ActionIdleStop, again each
  second): a chicken lying down otherwise gave up every walk its sandbox sent it on. Held so, its
  clips' root motion moves and turns it, as a controlled one's (a deer's canned flee turn
  carries it on). TODO(M13): the engine's process levels (CommonLibSSE
  `ProcessLists`: high, middle-high, middle-low, low) and how often each moves its actors are
  not documented. The controllers are in the world the
  player moves in: the player bumps into actors and they into each other. The crosshair's pick
  (L_ITEMPICKER) meets an actor's controller, its BIPED bodies keyframed to its pose
  (`src/shell/actor-bodies.ts`) or a dead one's ragdoll and takes that actor (`talkTargets`,
  `src/shell/actors.ts`; an actor with no collision in the world by its body's line, feet to
  head); line-of-sight rays meet the BIPED bodies ([Detection](#detection)).
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
- **Its graph** is driven as the engine's graph data channels do
  ([animation.md](animation.md#driving-the-graphs)): Speed, Direction and TurnDelta are what
  its steering wants in the last physics step (the velocity and the turn rate it asked of its
  controller, not what physics made of it: an actor walking into a wall walks on the spot, as
  the engine's do; once its controller has made the same for half a second, that: the motion
  feedback), with the actions their thresholds perform (moveStart, moveStop, turnLeft,
  turnRight, turnStop, moveForward, moveBackward) and the sync variables they set. The player's
  body is driven the same way. The graph's BSSpeedSamplerModifier turns Speed into
  SpeedSampled, the blend parameter of the locomotion blends. Measured on Orgnar: walking 80
  units per second plays MT_WalkForward, running 370 MT_RunForward. Its TurnDelta is the turn
  its steering made over all the physics steps since its graph was last driven (steps run at 60
  a second, frames at their own rate): read from the last step alone, a frame of two steps whose
  second had nothing left to turn said 0 and the next frame's single step said the turn, so an
  actor turning steadily (a wolf circling its prey, a horse following its rider's view) sent
  turnLeft and turnStop ten times a second and more (QA: 17 to 23 a second). Its IsSprinting
  follows its wish too (it asks to go at a sprint), not the speed physics made of it: a horse
  galloping into a fence went in and out of its SprintState 19 times a second. A travel that arrives on
  the way keeps its request until the next frame, so that the next travel its AI starts at once
  (a patrol's next point) goes on without a step of standing (a moveStop and moveStart at every
  patrol point otherwise).
- **Root motion:** the graph adds up, every update, how its playing clips move the actor (the
  behavior project's animation data, [formats/hkx.md](formats/hkx.md#animation-data)), each by
  its weight on the root bone (camera bobs and other partial poses leave it alone). While the
  graph is animation-driven (bAnimationDriven, set by BSIsActiveModifiers in furniture,
  staggers, dialogue, interactions) or while the actor stands and its clips move it (an attack's
  lunge, a canned turn: NPC_TurnRight90 turns Orgnar 90.1°, NPC_TurnLeft180 180.2°), its root
  motion moves and turns it in the next physics steps instead of its request. TODO(M13): the
  engine's rule is not documented. Held so in an idle (the dialogue idles MotionDrivenIdle plays,
  AnimationDrivenDialogueIdlesStateHH) while its AI sends it somewhere, its idle is stopped
  (ActionIdleStop: IdleStop for an NPC, which takes the idle machine back to its initial state
  and clears bAnimationDriven, bBlendOutSlow and bForceIdleStop), again each second until it
  is gone; then it sets out as any actor does (moveStart by its speed). MT_Standing_State
  leaves on moveStart only while not both bBlendOutSlow and bForceIdleStop are set, which such
  an idle sets: told moveStart alone, Lokir never moved, stood in the line, and the execution
  waited for the archers to kill him (measured in the browser: after IdleStop he ran his
  patrol). The engine stops an actor's current idle (AIProcess::StopCurrentIdle, with a
  force flag the graph's bForceIdleStop names); TODO(M13): when exactly it does so for a path
  is not read from the engine yet. As the graph lets go (bAnimationDriven back to 0) while it
  still goes its way it is told again (moveStart; turnLeft / turnRight turning), as the engine
  performs the movement action again when it stops an idle. Beyond the high process (no
  controller) an actor held so does not go its way either: it glided (a chicken sitting in its
  idle while it went on).
- **Trigger volumes** see actors with controllers: OnTriggerEnter and OnTriggerLeave with the
  actor, GetTriggerObjectCount counts them; fliers in the air too ([Flying](#flying):
  OnTriggerEnter and Leave; TODO(M13): GetTriggerObjectCount counts only those with controllers).
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
  it (logged; back where it was if that took it off the floor). The engine's own way out (observed
  in the original, its numbers not all identified): its path manager's static avoider keeps a window of
  the actor's recent updates, where it was and where it meant to be; when the window shows it
  moving well short of its way (fAcceptableErrorRatio, 0.9, against what it covered) it lays an
  avoid node one radius ahead of the actor (cost fDefaultAvoidNodeCost, 32) and searches again
  round it; only with bStaticAvoidanceTriggerMovementBlocked (off) does that also tell the actor
  it is blocked, whose MovementBlocked handler would put it in an engine-made "movement blocked"
  package (procedure 36; bUseMovementBlockedPackage, off, is read in the actor's update, its role
  not read).
  TODO(M13): ours searches wider instead of laying avoid nodes (findPath keeps off places, it has
  no costs).
- **Against a wall** (observed in the original): its graph is told what the actor wants,
  not what its controller made of it, whenever the two disagree (motion feedback:
  [animation.md](animation.md#driving-the-graphs)), and the player's graph always
  (bPlayerGraphFeedback 0), so an actor pressed against a wall walks on the spot, and a horse the
  player rides into a fence gallops on the spot. An NPC's AI notices it as above; the player's
  controls never do.
- **Warped** (observed in the original; the INI's [Pathfinding]): a travel given up (no
  way there, stuck after its searches, shut doors) counts as a path failure, the count starting
  over where the actor stands more than fMinFailureDistance (50) from the last failure. At
  iWarpMaxPathFailureCount (3) failures in a row (bWarpOnConsecutiveFailures) the actor is
  warped to a point fWarpPathOffset (100) short of where it was going, on the navmesh: once
  neither it nor that point is in the player's view, at most fWarpMaxTime (5 s) later (logged).
- **A destination that moves** (observed in the original): a path to a reference is
  searched again once the reference moved from where the path leads, an actor more than
  fAIMoveDistanceToRecalcTravelToActor (100), another reference more than
  fAIMoveDistanceToRecalcTravelPath (300), a leader followed more than
  fAIMoveDistanceToRecalcFollowPath (300); the travel goes on to where it is now.
- **Others in the way** (`src/ai/avoidance.ts`): an actor on its way looks at the nearest
  iMaxActorsToAvoid (10; at most 32) actors with controllers and the player within its
  avoidance radius (its speed times fAvoidanceTimeDelta, 3 s, between fMinAvoidanceRadius 256
  and fMaxAvoidanceRadius 512, and its radius: observed in the original), and goes round
  those its way would bring within reach (both radii and 8 units) in the next 1.5 seconds, the
  first it would meet: on the side away from it (right of one straight ahead), two that meet
  head-on both keeping right, turning just as far as passing needs (at most 1.2 radians). The
  player riding (a horse, a cart) is carried and no one to go round: their own horse went round
  them every step, its way wavering left and right under its rider.
  Kept from going on by one in its way (slower than 16 units a second) for longer than
  fMaxTimeBlockedByActors (1 s), it searches its path again round that one. TODO(M13): how the
  engine's own avoidance turns the way is not read yet.
- **Bumped** (`src/shell/actor-movers.ts`): the player walking into an actor's controller (at
  40 units a second or more, towards it) is a bump: where the player came from, clockwise from
  the actor's facing (GetLastBumpDirection), and whether it was small (IsSmallBump; observed in
  the original: big when the actor goes at fBigBumpSpeed, 600, or faster, or the player
  sprints into it; fSmallBumpSpeed the engine never reads).
  The actor plays ActionBumpedInto's idle (NPC_BumpFromFront, _BumpedFromLeft, ...: its tree
  picks by the direction), then, if it stood, steps off the player's way to the side it is on
  after the game's fBumpReactionSmallDelayTime (1 s), fBumpReactionIdealMoveDist (125) away or
  at least fBumpReactionMinMoveDist (75) where the navmesh has room, waits
  fBumpReactionSmallWaitTimer (3 s), and its package goes on. It says its ActorCollidewithActor
  line ([Talking](#talking)). TODO(M13): whether actors bumping each other react too.
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
  A door is queued again only by a cheaper way to it, and where a door leads is worked out
  once with the map: a worldspace's area has hundreds of doors, and every way back into it
  queued them all again (17 ms a search on average in the audit below, now 3.5 ms; the
  compass's quest doors and the actors away search on the main thread).
- **Roads:** between two points of an exterior the actor follows the NAVI's precomputed paths
  (NVPP) where that is at most 1.5 times the straight way.
- `node tools/route-info.ts <from> <to>` prints the route between two references (Mila Valentia
  from her house to her market stall: 1 door, 4,713 units); `--audit` routes from 40 load doors'
  arrivals to every other door: of the 2,153 load doors 1,334 of 1,560 routes are found, 3.2
  doors a route, 3.5 ms a search. Those not found start or end where no door leads on: scripted
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
- **When** (observed in the original): as the game's hour changes, every
  fEvaluatePackageTimer (15 s), every frame while it has none, and when a script asks
  (EvaluatePackage); here also as its package ends. One that must complete (PKDT flag 0x4) is not
  left before it has. One that completed ends and stays, done, while it is still the one chosen:
  it does not run again until another has run (a branch that repeats when complete is what goes
  round; a patrol not repeatable stops at its end). TODO(M13): the fallout behaviour of one
  without Skip Fallout Behavior (it stands). Its scripts hear of it: OnPackageStart (the new package), OnPackageChange
  (the one left), OnPackageEnd (one that ended), and the package's own fragments (begin, change,
  end) run, and its begin, change and end actions: an idle played, a topic said. While it
  runs, the actor plays the package's idles (its IDLA list, else its template's) whenever it
  stands still, one each timer (at least 8 seconds apart). GetCurrentPackage and
  GetIsCurrentPackage answer from it.
- **Its tree** runs from the root (Creation Kit: Procedure Tree; the engine's rules are not
  documented, these are its names'): a Sequence runs its children in order, one whose conditions
  do not hold skipped; a Stacked branch the first child that may run; a Simultaneous branch all
  those whose conditions hold at once, every update each of them (observed in the original),
  ending as one of them ends, whichever (those beside it stop then: the Sleep template finds a bed
  while it sandboxes, then sleeps), or, with PRCB flag 0x2 (xEdit's "Unknown 1"), as all of them
  have (the Sit template sits and waits; 19 of the 151 vanilla Simultaneous branches have it: `node tools/package-info.ts --simultaneous`). Ended by its first child
  alone before, the Sit template's search for a seat kept its package running after the Travel
  beside it, whose success completes the package, had arrived: DialogueRiftenSS02Scene and
  IvarsteadSSScene never ended. A Random branch runs one that may run, at random. A procedure
  runs until it
  succeeds or fails; one whose success completes the package (FNAM 0x1) ends it; a branch that
  repeats when complete (PRCB 0x1) starts over. Chosen again (every evaluation, EvaluatePackage)
  while it stays the package chosen, its tree goes on, unless a branch it runs (or, ended, the
  branches its last procedure ran under) may no longer run: then the tree is taken again from its
  root, the package staying (no package events): DialogueFollower's follower travels to wait as
  WaitingForPlayer turns 1 and follows again as it turns 0 (TODO(M13): the engine's own rule).
  The package's preferred speed (PKDT, with its flag) is its gait: jog and run run, walk and fast
  walk walk.
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
  the references each links to (XLKR without a keyword), starting at the nearest point if so
  set; observed in the original, the patrol's way is built from the links until one comes
  back to a point already on it, and only such a way goes round again, and only if repeatable
  (from the point the links come back to; not repeatable, it walks to that point once more and
  succeeds): a way whose last point links nowhere succeeds at its end, repeatable or not (ours
  went round any repeatable patrol for ever, so a single marker held its package and the scene
  phase waiting on it: Hadvar's dunCGHadvarToDragonCWallPerchHide in MQ101's dragon attack);
  Follow keeps within its maximum radius of its target, closing to
  its minimum; Wander goes from one random point of its place to another between pauses;
  Sandbox passes the time in its place (below); Sit, Sleep and UseIdleMarker use their furniture
  (their target, or the first free one a Find found) or idle marker and stay while the package
  runs (Sit succeeds once the actor sits, which MQ101's execution waits for; it stays seated). A
  Patrol point it was blocked from is tried again a few times before it goes on. The rest is in
  [The AI's game settings](#the-ais-game-settings): the radii places are reached within, the
  patrol's stay at its points, Wander's distances and pauses, Follow's radii and speed, Escort's
  waiting. Find keeps what its criteria name within its place in its object list (nearest first;
  without Allow Stealing only what the actor may use: below); Acquire picks those up; Activate
  goes to its target and activates it (furniture: uses it); Eat plays its eating idle with food
  it carries (one used up) or, with Create Fake Food, food made for the meal (ActionIdle's
  EatingRoot or DrinkingRoot by GetIsUsedItemType); LockDoors and UnlockDoors lock and unlock
  the load doors of their place (a door without a lock gets a novice one); Say says its topic,
  facing its target; ForceGreet waits at its place until the player comes into its trigger
  area, goes to them and opens the conversation with its topic; DialogueActivate talks to the
  player from its place, and to another actor through a scene the story manager gives the two
  ([Conversations between actors](#conversations-between-actors)); KeepAnEyeOn watches its target in its observation area and pursues it
  in its pursuit area; Escort leads its target to the destination, waiting for it where it
  falls behind; FollowTo follows until one of them reaches the destination; Flee runs to its
  place, else away from what it flees. A procedure that does not use furniture gets the actor
  up first. Hover, Orbit and FlightGrab fly a flier ([Flying](#flying); one
  that cannot fly holds its place). UseWeapon, UseMagic and Shout practise at their target
  through combat's mechanics, not its AI (`src/shell/actor-practice.ts`): UseWeapon takes up
  the weapon its Weapon Type names (one it carries of the type; its arrows for a bow), draws,
  faces its target (Headtrack Target: its head too) and attacks in barrages of Min..Max
  Attacks Per Barrage, Min..Max Pause apart, End After Barrages of them (0 or Never End: while
  the package runs; a barrage it could not make, its weapon not ready, ends a counted
  practice as failed, and with Never End is tried again a second later: MQ101's first archer
  gave up on Lokir at once, his package ended and the scene took it as done) — a bow drawn,
  held 0.6 s and loosed (Aim Only: never loosed; Always Hit:
  no spread, and the arrow flies onto an actor target's chest wherever it runs, without
  gravity: MQ101's archers on Lokir, whose death the execution scene waits for; TODO(M13): the
  engine's way; at a target that is no actor, 48 units over its placement: TODO(M13)), a melee
  weapon swung (Always Power Attack); Do No Damage takes no health, and without Allow Combat
  Start On Hit its hits start no fight, search or crime; its weapon goes away as it ends.
  UseMagic casts its Spell (that spell, else the attack spell it would choose) at its target
  Number To Cast Min..Max times (0: on and on), held Cast Time Min..Max seconds,
  Cooldown Time apart, Dual Cast with both hands. Shout shouts its Shout (put in its voice)
  at its target once, whether or not its voice has recovered, and succeeds (vanilla templates run
  Shouts one after another: dunCGAlduinDTravelGateBlocker02's two,
  dunCGAlduinShoutFromHoverMultipleTargetsRepeatTemplate's three in a repeating sequence; and
  MQ101AlduinAttackScene1 waits for Alduin's shout from the tower, dunCGAlduinPerchShoutTemplate's
  Sit then a Shout whose success completes the package), Just Headtrack turning only its head. TODO(M13): Crouch To Reload, Hold When Blocked. Acquire leaves what a living actor
  holds; with Allow Pickpocketing it goes to that actor and takes it from its pockets, with
  Allow Killing it fights that actor (StartCombat). Sandbox with Allow Eating eats now and then
  (food it carries, one used up, else a meal made up as Eat's Create Fake Food does: `sandbox`
  in `src/ai/procedure-runs.ts`); with Allow Conversation it lets
  its actor talk with others; Say says its topic (or a topic subtype's line) to its target,
  waiting for the line itself with Finish Speaking, its subtitle forced with Force Subtitle;
  LockDoors with Warn Before Locking first tells a player inside to go (TimeToGo) and locks
  after fAITrespassWarningTimer (5 s); a player who stays trespasses (the home is off limits to
  them: warned by those who see them, then reported; docs/gameplay.md, "Trespassing"); DialogueActivate with
  another actor as its target talks with it ([Talking](#talking)).
- **Shouts and the voice's recovery** (observed in the original). Every actor's voice
  recovers alike: when its graph raises Voice_SpellFire_Event (VoiceSpellFireHandler) the shout
  goes out and the voice recovers for the shouted word's recovery time × ShoutRecoveryMult, an
  actor value whose base is always 1 (inverted: the Blessing of Talos's fortify lowers it; ours
  keeps the actor value at 0 and takes 1 − it, the same product), counted down with the
  actor's update. A voice power cast while the voice recovers is refused by the caster's cast
  check (except for the player in god mode), and the combat AI picks its voice's shout only
  while less than fCombatInventoryShoutMaxRecoveryTime (5 s) of recovery is left. The package
  Shout procedure does not wait for it: it turns to its target until within
  fAIShoutToleranceDegrees (5°; with its aim bool, holding the aim fAIShoutMinAimSeconds, 2 s),
  checks that no one stands in the way (within fAIAimBlockedToleranceDegrees, 10°), puts the
  shout in the voice and marks the voice's caster to skip its cast check for that cast
  (SetSkipCheckCast), then begins the shout with all its words; if the shout has not gone out
  fAIShoutRetryDelaySeconds (4 s) later it begins again; it is done once the shout went out
  and the voice is idle again. The shout still sets the recovery. So MQ101's Alduin shouts
  Storm Call from Helgen's tower (60 s each word) and Unrelenting Force
  (MQ101DragonUnrelentingForceShout) right after it: MQ101AlduinAttackScene1's phase 9, which
  waits for the second, took 61 s while our Shout waited out the recovery, and takes 6.7 s now
  (measured in an unattended opening; the second shout leaves 5 s of recovery). The settings
  fCombatShoutShortRecoveryTime (10) and fCombatShoutLongRecoveryTime (60) are registered but
  read by no code. Ours: `beginShout(actor, unchecked)` (`src/scripting/runtime/
casting-engine.ts`), the Shout procedure's shout through `ActorCasting.shoutAt` with
  `unchecked`; the voice's recovery is still set. TODO(M13): the aim and blocked-line checks,
  the 4 s retry (ours retries its start each second while the actor casts).
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
  holds; targets also by an alias. A location alias's location: round its world location
  marker (LCTN MNAM), as far as its radius (RNAM) or the package's; an object or a type of
  object: the nearest such reference within 4096 units of the actor (TODO(M13): the engine's
  search radius; no vanilla package names these three; `place` in `src/shell/actor-ai.ts`). A
  place in another cell or worldspace: the actor walks its route ([Routes](#routes)) to the
  first load door and leaves the stage through it, its trip going on away from the loaded area
  ([Actors away](#actors-away)) until it arrives or comes back into it.
- Measured: at 8:00 in Whiterun the Imperial guards walk their patrols (600–800 units in ten
  seconds), the gate guard goes to his chair; in the Bannered Mare Hulda, Mikael and Sinmir run
  their sandbox packages, and Saadia hers from her default list. At 2:00 in Carlotta Valentia's
  house Mila runs her Sleep package: Find finds her bed, she gets into it and sleeps, and the
  house's door is locked.

### The player driven by AI

While the scripts drive the player (`Game.SetPlayerAIDriven(true)`), the player runs AI packages
as an actor does (`src/shell/player-pilot.ts`, `ActorAi.drivePlayer`): the same choice (a scene's
package action first, then their aliases' packages), the same procedures and the same events
(OnPackageStart/End on the player; a scene's package action completes with its package). Their
packages move the player's own controller (`Player.pilot`, `src/shell/player.ts`): along a
navmesh path (straight for static pathing), turning to the way they go at their movement type's
rotation speeds (SPED: while moving, in place walking or running), at the package's gait. The
movement keys do nothing meanwhile; without a package they stand. Furniture: they walk up to it,
then the enter's slide takes them in as when they use it themselves. MQ101's prisoner walks up
in line (MQ101PlayerMoveLineMarker1) and to the block (MQ101PlayerToMarker6). TODO(M13): the
player driven through load doors (no vanilla package takes them to another cell).

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
  it stands and its controller is back. Where no exit idle fits the actor it leaves by the quick
  exit (IdleForceDefaultState, which the tree gives an instant exit before any furniture
  branch): the tree sends every child getting up from a chair-type furniture into its
  ExitChairCHILD group (that branch tests no FurnitureSpecial keyword, unlike the child's
  enter), which has only front, left and right exits, so Haming could not get up from his
  cross-legged sit and his graph stayed seated under a package that walked. TODO(M13): the
  engine's own fallback (inferred).
- **Activate** (the ActivateSpecialFurniture template) of furniture is a use of it, not a walk
  to the furniture's place and an activation: an actor in it already stays (Torolf at his porch
  rail), one standing goes in by its enter.
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
  goes on to ChairIdleState). Its exit is measured after the same events. Its graph is kept in
  the furniture's state: a body made again while it uses furniture (its look changed, a new
  play made the player's) is put back in it by the enter and the instant idle once the use is
  in it, and so is one a script's idle left standing (not animation-driven, as furniture states
  are) a moment after it played. MQ101's player walked to Helgen's chopping block in the
  camera-bob idle (IdleWalkingCameraStart: the Master machine's MT WalkingCamera, outside the
  states that take a furniture's enter), so the block's IdleExecutioneeIdle went unheard, and
  the package's end fragment played IdleWalkingCameraEnd, which left them standing in the
  block: its IdleExecutionerAlduinReactionDeath (Behavior37, within Executionee_State) never
  played, PlayImod and IdleFurnitureExit never came, and MQ101 never reached stages 145 and
  160, which give the controls back. TODO(M13): how the engine keeps a graph in its furniture
  (an enter it holds until the graph takes it).
- **Getting up: the graph says when** (observed in the original). The engine does not end
  a use by a timer: it answers the events a graph raises with the handlers
  `meshes\responses\actorresponse.txt` names (`playercharacterresponse.txt` for the player,
  falling back to the actors' list). idleChairSitting (ChairEnterHandler) puts a sitting actor
  in the furniture, unless it already wants to stand; idleBedSleeping (BedEnterHandler) a
  sleeping one, unless it wants to wake. idleChairGetUp (ChairFurnitureExitHandler) ends the
  use of an actor in any sit state (about to sit, entering, sitting, about to stand);
  idleBedGetUp and idleSleepGetUp (BedFurnitureExitHandler) one in any sleep state. For the
  player both name PlayerFurnitureExitHandler, which ends the use whatever the state (and
  gives the camera back). Ending the use sets the sit state to none: the furniture is free,
  the actor's scripts hear OnGetUp, the player's controls come back. The engine also sends
  idleChairGetUp, or idleBedGetUp and idleSleepGetUp, to a graph itself when it moves an actor
  out of furniture. The graphs raise idleChairGetUp as they leave a furniture state for the
  default one: at the end of an exit, or at once on IdleFurnitureExit (0_master's
  ChairRoot_State goes to MT_Behavior_State on it). So a graph can get up by itself: MQ101's
  chopping block reaction (IdleExecutionerAlduinReactionDeath) ends with IdleFurnitureExit,
  and the player stands up and moves again without a key (measured: IdleFurnitureExit,
  IdleChairGetUp, and the use ends in the same frame, at MQ101 stage 160). Ours
  (`ActorFurniture.graphEvents`, from the stage actors' and the player's raised events): the
  handlers by the responses files; a use still on its way to its marker is not in it yet and
  stays. One got up by its graph while entering or in the furniture stands where its graph put
  it, on the floor it came from; one leaving stands when its exit raises the event, its exit's
  root motion having taken it out. TODO(M13): the engine waits for the graph alone; ours
  stands 1.5 s after an exit's root motion at the latest, for graphs whose exits our runtime
  does not play to their end. The enter still ends by its root motion's time (the tween to the
  marker), not on idleChairSitting.
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
  or wanders (Allow Wandering: at least its Min Wander Distance, fAIWanderDefaultMinDist
  without one). One thing at a time, for 15 s plus 0.6 s per point of energy (its Energy,
  without one the actor's own) below 100 (half to one and a half times that). TODO(M13): the
  engine's choice and timing (its daily plan and fSandbox\* settings: phase 4).
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

### Executions

Furniture an actor's AI goes to use (Sit, UseIdleMarker, Activate, a scene package, the player
driven by AI) is activated as it is entered: its scripts get OnActivate with the actor, as the
player's own activation sends it. MQ101's chopping block (ExecutionerChoppingBlock) runs on that:
its HeadChopBlockHookupSCRIPT notes the executioner, the guard (their keywords) and the prisoner
as each activates it, and once all three have, plays IdleExecutionerChop on the prisoner (the
executioner's, guard's and prisoner's graphs, 0_master Behavior36, 78 and 37, all chop on it;
the player: IdleExecutionerChop_Player, then stage 98). The prisoner's chop raises Decapitate and
KillActor; a graph's KillActor kills its actor; Decapitate takes the prisoner's head off
(docs/animation.md, "Dismemberment").

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
  Sequence or Stacked branch the first child whose conditions hold runs; of a Simultaneous
  branch's children that may run (those whose conditions are not known passed over), the first
  with a place gives it: one whose place is a link the actor lacks does nothing beside the
  others. CWPatrolAndGuardContestedHold (Sven's SvenRiverwoodIntroPatrol) is a Simultaneous of
  Guards at the Civil War's linked places and a Patrol from a marker in Riverwood; Sven has none
  of the links, and taking the first Guard's missing link as "not known" left him in his house,
  so RiverwoodIntroSceneHildeSoldierScene, which waits for him within 1,000 units of the player,
  never went on (`node tools/package-info.ts --audit interiors`: 498 actors undecided at 10:00,
  494 now). The procedure's inputs (PKC2) are the package's data inputs over its template's
  defaults.
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
  its radius behind or when the leader runs, and sprints after the running player while they
  sprint or once more than fFollowStartSprintDistance (500) behind; its speed is matched to the
  leader's ([The AI's game settings](#the-ais-game-settings)). The player's followers (DialogueFollower's
  FollowerPackageTemplate follows while WaitingForPlayer is 0 and waits while it is 1: waiting
  is the scripts') come along through load doors and on fast travel: they are put beside the
  player's arrival (through a door fFollowerSpacingAtDoors, 200, and their widths apart; on fast
  travel one spacing apart; row behind row) in the game state, and show as that place loads; on
  fast travel to an exterior the player's last ridden horse comes too. Teammates
  (SetPlayerTeammate) sneak while the player sneaks. One more than 2048 units behind and out of
  the player's sight (beyond 55° of their view) for 3 seconds is put 512 units behind them on
  the navmesh. TODO(M13): the engine's catch-up rule, where it puts those coming along, Need
  LOS and Accompany. GetPlayerTeammate and GetPlayerTeammateCount answer from the game state.
- **Favors** (UESP "Skyrim:Followers"): "Wait here" and "Follow me" are DialogueFollower's
  FollowerWait and FollowerFollow (WaitingForPlayer: the template's Stacked branches follow, or
  travel there and wait; a package whose running branch may no longer run is taken again from
  its root, above), "Let's trade" its `OpenInventory` (the container menu in NPC mode: docs/ui.md,
  "The item menus"). "I need you to do something" is the info's `SetDoingFavor(true)`: as the
  conversation ends the follower stands (its AI held) and the player is in command mode
  (`src/shell/actor-favors.ts`; the first time its tutorial, HBFT): the crosshair is the HUD's
  Favor frame (SetCrosshairTarget's abFavorMode) and reaches fFavorRequestPickDistance (2100);
  Activate commands at what it rests on: an actor it attacks (sAttack: StartCombat), a corpse or
  container it empties (sSearch / sOpen), an item it takes (sTake), a door it opens (sOpen),
  furniture it uses (sUse: sits, sleeps, works there), an activator or plant it activates;
  anything else (the ground) it goes to and waits there until the player is fFavorRequestRadius
  (4000) away or talks to it (TODO(M13): how long the engine keeps it, fFavorRequestWaitTimer is
  read as command mode's own wait). A lock on its way it picks (one that needs its key: Refuse;
  an owned one where it is seen the player's trespass: lockPicked). It says its Agree line, or
  refuses: MoralRefusal where its Morality forbids the crime (violence on one not hostile only at
  Morality 0, taking what the player may not at 0 and 2), Refuse where it cannot get there. A
  reference marked with SetNoFavorAllowed is not commanded. Tab leaves command mode
  (ExitFavorState line), as do fFavorRequestWaitTimer (40) seconds without a command, its death,
  the player fFavorRequestRadius away and a script taking its favor state; doing the favor clears
  it (IsInFavorState). TODO(M13): a follower's thefts seen as crimes of its own.
- **Mounting** goes through the idle tree as furniture does: under ActionActivate, HorseEvents
  (the horse HasKeyword ActorTypeHorse) gives Mount (HorseEnter) and Dismount (HorseExit,
  HorseExitSwim). Both are paired animations: rider and horse stand at the horse's root while
  they play, the horse's graph gets the event with "pa\_" before it; the rider's graph raises
  NPCpairedStop and NPCHorseExitOut at their end, and is sent pairedStop and HorseExitOut (the
  horse PairEnd). The rider starts at the race's mount offset (HorseRace DATA: 63.5 units to
  the horse's left, facing it: the clip's "NPC" track says the same) and gets off 111.6 units
  to its left (the dismount's end). Riding, its root is on the horse's SaddleBone (its
  HorseRider_State poses its pelvis at the root), its graphs driven by the horse's movement
  (its TurnDelta the horse's steering's: measured from frame to frame, frames without a physics
  step told the rider's graph it stopped turning);
  the horse's own AI waits. Off the horse its graphs stand again (Speed 0, moveStop): what moves
  it on foot starts from a standing graph (a rider let off a walking horse came out of
  HorseExitOut walking on the spot: Elenwen at Helgen's gate). GetSitting answers 2, 3 and 4 for a rider mounting, riding and
  getting off; IsRidingHorse, IsBeingRidden, IsOnMount, Dismount and IsPlayersLastRiddenHorse
  answer from it. A mount or dismount whose paired animation never says it ended is ended after
  [Animation] fMountDismountTimeout (8 s; the engine's timer, observed in the original).
- **The player** rides a horse by activating it: "Ride" (sRide), "Steal Horse" (sStealHorse)
  for one owned (XOWN) by another that is neither bought (PlayerHorseFaction) nor the last they
  rode: the game asks first (sStealHorse), then riding off is the theft
  (`CrimeEngine.horseTheft`: a steal of iCrimeGoldStealHorse, the horse marked stolen for
  IsHorseStolen; docs/gameplay.md, "Crime and factions"). Mounted, the movement keys send the horse the way the camera
  looks (it turns as it goes), Run and Sprint walk, run and gallop it; Activate gets them off.
  The back key (observed in the original: the player's movement input on a mount) drops
  the side keys; a horse that stands, or already backs up (its way within [Controls]
  fHorseClampAngle, 10°, of straight back), backs up facing on, one that moves otherwise is
  reined in and stops. They are carried on the saddle in the physics steps (their shape out of
  the world, and no one for their horse to go round), so their camera rides with the horse.
  TODO(M13): how the engine turns the horse to the camera (its rate; fHorseMaxAngleBeforeTurn),
  the path tweener to the mount place, mounting from the right.
- **Actors riding:** a procedure that lets an actor ride ("Ride Horse If Possible": Travel,
  Patrol, Follow, ...) mounts its horse (its ACHR's XHOR: General Tullius' MQ101TulliusHorse)
  within fAIHorseSearchDistance (3000) as it starts, also where it need not go anywhere (MQ101TulliusHoldPosition:
  Tullius waits in the saddle, so he leads the column as it sets off); one just come onto the
  stage (3 s) is put on at once (HorseEnterInstant; TODO(M13): the engine's rule for actors
  loaded with a horse). Its travel moves the horse; one that does not gets
  it off first, as do using furniture, taking and activating, and load doors
  (sNotAllowedToUseAutoDoorsWhileonHorse).
- **Carts and their riders:** below, "Vehicles".

### Vehicles

A cart a horse pulls and the actors riding it (`src/ai/vehicles.ts`, the stage:
`src/shell/actor-vehicles.ts`). Observed in the original (the game 1.7.104); what is
inferred is marked so.

**TetherToHorse** runs a moment later on the main thread (the native queues it). It puts the horse
`fHorseOffsetY:Cart` (200) ahead of the cart's origin along the cart's heading (`fHorseOffsetX`
across, 0; `fHorseOffsetZ` up, 0, on the horse's own height), turned as the cart is, its
character controller moved there too: a horse is always put in the shafts, wherever it stood
(the opening's second horse stands 411 ahead in the editor). Then the cart is joined to it:

- every simulated body of the cart weighs `fMass:Cart` (130 kg). Havok's setMass changes only
  the mass: the inertia stays as the model has it (the prisoner carriage's body was authored at
  12,000 kg with an inertia of 23,190 kg·m², which it keeps);
- the four wheels (WheelBackLeft, WheelBackRight, WheelFrontLeft, WheelFrontRight, on their own
  hinges) get `fFriction:Cart` (100; the carriage's front wheels were authored with 0.5), an
  angular damping of `fWheelAngDamp:Cart` (0.01), a linear damping of 0.005 and an allowed
  penetration of 0.3 Havok units (21 game units: they are swept only when a step would sink them
  deeper), and an action that every step pushes each down with its mass times `fGravMult:Cart`
  times 9.81 m/s², on top of the world's gravity (3.5: they hold the road);
- the FrontBar gets a linear and angular damping of 0.01;
- an action keeps the cart's body from tipping over: it looks at the world's up from the body;
  when that leans more than 0.71 towards the body's side (the body's right axis rises or sinks
  that far), or the body is upside down, it gives the body an angular impulse of
  `fTipImpulse:Cart` (500, Havok units) about the body's own forward axis, turning the side
  that is up down;
- a keyframed body follows the horse's spine node (`sHorseConnect:Cart`, HorseSpine2), placed
  where the node is in the world and turned as it is: a sphere of 0.057 Havok units (4 game
  units) on the BIPED_NO_CC layer, 130 kg, keyframed. The whole cart is put in the horse's
  collision group, so the cart, the horse and that body never touch. The body holds the cart's
  FrontBar (its shafts and front axle) by a prismatic constraint: the FrontBar's point
  (`fCartPivotX/Y/Z:Cart`, 0, 3, 0.7 Havok units: 210 ahead and 49 up of it) on the spine
  (`fHorsePivot`, its origin), sliding along the FrontBar's up tilted `fCartRot1:Cart` (10°)
  between `fCartLimitMin/Max:Cart` (±0.75: ±52 units), held across that axis and in all three
  turns. The cart's body hangs on the FrontBar by the model's own limited hinge (±40° about the
  vertical), so it turns behind the horse as a wagon does, its wheels rolling on the ground;
- the horse's harness bones (`sHarnessBoneLeft/Right:Cart`) are taken off the horse and hung
  on the cart's pole (`sHarnessBoneCart:Cart`, FrontHorseCarriage01, under the FrontBar) at
  ∓`fTetherOffsetX` (50), `fTetherOffsetY` (163), `fTetherOffsetZ` (13): the harness mesh,
  skinned to the horse's spine and to those bones, reaches from the horse to the pole. Every
  frame the pole turns (the shortest turn of its length, +y) to point from where it hangs at
  the spine raised by `fPoleZOffset:Cart` (-20).

Here the cart is simulated so with Rapier (`src/ai/cart-tether.ts`; the physics:
[physics.md](physics.md#tethered-carts)) once its horse stands where the tether put it and the
ground under the cart is in place (until then its bodies wait where it was placed). The cart
does not touch the actors near it (its horse, its riders, those walking by): their controllers
keep them off it, but their keyframed bodies, moved into it at any speed, threw it. TODO(M13):
how strongly the engine's characters push simulated objects.

**The ride.** The carts bounced like mad on the opening's road. Measured every physics step
over the whole ride to Helgen (both carts, about 4 minutes each), with the bounce as the cart
body's vertical speed against its average over a second (the road's own rise and fall taken
out; the ground under the horse's feet alone gives 7.4 units a second):

|                                              | before              | now                   |
| -------------------------------------------- | ------------------- | --------------------- |
| bounce (RMS, units a second)                 | 15–23               | 7.9                   |
| bounce at most                               | 211–404             | 82–106                |
| at the hairpin (RMS / at most)               | 12–27 / 113–338     | 8–9 / 69–72           |
| vertical acceleration (RMS, units a second²) | 950–1,290           | 560–590               |
| pitch rate (RMS / at most, radians a second) | 0.12–0.19 / 1.8–3.4 | 0.08 / 0.8–1.2        |
| roll rate (RMS / at most)                    | 0.15–0.19 / 2.3–2.9 | 0.10 / 0.7–0.8        |
| the tether's turn away from its frame (RMS)  | 15–19°              | (pitch and roll free) |

The causes, each measured by replaying a recorded ride (the horse's spine every step) over the
road's collision in Node:

- **The spine jumped.** A horse behind the camera is animated ten times a second, and a frame
  of several physics steps moves it once: the keyframed body jumped to each new pose in one
  step and yanked the cart ten times a second. The engine interpolates an actor's pose between
  its graph's updates; the tether now follows the spine so (`PoseEasing`: each new pose eased
  into over the time the last one took, from where it was shown). This alone halved the bounce.
- **The frame fought the wheels.** The joint's frame was taken from how the FrontBar and the
  spine stood when hitched (the horse's idle leaned its spine up to 8° sideways), and the spine
  stood upright on a road sloping down up to 25° (the horse leans with the ground, but only as
  drawn); held by the tether's turns, the cart was pressed into the road or lifted off it on
  every slope (15° from the frame on average, a wheel in the air on every step). Now the frame
  is the spine's rest (the cart turned as the horse standing), the spine leans as the horse is
  drawn leaning (eased: `TETHER_LEAN_EASE`, 0.3 s; the drawn lean jumps from one ground
  triangle's normal to the next), and the cart's pitch and roll are left to its wheels; its
  heading is held by a spring (`TETHER_TURN_SPRING`). Held outright (as the engine's joint
  holds them), Rapier's stiff joint threw the cart off the road whatever the spine did.
- **The start.** The cart waited where it was placed, a little above the ground, and fell onto
  it as it was let go, Rapier pushing it back out at 100 units a second; it now starts as the
  engine's settled cart would (its first half second only moved out of what it overlaps).
- **The tilt prevention never acted**: it compared the body's up with its own right (always
  square). It reads the body's right's rise now, as the engine does.

What did not matter (the same replay): the wheels' continuous collision, the landscape's
internal edges (Rapier's fix for edge bumps), 16 solver iterations instead of 8, restitution (a
wheel's 0.4 against the landscape's none is none), and the steps per frame: with the browser's
CPU slowed three times every frame took the 3 steps `uMaxNumPhysicsStepsPerUpdate` allows, and
the cart bounced 8.7–10.8 units a second (17 seconds of the ride), as at one step a frame (the
spine's pose, moved once a frame, is eased over the frame's steps). Keeping the inertia as the
engine does made the cart rock 40% more here: the engine holds the body's attitude by the
tether, here the wheels do, and a body as heavy to turn as 12,000 kg on a mass of 130 follows
them late; so the inertia is scaled with the mass. TODO(M13): Havok's solver lets the held
turns give way to the wheels; how far is not known.

`node tools/cart-ride.ts` drives a cart behind its horse over the real collision of its road
(the horse walking its linked references, its spine at rest): MQ101's carts down past the
hairpin (their links end before Helgen) bounce 8.8 units a second (7.0–12.3 per 20 s), their
pitch rate at most 0.69 radians a second, their up never below 0.895;
tests/vehicles.int.test.ts rides the first cart's first 40 seconds.

**Its riders** sit still on it: each frame their 3D is placed at the cart's root as it is drawn
(0.00 units and 0.00° apart for each of the nine riders in every frame measured; the player,
carried in the physics steps, is within the step's 2 units). **The horses' gait** matches
the cart's speed: the horse walks at 125 units a second, as fast as its WalkForward clip moves
(125.1); TODO(M13): its graph blends TrotForward in now and then (its Direction flips between
0 and 1) and its spine sways up to 10 units sideways and 14 forward and back, which the cart
feels; that is the horse's animation's.

A door along the cart or just ahead of it is one its horse comes to: it opens to the horse as
any door on an actor's way, and an actor's door is not shut while a cart is still in it.

**SetVehicle** (an Actor's vehicle that is not an actor; a horse makes it a rider instead)
keeps the vehicle on the actor, sets its sit state to sitting and attaches a controller to its
3D (third and first person) that every frame puts it at the vehicle's root body: its 3D turned
fully as the body is (pitch and roll too), its position the body's and its angle its heading.
So the actor's own animation movement does not move it in the vehicle: its riding idles seat it
in the vehicle's frame (CartPrisonerASway puts the pelvis 200 behind and 139 above the cart's
origin, the B, C and D seats and the driver's bench the others). Two graph events end the ride,
as the engine handles them: ExitCartBegin (an exit idle starts) takes the controller off, and
the exit's root motion moves the actor out from where the vehicle was (CartPrisonerAExit: 380
out of the back); ExitCartEnd sets the vehicle to none. NPCDetach takes the controller off too.
A prisoner's exit clip ends with OffsetBoundStandingCartStart (seat A's, Ulfric's, with
OffsetBoundStandingStart): it sends CartExit, the only way out of the human graph's Cart_State,
whose exit raises ExitCartEnd (inferred from the data). The player rides so too, carried in the
physics steps (their shape out of the world meanwhile); an actor's AI that goes somewhere lets it
off. Before, the riders were at the cart's root but moved by their graphs' movement: actors
still walking or falling (Speed up to 1977) as SetVehicle came drifted up to 634
units behind the cart (Ulfric "hovering above the next horse").

The cart's travel is its horse's packages (the opening's PatrolStaticPathing along 58 markers to
Helgen); `ActorVehicles.startTravel` has the horse choose its package again, as the opening's
stage 15 and a scene's package action do.

**SetMotionType** reaches a cart its horse pulls (its collision is the vehicles' once its cell
gave it up, so the cell's placements no longer hold it): keyframed, its bodies stay where they
are whatever its tether does, dynamic they are simulated again. MQ101's stages 42 and 43 keyframe
the carts as they stop in Helgen's square, so they stand while their horses idle, their riders
get out and the square's corpses are enabled round them (before, the call was lost: the carts
rocked on their wheels for minutes as their horses' idles swayed the tethers, and the dead horse
by the second cart, enabled with the dragon's attack, pushed it about).

**A horse that jumps** (moved by a script, warped by its failing ways, or back on the stage
elsewhere after it left it) takes its cart along: a spine that moves more than 100 units in one
physics step (`SPINE_JUMP`; a gallop moves about 15) moves the cart's bodies as it moved, at
rest, and the tether's body with them (`CartTether.carry`). Followed by the joint, such a jump
threw the cart at up to 10,000 units a second and left it shaking on its wheels for minutes.
TODO(M13): what the engine does with a tethered cart whose horse is moved (its keyframed spine
body would pull it so).

**Doors and scripts.** ObjectReference.SetOpen opens or shuts a door of the loaded area: it
swings with its sound and stays so (no actor's timer shuts it), its collision following its
sequence; a door comes in as the scripts left it (GetOpenState), else as placed (REFR ONAM,
"open by default"). The opening's stage 20 opens Helgen's east gate this way before the carts
reach it (it was ignored: the horses opened it as any door, and it shut 3 seconds after each
with its cart in it, through which the cart, keyframed then, passed).

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
  through it, and its trip goes on from the door's arrival point. It walks to the navmesh
  triangle the navmesh marks in front of the door (else the navmesh point nearest the door), not
  to the door's own place, which sits in its frame off the walkable floor (HelgenHomestead's
  door is a hundred units from Torolf's porch).
- **When its package changes** (a script's EvaluatePackage, a scene's package action starting
  or ending) an actor away of those spaces is asked again at once and sent where its package now
  has it. While a scene's package action runs, its packages are the actor's only ones away as
  on the stage (an action done: it stays). A trip that reaches the place a Travel sent it to
  completes that package, so a scene waiting on it goes on: MQ101TorriLedgeScene's last phase
  waits for Haming's walk into his house, which he finishes beyond its door. TODO(M13): the low
  process's other procedures (a sit, a sandbox) are not done by getting there.
- Asked 16 at a time: at Whiterun's plains district 449 actors in 38 spaces in 8 seconds at the
  start (the jump as the game loads), 0.6 seconds at an hour's change. At 9:00 Mila Valentia
  steps out of her house's door and walks to her stall at the market; set to 10:00 she stands
  there at once. TODO(M13): the engine's rule for who keeps a schedule while away (persistent
  references, the low process's reach) and its pace are not documented.
- A run works in slices: after 4 ms of asking it lets the browser draw a frame before it goes
  on (`PapyrusScheduler.giveWay`), and the plugins' actors of each cell asked about are found
  once (a worldspace's persistent cell has tens of thousands of references: looking through
  them took 200 ms each run).

A procedure that would go round without ever waiting (each step ending at once: a patrol of
one point the actor stands on was one) is stopped after 100,000 rounds within one update: its
package ends as failed and is chosen again later, so a fault in one actor's AI does not hang
the game.

## The AI's game settings

The AI outside combat reads the engine's game settings by name (`src/ai/ai-settings.ts`: the
load order's value, else the engine's built-in default; the INI's [Pathfinding], [HeadTracking]
and [General] ones through `src/world/ini-settings.ts`). What the engine does with each was read
from the original game's behaviour only (in our words):

- **Package evaluation:** fEvaluatePackageTimer ([Packages](#packages)).
- **Where an actor is at a place:** within the place's radius, at least
  fAIMarkerDestinationRadius at a marker (XMarker, XMarkerHeading; Skyrim.esm 50),
  fAIFurnitureDestinationRadius at furniture (Skyrim.esm 150), fAIDistanceRadiusMinLocation
  (100) elsewhere: Travel, HoldPosition, Patrol's points, Sandbox's place, FollowTo's and
  Escort's destinations, an idle marker (the marker radius), furniture gone to (the furniture
  radius).
- **Searches:** an object or a type of object a package names (its place, its target) is the
  nearest within fAIAcquireObjectDistance (4000); furniture an empty object list asks for within
  fAIFindBedChairsDistance (8000).
- **Patrol:** at a point with an idle time (REFR XPRD) it waits that long; furniture it uses for
  at least fAIPatrolMinSecondsAtNormalFurniture (30 s).
- **Wander:** each walk at least its Min Wander Distance (its slot 3, a number the engine reads;
  Sandbox's slot 10; fAIWanderDefaultMinDist, 200, without one); between walks a pause of up to
  (fAIMaxWanderTime − (Energy × fAIEngergyLevelMult + fAIEnergyLevelBase)) / 2 seconds, at
  random (Energy: the actor's; 100 − 50 → up to 25 s).
- **Where a wanderer walks** (observed in the original: BGSProcedureWander's update; a
  Sandbox that wanders runs a Wander of its own in the sandbox's place, with its Min Wander
  Distance). Its place reaches at least fAIDistanceRadiusMinLocation (100). Outside the place
  it first goes into it. Its first walk is a **random location of the pathing**: a point of the
  navmesh within the place that it can walk to, at least its Min Wander Distance away. Every
  walk after that goes **across the place**: from the place's middle, the way from where its
  last walk led towards the middle, turned at random by up to 45° either side, as far as a random
  share of the radius (the middle's height). A point it cannot walk to (off the navmesh, behind
  a fence, on another island) gets no path; its walk is a request to the pathing, which finds
  its way later, and without one the wander asks again (inferred: TODO(M13), how the engine's
  pathing answers a goal off its navmesh is not read). Ours
  (`src/ai/procedure-runs.ts` wanderPoint, `randomReachablePoint` in `src/ai/pathfinding.ts`):
  the reachable triangles within the place by their area, a random point in the one picked; an
  across-the-place point is taken only where a path reaches it (up to 8 tried at once, else it
  waits a moment). Before, any point of the circle was taken unchecked, inside houses and
  behind the garden fences, and the first walk went anywhere within it (QA: a Riverwood chicken
  beyond the high process stood 26 s 687 units short of its point, in every run; with this and
  the walkers' idles stopped, above in "Movement", none).
- **Follow:** its radii without its own are fFollowSlowdownZoneWidth (150) and
  fFollowMatchSpeedZoneWidth (128), the smaller the minimum. Its speed is matched to the
  leader's (`followSpeed`): at least the leader's; from the middle of its radii to the outer one
  up to fFollowExtraCatchUpSpeedMult (0.2) faster (running beyond it 1.25 times); nearer than
  the middle slower, towards nothing at the inner one; always within
  fFollowWalkMinSlowdownMultiplier–MaxSpeedupMultiplier (0.75–1.5) times that speed walking,
  fFollowRun… (Skyrim.esm 0.75–1.25) running. TODO(M13): which of its zones the engine passes
  as inner and outer (here its minimum and maximum radius) and its walk zone
  (fFollowWalkZoneMult).
- **Escort:** it waits once the target is more than its Distance To Wait For Followers behind
  (without one fAIEscortWaitDistanceInterior, 512, inside; outside its destination's radius,
  at least 200, times fAIEscortWaitDistanceExterior, 2) and goes on once the target is that near;
  on its way it stops only fAIEscortHysteresisWidth (50) farther; it starts or stops at most
  every fAIEscortStartStopDelayTime (1 s).
- **LockDoors' warning:** fAITrespassWarningTimer (Skyrim.esm 5 s).
- **Paths, avoidance, warps and bumps:** [Paths](#paths); **followers' speeds and doors,
  horses:** [Followers, mounts and vehicles](#followers-mounts-and-vehicles); **detection, the
  alarm and the guards' response:** [Detection](#detection) and docs/gameplay.md;
  **head tracking:** docs/animation.md.
- **Settings the engine never reads** (only defined): fSmallBumpSpeed, fSneakSizeBase,
  fCrimeAlarmRespMult, fAIBestHeadTrackDistance, fAIInteriorHeadTrackMult.

## Detection

What the actors notice (`src/ai/detection.ts`, `src/ai/detection-states.ts`,
`src/ai/light-level.ts`, `src/ai/reactions.ts`, wired in `src/shell/actor-senses.ts`; check:
`node tools/detection-info.ts --settings | --records | --level ...`).

- **Who tests whom:** every living actor of the high process whose AI runs (not one a script
  disabled with EnableAI false: it is still seen) tests the player and the other actors of the
  high process, each every fDetectionUpdateTimeMin (1 s) near the player to
  fDetectionUpdateTimeMax (2 s) at detection's reach; in a complex scene (as many actors as
  iAINumberActorsComplexScene, 20, or more) fDetectionUpdateTimeMinComplex (2.5 s) to MaxComplex
  (5 s); at most the INI's iUpdateDetectionsAllowedPerFrame (100) tests a frame, the rest wait
  for the next (observed in the original). Scripts' questions (GetDetected,
  IsDetectedBy) test anew when the last test is older than a second (the Construction Set
  wiki: GetDetected runs the formula).
- **The reach** (observed in the original): fSneakMaxDistance (2500 in Skyrim.esm), times
  fSneakExteriorDistanceMult (2.1) outside, times fSneakFlyingDistanceMult (3) when the
  observer or the target flies ([Flying](#flying)); for an observer in combat and
  a target other than its combat target (not the player), times
  fDetectionCombatNonTargetDistanceMult (0.75): a fighter's mind is on its own target. Beyond
  the reach the level is −1000 (combat's "out of reach").
- **The formula** (observed in the original; `detectionLevel`):

  A = (max(0, reach − distance) / reach) ^ fSneakDistanceAttenuationExponent, the distance
  between the two actors' positions;

  sound = (int(fSneakActionMult) × the loudness of its last action (iSoundLevel\*, for
  fDetectionActionTimer) + (running ? fSneakRunningMult : 1) × (fSneakEquippedWeightMult ×
  the weight of the armour it wears + fSneakEquippedWeightBase) × its movement noise ×
  moving) × fSneakSoundsMult × A, × fSneakSoundLosMult without a line of sight (unless it is
  the observer's ambush target), × (1 + fSneakSleepBonus) for an observer asleep, at least 0;

  visual = in view × A × motion × (light × fSneakLightMult (fSneakLightExteriorMult outside,
  instead) + fDetectionSneakLightMod) × (asleep ? 0 : (100 − Blindness) / 100) ×
  fDetectionLargeActorSizeMult × fSneakDetectionSize\* of its race's size, at least 0, none
  for a target with Invisibility; motion = 1 + fSneakLightRunMult running +
  fSneakLightMoveMult moving, then the target's Mod Detection Movement perks;

  skill = (A × (1 + fSneakAlertMod for an observer in combat + fSneakSleepMod asleep +
  fSneakCombatMod when it has a combat target and this is another + fSneakAmbushTargetMod /
  NonTargetMod in an ambush package) × perception − the target's skill while it sneaks) ×
  fSneakSkillMult; perception = fSneakPerceptionSkillMin + (Max − Min) × the observer's Sneak
  / 100; the target's skill its Sneak with its Mod Detection Sneak Skill perks; both counted as
  fPlayerDetectionSneakMult × Sneak + fPlayerDetectionSneakBase for the player (0.4 and 10 in
  Skyrim.esm: the player's Sneak 15 counts as 16);

  level = fSneakBaseValue + sound + visual + skill, a whole number (between 0 and 1: 1; else
  its whole part); a level of 0 from the formula is −1 (0 is kept for an event's place).
  Detected above 0, in combat too: the engine never reads iAICombatMinDetection; what keeps a
  fight's target is its combat group ([Combat detection](#combat-detection)). The target's
  perks are asked (the engine's owner of Mod Detection Light / Movement / Sneak Skill and
  Ignore Running During Detection is the target, the observer the second): Ignore Running
  takes its running away, and its moving while it sneaks. Its sneaking counts whenever it
  sneaks (in combat too). TODO(M13): the perks' conditions on the observer are not given (one
  profile serves all observers), and which packages are ambushes (the engine's package type 9)
  is not read yet. Skyrim.esm stores 18 fSneak\* settings and fDetectionSneakLightMod; the
  others are the engine's built-in values (fSneakEquippedWeightBase 12, Mult 0.5,
  fSneakLightMoveMult 0.01, fSneakLightRunMult 0.2, fSneakCombatMod −0.4, fDetectionViewCone
  190, ...: `node tools/detection-info.ts --settings`). In daylight outside a bandit (Sneak 25)
  sees the player standing 400 units before it at level 29 (`node tools/detection-info.ts
--level sneak=15 light=50 distance=400 exterior standing player`), where the earlier
  reconstruction gave −1. **Muffle** (`movementNoise`): the engine multiplies the movement's
  sound by MovementNoiseMult; here the Value and Peak Value Modifiers on it (its base is 0)
  take that share off: the Muffle spell (1) and Silence's ability (1) silence it, the Muffle
  enchantment and Muffled Movement's ability (0.5) halve it (TODO(M13): how the engine's
  getter turns the modifiers into the multiplier).

- **Sight** (observed in the original): the line of sight is looked for only within its
  reach off the observer's facing: the full reach within fDetectionLOSDistanceAngle (60°) of
  the facing, beyond it shrinking evenly to fDetectionLOSDistanceMultInterior (0.75) /
  Exterior (0.5) of it straight behind. It is a ray on the line-of-sight layer (L_LINEOFSIGHT:
  static, clutter, props, trees, terrain, the actors' BIPED bodies, ...; not the character
  controllers, not transparent collision) from the observer's eyes (92% of its controller's
  height standing, 62% sitting, 20% lying) through its own bodies (its eyes are inside its
  head's: Havok keeps an actor's bodies in one system group) to the target's head (0.85 of its
  height); for an important target (the player, the observer's combat target, any for the
  player) its middle, head and legs (0.5, 0.85, 0.15), each × 0.57 while it sneaks, the first
  clear one counting. In view: with a line of sight within half of fDetectionViewCone (95°) of
  the facing. Until this the ray stopped at the observer's own head (it started inside it): no
  NPC ever saw anyone, and detection rested on the skills alone (−9 at 350 units in daylight).
- **The light on the target** (observed in the original: `detectionLight`): its light
  (night eye: × int(fDetectionNightEyeBonus)), less iLightLevelExteriorMod outside or, inside,
  the lesser of iLightLevelInteriorMod and 100 × the brightest channel of the cell's ambient,
  between 0 and iLightLevelMax, rounded after its Mod Detection Light perks. GetLightLevel
  gives that × fSneakLightMult (outside fSneakLightExteriorMult). The light itself
  (`lightLevel`): the luminance of the view's lighting at its chest times 100: the mean of the
  six directional ambients, the directional light where a ray to the sun is clear (inside
  always), each point light within its radius with the renderer's falloff 1 − (d / r)²
  (TODO(M13): the engine keeps each actor's light from its renderer, a sum not read). The point
  lights are those the viewers light the world with, outside and in: the cells', the created
  objects' and those the actors carry (`ActorStage.lights`): a torch in a hand (its LIGH at its
  model's AttachLight node: [Combat](#combat), Torches), a spell's casting light in a hand,
  magic effects' lights (Candlelight), what flies and bursts.
- **States** per observer and target: detected above 0, noticed above fSneakNoticeMin (ours,
  for the stealth eye and the reactions to something near: the engine never reads it),
  searching once a noticed or detected target is lost (or a noise heard) for
  fDetectionStateExpireTime (30 s), else unseen. Each change is told (`Detections.listen`:
  detected, noticed, searching, lost; heard, witnessed, alarm, attacked, corpse). The places
  kept are copies (an actor's position is its own, and moves on).
- **Events** (observed in the original: `eventLevel`): a noise (CreateDetectionEvent, the
  sound level of an impact that sounded, `ActorSenses.noise`) reaches the actors within
  fDetectEventDistancePlayer (1536) of the player's, fDetectEventDistanceNPC (512) of others'
  (× fDetectEventDistanceVeryLoudMult 2 when very loud); a target's projectile seen passing
  within fDetectProjectileDistancePlayer (1024; an actor's in combat:
  fDetectProjectileDistanceNPC 512), in the observer's line of sight and view cone, is an
  event of loudness 50 where it is. Its level: fSneakBaseValue + int(fSneakActionMult) ×
  loudness × fSneakSoundsMult × A (× fSneakSoundLosMult without a line of sight to the place)
  - in view × A × (iDetectEventLightLevelInterior / Exterior × fSneakLightMult (outside
    fSneakLightExteriorMult) + fDetectionSneakLightMod) (none asleep), A over fSneakMaxDistance
    (fDetectEventSneakDistanceVeryLoud when very loud) × fSneakExteriorDistanceMult outside; no
    skills. Above 0 the hearer knows its owner is there (its level 0 at the place: combat groups
    hear of it, [Combat detection](#combat-detection)), is alerted there (GetIsAlerted) and
    searches. The data: IPCT sound levels normal 659, loud 1, silent 3; every footstep impact
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
  SendStealAlarm (the actors within iCrimeAlarmRecDistance of the criminal are alarmed, those
  beyond the high process within iCrimeAlarmLowRecDistance of the one who raised it; guards
  among them pursue, iNumberGuardsCrimeResponse at most:
  [Crime and factions](gameplay.md#crime-and-factions)), StopCombatAlarm, CreateDetectionEvent; OnGainLOS / OnLostLOS for the pairs scripts
  register (every quarter second; the player sees what is on screen with nothing between the
  camera and it; the first look tells how it is).
- **For combat (5.2) and crime (M11):** `ActorSenses.detections` (state, level, detects,
  detectors, known, lastKnown, listen), `noise`, `action`, `attackedBy`, `fight`, `warn`, the
  hooks `inCombat`, `combatTarget` and `hostile` (the combat AI sets them), `tested` (each
  test and event told to the combat groups), `combatOverrides` (ECOR),
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
  optional is there: the reference its alias holds, alive, or dead and done with unless its
  death ends the scene (MQ101AlduinAttackScene1 casts StormcloakPrisoner01, beheaded in Scene4
  before it, and must play for Alduin to come; TODO(M13): the engine's rule). Its actors are
  in it until it ends
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
  The head turns through the world's look-at (WorldBridge.lookAt with the 'dialogue' kind:
  [animation.md](animation.md#head-tracking), the actor's head track target and its graph's
  BSLookAtModifier);
  with Face Target the actor turns to its target while it stands (`src/shell/actor-scenes.ts`),
  its package's own facing coming back after.
- **Packages:** while a package action runs, its actor's package stack is that action's
  packages alone (`ActorAi`'s stack asks the scene first). Observed in the original
  (BGSSceneActionPackage): as the action starts, its actor takes the first of its packages
  whose conditions hold, as a new start of that package: one the actor runs already and has
  completed (its alias's package, the same package of an action a phase before) runs again
  from its root, so a Travel to where the actor stands is done at once (ours kept a completed
  package done while it was still the one chosen, and the action waited for an end that had
  come before it started: Hadvar at MQ101HadvarMarker8, below); with none, or an actor dead,
  disabled or no actor, the action is done
  at once (MQ101DragonAttackScene1's first phase waits on Alduin's MQ101AlduinPerch1, whose
  conditions no longer hold by then). While it runs, the engine looks at it every update: with
  the actor running the action's package, it is done once the actor is dead or disabled or the
  package has reached its end; with the actor in the scene but running another package, the
  action starts again (its packages again; with none that may run, done). Here the stack gives
  the action's packages back by itself, and an action whose actor runs another package is
  looked at again each second for packages that may run (`packagesRunnable` in
  `src/scripting/runtime/scene-host.ts`: the packages' own conditions; TODO(M13): those on the
  package's data). As it ends, the actor whose package it was leaves it (unless another running
  action of the scene holds it there) and chooses its package again. One whose package completes is done,
  and its actor stands where it got to until the action ends: MQ101Scene1's Imperial soldier
  waits at the cart's greeting marker while his action spans six more phases. As the action
  ends, the actor's own packages come back. An actor with Run Only Scene Packages (CommonLibSSE;
  no vanilla actor) runs only scene packages for the whole scene. IsScenePackageRunning,
  GetIsCurrentPackage and GetCurrentPackage answer from it (the scene's package where the
  actor's AI does not run). TODO(M13): the engine's stack during a scene. Observed in the
  original, the action asks nothing of where its actor is: its process runs the package, high or
  low. So an actor away runs its scene package too ([Actors away](#actors-away): sent where it
  has it, a Travel done once its trip gets there).
- **A travel that fails** is not a package done: its Travel procedure searches its way again a
  second later (the movers warp an actor whose ways keep failing near one spot,
  bWarpOnConsecutiveFailures), so a phase waiting on a walk waits until the actor is there.
  Before, a way cut short (Torolf at HelgenHomestead's door frame) ended the package as if it
  had arrived, and the action was done with him a door's width short.
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
  (not fRandomSceneAgainMinTime / MaxTime: those space random scenes).
- **Random scenes** (those of quests the Actor Dialogue event started) play one at a time and
  hold while their two actors come together: [Conversations between
  actors](#conversations-between-actors).

Measured with `--play`: Lucan and Camilla argue in the Riverwood Trader (MS13LucanCamillaSceneView)
in four lines, Lucan turns to the player for "Oh, a customer. Sorry you had to hear that." if
they see the player, Camilla goes back to work and the quest stops after 39 seconds of text;
MQ101Scene1 says the cart ride's lines in the game's order, from Ralof's "Hey, you. You're
finally awake." to "And it looks like the Thalmor are with him." After a new game in Node
(`node tools/papyrus-run.ts --new-game`) 9 scenes play: MQ101Scene1 waiting for the player's
3D, and scenes that begin with their quests, whose first phase waits for the player to come near
(MorthalInitialScene, RJBanditScene, MG01MirabelleAncanoScene: GetDistance between references
in different spaces, or with one placed nowhere yet, is as large as
ObjectReference.GetDistance's, 1e10, so they wait while the player rides to Helgen;
`tests/papyrus-runtime.int.test.ts`) or for a script (IvarsteadSSScene).

### Town scenes

The towns' street and gate scenes (Riften's DialogueRiftenSS01 and SS02, DialogueRiftenMaul,
Whiterun's DialogueWhiterun scenes, Winterhold's and Ivarstead's first visit, Markarth's Forsworn
murder, the temples, the inns' bards) are ordinary scenes; what makes them a class is how they
start. `node tools/scene-audit.ts --starts <quest pattern>` (`.` for all) lists every quest with
scenes that the Actor Dialogue event does not start: how it starts, the trigger boxes whose
scripts name it or its scenes (and whether they wait for the player), and what each scene's first
phase waits for. Of the 382 vanilla ones, 74 start with the game (4 of them also by a story
manager event), 128 by a story manager event alone (Change Location 63, Script 47, Level Up 5,
...) and 180 by scripts only (another quest's stage fragment, a trigger, a dialogue fragment);
187 have a trigger box that waits for the player (871 boxes).

What the scripts do (no engine rule of its own is involved):

- The quest starts with the game, or by Change Location as the player enters the town (Riften's
  Mistveil Keep and Bee and Barb scenes, Whiterun's preacher); its scene begins with it (Begin on
  Quest Start) and its first phase stands with the actors in their start packages.
- The first phase waits for a quest variable or stage. Riften's north gate: RDS01Scene waits for
  GetVMQuestVariable(DialogueRiftenSS01, ::pGo_var) == 1; RDSTriggerScript, on the gate's
  trigger box, compares who walks in with Game.GetPlayer and sets stage 10 (and stage 200 of
  DialogueRiftenGateGuards), whose fragment sets RDSQuestScript.pGo to 1; Mjoll and Aerin then
  talk ("I had another run-in with the Thieves Guild."). DialogueRiftenSS02 (Sapphire and Shadr)
  and DialogueRiftenMaul (Maul meets the player) work the same way with their own boxes, as
  Ivarstead's IvarsteadSSScene does.
- Others are started by the box itself: defaultStartSceneTrigScript (Whiterun's establishing
  scene, the temple's healing scenes), StartSceneTriggerSpecificTime (Amren's and Braith's
  scenes, only between its NoEarlierThan and NoLaterThan hours of GameHour), a stage set by
  defaultsetStageTrigSCRIPT (Markarth's MS01IntroWorldScene).
- Some wait for the player to come near (GetDistance to the player): MG01MirabelleAncanoScene
  holds Mirabelle and Ancano in the College courtyard until the player is within 600 units, and
  its later phases need MG01's stage 30; MorthalInitialScene, MS13BanditCampfireScene alike.

So a player who arrives elsewhere (the console's coc into the middle of Riften) and stands still
sees the actors stand where the scene put them, as in the game; the scene plays as they walk
through the gate. Checked in Node (`tests/papyrus-runtime.int.test.ts`: after a new game RDS01Scene
stands in its first phase, the player entering RDS01TriggerRef sets stage 10 and pGo, and its
lines follow) and in the browser with the QA runner's streets scenarios (below).

Which trigger boxes wait for the player is read from their scripts
(`src/scripting/runtime/trigger-gates.ts`): one whose OnTriggerEnter (in any state, its own or its
parent script's) asks for Game.GetPlayer (RDSTriggerScript, defaultsetStageTrigSCRIPT's
waitingForPlayer state), or whose properties name the player (defaultOnEnter's targets,
StartSceneTriggerSpecificTime's triggerActor). One that names only another actor
(defaultSetStageTRIGSpecificActor: MQ101SetStage32 waits for the prisoners' cart horse) does not.

Measured with the QA runner (2026-10-24, on b9b337e and after):

- The 20 places, whiterun-long-day, riverwood and windhelm-snow: 26 scenes started, 12 ended
  before and 25 and 12 after (the counts move from run to run: the Actor Dialogue scenes and how
  long a place plays). Scene stalls 1 before (Falkreath's DA05FuneralScene, waiting for
  DA05FuneralTriggerScript's box by the graveyard; in the lead's run2 also Riften's three gate
  scenes and MG01MirabelleAncanoScene), 0 after: they are the timeline's "waits for the player"
  (5 in the after run: RDS01Scene, DialogueRiftenSS02Scene, DialogueRiftenMaulStartScene,
  MG01MirabelleAncanoScene, MS13BanditCampfireScene).
- The streets scenarios: in Riften RDS01Scene plays through its five phases once the player is in
  RDS01TriggerRef and Maul meets the player once in DRMSTrig01Ref; Whiterun's Braith and Lars
  scene, Winterhold's first-visit scene and Markarth's dog scenes play to their ends; the
  establishing and Amren scenes start as their boxes are entered (their actors were not near
  the player, so the timeline does not list them).
- Left (not the scenes' rules): DialogueRiftenSS02Scene and IvarsteadSSScene stand in their last
  phase, which waits for their actors' Sit-template packages (DRSS02ShadrInScene,
  IvarsteadSSGwilinPackage: a Find of furniture near a wall-lean marker beside a Travel that
  completes the package) to complete; ours keeps them running (the furniture and package
  procedures', [Furniture and idle markers](#furniture-and-idle-markers)).

### Checking a scene against its data

Two halves, one in the browser and one in Node:

- `engineDev.sceneTrace()` (development builds, `src/shell/scene-trace.ts`) traces what the
  scenes and their actors do, a line per change: the director's own trace (phases starting,
  skipped and completing, each action starting for its actor, lines said, packages done, actions
  ending, scenes ending or stopped), each playing scene's phase, and for every actor a scene
  casts (followed on after its scene) the package it runs, whether it fights, watches a fight,
  flees, is carried (horse, cart), flies, is in furniture or off the stage, its graph's
  innermost states and its path (a point each 40 units). The first call begins it; each call
  returns it so far.
- `node tools/scene-audit.ts <scene>` (or `--quest <quest>`) lists what the data says each
  actor does phase by phase: its alias (how it is filled, its own alias packages), each action
  (a line with its first info's text and whom it looks at, a timer, a package with its procedure
  tree, every input named and resolved: the reference, its base and where it is placed), the
  conditions of the scene, its phases, the packages and their branches.
- `node tools/scene-audit.ts --trace <file> [--quest <quest>]` reads a trace and lists where the
  actors did otherwise: a scene that did not start; a package action whose actor runs another
  package (or fights, flees, stands) a few seconds on; a travel-like package done well short of
  its place; furniture a package should use never entered; a line never said; an actor that
  walks off while its done package holds it still; a phase that has waited 90 seconds and the
  actions it waits on (with their actors' state). Notes list what is not the scene's to say: a
  phase skipped, a package action none of whose packages may run, an actor moving on its own
  packages between its package actions, a stopped scene's lines cut short.

What MQ101's run (the opening, unattended, to the dragon) showed and how the systems were
wrong:

- **Torolf (MQ101TorriLedgeScene)** leans on his porch rail (MQ101TorolfUseFurnitureStart,
  ActivateSpecialFurniture), tells Haming to go in, walks to his start marker, then into the
  house after him (MQ101TorolfGoesInside); the scene ends once both are in (stage 28), and their
  aliases' packages take them out again (Torolf to his rail, at stage 120 running to
  MQ101TorolfMarker8, where Alduin's fire takes him). Ours: the Activate procedure stood him up
  from the rail first (as every procedure but the furniture ones does) and walked him to the
  rail's enter point while his graph was still leaning, which it could not leave: he retried
  every few seconds and never leaned; his later Travel left a furniture he was no longer
  recorded in, so his graph stayed leaning while his package walked, and the walk failed, which
  ended his package as done a door's width from the door. Haming's sit had no exit idle for a
  child (below), so he stayed seated with a Travel he could not walk. Once through the door
  neither's package went on (the low process did not run scene packages), so the scene's last
  phase waited for ever and held both. Fixed: Activate of furniture is a use of it (in it
  already: it stays); a travel that fails searches again; doors are walked to by their navmesh
  door triangle; an actor away runs its scene package and a Travel completes when its trip gets
  there; furniture with no exit idle for the actor is left by the quick exit.
- **Lokir (MQ101Scene4, phase 8)** runs MQ101LokirtoMarker2Package (a static patrol, Ignore
  Combat) while the archers shoot (MQ101ArcherFireLokirPackage, Always Hit) and dies on the run.
  Ours ran him; but an arrow that did not kill him at once put him in combat with the archer,
  and combat held his package: he would stand under fire. Fixed: a package that ignores combat
  holds the actor's fight ([Combat AI](#combat-ai)).
- **Package actions done short of their place:** General Tullius's MQ101TulliusToMarker6
  (getting off his horse), the cart soldiers' and Ulfric's and Ralof's walks to the block ended
  as done when a way failed once. With a failing way searched again, the final run's audit has
  none of them; a trip planned by a view that is not shown no longer ends a package either.

What the QA sweep's opening (2026-10-23) showed beyond the dragon, where MQ101 stood at stage
160 in every run:

- **The tower (MQ101DragonAttackScene1, phase 4)** has Ralof run inside to MQ101RalofMarker9
  and waits for stage 25 of MQ101DragonAttack, which only the player sets: a
  defaultSetStageTrigSCRIPT strip across the tower room (MQ101DASetStage25, prerequisite stage
  10). Its fragment closes the door behind the player and enables the doorway's collision
  marker (stage 50), and the scene goes on up the stairs. Ralof and the door were never in the
  way: Ralof stood at his marker, the door open as placed (ONAM), the collision marker
  disabled as placed. The trigger was half its size: XPRM bounds are a box's half extents
  (observed in the original: [formats/esm.md](formats/esm.md#doors-arrivals-and-collision-primitives)),
  and taken as full sizes every trigger and collision box of the game was half as wide, deep
  and tall; the player stood in the room by Ralof, a few units outside the strip. Fixed in
  the physics' primitives (`PhysicsWorld.addPrimitive`): the box is its bounds' size each way.
  The player's bumps were checked on the way: an actor standing (its travel arrived) steps
  aside after the bump's delay; one still on a travel only flinches, as before.
- **The street below the inn (MQ101DragonAttackSceneBPerchTower, phase 2)** waits for
  Hadvar's dunCGHadvarToBFromC, a Travel to MQ101HadvarMarker8. His alias runs the same
  package from stage 10 and he had got there and completed it before the scene started; the
  action giving him the package again found it chosen already and done, so it never heard an
  end and the phase stood ("Still alive, prisoner?" never came). Fixed: a package action
  starts its package anew ([Packages](#scenes), above).
- **By the wall (MQ101DragonAttackSceneCPerchWall, phase 1)** waits for Hadvar's
  dunCGHadvarToDragonCWallPerchHide, a repeatable Patrol of one marker that links nowhere. The
  engine's patrol goes round only a way whose links come back to a point of it, so this one
  succeeds once Hadvar is there; ours went round for ever ([Packages](#packages), Patrol).
- **MQ101TorriLedgeScene, phase 0** (45 s with Torolf's rail package running) is no fault: it
  waits for stage 32 of MQ101, set by a trigger the prisoners' cart passes
  (MQ101SetStage32, defaultSetStageTRIGSpecificActor on the cart's horse) about 5,000 units
  after the gate trigger that started the scene (MQ101CloseNorthGate, stage 25): 45 to 50
  seconds at the horse's walk (about 110 units a second measured).
- **RiverwoodIntroSceneHildeSoldierScene, phase 1** (45 s, nothing open): Hilde has run to
  her marker and the phase completes once Sven is within 1,000 units of the player (GetDistance
  on his alias). That waits for the player rightly, but Sven was never out to be met: his
  SvenRiverwoodIntroPatrol (until stage 10 of the scene's quest) patrols from a marker beside
  Hilde's, and where packages put actors took the first Guard of its Simultaneous, whose link
  he lacks, for an unknown place, so he stayed in RiverwoodSvensHouse. Fixed ([Where packages
  put actors](#where-packages-put-actors)): he walks his patrol outside, and with the player
  within 1,000 units the scene plays through ("A dragon! I saw a dragon!" to Sven's "And I've
  got better things to do", measured in the browser after `coc Riverwood` at 13:00).
- The QA monitor's `scene-stall` now says what a phase waits for (its completion conditions
  written out), starts the wait again when a quest those conditions read moves on, and does
  not count a phase with nothing of its own open that waits for the player to come (a
  condition naming the player): [qa.md](qa.md).

Measured with the QA runner (riverwood, combat, opening): scene stalls 3 before (TorriLedge in
the opening, HildeSoldier in riverwood and in combat), none after. The opening, unattended with
the follow bot, now runs past the tower (stage 25 some 30 s after the bot reaches the door),
across the inn's roof, through Hadvar's street and wall scenes to
MQ101DragonAttackSceneDToKeep, Hadvar escorting the player to the keep; MQ101 itself stays at
stage 160 until the keep (its next stage is set inside). Left, and seen on the way:

- **The tower's open door** (ImpWoodDoorSingleSmall01, open as placed): its collision, a
  convex block 206 units wide on the leaf's node (43 of it beyond the hinge), swung with
  the open sequence lies along the way in, its near end across the outer step; the player gets
  past only from some angles (the bot after a few tries, in one run of four never). Whether the
  engine's open leaf leaves more room is not read yet (TODO(M13): the door's open pose against
  the game's).
- **AvoidPlayer:** the engine has a procedure that keeps an actor fAvoidPlayerDistance (100)
  from the player, given to actors within fTriggerAvoidPlayerDistance (400) who see the player
  do certain things (observed in the original, its comments-on-the-player loop); which actions start it is
  not read yet (TODO(M13)). The player's bumps already move a standing actor aside.
- The follow bot's limits: it stands where the debris east of the inn holds it in some runs,
  and does not loot or equip (the keep's "Find some equipment").

The QA sweep of 2026-10-24 (main b9b337e) had the opening stand twice: MQ101Scene1's last
phase (28, waiting for stage 30 of the cart's horse at MQ101SetStage30 in the square) for three
minutes, and MQ101Scene3's phase 9 (waiting for stage 45: the first cart's driver's ExitCartEnd,
which MQ101CartRiderScript counts) for good. Bisected over the wave's merges, each run with a probe
logging the column (both carts' horses, Hadvar's and Tullius's, their packages and travels, the
carts) every two seconds: every merge up to the deaths' ran through to stage 160; with the
scripts' merge the runs stood. Neither scene nor script was at fault. The QA harness frames each
first anomaly with a camera of its own, and the loaded cells followed the camera. With the
scripts' merge the dead Khajiit caravan, four cells east of the road, raised its ragdolls' first
velocity spikes later, as the column came into Helgen (before, while it was still on the road
three cells from them; why the timing moved was not pinned down). Framed there, the camera
unloaded Helgen's cell under the column (logged by hooking the stage's removals): General Tullius, his horse and the first cart's horse left the stage with it, came back
wherever their packages had them by then, and the first cart (left behind, tethered) was dragged
up to 4,500 units after its horse; Scene3's phase 9 stood in the runs where that happened, and
passes with it fixed (TODO(M13): what of the driver's ride the cell's unloading lost was not
traced; an actor that comes back onto the stage with a vehicle in its game state is not put back
on it). Fixed in the streaming (the cells
load round the player, as the engine's grid: [qa.md](qa.md)); the carts now also follow
SetMotionType and are carried by a horse that jumps (Vehicles, above), and a corpse a script
enables is pushed out of a cart it lies against without being thrown ([physics.md](physics.md)).
Measured with the QA runner, the opening unattended (900 s): stage 35 at 240 s, 50 at 285 s and
160 at 527 s (run1 on 7de82cc: 233, 278 and 527; on b9b337e it stood at stage 42 or 26); its
anomalies 69 (b9b337e: 771 in 520 s, 971 in 905 s), of them on the carts 2, a bounce of a second
as the ride starts (b9b337e 309; run1 15), and none on the dead horse by the second cart (75 when
it was thrown).

Whiterun's market by day (10:00, seven minutes): ADIA's random scenes (Nazeem and Ysolda,
Carlotta and Ysolda, Anoriath and Ysolda) and WhiterunMarketplaceScene2/3 play through, their
actors brought together, every line said, no deviation. Alduin (MQ101AlduinAttackScene1) ran his
approach patrol rather than MQ101AlduinPerch1 for a while (Must Complete held it past the
scene's package action) and ended his tower shout packages 1,200 to 1,900 units from the perch
(the end of Perch1 took him off it): both fixed with the flight ([Flying](#flying), Packages);
a flier in the air (the trace's FLYING) is not taken to walk off while a done package holds it.
Left in MQ101's run: Haming takes 20-30 seconds of failed approaches before he sits cross-legged at
the start (his enter's start point next to the furniture's own); the cart driver's
MQ101Guard1ToMarker5 is done at once as its Variable01 (set by the cart's ExitCartEnd) is not
yet 1, as the engine's rule has it.

## Talking

What actors say outside the dialogue menu (`src/ai/talk.ts` for who talks when,
`src/shell/actor-talk.ts` on the stage, `src/shell/world-lines.ts` for how a line is said; the
lines: the dialogue engine's `subtypeLine` and `topicLineTo`). What the engine keeps for it is
CommonLibSSE's HighProcessData (greetingTimer, exclusiveTimer, idleTimer, checkToTalkTimer,
lastSpokenToArray); the conversations between actors follow the engine's own rule, observed in
it ([below](#conversations-between-actors)); for greetings and chatter the rules
follow the game settings' names (TODO(M13) where they are ours). The running package's PKDT interrupt flags
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
- **Conversations between actors** are scenes the story manager gives two actors that ask for
  one: see [below](#conversations-between-actors). The engine has no conversation of its own
  made of Hello and Idle lines.
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
  ShootBow, and PlayerinIronSights as a drawn bow is aimed: its graph's bowDrawn), knocking
  things over and standing on furniture TODO(M13) (the physics does not tell who knocked an
  object).
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

### Conversations between actors

Observed in the original (the behaviour, in our words; `src/ai/talk.ts` holds the rules,
`src/shell/actor-talk.ts` carries them out on the stage, `src/ai/scene-runtime.ts` plays the
scenes). Two actors talking with each other is always a scene of a quest: an actor asks the
story manager for a scene with another (the Actor Dialogue event, ADIA), and what its tree
answers plays. The vanilla tree holds 900 quests under it (with the Creation Club plugins'
nodes 919 entries: town and household scenes, inns, Civil War soldiers, the MQ201 party,
Sovngarde, dogs), all with a scene of two (869) or three actors.

- **Who asks, and when.** Each actor of the high process keeps a social timer, drawn between
  fAISocialTimerForConversationsMin and Max (vanilla 10 to 30 s; the engine's own defaults are
  5 and 30), which counts down while the actor is in no scene. Once it has run out, the actor
  looks for a partner on every update until it finds one, if: its package allows random
  conversations (PKDT 0x2), it speaks (has a voice), is not asleep, not fighting, not talking
  with the player, in no scene and in no other ask, and is within fDistancetoPlayerforConversations
  (3000) of the player, who is not in a conversation. There is no chance roll:
  fAISocialchanceForConversation (and its Interior twin) is read by the engine's spectator
  comments, not here.
- **Whom.** It goes through the high process's actors in their order and takes the first that
  may be asked: not itself or the player, speaking, free, standing or seated (not asleep, not in
  other furniture), its package allowing random conversations, in no scene and no other ask,
  within fDistancetoPlayerforConversations of the player, within
  fAISocialRadiusToTriggerConversation (vanilla 500; the engine's default 900; in an interior
  the Interior value, 500) of the one asking, in an interior on its floor (less than 90 units
  higher or lower), and not on the asking actor's list of those it talked with. Both are put on
  each other's list; the list is cleared every fAItalktosameNPCtimer (120 s) the actor spends
  looking.
- **The event.** Its data are the asking actor's current location (L1), the asking actor (R1)
  and the one asked (R2); the started quest's OnStoryDialogue gets the three. Both are taken
  (the engine's "in random scene" flag) until the story manager answers.
- **The answer.** With a quest, both draw their social timers again and stay taken while the
  quest runs. Without one nothing else happens (there is no conversation of the engine's own):
  both are free again, and only the first of the two in the process list draws its timer again,
  so the other may look again at once.
- **Random scenes.** A scene of a quest the Actor Dialogue event started is a random scene. One
  random scene plays at a time; as one begins, the pause before the next is drawn
  (fRandomSceneAgainMinTime to MaxTime: vanilla 10 to 30 s, the engine's default 5 to 10), and it
  counts only while no random scene plays; the engine clears it as a random scene ends, so it
  holds back only starts that come while one is about to begin. If an actor of it plays in
  another scene, it waits and looks again a second later. As it begins, the engine looks again
  whether its first two actors may talk (the second as the asking one, the first as the one
  asked); if not, the scene does not play (its quest stops with Stop Quest on End).
- **Coming together.** The one that asked (else the second actor) starts a conversation with the
  other: both stop their packages and the scene holds while the one that started walks up to
  within iAISocialDistanceToTriggerEvent (vanilla 200; the engine's default 90; seated, 20 more)
  of the other, or, with both seated or asleep, they talk from up to
  iAIMaxSocialDistanceToTriggerEvent (500) apart. They turn to each other (a scene's line waits
  until its speaker faces whom it speaks to within fAIMinAngleRangeToStartSceneDialogue, 20
  degrees; we hold the scene for that, at most 2 s: TODO(M13) the engine's patience), and the
  scene goes on: its phases and lines as any scene's. They stand facing each other while it
  plays (the engine's in-game dialogue package); an actor the scene gives a package to follows
  that. TODO(M13): whether the engine gets a seated actor up (we have the other one come) and
  what fAIWalkAwayTimerForConversation (2 s, set as a random scene begins) does.
- **DialogueActivate** with another actor as its target raises the same event (it as R1, its
  target as R2) and waits fAISocialTimerToWaitForEvent (20 s) for a scene to take it: none, the
  procedure fails. In the scene it walks up to within fAIDialogueDistance (170) of its target,
  both face each other, and the procedure succeeds as the scene ends.
- **The log** names each ask and its answer ("YsoldaREF asking for random scene with NazeemREF",
  "got a quest back: DialogueWhiterunNazeemYsoldaScene1" or "failed to get a quest"), the coming
  together and when the two face each other.
- **What answers where.** Most quests' aliases name who may play them (R1 and R2 by GetIsID, a
  faction, a voice type), and an alias another quest reserves keeps an actor out unless the alias
  allows reserved ones: at the start of the main quest MQReserved holds Riverwood's family, so
  their household scenes wait for it. `node tools/story-manager.ts ADIA` shows the tree;
  `node tools/story-manager.ts ADIA --at WhiterunLocation` walks it for every pair of a
  location's actors after a new game (nothing started) and lists the quests each pair reaches;
  `node tools/talk-info.ts YsoldaREF NazeemREF` asks for real and names the quest and its scenes.
- **Measured in the browser** (main-menu `coc`, 2026-10-23): in Whiterun's Plains District at
  9:00, 50 asks in 8 minutes gave five market scenes (Nazeem and Ysolda, Anoriath and Ysolda,
  Carlotta and Nazeem, Fralia and Ysolda, Olfina and Ysolda), each with the asking one walking
  from 250 to 500 units up to 200, both facing each other (0 degrees off) and every line said;
  in Riverwood the dog's scene (Stump and Frodnar) played, the family's waited for MQReserved.

## Combat

What actors and the player do in a fight (`src/gameplay/combat/`, `src/shell/actor-combat.ts`;
the plan: [m10-plan.md](m10-plan.md) 5.1; the records: `node tools/weapon-info.ts <filter>`).
Who fights whom, and how, is the combat AI's ([Combat AI](#combat-ai)); its packages wait
meanwhile.

- **Actions** go through the idle tree as the engine's do: ActionDraw, ActionSheath,
  ActionRightAttack, ActionLeftAttack, ActionRightPowerAttack, ActionLeftPowerAttack,
  ActionDualAttack, ActionDualPowerAttack, ActionRightRelease, ActionLeftRelease,
  ActionStaggerStart, ActionRecoil(Large), ActionBlockHit, ActionBleedoutStart / Stop: the idle
  the engine's search of the tree gives ([esm.md](formats/esm.md#idles-and-actions); its
  conditions run on the actor, the attack's target their Target: an NPC's combat target, the
  player's the actor they aim at, [gameplay.md](gameplay.md#killmoves)) sends its event to the
  actor's graphs (the player's first-person graph too). A sheathed weapon is drawn by the attack's own tree (DrawWeapon: WeapEquip). The engine
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
  GetPairedAnimation, GetMovementDirection, GetLastHitCritical, IsInCombat, GetCombatState,
  IsPC1stPerson and the conditions run on the combat target read it, as do the natives
  IsWeaponDrawn, DrawWeapon, SheatheWeapon, IsBleedingOut, IsInKillMove, IsInCombat,
  GetCombatState and GetCombatTarget. ShouldAttackKill, IsLastHostileActor and GetTargetHeight
  are the killmoves' ([gameplay.md](gameplay.md#killmoves)): valued when asked, on the
  condition's target. A fighter's work that awaits the scripts (the bleedout's regain) runs
  one at a time: started every frame, long frames started more of it than finished and the
  backlog of perk conditions froze a fight for seconds.
- **Weapons on the body** (`src/shell/actor-weapons.ts`): the right hand's weapon model hangs on
  its sheath node (the equip system's: the models' "Prn", WeaponSword, WeaponDagger,
  WeaponAxe, WeaponMace, WeaponBack, WeaponBow) and goes to WEAPON at weaponDraw, back at
  weaponSheathe; its scabbard ("Scb") stays at the sheath; a left-hand weapon is shown drawn
  only, in SHIELD (vanilla's skeleton has no left sheaths); the ammunition hangs in QUIVER (its
  single "Arrow:0" left out) and an arrow is on the bow from arrowAttach to its release. The bow
  animations move the Weapon bone into the left hand (Bow_DrawLight: 19 units beyond it). A bow's
  or crossbow's own graph draws its string with its wielder's graph events
  ([animation.md](animation.md#held-weapons)); a blade that drew blood shows it
  ([rendering.md](rendering.md#weapon-blood)). The weapon's sounds: NAM9 at weaponDraw, NAM8 at weaponSheathe, TNAM at weaponSwing (every vanilla
  melee weapon's swing, WPNSwingBladeMediumSD; xEdit names it the attack fail sound), SNAM at
  a shot. While a bow is drawn its wielder's arms aim where the shot goes (the graphs'
  BSDirectAtModifiers of bows, userInfo 2: the player's view, an NPC's target's chest; as an
  aimed spell's: [Magic in combat](#magic-in-combat)).
- **Torches** (the equip system's torch: a LIGH that can be carried, in the left hand): its
  model (LIGH MODL) is held on SHIELD whether the weapons are drawn or not (an instance of its
  own placed there every frame, so its fire's particles follow it), the graphs get
  iLeftHandType 11 and the event torchEquip (0_master's MT_LeftHandOverride takes it to
  MT_Torch_State: the arm holds it up; torchUnequip as it goes, ShdEquip and WeapSoloEquip for
  a shield likewise; TODO(M13): when the engine sends them) and its light (the LIGH's radius, colour,
  flicker) shines from the model's AttachLight node, lighting the world and its bearer for
  detection ([Detection](#detection), the light on the target). `ActorCombat.lights`.
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
  (Novice 2 / 0.5 .. Legendary 0.25 / 3; [GamePlay] iDifficulty). The perks' entry points
  (weapon, power attack and bash damage, critical chance and damage, sneak, block, deflected
  arrows, armour piercing, incoming damage, stagger, Sweep, the spells a hit applies) are asked
  each hit (docs/gameplay.md, "Perks").
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
  The Stagger effect (MGEF archetype 33: Unrelenting Force's 0.75, 1.25, 1.5; the Incinerate
  and Ice Spike perks' push 0.25; the giants' and atronachs' area slams) staggers by its
  magnitude weighed so against the target's mass, from its caster's side.
- **Knock-downs** (`src/shell/actor-knockdowns.ts`, `actor-bodies.ts`, the player's:
  `player-knockdown.ts`): Actor.PushActorAway and KnockAreaEffect (Unrelenting Force's third
  word is its effect's VoicePushEffectScript: PushActorAway with PushForce 15), a trap's
  ProcessTrapHit push, an explosion with Knock Down Always (EXPL DATA 0x4; By Formula 0x8:
  those below fKnockdownCurrentHealthThreshold of their health, TODO(M13)), an attack whose
  attack data has a knockdown (ATKD @32: the beast forms' sprinting swipes, read as a chance),
  paralysis (it lies until the effect ends; TODO(M13): the game's paralysed fall stiff). The
  idle tree's ActionKnockdown says how: the humans', bears', giants' and others' knock-down
  idles send Ragdoll (or RagdollInstant), mammoths', atronachs' and wisps' stagger; a race
  with No Knockdowns (RACE DATA 0x400000: dragons, mammoths, Dwarven automatons) and a graph
  without either stagger at full strength (UESP "Unrelenting Force"). Knocked down, its graph
  goes to FullyRagdoll (i1stPerson 0: the engine's third-person graphs), its controller goes,
  its bodies are let go from the pose it had and flung at the force as a speed (m/s, every body
  alike: TODO(M13) PushActorAway's unit; so read, Fus Ro Dah throws a bandit about 20 m), its
  pose follows them; it does not act (GetKnockStateEnum 7 down, 6 getting up). Its ragdoll at
  rest (30 units a second for 0.5 s after a second, at most 8 s: TODO(M13)), the engine gets
  it up: the ragdoll's pose (as bone transforms, in a frame on the ground under its COM) goes
  to its graph, iGetUpType 1, GetUpBegin; its pose matcher (hkbPoseMatchingGenerator) picks
  the get-up clip whose first pose lies as the ragdoll does (GetUpFromFront, GetUpFromBack:
  by the COM, neck and left upper arm, turned about the up axis to fit:
  `src/animation/pose-matching.ts`); at the timer's GetUpStart it stands where the match puts
  it, its bodies follow its pose again and hkbGetUpModifier blends from the ragdoll's pose into
  the clip over its second; at the clip's GetUpEnd it has its controller back. Pushed again as
  it rises it falls again; hits on one lying push its ragdoll (fDeathForce\* by the damage).
  The player knocked down lies so too: their keys do nothing (PlaySession.knocked), the
  bleedout camera looks at the body as at their death, and they stand where their body got up.
- **Disarm** (MGEF archetype 9: the Disarm shout's 12, 20, 30, Disarming Bash's 99, read as
  the highest level it disarms: UESP "Skyrim:Disarm"): the right hand's weapon leaves the
  actor's items and falls from its hand (the WEAPON node) as a new reference of it in the
  world, which anyone may pick up; a dual wielder's left goes into its inventory; bound
  weapons stay. A fighter left with its fists after holding a weapon runs to a weapon lying
  within 1024 units and picks it up (TODO(M13): the engine's reach).
- **Telekinesis** and **Grab Actor**: the player's Telekinesis is the grab spring's
  (docs/gameplay.md, "Magic effects"). Grab Actor (the Vampire Lord's Vampiric Grip, MGEF
  archetype 45) knocks its target down (its graph's Ragdoll) and holds its ragdoll's root
  before its caster, at its chest fMagicGrabActorMinDistance ahead (120, Dawnguard.esm; observed
  in the original: the hold's distance; pulled there at 8 × the way a second, at most
  600 units a second: TODO(M13) the engine holds it before the player's camera), while the
  effect lasts; let go, it is flung away from its caster with fMagicGrabActorThrowForce (15),
  falls and gets up.
- **Power attacks**: the player's attack button held [Controls] fInitialPowerAttackDelay (0.3 s)
  is a power attack (both buttons: the dual ones); without stamina it is a plain one (the HUD's
  meter blinks). Power attacks and bashes cost the skill progression's powerAttackCost and
  bashCost.
- **Bows** (`projectile.ts`, `src/shell/combat-projectiles.ts`): the bow draws while the button is
  held and looses at arrowRelease; the shot's damage is the equip system's (bow and arrow) × the
  draw (UESP "Archery": 35% before the draw, then linear from 50% to full). The arrow flies at
  its PROJ's speed (iron arrows 3600) × the draw from the WEAPON node, under 9.8 m/s² × its
  gravity (0.35), against what L_PROJECTILE meets (actors' bodies; the player's shape), until
  its range. Where it goes (the player's view tilted up and the aim assistance; an NPC's led aim
  at its target's upper body on the arrow's arc, astray by fBowNPCSpreadAngle as far as its
  Archery lacks): docs/gameplay.md, "Aiming projectiles". An actor hit takes the shot;
  hitting the world the arrow sticks fCombatMissileStickDepth deep, a reference of its
  ammunition to pick up (kept still), at most 15 of them. In first person only the first-person
  graph's arrowRelease looses the arrow (the body's, often raised first, is not counted).
  TODO(M13): how much slower a partly drawn arrow flies.
- **Impacts** (`src/shell/combat-impacts.ts`): the weapon's impact data set (INAM; bashes and
  blocks BIDS; fists the race's NAM5; arrows the bow's) against the target's flesh (its race's
  NAM4: MaterialSkin, MaterialBoneActor, ...) gives the impact: its sound (heavy for power
  attacks) and its decal (DODT and the texture set DNAM: blood) on the floor or wall behind.
  TODO(M13): its effect model (the spray's particles).
- **Health**: a hit takes health (DamageActorValue with its attacker), tells the target's
  scripts (OnHit: aggressor, weapon, projectile, power, sneak, bash, blocked), uses the
  attacker's weapon skill by the weapon's base damage (Sneak by fSneakAttackSkillUsageMelee for
  a sneak attack), and shows the target on the HUD's enemy bar (its name and health) for the
  player's hits (how long: docs/ui.md, "The HUD"). Health run out kills (the ragdoll pushed by fDeathForce{Ranged}Min..Max by the
  damage; its death cry, its Death line, unless the kill was KillSilent's, which reports no
  murder either); an essential actor, and a protected one unless the player themselves dealt
  the blow (a follower's, a summon's or another actor's leaves it down: UESP "Protected
  NPCs"), bleeds out
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
- **Killmoves**: an attack whose idle is a paired one ("pa_<name>" for the attacker, "<name>"
  for the target) plays only if the target's graph takes its side; the target goes to its mark
  in the paired clip and dies at its KillActor or KillMoveEnd; the player's play in the kill
  camera, with its slow motion. When they happen: [gameplay.md](gameplay.md#killmoves); how
  they play, end and are shown: [animation.md](animation.md#killmoves).
- **Combat music**: while anyone fights the player the default battle music (DOBJ BTMS) plays,
  ending with its finale as the fight does.

## Combat detection

What a fight knows of its targets, and when it may strike again: observed in the original
(the combat group's per-target update, its stealth point and target timers, the actor's
detection and its lines of sight, the melee attack choice), implemented in
`src/ai/combat-groups.ts` and `src/shell/actor-combat-ai.ts`; `src/ai/combat-groups.test.ts`
runs the rules.

- **The group's targets.** A combat group keeps, for each of its targets, the group's
  detection level of it (the highest of its members' last ones: a member's lower level does
  not lower another's until that member tests again), its stealth points, whether it is
  _known_ (detected and followed) or _lost_, and when and where it was last detected, last
  known, lost, attacked from and heard. A target joins the group with fCombatStealthPointMax − 1
  (99) points and no level (−1000). Each detection test a member makes of it (every 1–2 s,
  [Detection](#detection)) and each event of it the member notices (level 0 at the place)
  updates it; members out of the high process detect the targets within
  fCombatDetectionLowDetectionDistance (4096) fully (level 100) every second.
- **Detected:** a level above 0 detects the target, but while it has stealth points only above
  iCombatStealthPointDetectionThreshold (25; iCombatStealthPointSneakDetectionThreshold, 70,
  for a sneaking target); then its points are gone. Detected, it is known: the group follows it
  (its true place) for fCombatDetectionNoticedTimeLimit (10 s) while it stays within
  fCombatDetectionNoticedDistanceLimit (768) of where it was detected. Sensed below the
  threshold, its place is known but it is lost (the group searches while its points drain).
- **Stealth points** (every 0.1 s): while the group's level is 0 or more and the target has
  points, they drain by level × fCombatStealthPointDrainMult (3 in Skyrim.esm) a second (at
  level 0 they stay above 0); so a target at level 10 is detected after 3.3 s. Once lost and
  below the most, they come back by max(fCombatStealthPointRegenMin (5), −level ×
  fCombatStealthPointRegenMult (0.2)) a second, but only fCombatStealthPointRegenLostWaitTime
  (10 s; AlertWaitTime, 10 s, if it was never detected) after it was last known or lost,
  fCombatStealthPointRegenAttackedWaitTime (15 s) after it last attacked a member and
  RegenDetectedEventWaitTime (10 s) after it was last heard. An attack caps them at
  fCombatStealthPointAttackedMaxValue (50) and marks the attacker's place; a noise (an event
  more than 64 units from the last, a second after it) at DetectedEventMaxValue (75).
- **Lost and found:** a target not known of for fCombatDetectionLostTimeLimit (10 s) is lost;
  so is one a member has a line of sight to and does not detect (no longer followed, or
  invisible), and one whose last known place a member stands within
  fCombatDetectionLostCheckNoticedDistance (256) of and sees. Detected again, it is found.
- **Searching:** a group searches once all its targets are lost and a member fights one of
  them, unless all its members flee; it stops as soon as one is found (or all flee). Its
  members then search (CombatToLost; GetCombatState 2) where the group last knew the target to
  be (seen, else where it attacked from or was heard), and fight again when the group finds it
  (LostToCombat). While a target is known the members go for where it is; known no longer but
  not lost, for where the group last knew it.
- **Giving a target up** (every second): one dead or gone; one whose stealth points are full
  again while the group searches; one lost for fCombatDetectionLostRemoveTime (30 s) that no
  member fights; one lost for fCombatDetectionLostRemoveDistanceTime (60 s) with no member
  within fCombatDetectionLostRemoveDistance (4096) of it; one lost for
  fCombatDetectionFleeingLostRemoveTime (30 s) while all members flee. Its members forget it;
  a member left with no target ends its combat (LostToNormal after a search). So a player who
  breaks contact (out of sight, out of reach, sneaking) is lost 10 s after the group last knew
  them, the search's points come back from 10 s after that, and the fight ends some 20 s
  later; found during it, the fight goes on. Measured at Embershard Mine (two bandits, the
  player gone out of reach and sneaking): followed 10 s, lost at 23 s, points back from 33 s,
  given up and back to their packages at 52 s.
- **The attack loop** (observed in the original): a fighter chooses no new melee attack
  while it is still in its last one, but no longer than fCombatAttackAnimationDrivenDelayTime
  (1.5 s) after it chose that one; in the last one's chain window (nextAttack, followThrough)
  the next one follows. The attack's time is noted as the graph takes it. An attack (a swing,
  a bow's draw, a bash) its graph refuses (`BehaviorRuntime.answered`: no state the graph is in
  answers the event then, or the transition under way may not be interrupted: the last swing
  still blending out) ends at the next frame, and the fighter asks again at its next decision,
  the combat tree's attack idle (0.25 s); before this it waited 1.5 s in its wind-up for an
  answer, so archers loosed with gaps. An event its graph refuses 8 times and never took is not
  chosen again (a creature's). A draw or sheathe its graph refuses goes back, and one that never
  reaches its end (4 s without the graph's weaponDraw or weaponSheathe) leaves the weapon away,
  so that the fighter draws again: a guard waited for good with its bow "sheathing".
- **Arrows:** an NPC never runs out of arrows while it carries one (UESP "Skyrim:Arrows"); only
  the player's quiver empties. Before this, bandit archers turned to their fists after their
  quiver's dozen shots.
- **Yield:** one that attacked the player by its aggro radius (it warned them off: wolves,
  bears) does not accept their yield, as one that attacks them on sight; before this, a wolf
  facing a player with their weapon away entered and left combat every quarter second.
- **AI disabled** (EnableAI false, observed in the original: it clears the actor's
  process flag and stills its controller): the actor's AI does nothing (`ActorMovers.runsAi`):
  no packages, no combat decisions or acts (it neither draws nor equips), no detection of its
  own (it is still seen), no reactions or talk, no flight steering, no follower catch-up, no
  travel (its way and its movement wish dropped); its graph animates on. Vanilla uses it on
  mannequins, statues, the Falmer's ice poses, monks' scenes and summoned staffs.
- **Measured** (headless Chrome, god mode, `?devdata`): Embershard Mine, two bandits by the
  player 140–300 units away in torchlight: detected at levels 18–29 (they searched 1–2 s while
  their points drained, then fought), kept the player 63 s with no loss, melee attacks every
  2.2 s (one in reach) and every 9.9 s (one its style kept circling out of reach); Riverwood,
  a bandit archer: 25 shots in 58 s, 2.4 s apart (most 4.3), 0.5 s (most 1.8) between one
  shot's end and the next draw, no refusal; Whiterun's road, three bandits against three
  guards and a townsman: the guards' first fight 16 and 33 attacks in 50 s (before: 1 and 7,
  their bows stuck), all bandits dead in 55 s, every fighter keeping its target throughout; two
  wolves against the guards: dead in 35 s; a wolf against the player alone: kept them (no
  flip-flop); a dragon against the guards: kept 90 s by all; every fight ended once its last
  enemy died or was given up.

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
  left; a dual cast its DualMagic_ one), with the hand's bWantCastRight / bWantCastLeft set
  and BeginCastRight / BeginCastLeft before it (the graph's CastingState: docs/animation.md,
  "Casting"); a staff's or a scroll's, or where the tree plays none, the event it
  would pick is sent. Magic is drawn as weapons are ("Combat": ActionDraw plays Magic_Equip,
  whose clip raises weaponDraw and Magic_Equip_Out; put away Magic_Unequip_Out), and with it
  drawn the player's attack buttons whose hands hold a spell, staff or scroll cast
  (`PlayerCombat` hands them to `PlayerCasting`: CastingButtons); IsWeaponMagicOut is any drawn
  state, IsWeaponOut not when the hands hold only magic. An NPC's castAt draws first. While an
  aimed cast lasts its arms aim (the graphs' BSDirectAtModifiers of bows and spells:
  `setDirectAtTarget(2, point)` along the aim). Ready: ActionRightReady
  (MRh_SpellReady_Event); a concentration spell charged: ActionRightRelease (its loop, whose
  MRh_SpellFire_Event starts the sprays); released ready: ActionRightRelease
  (MRh_SpellRelease_Event), the spell leaving as the release clip raises MRh_SpellFire_Event;
  stopped or let go early: ActionRightInterrupt (MRh_Equipped_Event). A dual cast goes on with
  the left hand's actions. Shouts:
  ActionVoice (shoutStart), ActionVoiceRelease as the words go (the Whirlwind Sprint variants by
  GetCurrentShoutVariation), ActionVoiceInterrupt. A ward hit: ActionWardHit (wardAbsorb,
  WardBreak by IsWardState).
- **Sounds and art:** the costliest effect's sounds (MGEF SNDD) from the hand's magic node (NPC R
  / L MagicNode): charge as it charges, ready once it is, the concentration loop while a
  concentration spell is held, release as it fires (a shout's thu'um); its casting art (MGEF
  casting art, ARTO, running its own CastingBasic graph on the actor's events) on the magic node
  while the cast lasts (the player's while their magic is drawn: the hands' idle effects; in
  first person on the first-person arms' nodes), a dual cast's own art (MGEF
  dual cast art) at its dual cast scale (`src/shell/actor-casting.ts`), its light there (the
  MGEF's casting light). On the target the effect's hit shader (EFSH) and hit art (ARTO) as it
  takes hold (`src/shell/actor-effects.ts`; docs/gameplay.md, "Magic effects").
- **Projectiles** (the costliest effect's PROJ; docs/formats/esm.md, "Projectiles and
  explosions"): from the source's node (the voice: the head) along the aim — the player's at
  the point under the crosshair (what the camera's ray meets, else 8192 units along it), an
  NPC's target's chest, else its facing. Missiles, lobbers and arrow-like bolts fly
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
  attacker (detection's `attackedBy`) and turns on it as on a blow (the combat AI's hit: a
  held spell's sprays count once a second). A Target Location spell
  makes its summons and hazards where it landed. The explosion bursts (its sounds, `explode`:
  its enchantment, damage and force within its radius), the area reaches those near (`area`),
  the effect's impact data set sounds on the surface hit; both are noises for detection by their
  sound levels. On an actor not hostile to its caster a hostile spell's hit is an assault
  (crime's `assault`, the one hit among the witnesses), as a blow's is. What shows
  (`src/shell/magic-fx.ts`): a projectile carries its light (PROJ light); with Muzzle Flash its
  muzzle flash model and light where it leaves, for its muzzle flash duration; a beam from the
  hand, a cone's wave sweeping out at its speed to its range; an explosion's model and light and
  its image-space modifier on the player within its radius; an impact's decal, model and hazard
  (the effect's and the explosion's impact data sets). TODO(M13): a beam is shown at its own
  model's length (the engine stretches it to the hit).
- **Noise and comments:** a cast or a shout is an action noise as loud as its effect's casting
  sound level (detection's `action`); the player's are commented on (PlayerCastProjectileSpell,
  PlayerCastSelfSpell, PlayerShout).
- **The AI's API** (5.2's combat AI calls it): `castAt(actor, hand, target, {spell, purpose})`
  casts from a hand ('both': dual cast) the given spell (equipped first), what the hand holds,
  or the spell the casting engine chooses for the purpose (`chooseSpell`: attack, heal, summon,
  ward, buff: of its spells and what its hands hold, those it has the magicka for whose AI
  delay has passed, the one worth most against the target: `spellWorth`, "Combat AI");
  `healSelf(actor)` (a concentration heal held until whole), `summon(actor, target?)`,
  `drinkPotion(actor, value)` (the carried potion restoring the value most);
  `shoutAt(actor, target, words?)` (Greybeards, draugr; dragons' breath: [Flying
  combat](#flying)): the voice's shout, its
  words let out after their hold time. NPCs release a fire and forget spell once ready and hold
  a concentration spell while their AI keeps it (`castAt`'s hold: the combat AI while its
  target is alive, within the spell's range and before it; UseMagic its cast time), at most
  8 s (TODO(M13)); without a say of the AI's, 2.5 s. An actor that dies or leaves the stage stops casting.
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
fCombatDialogue\*); the others keep the engine's built-in defaults (see below). The combat
style's values count on the engine's scale of its settings ([Style values](#style-values));
where the rule that uses one is not known yet, it is marked TODO(M13).

### The engine's built-in game settings

The engine defines about 3,500 game settings with built-in defaults; a plugin's GMST record only
overrides one. Skyrim.esm overrides a part of them, so for the rest the engine's own default
counts (`readCombatAiSettings` and the other settings tables keep it as their fallback). The
defaults are the original game's own, described by behaviour only. Some that matter here:

| Setting                                 | Default           | Meaning                                              |
| --------------------------------------- | ----------------- | ---------------------------------------------------- |
| iFriendHitNonCombatAllowed              | 0                 | a friend turns on the player at their first blow     |
| iFriendHitCombatAllowed                 | 3 (Skyrim.esm: 4) | blows a friend lets pass in combat                   |
| iAllyHitNonCombatAllowed                | 3                 | blows an ally lets pass out of combat                |
| iAllyHitCombatAllowed                   | 1000              | 1000 or more: an ally lets any number pass in combat |
| fCombatYieldTime, fCombatYieldRetryTime | 10, 600           | read where the player yields to those fighting them  |
| fCombatInventoryMinEquipTime\*          | 5, 3, 3, 5, 0     | weapon, magic, shout, staff, fists: kept at least    |
| fCombatRestoreHealthPercentMin / Max    | 0, 0.5            | it restores health below this (defensive mult 0, 1)  |
| fCombatRestoreMagickaPercentMin / Max   | 0.25, 0.4         | it restores magicka below this (defensive mult 0, 1) |
| iCrimeAlarmRecDistance                  | 4000              | an alarm reaches the actors this near                |
| fEvaluatePackageTimer                   | 15                | between an actor's package evaluations               |

The friendly-hit allowance depends on the reaction (FACT XNAM): a friend uses the iFriendHit
pair, an ally the iAllyHit pair; more blows than allowed turn it on the attacker, an allowance of
1000 or more never does.

Some settings the plugins define are never read by the engine: fCombatInventoryUpdateTimer (it
weighs its equipment continuously, keeping what it took up for its kind's
fCombatInventoryMinEquipTime), iAICombatRestoreHealthPercentage, iAICombatRestoreMagickaPercentage
and fCombatItemRestoreTimer (it restores by its style, below: Style values),
fCombatAvoidThreatsChance (the style's avoid threat chance counts), fCombatSpeakAttackChance and
fCombatSpeakTauntChance, fCombatTeammateFollowRadiusBase and Min, fCombatThreatExtrudeTime,
fEnemyHealthBarTimer (the enemy bar is [Interface] iEnemyHealthDisplayTime's: 2 s after the
enemy's health last changed). Our code does not use them.

### The attack decision

The engine's combat AI is a behaviour tree built in code, with named nodes (Combat Parallel,
Melee Sequence, Attack Selector, Attack Idle, Flee Selector, Block Selector, ...). In melee an
"Attack Idle" waits 0.25 s, then a random roll against the attack chance starts an attack
(`ATTACK_DECISION_SECONDS`, `attackChance` in `src/ai/combat-tactics.ts`). The chance:

- the combat style's offensive mult, mapped linearly onto fCombatAttackChanceMin (0.05, at 0) ..
  fCombatAttackChanceMax (1, at 1): even an offensive mult of 0 attacks now and then;
- against the player while others attack them too, the offensive mult × the group offensive
  mult once per other attacker, not below fCombatGroupOffensiveMultMin (0.1);
- against a staggered or recoiling target × the larger of the style's attack and power attack
  staggered mults;
- else while it blocks: × fCombatAttackChanceBlockingSwingMult (0: no attack) as the target
  swings, otherwise × the defensive mult mapped onto fCombatAttackChanceBlockingMultMax (0.67,
  at 0) .. Min (0.2, at 1);
- after its first attack × 1, rising to fCombatAttackChanceLastAttackBonus (1.5) as
  fCombatAttackChanceLastAttackBonusTime (5 s) passes since the last one.

So a civilian with a low offensive mult still attacks about every second while it fights. Shots
and casts are decided the same way, each 0.25 s (the tree's Ranged Attack Idle and Cast
Immediate / Concentration Spell Idles) by their own chances (Style values); a shout is tried
each second while its voice has recovered.

### Style values

Observed in the original: the engine never uses a combat style's (CSTY) value as a chance
or a distance directly. Each is placed on a scale of two (or three) game settings: a chance,
distance or time is `Min + v × (Max − Min)` for the style's value `v`; the advance radii, the
optimal range and the block time are a three-point curve (`curve` in
`src/ai/combat-tactics.ts`: `Min` at −1, `Mid` at 0, `Max` at 1, linear between, unclamped).
"Offensive" is the offensive mult as the attack decision weighs it (× the group offensive mult
against a crowded player, `offensiveMult`). With the engine's defaults (no plugin sets these but
the outer advance radii and fCombatAdvanceInnerRadiusMax):

| Value (function)                         | Style value            | Settings (Min .. Max)  | Range                    |
| ---------------------------------------- | ---------------------- | ---------------------- | ------------------------ |
| attack (`attackChance`)                  | offensive              | fCombatAttackChance\*  | 0.05 .. 1                |
| ranged attack (`rangedAttackChance`)     | offensive              | …RangedAttackChance\*  | 0.05 .. 1                |
| immediate spell (`castChance`)           | offensive              | …CastImmediate…\*      | 0.05 .. 0.75             |
| concentration spell (`castChance`)       | offensive              | …CastConcentration…\*  | 0.25 .. 1                |
| offensive bash (`offensiveBashChance`)   | offensive × bash mults | …OffensiveBash…\*      | 0 .. 0.05                |
| bash from a block (`bashChance`)         | defensive × bash mults | fCombatBashChance\*    | 0.025 .. 0.2             |
| block (`blockChance`)                    | defensive              | fCombatBlockChance\*   | 0 .. 1                   |
| block attack (`blockAttackChance`)       | defensive              | …BlockAttackChance\*   | 0 .. 1                   |
| restore health, magicka (`restoreShare`) | defensive              | …RestoreHealth/…\*     | 0 .. 0.5, 0.25 .. 0.4    |
| dodge (`dodgeChance`)                    | CSGD avoid threat      | fCombatDodgeChance\*   | 0 .. 1                   |
| special attack (`specialAttackChance`)   | CSME special attack    | …SpecialAttack…\*      | 0 .. 1                   |
| circle (`circleChance`)                  | CSCR circle            | fCombatCircleChance\*  | 0 .. 0.75                |
| circle distant (`circleDistantChance`)   | CSCR circle            | …CircleDistant…\*      | 0.25 .. 0.75             |
| fall back (`fallbackChance`)             | CSCR fallback          | …FallbackChance\*      | 0 .. 0.5                 |
| flank distance (`flankDistance`, units)  | CSCR flank distance    | …FlankingDistance\*    | 0 .. 1024                |
| stalk time (`stalkTime`, seconds)        | CSCR stalk time        | …FlankingStalkTime\*   | 0.01 .. 10               |
| strafe (`strafeChance`)                  | CSLR strafe            | fCombatStrafeChance\*  | 0 .. 0.75                |
| block time (`blockTime`, curve, s)       | defensive × 2 − 1      | fCombatBlockTime\*     | 4, 8, 10000              |
| advance radii (`advanceRadii`, curves)   | defensive − offensive  | …AdvanceInner/Outer…   | 0, 0, 256; 128, 256, 512 |
| optimal range (`maxOptimalRange`, curve) | defensive − offensive  | …MaximumOptimalRange\* | 1024, 1280, 1536         |

More of the same scale: the bash mults (`bashChance`) are the style's bash mult × its bash recoil
mult as the target recoils, else × its bash power attack mult as it power attacks, × its bash
attack mult as it swings, × fCombatBashTargetBlockingMult (0) as it blocks. A shot's chance gains
up to fCombatRangedAttackChanceLastAttackBonus (half of itself) over
fCombatRangedAttackChanceLastAttackBonusTime (10 s) after the last attack. A bow is held drawn at
random from fCombatRangedAttackHoldTimeAbsoluteMin (0.1 s) up to offensive on
fCombatRangedAttackHoldTimeMax .. Min (1.5 .. 0.25 s), the shortest with the target within
fCombatRangedAttackHoldTimeMinDistance (256) past the two radii. Against a staggered target the
defensive mult counts × fCombatAdvanceRadiusStaggerMult (0) for the radii; a defensive style
(radii above the middle) keeps its radii only while it was hurt within
fCombatAdvanceLastDamagedThreshold (10 s) and its reach and its target's differ by no more than
its inner radius, else the middle ones (the engine compares the target's reach with a distance of
the attacker's, read here as its reach: inferred). It advances from beyond its outer radius past
its reach and stops at its inner radius within it (inferred from the names). Restores: health
not within fCombatRestoreHealthRestrictTime (15 s) of the last, magicka not within
fCombatRestoreMagickaRestrictTime (10 s); no other value is restored (no stamina potions); the
combat tree waits fCombatMagicDrinkPotionWaitTime (3 s) after a potion. Flying: each CSFL chance
on its fCombat…ChanceMin .. Max (0 .. 1); a hover, perch attack or ground fight lasts at random
from its setting's Min up to the style's time on Min .. Max; an orbit at random from
fCombatOrbitTimeMin up to offensive on fCombatOrbitTimeMax .. Min (12 .. 3 s).

Not yet run (TODO(M13): phase 5, the combat tree): the special attack, block attack and offensive
bash behaviours (their values are ready); the flanking and ranged movement selectors (ours: in
`chooseManeuver`). The close movement is the engine's ([Combat movement](#combat-movement)).

- **Reactions** (`reactionsOf(runtime).reaction`, `src/ai/combat-reactions.ts`: the rules crime
  does not weigh, then crime and factions' `runtime.crime.reaction`; `combatReaction` keeps the
  rules without crime for tests and tools): summons, reanimated and commanded actors are their
  commander's allies and share its reactions; the player's teammates are the player's allies; one scripts set to be attacked on
  sight (SetAttackActorOnSight) is everyone's enemy; a relationship decides next (ally and lover
  ally, friend and confidant friend, foe and worse enemy); else the factions' combat reactions
  (FACT XNAM, scripts' SetAlly / SetEnemy) between the factions each is a member of, the closest
  bond winning (ally, friend, enemy, neutral), the other's view where the actor's names none; a
  crime faction set as the player's enemy is an enemy faction to the player. Vanilla factions
  list themselves (BanditFaction is BanditFaction's ally): faction-mates are not allies by
  themselves. Crime makes the player an enemy (`CrimeEngine.reaction`'s crime hostility): to
  the members of a faction set as the player's enemy, to those of a crime faction that is, to
  guards whose response to the player's bounty is to attack (`guardResponse`), and to the others
  of a crime faction that attacks rather than arrests (soldiers) once alarmed by a bounty
  (docs/gameplay.md, "Guards, fines and jail").
- **Entering combat**, every 0.25 s for each actor of the high process, among those it detects
  (or its group sees): by its aggression (unaggressive never, aggressive its enemies, very
  aggressive enemies and the neutral, frenzied anyone) it attacks on sight; its aggro radius
  (AIDT, where its package has the aggro radius interrupt) first leaves alone those beyond the
  warn radius, warns within it (ActionIdleWarn: the bear's roar, facing them) and attacks within
  the attack radius, or within the warn-or-attack radius once it has warned 2 s (TODO(M13)). The
  radius also has one that would not attack on sight warn and attack the neutral that come close
  (inferred: vanilla's wolves and bears are unaggressive with an aggro radius). It
  helps by its assistance (helps allies; helps friends and allies) one that fights or is
  attacked, against the other; guards (IsGuard: the class's guard flag or IsGuardFaction, as crime has it) help anyone attacked who did not
  strike first and would not attack on sight (the crime itself, its bounty and the guards'
  arrest are crime's: `src/shell/actor-crime.ts`); the player's teammates help
  the player at least as friends and allies, and fight within fCombatTeammateFollowRadiusMult ×
  512 of them. A blow turns its victim on the attacker: an enemy or a neutral at once, a friend
  or ally after iFriendHitCombatAllowed (4) blows in combat (2 out of it,
  iFriendHitNonCombatAllowed: TODO(M13)), each blow let pass a friendly fire comment (its Hit
  line, GetFriendHit) where its package has the friendly fire interrupt; attacked by one it does
  not detect, it searches. A package with Ignore Combat (PKDT) keeps it out of fights it would
  pick, and holds the fights it is in (observed in the original: as its package changes,
  the process is marked as ignoring combat by that flag, and meanwhile the combat controller's
  behaviour tree stands stopped; it starts again, Combat or LowCombat, once the package no
  longer ignores combat). Attacked, it stays in combat with its attacker but goes on with its
  package: MQ101's Lokir runs from the archers whether or not their first arrow fells him;
  calm keeps it out of all; StartCombat sets it on a target whatever its reaction and
  makes it hostile to it (the reaction's scriptHostile: the actor state's combatTargets, until
  StopCombat, StopCombatAlarm or its combat ends: TODO(M13) how long the engine keeps it); a
  hostile spell that takes hold turns its victim on its caster as a blow does. Entering, it says NormalToCombat (AlertToCombat when
  alerted), gets off its horse (TODO(M13): mounted combat), its detection reaction or override
  package ends, and its package's way stops.
- **Targets** (`selectTarget`): the most threatening (health × its blow's damage), nearest
  first (half as much at 1024 units), its current target counting 1.5 times (it does not switch
  for a little), one attacking it 1.5 times, one it lost a quarter. The odds (its enemies'
  strength against its group's) move its confidence between fCombatConfidenceModifierMin and
  Max every fCombatThreatRatioUpdateTime.
- **Combat groups**: an actor entering combat joins the group of an ally or friend fighting;
  its target, and any enemy it detects in combat, becomes the group's; the group keeps what
  its members know of its targets ([Combat detection](#combat-detection)): a target the group
  has not lost counts as detected for each member, at the place the group knows; it counts for
  the style's group offensive mult and GetCombatGroupMemberCount; one dying, another says
  AllyKilled.
- **What it fights with** (`chooseEquipment`, weighed again once what it took up has been kept
  its kind's fCombatInventoryMinEquipTime: a weapon 5 s, magic and a shout 3 s, a staff 5 s, and
  no sooner than what it carries is read again, 3 s): the weapons
  it carries (a bow or crossbow only with ammunition; a shot's range before its arrows are known
  fCombatMaximumProjectileRange) and its fists, each scored by its damage ×
  its combat style's equipment score mult (CSGD melee, ranged, magic, staff, unarmed, shout) ×
  its fit to the distance (melee within its reach, less beyond it to
  fCombatAbsoluteMaxRangeMult × the reach; ranged within its range, the one in hand
  fCombatCurrentWeaponAbsoluteMaxRangeMult farther, else fCombatInventoryMaxRangeScoreMult,
  falling to fCombatInventoryMinRangeScoreMult closer than fCombatAdvanceOuterRadiusMax) × 1.25
  for what is in hand (TODO(M13): phase 5, the engine's score; it adds
  fCombatInventoryEquippedScoreBonus on a scale of its own). Another weapon is taken up through
  the equip system (sheathed first, then drawn again; arrows or bolts for a bow or crossbow).
  Its combat style: its combat override package's (PACK CNAM), else its NPC\_ ZNAM (of the
  template that gives its AI data), else DefaultCombatstyle (0x3D). With csHumanMissile
  (ranged 3.2) an archer shoots down to about 250 units and draws its sword closer; a melee
  style keeps its sword at 400. Its magic (`src/shell/combat-casting.ts`, `CombatCasting`)
  joins its options, weighed by the style's magic, staff and shout mults: the attack spell
  worth most against its target (`CastingEngine.spellWorth`: each hostile effect's magnitude
  by its seconds times the share the target keeps through its resistances, Magic Resistance
  and the effect's own resist value, so a frost-resistant target draws fire; none where its
  conditions or level cap leave the target out, as Turn Undead on the living; plus the MGEF
  Script Effect AI Score; a spell cast again only after its effects' AI Delay Time;
  TODO(M13): the engine's CombatMagicCaster weighing), each staff it carries with charge left
  (taken up as a weapon), and its voice's shout. A concentration spell it holds while its
  target is alive, within the spell's range and before it.
- **Its support** (`chooseSupport`, weighed every second): a ward (MagicWard on the spell or
  its effect) against a spell or breath coming at it, held while one comes; below its style's
  health restore share (Style values: 0 .. 50% by its defensive mult) its healing spell, else
  the Health potion it carries that restores most, not within fCombatRestoreHealthRestrictTime
  (15 s) of the last; below its magicka restore share (25 .. 40%) a Magicka potion, not within
  fCombatRestoreMagickaRestrictTime (10 s); no stamina potions (the engine restores no other
  value); a summons when none of its summons stands; a buff (a lasting Self spell: Oakflesh, a
  cloak) not on it. Its attacks wait 1.5 s after a cast, fCombatMagicDrinkPotionWaitTime (3 s)
  after a potion.
- **Movement** ([Combat movement](#combat-movement): how it faces and its close movement): more
  than 512 units beyond its reach it chases its target over the navmeshes, running (sprinting
  from beyond fCombatApproachTargetSprintStopRange); nearer, the combat tree's close movement:
  it advances to a place round its target, surrounds a crowded one, circles, falls back, backs
  off or stands. Flanking styles stalk round it just out of reach for their stalk time (a
  circle), then come at it from the side with allies on the target (round to the point a quarter
  round it, their flank distance past their reach), else advance; at range it closes to its
  optimal range (Style values), falls back within fCombatAdvanceOuterRadiusMax (fallback chance),
  strafes aside (strafe chance) or holds, and chases beyond its range (TODO(M13): the ranged and
  flanking movement trees are not read). Its combat override package list (NPC\_ / alias ECOR: the first package
  whose conditions hold) keeps it within that package's place: back there first, no chase of a
  target beyond it.
- **Attacks** (`chooseAttack`, every 0.25 s: The attack decision): within reach and facing
  its target within 30°, it attacks by its attack chance, a power attack by its attack
  data's chance (ATKD; × power attack staggered mult on a staggered, power attack blocking mult
  on a blocking target), chaining in the attack's window; blocking, it bashes by its bash chance
  (Style values). A bow is drawn by its ranged attack chance and loosed after its hold time; a
  spell or staff is cast by its cast chance when it casts nothing yet (TODO(M13): its line of
  fire).
- **Blocks**: a melee swing coming at it within the swinger's reach it blocks once by its
  block chance (× fCombatBlockChanceWeaponMult without a shield), where its left hand blocks
  (a shield, a two-handed weapon, a one-handed weapon with the left hand free); it lets go as
  the swing ends or after its block time (TODO(M13): phase 5, the sustained Block and Block
  Attack).
- **Threats**: an arrow, a spell's projectile (its collision radius) or a breath (a shout
  drawn in or sprayed at a target, from the head: 96 units wide at the breath's 1000 units a
  second; TODO(M13)) whose line passes through it within 1.2 s (TODO(M13): phase 5, the
  engine's fCombatThreat\* model) it sidesteps by its dodge chance, out of the line to the side
  it stands on, saying AvoidThreat.
- **Fleeing** (`shouldFlee`): below its confidence's share of health (cowardly at once,
  cautious fConfidenceCautious 37.5%, average fConfidenceAverage 15%, brave fConfidenceBrave
  3.75%, foolhardy never) × (1 − the odds' modifier), or with Fear or Turn Undead on it; Rally
  and frenzy keep it in the fight. It says Flee, runs fFleeDistanceExterior (5000) / Interior
  (3000) away from its enemy over the navmeshes, cowers where it can go no farther (ActionIdle:
  the idles IsFleeing picks), fights again cornered (within 192 units, for 10 s), and its combat
  ends once it is that far and detects no enemy. IsFleeing: fleeing in combat, a Flee procedure
  that counts as fleeing, or fear.
- **Searching** (`CombatSearch`): once its group has lost all its targets
  ([Combat detection](#combat-detection)) it searches (CombatToLost; GetCombatState 2): it runs
  to where the group last knew its target to be (within
  fCombatSearchLocationInvestigateDistance), looks round three times
  (fCombatSearchInvestigateTime), walks to points within 768 units round the place, saying its
  LostIdle lines (fCombatDetectionDialogueIdle\*); the group finding one again (LostToCombat) it
  fights on; the group giving its targets up, it ends its combat (LostToNormal; detection's
  alert ends).
- **Yielding**: an actor fighting the player that does not attack them on sight (the fight is
  a quarrel or a brawl) and would flee yields instead: Yield, weapon away, out of the fight for
  fCombatYieldTime (10 s), not again within fCombatYieldRetryTime (600 s); struck again it
  fights on. The player yields a quarrel their blows started by sheathing and holding off 3 s:
  AcceptYield, and it lets them be; so do guards that took up a fight against the player (a
  crime: their arrest follows) unless their faction attacks the player on sight. TODO(M13): the
  engine's rule.
- **The end of combat**: no enemy known (CombatToNormal; dead, bleeding out, gone, left
  behind, or given up by its group), StopCombat, calm or a search given up: it leaves its group, stands, sheathes 3 s
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
  SetAttackActorOnSight. Detection asks it who is in combat (fSneakAlertMod), whom each fights
  (others are noticed less: fSneakCombatMod, fDetectionCombatNonTargetDistanceMult; the target
  is looked at three ways) and who is hostile to whom (searching for one noticed or lost before
  combat), and tells it each test (the groups' knowledge).
- `node tools/combat-ai-info.ts dunFaldarsToothBetBandit01 HuldaREF C06WolfSpiritREF`: each
  actor's AI values, combat style, what it carries and fights with at 100, 400 and 1500 units,
  and the reactions between them and to the player (`--new-game`: after a new game).

### Combat movement

How a fighter faces and moves near its target (`src/ai/combat-movement.ts`, the turning in
`src/ai/locomotion.ts`, on the stage `#melee` / `#shoot` of `src/shell/actor-combat-ai.ts`).
Observed in the original, behaviour only: its combat tree's close movement, the target
locations, the aim controllers, the movement parameters its combat paths hand the movement
controller, and the planner's facing. Settings: `readCombatMovementSettings` (the load order's
GMSTs, else the engine's defaults).

**Facing.** A fighter faces a point, not its target: its aim controller takes the target's place
as the point every fCombatAimMeleeUpdateTime (0.25 s; fCombatAimMeleeHighPriorityUpdateTime,
0.1 s, against the player within its reach; a shooter's every fCombatAimProjectileUpdateTime),
and an advance farther than fCombatCloseRangeTrackTargetDistance (768) from its target faces the
way it runs. Its planner turns it there as the engine's movement controller does:

- standing, it turns until it faces the point within 1°, then holds its facing until the point
  is more than its tolerance off: fCombatAngleTolerance (1°) or its race's aim angle tolerance
  if larger (RACE DATA: trolls 23°, bears 30°, dragons 42°); out of combat fDefaultAngleTolerance
  (5°). Moving, it keeps turning to it;
- its turn rate comes from an angle controller: the fastest that still stops on the heading at
  its angular acceleration (never past it), at most its rate; within 1° of the heading and
  slower than 1° a second, none. In combat the rate is fCombatPathingNormalizedRotationSpeed
  (2.25) on the engine's normalized scale (1 its movement type's walking turn rate, 2 its running
  one, beyond that in running rates: 1.25 × the running rate) and its angular acceleration
  1 / its race's angular acceleration rate (humans 0.25: 4) × fCombatPathingRotationAccelerationMult
  (2) in turn-while-moving rates a second (humans: 0.16 s to full speed). Out of combat its
  movement type's rates and its race's acceleration unscaled (TODO(M13): the movement parameters
  outside combat are not read).

What this fixed: the heading was snapped to the target's place every physics step, so while a
fighter or its target moved, its turn rate fell to 0 on the steps that had no turn left and rose
again on the next (frames and steps at different rates); the graph's TurnDelta channel, which
has no hysteresis, sent turnLeft / turnStop 12–23 times a second and the idle and drawn-bow turn
states flipped as often (QA combat: 20 turn-chatter and 6 state-chatter anomalies).

**The close movement** (the combat tree's Close Movement Context; its Movement Repeat runs the
selector again whenever the behaviour under way ends):

| Where           | Tries, in turn                                                                      |
| --------------- | ----------------------------------------------------------------------------------- |
| out of range    | Fallback To Ranged, Advance, Surround, Circle Distant (its chance), idle            |
| out of position | Reposition, Surround, idle                                                          |
| in range        | Fallback or Circle (the style's chances), Backoff (fCombatBackoffChance 0.25), idle |

Its range is its reach (with the target's radius) and its inner advance radius; idle is the
tree's Close Movement Idle, 0.25 s standing. Each behaviour is a straight combat path
(CombatPathRequestStraightPath) to one goal the navmesh must allow (`straightReach` in
`src/ai/pathfinding.ts`: the line and the lines its radius to either side stay on the navmeshes;
a goal cut short where the navmesh ends, if the rest is still worth going), at a combat speed on
the normalized scale (fCombatSpeedValueWalk 1, FastWalk 1.33, Jog 1.66, Run 2: between the
movement type's walk and run speeds in the way it goes). It ends at its goal or by its own rule,
checked every 0.1 s:

- **Advance / Reposition**: to a target location (below) at its range less
  fCombatTargetLocationPathingRadius (10), running (sprinting from farther than
  fCombatApproachTargetSprintStopRange, [Combat] bCombatPathSprinting), walking the last
  fCombatApproachTargetSlowdownDistance (96); its place moves with its target; where the
  straight line is not clear it goes over the navmeshes. Reposition: it has left its place
  (its bearing from the target off its reservation by more than
  fCombatTargetLocationRepositionAngleMult × its width, or another holds it).
- **Surround**: it keeps within fCombatSurroundDistanceMin .. Max (128 .. 384) beyond its range:
  nearer it retreats to the band's middle, farther it makes for it, running.
- **Circle**: facing its target, round it by an angle (at random from fCombatCircleAngleMin up to
  the style's circle mult on fCombatCircleAngleMin .. Max, 30 .. 90°, × fCombatCircleAnglePlayerMult
  against the player, at least the angle three of its radii take at its distance) at its
  distance, one side at random, else the other, to a goal its target sees
  (fCombatCircleViewConeAngle 150°), at least fCombatCircleMinMovementDistance away, a place
  there reserved; FastWalk. Given up once its target will be (fCombatAnticipateTime ahead)
  beyond fCombatCircleDistanceMax past its range, or comes within fCombatCircleMinDistanceMult
  of its range of the goal. **Circle Distant**: the same out of range, at its own distance, with
  no sight cone and no place.
- **Fallback**: facing its target that faces it (120°) and does not move away, straight back by
  fCombatFallbackDistanceMin .. Max, FastWalk, then it waits fCombatFallbackWaitTimeMin .. Max;
  given up once its target will be beyond fCombatFallbackDistanceMax past its range or its way
  turns more than fCombatFallbackMaxAngle off straight away.
- **Backoff**: facing its target that does not move away, closer than fCombatBackoffMinDistanceMult
  of its range, straight back to its range, FastWalk.

Every behaviour goes towards a fixed goal while it faces its aim point, so the way it goes
against its facing changes smoothly and crosses between ahead and behind at most once: before, a
circle or strafe went exactly sideways every frame (Direction 0.25 or 0.75, on the line between
the forward and backward halves), so moveForward / moveBackward flipped and the walk-back and
strafe clips restarted 9–14 times a second.

**Target locations** (`TargetLocations`): round each target its attackers hold places, each an
angular width (its size, the larger of twice its radius × fCombatTargetLocationRadiusSizeMult and
its radius × fCombatTargetLocationWidthSizeMult, over the distance, within
fCombatTargetLocationWidthMin .. Max: 10 .. 180°). An advancing fighter looks at
iCombatTargetLocationCount (24) bearings round its target, from its own, and takes the free one
nearest to itself whose way out from the target the navmesh allows (cut short to no less than
fCombatTargetLocationMinDistanceMult of the distance); its own place counts
fCombatTargetLocationCurrentReservationDistanceMult nearer. So a group spreads round its target
instead of piling onto one point. TODO(M13): the second size of the width rule (a cached size of
the actor's) is read as its radius; the selector's split of out of range, out of position and
in range, and Fallback To Ranged's condition, are inferred (its behaviour, backing to
fCombatRangedDistance to shoot, is the equipment choice's here).

**While it attacks** its controller does not move it (it stands, still turning to its aim): a
standing attack's clip has no root motion and the controller's way made it glide. Its attack
clip's own root motion carries it instead (`MoveRequest.rootMotion`: a forward power attack's
lunge, which before played on the spot), and what its graph moves it by is not fed back to the
graph as its own movement (`MotionFeedback` gets nothing made while the graph moves it: a drawn
bow's slight root motion was told as walking, the graph took its moving draw, stood again, and
flipped every frame). A dodge does not start in an attack under way and takes the movement over
(the tree's Interrupt Movement Resource). Ranged fighters' maneuvers (`#rangedRun`) are such
goals too: to their optimal range, back (a fallback), aside by fCombatStrafeDistanceMin .. Max,
or standing.

**Its own bodies** do not push its controller ([physics.md](physics.md#the-character-controller)):
an archer's own kinematic shape inside its capsule slid it about at 200–600 units a second while
it drew and stood (QA combat's glides in MT_Idle, Bow_Idle and the landing).

**Falls and landings** (every NPC's, `Locomotion` with the movers' actions): the engine performs
ActionFall and ActionLand, and the idle tree's conditions decide what plays: 0_master's JumpFall
only falling faster than 350 units a second (GetVelocity Z), its landings only in its jump state
(bInJumpState), JumpLand / JumpLandDirectional by the speed it came down with (VelocityZ below
−200; inferred: VelocityZ is its controller's vertical speed). Before, every step without ground
under it sent JumpFall and the next JumpLand: placed fighters and those on rocks chattered between
JumpFall and JumpLand and stood in the landing while they moved.

## Flying

Actors of a race that flies (RACE DATA Flies: DragonRace, AlduinRace, UndeadDragonRace,
DragonBlackRace and the DLCs'; no other vanilla race flies: the dragon priests and the chaurus
hunters hover in their animations and move as walkers). The rules: `src/ai/flight.ts`; on the
stage `src/shell/actor-flight.ts`; check: `node tools/flight-info.ts`; in the browser
`engineDev.flightTrace()` (a line per flying state change and fight phase). Observed in the
original (behaviour, in our words), unless marked ours.

### States and the graph

- **Flying state** (CommonLibSSE FLY_STATE): 0 on the ground, 1 taking off, 2 cruising, 3
  hovering, 4 landing, 5 perched, 6 an action (the talon grab). In the air (IsFlying) is every
  state but 0 and 5. The engine sets the state as the dragon graph raises its events
  (FlightTakeOff 1, FlightCruising 2, FlightHovering 3, FlightLanding 4, FlightPerching 5,
  FlightAction 6, FlightLand back to 0; LandEnd ends a landing); setting it also switches the
  character controller between its flying and ground states (in the air a flier has no
  controller here: src/shell/actor-movers.ts holds it off).
- **CanFly**: its race flies, its graph's Injured is not set, it is allowed to (SetAllowFlying;
  Dragonrend's DragonRend actor value here), and it has health. A hurt flier (below its race's
  injured health: RACE DATA 35%) cannot fly at all: in the air it lands, on the ground it stays.
- **The idle tree drives it**: ActionFlyStart (TakeOff off the ground or a perch;
  FlyStartCruise when the state is already cruising: a start in the air with no take-off clip),
  ActionFlyStop (FlyStopDefault; FlyStopInjured when hurt; FlyStopHasty and FlyStopCrash as the
  landing request is hasty or a crash; FlyStopPerch\* by the landing's target: GetIsID of the
  perch), ActionHoverStart and ActionHoverStop. A flight grab sends to_Flight_Kill_Grab_Enter and,
  as the enter clip ends (FlightActionEntryEnd), to_Flight_Kill_Grab_Action or \_Action_Failed.
  Offline: `node tools/behavior-run.ts meshes\actors\dragon\dragonproject.hkx --motion --at
0.2:TakeOff --vector-at 6:TweenPosition=0,9000,0,0 --at 6:FlyStopDefault --time 12`.
- **What the engine sets each frame**: TargetSpeed (its flying movement type's speed for the
  speed asked: Dragon_Flying_MT forward 2000 walking, 7400 running; combat flies at its fastest),
  TurnDelta and PitchDelta (degrees a second, left and up positive), MovementDirection; while it
  comes to a landing, a hover or a grab DistToGoal (the way left) with HasTweenSpeed and
  TweenSpeed (the chosen clip's own speed), else HasTweenSpeed 0. Every flight action sets the
  tweeners' target: TweenPosition, TweenRotation (its heading as a rotation about z) and
  TweenEntryDirection (the turn to it, in turns clockwise). A take-off keeps its place and the
  way it faces; it turns for its goal once it cruises. The graph flies at its own Speed (its
  acceleration, drag and turns towards TargetSpeed).

### How it moves

- **Paths in the air** (the engine's fly path builders): a flight to a point lifts the point to
  its flight radius over the ground (RACE DATA flight radius, dragons 400) and curves there from
  the way it faces, turning no faster than its turn rate (its flying movement type's
  rotate-while-moving rate, 90° a second; fFlyingActorDefaultTurningSpeed without one), split
  between heading and pitch; the path ends at its point (no arrival radius). An orbit is a lap
  of points round its centre at its radius, raised over the ground under them and levelled, gone
  round the way the flier already turns, built again each lap. A hover and a landing are flown
  to where their clip begins: the point less the chosen clip's root motion, turned to the
  heading it will face (the landing approach MTLand45Approach: 2048 ahead and 2048 above its
  spot; the hover-enter clips 3584 ahead). The take-off clip is the first ActionFlyStart idle
  whose way up is clear (TakeOff, else TakeOff_Vertical).
- **Ours**: `steerFlight` turns and pitches towards the goal at that turn rate along the way
  (no spline), kept its flight radius over the ground; a landing begins within 768 of its
  approach point, a hover within the hover clip's 3584. fMoveFlyWalkMult and fMoveFlyRunMult
  are read by nothing in the engine. TODO(M13): the clear-way test that picks TakeOff_Vertical
  (we play the idle tree's first that holds), and what the engine's path follower does when a
  path ends and nothing asks again (ours circles where it is, 2048 wide).

### Packages

- **Travel**: a flier on the ground walks it (it does not take off for a Travel). In the air (or
  perched: it takes off first) it lands at its place: the engine's own Landing package lands it
  at the place's reference, facing the reference's heading (a plain XMarker: the way it comes
  in), the reference the landing's target (so a perch's FlyStopPerch\* idle plays). A **sky
  marker** (REFR flag 0x2000, xEdit "Sky Marker": a point in the air) is flown to and through
  instead.
- **Patrol**: a patrol whose first point is a sky marker starts its flier cruising at once
  (FlyStartCruise, no take-off), and its start is not set on the ground: a flier placed there by
  its package stays in the air (MQ101's Alduin over the mountains east of Helgen; before, the
  stage set him down on a peak and his trip to the tower began with a take-off from it, beside the
  trigger MQ101SetStage99). In the air it flies through each point and counts it reached within
  the point's radius and fAIPatrolHysteresisWidth (50) across and 180 up or down (the location's
  height window), or once its path ends there; a point that is not a sky marker it lands at; on
  the ground it walks to a point on the ground and takes off for a sky marker.
- **Sit on a perch** (furniture whose MNAM has Is Perch, 0x04000000: DragonPerchTower,
  DragonPerchWordwall, DragonPerchRockL02, DragonTowerHole01, DLC1's DragonWaterDive): in the air
  it lands on the perch (its Travel's radius is ten times fAIMarkerDestinationRadius in the air),
  facing the perch's heading; perched there already the Sit is done at once and it stays; perched
  elsewhere it takes off first. Ours: one on the ground takes off for its perch (the engine walks
  it to the perch, which a perch up a tower or a word wall does not allow).
- **Perched, it stays**: a perch is left only when a procedure needs it in the air (Travel,
  Patrol to a sky marker, Hover, Orbit, FlightGrab, Sit elsewhere, Shout without its stay input);
  Wait, DoNothing and a package that simply ends leave it there. (MQ101AlduinAttackScene1 moves
  Alduin from MQ101AlduinPerch1 to dunCGAlduinShoutTower01 and 02, each a Sit on the same tower
  perch and a Shout with BoolTrue: he shouts from the tower; before, the end of Perch1 took him
  off it and the shout packages ended 1,300 to 1,800 units from it.)
- **Hover**: it flies to its place, Height (0 without one) above it, and hovers facing the
  place's heading; the procedure is done once it hovers within the place's radius, and it stays
  hovering.
- **Orbit**: it circles its place, Height (1000 without one) above it, at a radius at random
  between its inner and outer radius (3000 and 3500 without them), lap after lap.
- **FlightGrab**: it flies at its target and grabs it with the talon grab (below).
- **Must Complete and scenes**: a package with Must Complete is kept until it completes when the
  actor's packages are chosen again, but a scene's package action sets its package at once, past
  it (src/ai/package-runtime.ts): MQ101AlduinApproachPatrol (Must Complete) gives way to
  MQ101AlduinPerch1 as the attack scene's phase changes.
- **Unable to fly outside a fight** (hurt, Dragonrend, SetAllowFlying false): it lands at its
  forced landing marker (SetForcedLandingMarker), else the nearest landing marker, else the
  navmesh near it; a crash landing under Dragonrend (unless SetAllowFlyingEx forbade crashing),
  a hasty one when a script grounds it (ours).

### Combat: the Flight subtree

The combat tree's movement selector (checked every 0.25 s) takes its Flight branch, second after
Essential Down, for a flier that can fly or is not on the ground (src/shell/actor-combat-ai.ts
asks `ActorFlight.fight`). A flier on the ground that cannot fly fights with the ground movement.

- **Takeoff** first: one on the ground or perched that can fly takes off.
- Then a selector checked every second: **able to fly**, the attack loop; **perched and unable**,
  it takes off; **in the air and unable**, it waits until it cruises and lands.
- **The attack loop**: while its target is outside its **combat area** it circles that area
  (Orbit Distant: round the area's centre at its radius). The area: fCombatAreaStandardRadius
  4096 (fCombatAreaStandardAttackedRadius 8192 for fCombatAreaStandardAttackedTime 1000 s after it
  was attacked), times fCombatAreaStandardFlyingRadiusMult 2 in the air; its centre is where the
  flier is as the fight begins, and moves to it again when it is attacked and when its target
  faces it within 30° nearer than both their sizes and 4096 (1024 at 30°). Otherwise, cruising:
  **Orbit** round its target at fCombatOrbitDistance (Skyrim.esm 4000; the engine's 6000) for
  a time at random from fCombatOrbitTimeMin (3 s) up to its offensive mult on
  fCombatOrbitTimeMax .. Min (12 .. 3 s), not ending while it is busy (breathing); then **one
  maneuver**, drawn by weight among those not tried: each weight its style's CSFL chance on its
  fCombat…ChanceMin .. Max (csDragon: ground attack 0.85, flying attack 0.75, hover 0.52, perch
  attack 0.5, dive bomb 0.36: drawn first 29%, 26%, 17%, 17%, 12%). One that cannot start is
  marked tried and another is drawn; none left, it orbits again.
- **Its ranges** (the combat inventory's): a breath's farthest is 0.9 of its projectile's range
  (at most fCombatMaximumRange 4096), its nearest 256, its optimal three quarters of the way
  between (fire and frost breath 256 / 1414 / 1800; fireball 256 / 3136 / 4096); its optimal range
  is the nearer of its style's farthest optimal range (fCombatMaximumOptimalRange\*, by its
  defensive less offensive mult) and its breath's optimal range, its reach its breath's farthest,
  each beyond both actors' size; in the air its farthest is at least fCombatFlightMinimumRange
  (1536).
- **Dive Bomb**: at its target where it will be in fCombatAnticipateTime (0.5 s), to one side by
  up to fCombatDiveBombOffsetPercent (10%) of its optimal range, fast, slowing within
  fCombatDiveBombSlowDownDistance (4096) of it; done within its optimal range less that offset.
  It may breathe on the way.
- **Hover** (one flier at a time): iCombatHoverLocationCount (4) points round its target at its
  optimal range, its own side first, each raised by fCombatHoverAngleMin .. Max (0 .. 20°),
  within its combat area; there it hovers facing its target from fCombatHoverTimeMin (Skyrim.esm
  5.5 s; the engine's 7.5) up to its style's hover time on that .. fCombatHoverTimeMax (15 s),
  then back into its cruise.
- **Ground Attack** (one flier landing or on the ground at a time): a hasty landing near its
  target within its optimal range, clear of the target and of every actor larger than
  fCombatLandingAvoidActorRadius (64); on the ground it fights (the combat AI's bites, tail,
  wing attacks and breath) from fCombatGroundAttackTimeMin (Skyrim.esm 8 s) up to its style's
  time on that .. fCombatGroundAttackTimeMax (17 s), then takes off if it can.
- **Perch Attack**: one of the loaded perches at random within its reach of the target, facing
  the target within fCombatPerchMaxTargetAngle (75°) of the perch's heading, free, with a clear
  line to the target; it lands on it facing the perch's heading and breathes from there for
  fCombatPerchAttackTimeMin (Skyrim.esm 4 s) up to its style's time .. Max (15 s), leaving early
  once its target is out of that angle (checked each second).
- **Flying Attack** is the talon grab, not a breath: only at a target slower than a jog (three
  quarters from its walk to its run), one a kill move may end (not essential), that one blow of
  the flier's would kill (its race's unarmed damage on its strongest attack); given up once the
  target moved fCombatFlyingAttackTargetDistanceThreshold (256) from where it was. TODO(M13): the
  engine's combat check does not leave out the player; whether the fly action's idles do is not
  read: ours does not grab the player.
- **Unable to fly in the air** (hurt, Dragonrend, killed): once it cruises it lands at its forced
  landing marker, else the nearest landing marker (DOBJ DLZM DragonMarker) within
  fCombatLandingZoneDistance (6000) with no actor within fDragonLandingZoneClearRadius (256) and
  its size, else the navmesh near it within fCombatLandingSearchDistance (6000), else any landing
  marker, else it circles and tries again. Hurt and fighting the player it looks round the player,
  where a crash strip (DOBJ DCZM DragonMarkerCrashStrip) competes: landing there is the crash
  landing (FlyStopCrash). A hurt flier's landing elsewhere plays FlyStopInjured. On the ground it
  cannot take off again while hurt: it fights there to its death.
- **Its breath** (the combat tree's Shout action: tried each second): while its actions are free,
  as it circles and dive bombs, hovering and perched once there (held while it flies to a hover
  point, lands, comes to a perch or grabs); a shout it knows (its spell list's SHOU, one at random)
  at a target before it (within 36°, ours) and within the shout's reach, when its voice has
  recovered: ActionVoice (shoutStart, shoutStartFireball), its words let out after their hold
  time (ActionVoiceRelease), a concentration breath spraying from its head's magic node until the
  graph's shoutStop or 3 s. On the ground the combat AI's own shouts breathe.
- **Killed in the air** (the engine's deferred kill): leaving the ground arms its deferred kill
  (Actor.StartDeferredKill); with no health it cannot fly and comes down, and dies as it lands
  (EndDeferredKill as its state returns to the ground), at the latest fBetaDeferredKillTimer (15 s)
  after its health ran out. Its death plays on the ground, then its scripts' soul absorb
  (dragonActorScript).

### Others

- **Perches**: one flier each; on it a flier has no controller and turns to its target.
- **Trigger volumes**: a flier without a controller (in the air, perched) tells the volumes it
  flies through as a walking actor's controller does (a ball of its size about its middle):
  MQ101SetStage99 lies across Alduin's way from his patrol's start.
- **Against fliers**: a target in the air counts as far as it is in three dimensions (bows and
  spells reach it, `chooseEquipment`); a blow from the ground does not reach one whose feet are
  above the attacker's head and half its reach (`withinReach`: melee fighters wait under it);
  observers notice it fSneakFlyingDistanceMult times as far.
- **Scripts and conditions**: IsFlying, GetFlyingState, IsAllowedToFly, CanFlyHere,
  SetAllowFlying, SetAllowFlyingEx, SetForcedLandingMarker; the conditions GetIsFlying,
  GetFlyingState, GetIsCrashLandRequest, GetIsHastyLandRequest, IsAllowedToFly, CanFlyHere,
  GetIsInjured. Interiors have no flying (CanFlyHere). Dragonborn's dragon riding flies through
  the same flight: docs/gameplay.md, "Dragon riding".
- `node tools/flight-info.ts`: the races that fly, their movement types, speeds and attacks, the
  flight settings; `node tools/flight-info.ts csDragon EncDragon01Fire`: a combat style's flight
  section with its times and how often each maneuver is drawn, an actor's shouts with their reach
  and combat ranges; `--perches`: the perch furniture.
