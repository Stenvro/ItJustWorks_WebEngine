# NIF (Skyrim Special Edition)

Implementation: `src/formats/nif/`. Little-endian. Sources: niftools `nif.xml`, NifSkope.

Verified on all 22,761 vanilla meshes: every supported block is consumed byte for byte
(`node tools/nif-stats.ts --parse` reports 0 problems).

## Versions

- Header line `Gamebryo File Format, Version 20.2.0.7` + `\n`, then version `0x14020007`,
  endian byte (1 = little), user version **12**, block count.
- Bethesda stream header: BS version **100** for SSE. One vanilla file still has BS 83
  (Skyrim LE); the parser handles the few BS-version conditions that differ.
- Export strings in the BS header: u8 length **including** the null, then the characters.

## Header layout after the BS header

| Field             | Type                        |
| ----------------- | --------------------------- |
| block type count  | u16                         |
| block types       | SizedString (u32 + chars)   |
| block type index  | u16 per block (mask 0x7FFF) |
| block sizes       | u32 per block               |
| string count      | u32                         |
| max string length | u32                         |
| strings           | SizedString                 |
| group count       | u32, then u32 per group     |

Because every block size is known, unsupported block types are skipped safely and each
supported parser is checked to consume its block exactly. A block that fails is reported
in `NifFile.problems` and kept as `unknown`; the rest of the file stays usable.

Footer: u32 root count + i32 refs. Refs are block indices; −1 = none. Strings in blocks
are i32 indices into the header string table (−1 = empty).

## Notable fields

- **NiAVObject**: flags u32 (BS > 26), translation, rotation as 9 floats **row by row**
  (Gamebryo streams `m[row][col]` and applies `v' = R·v`), scale, collision ref. No
  property list for BS > 34.
- **NiNode**: children refs, then effects refs (BS < 130). Subclasses add trailing fields
  (NiSwitchNode: flags u16 + active index u32; NiBillboardNode: mode u16; BSTreeNode:
  two bone lists; BSMultiBoundNode: ref + culling mode; BSOrderedNode: vec4 + byte;
  BSValueNode: i32 + byte; BSRangeNode family: 3 bytes; NiLODNode: ref;
  BSMasterParticleSystem: u16 + refs).
- **BSLightingShaderProperty**: the **shader type (u32) comes before** the NiObjectNET
  fields (nif.xml declares it inside NiObjectNET with `onlyT`). Extra fields per shader
  type: 1 env map scale; 5 skin tint; 6 hair tint; 7 parallax passes + scale; 11 multi-layer
  (4 values incl. a vec2); 14 sparkle vec4; 16 eye cubemap scale + two reflection centers.
- **BSEffectShaderProperty**: source texture and greyscale texture are SizedStrings; four
  bytes (clamp mode, lighting influence, env map min LOD, unused) sit between them and the
  falloff floats.
- **NiAlphaProperty**: flags u16 (bit 0 blend, bits 1-4 src, 5-8 dst, bit 9 test, 10-12 test
  function) + threshold u8.

## BSTriShape (SSE geometry)

After NiAVObject: bounding sphere (vec3 + radius), skin ref, shader ref, alpha ref,
BSVertexDesc (u64), triangle count (**u16** for BS < 130), vertex count u16, data size u32,
then (if data size > 0) the vertex data and u16 triangles. SSE then has a **particle data
size** u32 (and half-precision particle geometry if non-zero).

Data size is always `vertexCount × stride + triangleCount × 6`; the parser checks it.

BSVertexDesc (u64): low nibbles = stride/4, then offsets/4 for UV, UV2, normal, tangent,
color, skinning, landscape data, eye data; **bits 44-55** are the attribute flags
(vertex 0x1, UV 0x2, normal 0x8, tangent 0x10, colors 0x20, skinned 0x40, eye 0x100,
full precision 0x400). SSE always stores positions as 3 floats, followed by the bitangent X
float when tangents are present.

Per-vertex layout (SSE): position f32×3, bitangent X f32, UV f16×2, normal u8×3 + bitangent
Y, tangent u8×3 + bitangent Z, color u8×4, skin weights f16×4 + indices u8×4, eye data f32.
Normals and tangents map 0..255 to −1..1. The raw buffer goes to the GPU unchanged.

Skinned shapes have data size 0: their vertices live in NiSkinPartition (one shared vertex
buffer, the partitions' triangles index it directly). The bone indices of a vertex index the
NiSkinInstance's bone list (not the partition's). BSDismemberSkinInstance adds per partition
its part flags (u16: 0x1 editor visible, 0x100 starts a set) and body part (u16: a biped slot
30-61, or 130-161 / 230-261 for the same slots on head parts): equipment hides the partitions
of slots another piece owns (esm.md, Actors); a bone's matrix is its node's model-space
matrix times the NiSkinData bind transform of that bone (skin space → bone space). The
vertices go to the GPU as stored and are skinned there (rendering.md, Skinning).
BSDynamicTriShape (faces) appends a u32 byte size and xyzw float positions.

## NiTriShape / NiTriShapeData (older geometry, 246 vanilla blocks)

NiTriShape: data ref, skin ref, material data (count, string refs, extra data, active
index, needs-update byte), shader ref, alpha ref. BSLODTriShape adds three u32 LOD sizes.

NiTriShapeData: group id, vertex count u16, keep/compress flags, vertices, data flags u16,
material CRC u32 (BS > 34), normals (+ tangents and bitangents if data flags & 0x1000),
bounding sphere, vertex colors (RGBA floats), **one** UV set if data flags & 1,
consistency flags, additional data ref, triangle count, triangle point count, triangles,
match groups.

## Hidden objects

- Objects named `EditorMarker` (any block type) are helper geometry for the Creation Kit,
  e.g. activator trigger volumes; the engine never draws them (1,012 vanilla meshes have one).
- BSXFlags bit `0x20` on the root (editor marker) hides the whole model.
- The **root node's own transform is ignored** by the engine: placing the object replaces it.
  866 vanilla meshes have a rotated root and 96 a translated one (e.g. Raven Rock's
  `redoranhutintcap01.nif` is turned 90°; applying it leaves gaps between the hut pieces).
- Base objects with record flag `0x800000` (is marker) are never drawn (see esm.md).

## Animation

Objects animate through controllers (`src/formats/nif/animation-blocks.ts`,
`src/render/animation.ts`). Every vanilla mesh parses (`node tools/nif-stats.ts --parse`).

- **NiTimeController** (base of all controllers): next controller ref, flags u16 (bits 1-2
  cycle type: 0 loop, 1 reverse, 2 clamp; `0x8` active; `0x20` manager controlled), frequency,
  phase, start time, stop time (f32), target ptr. Controller time = time × frequency + phase,
  wrapped into start..stop by the cycle type.
- Single-interpolator controllers add an interpolator ref (NiTransformController,
  NiVisController, NiAlphaController, BSNiAlphaPropertyTestRefController, ...). The shader
  controllers (BSEffect/BSLightingShaderPropertyFloat/ColorController) add the controlled
  variable u32: effect floats 0 emissive multiple, 1–4 falloff start/stop angle and opacity, 5
  alpha, 6 U offset, 7 U scale, 8 V offset, 9 V scale; lighting floats 0 refraction strength, 8
  environment map scale, 9 glossiness, 10 specular strength, 11 emissive multiple, 12 alpha,
  20–23 U/V offset/scale; colours: effect 0 emissive, lighting 0 specular, 1 emissive.
  NiMultiTargetTransformController has no interpolator: u16 count + target ptrs.
  NiPSys*Ctlr add a modifier name; NiPSysEmitterCtlr also a visibility interpolator.
- **NiControllerManager:** cumulative u8, sequences (ref list), object palette ref.
  **NiControllerSequence:** name, controlled blocks (u32 count, u32 array grow by; each:
  interpolator ref, controller ref, priority u8, node name / property type / controller type /
  controller id / interpolator id strings), weight, text keys ref, cycle type u32, frequency,
  start, stop, manager ptr, accum root name, u16 + anim note refs.
- **Interpolators:** float (value + NiFloatData), transform (translation, rotation quaternion
  w x y z, scale + NiTransformData; components of ±FLT_MAX are unset), point3 (+ NiPosData),
  bool / bool timeline (u8 + NiBoolData), blend interpolators (flags u8, array size u8, weight
  threshold; unless manager controlled the blend items; then the value for float/bool/point3).
- **Keys** (KeyGroup): u32 count, u32 key type if count > 0 (1 linear, 2 quadratic with forward
  and backward tangents, 3 TBC with tension/bias/continuity, 4 XYZ rotation, 5 constant), then
  time + value per key. **Quadratic:** a segment leaves its first key along that key's
  _backward_ tangent and arrives at the next key along its _forward_ one (as NifSkope reads
  them, despite the names). The data agrees: of the 64957 quadratic key groups in the vanilla
  meshes, 6113 first keys set only the backward tangent (189 only the forward one) and 4166
  last keys only the forward one (466 only the backward one). The UV scrolls of waterfalls,
  fire and lava are 0 → −1 with tangents −1: a steady scroll this way, a stop-and-go ease the
  other way. NiTransformData: rotation keys (quaternions; type 4: three float key
  groups for X, Y and Z instead), translations, scales.

**What plays:** active controllers that no manager drives, and the sequences of the model's
NiControllerManager that its **behavior graph** plays when the mesh names one on its root
(BSBehaviorGraphExtraData: name, graph file under `meshes\`, controls base skeleton u8; 1251
vanilla meshes; [hkx.md](hkx.md), [animation.md](../animation.md)). Without a graph the
first of the sequences Idle, AutoLoop, SpecialIdle, Waiting, mLoop, mIdle, AnimIdle,
AnimIdle01, Loop, AmIdle plays (of the 413 graph-less meshes with a manager, the banners'
SpecialIdle, the waterwheels' Idle and two single ones; AmIdle: the resting state of
furniture-like objects; most other sequences are played by scripts or activation: doors'
Open/Close). Around Whiterun 173 draws animate: waterfall foam scrolling, embers pulsing,
signs and props. Skinned meshes whose bones these controllers move (245 outside actors:
banners, flags, Sovngarde's drapery, Blackreach's giant mushrooms) wave with them through
GPU skinning.

**Sequences played on demand** (`buildSequences`): the other sequences of a controller manager
(a door's Open and Close) are kept by lower-case name with the scene graph they move, their
clock (start, stop, frequency, cycle type) and text keys; with a behavior graph all of them,
also those with only text keys (the graph's events). An instance carries its own playback
(sequence and start time on the renderer's clock) or its graph's; clamped sequences hold their
last pose (an open door stays open).

**NiBillboardNode** (billboard mode u16): the subtree turns its Z axis towards the camera; modes
1 and 9 turn only about the node's Y axis (ALWAYS_FACE_CAMERA 0, ROTATE_ABOUT_UP 1,
RIGID_FACE_CAMERA 2, ALWAYS_FACE_CENTER 3, RIGID_FACE_CENTER 4, BSROTATE_ABOUT_UP 5).
**BSROTATE_ABOUT_UP** (5, Bethesda's) keeps the node upright in the world: its Z axis points
up whatever its own and its parents' rotation, and it turns about that axis so its −Y side
faces the camera. Torch fire hangs below a node tilted 70° along the torch; the flame emitter,
the glow and the heat haze planes sit below such billboards and so stay upright (26 particle
systems and the torch and candle glow planes).

**Lights** (LIGH DATA after the near clip): period, intensity amplitude, movement amplitude
(f32). Flags `0x8` flicker and `0x40` flicker slow vary brightness and position by smooth
noise; `0x80` pulse and `0x100` pulse slow by a sine (the engine's exact curve: TODO(M13)).

## Particles

Particle systems (`src/formats/nif/particle-blocks.ts`, built by `src/render/particle-data.ts`,
simulated by `src/render/particle-sim.ts`): 1726 systems in 912 vanilla meshes, all parsed
(`node tools/particle-info.ts --audit`; one mesh: `node tools/particle-info.ts <path>`).

- **NiParticleSystem / BSStripParticleSystem** (NiAVObject): bound centre + radius, skin ref,
  shader property ref, alpha property ref, vertex desc (2 × u32), far/near begin/end (4 × u16),
  data ref, world space (bool), modifiers (ref list). World space (1477 systems): particles stay
  where they were emitted.
- **NiPSysData / BSStripPSysData:** NiGeometryData writes only its has-flags in BS 100 (group
  id, u16 max particles, keep/compress flags, has vertices, BS data flags u16, material CRC,
  has normals, bounding sphere, has vertex colours, consistency u16, additional data ref); then
  has radii, u16 active count, has sizes / rotations / rotation angles / rotation axes / texture
  indices (u8 each), the **atlas frames** (u32 count + vec4 each, stored as **u, width, v,
  height**), aspect ratio f32, aspect flags u16 (`0x1` quads turn along the velocity, `0x100`
  the aspect ratio applies), speed-to-aspect (3 × f32), has rotation speeds u8. Strips add max
  point count u16, start and end cap size (f32) and a z-prepass bool.
- **Modifiers** (NiPSysModifier: name, order u32, target ptr, active bool), field by field:
  emitters (speed, speed variation, declination and variation, planar angle and variation,
  initial colour RGBA, radius, radius variation, life span and variation; box: object +
  width/height/depth; cylinder: object + radius/height; sphere: object + radius; mesh: shape
  refs, initial velocity type u32 (0 normals, 1 random, 2 axis), emission type u32 (0 vertices,
  1 face centres, 2 edge centres, 3 face surfaces, 4 edge surfaces), axis); age/death (spawn on
  death, spawn modifier ref); spawn (u16 generations, percentage, u16 min/max count, speed and
  direction variation, life span and variation); gravity (object, axis, decay, strength, force
  type u32 0 planar / 1 spherical, turbulence, turbulence scale, world aligned); drag (object,
  axis, percentage, range, range falloff); bomb (object, axis, decay, delta v, decay type,
  symmetry type); rotation (speed and variation, angle and variation, random sign, random axis,
  axis); collider manager (collider ref; planar colliders: bounce, spawn/die on collide, spawn
  modifier, parent, next collider, object, width, height, X and Y axis; spherical colliders: a
  radius); BSPSysSimpleColorModifier (fade in, fade out, colour 1 end, colour 1 start, colour 2
  end, colour 2 start, 3 RGBA colours); BSPSysScaleModifier (f32 list over the life);
  BSPSysSubTexModifier (start frame, start fudge, end frame, loop start, loop start fudge, frame
  count, frame count fudge); BSPSysLODModifier (begin and end distance, end emit scale, end
  size); BSPSysInheritVelocityModifier (object, chance %, multiplier, variation);
  BSPSysRecycleBoundModifier (offset, extent, object); BSWindModifier (strength);
  BSPSysStripUpdateModifier (update delta time).
- **Controllers:** NiPSysEmitterCtlr and BSPSysMultiTargetEmitterCtlr drive an emitter's birth
  rate (particles per second) and, through their visibility interpolator, whether it emits;
  NiPSysModifierActiveCtlr switches modifiers; NiPSysEmitterSpeed/InitialRadius/LifeSpan/
  Declination/PlanarAngle/GravityStrength/InitialRotSpeedCtlr animate those values.
  Manager-controlled ones (flag `0x20`) take their interpolators from the idle sequence, whose
  controlled blocks name them **BirthRate** and **EmitterActive**; without an idle sequence the
  emitter waits (impacts and spells, played when triggered). The others run from the moment the
  object loads, even when not flagged active (`0x45`): the engine starts the controllers of an
  effect it attaches.

**Simulation** (per placed system; where nif.xml is silent the vanilla values decide):
emitters place particles in their object's volume (box, cylinder about Z, sphere, or on a mesh)
and send them along the object's Z axis turned by the declination and planar angle. Angle
variations are ± the value; speed, radius and life span variations ± half of it (vanilla speed
variations exceed the speed, e.g. 59.99 ± 65.99). Gravity accelerates along its axis (planar)
or towards its object (spherical); drag removes its fraction of the velocity along its axis per
frame at 30 fps (vanilla systems use one drag modifier per axis, 0.02–0.1); bombs push away
from their object with linear or exponential decay; planar and spherical colliders bounce or
kill; recycle bounds wrap particles inside a box at their object. Over a particle's life,
BSPSysSimpleColorModifier keeps colour 1 until colour 1 end, blends to colour 2 by colour 1
start, keeps it until colour 2 end and blends to colour 3 by colour 2 start; alpha rises from
colour 1's to colour 2's until fade in and falls to colour 3's from fade out (the candle glow:
0 → 0.37 → 0). BSPSysScaleModifier scales the radius through evenly spaced keys.
BSPSysSubTexModifier shows frames from the start frame (+ up to its fudge) at frame count (± its
fudge) frames per life, and past the end frame loops from the loop start (a loop start at the
end frame holds it); without it each particle keeps one random atlas frame. BSPSysLODModifier
distances are stored divided by 30000 (vanilla values are multiples of 1/60, steps of 500
units): from begin to end the birth rate scales to end emit scale and the size to end size.
Systems run within 4096 units of the camera or while in view (up to 16384); a system's first
update simulates 1.5 seconds, so fires do not start empty.

**Drawing:** camera-facing quads (half size = radius × scale), stretched along the velocity
where the aspect flags ask, with their atlas frame; strip particles draw the ribbon of their
recorded positions. They are shaded like BSEffectShaderProperty with the particle colour as
vertex colour (see [the rendering notes](../rendering.md#effects-and-particles)).

**Add-on nodes:** most fire, candle and smoke effects are not in the object's mesh but in a
master particle system (`meshes\mps\*.nif`) attached at a **BSValueNode** named
`AddOnNode<index>` (value i32 = the index, then a flags byte; 640 nodes in 242 meshes). The
ADDN record with that index names the model (see [esm.md](esm.md#add-on-nodes)).

## Collision

Havok collision (`src/formats/nif/collision-blocks.ts`, flattened by
`src/physics/collision-data.ts`): 11379 of the 22761 vanilla meshes have some, every block
parses (`node tools/nif-stats.ts --parse`; per mesh and audit: `node tools/collision-info.ts`).
Values are in Havok units: **1 Havok unit = 69.99125 game units** (bhkWorld's scale 0.0142875).

- **bhkCollisionObject** (also bhkSPCollisionObject for phantoms, bhkBlendCollisionObject for
  skeletons): target ptr, flags u16, body ref; blend objects add heir gain and vel gain (f32).
  The NiAVObject's collision ref points here; the body sits on that node.
- **bhkRigidBody / bhkRigidBodyT:** bhkWorldObject (shape ref, HavokFilter, 20 bytes of world
  object info), bhkEntityCInfo (4 bytes), then **bhkRigidBodyCInfo2010**: 4 unused, HavokFilter,
  8 unused, response u8, 3 bytes, translation (vec4), rotation (quaternion x y z w), linear and
  angular velocity (vec4), inertia (3×4 floats), centre of mass (vec4), mass, linear and
  angular damping, time factor, gravity factor, friction, rolling friction multiplier,
  restitution, max linear and angular velocity, penetration depth (f32), motion system,
  deactivator, solver deactivation, quality (u8), 16 bytes; then constraints (u32 + refs) and
  body flags u16. Only bhkRigidBodyT uses its translation and rotation (the body's place
  relative to its node); plain bodies sit on the node.
- **HavokFilter** (4 bytes): layer u8 (SkyrimLayer, see
  [esm.md](esm.md#collision-layers)), flags u8 (bits 0-4 biped part, `0x20` MOPP scaled, `0x40`
  no collision, `0x80` linked group), group u16.
- **Shapes:** bhkSphereShape (material u32, radius), bhkBoxShape (+8 bytes, half extents vec3,
  unused f32), bhkCapsuleShape (+8, point, radius, point, radius), bhkCylinderShape (+8, two
  vec4 points, cylinder radius, 12 bytes), bhkConvexVerticesShape (+24, vertices as vec4,
  planes as vec4), bhkConvexTransformShape / bhkTransformShape (child, material, radius, 8,
  4×4 column-major matrix with a Havok-unit translation), bhkListShape (children, material,
  24 bytes, filters per child: zero in vanilla), bhkMoppBvTreeShape (child, 12, scale, MOPP
  code: size u32, offset vec4, build type u8, bytes; not needed, the physics builds its own
  tree), bhkNiTriStripsShape (material, radius, 20 + grow by, scale vec4, NiTriStripsData refs,
  filters; 17 old meshes), bhkPlaneShape (1 mesh). The radius of convex shapes is a shell
  grown around them (Havok's convex radius).
- **bhkCompressedMeshShape** (target, user data, radius, f32, scale vec4, radius and scale
  copies, data ref) and **bhkCompressedMeshShapeData**: bits per index and winding index and
  their masks, error (the quantization step, 0.001), AABB, welding and material type (u8),
  three unused material tables, materials (material id u32 + HavokFilter each), named
  materials count, transforms (translation vec4 + quaternion x y z w), big vertices (vec4), big
  triangles (3 × u16, material u32, welding u16), chunks, convex pieces count. A **chunk**:
  translation vec4, material index u32, reference u16 (another chunk whose geometry it shares;
  0xffff: none), transform index u16, vertex count ×3 (u32) + u16 xyz, indices, strip lengths,
  welding info. A vertex is `rotate(transform, translation + u16 × error) + transform
translation`; the indices start with the strips (alternating winding) and continue as a
  triangle list. Each chunk's material carries its own layer: stair ramps and walls of one
  mesh can differ.
- **Material ids** (u32) are the CRC-32 (start 0, no final inversion) of the lower-case name of
  a MATT record (see [esm.md](esm.md#material-types)).

**Placement:** like the drawn model, the root node's own transform is replaced by the
reference's placement. A body's shapes are scaled by its node's scale and the reference's
(uniform) scale; its mass stays as authored. **Motion:** MO_SYS_FIXED (7) or mass 0 is fixed,
MO_SYS_KEYFRAMED (6) keyframed, the rest simulated; bodies on nodes that the model's sequences
move (door leaves) are keyframed and follow the playing sequence. Simulated bodies on the bones
of skinned geometry form ragdolls (armour on the ground keeps its wearer's bones; a book's covers
and pages; dead animals). Phantoms detect overlaps and never collide.

**Constraints** (`collision-blocks.ts`; a rigid body lists the constraints it is part of) all
start with bhkConstraintCInfo: u32 entity count (2), entity A and B (pointers to the rigid
bodies), u32 priority; then their CInfo (since 20.2.0.7, Vector4 = 4 × f32 with w unused):

| Block                        | Data                                                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| bhkBallAndSocketConstraint   | pivot A, pivot B                                                                                                                               |
| bhkStiffSpringConstraint     | pivot A, pivot B, length f32                                                                                                                   |
| bhkHingeConstraint           | per body: axis, perpendicular 1, perpendicular 2, pivot                                                                                        |
| bhkLimitedHingeConstraint    | as hinge, then min / max angle, max friction, motor                                                                                            |
| bhkPrismaticConstraint       | per body: sliding axis, rotation, plane, pivot; min / max distance, friction, motor                                                            |
| bhkRagdollConstraint         | per body: twist, plane, motor axis, pivot; cone max angle, plane min / max, twist min / max, max friction, motor                               |
| bhkMalleableConstraint       | u32 type, its own CInfo, that type's data, strength f32                                                                                        |
| bhkBreakableConstraint       | u32 type, its own CInfo, that type's data, threshold f32, remove when broken u8                                                                |
| bhkBallSocketConstraintChain | u32 pivot count, pivots by pairs (Vector4), tau, damping, CFM, max error distance, the chained bodies (count + pointers), a bhkConstraintCInfo |

The motor (bhkConstraintMotorCInfo) is a u8 type (0 none, 1 position: 6 f32 + bool, 2 velocity:
4 f32 + 2 bools, 3 spring damper: 4 f32 + bool). hkConstraintType: 0 ball and socket, 1 hinge,
2 limited hinge, 6 prismatic, 7 ragdoll, 8 stiff spring, 13 malleable. Pivots and axes are in
the body's own space (Havok units); where the two bodies' frames coincide the constraint is at its
zero. Vanilla (all 1632 parse to the block's size): 823 limited hinges (shop signs, ragdoll
books, hanging game), 752 ragdoll joints (armour and clothes on the ground), 35 balls and sockets
(5 breakable: the breakable boards, the mace trap's pin), 8 hinges (cart wheels, tongs, lily
pads), 8 stiff springs (3 breakable: beehives), 6 chains (bone alarms, the mace trap's chain); no
prismatic or malleable ones. Two in an actor's hair name entity −1 (the wearer's body).

**BSBound** (extra data): name, centre vec3, half extents vec3. A skeleton's "BBX" is the
actor's collision bound (the human skeleton: centre 0,0,64, half extents 22,14,64).

## Water volumes

A water activator's model holds the water one can enter as **phantoms on the WATER layer**
(11): `water1024.nif` a box 1024 units wide and deep under its surface, `wrwaterpool01.nif`
(Whiterun's Wind District pool) two boxes, the Markarth canals, mineral pools, puddles. 27
vanilla meshes hold such shapes (47 boxes, 2 convex hulls, 1 capsule); the activator's
bounds (OBND) only say where it is drawn. Water meshes without them (the streams down
Whiterun's stairs: bounds 3300 units high from the stairs past the walls) are only seen and
heard. Volumes are placed with the reference (its scale included); hulls and capsules are
taken as their bounding boxes.

## Furniture markers

**BSFurnitureMarkerNode** (and BSFurnitureMarker; nif.xml), an extra data named "FRN" on a
furniture's root: a u32 count of positions, each (BS version over 34) an offset (3 × f32, model
space), a heading (f32, radians about z), the animation type (u16: 1 sit, 2 sleep, 4 lean) and
the entry points (u16: 0x1 front, 0x2 behind, 0x4 right, 0x8 left, 0x10 up); 20 bytes each.
243 vanilla meshes hold one (`node tools/nif-stats.ts --parse`). The furniture record makes
some of them active (FURN MNAM, a bit per marker in the low 24 bits; FNPR repeats each marker's
type and entry points). A creature alcove's single marker is a sleep marker 114 units above its
origin: where the actor's root goes with the furniture's idle (`src/world/furniture.ts`).

## TRI (FaceGen morphs)

A head part (HDPT) names its morph files by part type (NAM0 then NAM1 path): 0 race morphs,
1 **Tri** (the expressions the game plays), 2 chargen morphs. The FaceGen head NIF already
has the race and chargen morphs applied; the Tri file's morphs move it at run time
(`src/formats/nif/tri.ts`, check: `node tools/tri-info.ts --all`, 569 vanilla files).

Layout (pyffi `tri.xml`): `FRTRI003`, then 14 i32: vertex count, triangle count, quad count,
2 unknown, UV count, has UVs, morph count, modifier count, modifier vertex count, 4 unknown;
the vertices (f32 × 3), the modifier vertices (f32 × 3), triangles (i32 × 3), quads (i32 × 4),
UVs (f32 × 2) and, with UVs, UV triangles and quads; per morph a name (u32 length with the
trailing zero, then the text), a scale (f32) and per vertex three i16 offsets (times the
scale); per modifier a name, a count and that many vertex indices (their positions are the
modifier vertices, in order). The vertices are those of the head part's shape in the FaceGen
head, in the same order (MaleHead.tri: 898, as MaleHeadNord).

Morphs of the human heads: 16 phonemes (Aah, BigAah, BMP, ChJSh, DST, Eee, Eh, FV, I, K, N,
Oh, OohQ, R, Th, W), modifiers (BlinkLeft / Right, BrowDown / In / Up Left / Right, LookDown,
SquintLeft / Right), moods and dialogue expressions (MoodAnger … MoodSurprise, DialogueAnger
… DialogueSurprise, CombatAnger, CombatShout) and SkinnyMorph.
