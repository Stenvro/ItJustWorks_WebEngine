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
