// What the running game has changed on top of the plugins: the clocks, globals, quests (running,
// stages, objectives, who fills their aliases), placed references (enabled, moved, opened,
// locked, destroyed), actors (actor values, factions, death), inventories and the references
// scripts created. Plain data, to be saved (TODO(M12)). Platform-independent.
// Notes: docs/scripting.md ("Game state").

import type { PlayerAppearance } from '../../gameplay/chargen.ts';
import { emptyLoadout, type Loadout } from '../../gameplay/equipment.ts';
import type { CreatedForm } from '../../world/created-forms.ts';
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
  /**
   * Temporary modifiers: magic effects that are taken back as they end (Fortify, abilities,
   * worn enchantments; CommonLibSSE ACTOR_VALUE_MODIFIER::kTemporary).
   */
  temporary?: number;
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
  /** Others attack it on sight (SetAttackActorOnSight: the combat AI). */
  attackOnSight?: boolean;
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
  /**
   * Everything it has equipped now (its hands, voice, ammo, what it wears): a mirror of
   * `equipment` kept by the equip system (ScriptRuntime.equipment), for readers of a set.
   */
  readonly equipped: ReadonlySet<number>;
  /** What it holds and wears, by place (the equip system). */
  readonly equipment: EquipmentState;
  crimeFaction?: number | null;
  level?: number;
  voiceRecoveryTime?: number;
  forcedLandingMarker?: number;
  /** SetVehicle: what it rides along on. */
  vehicle?: number;
}

/**
 * What an actor holds and wears (src/scripting/runtime/equipment-engine.ts; the rules:
 * src/gameplay/equipment.ts).
 */
export interface EquipmentState extends Loadout {
  /** Filled from its records (its outfit, the best it carries) as its inventory was first read. */
  ready: boolean;
  /** The outfit it wears now (OTFT: its outfit, or its sleep outfit while it sleeps). */
  outfit: number | undefined;
  /** It wears its sleep outfit. */
  asleep: boolean;
  /** Items in its inventory that came with its outfit (base → count): a new outfit takes them. */
  readonly outfitItems: Map<number, number>;
  /** Items scripts equipped to stay (EquipItem's abPreventRemoval): only scripts take them off. */
  readonly locked: Set<number>;
  /** Items it must not equip again by itself (UnequipItem's abPreventEquip). */
  readonly prevented: Set<number>;
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
  /** All the crime gold the player ever owed it (GetInfamy*: CommonLibSSE CrimeGoldStruct). */
  infamy?: number;
  infamyViolent?: number;
  playerEnemy?: boolean;
  playerExpelled?: boolean;
  /** The player resisted its guards' arrest (SetPlayerResistingArrest): they attack. */
  resisting?: boolean;
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

/**
 * A magic effect on an actor (the magic system's: src/scripting/runtime/magic-engine.ts): an
 * effect item of a magic item on its target, from its caster, as strong as it was cast and
 * resisted. Keyed by its ActiveMagicEffect script object's handle.
 */
export interface ActiveEffectState {
  /** MGEF. */
  readonly effect: number;
  readonly target: number;
  readonly caster: number | undefined;
  /** Seconds it has lasted, and lasts in all (0: at once, or until dispelled when lasting). */
  elapsed: number;
  /** (A concentration spell's held effects last on while it is held: casting-engine.ts.) */
  duration: number;
  readonly magnitude: number;
  /** The magic item (SPEL, SCRL, ENCH, ALCH, INGR) it is an effect of, and the effect item's index. */
  readonly item?: number;
  readonly index?: number;
  /** The worn or wielded object whose enchantment it is (or whose equip ability). */
  readonly source?: number;
  /** Feet. */
  readonly area?: number;
  /** It lasts until it is taken away: abilities, diseases, worn enchantments. */
  readonly lasting?: boolean;
  /** It was dual cast. */
  readonly dual?: boolean;
  /** Where a Target Location spell landed (what it makes stands there). */
  readonly at?: Vec3;
  /** Its conditions do not hold: it does nothing (its scripts finished) until they do. */
  inactive?: boolean;
  /** What it put on actor values that is taken back as it ends (actor, actor value, amount). */
  applied?: { readonly actor: number; readonly value: number; amount: number }[];
  /** What it made or raised: a summoned or reanimated actor, a bound weapon, a hazard. */
  made?: number;
}

/** What the magic system keeps of an actor besides the effects on it. */
export interface ActorMagicState {
  /** The poison on its weapon, for its next hits (hits deliver it: src/shell/actor-combat.ts). */
  poison?: { readonly weapon: number | undefined; readonly poison: number; charges: number };
}

/**
 * What casting keeps of an actor (src/scripting/runtime/casting-engine.ts). TODO(M12): in the
 * save.
 */
export interface ActorCastingState {
  /** Powers it used, by spell: the game day (GameDaysPassed) of the last use. */
  readonly powersUsed: Map<number, number>;
  /**
   * Its staffs' and enchanted weapons' charge left, by weapon base (the crafting engine's for
   * weapons). An enchanted weapon the player made is a form of its own, so its charge is its
   * own; the plugins' enchanted weapons share theirs by base. TODO(M13): per item, as the game
   * keeps it on each one (ExtraCharge).
   */
  readonly charge: Map<number, number>;
  /** The voice's recovery it began with (seconds; the shout meter's whole). */
  voiceRecoveryTotal?: number;
  /** Words of its last shout less one (GetCurrentShoutVariation). */
  shoutVariation?: number;
}

/** The player in jail (Faction.SendPlayerToJail): until they serve their time or escape. */
export interface JailState {
  /** The crime faction that jailed them, and the bounty they serve. */
  readonly faction: number;
  readonly violent: number;
  readonly nonviolent: number;
  /** The days they are to serve. */
  readonly days: number;
  /** The jail's cell (leaving it unserved is an escape). */
  readonly cell: number | undefined;
  /** Their items went to the evidence chest (they get them back once served). */
  readonly inventoryTaken: boolean;
}

/** What crime keeps of the player (src/scripting/runtime/crime-engine.ts). TODO(M12): saved. */
export interface CrimeState {
  /**
   * Stolen items by container, then base, then whose ("faction:witnessed", the crime faction
   * the theft was against and whether it was seen): their counts (GetStolenItemValueCrime /
   * NoCrime; vendors that are no fences refuse them).
   */
  readonly stolen: Map<number, Map<number, Map<string, number>>>;
  jail?: JailState;
  /** Interiors the player may not be in now: picked into, or locked with them inside. */
  readonly offLimits: Set<number>;
  /** Favor points the player has with actors (gifts, favors): their relationship rises. */
  readonly favor: Map<number, number>;
  /** Game.SetPlayerReportCrime(false): crimes against the player are not reported. */
  reportCrimeAgainstPlayer: boolean;
  /** The guard arresting the player now (GetArrestingActor; IsArrestingTarget). */
  arrestingGuard?: number;
  /** Horses the player took from their owners (IsHorseStolen). */
  readonly stolenHorses: Set<number>;
  /** The trespass warnings the player was given where they trespass now (GetTrespassWarningLevel). */
  trespassWarnings: number;
}

/**
 * Alike items of a container's base with data of their own (the game's extra data list on an
 * inventory entry, with its count: ExtraHealth for an improved weapon or armor).
 */
export interface ItemStack {
  count: number;
  /** ExtraHealth: 1.1 Fine, 1.2 Superior, ... (src/gameplay/crafting.ts temperHealth). */
  readonly health: number;
  /** The one of its base an actor wears or wields (the game's ExtraWorn on the list). */
  worn?: boolean;
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
  /** Crime: stolen items, jail, places off limits, favor (crime-engine.ts). */
  readonly crime: CrimeState = {
    stolen: new Map(),
    offLimits: new Set(),
    favor: new Map(),
    reportCrimeAgainstPlayer: true,
    stolenHorses: new Set(),
    trespassWarnings: 0,
  };
  /** Entries scripts added to leveled lists (LeveledItem.AddForm, ...), by list. */
  readonly leveledAdditions = new Map<number, { level: number; formId: number; count: number }[]>();
  /** Magic effects on actors (ActiveMagicEffect scripts): by handle key. */
  readonly activeEffects = new Map<string, ActiveEffectState>();
  /** What the magic system keeps of actors (a poisoned weapon), by actor. */
  readonly actorMagic = new Map<number, ActorMagicState>();
  /** What casting keeps of actors (powers used, staffs' charge, the voice), by actor. */
  readonly actorCasting = new Map<number, ActorCastingState>();
  /** Item counts per container (reference), by base form; filled from the records on first use. */
  readonly inventories = new Map<number, Map<number, number>>();
  readonly created = new Map<number, CreatedReference>();
  /** The next form id for a created reference (the save's own range, 0xFF000000 up). */
  nextCreated = 0xff000800;
  /** The next id of an active magic effect (script objects that are not forms). */
  nextEffect = 0xfd000001;
  /** The player's favorites (items, spells, shouts): the favorites menu's (Q). */
  readonly favorites = new Set<number>();
  /** The books the player has read (a skill book teaches once; TODO(M12): in the save). */
  readonly booksRead = new Set<number>();
  /** The tutorials shown in this game (their default objects' uses: "HBLK", ...). */
  readonly tutorialsShown = new Set<string>();
  /** How often each skill (actor value) has been made Legendary (TODO(M12): in the save). */
  readonly legendary = new Map<number, number>();
  /** What the player has seen of interiors (the local map's fog of war), by cell. */
  readonly seen = new Map<number, Map<string, Uint8Array>>();
  /**
   * The player's own map marker (the map's Place Marker), in the map's world: where it stands
   * (TODO(M12): in the save).
   */
  playerMarker:
    { readonly world: number; readonly position: readonly [number, number, number] } | undefined;
  /** Training sessions the player had at a level (five a level: the training menu). */
  training = { level: 0, sessions: 0 };
  /** Level-ups waiting for the player to choose (the level-up menu). */
  levelUps = 0;
  /**
   * The player's experience (src/scripting/runtime/progression-engine.ts): each skill's toward
   * its next level (by actor value), and the character's toward its next level-up (UESP
   * "Leveling"). TODO(M12): in the save.
   */
  readonly skillExperience = new Map<number, number>();
  playerExperience = 0;
  /** Encounter zones' levels, set as first met (ECZN). TODO(M12): in the save. */
  readonly zoneLevels = new Map<number, number>();
  /** The level each reference's leveled lists were picked at (it keeps its picks). */
  readonly leveledLevels = new Map<number, number>();
  /**
   * What the player looks like (the race menu's choices; its race is the Player base's race,
   * ActorBase.GetRace, while Actor.SetRace changes the actor's own: ActorState.race). Made from
   * the Player record (NPC_ 0x7) when first needed; undefined until then. TODO(M12): in the
   * save.
   */
  playerAppearance: PlayerAppearance | undefined;
  /** The name the player chose in the race menu (else the Player record's). TODO(M12). */
  playerName: string | undefined;
  /** Actors dead, by their base (GetDeadCount). */
  readonly deadCounts = new Map<number, number>();
  /**
   * Items of containers with data of their own (ItemStack: an improved weapon's health), by
   * container, then base: alike items of a base in stacks; the rest of the base's count (the
   * inventory's) is plain. Kept by the crafting engine (src/scripting/runtime/crafting-engine.ts).
   * TODO(M12): in the save.
   */
  readonly itemStacks = new Map<number, Map<number, ItemStack[]>>();
  /**
   * Forms the game made (the player's enchantments, enchanted items, potions and poisons:
   * src/world/created-forms.ts), by form id (the save's own range, as created references).
   * TODO(M12): in the save (and those no inventory holds any more left out).
   */
  readonly createdForms = new Map<number, CreatedForm>();
  /** Enchantments the player learned by disenchanting (their base enchantments). */
  readonly knownEnchantments = new Set<number>();
  /** The effects the player found out on each ingredient, by effect slot (0..3). */
  readonly ingredientEffects = new Map<number, ReadonlySet<number>>();
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
        equipment: {
          ...emptyLoadout(),
          ready: false,
          outfit: undefined,
          asleep: false,
          outfitItems: new Map(),
          locked: new Set(),
          prevented: new Set(),
        },
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

  /** A new form's form id (a created form: an enchantment, a potion). */
  createForm(form: CreatedForm): number {
    const formId = this.nextCreated++;
    this.createdForms.set(formId, form);
    return formId;
  }
}
