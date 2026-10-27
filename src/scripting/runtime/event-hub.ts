// The game's event hub (docs/scripting.md, "Events"): the one place a happening in the game is
// told, as the original engine's event sources tell it (its TES*Event sources, which feed the
// scripts, the story manager, the statistics and the interface at once). A producer emits an
// event once; every consumer that cares listens here: the relay to the scripts (their On*
// events), the relay to the story manager (its SM events), the misc stats, the HUD. So an event
// cannot reach one consumer and miss another.
//
// Every engine event source has a kind here, named after it; what each carries follows the
// source's own data (CommonLibSSE names them). References and forms are form ids; `undefined`
// stands for None. Platform-independent.

/** The events by kind: what each carries. */
export interface GameEvents {
  /** A reference was activated (TESActivateEvent). */
  activate: { readonly target: number; readonly actor: number | undefined };
  /** An active effect started or ended on a target (TESActiveEffectApplyRemoveEvent). */
  activeEffectApplyRemove: {
    readonly caster: number | undefined;
    readonly target: number;
    readonly effect: number;
    readonly applied: boolean;
  };
  /**
   * An actor entered another location (TESActorLocationChangeEvent): the player and NPCs alike;
   * `undefined` is no location (the wilderness).
   */
  actorLocationChange: {
    readonly actor: number;
    readonly from: number | undefined;
    readonly to: number | undefined;
  };
  /**
   * A book was read (TESBookReadEvent): the book (its base) and, when it was one, the reference
   * read (a book lying in the world).
   */
  bookRead: {
    readonly book: number;
    readonly reader: number;
    readonly reference: number | undefined;
  };
  /** A reference's cell attached or detached (TESCellAttachDetachEvent). */
  cellAttachDetach: { readonly reference: number; readonly attached: boolean };
  /**
   * A cell finished loading, its references' 3D included (TESCellFullyLoadedEvent): the cell,
   * if known, and its references whose 3D is in.
   */
  cellFullyLoaded: { readonly cell: number | undefined; readonly references: readonly number[] };
  /** An actor's combat state changed: 0 not in combat, 1 in combat, 2 searching (TESCombatEvent). */
  combat: {
    readonly actor: number;
    readonly target: number | undefined;
    readonly state: 0 | 1 | 2;
  };
  /** Items moved between containers or the world (TESContainerChangedEvent). */
  containerChanged: {
    readonly from: number | undefined;
    readonly to: number | undefined;
    readonly item: number;
    readonly count: number;
    /** The reference of the item itself, when it was or became one. */
    readonly reference: number | undefined;
  };
  /** An actor is dying (`dead` false) or dead (`dead` true) (TESDeathEvent). */
  death: { readonly actor: number; readonly killer: number | undefined; readonly dead: boolean };
  /** A destructible object went to another stage (TESDestructionStageChangedEvent). */
  destructionStageChanged: {
    readonly reference: number;
    readonly oldStage: number;
    readonly newStage: number;
  };
  /** An actor went into bleedout (TESEnterBleedoutEvent). */
  enterBleedout: { readonly actor: number };
  /** An actor equipped or unequipped something (TESEquipEvent). */
  equip: {
    readonly actor: number;
    readonly item: number;
    readonly reference: number | undefined;
    readonly equipped: boolean;
  };
  /**
   * An actor got into furniture (in it: sitting, sleeping, leaning) or up from it
   * (TESFurnitureEvent: enter, exit), the player too.
   */
  furniture: { readonly actor: number; readonly furniture: number; readonly entered: boolean };
  /** The player's fast travel ended (TESFastTravelEndEvent): game hours it took. */
  fastTravelEnd: { readonly hours: number };
  /** The player grabbed or released an object (TESGrabReleaseEvent). */
  grabRelease: { readonly reference: number; readonly grabbed: boolean };
  /** Something was hit by a weapon, a spell, a projectile or an explosion (TESHitEvent). */
  hit: {
    readonly target: number;
    readonly aggressor: number | undefined;
    /** The weapon, spell, enchantment, explosion or ingredient it was hit with. */
    readonly source: number | undefined;
    readonly projectile: number | undefined;
    readonly powerAttack: boolean;
    readonly sneakAttack: boolean;
    readonly bashAttack: boolean;
    readonly blocked: boolean;
  };
  /** A saved game finished loading (TESLoadGameEvent). */
  loadGame: Record<string, never>;
  /**
   * A location the player can clear was cleared (LocationCleared::Event: its bosses dead,
   * src/scripting/runtime/location-clearing.ts).
   */
  locationCleared: { readonly location: number };
  /** A lock's state changed (TESLockChangedEvent). */
  lockChanged: { readonly reference: number };
  /** A magic effect is applied to a target (TESMagicEffectApplyEvent). */
  magicEffectApply: {
    readonly caster: number | undefined;
    readonly target: number;
    readonly effect: number;
  };
  /** A ward was hit (TESMagicWardHitEvent): 0 friendly, 1 absorbed, 2 broken. */
  magicWardHit: {
    readonly target: number;
    readonly caster: number | undefined;
    readonly spell: number;
    readonly status: 0 | 1 | 2;
  };
  /** A reference's 3D attached to or detached from a cell (TESMoveAttachDetachEvent). */
  moveAttachDetach: { readonly reference: number; readonly attached: boolean };
  /** A reference's 3D loaded or unloaded (TESObjectLoadedEvent). */
  objectLoaded: { readonly reference: number; readonly loaded: boolean };
  /**
   * A reference's translation (TranslateTo) failed (0), completed (1) or is almost complete (2:
   * past fRefTranslationAlmostDonePercent of its way) (TESObjectREFRTranslationEvent).
   */
  objectTranslation: { readonly reference: number; readonly result: 0 | 1 | 2 };
  /** A door or container opened or closed (TESOpenCloseEvent). */
  openClose: {
    readonly reference: number;
    readonly actor: number | undefined;
    readonly opened: boolean;
  };
  /** An actor's package started, changed or ended (TESPackageEvent). */
  package: {
    readonly actor: number;
    readonly package: number;
    readonly type: 'start' | 'change' | 'end';
  };
  /** A perk entry of the Activate kind ran (TESPerkEntryRunEvent). */
  perkEntryRun: {
    readonly cause: number;
    readonly target: number;
    readonly perk: number;
    readonly flag: number;
  };
  /** The player shot an arrow or bolt (TESPlayerBowShotEvent). */
  playerBowShot: {
    readonly weapon: number;
    readonly ammo: number;
    readonly power: number;
    readonly sunGazing: boolean;
  };
  /** A quest's scripts were initialised (TESQuestInitEvent). */
  questInit: { readonly quest: number };
  /** A quest's stage was set (TESQuestStageEvent). */
  questStage: { readonly quest: number; readonly stage: number };
  /** A quest started or stopped (TESQuestStartStopEvent). */
  questStartStop: { readonly quest: number; readonly started: boolean };
  /** A reference was reset with its cell (TESResetEvent). */
  reset: { readonly reference: number };
  /** A scene's action or phase changed, or the scene started or ended (TESScene*Event). */
  scene: {
    readonly scene: number;
    readonly type: 'begin' | 'end' | 'phaseBegin' | 'phaseEnd' | 'action';
    readonly index: number | undefined;
  };
  /**
   * An item was sold (TESSellEvent): who sold it, the item, how many, and the item's own
   * reference when it has one (a quest's item kept in the inventory).
   */
  sell: {
    readonly seller: number;
    readonly item: number;
    readonly count: number;
    readonly reference: number | undefined;
  };
  /**
   * The player's sleep started or stopped (TESSleepStartEvent, TESSleepStopEvent): at the start
   * when it began and when it is to end (game days passed), at the stop whether it was broken.
   */
  sleep: {
    readonly started: boolean;
    readonly interrupted: boolean;
    readonly start?: number;
    readonly end?: number;
  };
  /** A spell, power, scroll or shout was cast (TESSpellCastEvent). */
  spellCast: { readonly caster: number; readonly spell: number };
  /** An actor's race switch ended (TESSwitchRaceCompleteEvent). */
  switchRaceComplete: { readonly actor: number };
  /** A topic info's line began or ended (TESTopicInfoEvent). */
  topicInfo: {
    readonly speaker: number;
    readonly topicInfo: number;
    readonly type: 'begin' | 'end';
  };
  /** A tracked misc stat changed (TESTrackedStatsEvent). */
  trackedStats: { readonly stat: string; readonly value: number };
  /**
   * A trap hit something (TESTrapHitEvent): its contact began (`start`), goes on (`hit`) or
   * ended (`stop`); `initial` its first contact.
   */
  trapHit: {
    readonly trap: number;
    readonly phase: 'start' | 'hit' | 'stop';
    readonly target: number;
    readonly velocity: readonly [number, number, number];
    readonly position: readonly [number, number, number];
    readonly material: number | undefined;
    readonly initial: boolean;
    readonly motionType: number;
  };
  /** Something is in a trigger volume (TESTriggerEvent: repeated while inside). */
  trigger: { readonly trigger: number; readonly reference: number };
  /** Something entered or left a trigger volume (TESTriggerEnterEvent, TESTriggerLeaveEvent). */
  triggerEnterLeave: {
    readonly trigger: number;
    readonly reference: number;
    readonly entered: boolean;
  };
  /** The player's wait started or stopped (TESWaitStartEvent, TESWaitStopEvent). */
  wait: { readonly started: boolean; readonly interrupted: boolean };
  /** The player learned a word of power new to them (Game.TeachWord: the HUD's notice). */
  wordLearned: { readonly word: number };
}

export type GameEventKind = keyof GameEvents;

/** A listener of one kind; a promise it returns the hub awaits only in `emitted`. */
export type GameEventListener<K extends GameEventKind> = (event: GameEvents[K]) => unknown;

type AnyListener = (event: never) => unknown;

/** The hub: producers emit, consumers listen; listeners run in the order they were added. */
export class EventHub {
  readonly #listeners = new Map<GameEventKind, AnyListener[]>();
  /** Where a listener's failure goes (it never stops the others or the producer). */
  onError: (kind: GameEventKind, error: unknown) => void = () => undefined;

  /** Listens to one kind; returns what stops listening. */
  on<K extends GameEventKind>(kind: K, listener: GameEventListener<K>): () => void {
    const list = this.#listeners.get(kind) ?? [];
    list.push(listener);
    this.#listeners.set(kind, list);
    return () => {
      const at = list.indexOf(listener);
      if (at >= 0) list.splice(at, 1);
    };
  }

  /** Tells every listener of the event's kind; does not wait for what they start. */
  emit<K extends GameEventKind>(kind: K, event: GameEvents[K]): void {
    void this.emitted(kind, event);
  }

  /** As emit, resolved once every listener's work (its promise) is done. */
  async emitted<K extends GameEventKind>(kind: K, event: GameEvents[K]): Promise<void> {
    const list = this.#listeners.get(kind);
    if (!list) return;
    const pending: Promise<unknown>[] = [];
    for (const listener of [...list]) {
      try {
        const result = (listener as GameEventListener<K>)(event);
        if (result instanceof Promise) {
          pending.push(
            result.catch((error: unknown) => {
              this.onError(kind, error);
            }),
          );
        }
      } catch (error) {
        this.onError(kind, error);
      }
    }
    await Promise.all(pending);
  }
}
