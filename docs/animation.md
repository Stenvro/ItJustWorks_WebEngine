# Animation

How placed objects animate (`src/render/animation.ts`, `src/animation/object-graph.ts`).
Formats: [nif.md](formats/nif.md#animation) (controllers, sequences, keys),
[hkx.md](formats/hkx.md) (behavior graphs).

## What plays

- **Controllers that no manager drives** (flags active, not manager-controlled) play on their
  own from the moment the scene starts: UV scrolls of waterfalls and lava, turning parts.
- A mesh **without a behavior graph** plays its controller manager's idle sequence (Idle,
  SpecialIdle, ...; [nif.md](formats/nif.md#animation)). Scripts and activation play the others
  (a door's Open and Close).
- A mesh **with a behavior graph** (BSBehaviorGraphExtraData) plays what its graph plays: each
  placed object runs its own copy, started when it is placed (its 3D loads), on the renderer's
  clock. Several sequences can play at once (a barrier's shader loop beside its idle, a word
  wall's Waiting beside its UVAnim), each from its own start; the model's free controllers
  play under them.

## Object graphs

`ObjectGraph` runs the subset of the Havok Behavior runtime that objects need:

- **Start**: every state machine enters its start state (startStateId, or the variable bound
  to it; random start states by probability, from a generator seeded with the reference's form
  id so a reference starts the same way every time it loads). Blenders activate the children
  with weight (with flag 0x8 all of them; parametric blends the two around the parameter).
  Modifier generators pass through.
- **Leaves**: a BGSGamebryoSequenceGenerator plays its NIF sequence with weight fPercent
  (blend mode 1), 1 − fPercent (2) or 1; at weight 0 it plays nothing (a toggleable fire's
  partA at the start). A sequence the mesh does not have plays nothing and sends nothing.
- **Events**: the text keys of the playing sequences are sent to the graph as events when the
  sequence passes them (looping ones every cycle, reverse ones back and forth, clamped ones
  once), by name, case-insensitively, at the moment they pass, not at the frame that notices:
  AutoPlay's `end` starts AutoLoop exactly when the intro ends. An event takes the first usable
  transition of the current state, then the state machine's wildcards (outermost machine
  first; disabled ones and those whose condition does not hold are skipped).
- **Blends**: a transition with a blending effect fades the state left out and the state
  entered in over its duration on its blend curve (the old sequences stop sending text keys
  and stop at its end). Sequences blend as Gamebryo's blend interpolators do: where several
  animate the same value, the weighted mean of their values (weights normalised; a value one
  sequence alone animates is that sequence's whatever its weight; rotations as a normalised sum
  of aligned quaternions; a visibility the heaviest one's), over the model's free controllers.
- **Conditions** (hkbExpressionCondition) are evaluated over the graph's variables, as in the
  full runtime. Variables changed by modifiers are not (ObjectGraph runs no modifiers); graphs
  that need them play skeletal clips and run in the full runtime below. Unifying the two
  (sequences as leaves of the full runtime) and the events and variables scripts send
  (ObjectReference.PlayAnimation, SetAnimationVariable*): TODO(M8).
- Particles follow: the manager-controlled controllers of a particle system (birth rate,
  emitter active) take their values from the sequences the graph plays.

## Skeletal objects

343 object projects play Havok clips (hkbClipGenerator, .hkx animations) on the model's own
nodes: traps (swinging blades, falling logs, spike walls), the skinned bows (string and
limbs), Dwemer and Apocrypha mechanisms, the Eye of Magnus, Blackreach's glowing worms. The
session reads such a project once (`AnimationAssets.skeletalGraph`, src/shell/animation-assets.ts):
its character's Havok skeleton, every behavior file, and the clips its start states play.

- **Skeleton**: the model's node tree (ModelData.nodes, kept for every model with a graph) is
  the rig; Havok bones are matched to nodes by name, as for actors (ActorSkeleton). Nodes
  under no matched bone stay where the model, and its NIF sequences, put them; 5 meshes
  (e.g. WhiterunDragonTrap01's x_SingleBone, the `_hkp` bow proxy) have no matching node
  and do not move, as in the game.
- **Running**: every placed instance runs its own BehaviorRuntime (seeded by the reference),
  started in its graph's start pose and moved every frame with the actors
  (`animateSkeletons`, src/animation/animated-skeleton.ts). Rigid parts hang on their pose
  node, skinned parts (bows) follow their bones' palette.
- **Collision**: bodies on moved nodes are fixed in the NIF (482 of 487); the game moves them
  with the node, so they are keyframed and follow the pose (`PlaySession`, moved by the
  rest-to-pose change of their node).
- **Start pose**: most wait in a looping state for an event (traps' TrapStart, bows' Idle);
  their rest pose is that state's first frame. CasSecEntrance01 (the Volkihar courtyard's
  secret stair, Valerica's dial puzzle) stands closed in ClosedLoop, which is its rest
  pose; its `Open` clip lowers and turns the platforms and stair by 24 units. The events
  come from scripts and activation (traps' trigger volumes, the dials): TODO(M8).
- Graphs that play both clips and NIF sequences (WhiterunDragonTrap01, TrapBladeSwinging01,
  the bound bow) run both: the sequences through `ObjectGraph`, the clips through the
  runtime (TODO(M8): one runtime, so an event reaches both).

## Actors

How placed actors (ACHR) appear and move (`src/shell/actors.ts`, `src/animation/skeleton.ts`;
their look: [formats/esm.md](formats/esm.md#actors)).

- **Skeleton:** the race's skeleton model (RACE ANAM, e.g. `character assets\skeleton.nif`)
  gives the node tree (`buildRig`, read in an asset worker; the root's own transform is
  ignored, as for models). The race's behavior project (RACE NAM3, `DefaultMale.hkx`) names its
  character (`loadCharacterInfo`: hkbCharacterStringData, name 160, rigName 168, ragdollName
  176, behaviorFilename 184, animationNames 48, all relative to the project's folder): the
  Havok skeleton (`character assets\skeleton.hkx`) whose bones are matched to the nodes by
  name (96 of the 99 human bones).
- **Pose** (`ActorPose`): every node's model-space matrix: animated nodes from the bones'
  local hkQsTransforms (translation, quaternion, scale), the others under their parent as the
  skeleton model places them. The Havok reference pose is the skeleton model's rest exactly
  (checked to 0.001 units); a body skinned with it is its own rest pose.
- **Models:** each worn addon's model (its `_0` and `_1` blended by weight in the worker) and
  the FaceGen head are skinned to the pose: their bones are found by name in the skeleton
  (`ModelInstance.pose`), and their palettes are rewritten whenever the pose changes. One
  instance per model, all at the reference: upright (only the turn about z), at the race's
  height times the actor's and the reference's scale.
- **What plays:** the race's behavior graph (below), started when the actor is placed with
  the clips its start states play loaded, then run on by a moment its reference picks (actors
  placed together do not breathe together); clips load as the graph first asks for them (the
  female clip for women where one exists). Actors stand where they were placed until their
  AI packages move them (M10).

## Faces

An actor's face (`FaceAnimation`, `src/animation/face.ts`) sets the weights of its head
parts' expression morphs every frame (the TRI morph names: 17 expressions, 14 modifiers, 16
phonemes, in the order the game's `mfg` console commands number them); the renderer adds
the morphs to the FaceGen head's shapes (rendering.md, Skinning).

- **Blinking:** after a delay between fBlinkDelayMin and fBlinkDelayMax (0.5–2.5 s), both
  lids close over fBlinkDownTime (0.04 s) and open over fBlinkUpTime (0.14 s); each face has
  its own random sequence (seeded by the reference).
- **Expression:** one of the 17 (MoodHappy, DialogueAnger, CombatShout, ...) held at a
  strength. TODO(M10): moods from AI and combat, dialogue emotions from the responses (INFO
  TRDT emotion type and value).
- **Speech:** a line's lip-sync curves (formats/audio.md, LIP) drive the phonemes and the
  modifiers (blinks join the face's own, the strongest wins; brows, eye looks). The curves
  start with their lead-in frames, the audio after them, at the head through the 3D dialogue
  output model (DOBJ DOP2) in the dialogue category (DDSC). The lines' head pitch, roll and
  yaw are kept for head tracking (TODO(M10), which moves the same bone); creature lines
  (8 curves) move jaws (TODO(M10)).
- **Testing until dialogue (M9):** in the sandbox, the crosshair finds an actor along the
  activation ray (within fActivatePickRadius of the line from its feet to its head; TODO(M10):
  actors' own collision) and "Talk" makes it say a random line of its voice type (NPC VTCK,
  `sound\voice\<plugin>\<voice type>\`).
- Not applied: the TRI's SkinnyMorph (FaceGen heads are baked with the actor's weight:
  formats/esm.md, Actors) and the Races / CharGen morphs (baked by the Creation Kit). Idle eye
  movement by emotion (fEyeHeading/PitchMin/MaxOffsetEmotion*) and looking at things: TODO(M10)
  with head tracking.

## Behavior runtime

Actors run their race's behavior project (`src/animation/behavior-runtime.ts`; offline:
`node tools/behavior-run.ts <project> --set Speed=150 --event moveStart`): the root behavior
file and every file it references (`loadBehaviorFiles`: 17 for humans, `0_Master.hkx` →
`MT_Behavior.hkx`, …). Variables and events are the character's: each file's are joined to
them by name (a variable keeps the first file's initial value). Each frame:

1. **Events** sent to it (and those raised while handling them, a few rounds) go to every
   active node. A **state machine** takes the transition of its current state or its
   wildcards whose event it is (not disabled; its condition holding, see the expressions
   below; from the nested state it names; within its trigger interval by time), the highest
   priority first (TODO(M13): Havok does not document which way priorities go; the few
   vanilla ones read as higher wins), then in order. Its own events return to the previous
   state, take a random state or the next higher / lower state id. Leaving a state raises its
   exit events, entering one its enter events and the machine's change event; a transition
   with a blending effect (duration, curve) plays both states and blends them, an instant one
   switches; a self transition starts the state over (unless its effect continues); a
   transition into a nested state sets that machine's start.
2. **Update** of the active nodes: transitions without an event whose condition holds are
   taken; clips advance by their playback speed (looping, single play, ping-pong, user
   controlled; an enforced duration plays the clip in that time) and raise their triggers
   and the animation's annotations as they pass them (unless the clip's flag 0x10 says not
   to); a syncing blender (flag 0x1) plays its clips at one phase, advanced by the time over
   their weighted duration; modifiers run: expressions assign variables or raise events
   (once, on true, false to true, every frame once true), BSIsActiveModifier sets its bound
   flags while active, timers, event-driven modifiers, events every N events, damping (PID),
   value interpolation, events from ranges, modify-once modifiers.
3. **Pose:** clips are sampled (additive clips hold differences, laid on what is below);
   blenders sum their children's poses by normalised weights (parametric ones by their
   blend parameter, cyclic ones wrapping), per bone where bone weights limit a child; bone
   switches take the bones of their children over the default's; transitions blend their two
   states by the curve. Nodes that stop being active are deactivated (exit events, modifier
   resets, BSEventOnDeactivateModifier's event).

**Expressions** (`behavior-expression.ts`): conditions, assignments (`var = expr`) and raised
events (`event if (expr)`) over the character's variables, with C's operators and the
functions the vanilla graphs use (cond, fabs, clamp, min, max, sind, cos, …); 352 of the 353
vanilla expressions parse, the last is malformed in the data and never holds.

A standing NPC (variable IsNPC 1) reaches `MT_Standing_State` and plays `MT_Idle` with
`MT_Idle_Skinny`; `moveStart` with a Speed brings it to `Default_Locomotion_State`, walk and run
blended by speed in step, raising FootLeft / FootRight. All 53 skeletons of the placed actors
start their graph and play idles (`tools/actor-info.ts --audit --deep`); some creatures start
in a combat idle (dragons, rieklings) or a transform (vampire lords, werewolves) until the
engine sets the variables of their state (TODO(M10)). Not yet: procedural modifiers (look-at,
foot IK, twists, keyframed bones, ragdoll controls: TODO(M10)), the engine's events and
variables of movement and combat (M10, M11).

**Intervals:** a transition with a trigger interval (flag 0x1) is taken only within it, one
with an initiate interval (0x2) is kept until it begins when triggered before (unless one kept
already is uninterruptible while delayed, 0x8). Each end of an interval is an event received
in the state (an attack window between R1_Start and R1_Stop, raised by the clip's annotations)
or else a time in the state (an exit time of 0 never ends). Vanilla: 30 trigger intervals and
466 initiate intervals (InitiateStart..InitiateEnd: getting up from a seat, out of an idle),
all bounded by events.

**BSCyclicBlendTransitionGenerator** (directional blends of werewolves, vampire lords, wisps):
its CyclicFreeze event holds its blender's parameter where it is; CyclicCrossBlend fades from
the pose at that parameter to the live one over its transition duration on its blend curve,
the children at both parameters playing on meanwhile (the engine sends the events when a
direction wraps around: TODO(M10) with movement). **BSOffsetAnimationGenerator** lays a clip
on its generator's pose, sampled at the time its variable picks (rangeStart..rangeEnd over the
clip), additively for additive clips. Its vanilla use is the characters' weapon adjustment:
weapAdj picks how far `weaponAdjustment.hkx` pushes the sheathed weapons out; the engine sets
it from the armour (ARMA DNAM weapon adjust, f32 at 8): only body pieces vary it in the data
(0.1–0.65; helmets and the rest are 0 or 1), so it is the cuirass's (slot 32; TODO(M13): not
documented).
