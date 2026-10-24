# Physics and the player

How the engine's Havok world is rebuilt on Rapier (`src/physics/`), and how the player moves
and looks (`src/shell/player.ts`, `src/shell/play-session.ts`). Formats:
[nif.md](formats/nif.md#collision), [esm.md](formats/esm.md#collision-layers).

## The world

- **Units:** Rapier runs in Havok units (≈ metres, 1 = 69.99125 game units); the engine's
  own code works in game units and converts at the boundary.
- **Steps:** fixed `[HAVOK] fMaxTime` (1/60 s), at most `uMaxNumPhysicsStepsPerUpdate` (3) per
  frame (observed in the original: the engine clamps a frame's physics time to that many steps; its
  "complex" mode, fMaxTimeComplex with uMaxNumPhysicsStepsPerUpdateComplex 1, is not known to be
  used: TODO(M13); fTimePerSubStep and iMinNumSubSteps are read by nothing); the player's camera
  is interpolated between the last two steps, so 144 Hz screens see smooth motion.
- **Top speeds:** every simulated body's velocity is clamped after each step to its file's
  maximum linear velocity (Havok units a second) and angular velocity (radians a second), as
  Havok's motions do.
- **Swept bodies** (continuous collision, Rapier's CCD): the engine chooses a body's quality as
  it makes it (observed in the original): a simulated body thicker than `fDebrisMinExtent` (2 Havok units,
  140 game units) along all three axes, or whose top speed is below `fDebrisMaxVelocity` (25
  game units a second), is debris, never swept; of the others, debris quality becomes moving
  (swept against what is fixed) and the rest keep the file's (vanilla files: fixed, keyframed,
  debris and moving). So nearly all clutter is swept; a cart is not. Rapier sweeps against
  everything, not only fixed bodies.
- **Gravity:** 9.8 m/s² downwards. Not documented; it is what mods read from the running
  game (hkpWorld::m_gravity).
- **Collision filter:** every collider has a layer; pairs collide as the COLL records say
  (Rapier's physics hooks for simulated pairs, a filter for queries and the character).
- **Friction and restitution** combine as Havok's square root of the product (each collider
  gets the square root, Rapier multiplies).
- **What is placed:** the collision of every enabled object in the loaded cells, the
  landscape of each cell (its 33×33 heights as triangles, split like the drawn landscape, on
  L_GROUND), and collision primitives. It goes in a few per frame (3 ms) so loading does not
  stutter. Simulated objects stay asleep until their cell's collision is complete, then
  settle (the warm start) unless "Don't Havok Settle"; their drawn model follows the body.
  Large references beyond the loaded grid and distant LOD have no collision, as in the game.
- **What waits:** simulated bodies that do not settle (not yet: until their cell's collision
  is complete; for good: "Don't Havok Settle", and statics) stay where they were placed until
  something that moves touches them (the player's shape, an object in motion) or the player
  takes hold of them; then they fall and roll like any item. Havok leaves a deactivated body
  alone until an active one touches it; Rapier wakes a sleeping body at its first contact,
  even with the wall it hangs on, so waiting bodies are kinematic until touched (they meet
  nothing fixed and cost nothing).
- **Statics do not settle:** a STAT whose model has simulated bodies (the "...Static" clutter
  such as GlazedCandlesStatic, mounted antlers, the "...ForDisplay" weapons on Jorrvaskr's and
  Dragonsreach's walls) can be knocked over, but waits until it is (`settlesWhenPlaced`).
  Settled, Dragonsreach's antlers fell 600 units off its walls, which they never do in the
  game; only 13 of 379 such statics carry "Don't Havok Settle". TODO(M13): inferred from the
  data.
- **Weapon racks** are the game's own WeaponRackActivateSCRIPT (docs/scripting.md): as its
  cell attaches, the rack takes the reference it links to without a keyword, checks it against
  its RackType (1: anything but a shield; 2: a shield; 3: neither a dagger, a shield nor a
  bow), sets its motion type to keyframed (the body stops waiting for a touch) and moves it to
  its trigger's pivot node for its type (MoveToNode: the node's place in the trigger's model).
- **Settling without throwing:** what a placement overlaps (book corners in a shelf's back
  panel, a cover into the board under it) is pushed out by the solver; for the first half
  second after a body is set to settle its speed is taken away after every step, so the push
  only moves it (Havok recovers penetrations slowly; Rapier's push sent Jorrvaskr's books
  off their shelves). TODO(M13): how far the engine's warm start goes. Settled over 10 s:
  Breezehome, Warmaiden's, Belethor's, the Bannered Mare and the Sleeping Giant keep
  everything in place; Jorrvaskr 3 books (placed over a shelf's edge). A placement a script
  enables (`PhysicsWorld.setEnabled`) is pushed out so too for its first half second back:
  MQ101's dead horse, enabled with the dragon's attack against the second cart's back in
  Helgen's square, was thrown at 14,000 units a second (a test box 15 units into a board left
  it at 46 units a second, now at 0.1).
- **Solver:** 8 iterations per step (Rapier's default 4 lets stacks and hinged bodies creep
  and jitter: 34 bodies of Jorrvaskr stayed awake after 10 s, 9 with 8), at the same cost as
  fewer bodies stay awake.
- **An object's bodies never collide with one another** (Havok's group filter gives each
  placed object a system group): a hanging pheasant's body against the hook it hangs on, a
  book's covers.
- **Hung objects** (simulated bodies on a fixed one: hanging game, chains) placed into other
  collision deeper than a game unit (a pheasant's hook set into a beam, its body in it) never
  collide with that collision: unable to leave it, it would push against its hinges and swing
  for good (it did in nearly every inn). Found by the contacts after their first step, which
  pushed them out: they go back to where they were placed.
- **Keyframed bodies** (door leaves) follow their node in the sequence the object plays.

## Actors on the ground

Actors are set on the ground as a controller puts them when their cell loads
(`src/world/actor-ground.ts`; near the player they then get a character controller of their own:
[ai.md](ai.md#movement)): once the cell's collision is complete, a ray straight down from 16
units above where the actor stands (its reference, where a script moved it, or where its package
has it: [ai.md](ai.md#where-packages-put-actors)), on what the character controller collides
with, gives the feet's height. The controller falls, so the
ground may be any distance below: leveled animals and bandits in the wilderness are placed up
to 120 units above it. Races that tilt lean with the ground's normal there: RACE DATA flag 0x8
"tilt front/back" (four-legged animals) about their sideways axis, 0x10 "tilt left/right"
(spiders, chaurus, mudcrabs, mammoths) about their length too; others stay upright. Races that
do not walk (0x100 "walks" unset: slaughterfish) stay where they were placed, as do actors in
the furniture their package uses (the furniture holds them) and actors with nothing under
them (placed in a cell their package takes them out of). Actors placed below the landscape stay
there: whether the engine's controller lifts them out is not documented (TODO(M13)).

## Water volumes

Swimming and the sound under water test where water can be entered
(`src/world/water-volumes.ts`): a water activator's (ACTI WNAM) WATER-layer phantoms
([nif.md](formats/nif.md#water-volumes)), and the cell's water plane where it lies above the
landscape (no bottom). Water without a volume is only seen and heard.

## The character controller

The engine's controller shape (hkCharControllerShape) is a convex hull of two rings of eight
points with one point below and one above (PLANCK and Dynamic Collision Adjustment read and
rebuild it at runtime), made from the skeleton's collision bound "BBX" scaled by the race's
height. Its exact ring radius and heights are not documented. Here: the bound's narrow half
extent (14 × 1.03 for a Nord) as the rings' radius and the full bound height, with Havok's
default convex shell of 0.05 (3.5 units) around it: 36 units across. The first-person camera
stands in the shape's middle, so a wall the player walks into stays beyond the near plane
(`[Display]` fNearDistance 15); with the shell inside the rings (29 across) the camera looked
through walls. Rings one radius from the ends. The cone between end point and ring rides over small
steps (about 14 units); on stair materials (MATT stairs flag) whole stairs up to 32 units
are climbed: the treads of the 330 vanilla stair collision meshes rise mostly 24 or 16, but
also 25–28 (Castle Volkihar's courtyard stairs: 24.4) and up to 32. The steepest walkable slope is kept in
hkpCharacterProxy::maxSlopeCosine without an INI setting or GMST: 60° here, TODO(M13):
calibrate both against the game. A step is climbed when the controller's own movement on a
staircase gets less than 60 % of the way it was to go, measured along that way (sliding along a
riser walked into at an angle is no way up): the shape rises by up to the stair height (as far
as there is room), moves on — the way it was to go, else along what blocks it (a wall beside
the stairs) — and comes down onto the step if that is walkable ground higher than where it
stood (`CharacterBody` step-up: shape casts that ignore what the shape already touches; a
steep wall touching the shape's side as it comes down is stepped away from first, it is met
before the step). Rapier's own autostep stopped at random treads of the Volkihar courtyard's
stairs (24 units, like those climbed before them) whatever its minimum step width, and climbed
at about 40 % of walking speed (its controller moves along the edge's slope at cos² of its
angle); stairs are now climbed at about walking speed (the courtyard's 244-unit stairs in
0.8 s). TODO(M13): compare with how the engine uses the stairs material.

Off the stairs the same step is tried — the engine's controller has a TryStep (CommonLibSSE:
`bhkCharacterController` flags kTryStep beside kOnStairs) — but only onto ground actors walk:
the cells' navigation meshes (`NavmeshSurface`, within 24 units of the mesh). Rubble piles,
cave rocks and raised floor pieces lie on the navmesh with bumps of 17–32 units; benches
(30–32 high) and chests are left out of it, so the player walks over the one and not onto the
other. How far the engine's own TryStep goes is not documented: TODO(M13). The actors'
controllers step so too (`src/shell/actor-movers.ts`, onto the navmeshes of the loaded area):
before only the player's did, and a Riverwood chicken sent onto a porch the navmesh covers
stood before its edge.

`node tools/stairs-audit.ts` walks the player up and down every staircase and ramp of the
interiors as actors walk them: the slopes of the navigation meshes (see
[esm.md](formats/esm.md#navigation-meshes)). Neighbouring navmesh triangles sloping the same way
make a flight; where it meets flat navmesh at its foot and top are its landings. The player
walks from a landing below to the one above and back, through the middles of the edges the
flight's triangles share, steering as a player would. Of 14,367 walks over 6,767 flights, 854
do not arrive (1,138 with steps on stairs only): closed doors, gates and portcullises, magic
barriers, spider webs and cocoons to cut through, moving bridges and platforms (game states:
the running game's scripts open, lower and raise them, the audit runs none; blows, spells and
explosions tear and break the webs, which are destructible objects: docs/gameplay.md,
"Destruction"; the bridges'
collision follows their animation already, see Constraints and ragdolls and animation.md,
Skeletal objects); walks that hug an obstacle beside the way (the audit steers
through the edges' middles, a player walks around it); and a few steps higher than 32 units.

- **On the ground** it only moves along the ground; snapping to the ground (as far as the
  shape's radius) keeps it on slopes and down steps. Pressing down every step as well makes
  Rapier's controller meet the floor at the start of the step and now and then drop the rest
  of the step there (the player stuttered and stuck on flat floors: 69 times in a run through
  the Palace of the Kings, now 2).
- Gravity × `[HAVOK] fInAirFallingCharGravityMult` (1.35) while falling, ×
  `fUnsupportedGravMult` (4) while standing on something too steep (sliding off).
- **Pushing** (the engine's character controller, observed in the original): a simulated body a character
  walks into gets an impulse along the contact's normal at the contact, the one that takes the
  touched point up to the character's speed (TODO(M13): Havok's character proxy's own impulse is
  not known), its speed change held to 1000 Havok units a second, times a factor by the body's
  layer and mass: nothing for one without mass or of `[HAVOK] fMoveLimitMass` (95 kg) or more,
  nor a projectile; a prop (L_PROPS) ×3 up to half that mass, else ×0.1; a trap ×0.1; anything
  else ×2. Rapier's own impulses on dynamic bodies are off; the controller still stops at what it
  does not push.
- **Its own bodies** (its ragdoll's bones, a held or worn object with collision) never block or
  push its controller: Havok's character and its bodies share a collision system group that
  does not collide with itself. A kinematic shape of an archer's own inside its capsule pushed
  the capsule out every step, so it slid about at 200–600 units a second while it stood
  (`CharacterBody`: what it moves against and recovers from leaves out its own actor's).
- **Speeds** come from the movement types (MOVT): NPCDefault walking and running,
  NPCSprinting (only forward), NPCSneaking, NPCSwimming; `bAlwaysRunByDefault`, Run walks,
  Caps Lock toggles. Air control is not documented: the speed at take-off is kept.
- **Jump:** GMST fJumpHeightMin (Skyrim.esm 76, built in 64) is the height; with constant
  gravity the take-off speed is √(2 g h). No jumping while sprinting (vanilla blocks it). A
  sprint goes on in the air (a jump, a step down) until the fall is faster than
  fJumpFallVelocityMin (Skyrim.esm 700 units a second; the engine's sprint, observed in the original).
- **Swimming:** at a submersion (water depth over the body's height) of 0.69 the body floats
  with its shoulders at the surface; looking down while swimming forward dives. The engine's
  float height (swimFloatHeight) is not documented; 0.69 is the in-game measurement of the
  author of "Wade In Water".
- **The body and its camera** are the player's avatar (animation.md, The player): the
  first-person camera rides the animated Camera1st node (sneaking lowers it), a jump pushes off
  when its animation raises JumpUp. Sprinting drains stamina (docs/gameplay.md). A fall higher
  than fJumpFallHeightMin takes health (fJumpFallHeight\*, through the perks' Mod Falling
  Damage; none into water): `src/gameplay/falling.ts`, docs/gameplay.md. Every character
  controller measures its falls (`CharacterBody.landedFrom`: from the highest point of its feet
  since it left the ground), so NPCs, creatures and horses take the NPCs' falling damage
  (`...NPC` settings) as the player takes the player's (the engine's landing handler, observed in
  the original, is the actor's). An actor getting up from a ragdoll (knocked down, thrown) is measured
  from its feet as it fell (raised by however far its ragdoll flew up) to the ground it gets up
  on, against a quarter of the minimum height (the engine's ragdoll end).

## Tethered carts

A cart its horse pulls (TetherToHorse: [ai.md](ai.md#vehicles)) is a simulated model like any
other, set up as the engine sets it up (`src/ai/cart-tether.ts`) and moved every physics step by
the stage (`src/shell/actor-vehicles.ts`):

- **Its bodies** become dynamic as it is tethered and start as a settled object does (for half a
  second the solver's push out of what they overlap only moves them): the cart waited, keyframed,
  where it was placed, where the engine's had settled on its wheels with its cell. Each weighs
  `fMass:Cart`; `PhysicsWorld.tuneBody` scales the inertia with the mass (Havok's setMass keeps
  it: see ai.md for why it is scaled here).
- **The wheel action** is a gravity scale: 1 + `fGravMult:Cart` × 9.81 / 9.8 (the engine's action
  adds that force each step; the world's gravity is 9.8). The wheels are not swept (their allowed
  penetration, 0.3 Havok units, is more than a step moves them); their friction combines with the
  ground's as any other (√(100 × 0.5) against the landscape).
- **The tether** is a keyframed body with no shape (`PhysicsWorld.addHitch`) moved every step to
  the spine (Rapier's next kinematic pose: it gets the velocity that takes it there in the step),
  and a generic joint: it slides along its x (the slide axis) between the limits, is held along
  y and z, its turn about x springs back to the joint's frame (a motor towards 0 with the
  spring's stiffness and damping as accelerations), its turns about y and z are free. The
  engine's prismatic joint holds all three turns; Rapier's joint held so with a keyframed body
  on one side and the wheels on the ground on the other has no give: the replayed ride (below)
  threw the cart off the road at thousands of units a second whatever the spine did.
- **The spine it follows** is eased (`PoseEasing`, `TETHER_LEAN_EASE` in `src/ai/vehicles.ts`):
  a kinematic body sent to a new pose jumps there in one step, and the horse's pose comes ten
  times a second behind the camera, once a frame of three steps at a low frame rate.

`node tools/cart-ride.ts [cart] [horse]` drives a cart behind its horse over the real collision
of the horse's linked references (the opening's road) and prints the ride: the bounce (vertical
speed against its average over a second), the pitch and roll rates, the lowest up, the wheels
off the ground. The browser's measurements (the whole ride, both carts) and the causes:
[ai.md](ai.md#vehicles). The world's own settings are unchanged by the carts: the solver's 8
iterations, the landscape's mesh, the step limit (clutter settles and rolls as before).

## Cameras and input

- **Input:** the bindings of the game's control map (see
  [controlmap.md](formats/controlmap.md)); mouse look turns `π × fMouseHeadingSensitivity ×
fMouseHeadingXScale` radians per count (× fMouseHeadingYScale vertically).
- **First person:** at the 1st-person skeleton's Camera1st node (120.5 × race height).
  **Third person:** behind the 3rd-person skeleton's Camera3rd node, moved right by
  fOverShoulderPosX and down by fOverShoulderPosZ, at fVanityModeMinDist … fVanityModeMaxDist
  by the zoom (mouse wheel by fMouseWheelZoomIncrement down to fMinCurrentZoom; further in goes
  to first person). A sphere of fCameraCasterSize on L_CAMERA keeps it out of walls. Observed in
  the original (`src/shell/player.ts`): the zoom moves to its target at
  fMouseWheelZoomSpeed (0.8) of its range a second, in a straight line; looking down pulls the
  camera back by up to fPitchZoomOutMaxDist (100), in step with the pitch (all of it straight
  down); a camera a wall pushed in eases back out from where it met the wall, fCollisionRecoverySpeed
  (3) of the way a second, once the wall is gone, when the way back is longer than
  √fCollisionRecoveryMinDist (√4000, about 63 units; else it jumps). Toggle POV switches as it
  is let go (after at least fTogglePOVDelay, 0 s); held for f1st3rdSwitchDelay (0.25 s) in first
  person it goes to third person at once. TODO(phase 7): the camera states that read the other
  `[Camera]` settings, now in `INI_DEFAULTS`: holding Toggle POV in third person turns the camera
  about the player (and bReturnTo1stPersonFromVanity), the auto vanity camera (after
  fAutoVanityModeDelay, 120 s, without input: circling by fAutoVanityIncrement, 0.01 radians an
  update, fDefaultAutoVanityZoom away; bDisableAutoVanityMode, bForceAutoVanityMode), the
  heading's chase (fChaseCameraSpeed 10 radians a second, at most fChaseCameraMaxAngle 30°
  behind: what sets its target is not known yet), the furniture camera (fFurnitureCameraZoom 250,
  fFurnitureCameraAngle π/8; a workbench's fWorkbenchCamera*), flying (fVanityModeMinDistFly
  1200, fVanityModeMaxDist × fVanityModeMaxDistFlyMult 4).
- **Field of view:** fDefaultWorldFOV (80) is the horizontal field of view of a 4:3 frame;
  wider screens see more at the sides (Hor+). The reference aspect is not documented.
- **Free camera (tfc):** a switch in the shell; the player stays where they are.

## Activation

The crosshair is a sphere of fActivatePickRadius (16) cast from the camera along the view for
fActivatePickLength (180; further in third person by the camera's distance from the eyes) on
L_ITEMPICKER. Load doors take the player to their XTEL (inside or out, see
[esm.md](formats/esm.md#doors-arrivals-and-collision-primitives)); other doors play their
Open and Close sequences. The prompt is the HUD's crosshair text in Play (the shell's in the
sandbox); load doors show the loading menu (play-mode.ts).

**Arriving** through a door, the player waits (in place, behind the loading screen) until the
collision of the cell and the eight around it is in place — a street, bridge or porch may
belong to a neighbour — and ray casts see it: Rapier updates what queries search (its broad
phase) in a physics step, so collision placed since the last step is not there for them yet
(`PhysicsWorld.queriesCurrent`); the player is placed at the start of a frame, before that
frame's collision. Then the player stands on the floor: the first surface below half the
body's height above the arrival point, down to 96 below it (`Player.arrivalFloor`). Porch
roofs and door frames stay above; below the middle of the body, Havok's character proxy is
pushed up out of what it stands in (it recovers from penetration along the contact normal).
Arrival points lie up to 37 units under their floor (Halted Stream Camp, Chillfurrow Farm,
Fenn's Gulch Mine). Without a floor there (an underwater passage's auto-load door) the player
stays at the door's height. Then the character controller recovers from penetration
(`CharacterBody.recover`): pushed along each overlapping contact's normal by its depth, a few
rounds, as Havok's proxy does — arrival points may lie in their door (KatariahWorld's balcony
door: 25 units in front of it, where the shape reaches 32). The rays leave out the player's
own shape and phantoms (trigger volumes), as the character controller does. Waiting has no
time limit but a 60 s safety net: a 10 s limit placed players under their floor where a heavy
cell's collision took longer (frames are slow in a hidden tab). While walking, a player whose
cell's collision has not loaded yet waits instead of falling through.

The viewers start where a door would bring the player in: an interior at the first of its load
doors (both sides there at the start of a new game), a worldspace at the door nearest its
busiest cell (the East Empire Company Warehouse's door to Brinewater Grotto is disabled and
boxes stand before it; it starts at the Solitude docks' door); without doors, a worldspace at
its busiest cell's middle on whatever is below (The Pit: on its arena), an interior at its
middle.

`node tools/spawn-audit.ts` walks every load door: the arrival as above with the collision of
where it leads (interiors with player homes built, as the viewer opens them; exteriors with the
3×3 cells and their landscape), a second standing, then walking off in eight directions; it
lists arrivals without a floor, falling, standing in something, without headroom, stuck or
under water, and the viewers' starts. `--passages` opens every door of the interiors whose
leaf stands taller than the player and walks through it both ways. Of 2,092 arrivals (217
doors disabled at the start left out), the ones left with a problem are test and placeholder
cells (CTest, the Creation Club placeholders, MainMenuCell, the voice cells), states that quests
change (Sky Haven Temple's exterior lies in a collision box until MQ203 disables it; Highpoint
Tower is buried in ash), and drops by design (the Ratway's sewer outlet into Lake Honrich, the
prison release markers). Of 1,492 doors, 104 stay shut to the walk: deadbolted ones (opened
from the other side), spider webs to cut through, Nchardak's seals, rubble behind false doors,
and load doors used as plain doors (their Open only cracks them, as the game plays it): the
deadbolts, seals and secret doors are scripts (the running game's, not the audit's), the webs
destructible objects that blows, spells and explosions break (docs/gameplay.md,
"Destruction").

**Grabbing:** Activate on a loose (simulated) object waits `[Controls] fZKeyDelay` (0.2 s): let
go before that, it activates; held longer, the player takes hold of the object where the
crosshair's sphere touched it, until Activate is let go (`src/physics/grab.ts`). So too a dead
actor (its search on a tap): held, the player drags the ragdoll body the pick met, its joints
bringing the rest (`PhysicsWorld.grabbable`'s corpse, src/shell/play-session.ts). Never the
living (bAllowHavokGrabTheLiving 0: a knocked-down actor's ragdoll neither). The engine hangs the object on Havok's mouse spring
(hkpMouseSpringAction): every step an impulse at the held point, through the body's effective
mass there (m⁻¹·1 − [r]× I⁻¹ [r]×), removes fZKeySpringElasticity (0.2) of the distance to the
point the camera looks at (at the distance it was taken) and fZKeySpringDamping (0.5) of the
point's velocity; the impulse is limited to mass × step × the maximum relative force; then
both velocities are scaled by fZKeyObjectDamping (0.75). The maximum force is fZKeyMaxForce
(Skyrim.esm 100, built in 250) × a scale that falls with the weight (observed in the original: the Havok
mass of the object's bodies): fZKeyMaxForceScaleHigh (1) up to fZKeyMaxForceWeightLow (0),
fZKeyMaxForceScaleLow (0.2) at fZKeyMaxForceWeightHigh (Skyrim.esm 150, built in 300) and
beyond: heavy objects sag. A body heavier than fGrabMaxWeightWalking (100 kg) is not taken
hold of (fGrabMaxWeightRunning is read by nothing); holding one heavier than fZKeyHeavyWeight
(75 kg) the player walks, as over-encumbered. When the held object is left behind by more than
fActivatePickLength it is dropped. TODO(M13): the engine checks a held object that falls more
than 96 units behind against its contacts (fZKeyMaxContactDistance, fZKeyMaxContactMassRatio);
what it then does is not known; the complex helper's spring for ragdolls (fZKeyComplexHelper\*;
a held ragdoll hangs on the plain spring at the body taken hold of).

**Telekinesis** (observed in the original): the same spring with fMagicTelekinesisSpringDamping (0.5),
...SpringElasticity (0.075), ...ObjectDamping (0.95) and ...MaxForce (1000, no weight scale),
holding the object at its middle; thrown, its turning is stopped. Its reach, pull, hold and throw:
docs/gameplay.md, "Magic effects" (src/gameplay/magic/telekinesis.ts). TODO(M13): the complex
spring for ragdolls (fMagicTelekinesisComplex*); fMagicTelekinesisLiftPowerMult is read by nothing.

**Constraints and ragdolls** (`physics-world.ts`, `articulation.ts`; the blocks:
formats/nif.md, Collision): a model's constraints become Rapier impulse joints between its
bodies, the two Havok frames as the joint's local frames (axis, perpendiculars, pivot; the
placement's scale on the pivots), and bodies held together do not collide with each other.
Ball and socket → spherical; hinge → revolute; limited hinge → revolute limited to its angles;
prismatic → prismatic limited to its distances; ragdoll → spherical with three angle ranges:
the twist, the swing towards the motor axis within the cone, the swing towards the plane axis
within the cone and the plane limits (TODO(M13): Havok's limit is a cone and two planes); the
hinges' and the ragdolls' twist and plane angles are mirrored, as Rapier measures a joint's
turn the other way round from the files' limits (`node tools/ragdoll-info.ts --limits`: of
12,149 limited hinges in the 1,257 complete placed ragdoll poses, the Creation Kit's settled
Havok state, 60 % lie within their limits unmirrored and 97 % mirrored; the plane angles 90 %
and 97 %; unmirrored, knees and elbows bent only backwards, and a dying pose's bent knee
started past its limit and snapped); stiff
spring → rope (TODO(M13): a stiff spring also pushes); a chain → a ball and socket per link.
**Friction:** a ragdoll's and a limited hinge's maximum friction torque (a prismatic's friction
force) is a motor towards no relative speed on the joint's free axes whose force is that maximum
(an absolute torque in Havok's units, kg·m²/s²: the human skeleton's ragdoll joints hold 10, its
hinges 0, as the mammoth's, sabre cat's and centurion's), meant to hold limbs against less and
let them give way to more (TODO(M13): measured, Rapier's velocity motor holds far less than its
maximum: see "The dead"). Motors (no vanilla constraint has one), malleable strength and a chain's tau and
damping are not applied (Rapier's joints are stiff). A joint is in the world only while one of its two bodies is simulated: between
two keyframed or held bodies (a living actor's ragdoll keyframed to its pose, an object placed
to wait) it is left out and made again from its constraint as a body is let go (a death, a
knock-down, a touch). Rapier solves a joint between two kinematic bodies in every substep all
the same: Helgen's opening spent 3.5 of its 4.8 ms a physics step on the 400 joints of 23
living actors' ragdolls, at three steps a frame. **Breakable** constraints break when the impulse on them in a step exceeds
their threshold: the beehive's 20 holds its 10 kg (1.6 per step at 60 Hz), the mace trap's pin
(30) its 108 kg of chain and mace (17.6); the joint's impulse is not exposed, so it is the
change of momentum of its simulated body that gravity does not explain (TODO(M13): contacts on
the body count too).

Models whose bodies move their nodes one by one (`isArticulated`: constraints, or several
simulated bodies) are drawn on a pose of their own nodes rather than moved as one: every
simulated body places its node (the placement inverted × the body's pose × its rest pose
inverted × the placement × the node's rest), the nodes under it follow; skinned parts take
their bones from the pose, rigid parts hang on their node. Outside actors, 103 vanilla meshes
have simulated bodies on bones (books, amulets, hanging pheasants and rabbits, salmon, pelts,
bows, dead creatures) and 130 have limited hinges (shop signs swing when pushed, the books'
covers, hanging game). Placed objects stay asleep in their placed pose until touched (or settle
as their cell loads, as other loose objects).

**The dead** (ACHR flag 0x200, "starts dead": 1,527 in the load order, 938 of them in interiors
at a new game, mostly draugr, people, Dwemer spiders and skeevers) lie as ragdolls: their race's
skeleton.nif holds a body on each main bone (capsules, 18 for humans) joined by ragdoll and
limited hinge constraints, placed at the actor and articulated like the objects above, so the
skinned body, its armor and head follow the bones. They run no behavior graph and no face. Those
the running game kills lie the same way when their cell loads again (TODO(M12): from the rest
pose; where their bodies lay is the save's); one that dies in sight falls from the pose it had
(its living bodies, keyframed to its pose, are let go: [ai.md](ai.md#movement)). One that had no
bodies living (beyond the high process) gets them in the pose it has as it dies: they were made
in the model's rest pose and let go before their keyframed move reached the pose, so Lokir and
a Stormcloak at Helgen's block stood in their bind pose, balanced, until they slept so. A dead
actor's ragdoll over ground whose collision is not in yet waits for it; one whose actor is made
again (its look changed) moves the new look's pose (that stood in its bind pose over the
corpse). Observed in the
original:

- **The dead bodies' layer.** As a dead actor's Havok is set up, its ragdoll's bodies go to
  L_DEADBIP and become simulated (a living one's stay on L_BIPED, keyframed). By the COLL records
  L_DEADBIP meets clutter, weapons, projectiles, debris and other corpses, and no character
  controller; L_BIPED meets none of those (two corpses on L_BIPED passed through each other).
  Here too, for the placed dead and for every death (`ActorBodies.kill`, the dead player's too).
- **The placed ragdoll pose** (`src/world/ragdoll-data.ts`; XRGD: 28-byte entries of a bone id,
  a position and Euler angles; XRGB: the biped's turn). As the reference's 3D loads without a
  saved Havok state, the entries pose the model's nodes: walking its nodes depth first, every node
  with a collision object takes the next entry, whose bone id must be its body's biped part (its
  collision filter's low five bits), else the walk stops; a BSFadeNode with collision (an attached
  model's root, a clutter item's own root) ends its subtree's walk. An entry sets its node's local
  translation and rotation (the angles made a matrix as a reference's rotation is); XRGB, unless
  zero, turns the root's first child. The bodies are then placed on their nodes. A complete walk
  leaves the ragdoll simulated but at rest (here: held until something touches it); one that
  stopped sets its bodies simulated and awake (they fall from the pose so far). A dead actor with
  no pose is given a downward speed of one unit a second: it settles from its rest pose (here:
  the warm start, unless "Don't Havok Settle"). 1,463 of the 1,527 dead carry a pose; 1,332 walk
  completely on their skeletons (`node tools/ragdoll-info.ts --pose`), the joints' two pivots then
  lying a median 0.35 units apart (in the rest pose the human knees' are 4.3 apart); 33 skeleton
  corpses stop at the jaw (their poses were made before the skeleton's jaw had a body), and two
  corrupt entries (a node millions of units away) are taken as a stop here, as is a pose that
  would tear a joint apart (its pivots 16 units farther apart than at rest: some horses' and
  Dwemer spiders' poses were made on a skeleton whose nodes differ, and their bodies all share
  biped part 0, so the engine's check passes; Rapier snapped such joints together in one step,
  flinging Helgen's dead horse and the carts beside it). A ragdoll held until touched is let go
  as a whole: one body released alone hung, simulated, on its held neighbours' joints and shook. 8,670 objects carry a
  pose too (TODO(M13): not applied to objects yet; single-body clutter's is never applied, its
  body sits on its fade root).
- **Ragdoll penetration** (`src/physics/ragdoll-penetration.ts`, the engine's
  bhkRagdollPenetrationUtil): for [RagdollAnim] fDetectionUpdateTimeSec (5 s) after a dead
  actor's ragdoll is set up, every frame while all its bodies are simulated, each bone is tested
  by a ray from its parent's pivot to its own pivot, and back (the engine's ray interface casts
  both ways), against what L_DEADBIP collides with but the ragdoll itself. A bone whose ray meets
  something, and its descendants, collide with nothing until clear; the bone itself gets an
  impulse at the point met, along the surface's normal, of (fDesiredVel − its speed there along
  the normal) × its mass, at most fImpulseLimit (1.5 Havok units a second, 15) either way. A frame
  with no penetration and the end of the time give every bone its collision back.
- **The death push** (`ActorBodies.push`): the killing blow's force (fDeathForce{Ranged}*, by
  its damage) over fDeathForceMassBase + fDeathForceMassMult × the victim's Mass is a speed every
  body gains along the blow, times its biped part's share: the trunk, neck, head and upper arms
  all of it, forearms and thighs ¾, hands and calves ½, feet ¼, parts 17 to 22 (tails, wings) ¾,
  higher parts none (TODO(M13): the head's 1.5 the engine gives for some hits). It was an impulse
  of the force on every body, which sent hands and feet off at many times the trunk's speed.

How a ragdoll comes to rest: Havok deactivates by place, not by speed (inferred from Havok's
documented behaviour, TODO(M13): the engine's world settings are not read): a body is inactive
while it stays within 0.02 Havok units (and 0.05 radians) of where it last moved, however it
trembles there, and a system of bodies inactive for a second as a whole goes to sleep
(`PhysicsWorld.#deactivate`, checked every quarter second). Rapier sleeps bodies by their speed
alone, so a ragdoll whose limbs shook against a slope or a rock never slept (the Helgen skeleton
flipped its vertical speed 12–31 times a second for half a minute). Also behind the shaking, and
fixed: the landscape is solid from above only (`addMesh` with `ground`: Rapier's fixed internal
edges, which drop contacts from below a triangle and smooth the edges between them), so a foot
that went under the ground is no longer pushed further down while its joint pulls it up; and
trees' collision no longer sways with the wind (a fixed body in the file: only keyframed bodies
follow their nodes; the swaying trunks' kinematic bodies kept every corpse and loose object
against them stirring). Measured in Riverwood with 28 actor types spawned around the player and
killed by script: ragdolls still awake 30 s later 12 (before) → 0 (40 s), most at rest within
5–10 s. `node tools/ragdoll-info.ts [--still]` drops every race skeleton on a floor: 51 of 52
rest within 20 s (TODO(M13): the Dwemer spider keeps stirring: a 50 kg body on a 5 kg hub held
by a nearly rigid joint, under six legs of hinges); `--ref 97D60` lets one placed dead's
ragdoll go from its placed pose (the Khajiit caravan's, which stopped at its tail and shook for
good until the limits were mirrored, now rest within 3 s). A finding
left open (TODO(M13)): Rapier's velocity motor does not hold a torque below its maximum as
Havok's friction does (a 1 kg pendulum on a 1 m arm swings down against a 20 N·m limit), so the
joints' friction does little; the deactivation does what it did for Havok. Also open
(TODO(M13)): an animated pose past a joint's limits as the body is let go snaps back within a step
(Rapier's limits are stiff, Havok's soft): a body may jump 2,000 units a second for a frame.

Measured with the QA runner (docs/qa.md), before (the lead's sweep on main, or the coordinator's
runs of `combat-melee`) and after: the opening's corpse-upright 3 → 1 (Lokir and the Helgen
skeleton lie; one Stormcloak stays), the Helgen skeleton's jitter (42 episodes, 12–31 vertical flips a second for half a minute) →
none; ragdoll velocity spikes 17 (an Imperial soldier's) → 72, 65 of them Helgen's dead horse,
which now lies on L_DEADBIP where MQ101's carts (L_PROPS) run into it;
`combat` physics 0 → 0 with deaths in it; `combat-melee` 20–45 spikes a run and a dead soldier
left standing in two runs → 3 and 18 spikes in two runs, none left standing (one still in its death animation at 5 s). The `deaths` scenario (28 kinds
killed by script on Riverwood's rocky slopes) still shows a few ragdolls trembling against
rocks (static meshes are two-sided triangle meshes: their winding is not consistent enough to
make them one-sided like the landscape).

**Border regions:** in a worldspace with border regions (see
[esm.md](formats/esm.md#border-regions)) movement that would leave them stops at the edge, and
a player pushed or fallen across goes back to the last place inside; the game's notification
"You cannot go that way." (sPlayerLeavingBorderRegion) shows on the HUD in Play
(once while it repeats), in the shell in the sandbox.
