# Physics: completeness

What "100" means here: everything the meshes of the archives and the load order's records
(Skyrim.esm, Update, the three DLCs and the Creation Club files of the install) give physics is
read and simulated as the original (Havok 2010) does: every bhk class and field of the meshes
(shapes, constraints, motion types, qualities, layers, phantoms, materials), the collision
layers and their filter matrix, the character controller, ragdolls and their constraints,
projectiles' and explosions' physics, the havok materials (impact data, friction,
restitution), water (buoyancy), and the physics settings.

The data part comes from the sweep `node tools/animation-physics-completeness.ts --area
physics` (`--all` for every item with where it is read; it parses the 11,483 meshes with
collision, under a minute). An item is done when the engine reads it: a block type has a parser
whose node the physics (src/physics, src/shell, src/world, src/render) names; a field the files
set is named there; a value of a census (motion systems, qualities, responses, layers) is
handled; a record field is named outside the file that parses it; a setting is read by a
settings reader or named in the code. A field with one value in every mesh that asks nothing of
the physics counts as done with that reason. The mechanics are kept by hand below, against
docs/physics.md. The count after an item is how many blocks (records) use it.

## Count (2026-11-03, round 7)

| Part                          | Items | Done | Open |
| ----------------------------- | ----: | ---: | ---: |
| Collision blocks (NIF)        |    26 |   26 |    0 |
| Collision fields (NIF)        |   179 |  178 |    1 |
| Motion systems, qualities     |     8 |    8 |    0 |
| Responses, time, deactivators |     3 |    3 |    0 |
| Body layers, COLL layers      |    24 |   24 |    0 |
| Projectiles (PROJ)            |    24 |   23 |    1 |
| Explosions (EXPL)             |    16 |   16 |    0 |
| Material types, impact data   |    17 |   17 |    0 |
| Game settings (GMST)          |    45 |   41 |    4 |
| Mechanics (by hand)           |    28 |   20 |    8 |
| Total                         |   370 |  356 |   14 |

Round 1 wrote the sweep and this list, and fixed deactivation: Havok deactivates a simulation
island as a whole, ours put a body to sleep on its own while something still moved on it (a
crate with a head rocking in it sank into the ground and fell through it).

Round 2 (337 to 344): the bodies' allowed penetration depth in the choice of what is swept, the
explosions' vertical offset, the NPCs' fall settings (read already, by names the sweep did not
find). Next biggest: the blend collision objects' gains (1,193) with the keyframed ragdoll's
blend duration (Havok's hierarchy controller), the chains' softness and error limit, water
knockdowns, objects placed into what they lie on.

Round 3 (344 to 346): the chains' error limit (their links clipped to maxErrorDistance) and
their constraint force mixing (float epsilon in every chain: no softness). Ragdoll joints at
their limits were tried as Havok's soft limits (every angular limit solved before Rapier's step,
corrected by tau of its error a step): a limit solved without the contacts was pushed through
by them in Rapier's step and the ragdolls crept or shook (32 of 52 at rest within 20 s, against
51), and easing every excess of Rapier's own limits changed nothing for Hulda, whose legs lock
at their limits, not past them (docs/physics.md, "The cone"). Next biggest: the blend collision
objects' gains with the keyframed ragdoll's blend duration, Havok's give at four iterations
(Hulda's locked legs), water knockdowns, objects placed into what they lie on.

Round 4 (346 to 348): the blend collision objects' gains, through Havok's hierarchy controller
(src/physics/keyframe-hierarchy.ts): the living's bodies follow their nodes by it (1 and 1:
exactly) and carry their velocity into the ragdoll as it is let go; a ragdoll in the world
driven by its graph's rigid body controls (a creature's get-up, five dying graphs) is driven by
it with their gains (docs/physics.md, "The hierarchy controller"). Not reached: objects placed
into what they lie on, water knockdowns (the size against the current's speed is not
documented), the chains' damping (Rapier's joints have no per-joint softness to give it).
Next biggest: those, and Havok's give at four iterations (Hulda's locked legs).

Round 5 (348 to 354, one item added): water knockdowns, as observed in the original: a current
carries off an actor of a race that walks, flies or does not swim when it is faster than
fWaterKnockdownVelocity × the race size's multiplier (fWaterKnockdownSize\*), or whatever its
speed while the actor falls into it fast (`currentPush`, src/physics/water-physics.ts;
docs/physics.md, "Water"); a ragdoll made dynamic lifts its still bodies (added, done). Read
from the original for Hulda's locked legs: a dead actor's ragdoll keeps its files' constraints
as they are (limits, friction, no motor) in the world's solver, with no solver setting of its
own; with the lift she still stands at 1, 2, 2.5 and 3 s (docs/physics.md, "The cone"). Not
reached: objects placed into what they lie on, the chains' damping. Next biggest: those,
Havok's give at four iterations, the recoiling and the mounted in a weak current.

Round 6 (354 to 356, one item added): water walking, as observed in the original (an actor
with the Water Walking actor value above 0 takes to the water's surface as its body touches
it, and the surface bears it as ground; it does not swim: Character.waterFloor,
src/gameplay/swimming.ts walksOnWater; NPCs and the player); fDeathForceSpellImpactMult was
read already (src/gameplay/combat/combat-settings.ts). Not reached: objects placed into what
they lie on, the chains' damping.

Round 7 (356, unchanged), observed in the original: a cell's load settles its world at once
(the warm start: steps of [HAVOK] fMaxTime until fWarmStartMaxTime, 4 s, without deactivation,
then every island deactivated), its keyframed bodies and the bodies of its "Don't Havok Settle"
references held still (keyframed, without speed) meanwhile and given back their motion after;
a static's or a static collection's bodies are made fixed as it is placed (built: `fix`,
`fixedWhenPlaced`; they waited for a touch before). Not built: the settling at once and the
deactivation at its end (ours settles over the first 4 s of play); the objects placed into what
they lie on and the chains' damping stay open.

## Meshes

- [x] Block types (26 of 26): bhkCollisionObject 13689, bhkRigidBody 11334,
      bhkMoppBvTreeShape 8362, bhkCompressedMeshShape and its data 8214, bhkConvexVerticesShape
      3628, bhkRigidBodyT 3548, bhkBoxShape 3041, bhkCapsuleShape 2342,
      bhkConvexTransformShape 1681, bhkBlendCollisionObject 1193, bhkLimitedHingeConstraint
      823, bhkRagdollConstraint 752, bhkListShape 592, bhkSphereShape 207,
      bhkSimpleShapePhantom and bhkSPCollisionObject 191, bhkTransformShape 95,
      bhkCylinderShape 70, bhkBallAndSocketConstraint 30, bhkNiTriStripsShape 27,
      bhkHingeConstraint 8, bhkBreakableConstraint 8, bhkBallSocketConstraintChain 6,
      bhkStiffSpringConstraint 5, bhkPlaneShape 1 (src/formats/nif/collision-blocks.ts,
      src/physics/collision-data.ts).
- [x] Fields (172 of 179): the bodies' mass, inertia, centre, damping, gravity factor,
      friction, restitution, velocity limits, motion system, quality, solver deactivation,
      filters (layer, biped part, group), the shapes' every dimension, radius, material and
      transform, the meshes' vertices, triangles and welding, the constraints' pivots, axes,
      limits, friction and motors, the breakable's threshold. Rolling friction
      (rollingFrictionMultiplier) is 0 in every mesh.
- [x] collisionResponse (1, simple contact, in every body), timeFactor (1 in every body),
      deactivatorType (1 in every body; bodies come to rest in the original: the world's
      deactivation runs for all): nothing to apply.
- [x] penetrationDepth (14,882 bodies): Havok's allowed penetration depth. A body whose top
      speed covers no more than it in a step is never swept (`sweptBody`; round 2).
      TODO(M13): within a step Havok's time of impact also waits for that depth; Rapier's CCD
      has no per-body depth.
- [x] bhkBlendCollisionObject heirGain, velocityGain (1193; 1 and 1 in all): a living actor's
      bodies follow their nodes by Havok's hierarchy controller with these gains (keyframed
      exactly), and carry the velocity they were moved at into the ragdoll as it is let go
      (src/physics/keyframe-hierarchy.ts, ActorBodies #follow; docs/physics.md, "The hierarchy
      controller"; tests/conformance/animation/ragdoll-switch.test.ts; round 4).
- [x] bhkBallSocketConstraintChain maxErrorDistance (6, 0.1 in every chain): each link's error
      is clipped to it as the constraints' is to the world's (PhysicsWorld.#clipChains; round 3).
- [x] bhkBallSocketConstraintChain constraintForceMixing (6): float epsilon in every chain, no
      softness, as Rapier's joints have none (round 3). TODO(M13): the chains' damping (0.6 in
      every chain) is not applied; Rapier's joints take out all of a link's speed error.
- [ ] bhkRigidBody bodyFlags (1 body): not read.
- [x] Motion systems (2 sphere inertia 319, 3 sphere stabilized 2691, 4 box inertia 2362, 5 box
      stabilized 9510; fixed and keyframed by mass and node): motionOf, inertiaOf.
- [x] Collidable qualities (0 9546, 1 2338, 2 14, 4 2984): the engine's debris rule.
- [x] Body layers (23 used, 0 to 51): every one has a COLL record; the filter matrix is the
      COLL records' (55 layers, symmetric: src/physics/collision-layers.ts).

## Records

- [x] Projectiles (23 of 24): speed, gravity, range, collision radius and layer, impact force,
      explosion, proximity, timer, lifetime, cone spread, relaunch interval, tracer chance,
      flags, model, light, muzzle flash, sound, decal (src/world/projectile-data.ts and its
      readers).
- [ ] PROJ defaultWeaponSource (1 projectile): not read.
- [x] Explosions (15 of 16): force, radius, damage, flags, placed object, spawned projectile,
      image space and its radius, impact data set, model, light, sounds, enchantment.
- [x] EXPL verticalOffsetMult (34 explosions): the push comes from below the explosion's
      centre by that share of its radius (src/scripting/runtime/casting-engine.ts; round 2).
      TODO(M13): the sign and unit are read from the field's name.
- [x] Material types (MATT): havok id, parent, buoyancy, flags, impact data set, name.
- [x] Impact data (IPDS, IPCT 10 of 10): per material impacts, their duration, angle
      threshold, placement radius, orientation, model, sounds, hazard, flags.

## Game settings

- [x] 33 of 45: fall damage (fJumpFall*), the jump, the swimming breath, the grab and
      telekinesis (fZKey*, fMagicTelekinesis*, fMagicGrabActor*), the gameplay impulses
      (fGameplayImpulseMult*), the explosions' force (fExplosionForceMult*,
      fExplosionSourceRefMult), the death force (fDeathForce*), physics damage
      (fPhysicsDamage1Mass), the lobbed projectiles' friction and restitution (fGrenade*).
- [x] fJumpFallHeightMultNPC, fJumpFallHeightMinNPC, fJumpFallHeightExponentNPC: NPCs' fall
      damage (their controllers' landings and ragdolls' get-ups: src/gameplay/falling.ts, read
      by built names until round 2, so the sweep did not find them).
- [x] fWaterKnockdownSizeSmall, Normal, Large, VeryLarge, fWaterKnockdownVelocity: a current
      faster than the velocity × the race size's multiplier carries an actor off, a race that
      only swims never (currentPush, src/physics/water-physics.ts, src/shell/actor-movers.ts;
      round 5). TODO(M13): the recoiling and the mounted in a weak current.
- [ ] fExplosionWaterRadiusRatio, fExplosionSplashRadius: explosions on water.
- [x] fDeathForceSpellImpactMult: a killing spell's push (src/gameplay/combat/combat-settings.ts).
- [ ] fJumpSwimmingMult: a jump out of the water.
- [ ] fMoveWeightMax: the most an actor's walk can push.

## Mechanics (by hand)

- [x] The world: Havok units, gravity, the fixed step and its cap (`[HAVOK] fMaxTime`,
      uMaxNumPhysicsStepsPerUpdate), the solver's iterations.
- [x] Placed collision: every object, the landscape, collision primitives; streamed in.
- [x] Friction and restitution combined as Havok's square root of the product.
- [x] Settling (the warm start), waiting bodies, statics that do not settle, hung objects.
- [x] Deactivation: the distance rule, by island (round 1), solver deactivation.
- [ ] Solver deactivation's relative-speed threshold per class (docs/physics.md). TODO(M13).
- [x] Constraints: ragdoll, limited hinge, hinge, ball and socket, prismatic, stiff spring,
      malleable, breakable, the chain; the ragdoll cone, friction, motors, violation clipping.
- [ ] Violation clipping for hinges, balls and sockets, stiff springs. TODO(M13).
- [x] Continuous collision for small fast bodies (the engine's debris rule).
- [x] Collision layers and the group filter (an object's bodies never collide).
- [x] Triggers and phantoms.
- [ ] Projectiles in flight do not enter triggers.
- [x] The character controller: slopes, stairs, steps, pushing, platforms, falling, swimming.
- [ ] Leaving a moving platform keeps no velocity; Havok's proxy push response.
- [x] Ragdolls: death, hits, powered, keyframed, get-up, penetration recovery, corpses saved.
- [x] A ragdoll made dynamic: each of its bodies moving slower than 0.5 Havok units a second is
      given that much more upward speed (PhysicsWorld.liftStill; round 5).
- [ ] The paralysed's stiff fall; a body let go
      standing on its joints' limits (Hulda killed at the Bannered Mare's counter 1, 2.5 or 3 s
      into her lean stays draped over it: Havok's give at four iterations, which Rapier at 4 or
      5 substeps has only with worse settling; round 3).
- [x] Projectiles' flight: gravity, speed, bounces, sticking, impacts.
- [x] Explosions' impulses (force, falloff, the gameplay impulse settings).
- [x] An explosion's vertical offset (above; round 2).
- [x] Havok materials: impact data per material, footsteps, sounds (MATT, IPDS).
- [x] Water: buoyancy by material, currents, swimming, drowning (src/physics/water-physics.ts).
- [x] Water walking: an actor with Water Walking above 0 takes to the surface as its body
      touches the water, and it bears it as ground (Character.waterFloor, walksOnWater; round
      6). TODO(M13): the original holds it in its controller's own state; here its feet are
      kept from going under the surface.
- [x] Grabbing and telekinesis (src/physics/grab.ts).
- [x] Physics damage (fPhysicsDamage1Mass ...).
- [ ] Physics damage to destructibles from the listener (no vanilla impact reaches it).
- [ ] Objects placed into what they lie on fall through it (340 in the interiors:
      `tools/settle-audit.ts`). Round 7 read the original's warm start (docs/physics.md, "What
      is placed"): nothing in it keeps a penetrating body from leaving through the far side; it
      settles 4 s at once and then deactivates every island. TODO(M13): that end (ours keeps
      simulating what still moves), and Havok's one-sided contacts with meshes (ours are
      two-sided: a body more than half into a surface is pushed out below it).
- [ ] Traps: material, initial flag, cloud traps unchecked.
