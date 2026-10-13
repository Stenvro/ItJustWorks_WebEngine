# HKX (Havok packfiles) and behavior graphs

Skyrim SE stores skeletons, animations, ragdolls and behavior graphs as **Havok 2010.2.0-r1
binary packfiles**, 64-bit little-endian (`src/formats/hkx/packfile.ts`). Listing:
`node tools/hkx-info.ts <mesh.nif | file.hkx> [--objects]`, `--audit` for every graph a vanilla
mesh names. Sources: hkxcmd, HKX2, serde-hkx (member offsets per class), nif.xml for the NIF
side.

## Packfile layout

- **Header** (64 bytes): magic `0x57E0E057 0x10C0C010`, user tag, file version (8), layout rules
  (bytes per pointer 8, little-endian 1, reuse padding 0, empty base class 1), section count (3),
  contents section index and offset (the root object, an hkRootLevelContainer), contents class
  name section index and offset, the version string `hk_2010.2.0-r1` (16 bytes), flags.
- **Section headers** (48 bytes each): name (19 bytes + 0xFF), absolute data start, then
  offsets relative to it: local fixups, global fixups, virtual fixups, exports, imports, end.
  Sections: `__classnames__`, `__types__` (empty in game files), `__data__`.
- `__classnames__`: per class a u32 signature, `0x09`, the name, NUL.
- `__data__`: the objects back to back as they lie in memory (pointers zero), then the fixups:
  - **local** (source, target) pairs: a pointer to raw data in the same section (array
    contents, strings);
  - **global** (source, section, target) triples: a pointer to another object;
  - **virtual** (object, class name section, class name offset) triples: every object and its
    class.
    Tables are padded with `0xFFFFFFFF`.
- `hkArray` (16 bytes): data pointer (local fixup), size (i32), capacity and flags (i32,
  `0x80000000` set: the array does not own its memory). `hkStringPtr` and `char*`: a local
  fixup to a NUL-terminated string.
- Skyrim LE's 32-bit packfiles are not loaded by SSE and are rejected. Creation Club and
  resource-pack behaviors ship **binary tagfiles** (`.hkt`, magic `0xCAB00D1E 0xD011FACE`) next
  to Havok Behavior Tool sources (`.hkp`, `.hkc`, `.hkb`, XML) instead of packfiles:
  TODO(M7), together with the question of how the engine finds them for the `.hkx` names
  their meshes use (9 projects, 21 meshes; vanilla's 357 graphs are packfiles).

## Behavior graphs of objects

A mesh names its graph on the root node: **BSBehaviorGraphExtraData** (name, graph file
relative to `meshes\`, controls base skeleton: bool). 1251 vanilla meshes do (actors, magic
effects, traps, fires, word walls, banners, barriers); without one, the NIF's controller
manager plays only its idle sequence (see [nif.md](nif.md#animation)).

The file is a chain (`src/formats/hkx/behavior.ts`, `loadBehaviorGraph`):

1. **Project** (hkbProjectData → stringData at 32: hkbProjectStringData, characterFilenames
   at 48): the character file, relative to the project's folder.
2. **Character** (hkbCharacterData → stringData at 152: hkbCharacterStringData,
   behaviorFilename at 184): the behavior file, relative to the project's folder (`..` steps
   up: the bows share `weapons\bow\`).
3. **Behavior** (hkbBehaviorGraph: rootGenerator at 128, data at 136).

Member offsets (64-bit) that the reader uses:

| Class                              | Members                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| hkbBindable (base)                 | variableBindingSet 16                                                                                               |
| hkbNode (base, 72 bytes)           | name 56                                                                                                             |
| hkbBehaviorGraphData               | variableInfos 32 (6 bytes each: role 4, type i8), variableInitialValues 112, stringData 120                         |
| hkbVariableValueSet                | wordVariableValues 16 (i32 each; reals as float bits)                                                               |
| hkbBehaviorGraphStringData         | eventNames 16, variableNames 48                                                                                     |
| hkbStateMachine                    | startStateId 104, startStateMode 134 (0 default, 1 sync, 2 random, 3 chooser), states 144, wildcardTransitions 160  |
| hkbStateMachineStateInfo           | transitions 80, generator 88, name 96, stateId 104, probability 108, enable 112                                     |
| hkbStateMachineTransitionInfoArray | transitions 16 (72 bytes each: transition effect 32, condition 40, eventId 48, toStateId 52, priority 64, flags 66) |
| hkbBlendingTransitionEffect        | duration 80                                                                                                         |
| hkbBlenderGenerator                | blendParameter 76, flags 90 (0x8 keep zero-weight children, 0x10 parametric), children 96                           |
| hkbBlenderGeneratorChild           | generator 48, weight 64                                                                                             |
| hkbModifierGenerator               | modifier 72, generator 80                                                                                           |
| BGSGamebryoSequenceGenerator       | pSequence 72, eBlendModeFunction 80 (0 none, 1 percent, 2 one minus percent), fPercent 84                           |
| hkbClipGenerator                   | animationName 72, playbackSpeed 100, mode 114                                                                       |
| hkbVariableBindingSet              | bindings 16 (40 bytes each: memberPath 0, variableIndex 28, bindingType 33)                                         |

Transition flags: 0x20 disabled, 0x100 disable condition, 0x200 allow self transition from
any state, 0x400 global wildcard, 0x800 local wildcard, 0x4000 abut at end of the from-generator.

**What object graphs use** (319 graphs of placed objects): state machines, blenders, modifier
generators (damping), BGSGamebryoSequenceGenerator (Bethesda's leaf that plays one of the
mesh's own NIF sequences), hkbClipGenerator (skeletal clips: traps, banners), the reference
pose; a handful of expression conditions. How they run: [animation.md](../animation.md).

Examples:

- `GenericBehaviors\BlendBetweenStatesVariable`: a blender over partA (weight = the damped
  variable fToggleBlend, 0) and partB (one minus it): toggleable fires start **unlit**.
- `GenericBehaviors\AutoPlay`: AutoPlay, then AutoLoop on the event "End" (the sequence's
  `end` text key); StopEffect → AutoFadeOut.
- `GenericBehaviors\IdleTransIdleBackML` (Eye of Magnus barriers): ShaderLoopIdle and
  AnimIdle01 together.

## Animations

Character, creature and object clips are packfiles whose root holds an
`hkaAnimationContainer`: skeletons (`skeleton.hkx`), or one animation with its binding (every
clip). Reader: `src/formats/hkx/animation.ts`; check against every clip of the load order:
`node tools/hkx-anim.ts --verify` (6126 clips, 295 over several blocks, none failing).

| Class                            | Members (64-bit offsets)                                                                                                                                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| hkaAnimationContainer            | skeletons 16, animations 32, bindings 48 (arrays of pointers)                                                                                                                                                                                                                                                      |
| hkaSkeleton                      | name 16, parentIndices 24 (i16), bones 40 (16 bytes: name 0, lockTranslation 8), referencePose 56, referenceFloats 72, floatSlots 88                                                                                                                                                                               |
| hkQsTransform                    | 48 bytes: translation 0, rotation 16 (x y z w), scale 32                                                                                                                                                                                                                                                           |
| hkaSplineCompressedAnimation     | type 16 (5), duration 20, numberOfTransformTracks 24, numberOfFloatTracks 28, extractedMotion 32, annotationTracks 40, numFrames 56, numBlocks 60, maxFramesPerBlock 64, maskAndQuantizationSize 68, blockDuration 72, blockInverseDuration 76, frameDuration 80, blockOffsets 88, floatBlockOffsets 104, data 152 |
| hkaAnnotationTrack               | 24 bytes: trackName 0, annotations 8 (16 bytes: time 0, text 8)                                                                                                                                                                                                                                                    |
| hkaDefaultAnimatedReferenceFrame | up 16, forward 32, duration 48, referenceFrameSamples 56 (xyz + turn)                                                                                                                                                                                                                                              |
| hkaAnimationBinding              | originalSkeletonName 16, animation 24, transformTrackToBoneIndices 32 (empty: track i is bone i), floatTrackToFloatSlotIndices 48, blendHint 64 (1 additive)                                                                                                                                                       |

Vanilla clips carry no extracted motion: root motion comes from the behavior project's
animation data (`meshes\animationdata`), read with the behavior runtime (M7).

The float slots of the human skeleton are `hkFade:AnimObjectA/B/L/R` (an anim object's fade)
and `hkVis:Shield`, `hkVis:… MagicNode`, `hkVis:Weapon` (whether the object in that node is
drawn); a book clip fades its page in through one.

### Spline compression

The data is cut into blocks of up to `maxFramesPerBlock` frames; block `b` starts at
`blockOffsets[b]`, and a time `t` falls in block `floor(t · blockInverseDuration)` at frame
`(t − b · blockDuration) / frameDuration`. Every block holds its own curves, so the pose of
two blocks agrees at their seam only up to the compression's error (the check allows 0.1 rad
and one unit): a decoding error shows there first.

A block starts with a TransformMask per transform track (4 bytes) and one mask byte per float
track, then aligns to 4:

- TransformMask byte 0: quantizations: position bits 0–1, rotation bits 2–5, scale bits 6–7.
- Bytes 1 and 3 (position, scale): static x/y/z 0x01/0x02/0x04, curve x/y/z 0x10/0x20/0x40;
  static wins when both are set. A component with neither is 0 (position) or 1 (scale).
- Byte 2 (rotation): 0xF0 a curve, 0x0F static, else the identity.

Then per track: position, rotation, align 4, scale. A **vector channel** with a curve: u16
`count`, u8 `degree`, `count + degree + 2` u8 knots (frames), align 4; per component two f32
(min, max) for a curve or one f32 for a static value; `count + 1` control points of one u8
(quantization 0) or u16 (1) per curve component, as a fraction of min..max; align 4. Without a
curve: one f32 per static component. A **rotation**: the same curve header, align to the
quantization (4, 1, 2, 1, 2, 4), then `count + 1` quaternions (or one when static):

| Rotation quantization | Size | Layout                                                                                                    |
| --------------------- | ---- | --------------------------------------------------------------------------------------------------------- |
| 0 POLAR32             | 4    | phiTheta bits 0–17, r bits 18–27 (w = 1 − (r/1023)²), signs of x y z w in bits 28–31                      |
| 1 THREECOMP40         | 5    | three 12-bit components ((v − 2047) · √½/2047), index of the largest bits 36–37, its sign bit 38          |
| 2 THREECOMP48         | 6    | three u16 (15 bits: (v − 16383) · √½/16383); index = top bit of y · 2 + top bit of x, sign = top bit of z |
| 5 UNCOMPRESSED        | 16   | four f32                                                                                                  |

The largest component follows from unit length; the three stored ones fill the other indices
in order. THREECOMP24 (3) and STRAIGHT16 (4) occur in no vanilla clip and are refused.

Curves are B-splines of the given degree over the knots (The NURBS Book, A2.1 and A2.2);
rotations are blended component-wise and normalised.

**Float tracks** start at `blockOffsets[b] + floatBlockOffsets[b]`. Their mask: 0x01 static
(one f32), 0x10 a curve laid out like one vector component (header, align 4, min and max,
control points, align 4). Every vanilla float mask also has 0x02 and every vanilla float curve
has u16 control points, so 0x02 is read as the 16-bit quantization (TODO(M13): confirm against
a clip with 8-bit float curves, if one exists outside the vanilla data).

**Corrupt data in vanilla clips:** 59 clips carry NaN (or values beyond 10⁷) in some track,
always an unused bone (AnimObjectR in `dialogueangryhips.hkx`). Such a track is not written
for that block, so the bone keeps the pose below it (the reference pose).

**Fast turns are data:** about a third of the clips turn a track faster than 0.6 rad between
two frames at 30 fps: sword swings, fingers that clench, weapon bones that snap into the hand.
The decoding was checked where it could go wrong: consecutive control points whose largest
component changes stay close (mean 0.06–0.2 rad over 600 000 pairs), and every seam agrees.

The layout and the quaternion encodings were worked out with PredatorCZ's HavokLib
(spline decompressor) as documentation; float tracks from the vanilla data.
