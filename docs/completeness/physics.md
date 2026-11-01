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

## Count (2026-11-01, round 1)

| Part                          | Items | Done | Open |
| ----------------------------- | ----: | ---: | ---: |
| Collision blocks (NIF)        |    26 |   26 |    0 |
| Collision fields (NIF)        |   179 |  172 |    7 |
| Motion systems, qualities     |     8 |    8 |    0 |
| Responses, time, deactivators |     3 |    3 |    0 |
| Body layers, COLL layers      |    24 |   24 |    0 |
| Projectiles (PROJ)            |    24 |   23 |    1 |
| Explosions (EXPL)             |    16 |   15 |    1 |
| Material types, impact data   |    17 |   17 |    0 |
| Game settings (GMST)          |    45 |   32 |   13 |
| Mechanics (by hand)           |    26 |   17 |    9 |
| Total                         |   368 |  337 |   31 |

Round 1 wrote the sweep and this list, and fixed deactivation: Havok deactivates a simulation
island as a whole, ours put a body to sleep on its own while something still moved on it (a
crate with a head rocking in it sank into the ground and fell through it).

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
- [ ] penetrationDepth (14,882 bodies): Havok's allowed penetration depth (when continuous
      collision steps in for a moving body). Ours sweeps bodies by the engine's debris rule
      (`sweptBody`) without it. Next.
- [ ] bhkBlendCollisionObject heirGain, velocityGain (1193): how a keyframed ragdoll bone's
      body follows the animation (hierarchy and velocity gains). Not read.
- [ ] bhkBallSocketConstraintChain constraintForceMixing, maxErrorDistance (6): the chains'
      softness and error limit. Not read.
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
- [ ] EXPL verticalOffsetMult (34 explosions): where above the impact the explosion's centre
      is (its push from below). Not read.
- [x] Material types (MATT): havok id, parent, buoyancy, flags, impact data set, name.
- [x] Impact data (IPDS, IPCT 10 of 10): per material impacts, their duration, angle
      threshold, placement radius, orientation, model, sounds, hazard, flags.

## Game settings

- [x] 32 of 45: fall damage (fJumpFall*), the jump, the swimming breath, the grab and
      telekinesis (fZKey*, fMagicTelekinesis*, fMagicGrabActor*), the gameplay impulses
      (fGameplayImpulseMult*), the explosions' force (fExplosionForceMult*,
      fExplosionSourceRefMult), the death force (fDeathForce*), physics damage
      (fPhysicsDamage1Mass), the lobbed projectiles' friction and restitution (fGrenade*).
- [ ] fJumpFallHeightMultNPC, fJumpFallHeightMinNPC, fJumpFallHeightExponentNPC: NPCs' fall
      damage (NPCs' controllers do not fall-damage yet).
- [ ] fWaterKnockdownSizeSmall, Normal, Large, VeryLarge, fWaterKnockdownVelocity: water
      knocking actors down (a strong current, a waterfall). Not read.
- [ ] fExplosionWaterRadiusRatio, fExplosionSplashRadius: explosions on water.
- [ ] fDeathForceSpellImpactMult: a killing spell's push.
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
- [ ] The paralysed's stiff fall; the keyframed bones' blend gains (above).
- [x] Projectiles' flight: gravity, speed, bounces, sticking, impacts.
- [x] Explosions' impulses (force, falloff, the gameplay impulse settings).
- [ ] An explosion's vertical offset (above).
- [x] Havok materials: impact data per material, footsteps, sounds (MATT, IPDS).
- [x] Water: buoyancy by material, currents, swimming, drowning (src/physics/water-physics.ts).
- [x] Grabbing and telekinesis (src/physics/grab.ts).
- [x] Physics damage (fPhysicsDamage1Mass ...).
- [ ] Physics damage to destructibles from the listener (no vanilla impact reaches it).
- [ ] Objects placed into what they lie on fall through it (340 in the interiors:
      `tools/settle-audit.ts`). TODO(M13).
- [ ] Traps: material, initial flag, cloud traps unchecked.
