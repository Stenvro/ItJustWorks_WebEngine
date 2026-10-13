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
  first; disabled ones and those with a condition are skipped).
- Not yet: the blend of a transition effect between the two states (switched at once),
  conditions (hkbExpressionCondition), variables changed by modifiers and scripts, weighted
  blending of sequences below 1, skeletal clips (hkbClipGenerator): TODO(M7). Events from
  scripts (ObjectReference.PlayAnimation, SetAnimationVariable*): TODO(M8).
- Particles follow: the manager-controlled controllers of a particle system (birth rate,
  emitter active) take their values from the sequences the graph plays.
- Meshes whose graph plays Havok animations (hkbClipGenerator clips, .hkx files) stand in their
  rest pose until those play (TODO(M7)), and so does their collision: the Volkihar courtyard's
  secret stair (CasSecEntrance01, Valerica's dial puzzle) shows neither closed nor open, its
  spiral half under the platforms; opening it is the puzzle's script (TODO(M8)).

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
foot IK, twists, keyframed bones, ragdoll controls: TODO(M10)), BSCyclicBlendTransition's
freezing and cross-blending, BSOffsetAnimationGenerator's offset clip (TODO(M7)), the events
of a trigger interval, the engine's events and variables of movement and combat (M10, M11).
