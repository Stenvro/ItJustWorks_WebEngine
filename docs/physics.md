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
- **Keyframed bodies** (door leaves) follow their node in the sequence the object plays.

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
calibrate both against the game. Walking up stairs is slow: before a step is climbed, the
lower cone rides up its edge as up a slope of about 52°, and Rapier's controller moves along a
slope at cos² of its angle (about 40 % of walking speed on Breezehome's stairs; running
climbs them at full height). Havok keeps the speed along the surface; moving the wanted
movement onto the surface here, or treating stair edges as steps, made the controller stick
on the edges instead. TODO(M13): stairs at walking speed (how the engine uses the stairs
material).

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
- **TODO(M7):** the player's body (third person shows no one yet), the camera on the animated
  Camera1st node (sneaking lowers it), ragdolls and constraints. **TODO(M11):** fall damage
  (fJumpFallHeight*), stamina for sprinting.

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
Open and Close sequences. The prompt is the shell's until the game's HUD: TODO(M9), as are
loading screens.

**Arriving** through a door, the player waits (in place, the camera free to look) until the
collision of the cell and the eight around it is in place — a street, bridge or porch may
belong to a neighbour — and then until its floor is found between 16 units above the arrival
point (below porch roofs and door frames) and 96 below; after 10 s it is placed at the door's
own height. The rays leave out the player's own shape (it stands at the arrival point already)
and phantoms (trigger volumes), as the character controller does. While walking, a player
whose cell's collision has not loaded yet waits instead of falling through. Of 15 sampled
doors into Tamriel and the cities, 14 now land on the floor and stay; the trapdoor of
Lakeview Manor's unbuilt tower has no floor until it is built (TODO(M8): building states).

**Grabbing:** Activate on a loose (simulated) object waits `[Controls] fZKeyDelay` (0.2 s): let
go before that, it activates; held longer, the player takes hold of the object where the
crosshair's sphere touched it, until Activate is let go (`src/physics/grab.ts`). Never actors
(bAllowHavokGrabTheLiving 0). The engine hangs the object on Havok's mouse spring
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
by more than fActivatePickLength it is dropped (the engine's rule is not documented). Not yet:
fZKeyHeavyWeight (75) and the complex helper (fZKeyComplexHelper*, for ragdolls: TODO(M7)),
fZKeyMaxContactDistance and fZKeyMaxContactMassRatio (TODO(M13)).

**Border regions:** in a worldspace with border regions (see
[esm.md](formats/esm.md#border-regions)) movement that would leave them stops at the edge, and
a player pushed or fallen across goes back to the last place inside; the game's notification
"You cannot go that way." (sPlayerLeavingBorderRegion) shows in the shell until the HUD's own
(TODO(M9)).
