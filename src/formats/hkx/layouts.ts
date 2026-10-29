// Member layouts of the Havok 2010.2 classes Skyrim SE files hold, as a 64-bit packfile lays
// them out: each member's byte offset in its object (inherited members included) and its
// storage. Binary tagfiles name members instead of placing them; these tables let
// packfile-image.ts turn a tagfile into the packfile image the readers (behavior.ts,
// animation.ts, physics.ts) take. Offsets: the class reflection the original carries (each
// class's members with their offsets and types, docs/formats/hkx.md, "Class members"): every
// class the files hold, with the structs those embed. Only serialized members are listed:
// files never carry the runtime ones.

/** A member's storage: a number, a vector, a pointer, an inline struct or an hkArray of one. */
export type InlineType =
  | 'bool'
  | 'u8'
  | 'i8'
  | 'u16'
  | 'i16'
  | 'u32'
  | 'i32'
  | 'u64'
  | 'f32'
  /** hkVector4 or hkQuaternion. */
  | 'vec4'
  /** hkQsTransform: translation, rotation, scale. */
  | 'qs'
  /** hkMatrix3 or hkRotation: three columns of four floats. */
  | 'mat3'
  /** hkTransform (rotation columns, then translation) or hkMatrix4: sixteen floats. */
  | 'mat4'
  /** hkHalf: the high 16 bits of a float. */
  | 'half'
  /** A pointer to another object. */
  | 'ptr'
  /** hkStringPtr or char*. */
  | 'str'
  | `struct:${string}`;
export type MemberType = InlineType | `array:${InlineType}`;

/** A member's offset and storage; a fixed-size C array gives its element count. */
export type MemberLayout = readonly [offset: number, type: MemberType, count?: number];

export interface ClassLayout {
  readonly parent?: string;
  /** Bytes of an object (the element stride of a struct array). */
  readonly size: number;
  readonly members: Readonly<Record<string, MemberLayout>>;
}

export function inlineSize(type: InlineType): number {
  switch (type) {
    case 'bool':
    case 'u8':
    case 'i8':
      return 1;
    case 'u16':
    case 'i16':
    case 'half':
      return 2;
    case 'u32':
    case 'i32':
    case 'f32':
      return 4;
    case 'u64':
    case 'ptr':
    case 'str':
      return 8;
    case 'vec4':
      return 16;
    case 'qs':
    case 'mat3':
      return 48;
    case 'mat4':
      return 64;
    default:
      return HAVOK_LAYOUTS[type.slice('struct:'.length)]?.size ?? 0;
  }
}

const EVENT_PROPERTY = 'struct:hkbEventProperty';

export const HAVOK_LAYOUTS: Readonly<Record<string, ClassLayout>> = {
  // --- Bases ---------------------------------------------------------------------------------
  hkBaseObject: { size: 8, members: {} },
  hkReferencedObject: { parent: 'hkBaseObject', size: 16, members: {} },
  hkRootLevelContainer: {
    size: 16,
    members: { namedVariants: [0, 'array:struct:hkRootLevelContainerNamedVariant'] },
  },
  hkRootLevelContainerNamedVariant: {
    size: 24,
    members: { name: [0, 'str'], className: [8, 'str'], variant: [16, 'ptr'] },
  },
  hkbBindable: {
    parent: 'hkReferencedObject',
    size: 48,
    members: { variableBindingSet: [16, 'ptr'] },
  },
  hkbNode: {
    parent: 'hkbBindable',
    size: 72,
    members: { userData: [48, 'u64'], name: [56, 'str'] },
  },
  hkbGenerator: { parent: 'hkbNode', size: 72, members: {} },
  hkbModifier: { parent: 'hkbNode', size: 80, members: { enable: [72, 'bool'] } },
  hkbModifierWrapper: { parent: 'hkbModifier', size: 88, members: { modifier: [80, 'ptr'] } },
  hkbCondition: { parent: 'hkReferencedObject', size: 16, members: {} },
  hkbExpressionCondition: {
    parent: 'hkbCondition',
    size: 32,
    members: { expression: [16, 'str'] },
  },
  hkbStringCondition: {
    parent: 'hkbCondition',
    size: 24,
    members: { conditionString: [16, 'str'] },
  },
  hkbEventPayload: { parent: 'hkReferencedObject', size: 16, members: {} },
  hkbStringEventPayload: { parent: 'hkbEventPayload', size: 24, members: { data: [16, 'str'] } },
  hkbEventBase: { size: 16, members: { id: [0, 'i32'], payload: [8, 'ptr'] } },
  hkbEventProperty: { parent: 'hkbEventBase', size: 16, members: {} },
  hkbEvent: { parent: 'hkbEventBase', size: 24, members: {} },

  // --- State machines and transitions --------------------------------------------------------
  hkbStateMachine: {
    parent: 'hkbGenerator',
    size: 264,
    members: {
      eventToSendWhenStateOrTransitionChanges: [72, 'struct:hkbEvent'],
      startStateChooser: [96, 'ptr'],
      startStateId: [104, 'i32'],
      returnToPreviousStateEventId: [108, 'i32'],
      randomTransitionEventId: [112, 'i32'],
      transitionToNextHigherStateEventId: [116, 'i32'],
      transitionToNextLowerStateEventId: [120, 'i32'],
      syncVariableIndex: [124, 'i32'],
      wrapAroundStateId: [132, 'bool'],
      maxSimultaneousTransitions: [133, 'i8'],
      startStateMode: [134, 'i8'],
      selfTransitionMode: [135, 'i8'],
      states: [144, 'array:ptr'],
      wildcardTransitions: [160, 'ptr'],
    },
  },
  hkbStateMachineStateInfo: {
    parent: 'hkbBindable',
    size: 120,
    members: {
      listeners: [48, 'array:ptr'],
      enterNotifyEvents: [64, 'ptr'],
      exitNotifyEvents: [72, 'ptr'],
      transitions: [80, 'ptr'],
      generator: [88, 'ptr'],
      name: [96, 'str'],
      stateId: [104, 'i32'],
      probability: [108, 'f32'],
      enable: [112, 'bool'],
    },
  },
  hkbStateMachineTransitionInfoArray: {
    parent: 'hkReferencedObject',
    size: 32,
    members: { transitions: [16, 'array:struct:hkbStateMachineTransitionInfo'] },
  },
  hkbStateMachineTransitionInfo: {
    size: 72,
    members: {
      triggerInterval: [0, 'struct:hkbStateMachineTimeInterval'],
      initiateInterval: [16, 'struct:hkbStateMachineTimeInterval'],
      transition: [32, 'ptr'],
      condition: [40, 'ptr'],
      eventId: [48, 'i32'],
      toStateId: [52, 'i32'],
      fromNestedStateId: [56, 'i32'],
      toNestedStateId: [60, 'i32'],
      priority: [64, 'i16'],
      flags: [66, 'i16'],
    },
  },
  hkbStateMachineTimeInterval: {
    size: 16,
    members: {
      enterEventId: [0, 'i32'],
      exitEventId: [4, 'i32'],
      enterTime: [8, 'f32'],
      exitTime: [12, 'f32'],
    },
  },
  hkbStateMachineEventPropertyArray: {
    parent: 'hkReferencedObject',
    size: 32,
    members: { events: [16, `array:${EVENT_PROPERTY}`] },
  },
  hkbTransitionEffect: {
    parent: 'hkbGenerator',
    size: 80,
    members: { selfTransitionMode: [72, 'i8'], eventMode: [73, 'i8'] },
  },
  hkbBlendingTransitionEffect: {
    parent: 'hkbTransitionEffect',
    size: 144,
    members: {
      duration: [80, 'f32'],
      toGeneratorStartTimeFraction: [84, 'f32'],
      flags: [88, 'u16'],
      endMode: [90, 'i8'],
      blendCurve: [91, 'i8'],
    },
  },
  hkbGeneratorTransitionEffect: {
    parent: 'hkbTransitionEffect',
    size: 144,
    members: {
      transitionGenerator: [80, 'ptr'],
      blendInDuration: [88, 'f32'],
      blendOutDuration: [92, 'f32'],
      syncToGeneratorStartTime: [96, 'bool'],
    },
  },

  // --- Generators ----------------------------------------------------------------------------
  hkbClipGenerator: {
    parent: 'hkbGenerator',
    size: 272,
    members: {
      animationName: [72, 'str'],
      triggers: [80, 'ptr'],
      cropStartAmountLocalTime: [88, 'f32'],
      cropEndAmountLocalTime: [92, 'f32'],
      startTime: [96, 'f32'],
      playbackSpeed: [100, 'f32'],
      enforcedDuration: [104, 'f32'],
      userControlledTimeFraction: [108, 'f32'],
      animationBindingIndex: [112, 'i16'],
      mode: [114, 'i8'],
      flags: [115, 'i8'],
    },
  },
  hkbClipTriggerArray: {
    parent: 'hkReferencedObject',
    size: 32,
    members: { triggers: [16, 'array:struct:hkbClipTrigger'] },
  },
  hkbClipTrigger: {
    size: 32,
    members: {
      localTime: [0, 'f32'],
      event: [8, EVENT_PROPERTY],
      relativeToEndOfClip: [24, 'bool'],
      acyclic: [25, 'bool'],
      isAnnotation: [26, 'bool'],
    },
  },
  hkbBlenderGenerator: {
    parent: 'hkbGenerator',
    size: 160,
    members: {
      referencePoseWeightThreshold: [72, 'f32'],
      blendParameter: [76, 'f32'],
      minCyclicBlendParameter: [80, 'f32'],
      maxCyclicBlendParameter: [84, 'f32'],
      indexOfSyncMasterChild: [88, 'i16'],
      flags: [90, 'i16'],
      subtractLastChild: [92, 'bool'],
      children: [96, 'array:ptr'],
    },
  },
  hkbBlenderGeneratorChild: {
    parent: 'hkbBindable',
    size: 80,
    members: {
      generator: [48, 'ptr'],
      boneWeights: [56, 'ptr'],
      weight: [64, 'f32'],
      worldFromModelWeight: [68, 'f32'],
    },
  },
  hkbBoneWeightArray: {
    parent: 'hkbBindable',
    size: 64,
    members: { boneWeights: [48, 'array:f32'] },
  },
  hkbBoneIndexArray: {
    parent: 'hkbBindable',
    size: 64,
    members: { boneIndices: [48, 'array:i16'] },
  },
  hkbPoseMatchingGenerator: {
    parent: 'hkbBlenderGenerator',
    size: 240,
    members: {
      worldFromModelRotation: [160, 'vec4'],
      blendSpeed: [176, 'f32'],
      minSpeedToSwitch: [180, 'f32'],
      minSwitchTimeNoError: [184, 'f32'],
      minSwitchTimeFullError: [188, 'f32'],
      startPlayingEventId: [192, 'i32'],
      startMatchingEventId: [196, 'i32'],
      rootBoneIndex: [200, 'i16'],
      otherBoneIndex: [202, 'i16'],
      anotherBoneIndex: [204, 'i16'],
      pelvisIndex: [206, 'i16'],
      mode: [208, 'i8'],
    },
  },
  hkbModifierGenerator: {
    parent: 'hkbGenerator',
    size: 88,
    members: { modifier: [72, 'ptr'], generator: [80, 'ptr'] },
  },
  hkbManualSelectorGenerator: {
    parent: 'hkbGenerator',
    size: 96,
    members: {
      generators: [72, 'array:ptr'],
      selectedGeneratorIndex: [88, 'i8'],
      currentGeneratorIndex: [89, 'i8'],
    },
  },
  hkbBehaviorReferenceGenerator: {
    parent: 'hkbGenerator',
    size: 88,
    members: { behaviorName: [72, 'str'] },
  },
  BGSGamebryoSequenceGenerator: {
    parent: 'hkbGenerator',
    size: 112,
    members: { pSequence: [72, 'str'], eBlendModeFunction: [80, 'i8'], fPercent: [84, 'f32'] },
  },
  BSiStateTaggingGenerator: {
    parent: 'hkbGenerator',
    size: 96,
    members: {
      pDefaultGenerator: [80, 'ptr'],
      iStateToSetAs: [88, 'i32'],
      iPriority: [92, 'i32'],
    },
  },
  BSCyclicBlendTransitionGenerator: {
    parent: 'hkbGenerator',
    size: 176,
    members: {
      pBlenderGenerator: [80, 'ptr'],
      EventToFreezeBlendValue: [88, EVENT_PROPERTY],
      EventToCrossBlend: [104, EVENT_PROPERTY],
      fBlendParameter: [120, 'f32'],
      fTransitionDuration: [124, 'f32'],
      eBlendCurve: [128, 'i8'],
    },
  },
  BSBoneSwitchGenerator: {
    parent: 'hkbGenerator',
    size: 112,
    members: { pDefaultGenerator: [80, 'ptr'], ChildrenA: [88, 'array:ptr'] },
  },
  BSBoneSwitchGeneratorBoneData: {
    parent: 'hkbBindable',
    size: 64,
    members: { pGenerator: [48, 'ptr'], spBoneWeight: [56, 'ptr'] },
  },
  BSSynchronizedClipGenerator: {
    parent: 'hkbGenerator',
    size: 304,
    members: {
      pClipGenerator: [80, 'ptr'],
      SyncAnimPrefix: [88, 'str'],
      bSyncClipIgnoreMarkPlacement: [96, 'bool'],
      fGetToMarkTime: [100, 'f32'],
      fMarkErrorThreshold: [104, 'f32'],
      bLeadCharacter: [108, 'bool'],
      bReorientSupportChar: [109, 'bool'],
      bApplyMotionFromRoot: [110, 'bool'],
      sAnimationBindingIndex: [296, 'i16'],
    },
  },
  BSOffsetAnimationGenerator: {
    parent: 'hkbGenerator',
    size: 176,
    members: {
      pDefaultGenerator: [80, 'ptr'],
      pOffsetClipGenerator: [96, 'ptr'],
      fOffsetVariable: [104, 'f32'],
      fOffsetRangeStart: [108, 'f32'],
      fOffsetRangeEnd: [112, 'f32'],
    },
  },

  // --- Modifiers -----------------------------------------------------------------------------
  hkbModifierList: {
    parent: 'hkbModifier',
    size: 96,
    members: { modifiers: [80, 'array:ptr'] },
  },
  BSIsActiveModifier: {
    parent: 'hkbModifier',
    size: 96,
    members: {
      bIsActive0: [80, 'bool'],
      bInvertActive0: [81, 'bool'],
      bIsActive1: [82, 'bool'],
      bInvertActive1: [83, 'bool'],
      bIsActive2: [84, 'bool'],
      bInvertActive2: [85, 'bool'],
      bIsActive3: [86, 'bool'],
      bInvertActive3: [87, 'bool'],
      bIsActive4: [88, 'bool'],
      bInvertActive4: [89, 'bool'],
    },
  },
  hkbEvaluateExpressionModifier: {
    parent: 'hkbModifier',
    size: 112,
    members: { expressions: [80, 'ptr'] },
  },
  hkbExpressionDataArray: {
    parent: 'hkReferencedObject',
    size: 32,
    members: { expressionsData: [16, 'array:struct:hkbExpressionData'] },
  },
  hkbExpressionData: {
    size: 24,
    members: {
      expression: [0, 'str'],
      assignmentVariableIndex: [8, 'i32'],
      assignmentEventIndex: [12, 'i32'],
      eventMode: [16, 'i8'],
    },
  },
  hkbTimerModifier: {
    parent: 'hkbModifier',
    size: 112,
    members: { alarmTimeSeconds: [80, 'f32'], alarmEvent: [88, EVENT_PROPERTY] },
  },
  hkbEventDrivenModifier: {
    parent: 'hkbModifierWrapper',
    size: 104,
    members: {
      activateEventId: [88, 'i32'],
      deactivateEventId: [92, 'i32'],
      activeByDefault: [96, 'bool'],
    },
  },
  BSEventOnDeactivateModifier: {
    parent: 'hkbModifier',
    size: 96,
    members: { event: [80, EVENT_PROPERTY] },
  },
  BSEventOnFalseToTrueModifier: {
    parent: 'hkbModifier',
    size: 160,
    members: {
      bEnableEvent1: [80, 'bool'],
      bVariableToTest1: [81, 'bool'],
      EventToSend1: [88, EVENT_PROPERTY],
      bEnableEvent2: [104, 'bool'],
      bVariableToTest2: [105, 'bool'],
      EventToSend2: [112, EVENT_PROPERTY],
      bEnableEvent3: [128, 'bool'],
      bVariableToTest3: [129, 'bool'],
      EventToSend3: [136, EVENT_PROPERTY],
    },
  },
  BSEventEveryNEventsModifier: {
    parent: 'hkbModifier',
    size: 128,
    members: {
      eventToCheckFor: [80, EVENT_PROPERTY],
      eventToSend: [96, EVENT_PROPERTY],
      numberOfEventsBeforeSend: [112, 'i8'],
      minimumNumberOfEventsBeforeSend: [113, 'i8'],
      randomizeNumberOfEvents: [114, 'bool'],
    },
  },
  hkbDampingModifier: {
    parent: 'hkbModifier',
    size: 192,
    members: {
      kP: [80, 'f32'],
      kI: [84, 'f32'],
      kD: [88, 'f32'],
      enableScalarDamping: [92, 'bool'],
      enableVectorDamping: [93, 'bool'],
      rawValue: [96, 'f32'],
      dampedValue: [100, 'f32'],
      rawVector: [112, 'vec4'],
      dampedVector: [128, 'vec4'],
      vecErrorSum: [144, 'vec4'],
      vecPreviousError: [160, 'vec4'],
      errorSum: [176, 'f32'],
      previousError: [180, 'f32'],
    },
  },
  BSInterpValueModifier: {
    parent: 'hkbModifier',
    size: 104,
    members: { source: [80, 'f32'], target: [84, 'f32'], result: [88, 'f32'], gain: [92, 'f32'] },
  },
  BSModifyOnceModifier: {
    parent: 'hkbModifier',
    size: 112,
    members: { pOnActivateModifier: [80, 'ptr'], pOnDeactivateModifier: [96, 'ptr'] },
  },
  hkbEventsFromRangeModifier: {
    parent: 'hkbModifier',
    size: 112,
    members: { inputValue: [80, 'f32'], lowerBound: [84, 'f32'], eventRanges: [88, 'ptr'] },
  },
  hkbEventRangeDataArray: {
    parent: 'hkReferencedObject',
    size: 32,
    members: { eventData: [16, 'array:struct:hkbEventRangeData'] },
  },
  hkbEventRangeData: {
    size: 32,
    members: { upperBound: [0, 'f32'], event: [8, EVENT_PROPERTY], eventMode: [24, 'i8'] },
  },
  BSIStateManagerModifier: {
    parent: 'hkbModifier',
    size: 128,
    members: {
      iStateVar: [80, 'i32'],
      stateData: [88, 'array:struct:BSIStateManagerModifierBSiStateData'],
    },
  },
  BSIStateManagerModifierBSiStateData: {
    size: 16,
    members: { pStateMachine: [0, 'ptr'], StateID: [8, 'i32'], iStateToSetAs: [12, 'i32'] },
  },
  BSSpeedSamplerModifier: {
    parent: 'hkbModifier',
    size: 96,
    members: {
      state: [80, 'i32'],
      direction: [84, 'f32'],
      goalSpeed: [88, 'f32'],
      speedOut: [92, 'f32'],
    },
  },
  hkbRotateCharacterModifier: {
    parent: 'hkbModifier',
    size: 128,
    members: {
      degreesPerSecond: [80, 'f32'],
      speedMultiplier: [84, 'f32'],
      axisOfRotation: [96, 'vec4'],
    },
  },
  hkbTwistModifier: {
    parent: 'hkbModifier',
    size: 144,
    members: {
      axisOfRotation: [80, 'vec4'],
      twistAngle: [96, 'f32'],
      startBoneIndex: [100, 'i16'],
      endBoneIndex: [102, 'i16'],
      setAngleMethod: [104, 'i8'],
      rotationAxisCoordinates: [105, 'i8'],
      isAdditive: [106, 'bool'],
    },
  },
  hkbKeyframeBonesModifier: {
    parent: 'hkbModifier',
    size: 104,
    members: {
      keyframeInfo: [80, 'array:struct:hkbKeyframeBonesModifierKeyframeInfo'],
      keyframedBonesList: [96, 'ptr'],
    },
  },
  hkbGetUpModifier: {
    parent: 'hkbModifier',
    size: 128,
    members: {
      groundNormal: [80, 'vec4'],
      duration: [96, 'f32'],
      alignWithGroundDuration: [100, 'f32'],
      rootBoneIndex: [104, 'i16'],
      otherBoneIndex: [106, 'i16'],
      anotherBoneIndex: [108, 'i16'],
    },
  },
  BSRagdollContactListenerModifier: {
    parent: 'hkbModifier',
    size: 136,
    members: { contactEvent: [88, EVENT_PROPERTY], bones: [104, 'ptr'] },
  },
  hkbPoweredRagdollControlsModifier: {
    parent: 'hkbModifier',
    size: 144,
    members: {
      controlData: [80, 'struct:hkbPoweredRagdollControlData'],
      bones: [112, 'ptr'],
      worldFromModelModeData: [120, 'struct:hkbWorldFromModelModeData'],
      boneWeights: [128, 'ptr'],
    },
  },
  hkbPoweredRagdollControlData: {
    size: 32,
    members: {
      maxForce: [0, 'f32'],
      tau: [4, 'f32'],
      damping: [8, 'f32'],
      proportionalRecoveryVelocity: [12, 'f32'],
      constantRecoveryVelocity: [16, 'f32'],
    },
  },
  hkbWorldFromModelModeData: {
    size: 8,
    members: {
      poseMatchingBone0: [0, 'i16'],
      poseMatchingBone1: [2, 'i16'],
      poseMatchingBone2: [4, 'i16'],
      mode: [6, 'i8'],
    },
  },
  hkbRigidBodyRagdollControlsModifier: {
    parent: 'hkbModifier',
    size: 160,
    members: {
      controlData: [80, 'struct:hkbRigidBodyRagdollControlData'],
      bones: [144, 'ptr'],
    },
  },
  hkbRigidBodyRagdollControlData: {
    size: 64,
    members: {
      keyFrameHierarchyControlData: [0, 'struct:hkaKeyFrameHierarchyUtilityControlData'],
      durationToBlend: [48, 'f32'],
    },
  },
  hkaKeyFrameHierarchyUtilityControlData: {
    size: 48,
    members: {
      hierarchyGain: [0, 'f32'],
      velocityDamping: [4, 'f32'],
      accelerationGain: [8, 'f32'],
      velocityGain: [12, 'f32'],
      positionGain: [16, 'f32'],
      positionMaxLinearVelocity: [20, 'f32'],
      positionMaxAngularVelocity: [24, 'f32'],
      snapGain: [28, 'f32'],
      snapMaxLinearVelocity: [32, 'f32'],
      snapMaxAngularVelocity: [36, 'f32'],
      snapMaxLinearDistance: [40, 'f32'],
      snapMaxAngularDistance: [44, 'f32'],
    },
  },
  hkbKeyframeBonesModifierKeyframeInfo: {
    size: 48,
    members: {
      keyframedPosition: [0, 'vec4'],
      keyframedRotation: [16, 'vec4'],
      boneIndex: [32, 'i16'],
      isValid: [34, 'bool'],
    },
  },
  BSDirectAtModifier: {
    parent: 'hkbModifier',
    size: 224,
    members: {
      directAtTarget: [80, 'bool'],
      sourceBoneIndex: [82, 'i16'],
      startBoneIndex: [84, 'i16'],
      endBoneIndex: [86, 'i16'],
      limitHeadingDegrees: [88, 'f32'],
      limitPitchDegrees: [92, 'f32'],
      offsetHeadingDegrees: [96, 'f32'],
      offsetPitchDegrees: [100, 'f32'],
      onGain: [104, 'f32'],
      offGain: [108, 'f32'],
      targetLocation: [112, 'vec4'],
      userInfo: [128, 'u32'],
      directAtCamera: [132, 'bool'],
      directAtCameraX: [136, 'f32'],
      directAtCameraY: [140, 'f32'],
      directAtCameraZ: [144, 'f32'],
      active: [148, 'bool'],
      currentHeadingOffset: [152, 'f32'],
      currentPitchOffset: [156, 'f32'],
    },
  },
  BSLookAtModifier: {
    parent: 'hkbModifier',
    size: 224,
    members: {
      lookAtTarget: [80, 'bool'],
      bones: [88, 'array:struct:BSLookAtModifierBoneData'],
      eyeBones: [104, 'array:struct:BSLookAtModifierBoneData'],
      limitAngleDegrees: [120, 'f32'],
      limitAngleThresholdDegrees: [124, 'f32'],
      continueLookOutsideOfLimit: [128, 'bool'],
      onGain: [132, 'f32'],
      offGain: [136, 'f32'],
      useBoneGains: [140, 'bool'],
      targetLocation: [144, 'vec4'],
      targetOutsideLimits: [160, 'bool'],
      targetOutOfLimitEvent: [168, EVENT_PROPERTY],
      lookAtCamera: [184, 'bool'],
      lookAtCameraX: [188, 'f32'],
      lookAtCameraY: [192, 'f32'],
      lookAtCameraZ: [196, 'f32'],
    },
  },
  BSLookAtModifierBoneData: {
    size: 64,
    members: {
      index: [0, 'i16'],
      fwdAxisLS: [16, 'vec4'],
      limitAngleDegrees: [32, 'f32'],
      onGain: [36, 'f32'],
      offGain: [40, 'f32'],
      enabled: [44, 'bool'],
    },
  },
  hkbFootIkControlsModifier: {
    parent: 'hkbModifier',
    size: 176,
    members: {
      controlData: [80, 'struct:hkbFootIkControlData'],
      legs: [128, 'array:struct:hkbFootIkControlsModifierLeg'],
      errorOutTranslation: [144, 'vec4'],
      alignWithGroundRotation: [160, 'vec4'],
    },
  },
  hkbFootIkControlData: { size: 48, members: { gains: [0, 'struct:hkbFootIkGains'] } },
  hkbFootIkGains: {
    size: 48,
    members: {
      onOffGain: [0, 'f32'],
      groundAscendingGain: [4, 'f32'],
      groundDescendingGain: [8, 'f32'],
      footPlantedGain: [12, 'f32'],
      footRaisedGain: [16, 'f32'],
      footUnlockGain: [20, 'f32'],
      worldFromModelFeedbackGain: [24, 'f32'],
      errorUpDownBias: [28, 'f32'],
      alignWorldFromModelGain: [32, 'f32'],
      hipOrientationGain: [36, 'f32'],
      maxKneeAngleDifference: [40, 'f32'],
      ankleOrientationGain: [44, 'f32'],
    },
  },
  hkbFootIkControlsModifierLeg: {
    size: 48,
    members: {
      groundPosition: [0, 'vec4'],
      ungroundedEvent: [16, EVENT_PROPERTY],
      verticalError: [32, 'f32'],
      hitSomething: [36, 'bool'],
      isPlantedMS: [37, 'bool'],
    },
  },
  // Checked against the dragon's FootIKModifier (4 legs: hip, knee and ankle bones 41, 45, 47).
  hkbFootIkModifier: {
    parent: 'hkbModifier',
    size: 256,
    members: {
      gains: [80, 'struct:hkbFootIkGains'],
      legs: [128, 'array:struct:hkbFootIkModifierLeg'],
      raycastDistanceUp: [144, 'f32'],
      raycastDistanceDown: [148, 'f32'],
      originalGroundHeightMS: [152, 'f32'],
      errorOut: [156, 'f32'],
      errorOutTranslation: [160, 'vec4'],
      alignWithGroundRotation: [176, 'vec4'],
      verticalOffset: [192, 'f32'],
      collisionFilterInfo: [196, 'u32'],
      forwardAlignFraction: [200, 'f32'],
      sidewaysAlignFraction: [204, 'f32'],
      sidewaysSampleWidth: [208, 'f32'],
      useTrackData: [212, 'bool'],
      lockFeetWhenPlanted: [213, 'bool'],
      useCharacterUpVector: [214, 'bool'],
      alignMode: [215, 'i8'],
    },
  },
  hkbFootIkModifierLeg: {
    size: 160,
    members: {
      originalAnkleTransformMS: [0, 'qs'],
      kneeAxisLS: [64, 'vec4'],
      footEndLS: [80, 'vec4'],
      ungroundedEvent: [96, EVENT_PROPERTY],
      footPlantedAnkleHeightMS: [112, 'f32'],
      footRaisedAnkleHeightMS: [116, 'f32'],
      maxAnkleHeightMS: [120, 'f32'],
      minAnkleHeightMS: [124, 'f32'],
      maxKneeAngleDegrees: [128, 'f32'],
      minKneeAngleDegrees: [132, 'f32'],
      verticalError: [136, 'f32'],
      maxAnkleAngleDegrees: [140, 'f32'],
      hipIndex: [144, 'i16'],
      kneeIndex: [146, 'i16'],
      ankleIndex: [148, 'i16'],
      hitSomething: [150, 'bool'],
      isPlantedMS: [151, 'bool'],
      isOriginalAnkleTransformMSSet: [152, 'bool'],
    },
  },
  // The character's foot IK (hkbCharacterData.footIkDriverInfo); checked against DefaultMale's
  // (hip, knee and ankle bones 9, 10, 11 and 6, 7, 8).
  hkbFootIkDriverInfo: {
    parent: 'hkReferencedObject',
    size: 72,
    members: {
      legs: [16, 'array:struct:hkbFootIkDriverInfoLeg'],
      raycastDistanceUp: [32, 'f32'],
      raycastDistanceDown: [36, 'f32'],
      originalGroundHeightMS: [40, 'f32'],
      verticalOffset: [44, 'f32'],
      collisionFilterInfo: [48, 'u32'],
      forwardAlignFraction: [52, 'f32'],
      sidewaysAlignFraction: [56, 'f32'],
      sidewaysSampleWidth: [60, 'f32'],
      lockFeetWhenPlanted: [64, 'bool'],
      useCharacterUpVector: [65, 'bool'],
      isQuadrupedNarrow: [66, 'bool'],
    },
  },
  hkbFootIkDriverInfoLeg: {
    size: 96,
    members: {
      kneeAxisLS: [16, 'vec4'],
      footEndLS: [32, 'vec4'],
      footPlantedAnkleHeightMS: [48, 'f32'],
      footRaisedAnkleHeightMS: [52, 'f32'],
      maxAnkleHeightMS: [56, 'f32'],
      minAnkleHeightMS: [60, 'f32'],
      maxKneeAngleDegrees: [64, 'f32'],
      minKneeAngleDegrees: [68, 'f32'],
      maxAnkleAngleDegrees: [72, 'f32'],
      hipIndex: [76, 'i16'],
      kneeIndex: [78, 'i16'],
      ankleIndex: [80, 'i16'],
    },
  },

  // --- Graphs, characters and projects -------------------------------------------------------
  hkbBehaviorGraph: {
    parent: 'hkbGenerator',
    size: 304,
    members: { variableMode: [72, 'i8'], rootGenerator: [128, 'ptr'], data: [136, 'ptr'] },
  },
  hkbBehaviorGraphData: {
    parent: 'hkReferencedObject',
    size: 128,
    members: {
      attributeDefaults: [16, 'array:f32'],
      variableInfos: [32, 'array:struct:hkbVariableInfo'],
      characterPropertyInfos: [48, 'array:struct:hkbVariableInfo'],
      eventInfos: [64, 'array:struct:hkbEventInfo'],
      wordMinVariableValues: [80, 'array:struct:hkbVariableValue'],
      wordMaxVariableValues: [96, 'array:struct:hkbVariableValue'],
      variableInitialValues: [112, 'ptr'],
      stringData: [120, 'ptr'],
    },
  },
  hkbBehaviorGraphStringData: {
    parent: 'hkReferencedObject',
    size: 80,
    members: {
      eventNames: [16, 'array:str'],
      attributeNames: [32, 'array:str'],
      variableNames: [48, 'array:str'],
      characterPropertyNames: [64, 'array:str'],
    },
  },
  hkbVariableValueSet: {
    parent: 'hkReferencedObject',
    size: 64,
    members: {
      wordVariableValues: [16, 'array:struct:hkbVariableValue'],
      quadVariableValues: [32, 'array:vec4'],
      variantVariableValues: [48, 'array:ptr'],
    },
  },
  hkbVariableValue: { size: 4, members: { value: [0, 'i32'] } },
  hkbVariableInfo: {
    size: 6,
    members: { role: [0, 'struct:hkbRoleAttribute'], type: [4, 'i8'] },
  },
  hkbRoleAttribute: { size: 4, members: { role: [0, 'i16'], flags: [2, 'i16'] } },
  hkbEventInfo: { size: 4, members: { flags: [0, 'u32'] } },
  hkbVariableBindingSet: {
    parent: 'hkReferencedObject',
    size: 40,
    members: {
      bindings: [16, 'array:struct:hkbVariableBindingSetBinding'],
      indexOfBindingToEnable: [32, 'i32'],
    },
  },
  hkbVariableBindingSetBinding: {
    size: 40,
    members: {
      memberPath: [0, 'str'],
      variableIndex: [28, 'i32'],
      bitIndex: [32, 'i8'],
      bindingType: [33, 'i8'],
    },
  },
  hkbCharacterData: {
    parent: 'hkReferencedObject',
    size: 176,
    members: {
      characterControllerInfo: [16, 'struct:hkbCharacterDataCharacterControllerInfo'],
      modelUpMS: [48, 'vec4'],
      modelForwardMS: [64, 'vec4'],
      modelRightMS: [80, 'vec4'],
      characterPropertyInfos: [96, 'array:struct:hkbVariableInfo'],
      numBonesPerLod: [112, 'array:i32'],
      characterPropertyValues: [128, 'ptr'],
      footIkDriverInfo: [136, 'ptr'],
      handIkDriverInfo: [144, 'ptr'],
      stringData: [152, 'ptr'],
      mirroredSkeletonInfo: [160, 'ptr'],
      scale: [168, 'f32'],
    },
  },
  hkbCharacterDataCharacterControllerInfo: {
    size: 24,
    members: {
      capsuleHeight: [0, 'f32'],
      capsuleRadius: [4, 'f32'],
      collisionFilterInfo: [8, 'u32'],
      characterControllerCinfo: [16, 'ptr'],
    },
  },
  hkbCharacterStringData: {
    parent: 'hkReferencedObject',
    size: 192,
    members: {
      deformableSkinNames: [16, 'array:str'],
      rigidSkinNames: [32, 'array:str'],
      animationNames: [48, 'array:str'],
      animationFilenames: [64, 'array:str'],
      characterPropertyNames: [80, 'array:str'],
      retargetingSkeletonMapperFilenames: [96, 'array:str'],
      lodNames: [112, 'array:str'],
      mirroredSyncPointSubstringsA: [128, 'array:str'],
      mirroredSyncPointSubstringsB: [144, 'array:str'],
      name: [160, 'str'],
      rigName: [168, 'str'],
      ragdollName: [176, 'str'],
      behaviorFilename: [184, 'str'],
    },
  },
  hkbMirroredSkeletonInfo: {
    parent: 'hkReferencedObject',
    size: 48,
    members: { mirrorAxis: [16, 'vec4'], bonePairMap: [32, 'array:i16'] },
  },
  hkbProjectData: {
    parent: 'hkReferencedObject',
    size: 48,
    members: { worldUpWS: [16, 'vec4'], stringData: [32, 'ptr'], defaultEventMode: [40, 'i8'] },
  },
  hkbProjectStringData: {
    parent: 'hkReferencedObject',
    size: 120,
    members: {
      animationFilenames: [16, 'array:str'],
      behaviorFilenames: [32, 'array:str'],
      characterFilenames: [48, 'array:str'],
      eventNames: [64, 'array:str'],
      animationPath: [80, 'str'],
      behaviorPath: [88, 'str'],
      characterPath: [96, 'str'],
      fullPathToSource: [104, 'str'],
    },
  },

  // --- Animation -----------------------------------------------------------------------------
  hkaAnimationContainer: {
    parent: 'hkReferencedObject',
    size: 96,
    members: {
      skeletons: [16, 'array:ptr'],
      animations: [32, 'array:ptr'],
      bindings: [48, 'array:ptr'],
      attachments: [64, 'array:ptr'],
      skins: [80, 'array:ptr'],
    },
  },
  hkaSkeleton: {
    parent: 'hkReferencedObject',
    size: 120,
    members: {
      name: [16, 'str'],
      parentIndices: [24, 'array:i16'],
      bones: [40, 'array:struct:hkaBone'],
      referencePose: [56, 'array:qs'],
      referenceFloats: [72, 'array:f32'],
      floatSlots: [88, 'array:str'],
      localFrames: [104, 'array:struct:hkaSkeletonLocalFrameOnBone'],
    },
  },
  hkaBone: { size: 16, members: { name: [0, 'str'], lockTranslation: [8, 'bool'] } },
  hkaSkeletonMapper: {
    parent: 'hkReferencedObject',
    size: 144,
    members: { mapping: [16, 'struct:hkaSkeletonMapperData'] },
  },
  hkaSkeletonMapperData: {
    size: 128,
    members: {
      skeletonA: [0, 'ptr'],
      skeletonB: [8, 'ptr'],
      simpleMappings: [16, 'array:struct:hkaSkeletonMapperDataSimpleMapping'],
      chainMappings: [32, 'array:struct:hkaSkeletonMapperDataChainMapping'],
      unmappedBones: [48, 'array:i16'],
      extractedMotionMapping: [64, 'qs'],
      keepUnmappedLocal: [112, 'bool'],
      mappingType: [116, 'i32'],
    },
  },
  hkaSkeletonMapperDataSimpleMapping: {
    size: 64,
    members: { boneA: [0, 'i16'], boneB: [2, 'i16'], aFromBTransform: [16, 'qs'] },
  },
  hkaSkeletonLocalFrameOnBone: {
    size: 16,
    members: { localFrame: [0, 'ptr'], boneIndex: [8, 'i32'] },
  },
  hkaAnimation: {
    parent: 'hkReferencedObject',
    size: 56,
    members: {
      type: [16, 'i32'],
      duration: [20, 'f32'],
      numberOfTransformTracks: [24, 'i32'],
      numberOfFloatTracks: [28, 'i32'],
      extractedMotion: [32, 'ptr'],
      annotationTracks: [40, 'array:struct:hkaAnnotationTrack'],
    },
  },
  hkaSplineCompressedAnimation: {
    parent: 'hkaAnimation',
    size: 176,
    members: {
      numFrames: [56, 'i32'],
      numBlocks: [60, 'i32'],
      maxFramesPerBlock: [64, 'i32'],
      maskAndQuantizationSize: [68, 'i32'],
      blockDuration: [72, 'f32'],
      blockInverseDuration: [76, 'f32'],
      frameDuration: [80, 'f32'],
      blockOffsets: [88, 'array:u32'],
      floatBlockOffsets: [104, 'array:u32'],
      transformOffsets: [120, 'array:u32'],
      floatOffsets: [136, 'array:u32'],
      data: [152, 'array:u8'],
      endian: [168, 'i32'],
    },
  },
  hkaInterleavedUncompressedAnimation: {
    parent: 'hkaAnimation',
    size: 88,
    members: { transforms: [56, 'array:qs'], floats: [72, 'array:f32'] },
  },
  hkaAnnotationTrack: {
    size: 24,
    members: {
      trackName: [0, 'str'],
      annotations: [8, 'array:struct:hkaAnnotationTrackAnnotation'],
    },
  },
  hkaAnnotationTrackAnnotation: { size: 16, members: { time: [0, 'f32'], text: [8, 'str'] } },
  hkaAnimationBinding: {
    parent: 'hkReferencedObject',
    size: 72,
    members: {
      originalSkeletonName: [16, 'str'],
      animation: [24, 'ptr'],
      transformTrackToBoneIndices: [32, 'array:i16'],
      floatTrackToFloatSlotIndices: [48, 'array:i16'],
      blendHint: [64, 'i8'],
    },
  },
  hkaAnimatedReferenceFrame: { parent: 'hkReferencedObject', size: 16, members: {} },
  hkaDefaultAnimatedReferenceFrame: {
    parent: 'hkaAnimatedReferenceFrame',
    size: 80,
    members: {
      up: [16, 'vec4'],
      forward: [32, 'vec4'],
      duration: [48, 'f32'],
      referenceFrameSamples: [56, 'array:vec4'],
    },
  },

  // --- Physics, resources and the rest the files hold -----------------------------------------
  hkMemoryResourceContainer: {
    parent: 'hkResourceContainer',
    size: 64,
    members: {
      name: [16, 'str'],
      resourceHandles: [32, 'array:ptr'],
      children: [48, 'array:ptr'],
    },
  },
  hkResourceContainer: {
    parent: 'hkResourceBase',
    size: 16,
    members: {},
  },
  hkResourceBase: {
    parent: 'hkReferencedObject',
    size: 16,
    members: {},
  },
  hkpRigidBody: {
    parent: 'hkpEntity',
    size: 720,
    members: {},
  },
  hkpEntity: {
    parent: 'hkpWorldObject',
    size: 720,
    members: {
      material: [208, 'struct:hkpMaterial'],
      damageMultiplier: [232, 'f32'],
      storageIndex: [252, 'u16'],
      contactPointCallbackDelay: [254, 'u16'],
      autoRemoveLevel: [312, 'i8'],
      numShapeKeysInContactPointProperties: [313, 'u8'],
      responseModifierFlags: [314, 'u8'],
      uid: [316, 'u32'],
      spuCollisionCallback: [320, 'struct:hkpEntitySpuCollisionCallback'],
      motion: [336, 'struct:hkpMaxSizeMotion'],
      localFrame: [688, 'ptr'],
      npData: [704, 'u32'],
    },
  },
  hkpWorldObject: {
    parent: 'hkReferencedObject',
    size: 208,
    members: {
      userData: [24, 'u64'],
      collidable: [32, 'struct:hkpLinkedCollidable'],
      multiThreadCheck: [160, 'struct:hkMultiThreadCheck'],
      name: [176, 'str'],
      properties: [184, 'array:struct:hkpProperty'],
    },
  },
  hkpLinkedCollidable: {
    parent: 'hkpCollidable',
    size: 128,
    members: {},
  },
  hkpCollidable: {
    parent: 'hkpCdBody',
    size: 112,
    members: {
      forceCollideOntoPpu: [33, 'u8'],
      broadPhaseHandle: [36, 'struct:hkpTypedBroadPhaseHandle'],
      allowedPenetrationDepth: [104, 'f32'],
    },
  },
  hkpCdBody: {
    size: 32,
    members: {
      shape: [0, 'ptr'],
      shapeKey: [8, 'u32'],
    },
  },
  hkpTypedBroadPhaseHandle: {
    parent: 'hkpBroadPhaseHandle',
    size: 12,
    members: {
      type: [4, 'i8'],
      objectQualityType: [6, 'i8'],
      collisionFilterInfo: [8, 'u32'],
    },
  },
  hkpBroadPhaseHandle: {
    size: 4,
    members: {},
  },
  hkMultiThreadCheck: {
    size: 12,
    members: {},
  },
  hkpProperty: {
    size: 16,
    members: {
      key: [0, 'u32'],
      alignmentPadding: [4, 'u32'],
      value: [8, 'struct:hkpPropertyValue'],
    },
  },
  hkpPropertyValue: {
    size: 8,
    members: {
      data: [0, 'u64'],
    },
  },
  hkpMaterial: {
    size: 12,
    members: {
      responseType: [0, 'i8'],
      rollingFrictionMultiplier: [2, 'half'],
      friction: [4, 'f32'],
      restitution: [8, 'f32'],
    },
  },
  hkpEntitySpuCollisionCallback: {
    size: 16,
    members: {
      eventFilter: [10, 'u8'],
      userFilter: [11, 'u8'],
    },
  },
  hkpMaxSizeMotion: {
    parent: 'hkpKeyframedRigidMotion',
    size: 320,
    members: {},
  },
  hkpKeyframedRigidMotion: {
    parent: 'hkpMotion',
    size: 320,
    members: {},
  },
  hkpMotion: {
    parent: 'hkReferencedObject',
    size: 320,
    members: {
      type: [16, 'u8'],
      deactivationIntegrateCounter: [17, 'u8'],
      deactivationNumInactiveFrames: [18, 'u16', 2],
      motionState: [32, 'struct:hkMotionState'],
      inertiaAndMassInv: [208, 'vec4'],
      linearVelocity: [224, 'vec4'],
      angularVelocity: [240, 'vec4'],
      deactivationRefPosition: [256, 'vec4', 2],
      deactivationRefOrientation: [288, 'u32', 2],
      savedMotion: [296, 'ptr'],
      savedQualityTypeIndex: [304, 'u16'],
      gravityFactor: [306, 'half'],
    },
  },
  hkMotionState: {
    size: 176,
    members: {
      transform: [0, 'mat4'],
      sweptTransform: [64, 'struct:hkSweptTransform'],
      deltaAngle: [144, 'vec4'],
      objectRadius: [160, 'f32'],
      linearDamping: [164, 'half'],
      angularDamping: [166, 'half'],
      timeFactor: [168, 'half'],
      maxLinearVelocity: [170, 'u8'],
      maxAngularVelocity: [171, 'u8'],
      deactivationClass: [172, 'u8'],
    },
  },
  hkSweptTransform: {
    size: 80,
    members: {
      centerOfMass0: [0, 'vec4'],
      centerOfMass1: [16, 'vec4'],
      rotation0: [32, 'vec4'],
      rotation1: [48, 'vec4'],
      centerOfMassLocal: [64, 'vec4'],
    },
  },
  hkpPhysicsData: {
    parent: 'hkReferencedObject',
    size: 40,
    members: {
      worldCinfo: [16, 'ptr'],
      systems: [24, 'array:ptr'],
    },
  },
  hkpPhysicsSystem: {
    parent: 'hkReferencedObject',
    size: 104,
    members: {
      rigidBodies: [16, 'array:ptr'],
      constraints: [32, 'array:ptr'],
      actions: [48, 'array:ptr'],
      phantoms: [64, 'array:ptr'],
      name: [80, 'str'],
      userData: [88, 'u64'],
      active: [96, 'bool'],
    },
  },
  hkpConstraintInstance: {
    parent: 'hkReferencedObject',
    size: 112,
    members: {
      data: [24, 'ptr'],
      constraintModifiers: [32, 'ptr'],
      entities: [40, 'ptr', 2],
      priority: [56, 'u8'],
      wantRuntime: [57, 'bool'],
      destructionRemapInfo: [58, 'u8'],
      name: [80, 'str'],
      userData: [88, 'u64'],
    },
  },
  hkpRagdollConstraintData: {
    parent: 'hkpConstraintData',
    size: 384,
    members: {
      atoms: [32, 'struct:hkpRagdollConstraintDataAtoms'],
    },
  },
  hkpConstraintData: {
    parent: 'hkReferencedObject',
    size: 24,
    members: {
      userData: [16, 'u64'],
    },
  },
  hkpRagdollConstraintDataAtoms: {
    size: 352,
    members: {
      transforms: [0, 'struct:hkpSetLocalTransformsConstraintAtom'],
      setupStabilization: [144, 'struct:hkpSetupStabilizationAtom'],
      ragdollMotors: [160, 'struct:hkpRagdollMotorConstraintAtom'],
      angFriction: [256, 'struct:hkpAngFrictionConstraintAtom'],
      twistLimit: [268, 'struct:hkpTwistLimitConstraintAtom'],
      coneLimit: [288, 'struct:hkpConeLimitConstraintAtom'],
      planesLimit: [308, 'struct:hkpConeLimitConstraintAtom'],
      ballSocket: [328, 'struct:hkpBallSocketConstraintAtom'],
    },
  },
  hkpSetLocalTransformsConstraintAtom: {
    parent: 'hkpConstraintAtom',
    size: 144,
    members: {
      transformA: [16, 'mat4'],
      transformB: [80, 'mat4'],
    },
  },
  hkpConstraintAtom: {
    size: 2,
    members: {
      type: [0, 'u16'],
    },
  },
  hkpSetupStabilizationAtom: {
    parent: 'hkpConstraintAtom',
    size: 16,
    members: {
      enabled: [2, 'bool'],
      maxAngle: [4, 'f32'],
      padding: [8, 'u8', 8],
    },
  },
  hkpRagdollMotorConstraintAtom: {
    parent: 'hkpConstraintAtom',
    size: 96,
    members: {
      isEnabled: [2, 'bool'],
      initializedOffset: [4, 'i16'],
      previousTargetAnglesOffset: [6, 'i16'],
      target_bRca: [16, 'mat3'],
      motors: [64, 'ptr', 3],
    },
  },
  hkpAngFrictionConstraintAtom: {
    parent: 'hkpConstraintAtom',
    size: 12,
    members: {
      isEnabled: [2, 'u8'],
      firstFrictionAxis: [3, 'u8'],
      numFrictionAxes: [4, 'u8'],
      maxFrictionTorque: [8, 'f32'],
    },
  },
  hkpTwistLimitConstraintAtom: {
    parent: 'hkpConstraintAtom',
    size: 20,
    members: {
      isEnabled: [2, 'u8'],
      twistAxis: [3, 'u8'],
      refAxis: [4, 'u8'],
      minAngle: [8, 'f32'],
      maxAngle: [12, 'f32'],
      angularLimitsTauFactor: [16, 'f32'],
    },
  },
  hkpConeLimitConstraintAtom: {
    parent: 'hkpConstraintAtom',
    size: 20,
    members: {
      isEnabled: [2, 'u8'],
      twistAxisInA: [3, 'u8'],
      refAxisInB: [4, 'u8'],
      angleMeasurementMode: [5, 'u8'],
      memOffsetToAngleOffset: [6, 'u8'],
      minAngle: [8, 'f32'],
      maxAngle: [12, 'f32'],
      angularLimitsTauFactor: [16, 'f32'],
    },
  },
  hkpBallSocketConstraintAtom: {
    parent: 'hkpConstraintAtom',
    size: 16,
    members: {
      solvingMethod: [2, 'u8'],
      bodiesToNotify: [3, 'u8'],
      velocityStabilizationFactor: [4, 'u8'],
      maxImpulse: [8, 'f32'],
      inertiaStabilizationFactor: [12, 'f32'],
    },
  },
  hkaRagdollInstance: {
    parent: 'hkReferencedObject',
    size: 72,
    members: {
      rigidBodies: [16, 'array:ptr'],
      constraints: [32, 'array:ptr'],
      boneToRigidBodyMap: [48, 'array:i32'],
      skeleton: [64, 'ptr'],
    },
  },
  hkpPositionConstraintMotor: {
    parent: 'hkpLimitedForceConstraintMotor',
    size: 48,
    members: {
      tau: [32, 'f32'],
      damping: [36, 'f32'],
      proportionalRecoveryVelocity: [40, 'f32'],
      constantRecoveryVelocity: [44, 'f32'],
    },
  },
  hkpLimitedForceConstraintMotor: {
    parent: 'hkpConstraintMotor',
    size: 32,
    members: {
      minForce: [24, 'f32'],
      maxForce: [28, 'f32'],
    },
  },
  hkpConstraintMotor: {
    parent: 'hkReferencedObject',
    size: 24,
    members: {
      type: [16, 'i8'],
    },
  },
  hkaSkeletonMapperDataChainMapping: {
    size: 112,
    members: {
      startBoneA: [0, 'i16'],
      endBoneA: [2, 'i16'],
      startBoneB: [4, 'i16'],
      endBoneB: [6, 'i16'],
      startAFromBTransform: [16, 'qs'],
      endAFromBTransform: [64, 'qs'],
    },
  },
  hkMemoryResourceHandle: {
    parent: 'hkResourceHandle',
    size: 48,
    members: {
      variant: [16, 'ptr'],
      name: [24, 'str'],
      references: [32, 'array:struct:hkMemoryResourceHandleExternalLink'],
    },
  },
  hkResourceHandle: {
    parent: 'hkResourceBase',
    size: 16,
    members: {},
  },
  hkMemoryResourceHandleExternalLink: {
    size: 16,
    members: {
      memberName: [0, 'str'],
      externalId: [8, 'str'],
    },
  },
  hkpCapsuleShape: {
    parent: 'hkpConvexShape',
    size: 80,
    members: {
      vertexA: [48, 'vec4'],
      vertexB: [64, 'vec4'],
    },
  },
  hkpConvexShape: {
    parent: 'hkpSphereRepShape',
    size: 40,
    members: {
      radius: [32, 'f32'],
    },
  },
  hkpSphereRepShape: {
    parent: 'hkpShape',
    size: 32,
    members: {},
  },
  hkpShape: {
    parent: 'hkReferencedObject',
    size: 32,
    members: {
      userData: [16, 'u64'],
    },
  },
  hkpShapeInfo: {
    parent: 'hkReferencedObject',
    size: 128,
    members: {
      shape: [16, 'ptr'],
      isHierarchicalCompound: [24, 'bool'],
      hkdShapesCollected: [25, 'bool'],
      childShapeNames: [32, 'array:str'],
      childTransforms: [48, 'array:mat4'],
      transform: [64, 'mat4'],
    },
  },
  hkpLimitedHingeConstraintData: {
    parent: 'hkpConstraintData',
    size: 272,
    members: {
      atoms: [32, 'struct:hkpLimitedHingeConstraintDataAtoms'],
    },
  },
  hkpLimitedHingeConstraintDataAtoms: {
    size: 240,
    members: {
      transforms: [0, 'struct:hkpSetLocalTransformsConstraintAtom'],
      setupStabilization: [144, 'struct:hkpSetupStabilizationAtom'],
      angMotor: [160, 'struct:hkpAngMotorConstraintAtom'],
      angFriction: [184, 'struct:hkpAngFrictionConstraintAtom'],
      angLimit: [196, 'struct:hkpAngLimitConstraintAtom'],
      '2dAng': [212, 'struct:hkp2dAngConstraintAtom'],
      ballSocket: [216, 'struct:hkpBallSocketConstraintAtom'],
    },
  },
  hkpAngMotorConstraintAtom: {
    parent: 'hkpConstraintAtom',
    size: 24,
    members: {
      isEnabled: [2, 'bool'],
      motorAxis: [3, 'u8'],
      initializedOffset: [4, 'i16'],
      previousTargetAngleOffset: [6, 'i16'],
      correspondingAngLimitSolverResultOffset: [8, 'i16'],
      targetAngle: [12, 'f32'],
      motor: [16, 'ptr'],
    },
  },
  hkpAngLimitConstraintAtom: {
    parent: 'hkpConstraintAtom',
    size: 16,
    members: {
      isEnabled: [2, 'u8'],
      limitAxis: [3, 'u8'],
      minAngle: [4, 'f32'],
      maxAngle: [8, 'f32'],
      angularLimitsTauFactor: [12, 'f32'],
    },
  },
  hkp2dAngConstraintAtom: {
    parent: 'hkpConstraintAtom',
    size: 4,
    members: {
      freeRotationAxis: [2, 'u8'],
    },
  },
  hkpConvexTranslateShape: {
    parent: 'hkpConvexTransformShapeBase',
    size: 80,
    members: {
      translation: [64, 'vec4'],
    },
  },
  hkpConvexTransformShapeBase: {
    parent: 'hkpConvexShape',
    size: 64,
    members: {
      childShape: [40, 'struct:hkpSingleShapeContainer'],
    },
  },
  hkpSingleShapeContainer: {
    parent: 'hkpShapeContainer',
    size: 16,
    members: {
      childShape: [8, 'ptr'],
    },
  },
  hkpShapeContainer: {
    size: 8,
    members: {},
  },
  hkpBoxShape: {
    parent: 'hkpConvexShape',
    size: 64,
    members: {
      halfExtents: [48, 'vec4'],
    },
  },
  hkpConvexVerticesShape: {
    parent: 'hkpConvexShape',
    size: 144,
    members: {
      aabbHalfExtents: [48, 'vec4'],
      aabbCenter: [64, 'vec4'],
      rotatedVertices: [80, 'array:struct:hkpConvexVerticesShapeFourVectors'],
      numVertices: [96, 'i32'],
      planeEquations: [120, 'array:vec4'],
      connectivity: [136, 'ptr'],
    },
  },
  hkpConvexVerticesShapeFourVectors: {
    size: 48,
    members: {
      x: [0, 'vec4'],
      y: [16, 'vec4'],
      z: [32, 'vec4'],
    },
  },
  hkpConvexVerticesConnectivity: {
    parent: 'hkReferencedObject',
    size: 48,
    members: {
      vertexIndices: [16, 'array:u16'],
      numVerticesPerFace: [32, 'array:u8'],
    },
  },
  hkbReferencePoseGenerator: {
    parent: 'hkbGenerator',
    size: 80,
    members: {},
  },
  hkpListShape: {
    parent: 'hkpShapeCollection',
    size: 144,
    members: {
      childInfo: [48, 'array:struct:hkpListShapeChildInfo'],
      flags: [64, 'u16'],
      numDisabledChildren: [66, 'u16'],
      aabbHalfExtents: [80, 'vec4'],
      aabbCenter: [96, 'vec4'],
      enabledChildren: [112, 'u32', 8],
    },
  },
  hkpShapeCollection: {
    parent: 'hkpShape',
    size: 48,
    members: {
      disableWelding: [40, 'bool'],
      collectionType: [41, 'u8'],
    },
  },
  hkpListShapeChildInfo: {
    size: 32,
    members: {
      shape: [0, 'ptr'],
      collisionFilterInfo: [8, 'u32'],
    },
  },
  hkpMoppBvTreeShape: {
    parent: 'hkMoppBvTreeShapeBase',
    size: 112,
    members: {
      child: [80, 'struct:hkpSingleShapeContainer'],
    },
  },
  hkMoppBvTreeShapeBase: {
    parent: 'hkpBvTreeShape',
    size: 80,
    members: {
      code: [40, 'ptr'],
    },
  },
  hkpBvTreeShape: {
    parent: 'hkpShape',
    size: 40,
    members: {
      bvTreeType: [32, 'u8'],
    },
  },
  hkpMoppCode: {
    parent: 'hkReferencedObject',
    size: 64,
    members: {
      info: [16, 'struct:hkpMoppCodeCodeInfo'],
      data: [32, 'array:u8'],
      buildType: [48, 'i8'],
    },
  },
  hkpMoppCodeCodeInfo: {
    size: 16,
    members: {
      offset: [0, 'vec4'],
    },
  },
  hkpConvexTransformShape: {
    parent: 'hkpConvexTransformShapeBase',
    size: 128,
    members: {
      transform: [64, 'mat4'],
    },
  },
  BSGetTimeStepModifier: {
    parent: 'hkbModifier',
    size: 88,
    members: {
      timeStep: [80, 'f32'],
    },
  },
  BSPassByTargetTriggerModifier: {
    parent: 'hkbModifier',
    size: 160,
    members: {
      targetPosition: [80, 'vec4'],
      radius: [96, 'f32'],
      movementDirection: [112, 'vec4'],
      triggerEvent: [128, 'struct:hkbEventProperty'],
    },
  },
  BSDecomposeVectorModifier: {
    parent: 'hkbModifier',
    size: 112,
    members: {
      vector: [80, 'vec4'],
      x: [96, 'f32'],
      y: [100, 'f32'],
      z: [104, 'f32'],
      w: [108, 'f32'],
    },
  },
  BSTimerModifier: {
    parent: 'hkbModifier',
    size: 112,
    members: {
      alarmTimeSeconds: [80, 'f32'],
      alarmEvent: [88, 'struct:hkbEventProperty'],
      resetAlarm: [104, 'bool'],
    },
  },
  BSLimbIKModifier: {
    parent: 'hkbModifier',
    size: 120,
    members: {
      limitAngleDegrees: [80, 'f32'],
      startBoneIndex: [88, 'i16'],
      endBoneIndex: [90, 'i16'],
      gain: [92, 'f32'],
      boneRadius: [96, 'f32'],
      castOffset: [100, 'f32'],
    },
  },
  BSTweenerModifier: {
    parent: 'hkbModifier',
    size: 208,
    members: {
      tweenPosition: [80, 'bool'],
      tweenRotation: [81, 'bool'],
      useTweenDuration: [82, 'bool'],
      tweenDuration: [84, 'f32'],
      targetPosition: [96, 'vec4'],
      targetRotation: [112, 'vec4'],
    },
  },
  hkbTransformVectorModifier: {
    parent: 'hkbModifier',
    size: 160,
    members: {
      rotation: [80, 'vec4'],
      translation: [96, 'vec4'],
      vectorIn: [112, 'vec4'],
      vectorOut: [128, 'vec4'],
      rotateOnly: [144, 'bool'],
      inverse: [145, 'bool'],
      computeOnActivate: [146, 'bool'],
      computeOnModify: [147, 'bool'],
    },
  },
};

/** A member of a class or one of its bases. */
export function findMember(className: string, member: string): MemberLayout | undefined {
  for (let name: string | undefined = className, depth = 0; name && depth < 16; depth++) {
    const layout: ClassLayout | undefined = HAVOK_LAYOUTS[name];
    if (!layout) return undefined;
    const found = layout.members[member];
    if (found) return found;
    name = layout.parent;
  }
  return undefined;
}
