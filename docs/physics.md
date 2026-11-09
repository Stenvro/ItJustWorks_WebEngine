# Physics and the player

How the engine's Havok world is rebuilt on Rapier (`src/physics/`), and how the player moves
and looks (`src/shell/player.ts`, `src/shell/play-session.ts`). Formats:
[nif.md](formats/nif.md#collision), [esm.md](formats/esm.md#collision-layers).

## The world

- **Units:** Rapier runs in Havok units (≈ metres, 1 = 69.99125 game units); the engine's
  own code works in game units and converts at the boundary.
- **Steps:** fixed `[HAVOK] fMaxTime` (1/60 s), at most `uMaxNumPhysicsStepsPerUpdate` (3) per
  frame. Observed in the original: a frame hands Havok its time plus the time still owed, at most that many
  steps of it; the rest stays owed (a slow frame is made up in the frames after it, not lost), and
  a frame under a millisecond hands nothing (its time is owed too). Havok then steps fMaxTime
  until its clock reaches what it was handed, so its last step is at or a little ahead of the
  frame's time; the player's camera and the actors are drawn between the last two steps at the
  frame's time, so 144 Hz screens see smooth motion. The step and its cap scale with the world's
  time multiplier (TODO(M13): ours stay at fMaxTime under Slow Time). The engine's "complex"
  mode, fMaxTimeComplex with uMaxNumPhysicsStepsPerUpdateComplex 1, is there
  (`PhysicsWorld.complex`), and nothing turns it on: TODO(M13), what does in the original is not
  identified; fTimePerSubStep and iMinNumSubSteps are read by nothing.
- **The world's bounds** (inferred, TODO(M13): the original's size and what its broad phase's
  border does with an entity were not read): a simulated body past 16,384 Havok units along an
  axis, beyond every worldspace's cells, goes out of the simulation and stays as it is
  (`#leaveBounds`): what fell through everything does not fall on for good.
- **Top speeds:** every simulated body's velocity is clamped after each step to its file's
  maximum linear velocity (Havok units a second) and angular velocity (radians a second), as
  Havok's motions do.
- **Swept bodies** (continuous collision, Rapier's CCD): the engine chooses a body's quality as
  it makes it (observed in the original): a simulated body thicker than `fDebrisMinExtent` (2 Havok units,
  140 game units) along all three axes, or whose top speed is below `fDebrisMaxVelocity` (25
  game units a second), is debris, never swept; of the others, debris quality becomes moving
  (swept against what is fixed) and the rest keep the file's (vanilla files: fixed, keyframed,
  debris and moving). So nearly all clutter is swept; a cart is not. Rapier sweeps against
  everything, not only fixed bodies. A body whose top speed covers no more than its allowed
  penetration depth (bhkRigidBody penetrationDepth, Havok units) in a step is never swept:
  Havok's time of impact steps in only past that depth. TODO(M13): Havok also sweeps by it
  within a step (a TOI only past the depth); Rapier's CCD has no per-body depth.
- **Explosions' push** comes from below the explosion's centre by its Vertical Offset Mult
  (EXPL DATA, 34 vanilla explosions) of its radius (src/scripting/runtime/casting-engine.ts).
  TODO(M13): the sign and the unit are read from the field's name, not observed.
- **Gravity:** 9.8 m/s² downwards. Not documented; it is what mods read from the running
  game (hkpWorld::m_gravity).
- **Collision filter:** every collider has a layer; pairs collide as the COLL records say
  (Rapier's physics hooks for simulated pairs, a filter for queries and the character).
- **Triangle meshes** (the compressed meshes of statics, the landscape) are two-sided, as
  Havok's triangles meet what touches them. Havok's one-sided welding (every vanilla compressed
  mesh, and the landscape) is kept for ragdolls only, by a one-sided copy of each such mesh that
  only bodies on the ragdolls' layers (L_BIPED, L_BIPED_NO_CC, L_DEADBIP) meet, and that queries
  do not see: Rapier's fixed internal edges keep a limb's contacts on the triangles' fronts (a
  limb behind a rock's face is not pushed through it and back), but they drop the contacts of
  many convex hulls lying on a face. With one-sided meshes for all, 3,591 of the 69,455 loose
  objects of the interiors ended more than their size below where they were placed as their
  cells settled (Mistwatch's bear traps, 850 units through the tower's floor); two-sided, 1,091,
  of which 340 went through what they lay on and the rest rolled off it (`tools/settle-audit.ts`).
  TODO(M13): they are mostly objects placed into what they lie on (coins in piles and urns,
  bones, a knife stuck in a table), which the solver pushes out the far side. Holding such a body
  where it was placed (its contact's way out pointing down, 0.02 Havok units deep or more) was
  tried: with it, 130 went through instead of 92 of today's audit, what lay on or in the held
  ones among them (gems in a chest, tomatoes in a basket). Then: 92 of 69,455, 712 rolled off.
- **Welded faces while settling** (`PhysicsWorld.#weld`; inferred from the files' one-sided
  welding, TODO(M13): not observed): most of those 92 were placed deeper than half into a floor,
  a table's top or a cave's ground (berries, notes, bones, a ruined book that a rubble pile's hull
  pressed 27 units down into the floor), and the two-sided triangle put them out at its back. A
  settling body that the step pushes to the back of a welded triangle it may rest on (facing up,
  at most 60° steep) is put out at that triangle's front instead, unless another welded triangle
  it lies in pushes the other way (a dagger through a table's top into its underside); ragdolls
  meet the one-sided copies as before. Nor is a body that stands on something under it: a
  surface that does not move and that it may rest on (a welded triangle by its front), straight
  under its centre of mass, that the solver's push towards the triangle's back takes its lowest
  point onto (no farther under it than that push's depth and 2 units), and that it is not sunk
  into deeper than the triangle's front is over it (the lift, at least 2 units). A chaurus egg in
  Frostflow Abyss on the cave's floor under the edge of a mound's slope [000A439C, 000A439B] was
  put out on the slope and rolled 230 units off; the Blue Palace's bucket [000CC306], 3 units
  over the floor under a bed and its rim 2.5 units up into the bed's frame, was set 28 units up
  onto the frame while the gap was a fixed 2 units. A buried skull in Dustman's Cairn [000F051B],
  5 units out of a hollow dirt mound with the cave's floor some 9 units under it inside, stays in
  the mound's top (a gap as large as the lift let it fall to that floor and roll 125 units off).
  A linen pile on Frostmere Crypt's stairs [000B314E], sunk 4 units into the static linen sheet
  under its centre, was taken to stand on the sheet, slid off it through the hall's wall and fell
  3,184 units; now it lies in the stair's tread it is in. The body is moved after the step, so ray and shape casts
  see its new place after the next one (`queriesCurrent`). The triangles' fronts are read from
  our own collision data, not from Rapier's shape (which copies a mesh's buffers out whole).
  `tools/settle-audit.ts` (articulated objects posed by their XRGD, as the session does: 64,248
  of the 69,455 settle, below) now also counts what ends more than 8 units higher than placed.
  On 2026-11-09 38 fall through and 399 rise (with the fixed 2-unit gap 39 and 411; nothing falls
  with the two bounds that did not before). When the weld came in: without it 81 fell through and
  363 rose; with it 45 fell and 403 rose: of the 52 that
  rise only with it, 8 would have fallen through, and the rest were placed sunk into what they
  lie on and stay sunk without it, but for some that the weld put out on top of what they stand
  under (the bucket above). The support rule (one ray, its two bounds, the 2-unit gap, the side
  of a hit read from Rapier's featureId) is inferred (TODO(M13)). Exteriors (42 cells around Riverwood on
  their landscape) settle alike with and without it. Fort Fellhammer's hand cart [00044727] rolls
  down its ramp with its ore as it did without the weld (then it fell through the ramp; now it
  rolls on; the audit counts it and its six ores among the 38, as a surface lies between where
  they were placed and where they end): its wheels are placed 6 to 10 units into the planks of
  the hall's floor where the ramp starts (MineLHallDetwist01), its frame touches nothing but the
  ramp's edge and the ore placed inside its bed (up to 16 units deep), and its wheels turn freely
  on their plain hinges (no friction or motor in the file); it rolls with the ore taken away
  too. Rapier pushes the wheels out of the planks within 0.2 s, then the cart rolls on them.
  TODO(M13): whether Havok's slower penetration recovery keeps the wheels in the planks until the
  warm start's end deactivates the cart is not known. Open: books pushed out of a cupboard's or
  shelf's back panel (horizontal faces are left as they were), objects over a table's edge,
  overlaps with simulated or keyframed bodies (the hand cart's ore, trapdoors, a chest's lid,
  stacked plates thrown up off their table), and the baskets on nothing at 154 units in the inns
  built of FarmIntInnEnd04 (Nightgate, Moorside, Braidwood).
- **Friction and restitution** combine as Havok's square root of the product (each collider
  gets the square root, Rapier multiplies).
- **What is placed:** the collision of every enabled object in the loaded cells, the
  landscape of each cell (its 33×33 heights as triangles, split like the drawn landscape, on
  L_GROUND), and collision primitives. It goes in a few per frame (3 ms) so loading does not
  stutter. Simulated objects stay asleep until their cell's collision is complete, and that
  of the cells around where they lie (any of the eight being loaded: a shelf of the cell next
  door may hold them), then settle (the warm start) unless "Don't Havok Settle"; their drawn
  model follows the body. A body is simulated only over collision that is in place, as an
  actor is ([ai.md](ai.md#the-actors-of-the-loaded-area)): before, it fell through to the ground under it.
  Large references beyond the loaded grid and distant LOD have no collision, as in the game.
- **What waits:** simulated bodies that do not settle (not yet: until their cell's collision
  is complete; for good: "Don't Havok Settle", and statics) stay where they were placed until
  something that moves touches them (the player's shape, an object in motion) or the player
  takes hold of them; then they fall and roll like any item. Havok leaves a deactivated body
  alone until an active one touches it; Rapier wakes a sleeping body at its first contact,
  even with the wall it hangs on, so waiting bodies are kinematic until touched (they meet
  nothing fixed and cost nothing).
- **Statics are fixed:** a STAT or SCOL whose model has simulated bodies (the "...Static"
  clutter such as GlazedCandlesStatic, mounted antlers, the "...ForDisplay" weapons on
  Jorrvaskr's and Dragonsreach's walls) has its bodies made fixed as it is placed (observed in
  the original: its reference's collision, once in the world, is set to the fixed motion
  type; `fixedWhenPlaced`, `PhysicsWorld.fix`): nothing knocks them over. Settled, Dragonsreach's
  antlers fell 600 units off its walls; only 13 of 379 such statics carry "Don't Havok Settle".
- **The warm start, observed in the original:** as a cell is set up, its world is stepped at
  once at [HAVOK] fMaxTime (1/60 s) until [HAVOK] fWarmStartMaxTime (4 s) has passed, with
  deactivation off (bAllowDeactivationWhileWarmStarting 0; with it on, the stepping would stop
  once nothing moves), and then every island still active is deactivated. Meanwhile the bodies
  of its references that are keyframed, and every moving body of a reference flagged "Don't
  Havok Settle", are held: made keyframed with no speed, then given back their motion type and
  any speed they had. Ours settles over the first fWarmStartMaxTime of play instead (above): our
  deactivation leaves what settles be until then (Rapier's own sleeping still puts a settling
  body to sleep once it has rested a second by the rule below, `#holdAwake`) and leaves what still moves at its end moving. TODO(M13): the settling at once, and the
  deactivation at its end: putting to sleep what still moves at the 4 s of `tools/settle-audit.ts` took
  the objects of the interiors that go through what they lie on from 92 to 159 (a sleeping body's
  contacts drop while what lies on it still moves, as under "Deactivation by island").
- **Weapon racks** are the game's own WeaponRackActivateSCRIPT (docs/scripting.md): as its
  cell attaches, the rack takes the reference it links to without a keyword, checks it against
  its RackType (1: anything but a shield; 2: a shield; 3: neither a dagger, a shield nor a
  bow), sets its motion type to keyframed (the body stops waiting for a touch) and moves it to
  its trigger's pivot node for its type (MoveToNode: the node's place in the trigger's model).
- **Settling without throwing:** what a placement overlaps (book corners in a shelf's back
  panel, a cover into the board under it) is pushed out by the solver; for the first half
  second after a body is set to settle its speed is taken away after every step, so the push
  only moves it (Havok recovers penetrations slowly; Rapier's push sent Jorrvaskr's books
  off their shelves). TODO(M13): the original takes no speed away (its warm start, above, is
  plain stepping); Rapier's push out is the harder one. Settled over 10 s:
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
[ai.md](ai.md#movement)): once the cell's collision is complete, a ray straight down from 32
units above where the actor stands (its reference, where a script moved it, where it came through
a door, or where its package has it: [ai.md](ai.md#where-packages-put-actors)), on what the
character controller collides with, gives the feet's height. **The engine's position check**
(observed in the original) looks for what an actor stands on from a quarter of its height
above its feet, at most 32 units, down to fCheckPositionFallDistance (72) below them; the 32 here
are a human's quarter. It matters where a navmesh lies under the collision it covers: by Whiterun's
shops the navmesh is 20–25 units under the porch floors, and from 16 (or, for a controller made for
an actor walking in from beyond the high process, 24) units above a door marker or a navmesh point
the ray started under the floor and found the ground beneath it: Nazeem, Anoriath and Ahlam came
out of a door inside a porch and walked on the spot in it for minutes. A controller made for an
actor (`ActorMovers`) is set on its floor by the same check, from its own height. The controller
falls, so the
ground may be any distance below: leveled animals and bandits in the wilderness are placed up
to 120 units above it. Races that tilt lean with the ground's normal there: RACE DATA flag 0x8
"tilt front/back" (four-legged animals) about their sideways axis, 0x10 "tilt left/right"
(spiders, chaurus, mudcrabs, mammoths) about their length too; others stay upright.

**Leaning as they move** (observed in the original: its quadruped orientation controller,
`bhkQuadOrientationController`; ours `probedTilt` and `easeTilt` in `src/world/actor-ground.ts`,
run by `src/shell/actor-movers.ts`). A moving actor whose race tilts does not take the normal of
the ground under its middle: the engine probes the ground under the two ends of its controller
(ahead and behind by half its length, from its radius above its feet, a ray 2.5 Havok units, 175
game units, down; its contact points, where it has them, give the heights too, each averaged
with the height its end had), and its pitch is the angle whose tangent is their height difference
over its length less its two radii, clamped to 47° (a built-in constant); the roll the same across
for races that tilt left and right. Ours has no contact points: its rays start as high as the
steepest lean reaches over its length, so the uphill end meets the surface there (from its radius
above its feet, that ray began under a road on a slope and met what lies below it, at another depth
at every probe). The lean is not taken at once: every update it moves towards
the probed one by [HAVOK] fQuadrupedPitchMult (10) times the update's time of what is left, and
falls back to upright the same way for a race that does not tilt that way. Bipeds lean by their
support's normal (the engine's biped orientation controller, the same clamp and ease); no vanilla
biped race tilts.

Ours (inferred where the engine's numbers were not read): the probes at the ends of its bound
(the skeleton's "BBX": half its length ahead and behind, half its width aside), the height
difference over the distance between them (over its length less its radii, the engine's formula
with the bound's length, a horse leaned 1.45 times as steep as its road); probed again as it moves
4 units or turns 0.05 radians, eased every frame. A probe passes other actors and what its
controller passes (its cart), and a rock it starts inside is met where it leaves it (Havok's rays
pass what they start in). Without contact points, an uphill end on a steep slope starts under the
ground (a road met from below) and meets nothing: it is cast again from as high as a 47° lean
reaches over its half length, and with nothing either way that end is level with its feet (taken
as 175 units down, a cart horse reared 37° for a third of a second where the road to Helgen
steepens).

Measured in the opening's ride to Helgen (four horses, the carts' and the riders', every frame
over 40 to 60 s): before, a horse's drawn pitch jumped up to 70° in one frame (it took the normal
of the one ground triangle under its middle as it crossed onto it, every 4 units), swung by 6° or
more 0.55 to 0.83 times a second, in 5 to 10 of 40 seconds twice or more (QA `rocking`,
docs/qa.md), and averaged 13° to 20° nose down; it rocked as it walked. Now its pitch changes by
at most 3 to 5.5° in a frame (5° a second on average), swings by 6° 0.2 to 0.3 times a second (in
0 to 3 of 60 seconds twice), and averages 13° to 15° nose down, the road's own slope.

Races that do not walk (0x100 "walks" unset: slaughterfish) stay where they were placed, as do actors in
the furniture their package uses (the furniture holds them) and actors with nothing under
them (placed in a cell their package takes them out of).

**Out of the world.** An actor whose controller is in the air with no collision anywhere under it
(it went through a floor or the landscape) would fall for ever. Ours looks under a falling actor
every half second of its fall; with nothing there it is set back on the navmesh nearest where it
last stood (else there), on the floor the position check finds, and its way is searched again
(`ActorMovers.#watchFall`). TODO(M13): the engine's own rule was not found: no setting, debug text
or message names it (its warp after repeated path failures, "FailSafe Warp", is the pathing's:
[ai.md](ai.md#movement)). Actors beyond the high process have no controller and do not fall:
their walk keeps them on the navmesh.

**Not on each other.** An NPC's controller does not stand on another actor's
(`CharacterBody.standsOnActors` off): held up by an actor alone (nothing else within a stair's
height, 32 units, under its feet, by a ray down from its middle or its shape cast down, while its
shape rests on another actor's, or it is still coming off one) it is not grounded and moves off
that actor at least 100 units a second as it falls; a step up never lands on an actor. Brushing
past another, its lower shape a little up the other's, it still stands on the floor. One whose fall another actor stops (placed into it: the player set at Highmoon Hall's coc marker where Gorm stood held him 63 units up) is held up by it the same way, and is moved out of what it overlaps first. The player stands on heads, as in the game. TODO(M13): Havok's character
proxy's own rule was not read; NPCs are not seen standing on one another in the game.

## Where coc puts the player

Observed in the original (`src/world/coc-spot.ts`, `src/shell/cell-placement.ts`): the
console's centeroncell starts an exterior cell at its middle on the landscape, an interior cell at
its origin, and looks through the cell's references in order (deleted ones left out; in an
exterior, the worldspace's persistent references in its square and its own, each only if it stands
in the cell's square). It takes the first COCMarkerHeading (place and rotation), else the first
XMarkerHeading (place and rotation), else the first XMarker (place), else the arrival point of the
first door that leads into the cell (where its linked door here sends one; place), else the first
static (place), else the last reference looked at (place). An exterior spot is then raised to the
landscape and to the cell's water if it lies under them (bDefaultCOCPlacement, off, would skip the
references and keep the middle). The player falls from there onto what is below.

Before, an exterior used only a COCMarkerHeading of its own (not the persistent ones, where most of
them are) and else its middle 64 units over the landscape: Riften's North put the player in the
masonry under the walkway, Windhelm's market 12,000 units over the market (the landscape of the
Windhelm worldspace lies far above the city floor there), and interiors always at the door in.
`node tools/coc-audit.ts` checks every named cell's spot against its navmesh (on: a triangle
under it within 48 units of its height; high: the nearest under it lower; under: above it;
none: no navmesh under it); of the 2,378 named cells:

| cells                  | on    | high | under | none |
| ---------------------- | ----- | ---- | ----- | ---- |
| 1,617 exterior, before | 781   | 334  | 84    | 418  |
| exterior, now          | 1,245 | 83   | 19    | 270  |
| 761 interior, before   | 679   | 5    | 4     | 73   |
| interior, now          | 700   | 10   | 10    | 41   |

The 10 interiors now "under" have their marker where no navmesh lies at its
height (behind a shop's counter, a COC marker set a little low in a cave); the engine takes those
markers as well.

## Water volumes

Swimming and the sound under water test where water can be entered
(`src/world/water-volumes.ts`): a water activator's (ACTI WNAM) WATER-layer phantoms
([nif.md](formats/nif.md#water-volumes)), and the cell's water plane where it lies above the
landscape (no bottom). Water without a volume is only seen and heard.

## Water

`src/physics/water-physics.ts`, one step hook of the play (`PlaySession.water`). Our rules where
the engine's are not documented (TODO(M13)):

- **Buoyancy.** A simulated body is lifted by (1 + b) × ρ × V × s × g: b its material's buoyancy
  (MATT BNAM, −1 .. 1: stone and metal −1, Wood 0.25, Light Wood and baskets 0.5, a book 1), V
  its volume with the shapes' convex radius (Rapier's volume leaves it out: a log's hull of
  0.011 m³ is 0.025 m³ with its 2.5-unit shell), s its share under the surface (taken as a cube
  of its volume round its centre of mass), ρ 1000 kg/m³. It floats where that meets its weight
  (s = m / ((1 + b) ρ V)), else sinks. Ragdoll bones (L_BIPED, L_BIPED_NO_CC, a corpse's
  L_DEADBIP) take `fBuoyancyMultBody` (1) for the trunk and the head, `fBuoyancyMultExtremity`
  (−0.3) for the limbs. A flat hull has no core: its shell is its volume (an iron ingot's came
  out as no number at all, its material lost, and it floated).
- **Waterfalls** (inferred, TODO(M13): CommonLibSSE names the original's waterfall shape,
  BGSWaterCollisionManager::bhkWaterfall, a phantom; which models get one, its way and its pull
  were not read): the vanilla falling water (FXWaterfallBody\*, FXWaterfallThin\*) has a fixed
  convex body of the Water material on L_STATIC, where other water lies on L_WATER. What touches
  one is pulled down towards [HAVOK] fDefaultWaterfallCurrentVelocity (6 Havok units a second) at
  the water's drag.
- **Current.** The water drags what is in it towards its velocity at 1.5/s × s (2/s for the
  spin), which also damps the bobbing. A type's velocity is WATR NAM0/NAM1 (Havok units/s; 35 of
  the 58 vanilla types). Types with Enable Flowmap (RiverWaterFlow: Riverwood's river) flow
  along their cell's flow map (`src/world/flow-map.ts`) at 160 units/s. The map's R/G direction
  is smooth across the river; its alpha is striped from texel to texel, so the physics leaves it
  out.
- **An actor in a current** (observed in the original: the water's current applied to a
  character; `currentPush`, run for every moved actor in water in `ActorMovers`): a race that
  swims but neither walks nor flies keeps its place. Any other is carried off by a current
  faster than `fWaterKnockdownVelocity` (10 Havok units/s) × its race size's multiplier
  (`fWaterKnockdownSizeSmall` 0.25, `Normal` 0.5, `Large` 0.75, `VeryLarge` 1), or by any
  current while it falls into the water faster than 700 units/s in the air; a weak current then
  carries it at its speed plus the actor's own, at most the actor's top speed. The carry is the
  controller's push (`Character.knockBack`: kept while it is the strongest), for the step.
  TODO(M13): the original also carries an actor in recoil, and one whose mount is in the air, by
  a weak current; whether the push's speed is the current's or the current's over the step is
  inferred (the current's).
- **Water walking** (observed in the original: the actor's update, for a living actor whose
  Water Walking actor value is above 0): it takes to the surface as any of its body goes under
  it (a hundredth of its height), and performs ActionWaterwalkStart as it does (the vampire
  lord's WaterWalkStart); from then the surface bears it as ground and it never swims. Here the
  controller keeps its feet from going under the surface (`Character.waterFloor`), and it stays
  on it while its feet are within 2 units over it (`walksOnWater`, src/gameplay/swimming.ts),
  for NPCs (`ActorMovers`) and the player. Vanilla gives it by AbWaterwalking and a Creation
  Club potion. TODO(M13): the original holds it in a state of its controller; how high over the
  surface it stays on it is ours.
- **Splashes.** A body or an actor coming into the water downwards, or out of it upwards,
  splashes by its vertical speed × `fSplashSoundVelocityMult` (× `fSplashSoundOutMult` coming out)
  against `fSplashSoundLight` / `Medium` / `Heavy` (5, 25, 50), at most once per
  `fSplashSoundTimer`. The sound is its material's impact against the water's material (WATR
  TNAM, else Water) through the impact sounds, the model (`sSplashParticles` at
  `fSplashScale1..3`) at the surface (`onSplash`).

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

Off an edge of the ground: held by nothing but walkable ground (every contact of the sweep faces
up within the walkable slope) and getting nowhere (under 5 % of the way), the movement is swept
again from 0.02 Havok units (1.4 game units) higher, the snap to the ground bringing it down.
Ustengrav's safe fire plates are slabs 5 units high sunk a unit into the floor, their bevel
steeper than walkable; standing on one's edge, Rapier's sweep met that edge at once on every
slide, whichever way the player went, and they stuck there for good (the stairs past the fire
plates in Ustengrav02). Havok's character proxy walks off such an edge (TODO(M13): its own
handling of edges was not read).

Held in the gap the controller keeps to a wall (a hair nearer than its 0.01 Havok units), the
sweep and every slide meet that wall at once, whichever way it goes: the shape is set out of the
gap and swept again (`#outOfSkin`). On the ground that is a step getting nowhere across; in the
air, one getting nowhere at all. Ustengrav's door before the Horn's hall (NorWoodDoor01) swung
open as the player stepped through it; they hung beside its leaf 14 units over the floor,
falling ever faster without moving, until the air was taken in too
(`src/physics/character-gap.test.ts`).

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
  `fUnsupportedGravMult` (4) while standing on something too steep (sliding off). Rapier's
  controller calls anything less steep than a wall ground, so a character that came down on a
  face of 75° stood on it for good: too steep is no ground now, and it slides off, no faster than
  the face lets it. The contact alone does not say: a cone on a stair's or a ledge's edge meets it
  at the cone's own slope, so the faces under the shape's middle and ring are asked too, and only
  with none of them walkable is it on a slope (`#onWalkable`; `tools/stairs-audit.ts` walks Bleak
  Falls Barrow's 363 stairs and ramps the same with it as without it, and of Helgen Keep's 112 and
  Whiterun's 78 walks only those at shut doors and gates stop). TODO(M13): a jump is not asked for
  while it slides; Havok's proxy's own support check
  (bUseUnsupportedCast, fUnsupportCastLength) was not read.
- **Two characters** (inferred, TODO(M13): CommonLibSSE names the proxy's character interaction,
  the controller's push delta and count, kNotPushable; their numbers were not read): one walking
  into another gives it a share of the speed it closes at by their masses (`bumpSpeed`: its
  actor's Mass × 100 kg), into the push a moving body gives (`#bump`), so it moves off.
  [HAVOK] bAllowCharacterBumper off, or either's bumper off (its graph's DisableBumper), and they
  only block each other.
- **Warp** (inferred, TODO(M13): the setting's use is read from its name and the controller's
  position setter's "force warp"): whatever sets an actor further than
  √[HAVOK] fCharControllerWarpDistSqr (2449 units) from its controller has its controller set
  there at once; nearer, the controller goes on from where it is (`beyondWarp`, `ActorMovers`).
- **A good position** (inferred, TODO(M13): CommonLibSSE's TryMoveTo names the settings; what the
  original sets down by it was not read): the shape set down lies no deeper than [HAVOK]
  fGoodPosCheckDepth (0.1 Havok units) in anything (`goodPosition`), with TryMoveTo's cast on the
  way (`tryMoveTo`). A rider gets off on the horse's other side, then behind it, where a wall
  leaves no room at the dismount's end; a stuck actor is not set down where it is no good.
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
- **Jump:** GMST fJumpHeightMin (Skyrim.esm 76, built in 64) is the height, times the actor's
  scale, fJumpSwimmingMult out of the water, and its Jumping Bonus's share (`jumpHeight`;
  TODO(M13): the bonus as a percent is inferred; no vanilla effect sets it); with constant gravity
  the take-off speed is √(2 g h). An actor's graph's JumpBegin (the horse's jumpBegin as its jump
  starts) jumps its controller as the player's does (`ActorMovers.jump`); the human clips' JumpUp
  has no handler in the actors' response file, but jumps an NPC's controller as it pushes the
  player off (the dispatch's listener; TODO(M13): inferred, what in the original answers it is not
  known). No jumping while sprinting (vanilla blocks it). A
  sprint goes on in the air (a jump, a step down) until the fall is faster than
  fJumpFallVelocityMin (Skyrim.esm 700 units a second; the engine's sprint, observed in the original).
  The jump is asked for on the ground (the input) and pushes off when its animation raises
  JumpUp, on the ground or not by then (`CharacterBody.jump`): a step down or a stair's edge in
  between left the controller ungrounded for a step, the push-off was dropped, and the graph,
  in its jump state with no fall to land from (ActionLand needs one), hung in its jump pose on
  the stairs (the player "floating").
- **Step velocity:** an actor's measured speed (what its graph is told through the motion
  feedback) is its controller's last step's (`CharacterBody.stepVelocity`), the same on every
  frame until the next step. Measured over each frame, a frame without a step read as a stop and
  one with two as double speed (a display faster than the 60 steps a second, a frame a little
  short of a step), and the graphs' Speed flickered.
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

**Automatic doors** (DOOR FNAM 0x02: AutoLoadDoor01, a marker with neither collision nor a
crosshair prompt, at the ends of caves such as Helgen Keep's) are not activated by the crosshair.
Observed in the original: as such a door's 3D loads it watches the player's distance; within
fAutoDoorDisplayDistance (700) its destination is shown, and coming within
fAutoDoorActivateDistance (350) the screen fades for fAutoDoorFadeSecs (INI General, 0.5) and the
door is activated with the player as activator (its scripts first), unless they ride
(sNotAllowedToUseAutoDoorsWhileonHorse instead). Here `PlaySession` watches the distance from
the player's feet each frame (`autoDoors`, `walksThrough` in play-session.ts); a door the player
arrives by (loaded already within the distance) does not send them back. TODO(M13): the display
distance's text; the fade drawn (only its time passes); whether the distance is taken from the
feet or the character's middle.

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
door: 25 units in front of it, where the shape reaches 32). Other actors' controllers are not
part of that: a controller inside another (deeper than two of its gaps) leaves it in its steps
as Havok's proxy solves against a penetrating contact's plane, which moves out at its depth
times the proxy's penetration recovery speed (hkpCharacterProxyCinfo's default, 1 a second):
along the way out (centre from centre; two on one spot each the opposite way, the pair's way
taken from their references) it goes at least that fast, walking off freely and never further
in, and its sweep leaves that actor out. Rapier's controller, started inside another
controller, moved out by the whole depth in one step, the other the same way: three Greybeards
set at one door's arrival point went off together at some 1,800 units a second and over High
Hrothgar's ledge (`src/physics/character-overlap.test.ts`). A body that moves into the shape (a
door's leaf swinging shut over the player) has it put out the same way, by the whole depth and
unswept; what stands fixed stops that movement (`CharacterBody`'s `#heldByFixed`), or it goes
through the wall beside the door into the wall's hollow, and moves no more. The rays leave out the player's
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
Ball and socket → spherical; hinge → revolute; limited hinge → revolute limited to its angles
(eased as Havok's soft limits are: below); prismatic → prismatic limited to its distances;
ragdoll → spherical with three angle ranges: the twist, the swing towards the motor axis within
the cone, the swing towards the plane axis within the cone and the plane limits, a box the
constraint solver narrows to Havok's cone (below; TODO(M13): Havok's two planes are measured as
the second body's twist axis's angle to the plane, Rapier's swing about the axis); the
hinges' and the ragdolls' twist and plane angles are mirrored, as Rapier measures a joint's
turn the other way round from the files' limits (`node tools/ragdoll-info.ts --limits`: of
12,149 limited hinges in the 1,257 complete placed ragdoll poses, the Creation Kit's settled
Havok state, 60 % lie within their limits unmirrored and 97 % mirrored; the plane angles 90 %
and 97 %; unmirrored, knees and elbows bent only backwards, and a dying pose's bent knee
started past its limit and snapped); stiff
spring → rope (TODO(M13): a stiff spring also pushes); a chain → a ball and socket per link.

**The solver** (observed in the original): the engine makes its Havok world with Havok's
medium solver (tau 0.6, damping 1, four iterations, one microstep), a maximum constraint
violation of 0.05 Havok units (Havok's own is unbounded), an unbounded contact resting
velocity, a collision tolerance of 0.1 and no activation of bodies whose transform is set.
Every step it sets the solver again: with r the step over [HAVOK] fMaxTime × the time
multiplier, tau is 0.6 × (fHavokTauRatio × r + 1 − fHavokTauRatio) (GMST, 0.5) and the
iterations the larger of 4 and 3.9 × the time multiplier, rounded up, times r, at least 2; at
the engine's own step that is tau 0.6 and four iterations (`constraint-solver.ts`,
`solverSettings`; `PhysicsWorld.solver`). Havok's ragdoll constraint makes its twist, cone and
plane limits with a tau factor of 0.8 and its limited hinge its angle limit with 1 (the files do
not set it): a violated limit is brought back by tau × that share of its error a step. The world
info's gravity is 9.81 down (TODO(M13): GRAVITY is 9.8, as mods read it from the running
game; the hkpWorld may be given another later). What Rapier's joints cannot do as Havok's, the
constraint solver does before each Rapier step (`constraint-solver.ts`):

- **Friction:** a ragdoll's and a limited hinge's maximum friction torque (an absolute torque in
  Havok's units, kg·m²/s²: every race skeleton's ragdoll joints have 10, its hinges 0.01) holds
  the joint's relative turn still about each of its first body's frame axes (a ragdoll's three,
  a hinge's axle) up to that torque × the step, solved with the joint's pivot (the velocities of
  its two points kept together) and with the step's gravity speed already added, four times in
  turn per iteration (a limb turns most of all about its pivot: solved once each they converged
  so slowly that a held limb crept down). A limb whose weight pulls less than the friction stays
  (`constraint-solver.test.ts`: a 1 kg rod 1 m long, 4.9 N·m, held by 6 sinks under a degree in
  two seconds), one that pulls more swings down. Rapier's velocity motors cannot hold a torque:
  with any gain and any maximum a pendulum swung down as against a damper. Rapier adds gravity in
  each of its substeps and moves the bodies after each, so over a step a body moves as if it
  went at its speed plus (n + 1) / 2n of the step's gravity speed (n substeps): solved with all
  of it a held limb rose, with none it sank (`gravityShare`). A prismatic's friction is still a
  motor (TODO(M13): it does little).
- **Soft limits:** Rapier's limits are stiff (an error is gone within a step). A joint whose
  angle lies more than 0.05 radians past a limit as it is made (a dying actor's animated pose let
  go, a placed pose) has that limit moved to tau × its tau factor of the way from the angle back
  to it every step until the angle is within (`easedLimit`, `PhysicsWorld.#easeLimits`). A joint
  changed wakes its bodies (and changed while asleep, its bodies woke and fell through the
  ground they lay on): only changes are set, never while both its bodies sleep. The eased bounds
  only close in (what pushes a joint further past them does not widen them).
  Eased from any excess (not only past 0.05 radians), and with every angular limit solved in
  the constraint solver before Rapier's step instead of Rapier's (the limits' push back taken
  off after it), the ragdolls do not settle: a limit solved without the contacts is pushed
  through by them within Rapier's step (a chicken's ankle 40° past its cone at rest), and its
  push back, left in or taken off, kept the bodies creeping or shaking (32 of 52 race skeletons
  at rest within 20 s). Easing every excess changes nothing for a body standing on its joints'
  limits (Hulda below): they lie at their limits, not past them.
- **Error clipping:** Havok clips a constraint's positional error to the world's maximum
  constraint violation (0.05 Havok units, above): a ragdoll or limited hinge joint whose two
  pivots lie farther apart (a ragdoll pulled apart: a limb pushed out of a rock the rest lies in)
  has its second pivot moved for the step to that distance from the first, along the way
  between them, so that it comes back by at most that much a step (`#clipViolation`); Rapier
  corrects all of it at once, and Lokir's corpse, half under a rock as Alduin's landing woke
  it, was flung about for five minutes. The large ragdolls settle later for it (the undead
  dragon's, the Dwemer spider's, the gargoyle's within 26–32 s on a floor). A chain's links
  (bhkBallSocketConstraintChain: the traps' ropes and chains, 6 in the data) are clipped to the
  chain's own maxErrorDistance (0.1 in every chain), hinges, balls and sockets and stiff springs
  (past their length) to the world's (`#clipLinks`).
- **Solver deactivation:** the engine's world (Havok's) slows slow bodies further: a body of
  solver deactivation class low, medium, high or max (the file's; every race skeleton's bodies
  are low) moving slower than 0.01, 0.017, 0.02, 0.025 × g (Havok units a second, g the
  gravity's strength) and turning slower than that × 0.1 g has its velocities multiplied in each
  of the solver's iterations by 1 − 8, 11.8, 15, 16 × 0.016 over the iterations (`slowBodyFactor`,
  after each step: a slow low-class body loses an eighth of its speed a step). TODO(M13): Havok
  slows a body only while its speed relative to its neighbours is also below a threshold per
  class (0.05, 0.02, 0.013, 0.01 at four iterations; how it is measured is not known).
- **Deactivation by island:** Havok deactivates a simulation island (the awake bodies joined
  by contacts and constraints) as a whole: no body of it sleeps while another still moves
  (`contactIslands` in `#deactivate`). Put to sleep on its own, a body under something still
  moving kept being moved by it but solved no contact with what held it up: MQ101's head
  basket (an open crate) with the severed head rocking in it sank into the ground under it and,
  seconds later, fell through it, the head with it (`physics-world.test.ts`, "one simulation
  island").

- **The cone:** Havok's ragdoll constraint keeps the second body's twist axis within its cone
  (coneMaxAngle) of the first's; Rapier's limits are a box of two swings, as wide as the cone on
  each axis and wider on its diagonals (by up to √2). A ragdoll joint whose twist axes lie
  further apart than the cone is turned back about the line across them, by tau × the ragdoll
  limits' tau factor of the excess a step (pushed back only). Hulda, killed still where she
  leans at the Bannered Mare's counter (a Ragdoll death, no blow), stayed asleep on her feet,
  her hips and knees in the box but past the cone and held there by their friction; with the
  cone she slumps to the floor (`ragdolls-death.test.ts`) when killed 0.5 or 5 s into her lean
  idle. Killed at 1 to 4.5 s her upper body tips onto the counter while her hips bend to
  their limit and her knees straighten to theirs, her feet flat at the ankles' limit: her legs
  stand as a locked strut and she stays draped over the counter (head at 96–99 units). It is
  the solver's give, not the limits' softness: Rapier at 4 or 5 substeps (the original's world
  solves with four iterations) leaves the strut loose enough to buckle and she slumps in every
  phase, but the race skeletons' ragdolls then settle worse (`node tools/ragdoll-info.ts`: at 5,
  46 of 52 still and 47 of 52 pushed rest within 20 s, at 4 46 and 46, against 51 and 48 at 8;
  Rapier's internal iterations at 2 stiffen it again). Lifting her out of the floor her animated
  feet start 6 units into, or her joints' friction at 0 or 1.5 times, does not change it.
  Observed in the original (round 5): a dead actor's ragdoll is set up with nothing of its own.
  Its constraints are its files' (the behavior's ragdoll takes the mesh's constraint data as it
  is: the limits, their tau factors, the friction, no motor), solved in the world's solver
  (above: no per-ragdoll tau, damping or iterations), and made dynamic it is only woken and its
  still bodies lifted (below). With today's joints and that lift, Rapier at four substeps keeps
  her standing too (head at 91–93 units at 1, 2, 2.5 and 3 s; 44 of 52 still and 45 of 52 pushed
  at rest within 20 s); only two substeps buckle the strut. The foot capsules point 36° toe
  down at the skeleton's rest, and the ankle's limit (3.6°) leaves them 5° short of flat: a
  foot pressed flat holds its calf leaning back, the knee behind the line from hip to ankle,
  locked at its limit. Traced at 1, 2 and 3 s (and swept at 1 to 4.5 s): within a second of the
  kill her feet are pressed flat onto that limit and her knees straightened to theirs, then her
  thighs spread to their plane limits and every joint of her legs lies at a limit, the hips at the
  cone. Her bodies fall asleep about 2 s after the kill, but sleep is not what holds her: kept
  from sleeping (bodies created unable to sleep, and the solver deactivation off) she still stands
  5 s on. That one limit
  decides it: 8° more dorsiflexion and she slumps at 1 and 2 s (at 3 s her other knee stays
  locked). The placed ragdoll poses (the Creation Kit's settled Havok state) lie past their
  limits often (`node tools/ragdoll-info.ts --limits`, mirrored, of the 1,257 complete poses;
  the tool prints each joint's limits as the file gives them, lower the minimum angle, upper
  the maximum): of 1,992 ankles (NPC Foot to NPC Calf, -34° to 3.6°) 83 past the upper limit,
  the dorsiflexion's, by more than 1° and 23 by more than 5° (240 and 161 past the lower); of
  2,034 knees (NPC Calf to NPC Thigh, -110° bent to 0° straight, as skeleton.nif and
  skeleton_female.nif both give it) 38 and 9 past the straight limit, the upper one (82 and 5
  past the bent one); of 2,002 elbows (0° to 110°) 424 and 15 past the 0° limit; of 1,842
  shoulders' planes (-75° to 5°) 384 and 141 past the 5° limit. So Havok's limits give under a
  corpse's own weight, by a few degrees and in some poses far more, the knees' straight side
  and the ankles' dorsiflexion among them. Tried and not kept: a give in proportion to the load
  a limit carries (the load's torque impulse × the step over the iterations × the joint's own
  inertia × tau, as a Gauss-Seidel solve of a light link under a heavy load in four iterations
  falls short). The load was read twice, from the step's change of momentum of each side of the
  joint less gravity and its contacts' normal impulses (the contacts' friction impulses were not
  read), and the two readings never agreed: from her foot's side her ankle and her knee came out
  at about 3 N·m pressed on their limits, from the other side (through the counter's contacts)
  about 50 times more, and which of the two is nearer is not known (the floor's friction on her
  feet is missing from the one, the counter's from the other). The give took the lesser of the
  two readings, and none where they did not both press the limit, so at her ankle it was at most
  what 3 N·m earns, a fraction of a degree, by construction, far from the 8° that let her slump.
  The race skeletons settled a little worse with it (49, 48 and 48 of 52 at rest within 20 s,
  still, pushed and lifted, against 51, 48 and 50). This rules out that reading of the load, not
  a give of Havok's limits under her load. TODO(M13): the load her ankles and knees carry at
  their limits is unmeasured (the two readings disputed, the contacts' friction not counted);
  with it measured, whether her limits' give at four iterations buckles the strut, or something
  other than the limits does.
- **Made dynamic** (observed in the original: the behavior's ragdoll driver set to dynamic):
  every body of it that is then of a dynamic motion type and moves slower than 0.5 Havok units
  a second is activated and given 0.5 Havok units a second more upward speed, so that nothing
  let go still stays as it was placed (`PhysicsWorld.liftStill`, after the bodies take their
  keyframed velocities in `ActorBodies`, at a death's or a knock-down's let-go; that these are
  the moments the driver is set dynamic is inferred). `node tools/ragdoll-info.ts --lift` lifts
  the dropped skeletons too: 49 of 52 still and 50 of 52 pushed at rest within 20 s, against 51
  and 48 without.
- **Motors** (the powered ragdoll: Havok's position motors, as the behavior graph's
  hkbPoweredRagdollControlsModifier sets them; no constraint in the files has an enabled one):
  a powered joint pulls its second body's turn relative to its first toward the turn the
  graph's pose gives the two (`PhysicsWorld.power`, `JointMotor`): the turn left (a rotation
  vector) is recovered at tau of it a step, no faster than proportionalRecoveryVelocity × its
  angle + constantRecoveryVelocity, damping that share of the speed's error, with at most
  maxForce × the step about each axis; a powered joint's friction gives way to its motor. A
  knocked-down actor's ragdoll is powered by its graph's control data every frame (its pose
  of that frame as the target, the bones it names; `ActorBodies`): FullyRagdoll's 0 leaves it
  limp, matching the get-up's first pose (200) pulls its limbs toward it before the get-up
  blends from it; powered bodies are kept awake. TODO(M13): Havok's controller drives the
  ragdoll's root by its world-from-model mode, not done; the paralysed's stiff fall. A dying
  graph's powered bones: the engine's ragdoll drive, below.

**The engine's ragdoll drive** (`src/physics/ragdoll-anim.ts`; [RagdollAnim] INI settings, the
engine's built-in defaults, no shipped INI sets them): a hierarchy controller's control data
(fHierarchyGain 0.17, fVelocityDamping 0, fAccelerationGain 1, fVelocityGain 0.6, fPositionGain
0.05, fPositionMaxLinearVelocity 14, fPositionMaxAngularVelocity 18, fSnapGain 0.1,
fSnapMaxLinearVelocity 3, fSnapMaxAngularVelocity 0.3, fSnapMaxLinearDistance 0.3,
fSnapMaxAngularDistance 1: Havok's default gains; the snap's angular velocity limit is Havok's
too, 0.3; the other limits are Havok's 1.4, 1.8, 0.3, 0.03 and 0.1 times ten) and the hits'
feedback (bRagdollFeedback 1, fFeedbackImpulseMult 500, fFeedbackOnOffGain 0.3,
fFeedbackOnOffGainTimeMS 1000, fFeedbackTimeMS 10000). Their use is inferred from their names
(TODO(M13)):

- **Powered bones**: a dying actor's ragdoll driven by its graph (after AddRagdollToWorld) whose
  graph powers bones of it (force above 0) has those bones (all, when it names none) simulated
  and pulled toward the pose by these gains, its keyframe bones modifiers' bones hard; no
  vanilla dying graph does (AnimateToRagdoll keyframes). FullyRagdoll's force 0 lets the death
  go limp as before; a knocked-down actor's get-up keeps its motors.
- **bAlwaysDriveRagdoll** ([Animation], 0): with it on, a living actor's ragdoll is driven by
  its graph as a dying one's is (the check of what the graph drives answers yes at once:
  observed in the original): simulated where its graph's rigid body controls are active,
  keyframed to the pose where not (that some of Hulda's states as she stands and leans at the
  Bannered Mare's counter have them active is expected, not yet seen in a run: the feedback case
  in `tests/conformance/animation/ragdolls-death.test.ts` waits up to 20 s for one); turned
  off, the living's bodies are keyframed again. The [Animation] and
  [RagdollAnim] settings are read each frame (the player's changes apply at once, the feedback's
  to a ragdoll already hit too).
- **Feedback**: a blow that does not kill, on an actor whose ragdoll is driven with bodies
  simulated, pushes the body nearest where the blow landed (combat's hit point) by
  fFeedbackImpulseMult along the blow (game units of momentum, made Havok's by dividing by the
  world scale: 7.1 Havok units, about 1.4 m/s on a 5 kg forearm), and the drive's gains go to
  fFeedbackOnOffGain of their own over fFeedbackOnOffGainTimeMS, stay there until fFeedbackTimeMS
  after the hit, and come back over fFeedbackOnOffGainTimeMS. A further hit holds them down for
  the full fFeedbackTimeMS from itself, going on down from where they are (no jump back up). The
  feedback belongs to the drive: once the ragdoll is driven no more (a get-up over, the INI's
  drive turned off, let go limp) it is gone, so a blow on a knocked-down actor's get-up yields
  that get-up only.

**The hierarchy controller** (`src/physics/keyframe-hierarchy.ts`: Havok's
hkaKeyFrameHierarchyUtility, as its rigid body ragdoll controller runs it) drives a ragdoll's
bodies toward an animated pose by velocities instead of moving them there. Per body, parents
first: the keyframe's own velocity (its pose against its last); hierarchy matching (the
velocity that keeps its pose relative to its parent body where the parent goes this step, by
hierarchyGain; the root against the world); velocity matching (damped by velocityDamping, toward
velocityGain × that by accelerationGain); position matching (positionGain of the error a step,
at most positionMaxLinear/AngularVelocity) and snapping (snapGain on the error taken at most
snapMaxLinear/AngularDistance, at most the snap velocities). With full gains a body is on its
pose each step (the tests check it). TODO(M13): the order Havok sums its stages in is not
documented. It runs in two places (`ActorBodies`):

- **The living's bodies** follow their nodes by it with their blend collision objects' gains
  (bhkBlendCollisionObject heirGain, velocityGain: 1 and 1 in all 1,193 bodies of the data:
  keyframed exactly), keeping the velocity they were moved at. Let go (a death, a knock-down),
  every body carries that velocity into the ragdoll, as a keyframed Havok body does: the
  ragdoll goes on from the pose as the animation moved it, without a stop
  (`tests/conformance/animation/ragdoll-switch.test.ts`: Hulda's hand, 40 units a second in
  her lean, goes on so).
- **A ragdoll in the world driven by its graph** (AddRagdollToWorld while dying, until
  RemoveRagdollFromWorld or limp; a knocked-down actor rising, until it is up): while the
  graph's hkbRigidBodyRagdollControlsModifier is active and no powered ragdoll controls are
  (FullyRagdoll's limp takes precedence), its bodies are simulated; the bones its keyframe
  bones modifiers name are keyframed hard (full gains), the others are driven by the
  modifier's control data (Havok's defaults in 49 of 55 graphs: hierarchy 0.17, velocity 0.6,
  position 0.05; the draugr's and four others' softer), blended in from their own motion over
  its durationToBlend (0.5 s in every graph). Its controls lie in 23 graphs' GetUpFromRagdoll
  (the bear's upper body rises driven, its lower body keyframed), five AnimateToRagdoll states
  and the root states (where the ragdoll is not in the world). Without them, the bodies
  follow the pose as the living's do. TODO(M13): whether the original then lets them go limp,
  and whether it draws the driven bones from their bodies (here the graph's pose is drawn).

A chain's tau (1), damping (0.6 in every chain) and constraint force mixing (float epsilon), and
a malleable constraint's strength (Havok's virtual mass factor: each of its rows takes that share
of its impulse in an iteration), are applied where the engine solves as Havok does: a breakable
joint's group (below) and, for a malleable ragdoll or limited hinge, its friction, motor and
cone rows. A chain's links carry its damping in the world too (PhysicsWorld.#dampChains):
Havok solves them as one block, each of the four iterations taking 0.6 of the way from their
pivots' relative velocity to the one that closes tau of their error, so a step leaves
q = 0.4⁴ = 2.6% of the speed error and the pivots end it q × (error + speed error × step)
apart. Before each step that error is solved as Havok's solver leaves it (joint-impulses.ts,
from the bodies' velocities with gravity's of the step and the error the link has now; clipped
to the chain's maxErrorDistance) and each link's second anchor is moved by it, so that Rapier,
whose joints close all of their error, holds the pivots that far apart. A vanilla link hanging
still keeps q / (1 − q) × g × step² between its pivots (7e-5 Havok units, 0.005 game units),
more as the chain swings or is pushed; the anchor is set again only when it moves by more than
a tenth of that, so what hangs still sleeps. TODO(M13): inferred from Havok's documented
solver; the chain is solved on its own, not with the other constraints of its island (the
mace's pin). TODO(M13): a malleable joint's pivot and limits (Rapier has no per-joint softness;
no vanilla model has a malleable constraint). A joint is in the world only while one of its two bodies is simulated: between
two keyframed or held bodies (a living actor's ragdoll keyframed to its pose, an object placed
to wait) it is left out and made again from its constraint as a body is let go (a death, a
knock-down, a touch). Rapier solves a joint between two kinematic bodies in every substep all
the same: Helgen's opening spent 3.5 of its 4.8 ms a physics step on the 400 joints of 23
living actors' ragdolls, at three steps a frame. **Breakable** constraints break when the impulse on them in a step exceeds
their threshold: the beehive's 20 holds its 10 kg (1.6 per step at 60 Hz), the mace trap's pin
(30) its mace and the pull of the chain the mace hangs by (17 to 19 a step). Havok's measure
(hkpBreakableConstraintData) is the solver results of the constraint it wraps: the impulses its
rows took over the step's solver iterations, the root of the sum of their squares weighed
against the threshold (a hinge's two angular rows count with its three linear ones). Rapier
does not expose its joints' impulses, so a breakable ball and socket or hinge is solved before
each step as Havok's solver would solve it (src/physics/joint-impulses.ts) with every point
joint reached through simulated bodies: the world solver's iterations (four), tau (0.6) and
damping (1); a chain's links as one block with the chain's own tau, damping and constraint
force mixing; a hinge's angular rows; a malleable constraint's strength. The velocities solved
are what moved the bodies since the last step (gravity's speed of the step, a script's push),
and the error tau corrects is what the solve itself left over the steps (clipped to a chain's
maxErrorDistance): Rapier's chains drift apart a little every step, and that is no load. A
body's own change of momentum measured only the sum of what holds it: the chain's pull
cancelled out of the mace's, and the pin never broke. The stiff springs (the beehives) still
take their body's change of momentum. TODO(M13): inferred from Havok's documented solver;
contacts on the bodies are not in the solve. The mace (TrapMace01, MaceTrap): simulated
(SetMotionType 1) it hangs on its pin; fireTrap's first push (ApplyHavokImpulse 15: 3.2 on each
link, on L_PROPS, 4.8 on the mace, on L_TRAP) pulls the chain taut and the pin takes 48 in
that step (a rigid solve of the group gave 69; with damping 1 for the chain, 58): it breaks
there, and the second (50) pushes the mace already let go down past its base. A push of 6 or
more breaks it.

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
the running game kills lie the same way when their cell loads again, where their ragdolls laid
them (below: the corpse pose); one that dies in sight falls from the pose it had
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
- **Where a corpse is.** A dead actor is where its ragdoll carried it: one killed in the air
  (a dragon struck down in flight, Actor.Kill on a flier) is where it fell to, for its distance
  to others and its scripts' GetPosition (`ActorStage.livePlacement`: its placement moved by
  its ragdoll's first body's way since it went limp, `ActorBodies.moved`). Before, it stayed
  where it died, in the air, while its ragdoll lay on the ground. TODO(M13): the point of the
  ragdoll the engine's reference follows.
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
  as a whole: one body released alone hung, simulated, on its held neighbours' joints and shook.
  8,670 objects carry a pose too (armour on the floor, open books, hanging game): an articulated
  object's is walked the same way over its model's nodes (`poseObjectRagdoll` in
  src/world/ragdoll-data.ts; XRGB turns only an actor's biped), its bodies placed on its posed
  nodes, a complete walk leaving it at rest until touched and a stopped one settling; 7,534 apply
  completely, 1,131 have no model with a pose order (`node tools/ragdoll-info.ts --pose`).
  Single-body clutter's is never applied (its body sits on its fade root). `tools/settle-audit.ts`
  poses them the same way: left in their models' rest pose and settled, open books on wall
  shelves lay in the shelf and were put out into the wall above (the Blue Palace's
  [000CC006, 000CC007], Jorgen and Lami's house's [00105449]).
- **The corpse pose** (`src/animation/corpse-pose.ts`): the original keeps a corpse's Havok
  state with its reference; here, as a dead actor leaves the stage (its cell unloads) and as the
  game is saved, the nodes its ragdoll placed (those not where their parents and the skeleton
  put them) are kept in the world in its ActorState (`corpse`: saved with the game state,
  dropped with the actor's state by a cell's reset). As its cell loads again (or the save
  loads) its ragdoll is posed so before its XRGD, and lies at rest until touched if it lay at
  rest (else it falls on); a corpse still dying by its graph is not kept (it falls anew).
  `tests/sim-corpse-pose.int.test.ts`: Hulda knocked over and saved lies where she lay after the
  load (363 units off without it). TODO(M13): what of a corpse's Havok state the original keeps
  (its bodies' velocities, whether it was asleep) is not read.
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

How a ragdoll comes to rest: Havok deactivates by place, not by speed: a body is inactive while
it stays within the world's deactivation reference distance (observed in the original: its
world info keeps Havok's 0.02 Havok units; from it Havok derives, per deactivation class, a
frequent check within that distance and a turn of twice it, and a rarer one within four times
it and a turn of eight times it) of where it last moved, however it trembles there, and a
system of bodies inactive for a second as a whole goes to sleep (`PhysicsWorld.#deactivate`,
checked every quarter second, within 0.02 units and 0.05 radians; TODO(M13): how often Havok
runs its two checks and for how many frames a body must pass them are not read). Before that,
Havok's solver slows a slow body down (solver deactivation, above). Rapier sleeps bodies by their
speed alone, so a ragdoll whose limbs shook against a slope or a rock never slept (the Helgen
skeleton flipped its vertical speed 12–31 times a second for half a minute), and a body sliding
or turning slowly (under 0.1 units or about 0.1 radians a second) was put to sleep after half a
second, still moving. Rapier's sleeping is held to the rule (`PhysicsWorld.#holdAwake`): each
check starts Rapier's half-second timer over for every body not yet inactive for a second, and
a body Rapier puts to sleep before the rule would (one woken between checks) is woken again
with its speed, with what it touches (`tests/conformance/physics/deactivation.test.ts`).
Settling Whiterun's 27 interiors (`node tools/settle-audit.ts whiterun`) leaves the same 2
fallen and 17 dropped off; a settling cell steps longer with more bodies awake, as they now
rest a second before they sleep, not half of one (mean step over the first 4 s, Jorrvaskr
2.4 → 3.6 ms, Dragonsreach 4.8 → 6.1 ms, the Bannered Mare 2.5 → 3.7 ms; from 6 s on Jorrvaskr
and the Bannered Mare as before, while Dragonsreach keeps 11 bodies awake past 10 s, all asleep
by 20 s: 0.4 → 0.8 ms over 10–20 s). Also behind the
shaking, and fixed: the landscape is solid from above only (`addMesh` with `ground`: Rapier's
fixed internal edges, which drop contacts from below a triangle and smooth the edges between
them), so a foot that went under the ground is no longer pushed further down while its joint
pulls it up; static meshes are one-sided the same way (read from the data: every vanilla
compressed mesh, the 6,298 of architecture, dungeons, clutter and landscape objects, has
Havok's welding type 0, anticlockwise: one-sided welding, met from its triangles' anticlockwise
fronts and smooth across their edges; their winding is consistent, 99.1–99.8 % of their shared
edges run opposite ways, and of the rocks' flat triangles 94 % of the area faces up; a
mirroring transform turns the triangles over to keep their fronts), so a limb that got behind a
rock's face is pushed out to its front rather than back and forth; and
trees' collision no longer sways with the wind (a fixed body in the file: only keyframed bodies
follow their nodes; the swaying trunks' kinematic bodies kept every corpse and loose object
against them stirring). Measured in Riverwood with 28 actor types spawned around the player and
killed by script: ragdolls still awake 30 s later 12 (before) → 0 (40 s), most at rest within
5–10 s. `node tools/ragdoll-info.ts [--still]` drops every race skeleton on a floor: 50 of 52
rest within 20 s, all let go still within 40 s (`--seconds 40`: the undead dragon, the Dwemer spider, which
lands on its legs and keeps one swinging free on its hinges, and the gargoyle take 26–32 s;
pushed, the spider keeps swinging);
`--ref 97D60` lets one placed dead's ragdoll go
from its placed pose (the Khajiit caravan's, which stopped at its tail and shook for good until
the limits were mirrored, now rest within 3 s).

Measured with the QA runner (docs/qa.md), before (the lead's sweep on main, or the coordinator's
runs of `combat-melee`) and after: the opening's corpse-upright 3 → 1 (Lokir and the Helgen
skeleton lie; one Stormcloak stays), the Helgen skeleton's jitter (42 episodes, 12–31 vertical flips a second for half a minute) →
none; ragdoll velocity spikes 17 (an Imperial soldier's) → 72, 65 of them Helgen's dead horse,
which now lies on L_DEADBIP where MQ101's carts (L_PROPS) run into it;
`combat` physics 0 → 0 with deaths in it; `combat-melee` 20–45 spikes a run and a dead soldier
left standing in two runs → 3 and 18 spikes in two runs, none left standing (one still in its death animation at 5 s).

The constraint solver, the soft limits, the error clipping, the solver deactivation and the
one-sided static meshes, measured with the QA runner against the build before them (the same
monitors): `deaths` (28 kinds killed by script on Riverwood's slopes and river banks) physics
anomalies 232 and 160 in two runs → 9, 12 and 4 in three (vertical velocity flips 166 and 144 →
4, 0 and 0; ragdolls still stirring after 20 s 8 and 6 → 3, 2 and 2); the `opening` (on main
5e0019f, its carts fixed) 0 physics anomalies through MQ101 stage 160 and the keep (Lokir, the
Stormcloak at the block and the Helgen skeleton lie; before the error clipping, Lokir's corpse
was flung about for five minutes); the Khajiit caravan's cell (`at-POIPineForest23`) 43 → 1
and 3 (no spikes or trembling; its Khajiit 97D60 and horse, whose poses fall from where they stop,
asleep within 30 s); `creature-combat` 3 → 0, `combat-melee` 0 → 0, Bleak Falls Barrow 0 →
0, Dragonsreach 0 → 0. Left: the scenario's mammoth is placed against a fallen log, its ragdoll
propped on it and stirring in some runs (as before); hanging game (pheasants, rabbits) on its
limited hinges still trembles for a few seconds as its cell loads.

**Border regions:** in a worldspace with border regions (see
[esm.md](formats/esm.md#border-regions)) movement that would leave them stops at the edge, and
a player pushed or fallen across goes back to the last place inside; the game's notification
"You cannot go that way." (sPlayerLeavingBorderRegion) shows on the HUD in Play
(once while it repeats), in the shell in the sandbox.
