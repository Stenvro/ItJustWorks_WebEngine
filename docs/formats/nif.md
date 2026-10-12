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

Skinned shapes have data size 0: their vertices live in NiSkinPartition (TODO(M7)).
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
  time + value per key. NiTransformData: rotation keys (quaternions; type 4: three float key
  groups for X, Y and Z instead), translations, scales.

**What plays:** active controllers that no manager drives, and of a model's
NiControllerManager the first of the sequences Idle, AutoLoop, SpecialIdle, Waiting, mLoop,
mIdle, AnimIdle, AnimIdle01, Loop, AmIdle (AmIdle: the resting state of furniture-like objects,
e.g. the forge's idle smoke; most other sequences are played by scripts or activation:
doors' Open/Close, word walls, magic). Around Whiterun 173 draws animate: waterfall foam
scrolling, embers pulsing, signs and props. Skinned meshes whose bones animate (banners)
need skinning on the GPU: TODO(M7).

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
