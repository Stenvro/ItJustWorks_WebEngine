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

## Held weapons

Every vanilla bow and crossbow model names a project of its own (BSBehaviorGraphExtraData;
`node tools/held-weapon-info.ts`): `Weapons\Bow\BowProject.hkx` (540 models), the iron,
ebony, nightingale, falmer, wooden and bound bows' copies of it, and the two DLC01 crossbow
projects. Their character is a 7-bone skeleton (Bow_MidBone, the upper and lower limbs, the
two string bones) that the model's skinned bow follows. The first-person model (WNAM) is the
same NIF with the same graph (only `1stPersonIronBow.nif`, used by no weapon, lacks it); a
weapon without WNAM (the bound bow) shows its world model in first person.

The engine runs that graph beside its wielder's (`WeaponGraph`, src/animation/weapon-graph.ts,
on the models combat hangs on actors and on the first-person arms: src/shell/actor-weapons.ts):

- **Events:** every event the wielder's graph raises goes to the weapon's graph, which takes
  those it knows. BowBehavior's are exactly the ones the people's (third and first person),
  the draugr's and the falmer's graphs raise: `BowDraw` (Idle → Draw: DrawNock plays
  Bow_DrawLight), `bowDrawStart` (DrawNock → DrawPull), `BowRelease` (→ Release, Bow_Release),
  `bowReset` (wildcard → Idle), and the draugr's `BowDrawDraugr` (the heavy draw). Its own
  clips raise `BowDrawOut` (DrawPull → IdleDrawn: the string held) and `BowReleaseOut`
  (Release → Idle). The crossbows' take `BowDraw`, `BowRelease`, `BowReleaseFast`, `Reload`,
  `ReloadFast`, `attackStop` and `bowReset`, and raise `reloadOut`, `BowReleaseOut`. Nothing
  in them listens to the bow zoom (`bowZoomStart`, `bowZoomStop`: the camera's).
- **Variables:** the ones the engine sets on the wielder go to the weapon too (as combat sets
  them on the actor's graphs): `weaponSpeedMult`, which DrawPull's clip plays at (bound to its
  playback speed; at the graph's own 0 the string would stop half drawn), and the crossbows'
  `bPerkQuickDraw` (a perk's Set Boolean Graph Variable). `blendDefault` is the graph's own.
- **Pose:** the graph runs on the model's nodes as a skeletal object's does (its bones matched
  to the nodes by name, `startObjectSkeleton`), stepped with its wielder's combat update; its
  pose is in the model's space, and the model's root is the node it hangs on (SHIELD in the
  bow hand, WEAPON for a crossbow, WeaponBow at the back), so each moved node is that node's
  matrix times its pose. Sheathed, the bow waits in Idle (Bow_DrawHeavy's first frame, its
  rest).

## Weapons in the hands

Where the drawn weapons hang, what the engine tells the graphs about the hands, and how the
arms aim (`src/gameplay/equipment.ts` weaponNodes, `src/shell/actor-weapons.ts`,
`src/shell/actor-combat.ts`, `src/shell/actor-looks.ts`; observed in the original, in our
words). For NPCs and the player in third person; the first-person arms take the same nodes.

**Nodes.** A drawn weapon hangs on SHIELD when it is in the left hand or is a bow (animation
type 7), else on WEAPON (the right hand): the engine's attach and detach code picks the node
by exactly that rule. The bow animations hold the bow in the left hand and carry the WEAPON
bone (a child of the right hand) to where the nocked arrow lies, its forward along the shot;
the engine hangs the nocked arrow (the AMMO model's "Arrow:0") on WEAPON. With the bow on WEAPON
(as here before) it lay along the shot, level with the ground: the "horizontal bow" of
Helgen's archers. Measured with the human graph offline at full draw: SHIELD's up axis is
0.81–0.87 upright (the bow's cant) whatever the aim, WEAPON's forward within 0.3° of the aim.
A crossbow (type 9) stays on WEAPON, as do staves; a torch and a shield are on SHIELD. Detached
as it is sheathed, a weapon goes to its type's sheath node (sword WeaponSword, dagger
WeaponDagger, axe WeaponAxe, mace WeaponMace, both two-handed WeaponBack, bow and crossbow
WeaponBow); the models' own "Prn" names the same nodes (a staff's WeaponStaff is no node of
the vanilla skeleton: a sheathed staff is not shown).

**Hand variables.** iRightHandType and iLeftHandType are the hands' GetEquippedItemType codes
(0 hand to hand, 1 sword, 2 dagger, 3 axe, 4 mace, 5 greatsword, 6 battleaxe, 7 bow, 8 staff,
9 spell or scroll, 10 shield, 11 torch, 12 crossbow; a two-handed weapon both hands'). The
graphs' state machines and manual selectors start the hand's states by them (the audit below).
**iRightHandEquipped and iLeftHandEquipped** are not flags: while the weapons are out they
hold the same codes, while sheathed 0. The engine sets them as the drawn weapon reaches the
hand (the weaponDraw annotation's handler) and clears them as it is sheathed. Manual selectors
index by them: the sprint's two sides (a bow's, a torch's, a shield's run), the jumps' and the
shouts' crossbow variants, a rider's staggers and jumps. Set as 1 for any weapon (as here
before), a drawn bow sprinted, jumped and shouted as a sword and a torch's run was a weapon's.

**The player's graph.** The engine tells the player's graph IsPlayer 1, IsNPC 0 and iIsPlayer
1 as it sets it up (NPCs' graphs IsNPC 1). The graphs differ by it: blocking, bashing and
drawing again while drawn are the player's own transitions (a bow cannot block, its block is
the zoom; an NPC may attack straight out of a block); the look-at (BSLookAtModifier) and the
spine's direct-at for bows and spells are NPCs' only; the player's bow attack twists the spine
instead (1hm_behavior's PlayerBowModList, enabled by IsPlayer: BowAttackSpineTwistModifier,
Spine to Spine2 about the model's x axis by **Pitch**). Pitch is a graph data channel: the
actor's process pitch in degrees (observed in the original); the player's is where they look, up positive
(the body's graph only: the first-person arms are placed pitched with the view already). The
player's head therefore no longer follows dialogue partners, as the game's player's does not.

**Aim (BSDirectAtModifier).** The engine gives each modifier kind (userInfo) its target
through one interface, every update:

| Kind | Modifiers                                                                                                                                                           | Target                                                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | blockbehavior's BlockAnticipate\_\*\_BSDirectAtModifier (no source bone; heading and pitch offsets such as 20° and −20° for one-handed, −40° and −20° for a shield) | the WEAPON node of the actor its head tracks (the highest kind of head track set, as asked, not the eased look), if that is another actor; else none |
| 2, 3 | BSDirectAtModifier_Bow (bows and crossbows, from Spine2 turning Spine to Spine2), BSDirectAtModifier_Magic, the mounted bow's, the dragon rider's                   | an NPC: the point its combat aim points at (its movement controller's aim); the player: 4000 units along their view                                  |

Ours: an NPC holding a bow or crossbow out with a target (a fighter, or a practice's point)
aims 2048 units along where its shot would go (docs/gameplay.md, "Aiming projectiles") from the
moment it draws, so its spine has turned by the time the arrow is nocked (the modifier eases on
at 0.05 a step); the arrow leaves from WEAPON along that aim. Combat gives an NPC's combat
target to its combat head track (HEAD_TRACK_TYPE combat), which block anticipation reads.

**Measured in the browser** (Riverwood, `coc`, the shooters' UseWeapon practice at the player
600 units off, Archery as the actors have it): a bandit archer 5 of 5 arrows on the player, a
Whiterun guard 3 of 3, an Imperial soldier (MQ101ImperialArcherMale, Helgen's archers' base)
3 of 3; a bandit in its own combat drew, shot and hit. The nocked arrow pointed within 2–5° of
the line to the player's chest at full draw (the aim is taken from Spine2, the arrow lies off
it, and the shot is arced). The player in third person: the nocked arrow within 0.6° of the
look at 0°, +20° and −17°. In the opening (a new game left to run), as Lokir ran at stage 70
one of Helgen's archers drew, its spine turned to him (bAimActive 1) and its one arrow killed
him; the other drew and put its bow away. Poses of every weapon type (drawn, attacking, blocking) checked on
screenshots; the graph states the hand variables select, offline (`node tools/weapon-poses.ts`):

| Hands                     | Drawn                                                | Attack                             | Block                        |
| ------------------------- | ---------------------------------------------------- | ---------------------------------- | ---------------------------- |
| unarmed                   | H2H_Idle                                             | H2H_AttackRight                    | 1HM_BlockIdle                |
| sword, dagger, axe, mace  | 1HM_Idle (1HM_Readied_Default, Dagger_, Axe_, Mace_) | 1HM_AttackRight                    | 1HM_BlockIdle                |
| greatsword, battleaxe     | 2HM_Idle, 2HW_Idle                                   | 2HM_AttackRight, 2HW_AttackRight   | 2HM_BlockIdle, 2HW_BlockIdle |
| bow, crossbow             | Bow_IdleHeld, CrossBow_IdleHeld (lowered)            | Bow_DrawLight, CrossBow_IdleDrawn  | (attack held: drawn)         |
| staff, spell, both spells | StaffRight_Idle, MRh_Idle, MRh_Idle + MLh_Idle       | the casting states (Casting above) | none                         |
| weapon and shield, torch  | 1HM_Idle, Tor_1HMPose + 1HM_Idle                     | 1HM_AttackRight                    | Shd_BlockIdle, Tor_BlockIdle |
| two one-handed weapons    | DW1HM1HMIdle                                         | 1HM_AttackRight                    | DW1HM1HMBlockIdle            |
| weapon and spell or staff | MLh_Idle or Staff_Idle + 1HM_Idle                    | 1HM_AttackRight                    | 1HM_BlockIdle                |

The nocked shot's node is the ammunition's (observed in the original, from the engine's arrow attaching):
an arrow (AMMO flag Non-Bolt) on WEAPON, a crossbow's bolt on NPC R MagicNode [RMag]; a
non-playable ammunition shows none.

## Animation objects

The props an idle or a furniture animation puts in an actor's hands: the smith's hammer and
hot iron, the woodcutter's axe and log halves, the drinker's tankard, the bard's lute, flute
and drum, the broom, the pickaxe, the hoe, the alchemist's pestle and mortar, the cook's
spoon, the bar rag, books, quills, cuffs. Each is an ANIO record (src/world/anim-object-
records.ts; `node tools/anim-object-info.ts`): an editor id, a model (MODL, with MODT and
alternate textures, MODS) and an unload event (BNAM). The load order has 80 (63 in
Skyrim.esm); 78 are unloaded by `AnimObjectUnequip`, AnimObjectSeekerBook by
`AnimObjUnequip` (an event no graph raises) and AnimObjectLog by none. Dawnguard and
Hearthfire each define AnimObjectWoodScrap and AnimObjectDrawBlade (same models); the later
one in the load order is found (TODO(M13): which one the engine's editor id lookup keeps).

**Where they hang.** A prop's model has no graph and no clips of its own (FXChickenFeeding,
used by no vanilla graph, is the one with a graph); its root carries a "Prn" string naming the
skeleton node it goes on, as a shield's or a sheathed weapon's does. The people's skeletons
(third person, female and first person) have four nodes made for it, AnimObjectR, AnimObjectL,
AnimObjectA and AnimObjectB, which the props' clips move (`AnimObject*.hkx`, the furniture's
AO clips): 40 props hang there, the others straight on a body node (NPC R Hand 21, the hands'
magic nodes 6, NPC L Hand 4, NPC Spine2 for the lute and drum, the forearms for cuffs, the
head magic node for the Seeker's book, NPC Root, NPC COM for the boat). The Riekling's chisels
name its hands ("NPC R Hand"). No "2_" nodes are named: in a paired animation each actor
holds its own props on its own skeleton.

**The events.** The graphs name the props by editor id in the payloads of two events, which
meshes\responses\actorresponse.txt gives to the engine: `AnimObjLoad`
(AnimationObjectLoadHandler) and `AnimObjDraw` (AnimationObjectDrawHandler). The people's
graphs raise them as states are entered (107 states: BlackSmith_State loads the forge hammer
and the hot iron, then draws both; WoodChop_State the axe and the two log halves;
AnimObjectLute, StandingBarDrinking, SweepingState, the chair drinking and eating states) and
from clip triggers (22 clips: the chair drinker's tankard is drawn as the hand reaches it,
the wood pick-up's logs). The first-person graph has 14 such states, the Riekling's and Dragonborn's
hmdaedra project's one each. Clip annotations carry the payload after a dot
(`AnimObjLoad.AnimObjectSkeletonKey`; `AnimObjLoad.DecapitationHeadGore` and
`...NeckGore`, which no record has, so they do nothing; the gore of a decapitation is the
Decapitate handler's, not an animation object's). `node tools/anim-object-info.ts --graphs`
lists them per project; every payload of a graph names a record. `AnimObjectEquip` (the table
drinking states), `AnimObjectStop`, `AnimObjectIdleStop` and `NPCAnimObjDraw` have no handler:
they do nothing.

**Observed in the original** (the handlers, the list they feed and the reference's graph
event sink). Behaviour, in our words:

- One list for all actors, an entry per actor and object with its model as attached and a
  "draw requested" flag. The load handler finds the form by editor id (only an ANIO counts;
  an unknown name does nothing) and adds an entry unless the actor has one for that object
  already, then starts loading its model in the background.
- When the model is in: an entry whose actor is gone is dropped; one whose actor has 3D has the
  model cloned and attached to that 3D (the reference's current 3D: the player's first-person
  skeleton in first person) on its "Prn" node (a model without one is left unattached and
  never shows), then hidden unless a draw came meanwhile. A female actor holding one whose node
  is a hand or under one gets both hands' scale set to 1 (the female skeletons give the hands
  0.85) and back to 0.85 when it goes. While the player holds one, their camera switch is turned
  off (the control map's POV-switch flag), and turned on again when the last goes.
- The draw handler shows the actor's entry for that object (one still loading is shown as it
  attaches); without an entry it does nothing.
- Every event a reference's graph raises reaches its graph event sink; there, an event that is
  the unload event of objects the actor holds takes all of them away (detached, the entries
  dropped). So `AnimObjectUnequip`, raised by the exits of the states that loaded them (and by
  the entries of the arm states that end a carry), clears every prop of that actor at once.
- The actor's 3D going (unloaded, made again) drops all of its entries.
- A save keeps each entry (actor, object, shown or drawn); loading one asks for the load again,
  and the draw if it was shown. TODO(M12): our saves keep them.

**Ours** (src/animation/anim-objects.ts, the list; src/shell/actor-anim-objects.ts, the models):
the same list and rules. A prop is a model instance of its own placed every frame at its node's
matrix (the body's placement times the node's pose), after the poses; its NIF controllers and
particles play as a placed object's do. The player's go on the skeleton shown when the model
comes in (`bodyShown`: the body, else the first-person arms) and stay there; while they hold
one, `Game.DisablePlayerControls`' camera switch is off. Our poses take the hands' scale from
the clips (1), so the female hand rule changes nothing here. TODO(M13): if the hands get the
skeleton's 0.85, apply the rule.

The graph event dispatch ([Graph events](#graph-events)) calls
`ActorAnimObjects.animObject(reference, 'load' | 'draw', editorId)` for the two events with
their payloads (an event's own, or an annotation's text after its dot), from every actor's graph
and the player's two, and `graphEvents(reference, names)` hears every raised event for the
unload events (`animObject(reference, 'unequip', undefined)` is the same for
`AnimObjectUnequip`).

Seen in the browser: Mikael on a bar stool with a tankard, a standing drinker cheering with
his, Mila Valentina sweeping with a broom, a lute on its player's chest, the forge hammer at a
hammering wall, the axe at a chopping block (and, in the list, bread while eating, the broom
for Saadia). The order of events matters: a state left at once has its nodes deactivated before
the new state is entered (Behavior runtime, below), so an actor going straight from
StandingBarDrinking into WoodChop_State drops the tankard (the old nested state's
`AnimObjectUnequip`) before it loads the axe, and keeps the axe.

## Ambient idles

The idles actors play by themselves while their packages leave them standing, sitting or
leaning: the idle tree's ActionIdle (315 idles for 36 graphs; the people's under NPCIdleRoot:
the hand-on-hip and arms-crossed idles, the chair idles, a counter wiped, a table drinker's mug,
the spectators' cheers, the cannibals' and vampires' feeding). `node tools/idle-info.ts --tree
ActionIdle 0_master` lists them.

**Observed in the original** (the PickNewIdle handler and the AI process's idle update), in
our words:

- Each actor's process keeps a "wants a new idle" flag. Its graph's PickNewIdle (raised as an
  idle ends, and from its standing and sitting states) sets it, unless a "skip one" flag is set,
  which that event clears instead (set as a specific idle, a package's or a script's, replaces
  one that plays: the PickNewIdle its stop raises is no request).
- While the flag is set, each AI update tries ActionIdle: the first idle of the tree whose
  conditions hold, on the actor, with its process's target (the furniture it is in: the bar
  counter's keywords, the table's). One that plays clears the flag and sets the idle wait timer
  (fAIIdleWaitTime; fAIIdleWaitTimeComplexScene while a complex scene runs, when the next try
  waits for it); none leaves the flag set, and the next update tries again. Other systems set
  the flag themselves before an action that should resolve to an idle (a trespass warning).
- It is not tried for an actor farther from the player than its 3D's bound radius / 64 ×
  fAIIdleAnimationDistance (2000; × fAIIdleAnimationLargeCreatureDistanceMult, 3, for a race
  larger than medium), nor one on its way to furniture, entering, leaving or asleep in it, one
  whose package has idles of its own (PACK IDLA: those play), or one at its meal (an Eat
  package's eating step). The tries share a time budget per frame.

**Ours** (src/ai/ambient-idles.ts, the flags and gates; src/shell/actor-ambient-idles.ts, the
stage's): the same, the idle tree's search being the furniture's `actionEvent` (as the death
actions'), the bound radius the sphere round the skeleton's posed nodes. Not yet (TODO(M13),
listed in tests/conformance/animation/ambient-idles.test.ts): which specific idles set the skip
flag, the complex scene's wait, the frame's budget, the meal's gate. Seen in the headless
simulation (the Bannered Mare at 20:00, 60 s): Hulda wiped the counter (IdleBarCounterWipe),
Lucia put a hand on her hip (IdleHDRight), Saadia and Sinmir took MotionDrivenIdle (armed:
IdleIfEquipped).

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
- **How often they move:** as the engine updates its actors' graphs: every frame near the
  camera, farther away a few times a second ahead of time with their poses interpolated
  between ([below](#how-often-graphs-update)).

## How often graphs update

Observed in the original (its graph manager's update), in our words; ours in
`animateSkeletons` and `animationRate` (`src/animation/animated-skeleton.ts`), for actors and
animated objects alike.

- **The interval.** The skeleton's distance from the camera, scaled by 80° over the field of view
  (degrees across a 4:3 frame, fDefaultWorldFOV's measure: zooming in brings it near), decides
  how often its graph updates: up to [Animation] fAnimInterpNearDist (400) every frame; beyond,
  every fAnimInterpMinTime (0.08 s), rising evenly to fAnimInterpMaxTime (0.25 s) at
  fAnimInterpFarDist (800) and beyond. One the engine does not see gets the longest interval.
- **Ahead of time.** A far graph does not run the time that has passed: it runs ahead in one
  update to where it will be an interval on, and its pose blends from the pose before into that
  one as the interval passes (the engine keeps two pose buffers and swaps them at each update).
  Far actors so move smoothly at a fraction of the cost, and nothing lags.
- **Not past a trigger.** The interval is cut to just short (half a frame) of the next trigger or
  annotation a playing clip passes (the engine walks the active clips' triggers), so that what
  the clips raise (a footstep, a sound) is raised at its moment, not up to a quarter of a second
  early (`BehaviorRuntime.nextEventIn`).
- **Not for a frame or two.** An interval no longer than (1 + fAnimInterpSlop) frames is not worth
  it: the graph updates every frame. bAnimInterpEnable 0 turns it all off.

Ours besides: a skeleton behind the camera beyond the far distance is not interpolated (it steps:
nothing of it is seen), a nearer one is (its shadow is). A graph whose variable bDisableInterp is
set updates every frame (inferred from the engine's graph variable names: the manager checks a
flag of its own there; how it is set was not read). The skeleton's `time` is its graph's, ahead
of the clock between such updates, so the time its root motion covers is the graph's step and the
movers spread that motion over the interval. Before (every frame within 512 units in front of the
camera, else 10 or 5 times a second by 2048 and 4096 units, without interpolation) far actors'
poses stepped, and the graphs of everyone between 512 and 2048 units in front ran every frame.

## Driving the graphs

How the engine drives an actor's behavior graph while it moves (`Locomotion`,
`src/ai/locomotion.ts`; observed in the original, in our words; for NPCs, creatures, horses
and the player alike).

**Where the values come from.** Every movement update the actor's movement controller says what
it wants: a speed, the direction to go in (an angle against the actor's facing) and a rotation
speed; the engine keeps them in the actor's process data and moves the actor by them. The graph
sees these wishes, not what physics made of them: an actor walking into a wall walks on the
spot. **Motion feedback** ([Animation] bFeedbackToGraphFromCharacterController, on; observed in
the original; `MotionFeedback`): once the movement an NPC's controller made has agreed with the wish
(their speeds within fMotionFeedbackMinSpeedDelta, 25 units a second; their directions within
fMotionFeedbackMinAngleDelta, 20°) for fMotionFeedbackMinTime (0.5 s), the graph is told the
movement made (its direction only above fMotionFeedbackMinSpeed, 5); until then the wish, none
below fMotionFeedbackMinSpeed, its direction turning from the one told before by at most a full
turn a second. Two graph variables change the source: with **bIsSynced** (paired and synced animations)
the speed, direction and rotation are taken from the animation's own motion instead; with
**bSpeedSynced** the speed is taken from the graph's Speed (times the actor's scale). Before
each movement update the engine reads **bAnimationDriven** and **bAllowRotation** from the graph
and switches the movement controller between controller-driven (neither set), animation-driven
(the clips' root motion moves the actor) and animation-driven with the controller still turning
it (bAllowRotation, set alone or with bAnimationDriven). It does so every update in which time
passes, comparing them with the controller's mode, so a drive handler's switch (below) holds only
while the variables agree with it. For the player the controls are the movement controller: the wanted speed
is the input's (a drop of more than fMaxMoveRampDownDelta, 500, in one update is limited to it),
dampened (bDampenPlayerControls) and the direction frozen on a large change (The player, below).

**The graph data channels** copy them into the graph's variables before every graph update. The
Speed channel divides the speed by the actor's scale (observed in the original: the divisor is its
reference's GetScale, read as the channel is made; the thresholds read the speed itself), and the
clips' root motion is in the skeleton's units, scaled with it as it moves the actor: a fox (its
race 1.2 tall) walking at 68 units a second gets Speed 57 and plays the walk whose stride, 1.2
times as long, covers 68. Before, it got 68 and played a walk whose drawn stride went 125 units a
second while it went 68 (QA foot-slide in the opening: 104 unscaled).

| Variable                                        | Value                                                                                                                                           | Actions as it crosses a threshold                                                                                                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Speed                                           | the wanted speed, units per second, over the actor's scale (its GetScale: the reference's scale times the race's height by sex times the NPC's) | reaching 5 from below: ActionMoveStart; falling below 5: ActionMoveStop                                                                                                                            |
| Direction                                       | the wanted direction against the facing, the turn wrapped to 0..1 (0 ahead, 0.25 right, 0.5 behind, 0.75 left), unsmoothed                      | between the front half (below 0.25, or from 0.75) and the back half: ActionMoveForward / ActionMoveBackward; between the right (above 0, up to 0.5) and the left: ActionMoveRight / ActionMoveLeft |
| TurnDelta                                       | the rotation speed in degrees per second, left (counter-clockwise) positive                                                                     | faster than 1° a second from slower: ActionTurnLeft (positive) or ActionTurnRight; slower again: ActionTurnStop (a change of side while turning sends nothing)                                     |
| TargetSpeed, Pitch, Roll, PitchDelta            | the target speed; the pitch and roll in degrees; the pitch rate                                                                                 | none                                                                                                                                                                                               |
| weaponSpeedMult, leftWeaponSpeedMult, TimeDelta | the hands' weapon speeds; the frame's time                                                                                                      | none                                                                                                                                                                                               |
| iWantBlock                                      | the actor's want-block flag (set as ActionLeftAttack plays blockStart, cleared as ActionLeftRelease plays blockStop)                            | none                                                                                                                                                                                               |
| bHeadTracking                                   | whether it tracks a look-at target                                                                                                              | none                                                                                                                                                                                               |

The engine never writes IsBlocking or IsSprinting: it reads them back from the graph (IsSprinting
sets the actor's sprinting state; IsBlocking slows its speed). There is no smoothing in the
channels: damping is the graphs' own (TurnDeltaDamped, DirectionDamped, SpeedDamped by their
damping modifiers). The channels hold their last value while a flag of the actor's process is
set (TODO(M13): what sets it is not known).

**Actions** are queued as the channels cross their thresholds and performed later in the frame,
each through the idle tree (the action's idle for the actor's graph: ActionMoveStart's is
moveStart in every vanilla graph that has one, the characters' only while not riding;
ActionMoveLeft and ActionMoveRight have none). Whether the graph took the event or not, the
action sets the **sync variable** that the graphs' state machines start from when they are
entered, so that a graph coming back to its locomotion (landing, an idle ended, a weapon drawn)
starts as the actor moves:

| Action                                            | Sync variable             |
| ------------------------------------------------- | ------------------------- |
| ActionMoveStart / ActionMoveStop                  | iSyncIdleLocomotion 1 / 0 |
| ActionTurnRight / ActionTurnStop / ActionTurnLeft | iSyncTurnState 0 / 1 / 2  |
| ActionMoveForward / ActionMoveBackward            | iSyncForwardState 0 / 1   |
| ActionMoveRight / ActionMoveLeft                  | iSyncStrafeState 0 / 1    |
| ActionSprintStart / ActionSprintStop              | iSyncSprintState 1 / 0    |

Nothing is retried: an action the graph does not take is lost. When the engine stops an actor's
idle (IdleStopInstant, else IdleStop) it performs the movement action again: ActionMoveStart while
iSyncIdleLocomotion says it moves, else ActionTurnRight / ActionTurnLeft while iSyncTurnState
says it turns. An actor that gets a new path (the movement message NewPath, as its pathing finds a
way) while its graph's **bForceIdleStop** is set (the dialogue idles set it) has its idle stopped at
once (ActionIdleStopInstant: the characters' IdleStopInstant), so an idle that must end before the
actor goes on ends as it sets out (`ActorMovers.#newPath`; observed in the original; TODO(M13): the stop is
skipped unless a value of the actor's high process holds its default, not identified). A horse's rider
gets copy channels as it mounts: every update its graph copies the horse graph's
iSyncIdleLocomotion and HorseSpeedSampled.

**Ours.** The movers give `Locomotion` the steering's velocity and turn rate of the last physics
step (`src/shell/actor-movers.ts`; beyond the high process the walkers' steering; the player its
controller's velocity), and it sets the variables and sends the actions' vanilla events with the
sync variables as the table says. Moved by its graph's root motion (animation-driven, or standing
while a clip moves it) an actor stands to its graph. Held by an animation-driven state while its
AI sends it away it is told moveStart (which ends such idles); as the graph lets go
(bAnimationDriven back to 0) it is told again what it does (`Locomotion.resume`: the engine's
re-performed action after an idle stop). Riders copy the horse's HorseSpeedSampled and
iSyncIdleLocomotion (`src/shell/actor-mounts.ts`). An NPC's falls and landings are the
engine's ActionFall and ActionLand through its idle tree (0_master's JumpFall only falling faster
than 350 units a second, its landings only in its jump state: [ai.md](ai.md#combat-movement)),
not a JumpFall for every step without ground; its turning is the engine's angle controller (the
same section), so TurnDelta rises and falls smoothly instead of dropping to 0 between steps.

What this fixed (gliding): turning in place had no turnLeft / turnRight / turnStop at all, so
standing actors and horses rotated stiffly on their idles (measured: a Whiterun guard now plays
MT_TurnRight60, a horse TurnLoopingL; the drawn weapon's, the shield's and the bow's idle turn
states take the same events); the speed was
measured from step to step, so a horse tugged by its cart, or anything pushed, fed the graph's
speed sampler a jittering speed (its walk and trot blend stumbled) and its sync variables were
written every frame over the graphs'; actors beyond the high process went their way while their
graph held them in an idle; a graph out of an animation-driven idle stayed standing while the
actor walked (no new moveStart came).

**When the channels are read** (observed in the original). The engine reads its graph data
channels into a graph right before each update of that graph, comparing each value with what it
read at the update before: an action is performed as a value crosses its threshold between two
updates of the graph. The thresholds have no hysteresis: TurnDelta's 1° a second either way
(ActionTurnLeft or Right from below, ActionTurnStop from above), Speed's 5 (its ActionMoveStop is
withheld while a flag of the actor's process is set, as all its channels hold while another
is). Ours: `BehaviorRuntime.channels` is read at the start of every update; `Locomotion.latch`
hands it the actor's latest movement (the movers', the walkers', an NPC rider's) and
`Locomotion.release` takes it back (a mover freed, a walker gone, a rider off its horse). The
player's two graphs update every frame and are driven at once. A walker does nothing on a frame
without a physics step (no time stepped to move in): before, its speed fell to 0 on such frames.

What this fixed (the "animation that hangs in one step, repeated fast"): a far actor's graph,
updated five times a second, got every frame's moveStop and moveStart queued (a walker's speed
fell to 0 between physics steps); in one update it left its locomotion and came back several
times, each time its transitions dropping the blend under way (below, "Transitions"). Measured
over 90 s outside Whiterun: a chicken 7.9 state changes a second (265 locomotion-to-standing
flips and back), a cow 3.1, a Whiterun guard 3.7; in Riverwood a mudcrab 1.1.

**Ahead, not sideways.** Direction is the movement against the facing, wrapped into 0..1 (observed
in the original: the engine wraps the angle into a turn and divides; a movement a hair left of ahead is
0.99, a hair right 0.01, and the forward / backward and right / left actions are performed as it
crosses their halves). An NPC that does not strafe moves ahead, the way it faces, while it turns
towards the way it goes (`steer`): its Direction is 0. Before, it moved along the way while its
facing still turned, so walkers turning onto a path swayed into their walk-left and walk-right
blends.

**The speed sampled.** The graphs do not blend their locomotion by Speed itself: their
BSSpeedSamplerModifier (observed in the original) looks Speed up in the project's speed
data (`meshes\speeddatasinglefile.txt`: per locomotion state and direction, the speed each blend
parameter moves the character at) and gives the blend parameter that moves it at that speed
(HorseSpeedSampled, SpeedSampled); without a table, Speed itself. A cart horse walking at 125
gets 125.8, its walk (125.11) with 0.8 % of its slow trot, as in the engine; slower or faster,
the parameter differs more from the speed (a horse at 60 units a second gets 119.7: its walk
played slower, not a blend with standing). Before, Speed went through as it was.

The lookup itself (observed in the original: the speed sampler database's lookup, behind
the modifier and the [Animation] bUseSpeedSampler switch): the state's table by iState (none:
Speed itself); of its curves **one**, the one for exactly that direction, else the next higher,
and past the last (a direction a hair left of ahead, 0.99) the first: the curves are not
blended. In that curve the first point at least as fast as the goal, and the parameter linear
between it and the point before (before the first, a point at speed 0 with parameter 0).
**Faster than the curve's last point, the goal speed itself.** The horse's curves end at 321
units a second (parameter 324.5); its run blend's child sits at 450, its gallop's speed. Held
at the last parameter (ours before), a galloping horse played its trot with a seventh of its
run at 450 units a second; now it gets 450 and gallops. The same holds for every table: a
character running at 370 against state 0's curve that ends at 306.

**The state comes from the character's properties.** Nine quadruped projects (bear, dog, wolf and
fox, cow, deer and elk, goat, horker, mammoth, sabre cat) share the canine folder's quadruped
behavior, whose root modifier list holds one list per creature (BearModifierList,
CanineModifierList, ..., SkeeverModifierList), each enabled by a character property (IsBear,
IsCanine, ... read by the binding's property index) and each setting iState to its creature's
(iState_WolfDefault 100, iState_SabreCatDefault 80, ...). The property values are the
character's (hkbCharacterData.characterPropertyValues, by the character string data's
characterPropertyNames; `readCharacterPropertyValues`, given to every actor's graph before the
actor's own IsFemale, IsNPC, ...). Without them every list ran (the binding's stored 1) and the
skeever's, the last, set every one's iState to 90, which no table but the skeever's has: the
blend took the Speed itself, and a wolf walking 80 units a second played a walk whose stride
went at half that (QA `foot-slide` in Riverwood: 24 for three wolves). `node
tools/locomotion-audit.ts --without` runs every race's project told it walks: 47 walk in a state
their speed data has, 1 does not (the Falmer's 0 against its tables 1 and 2; its own data), and
these 9 changed from 90 to their own.

### Horses

The horse's graph (`meshes\actors\horse\behaviors\horsebehavior.hkx`) is driven as every
actor's is, by its movement (Speed, Direction, TurnDelta, IsSprinting), whether it walks free,
tows a cart or carries a rider. HorseSpeedSampled is the output of the graph's own
BSSpeedSamplerModifier (in its root modifier list, bound to iState, Direction, Speed), which a
rider's graph copies (above); in the engine the name appears only in its table of graph
variable names (observed in the original), no other writer of it was found. Its locomotion:

- **LocomotionState** plays ForwardLocomotionBlend_Horse, a syncing parametric blend on
  HorseSpeedSampled of five syncing turn blends: WalkForwardSlow (5: the walk at 0.04 of its
  speed), WalkForward (125.11), TrotForwardSlow (214: the trot at 0.704), TrotForward (303.9)
  and RunForward (450), each left, straight and right on TurnDeltaDamped (135, 0, −135; the
  walk's three are the same clip, the trot's and run's have clips of their own). TurnDeltaDamped
  is TurnDelta through a PID damping modifier (0.2, 0.015, −0.1). The speed sampler gives a
  walking horse (125) 125.8: 0.8 % of the slow trot in its walk, in step with it (above,
  Syncing blenders); 214 trots slowly, 302 trots, 450 gallops (it is past the speed table's last
  point, 321: the goal itself).
- **SprintState** (IsSprinting, SprintStart / SprintStop) plays SprintForward, tagged
  iState_HorseSprint (61: its movement type's sprint speeds).
- **Standing:** looping turns on TurnDelta (TurnLoopingL / R at turnSpeedMult, |TurnDelta| /
  112.5, by an expression), the idles; the canned turns (TurnCanned L / R, 90 and 180) are
  animation-driven.
- **Saddle_offset** (SaddleOffsetBlend) is an additive clip on the SaddleBone alone (4.2 units
  forward, 0.8 up; its other tracks hold nothing), blended beside the whole body by the
  SaddleBone's weight: it moves no body bone and gives no root motion. TODO(M13): Havok's
  normalisation of an additive child in a non-parametric blender (ours halves it with the body's
  weight of 1: the saddle sits 2.1 units back).

Measured with the QA monitors (docs/qa.md; main before and after, the same scenarios): in the
opening the cart horses' trot restarts and their walk at 900 to 1,300 units a second of root
motion are gone (0 horse anomalies; the carts' velocity spikes and jitter at the Alduin attack
went from 15 to 0 in that run), in `creatures` the animals' turn chatter went from 12 to 0,
their state chatter from 4 to 0, in `creature-combat` the turn chatter from 13 to 2, in
`combat` (people: the same syncing blenders and turn rates) clip restarts from 7 to 0, state
chatter from 11 to 1, turn chatter from 39 to 5. What made the horses walk wrong, besides the
syncing blenders: the player's horse steered round its own
rider (docs/ai.md, "Paths": the avoidance), TurnDelta read from one physics step of a frame of
several (docs/ai.md, "Movement"), IsSprinting from the speed physics made of a sprint (a horse
galloping into a fence flipped in and out of SprintState), and the speed sampler held at its
last parameter past the table (a gallop played as a trot).

**The rocking horses** (the opening's cart horses and the riders' horses "like rocking horses"):
not their clips, which walked at the cart's speed in step with it (Speed 125, HorseSpeedSampled
125.8, WalkForward), but their lean: the whole body was stood at the normal of the one ground
triangle under its middle every 4 units, jumping up to 70° in a frame and swinging back and forth
about once a second. They lean now as the engine's quadruped orientation controller leans them,
by the ground under their two ends, eased by fQuadrupedPitchMult
([physics.md](physics.md#actors-on-the-ground), with the numbers); the QA monitor `rocking`
watches for it (docs/qa.md).

Measured with the QA monitors (b9f6248 with the new monitors against this work, the same
scenarios, full length): `rocking` in the opening 67 (62 of them its four horses) to 7 (4), in
`creatures` 34 to 9, in `combat-melee` and `riverwood` 1 to 0 each; `foot-slide` in `riverwood`
26 to 0, `combat-melee` 21 to 0, `creatures` 14 to 1, the opening 10 to 0, `whiterun-day` 1 to 0.
The rest of the opening's player anomalies came from the QA follow bot (it set the view's yaw at
once ten times a second; now it turns it as a player does, past 5° at a steady rate, then holds it) and from the third-person
body in MT WalkingCamera (above, "The player").

TODO(M13): the actions are not resolved through the idle tree yet (the vanilla events are sent:
a rider's graph gets moveStart, and SprintStart is not refused while sneaking or blocking); the
movement controller's acceleration (it ramps the speed by the race's acceleration and deceleration
rates, RACE DATA: a factor 1 / rate, the scale it applies to not known) is not reproduced; what sets the process flags that hold the channels and withhold
ActionMoveStop.

## Graph events

What an actor's behavior graph raises reaches the engine as an event with a tag and a payload
(`src/animation/graph-events.ts`). The payload is the event's own string payload
(hkbStringEventPayload: AnimObjLoad's animation object, StartAnimatedCamera's camera node,
PairedKillTarget), else the text after the first dot of a name that has one: a clip annotation
such as `SoundPlay.NPCGiantAttackStomp`, `CameraShake.0.5` or
`AnimObjLoad.DecapitationHeadGore` (the graphs declare the whole text as an event, which the
graph itself handles by that name; 661 such names in the vanilla graphs). Scripts register for
the whole text (`RegisterForAnimationEvent(…, "SoundPlay.NPCGiantAttackStomp")` in a vanilla
script), so OnAnimationEvent gets it whole. Events sent to a graph may carry a payload too
(`sendEvent(name, payload)`); the graph's own handling does not read it.

**The dispatch.** The engine answers a raised event by a handler class:
`meshes\responses\actorresponse.txt` maps tags to them for every actor (weaponSwing :
WeaponRightSwingHandler; AttackWinStart and AttackWinStartLeft : AttackWinStartHandler),
`playercharacterresponse.txt` for the player (idleChairSitting : PlayerChairEnterHandler, the
actors' list behind it through BackupResponse). Ours: every placed actor's graph, the player's
body and first-person arms hand what they raise to the stage's dispatch
(`src/shell/actor-graph-events.ts`). Its listeners hear every event (footsteps and SoundPlay,
the scripts, the systems that follow events by name: flight states, get-ups, a ride's paired end,
a cart rider's exit, a held weapon's own graph, the casting art, the animation objects' unload
events); then each event goes, in the order raised, to its handler class's implementations, or,
without one, to the actor's own answers (the combat state's WeapEquip_Out, blockStop, bowEnd).
The handler classes are registered in that one module; a class asked for that nothing
implements is listed (`dispatch.unanswered()`); classes a system answers from its listener by the events' names (the flight states, the get-ups, a cart's exit, the player's jump) are declared so (`heardBy`). Of the 93 classes the files name, 91 are answered and 2 do not exist in the executable (tests/conformance/animation/engine-handlers.test.ts). Observed in the original, the last ones answered: BeginCastLeft / BeginCastRight (LeftHandSpellCastHandler, RightHandSpellCastHandler) begin a hand's waiting cast, its charge: ours begins at the action, its charge counted again from the graph's BeginCast, once (`CastingEngine.graphBegan`); JumpBegin (JumpAnimEventHandler) jumps the character controller fJumpHeightMin high (the player's push-off: its JumpUp only if a graph raises no JumpBegin; TODO(M13): the actor's jump height mult, fJumpSwimmingMult in water; NPCs' controllers do not jump); BowZoomStart / BowZoomStop (the player's list) start and stop the bow's zoom (Mod Bow Zoom: once the graph has raised either, the zoom follows them, the block input alone before; TODO(M13): the controls flag the start clears); CameraOverrideStart / Stop set and clear a flag of the third-person camera, MTState one of the actor's middle-high process (both kept, TODO(M13): what reads them is unread); FlightLandEnd frees the landing (the next flier may land), FlightActionEnd ends a grab its release did not, FlightCrashLandStart brings the flier down where its target was (`src/shell/actor-flight.ts`). Events that
come before the response files are read wait for them.

**The handlers** (observed in the original, in our words; ours after each):

| Handler (events)                                                  | The engine                                                                                                                                                                    | Ours                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AnimationDriven, MotionDriven, AllowRotation (Start…)             | switch the actor's movement controller at once: animation-driven, controller-driven, animation-driven with the controller turning it                                          | the movers' drive (`src/ai/movement-drive.ts`); bAnimationDriven and bAllowRotation switch it back every update (observed in the original); allowed to rotate, the steering turns an actor its root motion moves                                          |
| AddRagdoll (AddRagdollToWorld)                                    | adds the actor's ragdoll to the physics world, with its collision group                                                                                                       | a dying actor's ragdoll is driven by its graph ([Animation] bDriveRagdollWithGraph, 1): its bodies follow the pose while the graph keyframes or powers them (AnimateToRagdoll), and go limp as it stops (FullyRagdoll); undriven, limp at once |
| RemoveRagdoll (RemoveRagdollFromWorld)                            | removes it                                                                                                                                                                    | a dying body follows its graph again                                                                                                                                                                                                           |
| DeathStop (deathStop)                                             | ends the actor's dying (dead)                                                                                                                                                 | its body goes limp from where it is                                                                                                                                                                                                            |
| DeathEmote (DeathEmote)                                           | queues the actor's Death line (the combat dialogue's Death subtype), once a death                                                                                             | a death whose graph has DeathEmote says its Death line then (else at once; at most 2 s after)                                                                                                                                                  |
| VoiceSpellCast (BeginCastVoice)                                   | the voice's cast begins charging                                                                                                                                              | an NPC holds its shout's words (fShoutTime1 / 2) from then (a graph without it: after 1 s)                                                                                                                                                     |
| VoiceSpellFire (Voice_SpellFire_Event)                            | releases the voice's cast (the shout's spell), its recovery set by the variation's time × ShoutRecoveryMult                                                                   | the released shout's spell leaves the head then (a breath starts spraying); without the event, 1 s after the release                                                                                                                           |
| Left/RightHandSpellFire, InterruptCast                            | a hand's released spell; the actor's casting interrupted                                                                                                                      | as the engine (InterruptCast: every hand and the voice)                                                                                                                                                                                        |
| WeaponRight/LeftSwing (weaponSwing, weaponLeftSwing)              | the attack state becomes swinging; that hand's weapon's swing sound; the swing callback                                                                                       | as the engine (the left weapon's sound for the left hand)                                                                                                                                                                                      |
| AttackWinStart/End (also …Left)                                   | the next attack's window (a bow's next shot), the follow-through                                                                                                              | as the engine                                                                                                                                                                                                                                  |
| WeaponBeginDrawRight, WeaponBeginSheatheRight (BeginWeaponDraw/…) | the right weapon's equip / unequip sound; a draw turns the camera to its combat position when it follows the actor                                                            | the sounds; graphs whose draw raises neither (an NPC's WeapEquip) sound them at weaponDraw / weaponSheathe (inferred). TODO(M13): the camera's combat position                                                                                 |
| KillMoveStart, KillMoveEnd (also a victim's 2_KillMoveEnd)        | Start nothing; End: the actor is in its killmove no more (IsInKillMove), one done to it (its myKiller set) dies by its killer, its deferred death comes                       | as the engine ([Killmoves](#killmoves))                                                                                                                                                                                                        |
| IdleDialogueEnter/Exit (IdleDialogueLock/Unlock)                  | the lock does nothing itself; the unlock plays the dialogue idle the actor's process holds                                                                                    | dialogue idles (a line's speaker and listener idles, ActionTalking's) are held while locked, the last played at the unlock                                                                                                                     |
| Enable/DisableCharacterPitch, Enable/DisableCharacterBumper       | the character controller may pitch the actor (disabled: its pitch zeroed); its bumper on or off                                                                               | recorded per actor. TODO(M13): our controllers keep actors upright and have no bumper                                                                                                                                                          |
| ChairEnter, BedEnter, PlayerChair/BedEnter (idleChairSitting, …)  | unless it gets up already, the sit state becomes sitting (sleeping); the player's also switch the camera and controls                                                         | an entering furniture use is in (at its marker, OnSit). TODO(M13): the player's camera and controls                                                                                                                                            |
| MountDismountEnd (MountEnd, DismountEnd)                          | ends the mount or dismount under way for rider and horse                                                                                                                      | the ride's phase ends (as at its paired end)                                                                                                                                                                                                   |
| EndSummonAnimation (summonStop)                                   | a summoned actor's arrival is over: it takes its commander's combat target                                                                                                    | as the engine                                                                                                                                                                                                                                  |
| ActionActivateDone (ActivationDone)                               | the object the actor's process holds is activated, the procedure done                                                                                                         | an NPC's activation with an ActionActivate idle waits for it (3 s at most)                                                                                                                                                                     |
| VampireFeedEnd                                                    | a vampire feeding procedure is done                                                                                                                                           | TODO(M11): our AI runs no feeding procedure                                                                                                                                                                                                    |
| NPCAttach / NPCDetach                                             | attach the actor to its furniture's node the payload names, or detach it                                                                                                      | recorded. TODO(M13): our furniture keeps markers, not animated nodes                                                                                                                                                                           |
| CameraShake (payload: strength)                                   | shakes the camera from the actor's place (src/shell/camera-shake.ts)                                                                                                          | as the engine                                                                                                                                                                                                                                  |
| AnimatedCameraStart / DeltaStart / End (player)                   | the camera goes over (iAnimatedTransitionMillis) to ride the node the payload names in the player's body, or the third-person camera adds its motion; the end returns         | as the engine in third person. TODO(M13): the node's view axis (+y inferred)                                                                                                                                                                   |
| PitchOverrideStart/End, ZeroPitch (player)                        | a flag on the third-person camera; the camera's pitch to level                                                                                                                | the flag is kept (TODO(M13): what reads it); the pitch set to 0                                                                                                                                                                                |
| AnimationObjectLoad / Draw (AnimObjLoad, AnimObjDraw)             | load / show the animation object the payload names                                                                                                                            | the animation objects ([above](#animation-objects))                                                                                                                                                                                            |
| Decapitate (Decapitate; a killmove victim's 2_Decapitate)         | the actor wears its race's decapitation armor, its head is recorded gone, the cut is queued: the head copied into a piece of its own that flies off ([below](#dismemberment)) | as the engine                                                                                                                                                                                                                                  |
| PickNewIdle                                                       | the process wants a new idle                                                                                                                                                  | as the engine ([Ambient idles](#ambient-idles))                                                                                                                                                                                                |
| StopHorseCamera, RemoveCharacterController                        | named in the files, but the executable has no handler class of that name (only the name)                                                                                      | nothing                                                                                                                                                                                                                                        |

**A death** (`ActorGraphEvents.died`): the engine plays it through the idle tree: ActionDeath
(creatures: DeathAnimation, a bleeding-out or paired one Ragdoll), else ActionDeathWait (humans:
DeathAnimationRoot's MS12BedDeath, then Ragdoll if the killer holds a bow, a staff or magic, the
victim is paired, in furniture, bleeding out, swimming, or half the time, else DeathAnim). The
idles' conditions on their target see the killer (inferred, TODO(M13)). A Ragdoll idle, or none,
lets the ragdoll go at once; an animated death keeps the body on its graph (still animating
while dead) until the graph adds the ragdoll; one whose graph did not take the idle (its states
unchanged 0.3 s on) goes limp, and so does one whose graph never adds it, or keeps it keyframed
or powered, 8 s after it began (TODO(M13): what the engine does with such a graph; before, a
graph that kept its ragdoll keyframed held the corpse on its feet for good). A killmove's
victim dies in its paired clip. Seen in the browser (Riverwood): a villager's DeathAnim,
AddRagdollToWorld 0.06 s in, AnimateToRagdoll with 18 bones keyframed, limp as FullyRagdoll
began at 1.2 s; a cow and a dog took DeathAnimation and lay as ragdolls within 0.7 s (the dog's
DeathAnimation goes to Fully Ragdoll at once: it drops from the pose it stood in).

The graphs' ragdoll contact listeners (BSRagdollContactListenerModifier: AnimateToRagdoll's
death waits for a body to touch something) see the actor's bodies while they are still
keyframed: Havok reports a keyframed body's contacts with fixed ones, Rapier only when asked
(`PhysicsWorld.findFixedContacts`, set on an actor's bodies as its graph first asks: computed for every living actor they cost). Where the ragdoll goes from
there (the dead bodies' layer, the placed ragdoll pose, the limbs through the ground, the death
push, how it comes to rest): [physics.md](physics.md), "The dead".

**The camera's shake** (`src/shell/camera-shake.ts`, also `Game.ShakeCamera`: its strength
kept within 0 and 1, from its source's place or the player's): within fCameraShakeDistFadeStart ×
strength of the camera (at least fCameraShakeDistMin) the strength is kept, beyond it fades over
fCameraShakeDistFadeDelta × strength, past that no shake starts; then kept within
fCameraShakeMultMin and 1, for the time asked (else fCameraShakeTime, 1.25 s), fading over the
last fCameraShakeFadeTime. Each frame the view turns by the rotation
`meshes\actors\character\camerashake.nif`'s animation has then against its first key (Euler
angles about x, y, z: pitch, roll, yaw), times the strength. A new shake replaces the one under
way. An explosion shakes it from where it bursts (observed in the original): its radius
times fCameraShakeExplosionDistMult (0.001), for fCameraShakeTime, faded by its distance as
above; only one with a sound does (the engine starts it with the explosion's sounds): a spell's,
a destruction stage's.

Verified in the browser: an NPC's shout (Unrelenting Force) launched its projectile at its
graph's Voice_SpellFire_Event (1.2 s after shoutStart, MT_BreathExhaleShort's exhale); a
dual-wielding NPC's left attack raised weaponLeftSwing (WeaponLeftSwingHandler: swinging), then
AttackWinStartLeft and AttackWinEndLeft; Game.ShakeCamera(None, 0.5) turned the view by up to
0.6° for 1 s.

## Killmoves

A killmove is a paired idle: the attacker's power attack (or a sneak's) whose idle event begins
"pa_Kill", played by two actors on one synchronized clip (`src/shell/actor-combat.ts`, Killmoves;
the clips: `src/animation/paired-clips.ts`; the kill camera: `src/shell/killmove-camera.ts`).
When one is tried and which: [gameplay.md](gameplay.md#killmoves). Observed in the original;
in our words. Check: `node tools/idle-info.ts --tree ActionRightPowerAttack 0_master` (the tree
with each condition's run-on), `node tools/idle-info.ts --cameras` (the kill cameras),
`tests/killmoves.int.test.ts`.

**The pairing.** A paired idle's event names the leader's side ("pa_KillMoveB"); its partner's is
the rest ("KillMoveB"). The engine plays the partner's side first: the target's graph must take
its event (a transition from the state it is in: `BehaviorRuntime.wouldHandle`), and only then
is the leader's sent. Where the target cannot (a victim with its weapon sheathed: the people's
killmove victim states hang under the drawn-weapon behaviors), the player's attack is asked
again without its target: a plain power attack. Once paired, for a "pa_Kill" event:

- the leader's attack state is drawing; both actors are in a killmove (IsInKillMove) until
  their KillMoveEnd, at most fKillMoveMaxDuration (10 s: the timer clears only IsInKillMove);
- the victim's killer (myKiller) is the leader;
- both have their deaths deferred (StartDeferredKill: a blow that empties their health kills
  them as the deferral ends; its own timer fBetaDeferredKillTimer, 15 s);
- a killmove on the player turns the camera to third person; one the player leads plays in the
  kill camera (below).

The vampire's feeding bite (IdleVampireFeed) and the other "pa_" idles pair the same way without
being killmoves.

**The synchronized clip** (BSSynchronizedClipGenerator, its members after the clip: SyncAnimPrefix,
bSyncClipIgnoreMarkPlacement, fGetToMarkTime, fMarkErrorThreshold, bLeadCharacter,
bReorientSupportChar, bApplyMotionFromRoot). The people's graphs hold 226: 63 leader sides (60
prefix their partner "2_"), the rest partners' (153 killmove victims'); every partner gets to
its mark at once (fGetToMarkTime 0; the vampire lord's three 0.05 s), turned to it. The mark is in the clip: the partner's placement is the track
named the prefix alone ("2_"), the leader's the track "NPC" (both from the pair's root, which is
the leader's place as the clip begins); the partner's bones are its "2_"-prefixed tracks, moving
from there. Paired_1HMKillMoveB puts the victim 72.8 units ahead, turned about; a bear's clip
157, a wolf's 116.6. Ours: the partner is moved to its mark as its clip begins (`partnerMark`),
over fGetToMarkTime; not there within [Animation] fMaxTimeToMarkSec (3 s) the scene plays where
they stand. While paired, both actors are held (no character controller, no locomotion events:
a teleported victim would otherwise fall and turn its graph out of the clip; the player's keys
do not move them). The pair lasts as long as its clips: a graph that leaves its synchronized clip
is in its pair no more, whether or not it raised PairEnd (a bear killmove's leader raises none).

**The end.** The victim's side raises its events with the prefix: 2_KillActor (KillActorHandler:
it dies by its killer), 2_KillMoveEnd (KillMoveEndHandler: an actor with a killer dies by it, its
deferred death comes, it is in its killmove no more), 2_PairEnd; some clips raise all three on
their last frame with 2_PairEnd first (Paired_1HMKillMoveD, Paired_2HMKillMoveSlash at 0.4 s: the
slash is the kill). The leader's KillMoveEnd ends its own killmove. A graph keeps its side of the
pair while it still plays the synchronized clip (a last frame's 2_PairEnd comes as the clip
blends out: let go at once, the victim's skeleton took its killer's tracks for those frames and
stood in its killer's place). A victim that dies in its clip (its 2_KillActor, or killed by a
blow while paired, also after a last frame's 2_PairEnd) plays no death of its own: its body goes
limp from the clip's last pose as the clip ends (`ActorGraphEvents` died: paired), instead of
standing up again in its graph's own states until the death's eight-second wait let it fall.

`node tools/paired-audit.ts` lists the vanilla synchronized clips (516: 208 leader sides, 308
partner sides; 8 apply their motion from the root, the mounts and the dragon's): their placement
tracks ("NPC", "2_") never move during a clip and the projects' animation data give them no
root motion, so the mark taken as a clip begins keeps the two in place for the whole of it (observed
in the original: BGSSynchronizedAnimationInstance sets each partner's mark once, as
every member has activated, from the lead's world placement and the two placement tracks; the
partner's get-to-mark progress runs over fGetToMarkTime and the clip waits for none of them).
The QA monitor `pair-misaligned` (docs/qa.md) measures a partner's drawn placement against the
mark its leader's drawn placement and the clip give, through every paired clip of a run. A blow on an actor in a
killmove does fCombatKillMoveDamageMult (10) times its damage; the killmove clips' own hit
frames are NPCHitFrame, which no handler answers: the victim takes no blows from its clip.

**The kill camera** (the engine's VATS playback). A killmove the player leads always starts it,
in either view (the player's melee action with a paired target event); the camera path is
chosen from the kill cameras' tree (CPTH), its roots in order (each names the one before it:
PlayerDeath, DoVatsAtAll, ExitWeRanOutOfCams, ...), searched depth first: a path whose
conditions hold (run on the attacker, the victim their target) is tried below first and is the
answer itself if none below is and it has shots (DATA bit 7 clear: "must have camera shots");
a path whose shots are optional but has shots gives none, as does one with a shot that lasts no
time. Under PairedKillTest the dragons' paths come first, then 1stPRandom (33% in first
person), IsBackClear02 (16%), the close and slow cameras, 1stPFailsafeCam, FailSafeCamera. A
first-person shot (no model) leaves the player's own view. Each shot plays its Max Time (real
seconds) from its camera model's ExportCam node in its location's frame, looking at its target;
the world's clock runs at the shot's global time multiplier (the slow motion: the slow shots'
0.2 and 0.4), and its image-space modifier (VATSImodDOF) is cross-faded in over
fVATSImageSpaceTransitionTime (0.15 s), faded out as the camera ends. The VATS side functions
measure from the reference they run on: GetVATS*AreaFree how far a ray at
fVATSSmartCameraCheckHeight (96) toward that side of its facing runs before it meets anything
but the reference itself (10000 units if nothing); GetVATS*TargetVisible from points
fVATSSmartCameraCheckStepDistance (128) apart toward that side (fVATSSmartCameraCheckStepCount,
5), whether a ray to the other of the kill gets there (blocked by anything within 85% of the way,
another actor only within 256 units). Between shots (observed in the original): where the
next shot's camera sits more than fVATSCameraDollyMin (256) from where the last ended, the
camera dollies there in a straight line over fVATSCameraDollyTime (1 s) instead of cutting,
under a radial blur of fVATSCamTransRBStrengthCap (0.5) × a triangle of the move's progress
(`transitionBlur`). TODO(M13): the engine cuts some shots and dollies others over the shot's own
time by a start mode not yet tied to a CAMS field (ours dollies every shot after the first); the
blur's strength is computed but the image-space stack takes no free radial blur yet; which
distance TargetVisible returns (inferred: the last clear step's); the magic kill camera ([gameplay.md](gameplay.md#killmoves)). The ranged kill camera
plays the same tree on the player's bow and crossbow shots (its rules: gameplay.md).

Verified in the browser (Riverwood, spawned bandits, wolves and bears at low health, the player's
and guards' power attacks): third person with a sword 11 of 11 killmoves played to the victim's
death (KillMove1HMGrappleStab, StabUpFace, StabDownChest, RepeatStabDown, BackStab, ShortD, D,
I), first person 3 of 5 (the other two: victims turned away whose graph could not take the
back-stab: a plain power attack), a dagger 3 of 4, a battle-axe 2 of 3 (2HWHeadButt, 2HWB), a
greatsword 1 of 4 (2HMSlash: the kill at 0.4 s), wolves 6 of 6 (1HMWolfA/B), bears 2 of 2 (BearA,
1HMBearB); the victims stood 78 units before the attacker (StabDownChest's mark), died 0.2 s
after their pair ended, killed by the attacker; kill cameras chosen: S08BackLeftStart01,
PlayerFaceBack L/R, KillCamSlow*CloseUp/FarA, FailSafeCamera, the world's clock at 0.2 in the
slow shots. Two guards against three bandits (each started on the other): two of the three
deaths were killmoves (pa_KillMove1HMBackStab, pa_KillMoveI). A bandit's killmove on the player
(pa_KillMoveShortA) turned the first-person view to third person and killed the player at its
2_KillActor.

## Dismemberment

How a head comes off (`src/shell/actor-dismemberment.ts`; the rules:
`src/gameplay/combat/dismemberment.ts`; the data: `src/world/body-part-data.ts`, RACE DNAM and
NAM7 in `src/world/actor-records.ts`). Observed in the original; in our words.

**The data.** A race's body part data (BPTD, RACE GNAM) lists its parts, at most one of each
part type (torso, head, eye, look-at, fly grab, saddle): BPNN the skeleton node, BPNT the node
a severed part is cut at, BPNI the hit reaction's variable prefix, NAM1 the model that flies off,
NAM4 the node the gore follows, and BPND: damage multiplier, flags (severable, IK, explodable,
head, head tracking, absolute to-hit chance), type, health share, actor value, to-hit and
explosion chances, then for exploding and for severing each a debris (DEBR) with its count and
scale, an explosion (EXPL), an impact data set (IPDS) and its decal count, the gore's offset and
the replacement model's scale. `node tools/bodypart-info.ts --gore` lists the severable and
explodable parts: in the vanilla data there are none. The human head part carries an impact
data set with four decals and no flags. What decapitates is not the body part data but the
race: RACE DNAM names a decapitation armor per sex (every playable race: `DecapitatedHead`;
creatures none) and NAM7 its blood art (`BloodSprayDecap01`). The armor's addons are worn like
any armor: `DecapitatedNeckAA` (slot 51) a neck stump in partition 51, `DecapitatedHeadAA`
(slot 50) the cut under the head in partition 150, both skinned to `NPC Head [Head]`
(Argonian and Khajiit variants).

**Partitions.** A BSDismemberSkinInstance names a body part per partition: the biped slots
30-61 (what the body keeps), the 100s (130 head, 131 hair, 141 long hair, 143 ears, 150 the
decapitation cut: what goes with the cut piece) and the 200s (230: the neck under a head). The
FaceGen heads are 230 (neck), 130 and 143; helmets and hair put their shapes in the 100s.

**Who decapitates.** One path only: the graph event `Decapitate` (actorresponse.txt:
DecapitateHandler). In the executable nothing else marks a limb gone.

- The opening's execution: the executionee's `AOExecutioneeChop.hkx` clip in
  `mt_behavior.hkx` raises Decapitate 8.16 s before its end and KillActor 3.39 s before it.
- Killmoves: the attacker's paired clip raises `2_Decapitate` (and later `2_KillActor`) for its
  partner; the victim's graph plays the same clip, and the side done to answers the `2_` events
  as its own (combat-state: the victim decapitated, then killed). Seven clips do so in the
  one-handed, two-handed and dual-wield behaviors (1HM decap slash at 0.76 s before the kill at
  1.69 s, the bleed-out decaps, 2HM decap, 2HW A, dual-wield decap).
- The perks: the idle tree's decapitation killmoves (KillMoveDecapSlash, KillMove2HMDecapSlash,
  KillMoveDualWieldDecap, the bleed-out decaps, ...) need Savage Strike (one-handed) or
  Devastating Blow (two-handed), no NoDecapitate keyword, no ghost, and GetRandomPercent at most
  the global DecapitationChance; a bleeding-out victim's at 75% or always. Nothing else in
  combat cuts: a killing blow on a targeted body part rolls to explode it (absolute chance, or
  iCombatExplodePartChance × its explosion chance %) or else dismember it
  (iCombatDismemberPartChance), as the weapon's hit behavior allows (`rollLimb`), but only for
  parts flagged explodable (none vanilla), Skyrim's hits never target a part, and the hit's
  marks are acted on by nothing that cuts.

**The handler.** If the actor's head is not gone yet and its race has a decapitation armor for
its sex, the actor is given that armor to wear (AddWornItem: into its inventory and worn), the
head is recorded as gone with what the actor wears then (ExtraDismemberedLimbs; the change is
saved), and the actor is queued for the cut, which [GamePlay] iActorsDismemberedPerFrame (2)
actors get each frame. Ours: the armor goes on through the equip system; the look change it
causes is answered in place (`dressedInPlace`), so a dying body is not made again in the middle
of its death; it is asked for every look change until something else is worn or taken off
(putting the armor on may change what the actor wears in several steps, each told on its own;
answered for the first alone, a later one made the body again). And a body made again for a look change
(`ActorStage.lookChanged`) takes its old graph over where its race, sex and behavior project
are the same, as the game keeps an actor's animation going while what it wears changes: before,
a new graph started at its idle, and a prisoner made again during the chop at Helgen's block
stood up headless, then fell. The QA monitor `corpse-rises` catches a dead body's head coming
up again.

**The cut.** Unless [General] bDisableAllGore:

- The head's subtree (the head part's node and those under it: on a human `NPC Head [Head]`,
  `NPC Head MagicNode [Hmag]`, `NPCEyeBone`) is copied into a node of its own in the cell, at
  the head's place: the copy carries the ragdoll's head body, freed of its constraints, on the
  dead bodies' layer (L_DEADBIP), simulated. The body's own head node is hidden and its bodies
  leave collision.
- Every shape of the actor skinned to those nodes is copied to the piece (re-skinned to the
  copied nodes), except the FaceGen head node, which is moved there whole. On the body, the
  shapes skinned to the head keep only their partitions under 100 (the stump), the 100s and
  200s hidden; on the piece the copies show only 101-199 (the helmet's and hair's 130s, the cut
  150), whatever the equipment's slots say; the moved FaceGen head only loses its partitions
  under 100 and its 200s (its neck), keeping what it showed.
- Unless the actor's 3D was only loaded again, the head flies: along the line from the head's
  parent node (the neck) to the head, plus the direction the killer's weapon moves (its body's
  velocity; the killer the actor's myKiller), both as unit vectors, made one again, at
  [Combat] fDecapInitialSpeed (250 units a second), and spinning about that same axis at the
  same number in Havok units (3.6 radians a second).
- The race's blood art (NAM7) plays on the actor for fDecapitateBloodTime (5 s).

Ours: the body's instances read the cut nodes as its scene is built again (`Severing`: the
partition rule, the head parts left out); the decapitation armor's models are put on its
pose in place; the piece is the actor's instances skinned to the head on a still copy of the
pose, drawn where the head's body (the skeleton model's head body, alone) carries it; the
weapon's motion is read from the killer's weapon node between the blow and the cut (a frame
or more; the engine reads its weapon body's velocity), the killer being a killmove's leader
before the kill lands (inferred: the victim's myKiller is set by the kill). The ragdoll's
head bodies (a dying actor's, a corpse placed in its cell) stay out of collision. The piece
names no reference (the crosshair finds nothing on it).

**Persistence.** A dismembered corpse stays so: as its 3D is loaded again the engine compares
what it wears with what the limb's record says it wore and dresses it again if they differ,
then cuts again without the flight (the head drops from the neck, pushed away from the body's
root at fCombatDismemberedLimbVelocity) and bleeds again. Ours: the
game state keeps the limbs (`ActorState.dismembered`, saved with it in M12); an actor placed
again (its cell loaded again) is drawn without its head and a new piece drops from its neck; one
made again where it stands (a look change) keeps the piece that lies in the world. As its body
is made, one whose head is gone is dressed again as its last cut limb's record says if it wears
otherwise (`redressing`: what the record has and it does not wear is put on if it still has it,
the decapitation armor its outfit lost among them, not what was looted from it; what it wears
beyond the record is taken off; it is then made
again in that and cut again). TODO(M13): the engine's helper's exact rule (which limb's record
wins, whether it takes anything off) is not read. IsLimbGone (condition 397) asks the record.

| Setting                                       | Default | Use                                              |
| --------------------------------------------- | ------- | ------------------------------------------------ |
| [Combat] fDecapInitialSpeed                   | 250     | the head's launch speed (units a second)         |
| fDecapitateBloodTime                          | 5       | the neck's blood art (seconds)                   |
| [GamePlay] iActorsDismemberedPerFrame         | 2       | cuts a frame                                     |
| [General] bDisableAllGore                     | 0       | no cut (the armor still goes on)                 |
| iCombatDismemberPartChance, ExplodePartChance | 25, 5   | the fatal-hit roll (never reached)               |
| fCombatDismemberedLimbVelocity                | 10      | a head cut again on reload: pushed from the root |

Unused by the executable's Skyrim code paths: iDismemberBloodDecalCount, iMessIntactLimb*,
fExplodeLimbRemovalDelay (Fallout's).

Verified in the browser: the opening, unattended (a new game to MQ101 stage 90): the Stormcloak
prisoner (MQ101StormcloakCartMaleBroder) lost his head at his chop's Decapitate and died 4.7 s
later at its KillActor; the head dropped from the block into the basket before it and lay
there, the body lay headless beside it. A cart driver decapitated by the handler sprayed
BloodSprayDecap01 from the neck for 5 s. A bandit at Halted Stream Camp in a forced pa_KillMove1HMDecap (the
player leading): the victim's graph played KillMove1HMDecap, its head came off at 0.8 s
(2_Decapitate at 0.76 s), the body stood headless with the neck stump and fell headless once
dead; the head (face, hair, beard and the bloody cut) flew 560 units and rolled to rest. A
direct Decapitate on an Embershard Mine bandit: three head nodes cut, the FaceGen head moved,
ten shapes on the piece, the head on the floor asleep within seconds.

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
and from the race menu's camera; in first person its **first-person body** is drawn instead
(`src/shell/first-person-body.ts`): what it wears in its first-person slots, in their
first-person models (`ActorPlacer.wornModels` with `firstPerson`; the rule below), dressed on
the first-person skeleton as the body's are on its own (the
skeleton takes the models' nodes; dressed again as the look changes, the graph kept), and the
weapons' first-person models (WEAP WNAM, a STAT's model) in its hands (combat's HeldWeapons on
its pose: src/shell/actor-combat.ts). It stands on the feet facing the view, scaled by the
race's height, turned about its Camera1st node by the view's pitch, and is drawn unless
Game.ShowFirstPersonGeometry hid it (the beast forms, MQ101's cart: `runtime.
firstPersonGeometry`), from the free camera or dead. TODO(M13): the engine draws it in a pass
of its own (its own near plane and field of view over the world: here it shares the view's,
which shows the hands of the resting 1HM pose only looking down); the third-person body's
shadow, which the game casts in first person too. A menu that shows the player (the race menu)
animates the body on real time while the game stands still, and turns it itself.

**Both graphs hear the player's idles** (observed in the original): the player's graph
manager holds two graphs, the third-person body's and the first-person one, the one shown being
the manager's active graph; an event (an idle's, a script's SendAnimationEvent) goes to every
graph of the manager. So MQ101's walk to the chopping block (the package's CameraBobStart plays
IdleWalkingCameraStart on the player) takes the third-person graph too into Master_Behavior's MT
WalkingCamera, an additive camera bob without legs: in third person the body glides there (as
the engine's routing has it: inferred, the vanilla third-person view of that walk not seen;
the scene is made for first person, where the camera bobs as the player walks). Measured: the piloted player walks into its walk blends (MT_WalkForward, Speed 80) until
IdleWalkingCameraStart, then plays MT_WalkingCamera alone until IdleWalkingCameraEnd.

### First person

How the engine dresses the first-person body (observed in the original; implemented in
`src/world/actors.ts`: `addonModel`, `inFirstPerson`, `underSkin`):

- **Two bipeds, one dressing.** The player has a third-person and a first-person biped (the
  42 slots of what hangs where), both dressed the same way: the biped is cleared, the skin goes
  in first (the actor's own WNAM, else its race's), then what it wears over it. Every addon of
  an armor that fits the race (RNAM or a MODL race) is put in; per slot the usual owner rule
  decides (armor over skin, the higher DNAM priority).
- **The first-person slots.** The first-person biped takes and draws only the slots its race's
  BOD2 lists. Every vanilla playable race lists 32 body, 33 hands, 34 forearms, 36 ring, 39
  shield and 61 FX01; so boots, helmets, hair and tails never reach the first-person body. A
  piece shows when it owns one of those slots; its partitions of slots another piece owns are
  hidden there as on the body (a cuirass's bare forearms under gauntlets).
- **Which model.** In the first-person biped an addon takes the first-person model of the
  actor's sex (MOD4 male, MOD5 female); a woman with no MOD5 takes MOD4. With neither, it takes
  its world model (MOD2 / MOD3, the woman's falling back to the man's), skinned to the
  first-person skeleton, which has every bone the world models use. Most gauntlets (iron, steel,
  ebony, daedric...) and most shields have no first-person model and are seen in first person
  this way; that is why the iron gauntlets showed nothing before.
- **Skin texture sets.** An addon's skin shapes (skin tint shader) take the NAM0 / NAM1 skin
  texture set of the sex whose model it took. A piece with none of its own keeps the set the
  skin left in its slot, the skin being laid first: a cuirass's bare arms take the race's torso
  skin (a Khajiit's fur, an Orc's green), gauntlets the race's hands. This holds in the world
  too. Inferred, not seen: the slot is the piece's lowest one. TODO(M13): NAM2 / NAM3 (a list
  of skin texture sets picked by the actor's weight when it holds more than one; no vanilla
  list does) are not read.

The beast races need nothing of their own: their skin's hands (NakedHandsKhajiit,
NakedHandsArgonian: `1stperson…HandsArgonian_1.nif`, claws included) carry first-person models
and their own skin texture sets, and their gauntlets' beast addons (`…GauntletsLightBeast`)
do too.

Two graphs run: the race's (`defaultmale.hkx`) on the body and the first-person one
(`_1stperson\firstperson.hkx`) on the first-person skeleton (`_1stperson\skeleton.nif` with
`skeletonfirst.hkx`, 99 bones), whose **Camera1st [Cam1]** bone is the first-person camera:
120.5 units up at rest, 86.4 in SneakMTIdle (times the race's height). The player's movement
drives both, as the engine drives every actor's graph ([Driving the graphs](#driving-the-graphs)):
Speed (the controls' wish, the controller's horizontal velocity, game units per second),
Direction, TurnDelta, IsSprinting, IsSneaking; the movement actions (moveStart / moveStop at
5 units per second, turnLeft / turnRight / turnStop, moveForward / moveBackward) and their sync
variables (**iSyncIdleLocomotion** 1 moving, 0 standing: 38 state machines start from it; without
it, landing from a jump while running restarted `MT_Default_Behavior` standing, no new moveStart
coming while the player keeps moving), SprintStart / SprintStop, SneakStart / SneakStop,
SwimStart / SwimStop. The controls freeze a large change of direction (more than
fFreezeDirectionDefaultAngleThreshold, 60°, faster than fFreezeDirectionDefaultSpeedThreshold,
100 units a second; bFreezeDirectionOnLargeDelta, all [Controls]): CyclicFreeze before the new
Direction, CyclicCrossBlend after it. A jump sends
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
  its own random sequence (seeded by the reference). After a blink, eyes looking down by
  fLookDownDisableBlinkingAmt (0.25 of the LookDown morph) or more hold the next one back until
  they look up (the engine's blink, observed in the original; inferred: its comparison reads the other way
  round, which would let only downcast eyes blink).
- **Expression:** one of the 17 (MoodHappy, DialogueAnger, CombatShout, ...) held at a
  strength, chosen every frame (`src/ai/moods.ts`, `src/shell/actor-moods.ts`): a script's
  override (Actor.SetExpressionOverride: the mfg expression and its strength 0..100, until
  ClearExpressionOverride), else CombatShout while the actor shouts and CombatAnger in combat,
  else its AI's mood (the Mood actor value, AIDT: neutral, anger, fear, happy, sad, surprised,
  puzzled, disgusted) as its Mood* expression at half strength (TODO(M13): the engine's
  strengths; SetExpressionOverride's default 50 is taken). The player's face too. A response's
  emotion (INFO TRDT emotion type and value: anger, disgust, fear,
  sad, happy, surprise, puzzled as the Dialogue* expressions; neutral none) shows instead of it
  while it is said. The shown expression's morph moves towards its strength, the others towards
  none, by fExpressionChangePerSec (2) a second and fExpressionStrengthAdd (1) more times the
  strength (the engine's expression update, observed in the original; the strength is taken to be the
  target expression's).
- **Speech:** a line's lip-sync curves (formats/audio.md, LIP) drive the phonemes and the
  modifiers (blinks join the face's own, the strongest wins; brows, eye looks). The curves
  start with their lead-in frames, the audio after them, at the head through the 3D dialogue
  output model (DOBJ DOP2) in the dialogue category (DDSC). The lines' head pitch, roll and
  yaw turn the head bone over the graph's pose (BehaviorRuntime.headTurn; TODO(M13): the
  signs of FaceFX's head curves); creature lines
  (8 curves) set the creature's behavior graph's lip variables, which move its mouth
  (ai.md, Talking).
- **Sandbox (debug only), Talk:** in the sandbox, the crosshair finds an actor along the
  activation pick (its controller, BIPED bodies or ragdoll the pick meets; one without
  collision within fActivatePickRadius of the line from its feet to its head) and "Talk" makes it say a random line of its voice type (NPC VTCK,
  `sound\voice\<plugin>\<voice type>\`).
- Not applied: the TRI's SkinnyMorph (FaceGen heads are baked with the actor's weight:
  formats/esm.md, Actors) and the Races / CharGen morphs (baked by the Creation Kit).
- **Eyes:** they look where the graph's look-at turned the eye bone (Head tracking, below),
  by the look morphs (LookLeft/Right at 29°, LookUp/Down at 16°: measured on eyesmale.tri and
  eyesfemale.tri; the engine's BSFaceGenAnimationData eyesHeading and eyesPitch), wandering by
  a random offset in the range of the face's emotion (fEyeHeading/PitchMin/MaxOffsetEmotion*;
  a new one every 1–3 s, TODO(M13)); a line's own looks join them.

## Casting

The characters' magic graph (`magicbehavior.hkx` under 0_master; `src/shell/actor-casting.ts`
plays it, for the player's body and first-person graphs alike):

- The engine sets **iRightHandType / iLeftHandType** to 9 for a spell or a scroll in the hand
  (GetEquippedItemType's code; src/shell/actor-combat.ts): the casting states' manual
  selectors pick their clips by it (index 9: MRh_ChargeLoop, MRh_Release, ...; 8 a staff's);
  any other type plays NullClips (MT_Idle), and the arms do not move.
- A hand that casts sets **bWantCastRight / bWantCastLeft**: MagicRoot's
  BeginCast_OnFalseToTrueMod raises BeginCastRight / BeginCastLeft, MagicReadyState →
  CastingState. The engine sends BeginCast with the start (the idle tree's ActionRightAttack
  leaf: MRh_SpellAimedStart, MRh_SpellAimedConcentrationStart, MRh_SpellSelfStart, MRh_WardStart,
  ...) in the same update: the hand's state machine (MRh_ReadyCast_Behavior) takes the start
  only in CastingState, and CastingState entered without a cast ends at once (below). They are
  cleared as the cast is released, stopped or interrupted.
- **CastStop**: CastingState's event-on-false-to-true of NotCasting, which the cast states'
  InvertNotCasting (is-active, inverted) hold at 0; when no hand casts any more it goes back to
  MagicReadyState.
- Fire and forget (MRh_AimedFireAndForgetBehavior): MRh_PreCharge → (MRh_PreChargeOut)
  MRh_ChargeLoop → **MRh_SpellReady_Event** (ActionRightReady, as the charge time passes)
  MRh_ReadyLoop → **MRh_SpellRelease_Event** (ActionRightRelease) MRh_Release, whose trigger at
  0.17 s raises **MRh_SpellFire_Event**: the spell leaves the hand then (the engine's
  RightHandSpellFireHandler), and its end MRh_Equipped_Event takes the hand back to its ready
  state.
- Concentration (MRh_AimedConcentrationBehavior, MRh_SelfConcentrationBehavior): the charge
  loop until **MRh_SpellRelease_Event** (ActionRightRelease as it is charged), MRh_PreAimedCon,
  then the loop, whose state raises MRh_SpellFire_Event as it is entered: the sprays begin.
  Let go (or out of magicka): ActionRightInterrupt, **MRh_Equipped_Event**, the wildcard back
  to MRh_Ready_State. Released before it was ready: the same.
- Dual casting: both bWantCast set, the start's DualMagic_ event (MLh_ReadyCast_Behavior's
  wildcards → Dual_Cast), carried on by the left hand's MLh_SpellReady_Event,
  MLh_SpellRelease_Event and MLh_SpellFire_Event (DMagAimRelease raises it at 0.17 s).
- A cast whose graph raises no SpellFire event fires 0.5 s on (TODO(M13): the engine's way
  without it).

**The third-person pose** comes from layering, not from an aim: the magic graph's clips
(MRh_Idle drawn, MRh_PreCharge / MRh_ReadyLoop / MRh_Release and the concentration loops while
casting) play over the whole body, and the other hand's pose is laid over them by bone weights:
with nothing in the left hand, 0_master's H2H_MRh_Idle_BoneSwitch_3rdP takes 1HM_Idle for the
left arm only; with a spell in both, magicbehavior's DualMagicReady_BoneSwitchGen takes MLh_Idle
for the left arm. Those weights are not in the behavior files: the switch's
BSBoneSwitchGeneratorBoneData binds its spBoneWeight (a blender child its boneWeights) to a
character property, and the file holds a one-bone placeholder. The character file gives the
property its weights (hkbCharacterData.characterPropertyValues: a property of pointer type holds
the index of its hkbBoneWeightArray among the value set's variants; the humans' LeftArm,
RightArm, UpperBody, Hands, Arms, ...). `loadBehaviorFiles` reads them from the project's
character and the parser puts them where the files bind them (`readCharacterBoneWeights`).
Read as the placeholder (missing bones counting 1), the other hand's clip took the whole body:
with Flames or Firebolt drawn the casting hand hung at the hip, holding 1HM_Idle's absent
weapon, and every spell left from there. Measured on the player in Riverwood (NPC R MagicNode
over the feet; head bone 108 drawn, 94–103 casting): drawn 70 → 88 (30 units ahead of the
body, was 13 behind), Flames casting 69 → 89–97, Firebolt charged (MRh_ReadyLoop) 89 with the
hand by the shoulder; an NPC (Embry, given Flames) drawn 98, releasing 102 with the arm thrust
forward. 355 bound bone weights in 15 projects use them (humans in both persons, wolves and
dogs, rieklings, falmer, hagravens, trolls, the vampire lord, the werewolf, the dragon priest,
horses, the dwarven spider and ballista centurions); every one names a property its character defines
(`tests/casting-pose.int.test.ts`; `node tools/behavior-run.ts <project> --bone "R MagicNode"`
prints a bone's model-space position).

The graph's own aim while casting is BSDirectAtModifier_Magic on CastingState: it turns the
spine (Spine to Spine2, from Spine2) towards the engine's aim for spells (userInfo 2: the aimed
point, docs/ai.md "Magic in combat"), up to AimHeadingMax and AimPitchMax, enabled by IsNPC; its
outputs are bAimActive, AimHeadingCurrent and AimPitchCurrent (the graph writes them, the engine
does not). No modifier aims the arms; Pitch is a graph data channel that no human magic node
reads. The player's graph is no NPC's (IsNPC 0, observed in the original: [Weapons in
the hands](#weapons-in-the-hands)), so their spine does not turn to a spell's aim; the
mounted one's (magicmountedbehavior) does not either. TODO(M13): how the engine pitches the
player's body while casting (the graphs' PitchOverride events) is not reproduced.

**Casting art** (MGEF casting art: Fireball01HandEffects, ShockHandEffects, ...) carries its own
graph (BGED `Magic\CastingBasic.hkx`: mIntro → mIdle, mCharge on a start, mReady on
SpellReady, mCast on SpellRelease, back to mIdle on Equipped), which hears the events the
actor's graph is sent and raises (the engine's ActorMagicCaster is a sink of the actor's graph
events); its bRightHand / bLeftHand (conditions of every transition) pick the hand's events. It
sits on the hand's magic node (NPC R MagicNode [RMag], NPC L MagicNode [LMag]): the player's
while their magic is drawn with a spell or a scroll in the hand (their hands' idle flames), an
NPC's while it casts. In first person the player's hands are the first-person skeleton's magic
nodes (the arms the player sees): the art, the casting light, the sounds and the projectiles
leave from them; in third person the body's.

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
   with a blending effect (duration, curve) plays both states and blends them (the old one's
   nodes deactivate as the blend ends; nested, into the same state, its events and flags:
   [Transitions](#transitions)), an instant one switches, the old states' active nodes
   deactivated then, before the new state's enter events (their nested machines' exit events
   first: TODO(M13), Havok's order is not documented; this is the one the vanilla props need); a
   transition into a nested state sets that machine's start. A node stays active while any
   active parent still holds it, as in Havok, whose graph activates and deactivates nodes by
   whether anything active reaches them: the bow attack's blend lays its arms (BowZoomBlend)
   over its lower body, and the standing lower body holds the same arms again, so an instant
   step from standing to moving (moveStart) must not deactivate them; it did, and every step
   an archer took started its draw over (it never shot while strafing). A state entered while
   the machine still blends out of it (one an earlier transition blends from) starts over, its
   nested machines at their start states, without deactivating it (no exit events), as Havok
   plays a fresh copy of a node used twice (`#restart`; blending in, from the pose the machine
   had): the bow attack's Bow_End state has no way out but the attack's attackStop back to the
   ready state, and a new bowAttackStart during that 0.2 s blend resumed Bow_End and waited
   there for good (the idle tree lets the next shot start at once: its condition is only that
   the attack state is not drawn or releasing). A global wildcard (flag 0x400) of
   a machine nested in another state of a machine is that machine's too: taken, it goes to the
   state holding the nested machine, which starts in the wildcard's state (Master_Behavior has
   no way into Cart_State but its Cart machine's IdleCartPrisonerASway). Paired animations
   (Paired_Mount.hkx, killmoves) name their tracks: "PairedRoot", the first actor's bones and the
   second's prefixed "2_"; each actor's graph takes its own bones' tracks by name
   (`src/animation/paired-clips.ts`). A machine with a sync variable writes the id
   of the state it enters into it, and one whose start mode is SYNC starts from it (sneaking
   locomotion and the idle turns share iIsInSneak that way). The BSIsActiveModifiers of the
   nodes the events made active are activated then, before any modifier updates (Havok
   activates what a transition enters before the frame's modifiers run, inner before outer):
   the magic graph's CastStop, an event-on-false-to-true of NotCasting on CastingState, reads
   the cast state's InvertNotCasting from the first frame, or it would end every cast as it
   begins.
2. **Update** of the active nodes: transitions without an event whose condition holds are
   taken; clips advance by their playback speed (looping, single play, ping-pong, user
   controlled; an enforced duration plays the clip in that time) and raise their triggers
   and the animation's annotations as they pass them (unless the clip's flag 0x10 says not
   to), what lies at a clip's start time too on its first step after it became active (the
   tower wall's opening clip raises Begin at its local time 0: MQ101DragonAttack's stage 103
   waits for it; of the vanilla behavior files' 881 triggers at a clip's start, none fired before:
   NPCKillMoveStart 232, 2_KillMoveStart 163, InitiateEnd 62, BeginWeaponDraw 32, BeginWeaponSheathe
   26, levers', gates' and traps' sounds); a syncing blender (flag 0x1) keeps a cycle of its own and plays everything it blends
   at that phase, advanced by the time over its children's weighted cycle (a clip's at its
   playback speed, a blender's its children's weighted); a syncing blender within one plays
   at the outer one's phase ([Syncing blenders](#syncing-blenders)); modifiers run:
   expressions assign variables or raise events
   (once, on true, false to true, every frame once true), BSIsActiveModifier sets its bound
   flags while active, timers, event-driven modifiers, events every N events, damping (PID),
   value interpolation, events from ranges, modify-once modifiers.
3. **Pose:** clips are sampled (additive clips hold differences, laid on what is below);
   blenders sum their children's poses by normalised weights (parametric ones by their
   blend parameter, cyclic ones wrapping), per bone where bone weights limit a child (those
   bound to a character property are the character's: [Casting](#casting)); bone
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
start their graph and play idles (`tools/actor-info.ts --audit --deep`). A dragon's ground idle
is Ground_CombatIdle (its animations have no other). A riekling's graph draws its weapon as it
starts (MSG_StandingEquip_State: weaponDraw, which the combat mechanics take as drawn; its AI
sheathes it out of combat), a werewolf's or vampire lord's plays its transformation's start
once (WW_Howl) before its idle. TODO(M13): what the engine gives a graph as an actor loads to
start it elsewhere is not documented. The dead run no graph: their ragdolls pose them
(physics.md, Constraints and ragdolls). Procedural modifiers: below. The engine's variables and
events of locomotion (`src/ai/locomotion.ts`), combat (iRightHandType, iLeftHandType,
IsAttacking, IsBlocking, ...: docs/ai.md, "Combat"), casting and flight are the shell's.

**Intervals:** a transition with a trigger interval (flag 0x1) is taken only within it, one
with an initiate interval (0x2) is kept until it begins when triggered before (unless one kept
already is uninterruptible while delayed, 0x8). Each end of an interval is an event received
in the state (an attack window between R1_Start and R1_Stop, raised by the clip's annotations)
or else a time in the state (an exit time of 0 never ends). Vanilla: 30 trigger intervals and
466 initiate intervals (InitiateStart..InitiateEnd: getting up from a seat, out of an idle),
all bounded by events.

**BSCyclicBlendTransitionGenerator** (directional blends: atronachs, werewolves, vampire lords,
wisps, the first-person character's locomotion and attacks):
its CyclicFreeze event holds its blender's parameter where it is; CyclicCrossBlend fades from
the pose at that parameter to the live one over its transition duration on its blend curve,
the children at both parameters playing on meanwhile. The engine sends the events from the
player's controls, on a large change of direction ([The player](#the-player); every vanilla
generator names these two); NPCs' movement sends none. **BSOffsetAnimationGenerator** lays a clip
on its generator's pose, sampled at the time its variable picks (rangeStart..rangeEnd over the
clip), additively for additive clips. Its vanilla use is the characters' weapon adjustment:
weapAdj picks how far `weaponAdjustment.hkx` pushes the sheathed weapons out; the engine sets
it from the armour (ARMA DNAM weapon adjust, f32 at 8): only body pieces vary it in the data
(0.1–0.65; helmets and the rest are 0 or 1), so it is the cuirass's (slot 32; TODO(M13): not
documented).

### Transitions

How a state machine's blending transitions run (Havok's hkbStateMachine and
hkbBlendingTransitionEffect as the vanilla graphs use them; the census of the 428 vanilla
behavior files: `node tools/behavior-run.ts --transitions`):

- **Nested.** A transition taken while another of the same machine still blends does not start
  from the state that one enters: it blends from the transition under way, which goes on blending
  inside it (its clips play on) until it ends and becomes its state. A machine keeps at most
  maxSimultaneousTransitions nested (32 in 3,604 vanilla machines, 2 or 4 in 39): beyond, the
  oldest ends at once. Before, the blend under way was dropped and the pose popped to the state
  it entered; a graph flipping back and forth showed the state it left at full weight each time.
  Transitions without an event (a condition) are taken while one blends too, unless that one may
  not be interrupted.
- **Back into a state it blends out of** (A to B, then back to A while A still blends out): Havok
  plays a fresh copy of A beside the one blending out; ours share their nodes, so the machine's
  pose as it was is held and A starts over blended in from it (`#restart`, as an instant
  transition back starts it over).
- **Events while blending.** The project's default event mode (hkbProjectData: 2 in every
  vanilla actor project) keeps events from the states a transition blends out of; an effect may
  say otherwise (1,222 vanilla effects let both sides hear them, 30 say not the state left;
  3 would keep them from the state entered). Before, every event reached both sides.
- **Into the same state.** By the effect's self-transition mode: continue (nothing starts over),
  reset (what the state plays starts over), blend (it starts over, blended in from the pose the
  machine had: the runtime keeps the last pose of the machines that have such a transition), or
  the default, continue if what the state plays is cyclic (a looping or ping-pong clip, a blender
  of such, a machine whose state plays one) and blend if not. Without an effect: reset. Before,
  every self transition but a continuing one reset, so a looping clip re-entered by a repeated
  event started over each time. 220 vanilla transitions can lead into their own state.
- **A machine entered again** (a self transition above it that resets or blends): by its own
  self-transition mode it stays in its state (3,510 vanilla machines; what that state plays starts
  over), goes to its start state if its state has a transition there (47), or always (86).
- **Effect flags and end mode:** sync (344) starts the state entered where the state left is in
  its cycle; ignore from / to world-from-model (1,290 / 487) leaves the root motion to the other
  side; end mode 1 lasts until the state left ends, 2 no longer than that (22 vanilla, all of
  duration 0).
- **Clip flags:** continue motion at end (0x1: the quadrupeds' canned flee turns) keeps moving
  the character as the clip's last moment did once a single-play clip has ended; ignore motion
  (0x20) does not move it. A clip that joins a syncing blender's cycle (a horse's trot joining its
  walk) starts at the cycle's phase without moving the character from its start (it jumped a
  stride ahead), as does a clip started at a fraction.

### Syncing blenders

A blender with the sync flag (hkbBlenderGenerator FLAG_SYNC, 0x1) plays what it blends in step:
one cycle for all its children. Ours (`BehaviorRuntime`, `#sync`): the blender keeps a phase of
its own (0..1), advanced every update by the time over the weighted cycle of its active
children (a clip's duration, cropped or enforced, over its playback speed; a blender's, its own
children's weighted; a state machine's, its current state's). Every child plays at that phase:
a clip's time is the phase times its duration; a syncing blender within takes the phase from
the outer one instead of advancing its own (the horse's speed blend, ForwardLocomotionBlend_Horse,
holds five syncing turn blends: walk-slow, walk, trot-slow, trot and run, each left, straight
and right on TurnDeltaDamped at 135, 0 and −135; of the vanilla graphs' 1,358 syncing blenders in
428 behavior files, 162 hold syncing blenders of their own, in 37 files: the characters' MT,
weapon, bow, magic and block locomotion, the horse, the mudcrab, draugr, troll, giant, dragon,
werewolf and others). A child whose weight comes back above zero is
activated anew and starts at the blender's phase; the cycle goes on. A blender entered anew
starts where its clips were started (a transition that syncs), else at 0.

**What this fixed.** The phase was read from the first active child's clip. In a turn blend
whose damped TurnDelta wavers about zero, the side children take turns: right and straight, then
straight and left. Each time the right child came in, its clip was new (phase 0): the whole walk
started over. Measured offline (`tools/behavior-run.ts`'s runtime, the horse project, Speed 125,
TurnDelta ±30 every eighth of a second): the walk stood in its first tenth (WalkForward at
0.08, 0.10, 0.12 after 1, 2, 3 s) and its root motion read 530 units a second, each restart
counted as a loop of the clips that stayed; the opening's cart horse (MQ101CartHorse2Patrol1)
read 893 to 1314 units a second at a walk of 125 in the QA sweep, its trot clips restarting 8
times a second. Now the walk goes through its stride (1.00, 0.91, 0.83 after 1, 2, 3 s, about 1.1 s
a cycle) and its root motion reads 126 units a second; the walk and the trot within the speed
blend are in step (before, each turn blend kept its own phase).

The runtime counts what it does (`BehaviorRuntime.stats`: updates, state changes, self
transitions, interrupted transitions, clip starts) and tells a development hook of every state
change (`traceChange`): the measurements in this file come from them.

## Mirrored clips

A clip with the mirror flag (hkbClipGenerator 0x4: 200 vanilla clips in 37 graphs: every
quadruped's right turns, played from the left ones; mirrored attacks, recoils, get-ups and deaths;
the humans' HideL* and CornerPeek*R) plays its pose mirrored across the character
(`src/animation/mirror.ts`). Observed in the original (Havok's hkaMirroredSkeleton as the
executable builds it from the character's hkbMirroredSkeletonInfo), in our words:

- The mirror axis is a quaternion (every vanilla character: (1, 0, 0, 0), across the plane x = 0,
  its left and right) and each bone has a partner (the bone pair map; empty in 326 of the 355
  vanilla characters, the horse, the wolf and the skeever among them: then every bone is its own
  partner; `CharacterInfo.mirror`).
- As the skeleton is set up, each bone gets an invariant rotation from the reference pose: its
  model-space rotation inverted, times the axis, times its partner's model-space rotation,
  snapped to the nearest of the 24 quarter-turn rotations when within 0.1 of one. The reference
  pose so mirrors onto itself (checked: the human skeleton within 0.01 units and 1.2°, the deer
  and the chicken likewise).
- A pose is mirrored bone by bone in local space: the rotation becomes the parent's invariant
  (the axis for a root) times the rotation times the bone's own invariant inverted; the
  translation is turned by the parent's invariant and negated. Then each bone swaps its
  transform with its partner's. The clip's motion is mirrored by the axis: x negated, the turn
  reversed.
- With every bone its own partner (horses, wolves) the bones' places are reflected too: a left
  leg's place goes to the right side, the right leg's to the left, each keeping its own
  orientation; that is what the engine's mirroring does with these characters.
- An additive mirrored clip (ours: the engine's path for additive poses was not read) is laid
  on the reference pose, mirrored, and taken again as the difference to the mirrored reference.

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
- **BSDirectAtModifier** (23: bows and crossbows, spells, the dragon rider, block
  anticipation; observed in the original): the chain from start to end bone turns by the
  heading and pitch from the source bone to the target (from the character's origin when it
  has none, sourceBoneIndex −1), each within its limit and then the offset added, eased by its
  gains (snapped to none below 0.01 as it eases off); its outputs (active, current heading
  and pitch) go to their variables. The target: a bound vector, the camera, or the aim the
  engine gives its kind (BehaviorRuntime.setDirectAtTarget by userInfo: 1 block anticipation,
  2 bows and spells, 3 the dragon rider): [Weapons in the hands](#weapons-in-the-hands).
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
  swinging the leg onto it (observed in the original: the two-joint solver turns the knee
  about the hinge by the wanted interior angle less the one it has, taken without a sign, so a
  leg the clip holds straight or a little past straight bends forward to the people's 165°;
  ours took the side from the angle's sign and bent such knees backwards for a frame or a few,
  the NPCs' "knocking knees"; `tests/conformance/animation/foot-ik.test.ts`), the foot keeping its animated turn, tilted to the slope where
  planted (ankleOrientationGain, maxAnkleAngleDegrees). It eases on and off by onOffGain,
  keeping what it found while off. The engine turns humans' on (bHumanoidFootIKEnable 1; the
  graph turns it off in furniture; TODO(M13): when the engine sets it); bHumanoidFootIKDisable
  (set by state machines' isActive outputs and BSIsActiveModifiers: swimming, killmoves,
  bleedout, jumps, mounts) turns it off. The rays see what character controllers stand on,
  the actor's own controller left out (TODO(M13): the driver's own filter, L_TRANSPARENT, would
  see its ragdoll). TODO(M13): locking planted feet and the planted and raised gains are not
  documented.
- **hkbKeyframeBonesModifier** (91): the ragdoll bones it keeps keyframed
  (BehaviorRuntime.keyframedRagdollBones: the lower body getting up; the whole ragdoll on its
  way to ragdolling). The ragdoll bones are the ragdoll skeleton's, mapped onto the animation
  skeleton's by the skeleton file's hkaSkeletonMapper (readRagdollMapping: names do not tell,
  the giant's left thigh is "[RThg]01"). The living's bodies follow the pose (keyframed:
  actor-bodies.ts); a hit pushes a ragdoll lying (dead or knocked down) instead: vanilla keeps
  the living's whole ragdoll keyframed (the SKSE mods that add hit reactions to the living make
  the point), and its rigid body controls (hkbRigidBodyRagdollControlsModifier:
  rigidBodyRagdoll, its hkaKeyFrameHierarchyUtility gains) drive the get-up's upper body,
  which is keyframed to the blend here.
- **Ragdolls and getting up** (docs/ai.md, "Combat": Knock-downs): `Ragdoll` (i1stPerson 0)
  and `RagdollInstant` take the human graph to FullyRagdoll; its pose matcher
  (hkbPoseMatchingGenerator, read as a blender with its own members) shows the matched get-up
  clip's first pose, held still, from its start-matching event, matching again whenever the
  engine gives the ragdoll's pose (setRagdollPose: bone transforms in the model frame): of its
  children's first poses the one whose root, other and another bones (the ragdoll's COM, neck,
  left upper arm) lie as the ragdoll's do, turned about the up axis and shifted to fit
  (src/animation/pose-matching.ts: least squares; TODO(M13) Havok's own weighing), and keeps
  the turn and shift (poseMatch) and the ragdoll's pose in that frame (matchedRagdollPose);
  from its start-playing event (GetUpStart, the timer of MatchAndSendGetup 0.5 s after
  GetUpBegin) it plays that clip. hkbGetUpModifier, as it becomes active, takes the matched
  ragdoll pose and blends from it into the animation over its duration (1 s; the ground under
  the engine's placement is level: groundNormal and alignWithGroundDuration add nothing).
  hkbPoweredRagdollControlsModifier's control data is told (poweredRagdoll: maxForce 0 limp in
  FullyRagdoll, 200 matching; its tau, damping, recovery velocities and bones): a knocked-down
  actor's ragdoll joints' motors pull it toward the graph's pose with it (physics.md,
  Constraints and ragdolls: Motors). TODO(M13): the paralysed's stiff fall.
  BSRagdollContactListenerModifier raises its event once a body of its bones touches
  something (the engine's ragdollContact: ActorBodies.touching), as AnimateToRagdoll's death
  animation goes limp. `tests/knockdown.int.test.ts` runs the human graph through it on the game
  data.
- **hkbRotateCharacterModifier** (6): turns the character at TurnDelta in the equip and unequip
  states; the movers make that turn already, so the graph's root motion leaves it out.
- **The dragon's flight modifiers** (docs/ai.md, "Flying"): BSTweenerModifier carries
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
- Not run, by milestone (behavior.ts): BSIStateManagerModifier (M11, with the beast forms).

## Head tracking

Where actors look (`src/ai/head-tracking.ts`, `src/shell/actor-looks.ts`): an actor has a
head track target of each kind (CommonLibSSE HEAD_TRACK_TYPE: default, action, script, combat,
dialogue, procedure); the highest set is looked at (TODO(M13): the order is the enum's).
Scripts' Actor.SetLookAt and ClearLookAt are 'script'; scenes' looks, speakers talking to
someone and the actor talking with the player are 'dialogue'; other code asks through
`session.scriptWorld.lookTargets.lookAt(actor, target, kind)` (a reference or a world point;
undefined lets go). A script's look is held fAIStayonScriptHeadtrack (20 s), then the actor's
own for −fAIRevertToScriptTracking (3 s), then the script's again. Without any, an actor
chooses its own look (observed in the original): every [HeadTracking]
fUpdateDelaySecondsMin–Max (1–1.5 s), at most iUpdateActorsPerFrame (10) actors a frame, only
within fAIMaxHeadTrackDistanceFromPC (2000; an extra large race fAIMaxLargeCreatureHeadTrackDistance, 12000) of the player, the player or another actor it detects (detection: docs/ai.md,
"Detection") within fAIMaxHeadTrackDistance (400; extra large 12000) and 120° of its facing,
the nearest; a new one held fUpdateDelayNewTargetSecondsMin–Max (3–8 s) while it still may be
looked at. fAIBestHeadTrackDistance and fAIInteriorHeadTrackMult the engine never reads.
TODO(M13): how the engine scores the candidates (here the nearest), its look along the path
(fMin/MaxPathLookAtPointDist, fPathLookAtPointTime), a package target's look
(fAIActorPackTargetHeadTrackMod).
Actor.SetHeadTracking(false)
and the graph's HeadTrackingOff (graphs' and clips' events; actorresponse.txt's
HeadTrackingOffHandler; HeadTrackingOn again) stop it. The point looked at turns towards the
target at fHeadTrackSpeedMax (200° a second) when more than fHeadTrackSpeedMaxAngle (10°) off,
fHeadTrackSpeedMin (60°) within fHeadTrackSpeedMinAngle (5°), now and then off it by
fAIHeadTrack*'s random offset (0 in Skyrim.esm); it reaches the graph as bHeadTracking and
TargetLocation, the camera as camerafromx/y/z. The player's body looks the same way at what
scripts, scenes and dialogue ask and else, in third person, where the camera looks
(TODO(M13): the engine's own player head tracking is not documented).
