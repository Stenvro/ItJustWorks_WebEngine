// What the running game has changed on top of the plugins: the clocks, globals, quests (running,
// stages, objectives, who fills their aliases), placed references (enabled, moved, opened,
// locked, destroyed), actors (actor values, factions, death), inventories and the references
// scripts created. Plain data, to be saved (TODO(M12)). Platform-independent.
// Notes: docs/scripting.md ("Game state").

import type { StoryEventData } from './story-manager.ts';

export type Vec3 = [number, number, number];

export interface ObjectiveState {
  displayed: boolean;
  completed: boolean;
  failed: boolean;
  /** When it was last shown (GameState.questClock): the journal lists newer ones first. */
  shown?: number;
}

export interface QuestState {
  running: boolean;
  /** The current stage (GetStage): the last one set. */
  stage: number;
  readonly stagesDone: Set<number>;
  readonly objectives: Map<number, ObjectiveState>;
  /** Alias id → the reference or location filling it. */
  readonly aliases: Map<number, number>;
  completed: boolean;
  failed: boolean;
  /** Shown as the active quest in the journal. */
  active: boolean;
  /** Times started (Run Once quests start once). */
  starts: number;
  /** The log entries its stages chose that have a journal text (stage, entry index), in order. */
  readonly log: { readonly stage: number; readonly entry: number }[];
  /** When it was last updated for the player (GameState.questClock): the journal's order. */
  updated: number;
  /** The story manager event that started it (its conditions and aliases read its data). */
  event?: StoryEventData;
}

export interface ReferenceState {
  enabled?: boolean;
  position?: Vec3;
  /** Radians. */
  rotation?: Vec3;
  /** The cell it was moved into (MoveTo across cells), or 0 for none (a created ref). */
  cell?: number;
  /** The worldspace of an exterior cell it was moved into. */
  world?: number;
  deleted?: boolean;
  /** Taken into a container (an actor's inventory) as its base's count: out of the world. */
  container?: { readonly holder: number; readonly base: number; readonly count: number };
  destroyed?: boolean;
  destructionStage?: number;
  /** Doors and containers: 0 none, 1 open, 2 opening, 3 closed, 4 closing. */
  openState?: number;
  locked?: boolean;
  lockLevel?: number;
  activationBlocked?: boolean;
  ownerActor?: number;
  ownerFaction?: number;
  /** Motion type set by script (SetMotionType): 1 dynamic, 2 sphere inertia, ..., 4 keyframed. */
  motionType?: number;
  scale?: number;
  /** Linked references a script changed (keyword 0: none). */
  links?: Map<number, number>;
}

export interface ActorValueState {
  /** The base value a script set (SetActorValue / SetAV); else the record's. */
  base?: number;
  /** Permanent modifiers (ModActorValue). */
  modifier: number;
  /** Damage restored over time (DamageActorValue / RestoreActorValue). */
  damage: number;
}

export interface ActorState {
  /** By actor value index. */
  readonly values: Map<number, ActorValueState>;
  /** Faction → rank a script set (−2: removed from it). */
  readonly factions: Map<number, number>;
  dead?: boolean;
  /** Who killed it. */
  killer?: number;
  ghost?: boolean;
  restrained?: boolean;
  doingFavor?: boolean;
  playerTeammate?: boolean;
  canDoFavor?: boolean;
  alerted?: boolean;
  unconscious?: boolean;
  bribed?: boolean;
  intimidated?: boolean;
  dontMove?: boolean;
  aiEnabled?: boolean;
  noBleedoutRecovery?: boolean;
  /** Its own outfits (Actor.SetOutfit), over its base's. */
  outfit?: number;
  sleepOutfit?: number;
  race?: number;
  /** Spells and shouts added (true) or removed (false) by scripts. */
  readonly spells: Map<number, boolean>;
  /** Perks added (true) or removed (false) by scripts. */
  readonly perks: Map<number, boolean>;
  /** It has talked to the player (GetTalkedToPC). */
  talkedToPlayer?: boolean;
  /** Items equipped by scripts (TODO(M11): the equip system). */
  readonly equipped: Set<number>;
  crimeFaction?: number | null;
  level?: number;
  voiceRecoveryTime?: number;
  forcedLandingMarker?: number;
  /** SetVehicle: what it rides along on. */
  vehicle?: number;
}

/** What scripts changed on an actor base (ActorBase natives): it holds for all its actors. */
export interface ActorBaseState {
  essential?: boolean;
  protected?: boolean;
  invulnerable?: boolean;
  outfit?: number;
  sleepOutfit?: number;
}

/** A faction's crime gold and standing with the player and other factions. */
export interface FactionState {
  crimeGold: number;
  crimeGoldViolent: number;
  playerEnemy?: boolean;
  playerExpelled?: boolean;
  /** Combat reactions scripts set (SetAlly, SetEnemy): faction → 0 neutral .. 3 friend. */
  readonly reactions: Map<number, number>;
  /** Reaction modifiers (SetReaction / ModReaction). */
  readonly reactionModifiers: Map<number, number>;
}

export interface LocationState {
  cleared?: boolean;
  /** Keyword data (SetKeywordData): keyword → value. */
  readonly keywordData: Map<number, number>;
}

export interface CellState {
  ownerActor?: number;
  ownerFaction?: number;
  public?: boolean;
}

/** A magic effect active on an actor (TODO(M11): the magic system applies and ends them). */
export interface ActiveEffectState {
  /** MGEF. */
  readonly effect: number;
  readonly target: number;
  readonly caster: number | undefined;
  /** Seconds it has lasted, and lasts in all (0: until dispelled). */
  elapsed: number;
  readonly duration: number;
  readonly magnitude: number;
}

/** A reference a script created (PlaceAtMe, alias Create Reference). */
export interface CreatedReference {
  readonly base: number;
  readonly count: number;
}

export class GameState {
  /** Real seconds the game has run (outside menus). */
  realTime = 0;
  /** Game days passed (the GameDaysPassed global): 1.333 is 8:00 of the first day. */
  gameDaysPassed = 0;
  readonly globals = new Map<number, number>();
  readonly quests = new Map<number, QuestState>();
  readonly references = new Map<number, ReferenceState>();
  readonly actors = new Map<number, ActorState>();
  readonly actorBases = new Map<number, ActorBaseState>();
  readonly factions = new Map<number, FactionState>();
  readonly locations = new Map<number, LocationState>();
  readonly cells = new Map<number, CellState>();
  /** Relationship ranks scripts set between two NPC_ bases ("low:high" form ids). */
  readonly relationships = new Map<string, number>();
  /** Entries scripts added to leveled lists (LeveledItem.AddForm, ...), by list. */
  readonly leveledAdditions = new Map<number, { level: number; formId: number; count: number }[]>();
  /** Magic effects active on actors (ActiveMagicEffect scripts): by handle key. */
  readonly activeEffects = new Map<string, ActiveEffectState>();
  /** Item counts per container (reference), by base form; filled from the records on first use. */
  readonly inventories = new Map<number, Map<number, number>>();
  readonly created = new Map<number, CreatedReference>();
  /** The next form id for a created reference (the save's own range, 0xFF000000 up). */
  nextCreated = 0xff000800;
  /** The next id of an active magic effect (script objects that are not forms). */
  nextEffect = 0xfd000001;
  /** The player's favorites (items, spells, shouts): the favorites menu's (Q). */
  readonly favorites = new Set<number>();
  /** Actors dead, by their base (GetDeadCount). */
  readonly deadCounts = new Map<number, number>();
  /** Counts the quests' updates for the player (QuestState.updated). */
  questClock = 0;
  /** What Debug.Notification / MessageBox showed (the HUD's until M9). */
  readonly messages: string[] = [];

  quest(formId: number): QuestState {
    let state = this.quests.get(formId);
    if (!state) {
      state = {
        running: false,
        stage: 0,
        stagesDone: new Set(),
        objectives: new Map(),
        aliases: new Map(),
        completed: false,
        failed: false,
        active: false,
        starts: 0,
        log: [],
        updated: 0,
      };
      this.quests.set(formId, state);
    }
    return state;
  }

  reference(formId: number): ReferenceState {
    let state = this.references.get(formId);
    if (!state) {
      state = {};
      this.references.set(formId, state);
    }
    return state;
  }

  actor(formId: number): ActorState {
    let state = this.actors.get(formId);
    if (!state) {
      state = {
        values: new Map(),
        factions: new Map(),
        spells: new Map(),
        perks: new Map(),
        equipped: new Set(),
      };
      this.actors.set(formId, state);
    }
    return state;
  }

  actorBase(formId: number): ActorBaseState {
    let state = this.actorBases.get(formId);
    if (!state) {
      state = {};
      this.actorBases.set(formId, state);
    }
    return state;
  }

  faction(formId: number): FactionState {
    let state = this.factions.get(formId);
    if (!state) {
      state = {
        crimeGold: 0,
        crimeGoldViolent: 0,
        reactions: new Map(),
        reactionModifiers: new Map(),
      };
      this.factions.set(formId, state);
    }
    return state;
  }

  location(formId: number): LocationState {
    let state = this.locations.get(formId);
    if (!state) {
      state = { keywordData: new Map() };
      this.locations.set(formId, state);
    }
    return state;
  }

  cell(formId: number): CellState {
    let state = this.cells.get(formId);
    if (!state) {
      state = {};
      this.cells.set(formId, state);
    }
    return state;
  }

  /** A new reference's form id. */
  create(base: number, count = 1): number {
    const formId = this.nextCreated++;
    this.created.set(formId, { base, count });
    return formId;
  }
}
