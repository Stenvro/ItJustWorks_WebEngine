# Animation: completeness

What "100" means here: everything the archives' behavior graphs and animations and the load
order's records (Skyrim.esm, Update, the three DLCs and the Creation Club files of the install)
give animation is read and run as the original does: every Havok behavior class and member the
graphs use, every annotation of every animation, the engine's handlers of the graphs' events,
every IDLE field and condition, the actions (AACT), paired animations and kill moves, head
tracking, look-at and foot IK, faces and lip sync, and the animation settings.

The data part comes from the sweep `node tools/animation-physics-completeness.ts --area
animation` (`--all` for every item with where it is read; about two minutes: it reads every
Havok file of the archives). An item is done when the engine reads it:

- a behavior class: the parser maps it to a node the runtime runs (never its catch-all
  `other`), or the code names it;
- a behavior member: the parser reads it (every read of every packfile is recorded; the
  formats' census, `format-census.ts hkx-members`, checks the same over all Havok files);
- a parsed node field: the runtime's code (src/animation, src/shell) names it;
- an annotation (by its tag: the text before its first dot, a paired partner's `2_` left
  off): the code names it, a response file's handler the code implements answers it, a
  footstep record (FSTP) names it, or a graph has it as an event (the runtime raises it there);
- a record field: named outside the file that parses it; a condition function: valued
  (tests/condition-audit.int.test.ts); an action: performed by the code by its editor id; a
  setting: read by a settings reader or named in the code.

A name found is a strong hint, not proof (a common field name is found anywhere); the mechanics
are kept by hand below, against docs/animation.md and the conformance suites
(tests/conformance/animation/). The count after an item is how many objects (nodes,
annotations, records) use it.

## Count (2026-11-03, round 8)

| Part                        | Items | Done | Open |
| --------------------------- | ----: | ---: | ---: |
| Behavior classes            |    66 |   66 |    0 |
| Behavior members (read)     |   320 |  320 |    0 |
| Behavior node fields (run)  |   292 |  283 |    9 |
| Annotations (tags)          |   135 |  127 |    8 |
| Response handlers           |    97 |   97 |    0 |
| Idles (IDLE fields)         |    10 |    9 |    1 |
| Idle conditions (functions) |   111 |  111 |    0 |
| Actions (AACT)              |    71 |   68 |    3 |
| Game settings (GMST)        |    20 |   20 |    0 |
| Mechanics (by hand)         |    27 |   18 |    9 |
| Total                       |  1149 | 1119 |   30 |

Round 1 wrote the sweep and this list. Built: the animations' SoundStop.<descriptor> and
SoundRelease.<descriptor> (17 and 8 annotations: the bow's draw loop, WPNBowPullLPM, stops as
the arrow leaves; a dog's distant bark ends) stop what that actor's SoundPlay started
(src/shell/actor-sounds.ts).

Round 2 (1053 to 1075): the movement actions (17: moving, turning, sprinting, sneaking,
swimming, the player's jump, the get-up and knock-down) are performed through the idle tree,
at once where their idles ask only the actor's own state; the syncing blenders' sync master
and the clips' sync points; the idles' replay delay; the two response handlers that are no
classes of the original (their events do nothing). Next biggest: the 38 node fields (userData
of 24 kinds, TODO(M13); the paired clip's mark threshold and prefix; the cyclic blend range;
the powered ragdoll's world-from-model mode; the keyframed ragdoll's blend duration), the 14
actions left (path end, summoned start, force equip, reload, dual release, block anticipate,
ragdoll instant, reset graph, ...).

Round 3 (1075, unchanged): spent on the ragdolls' joints at their limits (Hulda at the
Bannered Mare's counter: she slumps when killed 1.5 or 2 s into her lean, and stays draped over
the counter on locked legs at 1, 2.5 and 3 s; docs/physics.md, "The cone", and the physics
list). The node fields, the actions and SoundPlayAt for object graphs were not reached.

Round 4 (1075 to 1081): the rigid body ragdoll controls run (their gains through Havok's
hierarchy controller, src/physics/keyframe-hierarchy.ts; their durationToBlend blends them in:
docs/physics.md, "The hierarchy controller"); the cyclic blend range (run all along by the
parser's activeChildren, which the sweep did not see: now named, and tested); the synchronized
clip's SyncAnimPrefix picks the partner's tracks; IDLE loopMin and loopMax (the looping idles
stop after their time); SoundPlayAt for object graphs. Not reached: the 14 actions (each needs
an engine moment in another system: the travel's arrival heading, the summon's appearance, the
combat code's equip, reload, bash and block), the mark threshold, the powered ragdoll's
world-from-model mode, bDisableInterp's setter.

Round 5 (1081 to 1087): six actions get their engine moment (src/gameplay/combat/
combat-actions.ts, tests/engine-actions.int.test.ts): ActionForceEquip as the hands change with
the weapon out, ActionReload for a crossbow out without its bolt, ActionDualRelease as both
attack buttons come up at once, ActionBlockAnticipate as a blow comes at a held block,
ActionPathEnd as a furniture walk arrives with the entry's heading, ActionSummonedStart as a
summon first appears. The eight left have no moment in the data or docs (below).

Round 6 (1087 to 1088): of the eight actions, seven are the engine's own default objects
(observed in the original: Action Ragdoll Instant, Action Reset Animation Graph, Action
Waterwalk Start, Action VoiceReady, Action Look, Action Shield Change, Action Listen Idle), so
the engine asks for them at moments still to be found; ActionStopEffect is none, so nothing in
the engine names it: inert. Not reached: those seven moments, the node fields (the mark
threshold, applyMotionFromRoot, the powered ragdoll's world-from-model mode, bDisableInterp's
setter, userData). Physics this round: a ragdoll made dynamic lifts its still bodies
(docs/physics.md, "Made dynamic"); Hulda's locked legs stay open.

Round 7 (1088 to 1092): the engine reads its default objects by their place in the list (the
DOBJ order); four of the seven actions are read there, each at a moment now built (docs/
animation.md, "Driving the graphs"; tests/engine-actions.int.test.ts): ActionRagdollInstant as an
actor placed dead has its graph made, ActionResetGraph as an actor is resurrected (the stage
now raises it: it was left lying), ActionWaterwalkStart as an actor with Water Walking takes to
the water (water walking built: the surface bears it, NPCs and the player), ActionShieldChange
as a shield goes on or off. ActionLook, ActionVoiceReady and ActionListen were found read
nowhere the search reached. Not reached: the node fields (the mark threshold,
applyMotionFromRoot, the powered ragdoll's world-from-model mode, bDisableInterp's setter,
userData).

Round 8 (1092 to 1117), observed in the original: hkbNode.userData (24 node kinds, 4,950 nodes)
is compared by nothing; the runtime keeps its own state there on clip and offset generators
(their animation still loading, or loaded), which ClipHost's load on first use is (inert). The
synchronized clip's fMarkErrorThreshold: once its get-to-mark time is over, the partner is at
its mark when within it on each axis (and turn, reorienting); until then it is put there again
(`atMark`, src/shell/actor-combat.ts). bDisableInterp has no setter in the engine: it reads it
with bIsSynced and bSpeedSynced, any of them set keeping the graph from interpolation (all three
now asked). The player's graph is given ActionWaterwalkStart. bApplyMotionFromRoot (the actor
moved by its root bone, the bone left at the origin; docs/animation.md, "Killmoves"): built
2026-11-09 (BehaviorRuntime.motionFromRoot; the riders placed by it, src/shell/actor-mounts.ts).
Not reached: the powered ragdoll's world-from-model mode; ActionLook, ActionVoiceReady and
ActionListen (the computed reads of the default objects are the actor's queue of actions, and
what fills it was not found).

## Behavior graphs

- [x] Classes (66 of 66 in the 433 graphs, characters and projects of the archives): the
      generators (hkbStateMachine 3673 with its state infos 10728 and transitions,
      hkbClipGenerator 10143, hkbBlenderGenerator 2023, hkbManualSelectorGenerator 583,
      hkbPoseMatchingGenerator 98, hkbBehaviorReferenceGenerator 97, hkbReferencePoseGenerator,
      hkbModifierGenerator 1933, BGSGamebryoSequenceGenerator 661, BSSynchronizedClipGenerator
      540, BSiStateTaggingGenerator 171, BSCyclicBlendTransitionGenerator 154,
      BSBoneSwitchGenerator 137, BSOffsetAnimationGenerator), the modifiers (hkbModifierList,
      BSIsActiveModifier 677, hkbEvaluateExpressionModifier 476, hkbEventDrivenModifier 162,
      BSLookAtModifier 128, BSEventOnDeactivateModifier, hkbPoweredRagdollControlsModifier,
      hkbKeyframeBonesModifier, BSEventEveryNEventsModifier, hkbTimerModifier,
      hkbRigidBodyRagdollControlsModifier, BSRagdollContactListenerModifier, hkbGetUpModifier,
      BSSpeedSamplerModifier, hkbDampingModifier, BSInterpValueModifier, BSModifyOnceModifier,
      hkbFootIkControlsModifier, BSEventOnFalseToTrueModifier, BSDirectAtModifier,
      hkbTwistModifier, hkbRotateCharacterModifier, hkbEventsFromRangeModifier,
      BSTweenerModifier, BSIStateManagerModifier, hkbFootIkModifier, BSGetTimeStepModifier,
      BSPassByTargetTriggerModifier, BSDecomposeVectorModifier, BSTimerModifier,
      BSLimbIKModifier, hkbTransformVectorModifier), the conditions (hkbExpressionCondition,
      hkbStringCondition), transition effects (hkbBlendingTransitionEffect), bindings, payloads
      and the graph's data (src/formats/hkx/behavior.ts, src/animation/behavior-runtime.ts).
- [x] Members: all 320 serialized members the files set are read (the two clip binding
      indexes are -1 in every file: the runtime binds clips as they activate).
- [x] Node fields run (283 of 292): everything the state machines, transitions, clips,
      blenders, selectors and modifiers carry, but for:
- [x] `userData` of 24 node kinds (4,950 nodes): inert, observed in the original: the files'
      per-class 1, 2 and 3 are compared by nothing; the runtime keeps its own state there on clip
      and offset generators (8: their animation still loading, a stand-in played; 12: loaded),
      as ClipHost loads a clip on its first use (round 8).
- [x] blender.indexOfSyncMasterChild (2080): a syncing blender's master child (13 of 1,369,
      the jumps' directional and the unequip blends) leads its cycle and its sync points while
      it plays (docs/animation.md, "Syncing blenders"; round 2).
- [x] blender.maxCyclicBlendParameter (2121), minCyclicBlendParameter (17): a cyclic
      parametric blend's parameter wraps within its range, from the last child back to the
      first (activeChildren in src/formats/hkx/behavior.ts, which the runtime's blend weights
      use; tested in behavior.test.ts; round 4).
- [x] synchronized-clip.syncPrefix (226): the partner's tracks are the active synchronized
      clip's SyncAnimPrefix ("2_" in all 226 that name one; pairedTrackBones; round 4).
- [x] synchronized-clip.markErrorThreshold (540): the partner is at its mark once within it on
      each axis (with bReorientSupportChar, its rotation too) after its get-to-mark time; until
      then it is put there again (observed in the original; `atMark`; round 8).
- [ ] synchronized-clip.applyMotionFromRoot (13: Mount, Dismount, DragonMount, DragonDismount,
      the dragon's grapple and mount): observed in the original, the actor's placement follows
      its skeleton's root bone (the mark composed with the bone's pose, the bone left at the
      origin). TODO(M13): not built (the drawn picture is the same; the actor's own place does
      not follow).
- [ ] powered-ragdoll.worldFromModelMode (95): the powered ragdoll's root (world-from-model
      mode, its pose-matching bones). TODO(M13) with the formats' list; not reached in round 8.
- [x] rigid-body-ragdoll.durationToBlend (56; 0.5 s in all): the rigid body controls blend in
      from the bodies' own motion over it as they drive a ragdoll in the world, their control
      data through Havok's hierarchy controller (src/physics/keyframe-hierarchy.ts,
      ActorBodies #drive; round 4).
- [x] get-up.alignWithGroundDuration, groundNormal (46: 0.25 s and straight up in all): the
      get-up's turn of the character's world-from-model to the ground. Ours stands the character
      upright as it is matched (the blend from the ragdoll's pose is the pose's, over its
      duration), so the turn to straight up has nothing left to turn; read and not applied.
      TODO(M13): a ground normal other than up (no vanilla graph has one).
- [x] foot-ik-controls.alignWithGroundRotation (25), foot-ik.alignWithGroundRotation (2): the
      character's first bone turned by it before its feet are placed; the identity in all 27
      (#alignWithGround). TODO(M13): Havok's use of any other turn.
- [x] damping.enableVectorDamping (43; off in all): rawVector to dampedVector by the same
      controller as the value's.
- [x] rotate-character.degreesPerSecond, speedMultiplier (6; all bound to TurnDelta, speed 1):
      the turn the movers make anyway, so left out of root motion, not to turn twice. One not
      bound to a variable (no vanilla one) turns the character by its root motion.

## Annotations and events

- [x] Tags (127 of 135; 7,693 annotations): footsteps by their sets' tags (FootLeft 1004,
      FootRight, FootBack, FootFront, FootScuff*, FootSprint*, JumpDown, ...; src/shell/
      actor-sounds.ts), SoundPlay, NPCSoundPlay, SoundStop, SoundRelease, the response files'
      events (weaponSwing, HitFrame, PreHitFrame, ...), the graphs' own events (SyncLeft,
      SyncRight, FlightLandingEffect, the dogs' and wolves' sounds by their graph events, ...),
      paired clips' own events of each side ("2_" and "NPC", the prefix off; the other side's
      not heard; NPCSoundPlay keeps its name: docs/animation.md "Paired events").
- [x] SyncLeft, SyncRight and the other sync points (EVENT_FLAGS.syncPoint): they sync the
      clips of syncing blenders (round 2; by hand below).
- [x] FrontFoot (26), BackFoot (25), Spellfire (2), FrootBack (4), FootFornt (3), FottFront (1),
      FoorRight (1), and 11 empty annotations: no effect. An annotation only does something
      through a name that answers it (a footstep set's tag, a response file's event, a graph's
      event); nothing in the data names these. Whether the original's code answers FrontFoot or
      BackFoot was not read: TODO(M13).
- [x] SoundPlayAt.<descriptor>.<node> (20, the sawmill's saw): an object graph's sound at that
      node of its model as it moves; its SoundPlay at the object (objectSounds in
      src/sim/placed-objects.ts; round 4).
- [x] Response handlers (97 of 97): actorresponse.txt and playercharacterresponse.txt. Two,
      StopHorseCameraHandler and RemoveCharacterControllerHandler, are no classes of the
      original: their events do nothing there and here (tests/conformance/animation/
      engine-handlers.test.ts; the sweep's NO_HANDLER_CLASS).

## Idles and actions

- [x] IDLE fields: parent 3779, behavior graph 3337, event 2982, conditions 2215, previous
      1489, flags 383 (src/ai/idle-records.ts, the idle tree's search).
- [x] Idle conditions: all 111 functions the idles use are valued.
- [x] loopMin, loopMax (4 idles: the goat's feeding 10 to 30 s, the sabre cat's lie-down 4 to
      8, the troll's crouching group 2 to 5, IdleInjured 255: forever): the idle stops
      (ActionIdleStop) after a random time between them (idleLoopSeconds, ActorFurniture; round
      4). TODO(M13): inferred from the Creation Kit's name; how the original ends the loop.
- [x] replayDelay (126 idles): an idle is not picked again for the actor until its delay has
      passed (src/shell/actor-furniture.ts; round 2). TODO(M13): per actor or not; a group
      idle's delay over its children.
- [ ] animationGroupSection (3128 idles): "stray bytes" in Skyrim's data (idle-records.ts).
      TODO(M13): confirm the original reads nothing there.
- [x] Actions performed (**DONE** of 71): ActionIdle, ActionDraw, ActionSheath, the attacks
      and power attacks, interrupts, ready and release of each hand and the voice,
      ActionActivate, ActionLand, ActionFall, ActionDeath, ActionDeathWait, the bleedout's, the
      stagger's, the recoils, ActionBlockHit, ActionWardHit, ActionBumpedInto, ActionTalking,
      flight and hover, ActionPathStart, ActionIdleStop, ActionIdleStopInstant, ActionIdleWarn;
      round 2: the movement actions (ActionMoveStart, ActionMoveStop, ActionMoveForward,
      ActionMoveBackward, ActionMoveLeft, ActionMoveRight, ActionTurnLeft, ActionTurnRight,
      ActionTurnStop, ActionSprintStart, ActionSprintStop, ActionSneak, ActionSwimStateChange,
      ActionLargeMovementDelta) through the idle tree as the data channels cross their
      thresholds, at once where their idles ask only the actor's own state, else in order
      behind the tree (src/ai/locomotion.ts, ActorFurniture.actionEventNow); the player's
      ActionJump; the knock-downs' ActionGetUp and ActionKnockDown (combat's ActionKnockdown
      was asked by a misspelt name the sweep did not find); round 5 (each with its moment
      decided from plain state, src/gameplay/combat/combat-actions.ts, and its tree tested in
      tests/engine-actions.int.test.ts): ActionForceEquip (a hand's item changed with the
      weapon out: WeapOutRightReplaceForceEquip, WeapOutLeftReplaceForceEquip,
      MagicForceEquipRight, ...), ActionReload (an attack asked of a crossbow out without its
      bolt: reloadStart), ActionDualRelease (both attack buttons up within fDualCastChordTime:
      StaffBashRelease with a staff in the left hand), ActionBlockAnticipate (a blow coming at
      an NPC's held block, each blow once: blockAnticipateStart), ActionPathEnd (a furniture
      walk arriving with its entry's heading: the canned turn by GetPathingTargetAngleOffset),
      ActionSummonedStart (a Summon Creature's actor as the stage first shows it: summonStart).
      TODO(M13): the original's exact moments (the player's block anticipation; an arrival
      heading for other travels).
- [x] ActionStopEffect: inert. It is not one of the engine's default objects (the engine names
      the actions it performs through them; the other seven below are), and no vanilla graph
      has an idle for it (round 6).
- [x] The engine's own (round 7, observed in the original; docs/animation.md, "Driving the
      graphs"): ActionRagdollInstant (RagdollInstant, 46 graphs) as an actor placed dead has
      its graph made (src/shell/actor-stage.ts); ActionResetGraph (returnToDefault, Reset,
      RESET_GRAPH: 44 graphs) as Resurrect raises an actor (ActorStage.resurrected);
      ActionWaterwalkStart (the vampire lord's WaterWalkStart) as an actor with Water Walking
      takes to the water (src/gameplay/swimming.ts walksOnWater; the player's graph too, round 8); ActionShieldChange (no idles)
      as a shield goes on or off (combat-actions.ts changesShield). TODO(M13): the kill asked
      with its ragdoll at once and a reanimation ending on the dead (both RagdollInstant in the
      original) are not built; the knocked down and unconscious placed (a save) are not dropped
      by it.
- [x] Actions never performed (3): inert, as ActionStopEffect above. ActionLook and
      ActionVoiceReady have no idles in any vanilla graph, ActionListen one empty idle group, so
      performing them would play nothing. (When the original performs them was not found: round 8. A mod's idle under one would not play: TODO(M13).)

## Game settings

- [x] All 20: head tracking (fHeadTrackSpeed*, fAIHeadTrack*), blinks (fBlink*), iLipMorphCount.
- [x] The engine's built-in [Animation] and [HAVOK] INI settings (the list observed in the
      original). Read: bAlwaysDriveRagdoll, bAnimInterpEnable, fAnimInterp*, bDriveRagdollWithGraph,
      bFeedbackToGraphFromCharacterController, bFootIK, fBoneLODDistanceScale, fMaxTime,
      fMaxTimeToMarkSec, fMotionFeedback*, fMountDismountTimeout, fMoveLimitMass,
      fQuadrupedPitchMult, fUnsupportedGravMult, fWarmStartMaxTime,
      iMinBonesToGenerateWhileSitting, uMaxNumPhysicsStepsPerUpdate, bUseSpeedSampler,
      fSpecialIdlePickTime (the ambient idles' frame budget, read as microseconds: inferred).
      [RagdollAnim]'s gains (fHierarchyGain ... fSnapMaxAngularDistance) and feedback
      (bRagdollFeedback, fFeedback*): read, their use inferred (docs/physics.md, "The engine's
      ragdoll drive"). Taken to be of no effect here by their names (tools, threads, consoles, caches; their reads
      not followed): bAlwaysSaveAllInfo,
      bDebugMultithreaded, bDisplayMarkWarning, bDrawAnimPoseInVDB, bHavokDebug,
      bInitiallyLoadAllClips, bLoadCollatedAnimTextData, bMultiThreadBoneUpdate,
      bRegisterAllVDBViewers, bSendNonVisibleBehaviorGraphsToSPU, bShouldProcessRequests,
      bUseSPUGenerate, bUseVariableCache, bUseWorldLock, sHkxDBNameContextPrefix,
      uVariableCacheSize, iEntityBatchRemoveRate. fJumpAnimDelay: no code of the original reads it.
- [ ] Read by the original and not by us. bApplyPitchToExtractedMotion (1): a clip's root motion
      turned by the actor's pitch (no effect at pitch 0; the movers' root motion is level);
      bEnableHavokHit (0) with fHavokHit*: off in the game; bFootIKFeedback (1), bForceJumpingFromGraph
      (0), bRandomizeGraphSeed (1), fIdleChangeClearTime (1), fWeaponChangeClearTime (0.5),
      fMaxFrameCounterDifferenceToConsiderVisible, the player's
      fPlayerCharacterDrawSheatheTimeout, fPlayerCharacterPowerAttackStartTime,
      fPlayerCharacterAttackIntroLength, fPlayerCharacterAttackComboStartFraction: each has one
      to three reads, not followed. TODO(M13). The physics' solver and character keys (fSD, fSE,
      fOD, fRF, iSimType, fTimePerSubStep, iMinNumSubSteps, bUseCharacterRB, ...) are the physics
      area's and were not gone through here.

## Mechanics (by hand)

- [x] The behavior runtime: state machines, transitions and their effects, blending, syncing
      blenders, bindings, expressions (docs/animation.md, "Behavior runtime").
- [x] Sync points: a syncing blender's children play between their own sync points as its
      cycle is between its layout's (src/animation/sync-points.ts; round 2).
- [x] Mirrored additive clips: by our own rule (docs/animation.md, "Mirrored clips"), and no
      vanilla graph plays one (tests/conformance/animation/clips.test.ts). TODO(M13): the engine's
      rule, for a mod's.
- [x] Engine handlers: the response files' 95 of 97 (above).
- [x] An event no node takes is reported as not handled (BehaviorRuntime.answered): a death
      idle its graph does not take lets the body go at once (inferred, TODO(M13);
      tests/conformance/animation/graph-runtime.test.ts). (bDisableInterp has no setter in the engine, observed in the
      original: the graphs set it; it is read with bIsSynced and bSpeedSynced: round 8.)
- [x] Head tracking (docs/animation.md, "Head tracking"; the settings above).
- [x] Look-at, direct-at (BSLookAtModifier, BSDirectAtModifier) and limb IK.
- [ ] Foot IK: the narrow quadrupeds' (the formats' list).
- [x] Faces: expressions, phonemes, blinks, the head's morphs (src/animation/face.ts).
- [ ] Faces: the expression change rate.
- [x] Lip sync (.lip, .fuz) with the dialogue.
- [x] Faces: the emotions' eye offsets from the settings; a creature line's curves matched to its
      graph's Lip variables by phoneme (tests/conformance/animation/faces.test.ts).
- [ ] Faces: the engine's scale from an eye turn to a look morph's weight (ours an inferred
      estimate from the eyes' TRI, 29° and 16°).
- [x] Paired animations: the support's mark, its side to the clip's end, death limp.
- [x] Paired animations: events routed per side by their prefix ("2_", "NPC"; the other side's
      not heard from it); pairedStop ends only the pair of the side that raised it, the other
      side's by its own pairedStop or as its graph leaves the clip (inferred;
      tests/conformance/animation/paired-animations.test.ts).
- [ ] Paired animations: a vampire feeding pair ends the feeding procedures. TODO(M11): our AI
      runs no feeding procedure; VampireFeedEnd ends the feeder's GetVampireFeed (inferred).
- [x] Kill moves (docs/animation.md, "Killmoves").
- [x] Dismemberment and decapitation (the head's flight, the stump, persistence).
- [ ] The severed head's flight into MQ101's basket: it reaches the rim's height over the near
      wall and rolls off (docs/animation.md, "Dismemberment"). TODO(M13): where the original's
      flight starts.
- [x] Ragdolls: death, powered ragdolls, get-up, keyframed ragdolls.
- [ ] The powered ragdoll's root (world-from-model mode); the paralysed's stiff fall.
- [x] Animation objects: the list, the female hands' scale while one is held (inferred: the
      skeleton's own node scale stays under the clips), the POV switch off while the player holds
      one, a model without "Prn" never shown, saves (tests/conformance/animation/animation-objects.test.ts).
- [x] Ambient idles (but which idles skip the next PickNewIdle, the complex scene's wait).
- [x] Weapons and aim, casting, horses, first person.
- [x] Graph state in saves: each actor's graph's states, clips' times, variables, events not
      handled yet, transitions and modifiers (docs/formats/save.md, "Animation graphs";
      tests/conformance/animation/graph-runtime.test.ts).
- [x] Clips: compression, root motion, float tracks, annotations.
- [x] Clip triggers and annotations raised as they are passed: looping cycles, ping-pong turns,
      a negative speed played from the end, acyclic triggers (docs/animation.md, "Clip triggers";
      inferred where Havok's rule is not documented).
- [x] Sounds of animations: footsteps, SoundPlay, NPCSoundPlay, SoundStop, SoundRelease.
