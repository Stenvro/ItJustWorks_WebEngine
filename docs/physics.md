# Physics and the player

How the engine's Havok world is rebuilt on Rapier (`src/physics/`), and how the player moves
and looks (`src/shell/player.ts`, `src/shell/play-session.ts`). Formats:
[nif.md](formats/nif.md#collision), [esm.md](formats/esm.md#collision-layers).

## The world

- **Units:** Rapier runs in Havok units (≈ metres, 1 = 69.99125 game units); the engine's
  own code works in game units and converts at the boundary.
- **Steps:** fixed 1/60 s (`[HAVOK] fMaxTime`), at most 4 per frame; the player's camera is
  interpolated between the last two steps, so 144 Hz screens see smooth motion.
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
  everything in place; Jorrvaskr 3 books (placed over a shelf's edge).
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
other. How far the engine's own TryStep goes is not documented: TODO(M13).

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
- **Speeds** come from the movement types (MOVT): NPCDefault walking and running,
  NPCSprinting (only forward), NPCSneaking, NPCSwimming; `bAlwaysRunByDefault`, Run walks,
  Caps Lock toggles. Air control is not documented: the speed at take-off is kept.
- **Jump:** GMST fJumpHeightMin (76) is the height; with constant gravity the take-off speed
  is √(2 g h). No jumping while sprinting (vanilla blocks it).
- **Swimming:** at a submersion (water depth over the body's height) of 0.69 the body floats
  with its shoulders at the surface; looking down while swimming forward dives. The engine's
  float height (swimFloatHeight) is not documented; 0.69 is the in-game measurement of the
  author of "Wade In Water".
- **The body and its camera** are the player's avatar (animation.md, The player): the
  first-person camera rides the animated Camera1st node (sneaking lowers it), a jump pushes off
  when its animation raises JumpUp. Sprinting drains stamina (docs/gameplay.md). A fall higher
  than fJumpFallHeightMin takes health (fJumpFallHeight\*, the NPCs' ending in "NPC", through
  the perks' Mod Falling Damage; none into water): `src/gameplay/falling.ts`, docs/gameplay.md.

## Cameras and input

- **Input:** the bindings of the game's control map (see
  [controlmap.md](formats/controlmap.md)); mouse look turns `π × fMouseHeadingSensitivity ×
fMouseHeadingXScale` radians per count (× fMouseHeadingYScale vertically).
- **First person:** at the 1st-person skeleton's Camera1st node (120.5 × race height).
  **Third person:** behind the 3rd-person skeleton's Camera3rd node, moved right by
  fOverShoulderPosX and down by fOverShoulderPosZ, at fVanityModeMinDist … fVanityModeMaxDist
  by the zoom (mouse wheel by fMouseWheelZoomIncrement down to fMinCurrentZoom; further in goes
  to first person). A sphere of fCameraCasterSize on L_CAMERA keeps it out of walls.
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
(100) × a scale from fZKeyMaxForceScaleLow (0.2) at fZKeyMaxForceWeightLow (0) to
fZKeyMaxForceScaleHigh (1) at fZKeyMaxForceWeightHigh (150); the weight here is the Havok mass
(the engine's is not documented). The plugins set only fZKeyMaxForce and
fZKeyMaxForceWeightHigh; the other values are the executable's defaults, from a dump of every
game setting (they agree with the plugins on those two). When the held object is left behind
by more than fActivatePickLength it is dropped (the engine's rule is not documented).
TODO(M13): fZKeyHeavyWeight (75), the complex helper's own spring for ragdolls
(fZKeyComplexHelper\*: their defaults live only in the executable and are not documented; a
held ragdoll hangs on the plain spring at the body taken hold of),
fZKeyMaxContactDistance and fZKeyMaxContactMassRatio.

**Constraints and ragdolls** (`physics-world.ts`, `articulation.ts`; the blocks:
formats/nif.md, Collision): a model's constraints become Rapier impulse joints between its
bodies, the two Havok frames as the joint's local frames (axis, perpendiculars, pivot; the
placement's scale on the pivots), and bodies held together do not collide with each other.
Ball and socket → spherical; hinge → revolute; limited hinge → revolute limited to its angles;
prismatic → prismatic limited to its distances; ragdoll → spherical with three angle ranges:
the twist, the swing towards the motor axis within the cone, the swing towards the plane axis
within the cone and the plane limits (TODO(M13): Havok's limit is a cone and two planes); stiff
spring → rope (TODO(M13): a stiff spring also pushes); a chain → a ball and socket per link.
Motors, friction, malleable strength and a chain's tau and damping are not applied (Rapier's
joints are stiff). **Breakable** constraints break when the impulse on them in a step exceeds
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

**The dead** (ACHR flag 0x200, "starts dead": 938 of the actors in interiors at a new game,
mostly draugr, people, Dwemer spiders and skeevers) lie as ragdolls: their race's skeleton.nif
holds a body on each main bone (capsules on the BIPED layer, 18 for humans) joined by ragdoll
and limited hinge constraints, placed at the actor and articulated like the objects above, so
the skinned body, its armor and head follow the bones. They run no behavior graph and no face,
and fall where they lie as their cell settles. 43 of the 49 race skeletons with a ragdoll come
to rest on a floor; the mammoth's, sabre cat's, steam centurion's, netch's and riekling boar's
keep stirring without the constraints' friction (TODO(M13), as above). TODO(M13): the pose a
dead actor's ragdoll starts from when its cell first loads is not documented; here the
skeleton's rest pose. Those the running game kills lie the same way when their cell loads again;
one that dies in sight falls from the pose it had (its living bodies, keyframed to its pose, are
let go: [ai.md](ai.md#movement)).

**Border regions:** in a worldspace with border regions (see
[esm.md](formats/esm.md#border-regions)) movement that would leave them stops at the edge, and
a player pushed or fallen across goes back to the last place inside; the game's notification
"You cannot go that way." (sPlayerLeavingBorderRegion) shows on the HUD in Play
(once while it repeats), in the shell in the sandbox.
