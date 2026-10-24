// The automated QA harness's vocabulary (docs/qa.md): what an anomaly is, the systems they are
// grouped by and the thresholds the monitors use. No DOM and no Node APIs: the page's monitors
// and the Node scenario runner (tools/qa-run.ts) share it.

/** The engine's systems an anomaly points at (the report groups by them). */
export type QaSystem =
  | 'animation'
  | 'locomotion'
  | 'physics'
  | 'ai'
  | 'combat'
  | 'scenes'
  | 'scripts'
  | 'shell'
  | 'ui'
  | 'performance'
  | 'effects';

/** What a monitor saw. */
export type QaKind =
  /** Moves horizontally while no locomotion clip plays (and the graph's root motion is still). */
  | 'glide'
  /** The graph's root-motion speed and the actor's real speed disagree. */
  | 'speed-mismatch'
  /** Its legs walk at another pace than it goes (a gait out of its speed band: foot sliding). */
  | 'foot-slide'
  /** Its drawn body pitches or rolls back and forth as it goes (a rocking horse). */
  | 'rocking'
  /** A state machine changes state many times a second. */
  | 'state-chatter'
  /** One clip restarts many times a second before it gets anywhere ("hangs in one step"). */
  | 'clip-restart'
  /** moveStart/moveStop sent to the graph many times a second. */
  | 'move-chatter'
  /** turnLeft/turnRight/turnStop sent to the graph many times a second. */
  | 'turn-chatter'
  /** The skeleton stays at its bind (reference) pose, or has no graph. */
  | 'bind-pose'
  /** A corpse stands upright (no ragdoll laid it down: its bind pose). */
  | 'corpse-upright'
  /** A corpse's ragdoll has not come to rest long after it fell (a body still awake). */
  | 'ragdoll-restless'
  /** A bone is NaN or absurdly far from the actor. */
  | 'bad-bone'
  /** A grounded actor's feet are well above what is under them. */
  | 'floating'
  /** A grounded actor's feet are below a surface (inside geometry, under the ground). */
  | 'sunk'
  /** An actor with a travel does not get nearer its destination. */
  | 'stuck'
  /** A simulated body's vertical velocity flips sign many times a second. */
  | 'physics-jitter'
  /** A simulated body's velocity jumps in one frame. */
  | 'velocity-spike'
  /** A playing scene's phase does not change while its actors stand. */
  | 'scene-stall'
  /** A watched quest's stage does not change. */
  | 'quest-stall'
  /** The engine's log: an error or a warning line (Papyrus, actors, assets). */
  | 'log-error'
  | 'log-warning'
  /** The page's console: an error, an uncaught exception or rejection. */
  | 'console-error'
  /** A frame far longer than the frame budget. */
  | 'long-frame'
  /** An open menu shows, visible, the placeholder text its movie was authored with. */
  | 'placeholder-text'
  /** A scenario's check of what the player does failed (a prompt, a hotkey, a shot). */
  | 'interaction'
  /** The page stopped answering (the runner saw it). */
  | 'hang'
  /** An archer fighting within its range never looses an arrow (or holds its bow drawn). */
  | 'archer-silent'
  /** A creature fighting within its reach never attacks (or its attacks never hit). */
  | 'creature-passive'
  /** A paired animation's partner stands away from the mark its leader's clip puts it at. */
  | 'pair-misaligned'
  /**
   * More magic effects show at once than a fight's: explosion and impact models, cones' waves,
   * hazards standing and projectiles flying (a breath's sprays each leaving its own fire).
   */
  | 'effects-flood';

/** The system each kind belongs to. */
export const KIND_SYSTEM: Readonly<Record<QaKind, QaSystem>> = {
  glide: 'locomotion',
  'speed-mismatch': 'locomotion',
  'foot-slide': 'locomotion',
  rocking: 'locomotion',
  'state-chatter': 'animation',
  'clip-restart': 'animation',
  'move-chatter': 'locomotion',
  'turn-chatter': 'locomotion',
  'bind-pose': 'animation',
  'corpse-upright': 'physics',
  'ragdoll-restless': 'physics',
  'bad-bone': 'animation',
  floating: 'physics',
  sunk: 'physics',
  stuck: 'ai',
  'physics-jitter': 'physics',
  'velocity-spike': 'physics',
  'scene-stall': 'scenes',
  'quest-stall': 'scenes',
  'log-error': 'scripts',
  'log-warning': 'scripts',
  'console-error': 'shell',
  'long-frame': 'performance',
  'placeholder-text': 'ui',
  interaction: 'ui',
  hang: 'shell',
  'archer-silent': 'combat',
  'creature-passive': 'combat',
  'pair-misaligned': 'animation',
  'effects-flood': 'effects',
};

/** What an anomaly happened to: an actor (the player too), a simulated body, a scene. */
export interface QaSubject {
  /** Form id as 8 hex digits (a scene's, a quest's, a reference's). */
  readonly id: string;
  readonly name: string;
  readonly kind:
    'player' | 'npc' | 'creature' | 'horse' | 'object' | 'scene' | 'quest' | 'log' | 'menu';
}

export interface QaAnomaly {
  /** Its number in the run (screenshots are named by it). */
  readonly id: number;
  readonly kind: QaKind;
  readonly system: QaSystem;
  readonly subject: QaSubject | undefined;
  /** Seconds since the monitors started. */
  readonly time: number;
  /** The game's hour then (undefined: no game running). */
  readonly gameHour: number | undefined;
  /** Where (game units), if it has a place. */
  readonly position: readonly [number, number, number] | undefined;
  /** The cell or worldspace the player was in. */
  readonly cell: string | undefined;
  /** The active state machines' states ("machine:state"), for actors. */
  readonly states: readonly string[] | undefined;
  /** The clips playing, for actors. */
  readonly clips: readonly string[] | undefined;
  /** What it was doing by design (riding, in furniture, a scene's package…). */
  readonly context: string | undefined;
  /** A line saying what was seen. */
  detail: string;
  /** The numbers behind it (speeds, counts, distances). */
  readonly values: Record<string, number>;
  /** How bad (the report sorts by it; per kind). */
  severity: number;
  /** How long it lasted (seconds; episodes grow while they go on). */
  duration: number;
  /** The first of its kind for this subject (it gets a screenshot). */
  readonly first: boolean;
  /** The screenshot's file name (the runner sets it). */
  shot?: string;
}

export interface QaThresholds {
  /** Horizontal speed above which an actor moves (game units per second). */
  readonly glideSpeed: number;
  /** A glide lasts this long before it counts (seconds). */
  readonly glideSeconds: number;
  /** Root-motion speed at or above which the graph is taken to walk (game units per second). */
  readonly locomotionRootSpeed: number;
  /** Speed mismatch: the difference must be over this (game units per second)… */
  readonly mismatchAbsolute: number;
  /** …and over this share of the larger speed… */
  readonly mismatchRelative: number;
  /** …for this long (seconds). */
  readonly mismatchSeconds: number;
  /** Foot sliding: moving at least this fast (game units per second)… */
  readonly footSlideSpeed: number;
  /** …its speed and its graph's root-motion speed (each over a second) apart by this factor… */
  readonly footSlideRatio: number;
  /** …and by more than this (game units per second)… */
  readonly footSlideAbsolute: number;
  /** …for this long (seconds). */
  readonly footSlideSeconds: number;
  /** Rocking: a swing of the drawn lean is a turn back by at least this (degrees)… */
  readonly rockAmplitude: number;
  /** …this many swings within two seconds rock… */
  readonly rockSwings: number;
  /**
   * …nearer together on its way than this on average (game units: a body cannot follow ground
   * that rises and falls within its own length; a gallop over rough ground swings as often in
   * time, but far apart on its way)…
   */
  readonly rockSpacing: number;
  /** …for this long (seconds). */
  readonly rockSeconds: number;
  /** State changes of one machine per second that count as chatter. */
  readonly stateChangesPerSecond: number;
  /** Restarts of one clip per second that count as hanging in one step. */
  readonly clipRestartsPerSecond: number;
  /** A clip that restarts before this far in (seconds) on average gets nowhere. */
  readonly clipRestartReach: number;
  /** moveStart + moveStop per second that count as chatter. */
  readonly moveEventsPerSecond: number;
  /** Turn events per second that count as chatter. */
  readonly turnEventsPerSecond: number;
  /** A shown skeleton at its bind pose this long counts (seconds). */
  readonly bindPoseSeconds: number;
  /** A bone farther than this from its actor's origin is broken (game units). */
  readonly boneLimit: number;
  /** Feet this far above what is under them float (game units). */
  readonly floatGap: number;
  /** A surface this far above the feet has them sunk (game units). */
  readonly sunkDepth: number;
  /** Floating or sunk this long counts (seconds). */
  readonly groundSeconds: number;
  /** A travel that gets no nearer for this long is stuck (seconds). */
  readonly stuckSeconds: number;
  /** Getting this much nearer (or moving this far) is progress (game units). */
  readonly stuckProgress: number;
  /** Vertical velocity sign flips per second of a simulated body that count as jitter. */
  readonly jitterFlipsPerSecond: number;
  /** A flip counts only above this vertical speed (game units per second). */
  readonly jitterMinSpeed: number;
  /** Jitter lasts this long before it counts (seconds). */
  readonly jitterSeconds: number;
  /** A change of a body's velocity in one frame above this is a spike (game units per second). */
  readonly velocitySpike: number;
  /** A playing scene's phase unchanged this long, its actors standing, stalls (seconds). */
  readonly sceneStallSeconds: number;
  /** A frame longer than this is reported on its own (milliseconds). */
  readonly longFrameMs: number;
  /** An archer in combat within its range that looses nothing this long (seconds)… */
  readonly archerSilentSeconds: number;
  /** …or holds its bow drawn this long (seconds: fCombatRangedAttackMaximumHoldTime). */
  readonly bowHeldSeconds: number;
  /** A creature in combat within its reach that attacks not once this long (seconds)… */
  readonly creaturePassiveSeconds: number;
  /** …or attacks this often within its reach without a hit. */
  readonly creatureMisses: number;
  /** A paired clip's partner this far from its mark (game units) or turned this far (degrees). */
  readonly pairMarkUnits: number;
  readonly pairMarkDegrees: number;
  /** Magic effects (models, hazards, projectiles) showing at once above which they flood. */
  readonly effectsAtOnce: number;
}

export const DEFAULT_THRESHOLDS: QaThresholds = {
  glideSpeed: 40,
  glideSeconds: 0.5,
  locomotionRootSpeed: 15,
  mismatchAbsolute: 80,
  mismatchRelative: 0.6,
  mismatchSeconds: 1.5,
  footSlideSpeed: 40,
  footSlideRatio: 1.35,
  footSlideAbsolute: 25,
  footSlideSeconds: 1.5,
  rockAmplitude: 6,
  rockSwings: 3,
  rockSpacing: 200,
  rockSeconds: 0.5,
  stateChangesPerSecond: 8,
  clipRestartsPerSecond: 5,
  clipRestartReach: 0.2,
  moveEventsPerSecond: 6,
  turnEventsPerSecond: 8,
  bindPoseSeconds: 1,
  boneLimit: 20000,
  floatGap: 40,
  sunkDepth: 30,
  groundSeconds: 1.5,
  stuckSeconds: 10,
  stuckProgress: 64,
  jitterFlipsPerSecond: 6,
  jitterMinSpeed: 30,
  jitterSeconds: 1,
  velocitySpike: 1500,
  sceneStallSeconds: 45,
  longFrameMs: 100,
  archerSilentSeconds: 15,
  bowHeldSeconds: 10,
  creaturePassiveSeconds: 12,
  creatureMisses: 8,
  pairMarkUnits: 24,
  pairMarkDegrees: 25,
  effectsAtOnce: 40,
};

/** The frame times of a run (milliseconds). */
export interface QaFrameStats {
  readonly frames: number;
  readonly seconds: number;
  readonly fps: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly worst: number;
  /** Frames over 33 ms and over 50 ms. */
  readonly over33: number;
  readonly over50: number;
  /** Long tasks (PerformanceObserver 'longtask'): their count, total and longest (ms). */
  readonly longTasks: number;
  readonly longTaskTotal: number;
  readonly longTaskWorst: number;
}

/** What the page's monitors hand the runner at the end of a scenario. */
export interface QaSnapshot {
  readonly anomalies: readonly QaAnomaly[];
  /** Anomalies beyond those kept (per kind), still counted. */
  readonly dropped: Readonly<Partial<Record<QaKind, number>>>;
  readonly frames: QaFrameStats;
  /** Seconds the monitors ran. */
  readonly seconds: number;
  /** The most actors watched at once, and the simulated bodies seen awake. */
  readonly actorsWatched: number;
  readonly bodiesWatched: number;
}
