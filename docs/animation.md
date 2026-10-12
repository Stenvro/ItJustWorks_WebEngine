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
