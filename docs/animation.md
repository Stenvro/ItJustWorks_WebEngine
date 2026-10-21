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
  that need them play skeletal clips and run in the full runtime below. The events and
  variables scripts send (ObjectReference.PlayAnimation, SetAnimationVariable*) reach the
  graph, and the text keys it plays reach their OnAnimationEvent.
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
  come from their scripts (traps' trigger volumes, the dials), which the script runtime runs;
  the events the graph raises reach the scripts' OnAnimationEvent.
- Graphs that play both clips and NIF sequences (WhiterunDragonTrap01, TrapBladeSwinging01,
  the bound bow) run both: the sequences through `ObjectGraph`, the clips through the
  runtime; an event or variable from a script reaches both, as it reaches the one graph in
  the game (`placedScriptGraph`, src/shell/script-world.ts).

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
  female clip for women where one exists). Actors stand where they were placed (set on the
  ground: [physics.md](physics.md#actors-on-the-ground)); near the player their movement drives
  their graph and their clips' root motion moves them ([ai.md](ai.md#movement)).
- **What they wear plays too:** a worn model with a behavior graph of its own runs it (the
  Dwemer centurion's `FXSteamCenturionFogSkin.nif`: Autoplay plays its AutoPlay, then loops
  AutoLoop, scrolling the steam's texture along its skin; without it the steam stood still
  around its joints).
- **How often they move:** near the camera (512 units) and in front of it every frame; behind
  it or beyond 2048 units ten times a second, beyond 4096 five times a second, their graphs
  then running the longer step at once (`animationInterval`). In Whiterun's 25 cells this
  took the actors' per-frame cost from 6.1 to 0.3 ms. The engine's own scheme (actors'
  processing levels) is not documented: TODO(M13).

## The player

The player's body (`player-avatar.ts`) is the Player actor (NPC_ 0x7, reference 0x14) placed like
any actor: its race's skeleton, its outfit (the iron set) and its head, in the player's
appearance (`GameState.playerAppearance`: the race menu's choices, made from the Player record
when first needed; `src/shell/player-look.ts`). Its race (Actor.SetRace's, else the appearance's),
sex, weight, head parts, hair colour (HCLF), skin tone (QNAM) and complexion (FTST) go over the
Player record's (`LookOverrides`). No FaceGen head is baked for the player (the engine makes it
at run time), so its head is put together from its head parts (`ActorLook.headParts`: the
race's defaults, those of a type it has its own of replaced, and the parts they bring along:
head, mouth, eyes, hair, hairline for the vanilla Nord), each shaped for the face: the part's
model's own positions plus its race morph TRI (the race's NAM8 morph race at 1), its chargen
morph TRI (the NAM9 pairs, the NAMA types) and SkinnyMorph by the weight
(`src/gameplay/chargen-morphs.ts`, measured against the baked FaceGen heads), baked on the CPU
into the player's own copy of the part (the expressions still play on the GPU over it). The face
takes its complexion's textures as the baked heads have them (TX03 the subsurface map in slot 2,
TX04 the detail map in slot 3) and the face tint in slot 6: the appearance's tint layers
composited over the race's masks (`composeFaceTint`) into a 512×512 texture the engine writes.
The body is made again when the appearance changes (the race menu) or a script changes the
player's race (`ScriptWorld.lookChanged`; the other sex brings the other first-person graph); a
part is baked again only when the weights of its own morphs change, and a tint alone only
paints the texture again. Its race's height sets the cameras' (TODO(M13): the character
controller keeps the size it was made with). It is drawn in third person, from the free camera
and from the race menu's camera; in first person nothing of it is drawn (TODO(M11): the
first-person arms once weapons or spells are drawn; TODO(M13): the third-person body's shadow,
which the game casts in first person too). A menu that shows the player (the race menu)
animates the body on real time while the game stands still, and turns it itself.

Two graphs run: the race's (`defaultmale.hkx`) on the body and the first-person one
(`_1stperson\firstperson.hkx`) on the first-person skeleton (`_1stperson\skeleton.nif` with
`skeletonfirst.hkx`, 99 bones), whose **Camera1st [Cam1]** bone is the first-person camera:
120.5 units up at rest, 86.4 in SneakMTIdle (times the race's height). The player's movement
drives both, as the engine drives them: Speed (the controller's horizontal speed, game units per
second), Direction (the movement against the facing: 0 ahead, 0.25 right, 0.5 behind, 0.75 left),
IsSprinting, IsSneaking; moveStart / moveStop when it starts and stops moving (over 5 units per
second), SprintStart / SprintStop, SneakStart / SneakStop, SwimStart / SwimStop, and
**iSyncIdleLocomotion** with them (1 moving, 0 standing): the executable names it and no vanilla
graph writes it outside blocking, while 38 state machines start from it and leave state 0 on
moveStart and state 1 on moveStop; without it, landing from a jump while running restarted
`MT_Default_Behavior` standing (no new moveStart comes while the player keeps moving). A jump sends
JumpStandingStart or JumpDirectionalStart; the jump clip's **JumpUp** annotation pushes off (the
controller's take-off speed from fJumpHeightMin), JumpFall goes out once it comes down and
JumpLand (JumpLandDirectional when moving) when it stands again. In third person the body turns
to the way it moves (weapons sheathed) at the movement type's rotate-while-moving rate
(NPCDefault); in first person it faces where the camera looks.

**Bone weights** shorter than the skeleton count 1 for the bones they lack: the first-person
graph's BodyWeightBlend gives its main branch 97 weights, from before the camera bones (97, 98)
were added to the skeleton; counted as 0, the camera would never leave its rest (the game lowers
it when sneaking).

## Faces

An actor's face (`FaceAnimation`, `src/animation/face.ts`) sets the weights of its head
parts' expression morphs every frame (the TRI morph names: 17 expressions, 14 modifiers, 16
phonemes, in the order the game's `mfg` console commands number them); the renderer adds
the morphs to the FaceGen head's shapes (rendering.md, Skinning).

- **Blinking:** after a delay between fBlinkDelayMin and fBlinkDelayMax (0.5–2.5 s), both
  lids close over fBlinkDownTime (0.04 s) and open over fBlinkUpTime (0.14 s); each face has
  its own random sequence (seeded by the reference).
- **Expression:** one of the 17 (MoodHappy, DialogueAnger, CombatShout, ...) held at a
  strength. A response's emotion (INFO TRDT emotion type and value: anger, disgust, fear,
  sad, happy, surprise, puzzled as the Dialogue* expressions; neutral none) shows over it while
  it is said, eased in and out over 0.3 s (TODO(M13): the engine's blend). TODO(M10): moods
  from AI and combat.
- **Speech:** a line's lip-sync curves (formats/audio.md, LIP) drive the phonemes and the
  modifiers (blinks join the face's own, the strongest wins; brows, eye looks). The curves
  start with their lead-in frames, the audio after them, at the head through the 3D dialogue
  output model (DOBJ DOP2) in the dialogue category (DDSC). The lines' head pitch, roll and
  yaw turn the head bone over the graph's pose (BehaviorRuntime.headTurn; TODO(M13): the
  signs of FaceFX's head curves); creature lines
  (8 curves) set the creature's behavior graph's lip variables, which move its mouth
  (ai.md, Talking).
- **Sandbox (debug only), Talk:** in the sandbox, the crosshair finds an actor along the
  activation ray (within fActivatePickRadius of the line from its feet to its head; TODO(M10):
  actors' own collision) and "Talk" makes it say a random line of its voice type (NPC VTCK,
  `sound\voice\<plugin>\<voice type>\`).
- Not applied: the TRI's SkinnyMorph (FaceGen heads are baked with the actor's weight:
  formats/esm.md, Actors) and the Races / CharGen morphs (baked by the Creation Kit).
- **Eyes:** they look where the graph's look-at turned the eye bone (Head tracking, below),
  by the look morphs (LookLeft/Right at 29°, LookUp/Down at 16°: measured on eyesmale.tri and
  eyesfemale.tri; the engine's BSFaceGenAnimationData eyesHeading and eyesPitch), wandering by
  a random offset in the range of the face's emotion (fEyeHeading/PitchMin/MaxOffsetEmotion*;
  a new one every 1–3 s, TODO(M13)); a line's own looks join them.

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
   transition into a nested state sets that machine's start. A global wildcard (flag 0x400) of
   a machine nested in another state of a machine is that machine's too: taken, it goes to the
   state holding the nested machine, which starts in the wildcard's state (Master_Behavior has
   no way into Cart_State but its Cart machine's IdleCartPrisonerASway). Paired animations
   (Paired_Mount.hkx, killmoves) name their tracks: "PairedRoot", the first actor's bones and the
   second's prefixed "2_"; each actor's graph takes its own bones' tracks by name
   (`src/animation/paired-clips.ts`). A machine with a sync variable writes the id
   of the state it enters into it, and one whose start mode is SYNC starts from it (sneaking
   locomotion and the idle turns share iIsInSneak that way).
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
engine sets the variables of their state (TODO(M10)). The dead run no graph: their ragdolls pose them
(physics.md, Constraints and ragdolls). Procedural modifiers: below. Not yet: the engine's
events and variables of combat (M10 5.x, M11).

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

## Procedural modifiers

What the graphs' procedural modifiers do to the pose the clips gave
(`src/animation/procedural.ts`, run by the behavior runtime where the graph has them: an
hkbModifierGenerator lays its modifier on its generator's pose, a list's in order). Members:
the Havok 2010.2 headers (Project Anarchy), CommonLibSSE's BSLookAtModifier; member offsets:
`src/formats/hkx/layouts.ts` (checked against the vanilla files). The census of every vanilla
behavior file: `node tools/behavior-run.ts --modifiers`; one graph with a target or a slope:
`node tools/behavior-run.ts <project> --set IsNPC=1 --look 100,150,120`,
`--set bHumanoidFootIKEnable=1 --slope 20`. Gains are fractions per step of the Behavior
Tool's 30 Hz, made frame-rate independent (1 − (1 − g)^(30 dt); TODO(M13)).

- **BSLookAtModifier** (128 in 36 files; the humans' in the root modifier list, enabled by
  IsNPC): its bones (Spine1, Spine2, Neck, Head: 5°, 20°, 20°, 30°) each turn their forward
  axis towards the target within their own limit, each taking its turn from the pose the last
  left, then the eye bone (70°). Each bone's look eases by its gains (LookAtOnGain 0.12,
  LookAtOffGain 0.015; the eyes' 1). The target is TargetLocation (a world point, the engine's)
  while bHeadTracking holds, or the camera (camerafromx/y/z) with lookAtCamera; it is outside
  the limits beyond 85° from the character's forward (seen from the head), inside again within
  the threshold (10°): LookAtOutOfRange, and the event once; with continueLookOutsideOfLimit
  the bones keep looking. TODO(M13): Bethesda's class is not documented; this reading of its
  members turns a standing NPC's head about 50° and its eyes the rest to a target 80° to its
  right.
- **BSDirectAtModifier** (23: bows, spells, the dragon rider): the chain from start to end
  bone turns by the heading and pitch from the source bone to the target (within the limits,
  plus the offsets), eased by its gains; its outputs (active, current heading and pitch) go
  to their variables. The target: a bound vector, the camera, or the aim the engine gives its
  kind (BehaviorRuntime.setDirectAtTarget by userInfo: 2 bows and spells, 3 the dragon rider).
  Casting gives the aim of aimed spells (docs/ai.md, "Magic in combat"); TODO(M10) 5.1: bows'.
- **hkbTwistModifier** (19: the first-person body's pitch and lean, bow draws, a netch's lean,
  a tail's turn): the chain from start to end bone turns about the axis (in model space in
  every vanilla one) by the angle (degrees: 1stPRot = sin(Direction · 360) · RotMax, RotMax 5),
  shared equally (linear) or growing along the chain (ramped).
- **Foot IK** (hkbFootIkDriver on the character's hkbFootIkDriverInfo while the graph's
  hkbFootIkControlsModifier is active and enabled; hkbFootIkModifier with legs of its own, the
  dragon's): under each ankle a ray (from raycastDistanceUp above, 40, to raycastDistanceDown
  below, 32) finds the ground; the leg's error is its height over the model's ground, eased by
  the ground gains. Quadrupeds lean to the plane of their feet's ground
  (alignWorldFromModelGain); the body goes down by the worldFromModel feedback
  (m_worldFromModelFeedbackGain 0.35 for humans; errorUpDownBias 1: as far as the lowest foot
  needs). Each ankle then goes to its animated height over its own ground (within its min and
  max heights), the knee turned about its hinge (its interior angle within its limits), the hip
  swinging the leg onto it, the foot keeping its animated turn, tilted to the slope where
  planted (ankleOrientationGain, maxAnkleAngleDegrees). It eases on and off by onOffGain,
  keeping what it found while off. The engine turns humans' on (bHumanoidFootIKEnable 1; the
  graph turns it off in furniture; TODO(M13): when the engine sets it); bHumanoidFootIKDisable
  (set by state machines' isActive outputs and BSIsActiveModifiers: swimming, killmoves,
  bleedout, jumps, mounts) turns it off. The rays see what character controllers stand on,
  the actor's own controller left out (TODO(M13): the driver's own filter, L_TRANSPARENT, would
  see its ragdoll). TODO(M13): locking planted feet and the planted and raised gains are not
  documented.
- **hkbKeyframeBonesModifier** (91): the ragdoll bones it keeps keyframed
  (BehaviorRuntime.keyframedRagdollBones: the living's lower body; the whole ragdoll on its way
  to ragdolling). The living's bodies all follow the pose now (actor-bodies.ts); TODO(M10) 5.1:
  hits push the others, driven by the rigid body ragdoll controls.
- **hkbRotateCharacterModifier** (6): turns the character at TurnDelta in the equip and unequip
  states; the movers make that turn already, so the graph's root motion leaves it out.
- **The dragon's flight modifiers** (docs/ai.md, "Flying combat"): BSTweenerModifier carries
  the character to the engine's TweenPosition and TweenRotation (the landing spot, the hover
  point, the actor grabbed) over its tween duration or what was left of the clips below it as
  it began: it overrides the clips' root motion where it tweens (linear; TODO(M13): Havok's
  curve). BSPassByTargetTriggerModifier raises its event (DragonPassByEffect) as the
  character, within its radius of the target (the engine's: `world.passByTarget`), has it go
  from ahead to behind. BSTimerModifier is hkbTimerModifier with resetAlarm (its alarm again
  and again: PickNewIdle), BSGetTimeStepModifier writes the step (TimeStep: the flight's
  acceleration and drag expressions), BSDecomposeVectorModifier splits a vector
  (MovementDirection into MoveDirZ), hkbTransformVectorModifier transforms one (the grabbed
  actor's ConstraintOffset), BSLimbIKModifier bends the tail up off the ground (rays from
  castOffset above each bone, the chain's first bone turned within its limit, eased by its
  gain; TODO(M13): Bethesda's solver).
- Not run, by milestone (behavior.ts): the ragdoll's controls, get-up and contact listener
  (TODO(M10) 5.1) and BSIStateManagerModifier (M11, with the beast forms).

## Head tracking

Where actors look (`src/ai/head-tracking.ts`, `src/shell/actor-looks.ts`): an actor has a
head track target of each kind (CommonLibSSE HEAD_TRACK_TYPE: default, action, script, combat,
dialogue, procedure); the highest set is looked at (TODO(M13): the order is the enum's).
Scripts' Actor.SetLookAt and ClearLookAt are 'script'; scenes' looks, speakers talking to
someone and the actor talking with the player are 'dialogue'; other code asks through
`session.scriptWorld.lookTargets.lookAt(actor, target, kind)` (a reference or a world point;
undefined lets go). Without any, an actor looks at the player within 512 units in front of it
(TODO(M13): the engine's rule; TODO(M10) 4.1: once it detects them). Actor.SetHeadTracking(false)
and the graph's HeadTrackingOff (graphs' and clips' events; actorresponse.txt's
HeadTrackingOffHandler; HeadTrackingOn again) stop it. The point looked at turns towards the
target at fHeadTrackSpeedMax (200° a second) when more than fHeadTrackSpeedMaxAngle (10°) off,
fHeadTrackSpeedMin (60°) within fHeadTrackSpeedMinAngle (5°), now and then off it by
fAIHeadTrack*'s random offset (0 in Skyrim.esm); it reaches the graph as bHeadTracking and
TargetLocation, the camera as camerafromx/y/z. The player's body looks the same way at what
scripts, scenes and dialogue ask and else, in third person, where the camera looks
(TODO(M13): the engine's own player head tracking is not documented).
