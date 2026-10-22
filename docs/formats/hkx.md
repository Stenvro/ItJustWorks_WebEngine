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
  resource-pack behaviors are binary tagfiles instead ([Tagfiles](#tagfiles)).

## Tagfiles

Creation Club and resource-pack behaviors ship **binary tagfiles** (`.hkt`, magic
`0xCAB00D1E 0xD011FACE`, `src/formats/hkx/tagfile.ts`) next to their Havok Behavior Tool
sources (`.hkp` project, `.hkc` character, `.hkb` behavior: HBT XML, which the game does not
read; the project's export settings name `.hkt` as the tagfile extension). Layout: hkxparse
(exyorha, MIT) read as documentation, extended by what the data shows (version 0 below).

- After the magic, a stream of **tags**, each a variable-length integer: file info 1,
  class definition 2, object 3, remembered object 4, reference 5, null 6, end 7.
- **Integers**: the first byte holds the sign (bit 0) and 6 bits of magnitude (bits 1–6),
  bit 7 says another byte follows with 7 more bits (low bits first).
- **Strings**: a length, then that many bytes, added to a pool; a length ≤ 0 is the pool
  entry at its negation. The pool starts as two empty strings and is reset by a file info.
- **File info**: the version (3 or 0 in the game files; 4 adds the Havok version string).
- **Class definition**: name, version, parent (class index, 0 none), member count, per member
  its name, type, tuple size (tuples only) and class name (objects and structs only). Classes
  are numbered from 1 in order. Types: low 4 bits void 0, byte 1, int 2, real 3, vec4 4,
  vec8 5, vec12 6 (hkQsTransform, hkMatrix3: 12 floats), vec16 7, object 8, struct 9,
  cstring 10; `0x10` array, `0x20` tuple. Runtime members are listed with type void and never
  carry a value.
- **Object**: its class (an index), a bitmap of the members present ((n + 7) / 8 bytes, the
  bases' members first), then each present member's value. **A member left out is zero** (the
  state with id 0 has no stateId; a probability of 1.0 is written).
- **Values**: bytes as one byte, ints as an integer of the stream (any width), reals as f32,
  vectors as 4/8/12/16 floats, cstrings as strings, structs in place (class from the member).
  Byte arrays and tuples are raw bytes. Other arrays give their count (tuples their fixed
  size), then: int arrays the element width and vec4 arrays the component count (version 3,
  once per array), then the elements. **Struct arrays** are written member by member: one
  bitmap for the class, then per present member its values for all elements (read as an array
  of the member's basic type, without a count of its own).
- **Objects, version 3**: every object is a top-level remembered object, numbered from 1 as
  they come; an object member is that number (0 null), and may come before the object. The
  root is object 1.
- **Objects, version 0** (the fishing rod's skeleton and two unused clips, read from the data):
  an object member is a tag in place: a new object (3), a new object remembered for later
  references (4, numbered from 0), a reference to one (5 and its number) or null (6). The
  root is the first top-level object; the file ends after it without an end tag, and arrays
  carry no element width.

The engine turns a tagfile into the **packfile** it would be (`packfile-image.ts`): every
object laid out as its class's 64-bit layout says (`layouts.ts`: serde-hkx's offsets, those
the readers use checked against vanilla packfiles), its pointers, strings and arrays as
fixups. `Packfile.parse` does this for a tagfile, so the behavior and animation readers take
either. Members of classes without a known layout are reported, not placed: the ragdoll and
get-up modifiers of an unused ballista behavior (`bcbehavior.hkt`; the ballista plays its
`.hkx`) and the name of the skeleton files' hkMemoryResourceContainer.

The meshes name their projects `.hkx` while only the `.hkt` exists (`stagescycle.hkx` →
`stagescycle.hkt`); the files inside name `.hkt` themselves (`Characters\Character.hkt`). A
missing `.hkx` is therefore read as `.hkt` (`readHavokFile`; TODO(M13): inferred, the game
plays these graphs). All 6 projects load and start (20 meshes): the resource pack's stage
cycle (stage1state) and Dwemer vault seal (idle), the Ayleid activators (stage1), harvestable
plants (ready), the fishing rod (ready) and the giant mudcrab (ready, mouthidle). Of the 366 graphs
meshes name, 363 load; the other 3 are errors in the data (a mesh names
`dragonbloodwingl\dragonbloodheadwingr.hkx`, which lies in `dragonbloodwingr\`; the scorpion
trap's folder is empty; `magic\shoutimod.hkx` names no character).

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

The classes actor graphs use (all 423 vanilla behavior files parse; offsets from serde-hkx's
generated Havok 2010.2 classes, checked against their alignment):

| Class                              | Members                                                                                                                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| hkbStateMachine (more)             | eventToSendWhenStateOrTransitionChanges 72 (hkbEvent), returnToPreviousStateEventId 108, randomTransitionEventId 112, transitionToNextHigher 116 / Lower 120, syncVariableIndex 124, wrapAroundStateId 132, maxSimultaneousTransitions 133, selfTransitionMode 135 |
| hkbStateMachineStateInfo (more)    | enterNotifyEvents 64, exitNotifyEvents 72 (hkbStateMachineEventPropertyArray: events 16, 16 bytes each: id 0, payload 8)                                                                                                                                           |
| hkbStateMachineTransitionInfo      | triggerInterval 0, initiateInterval 16 (enterEventId, exitEventId, enterTime, exitTime), fromNestedStateId 56, toNestedStateId 60                                                                                                                                  |
| hkbBlendingTransitionEffect (more) | selfTransitionMode 72, eventMode 73, toGeneratorStartTimeFraction 84, flags 88, endMode 90, blendCurve 91 (0 smooth, 1 linear, 2 linear to smooth, 3 smooth to linear)                                                                                             |
| hkbExpressionCondition             | expression 16 (hkbStringCondition: conditionString 16)                                                                                                                                                                                                             |
| hkbClipGenerator (more)            | triggers 80 (hkbClipTriggerArray: triggers 16, 32 bytes each: localTime 0, event 8, relativeToEndOfClip 24, acyclic 25, isAnnotation 26), cropStart 88, cropEnd 92, startTime 96, enforcedDuration 104, userControlledTimeFraction 108, flags 115                  |
| hkbBlenderGenerator (more)         | referencePoseWeightThreshold 72, minCyclicBlendParameter 80, maxCyclicBlendParameter 84, indexOfSyncMasterChild 88, subtractLastChild 92; child boneWeights 56 (hkbBoneWeightArray: boneWeights 48, f32 per bone)                                                  |
| hkbManualSelectorGenerator         | generators 72, selectedGeneratorIndex 88                                                                                                                                                                                                                           |
| BSiStateTaggingGenerator           | pDefaultGenerator 80, iStateToSetAs 88, iPriority 92 (Bethesda generators start at 80, 16-aligned)                                                                                                                                                                 |
| BSCyclicBlendTransitionGenerator   | pBlenderGenerator 80, EventToFreezeBlendValue 88, EventToCrossBlend 104, fBlendParameter 120, fTransitionDuration 124, eBlendCurve 128                                                                                                                             |
| BSBoneSwitchGenerator              | pDefaultGenerator 80, ChildrenA 88 (BSBoneSwitchGeneratorBoneData: pGenerator 48, spBoneWeight 56)                                                                                                                                                                 |
| BSSynchronizedClipGenerator        | pClipGenerator 80                                                                                                                                                                                                                                                  |
| BSOffsetAnimationGenerator         | pDefaultGenerator 80, pOffsetClipGenerator 96, fOffsetVariable 104, fOffsetRangeStart 108, fOffsetRangeEnd 112                                                                                                                                                     |
| hkbBehaviorReferenceGenerator      | behaviorName 72                                                                                                                                                                                                                                                    |
| hkbModifier (base)                 | enable 72; hkbModifierList: modifiers 80                                                                                                                                                                                                                           |
| hkbEvaluateExpressionModifier      | expressions 80 (hkbExpressionDataArray: 16, 24 bytes each: expression 0, assignmentVariableIndex 8, assignmentEventIndex 12, eventMode 16: 0 send once, 1 on true, 2 false to true, 3 every frame once true)                                                       |
| BSIsActiveModifier                 | bIsActive0 80, bInvertActive0 81, … bIsActive4 88, bInvertActive4 89                                                                                                                                                                                               |
| hkbTimerModifier                   | alarmTimeSeconds 80, alarmEvent 88                                                                                                                                                                                                                                 |
| hkbEventDrivenModifier             | modifier 80, activateEventId 88, deactivateEventId 92, activeByDefault 96                                                                                                                                                                                          |
| BSEventOnDeactivateModifier        | event 80; BSEventOnFalseToTrueModifier: three slots of 24 at 80 (bEnableEvent 0, bVariableToTest 1, EventToSend 8)                                                                                                                                                 |
| BSEventEveryNEventsModifier        | eventToCheckFor 80, eventToSend 96, numberOfEventsBeforeSend 112, minimum 113, randomize 114                                                                                                                                                                       |
| hkbDampingModifier                 | kP 80, kI 84, kD 88, rawValue 96, dampedValue 100                                                                                                                                                                                                                  |
| BSInterpValueModifier              | source 80, target 84, result 88, gain 92; BSModifyOnceModifier: pOnActivateModifier 80, pOnDeactivateModifier 96                                                                                                                                                   |
| hkbEventsFromRangeModifier         | inputValue 80, lowerBound 84, eventRanges 88 (hkbEventRangeDataArray: 16, 32 bytes each: upperBound 0, event 8, eventMode 24)                                                                                                                                      |
| BSSpeedSamplerModifier             | state 80, direction 84, goalSpeed 88, speedOut 92                                                                                                                                                                                                                  |
| BSTimerModifier                    | alarmTimeSeconds 80, alarmEvent 88, resetAlarm 104                                                                                                                                                                                                                 |
| BSTweenerModifier                  | tweenPosition 80, tweenRotation 81, useTweenDuration 82, tweenDuration 84, targetPosition 96, targetRotation 112                                                                                                                                                   |
| BSPassByTargetTriggerModifier      | targetPosition 80, radius 96, movementDirection 112, triggerEvent 128                                                                                                                                                                                              |
| BSGetTimeStepModifier              | timeStep 80; BSDecomposeVectorModifier: vector 80, x 96, y 100, z 104, w 108                                                                                                                                                                                       |
| hkbTransformVectorModifier         | rotation 80, translation 96, vectorIn 112, vectorOut 128, rotateOnly 144, inverse 145, computeOnActivate 146, computeOnModify 147                                                                                                                                  |
| BSLimbIKModifier                   | limitAngleDegrees 80, currentAngle 84, startBoneIndex 88, endBoneIndex 90, gain 92, boneRadius 96, castOffset 100                                                                                                                                                  |
| hkbBehaviorGraphStringData (more)  | characterPropertyNames 64; hkbCharacterStringData: characterPropertyNames 80                                                                                                                                                                                       |
| hkbVariableBindingSet binding      | bindingType 33: 0 a graph variable, 1 a character property                                                                                                                                                                                                         |

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

Vanilla clips carry no extracted motion: root motion comes from the behavior projects'
animation data ([Animation data](#animation-data)).

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

## Animation data

What the behavior projects say about their clips beside the Havok files: text files in
`Skyrim - Animations.bsa` (one binary). Readers: `src/formats/animdata/`; the lookups the runtime
uses (by a race's behavior project and a clip generator's name, by an equip state):
`src/animation/animation-data-library.ts`. Every block of every file, compared with the graphs
and clips: `node tools/animdata-info.ts --parse`; one clip's keys: `--project DefaultMale --clip
MT_WalkForward`; attack sets: `--sets DefaultMale [--equip iLeftHandType=10,iRightHandType=1]`;
speed tables: `--speed DefaultMale [--state 0]`. Sources: the readers of Pandora Behaviour
Engine (`Pandora.Skyrim/AnimData` and `AnimSetData`; Pandora, like FNIS and Nemesis, rewrites
these files) for the block layouts and field names; the speed data and the responses from the
vanilla data alone.

The engine reads the **single files** (`meshes\animationdatasinglefile.txt`,
`animationsetdatasinglefile.txt`, `speeddatasinglefile.txt`): they hold the DLC projects too.
The per-project copies are the base game's: `meshes\animationdata\<project>.txt` (323, a project
block as below without its line count), `animationdata\boundanims\anims_<project>.txt` (39, the
motion block) and `meshes\animationsetdata\<project>data\` (39 folders: the set list without a
count, one file per set; `dirlist.txt` lists the folders). 11 character projects and 209 of the
813 set files differ from the single files.

A project is named by its behavior project file without the extension: `DefaultMale` is
`meshes\actors\character\defaultmale.hkx` (the race's `Actors\Character\DefaultMale.hkx`),
`FirstPerson` `actors\character\_1stperson\firstperson.hkx`, `WolfProject`
`actors\canine\wolfproject.hkx`; for each of the 49 character projects a file of that name
exists whose listed files lie next to it.

### animationdatasinglefile.txt

CRLF lines: the project count (429) and the names (`DefaultMale.txt`; 419 different: ten object
projects such as `Autoplay` and `Moth` are listed twice with different files, the first is
used); then per project its line count and block and, when the block's flag is 1, the line
count and lines of its motion block. A count covers every line of the block, the empty line
after each entry included (in vanilla every count matches). The 49 character projects come
first, in the order of the set and speed data; the 380 object projects have no clips.

| Project block line | Meaning                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `1`                | 1 in every project (Pandora: LeadInt)                                                               |
| file count, files  | the project's files from its folder: `Behaviors\0_Master.hkx`, `Characters\…`, the skeleton         |
| `1` or `0`         | whether clip data and motion data follow                                                            |
| clip blocks        | name, clip id, playback speed, crop start, crop end, event count, events `name:time`; an empty line |

A **clip block** is an hkbClipGenerator by name: its playback speed and crop
(cropStartAmountLocalTime, cropEndAmountLocalTime) equal the graph's in every generator found,
its events (`FootLeft:0.2`, `SoundPlay.NPCChickenScratch:0.333333`) carry the local time after
the last colon. Several generators share a clip (mirrored ones, slow and fast variants). The
**clip id** only keys the motion: it is the index of the clip's animation in the character's
animationNames in 44 projects but not in WerewolfBeast (none: the list moved by a few), Horse
(34 of 65) or the humans (DefaultMale 2486 of 2520), so generators are matched by name.

A **motion block** per clip id: clip id; duration; translation count, `time x y z` lines;
rotation count, `time x y z w` lines; an empty line. The keys are where the clip has moved the
actor since its start, in the frame it started in: x right, y forward, z up, game units
(1HM_AttackPowerFwdUncropped ends at y +484.5, the left power attack at x −123.7, the right one
at x +153.3). No key is written for time 0 (the start is zero and the identity), the last key
lies at the duration, times rise, and every rotation turns about z only (12 308 translation and
9681 rotation keys in 6725 entries). The duration is the clip file's (6631 of the 6675 entries
whose clip was found): keys are in the clip's own time, before crop and playback speed. Between
keys the translation is read linearly and the rotation spherically (not documented). 241
generators have no motion entry (DefaultMale and DefaultFemale 102 each, FirstPerson 29, Dragon
8): they do not move the actor. `Crossbow_IdleHeld` is listed twice with two clips in the three
human projects; the first is used.

**Plausibility.** MT_WalkForward moves 93.4 units in 1.133 s (82.45 u/s) and MT_RunForward 222.2
in 0.633 s (350.9 u/s): the child weights of MT_ForwardBlend (82.4541 and 350.987 on its
SpeedSampled axis). Over all parametric blenders on a speed variable, 2327 of 3578 children that
are clips sit within 1 % of the clip's speed times its playback speed (the others are round
authored values such as 5, 50 and 200). The MOVT speeds (NPC_Default_MT walk forward 80.1, run
370; [esm.md](esm.md)) lie on these axes; MT_SprintForward runs at 370.4. Chair_FrontEnterVar1
walks 63.5 units forward while it turns 180° to sit down.

### animationsetdatasinglefile.txt

The project count (49) and the paths (`DefaultMaleData\DefaultMale.txt`); per project the set
count, the set file names (`1HMShield.txt`), then the sets in that order. No line counts. A set
is an equip state of the character:

| Set lines                        | Meaning                                                                     |
| -------------------------------- | --------------------------------------------------------------------------- |
| `V3`                             | version (every set)                                                         |
| count, events                    | trigger events (weapEquip, swimForceEquip, WeapOutLeftReplaceForceEquip, …) |
| count, (variable, min, max)      | graph variables the state needs inside the range (both ends included)       |
| count, attacks                   | attack event, a flag (0 or 1), clip count, the clip generators it plays     |
| count, (folder, file, extension) | the clips the set uses, three u32 lines each                                |

Conditions test iLeftHandType (148), iRightHandType (149), iWantMountedWeaponAnims (84) and
bWantMountedWeaponAnims (5): 1HMShield is iLeftHandType 10, iRightHandType 1–4,
iWantMountedWeaponAnims 0. A variable the runtime does not name counts as 0. Most creatures have
one set (`FullBody`) without conditions; the humans have 374 (42 with conditions, the others
furniture and idle sets), FirstPerson 109, Draugr 25 (990 sets, 737 attacks). The lookup takes
an equip state's attacks from its sets with conditions first, then from those without.
Attack clips are clip generators of the animation data (776 of 793). The attack flag is 1 on 124
attacks, the plain and sprint ones (attackStart, attackStartLeftHand, attackStartSprint,
attackPowerStart_Sprint, AttackStartH2HRight, some bashes), and 0 on the directional power
attacks; its meaning is unknown (Pandora: Unk).

A clip is named by hashes: the BSCRC32 (reflected 0xEDB88320, start 0, no final inversion, as
the material ids) of its lower-case folder (`meshes\actors\character\animations`) and of its
lower-case file name without extension, and the extension's characters as a little-endian u32
(`hkx`: 7891816). 20 336 of the 20 807 are animations of the character's list (all of them in 36
of the 49 projects).

### speeddatasinglefile.txt

Not documented anywhere found; the layout and the meaning follow from the data and the graphs.
A text head, the project count (49) and `DefaultMaleData\DefaultMale.spd` lines, then binary,
little-endian, to the last byte: per project u32 1, u32 table count; per table i32 state, u32
curve count; per curve f32 direction, u32 point count and (f32 x, f32 y) points.

88 tables (two of Falmer's are empty, with states 0x80000000 and 0x626F7272: uninitialised
memory), 1634 curves, 18 302 points. Every other table has 19 curves, directions 0 to 0.9 in
steps of 0.05. The humans have states 0–10 and 15–17 (14 tables), FirstPerson and most creatures
one (state 0, or one of their own: 30 dog, 40 goat, 60 horse, 100 wolf), a few several (Draugr 0
and 3–7, Giant 0–2, Deer 20 and 21).

They are the tables of **BSSpeedSamplerModifier**, which `0_master.hkx` binds to iState (state),
Direction (direction), Speed (goalSpeed) and SpeedSampled (speedOut); the locomotion blenders
blend on SpeedSampled. A curve's x is that blend parameter, its y the speed the synchronised
blend then moves the actor at: DefaultMale state 0 direction 0 has (48.5, 16.10) and (324.5,
306.38), and the root motion of MT_WalkForwardSlow and MT_WalkForward, and of MT_WalkForwardFast
and MT_RunForward, blended at those weights (stride over the blended cycle duration), gives
16.11 and 306.42. State 1 is flat at 370.37, the sprint clip's speed. The sampler so inverts the
curve: the parameter at which the blend moves at the goal speed (walk 80.1 → 82.24). 1556 curves
rise in both x and y. Beyond a curve's last point (state 0 forward: 306.4, short of the run's 370) the lookup holds it. TODO(M13): whether the engine extrapolates is not documented.

### Responses

`meshes\responses\actorresponse.txt` (88 events) and `playercharacterresponse.txt` (13):
`event : Handler` lines naming the engine handler that answers an animation event of an actor's
graph (weaponSwing → WeaponRightSwingHandler, HitFrame → HitFrameHandler, idleChairSitting →
ChairEnterHandler, AddRagdollToWorld → AddRagdollHandler). The player's file starts with
`BackupResponse : ActorResponse`: an event it does not name falls back to the actors' list
(idleChairSitting → PlayerChairEnterHandler, HitFrame → HitFrameHandler).
