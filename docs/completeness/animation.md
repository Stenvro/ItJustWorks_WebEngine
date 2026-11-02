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

## Count (2026-11-02, round 3)

| Part                        | Items | Done | Open |
| --------------------------- | ----: | ---: | ---: |
| Behavior classes            |    66 |   66 |    0 |
| Behavior members (read)     |   320 |  320 |    0 |
| Behavior node fields (run)  |   292 |  254 |   38 |
| Annotations (tags)          |   135 |  127 |    8 |
| Response handlers           |    97 |   97 |    0 |
| Idles (IDLE fields)         |    10 |    7 |    3 |
| Idle conditions (functions) |   111 |  111 |    0 |
| Actions (AACT)              |    71 |   57 |   14 |
| Game settings (GMST)        |    20 |   20 |    0 |
| Mechanics (by hand)         |    24 |   16 |    8 |
| Total                       |  1146 | 1075 |   71 |

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
- [x] Node fields run (253 of 292): everything the state machines, transitions, clips,
      blenders, selectors and modifiers carry, but for:
- [ ] `userData` of 24 node kinds (4,950 nodes): hkbNode's user data. TODO(M13): what the
      original does with it is unknown (the formats' list has it open too).
- [x] blender.indexOfSyncMasterChild (2080): a syncing blender's master child (13 of 1,369,
      the jumps' directional and the unequip blends) leads its cycle and its sync points while
      it plays (docs/animation.md, "Syncing blenders"; round 2).
- [ ] blender.maxCyclicBlendParameter (2121), minCyclicBlendParameter (17): parsed, not run
      (a cyclic parametric blend's range).
- [ ] synchronized-clip.markErrorThreshold (540), syncPrefix (226), applyMotionFromRoot (13):
      parsed, not run (paired animations: when the support is close enough to its mark, the
      partner's clip prefix, root motion). Not reached in round 2.
- [ ] powered-ragdoll.worldFromModelMode (95): the powered ragdoll's root (world-from-model
      mode, its pose-matching bones). TODO(M13) with the formats' list.
- [ ] rigid-body-ragdoll.durationToBlend (56): how long the keyframed ragdoll blends in. Not
      reached in round 2: the keyframed bones are moved to the pose (actor-bodies #follow), not
      driven by Havok's hierarchy controller and its gains (the physics list's blend gains).
- [ ] get-up.alignWithGroundDuration, groundNormal (47): the get-up's turn to the ground.
- [ ] foot-ik-controls.alignWithGroundRotation (25), foot-ik.alignWithGroundRotation (2).
- [ ] damping.enableVectorDamping (43).
- [ ] rotate-character.degreesPerSecond, speedMultiplier (6).

## Annotations and events

- [x] Tags (127 of 135; 7,693 annotations): footsteps by their sets' tags (FootLeft 1004,
      FootRight, FootBack, FootFront, FootScuff*, FootSprint*, JumpDown, ...; src/shell/
      actor-sounds.ts), SoundPlay, NPCSoundPlay, SoundStop, SoundRelease, the response files'
      events (weaponSwing, HitFrame, PreHitFrame, ...), the graphs' own events (SyncLeft,
      SyncRight, FlightLandingEffect, the dogs' and wolves' sounds by their graph events, ...),
      paired partners' 2_ events.
- [x] SyncLeft, SyncRight and the other sync points (EVENT_FLAGS.syncPoint): they sync the
      clips of syncing blenders (round 2; by hand below).
- [ ] FrontFoot (26), BackFoot (25): no footstep set, response file or graph names them.
      TODO(M13): whether the original's code answers them.
- [ ] Spellfire (2): as above.
- [ ] FrootBack (4), FootFornt (3), FottFront (1), FoorRight (1), and 11 empty annotations:
      misspelt in the data; nothing names them. TODO(M13): confirm the original ignores them.
- [ ] SoundPlayAt.<descriptor>.<node> (20, the sawmill's saw): an object graph's sound at one
      of its nodes; object graphs do not sound their events yet.
- [x] Response handlers (97 of 97): actorresponse.txt and playercharacterresponse.txt. Two,
      StopHorseCameraHandler and RemoveCharacterControllerHandler, are no classes of the
      original: their events do nothing there and here (tests/conformance/animation/
      engine-handlers.test.ts; the sweep's NO_HANDLER_CLASS).

## Idles and actions

- [x] IDLE fields: parent 3779, behavior graph 3337, event 2982, conditions 2215, previous
      1489, flags 383 (src/ai/idle-records.ts, the idle tree's search).
- [x] Idle conditions: all 111 functions the idles use are valued.
- [ ] loopMin, loopMax (4 idles): the looping seconds. Not read.
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
      was asked by a misspelt name the sweep did not find).
- [ ] Actions never performed (14), each with what is missing:
  - ActionPathEnd (24 graphs: the canned turn into the heading arrived with): the travel's
    pathing target is not kept to its end (src/shell/actor-movers.ts #pathStart).
  - ActionSummonedStart (summonStart, 8 graphs): the summoning lives in the scripts' magic
    engine; the moment the summon appears is not handed to the stage yet.
  - ActionForceEquip (19 graphs), ActionReload (the crossbow's reloadStart), ActionDualRelease
    (StaffBashRelease), ActionBlockAnticipate (blockStart, blockAnticipateStart): combat's
    equip, crossbow, bash and block code sends their events directly. Next.
  - ActionRagdollInstant (RagdollInstant, 46 graphs), ActionResetGraph (returnToDefault, ...):
    TODO(M13): when the original performs them is not known.
  - ActionWaterwalkStart (WaterWalkStart, 1 graph: the levitating Dwemer sphere's): its
    moment is not known. TODO(M13).
  - ActionLook, ActionStopEffect, ActionShieldChange, ActionVoiceReady: no idles in any
    vanilla graph (performed, nothing would play); ActionListen: one empty idle group. TODO(M13):
    their moments.

## Game settings

- [x] All 20: head tracking (fHeadTrackSpeed*, fAIHeadTrack*), blinks (fBlink*), iLipMorphCount.
- [ ] The engine's built-in [Animation] and [HAVOK] INI settings: the ones the code reads
      (bAnimInterpEnable, fAnimInterp*, bDriveRagdollWithGraph,
      bFeedbackToGraphFromCharacterController, fBoneLODDistanceScale, fMaxTimeToMarkSec,
      fMotionFeedback*, fMountDismountTimeout) are done; the full list of keys is not in the
      data. TODO(M13): the original's list of them.

## Mechanics (by hand)

- [x] The behavior runtime: state machines, transitions and their effects, blending, syncing
      blenders, bindings, expressions (docs/animation.md, "Behavior runtime").
- [x] Sync points: a syncing blender's children play between their own sync points as its
      cycle is between its layout's (src/animation/sync-points.ts; round 2).
- [ ] Mirrored additive clips: by our own rule (docs/animation.md, "Mirrored clips").
- [x] Engine handlers: the response files' 95 of 97 (above).
- [ ] An event no node takes is not reported as not handled; bDisableInterp's setter.
- [x] Head tracking (docs/animation.md, "Head tracking"; the settings above).
- [x] Look-at, direct-at (BSLookAtModifier, BSDirectAtModifier) and limb IK.
- [ ] Foot IK: the narrow quadrupeds' (the formats' list); align with ground rotation.
- [x] Faces: expressions, phonemes, blinks, the head's morphs (src/animation/face.ts).
- [ ] Faces: the expression change rate.
- [x] Lip sync (.lip, .fuz) with the dialogue.
- [x] Paired animations: the support's mark, its side to the clip's end, death limp.
- [ ] Paired animations: events not routed per side.
- [x] Kill moves (docs/animation.md, "Killmoves").
- [x] Dismemberment and decapitation (the head's flight, the stump, persistence).
- [ ] The severed head's flight into MQ101's basket: it reaches the rim's height over the near
      wall and rolls off (docs/animation.md, "Dismemberment"). TODO(M13): where the original's
      flight starts.
- [x] Ragdolls: death, powered ragdolls, get-up, keyframed ragdolls.
- [ ] The powered ragdoll's root (world-from-model mode); the paralysed's stiff fall.
- [x] Animation objects (but the female hands' scale, the POV switch while one is held).
- [x] Ambient idles (but which idles skip the next PickNewIdle, the complex scene's wait).
- [x] Weapons and aim, casting, horses, first person.
- [ ] Graph state in saves: actors' graphs rebuilt from furniture and packages, not saved.
- [x] Clips: compression, root motion, float tracks, annotations.
- [x] Sounds of animations: footsteps, SoundPlay, NPCSoundPlay, SoundStop, SoundRelease.
