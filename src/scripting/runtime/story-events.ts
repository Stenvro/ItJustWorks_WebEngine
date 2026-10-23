// The story events of the world (docs/scripting.md, "Story manager"): what tells the story
// manager (story-manager.ts) of a happening, with the event's data as the engine fills it (observed
// in the original: each event type's members, the Event Data its nodes' conditions
// and quests' aliases read). Two kinds:
//
// - Relayed from the event hub (event-hub.ts): Change Location (CLOC) as the player enters
//   another location (actorLocationChange; the engine raises it for the player only, as it puts
//   the player in a cell of another location).
// - Raised at their places, where the engine raises them (they are not hub kinds): Player Add
//   Item (AIPL) and Player Remove Item (REMP), Cast Magic (CAST), Dead Body (DEAD), Arrest
//   (ARRT), Actor Hello (AHEL), New Voice Power (NVPE). Those places call the methods here.
//
// The story manager queues what it is told and works through it in order (story-manager.ts).
// Platform-independent.

import type { GameEvents } from './event-hub.ts';
import { PLAYER_REF } from './forms.ts';
import type { ScriptRuntime } from './runtime.ts';
import type { StoryEventData } from './story-manager.ts';
import { ObjectHandle, type Value } from '../values.ts';

/** How the player came by an item (Player Add Item's V1: OnStoryAddToPlayer's aiAcquireType). */
export const AcquireType = {
  none: 0,
  /** Taken from the world when another owns it. */
  steal: 1,
  /** Bought from a merchant. */
  buy: 2,
  /** Taken from an actor's pockets. */
  pickpocket: 3,
  /** Taken from the world. */
  pickUp: 4,
  /** Taken from a container (or a living actor's inventory). */
  container: 5,
  /** Taken from a dead actor. */
  deadBody: 6,
} as const;

/** How an item left the player (Player Remove Item's V1: OnStoryRemoveFromPlayer's aiRemoveType). */
export const RemoveType = {
  none: 0,
  /** Dropped into the world. */
  drop: 4,
} as const;

/** One member of an event's data: a reference (R), a location (L), a form (F) or a number (V). */
type Member = readonly [key: string, value: number | undefined];

export class StoryEvents {
  readonly #runtime: ScriptRuntime;

  constructor(runtime: ScriptRuntime) {
    this.#runtime = runtime;
    runtime.events.on('actorLocationChange', (event) => this.#changeLocation(event));
  }

  /**
   * Change Location (CLOC): the player entered another location. Members: R1 the actor, L1 the
   * old location, L2 the new (OnStoryChangeLocation(akActor, akOldLocation, akNewLocation)).
   */
  #changeLocation(event: GameEvents['actorLocationChange']): Promise<boolean> | undefined {
    if (event.actor !== PLAYER_REF) return undefined;
    const runtime = this.#runtime;
    return this.#raise(
      'CLOC',
      [
        ['R1', event.actor],
        ['L1', event.from],
        ['L2', event.to],
      ],
      [runtime.referenceHandle(event.actor), this.#location(event.from), this.#location(event.to)],
    );
  }

  /**
   * Player Add Item (AIPL): the player took or bought an item. Members: R1 its owner (the actor
   * whose it was), R2 the container it came from, L1 the player's location, F1 the item, V1
   * how (AcquireType). The engine raises it as the player picks an item up (owned: a theft,
   * with its owner), takes one from a container, a pocket or a corpse, or buys one.
   */
  async addToPlayer(
    item: number,
    type: number,
    owner: number | undefined,
    container: number | undefined,
  ): Promise<boolean> {
    const runtime = this.#runtime;
    const location = await runtime.locationOf(PLAYER_REF);
    return this.#raise(
      'AIPL',
      [
        ['R1', owner],
        ['R2', container],
        ['L1', location],
        ['F1', item],
        ['V1', type],
      ],
      [
        runtime.referenceHandleOrNone(owner),
        runtime.referenceHandleOrNone(container),
        this.#location(location),
        runtime.formHandle(item),
        type,
      ],
    );
  }

  /** The player picked an item up from the world; `stolen`: another owns it (its owner told). */
  async pickedUp(item: number, reference: number, stolen: boolean): Promise<boolean> {
    const owner = stolen ? await this.#owner(reference) : undefined;
    return this.addToPlayer(
      item,
      stolen ? AcquireType.steal : AcquireType.pickUp,
      owner,
      undefined,
    );
  }

  /** The player took items from a container: a pocket picked, a corpse, a container or a living actor's inventory. */
  async takenFrom(item: number, container: number, pickpocket: boolean): Promise<boolean> {
    const actors = this.#runtime.actors;
    const type = pickpocket
      ? AcquireType.pickpocket
      : (await actors.isActor(container)) && (await actors.isDead(container))
        ? AcquireType.deadBody
        : AcquireType.container;
    return this.addToPlayer(item, type, await this.#owner(container), container);
  }

  /**
   * Whose a reference is, as a reference: an actor's own inventory its own, else its owner's
   * (an NPC's unique reference). TODO(M13): what the engine gives for a faction's ownership
   * (none here).
   */
  async #owner(reference: number): Promise<number | undefined> {
    const runtime = this.#runtime;
    if (await runtime.actors.isActor(reference)) return reference;
    const owner = await runtime.crime.ownerOf(reference);
    return owner.actor === undefined ? undefined : runtime.forms.uniqueReference(owner.actor);
  }

  /**
   * Player Remove Item (REMP): an item left the player. Members: R1 its owner (the player), R2
   * the item's reference (dropped: the one lying in the world), L1 the player's location, F1
   * the item, V1 how (RemoveType). The engine raises it as the player drops an item.
   */
  async removeFromPlayer(
    item: number,
    type: number,
    reference: number | undefined,
  ): Promise<boolean> {
    const runtime = this.#runtime;
    const location = await runtime.locationOf(PLAYER_REF);
    return this.#raise(
      'REMP',
      [
        ['R1', PLAYER_REF],
        ['R2', reference],
        ['L1', location],
        ['F1', item],
        ['V1', type],
      ],
      [
        runtime.referenceHandle(PLAYER_REF),
        runtime.referenceHandleOrNone(reference),
        this.#location(location),
        runtime.formHandle(item),
        type,
      ],
    );
  }

  /**
   * Cast Magic (CAST): an actor began to cast a spell (a hand's spell, a staff, a scroll, a
   * power, a shout's word). Members: R1 the caster, R2 its target, L1 the caster's location, F1
   * the spell. The engine raises it for any caster not in combat.
   */
  async castMagic(caster: number, target: number | undefined, spell: number): Promise<boolean> {
    const runtime = this.#runtime;
    if (runtime.world.combat?.(caster)?.inCombat === true) return false;
    const location = await runtime.locationOf(caster);
    return this.#raise(
      'CAST',
      [
        ['R1', caster],
        ['R2', target],
        ['L1', location],
        ['F1', spell],
      ],
      [
        runtime.referenceHandle(caster),
        runtime.referenceHandleOrNone(target),
        this.#location(location),
        runtime.formHandle(spell),
      ],
    );
  }

  /**
   * Dead Body (DEAD): an actor came upon a dead one. Members: R1 the actor, R2 the dead actor,
   * L1 the actor's location (OnStoryDiscoverDeadBody(akActor, akDeadActor, akLocation)).
   */
  async deadBody(actor: number, dead: number): Promise<boolean> {
    const runtime = this.#runtime;
    const location = await runtime.locationOf(actor);
    return this.#raise(
      'DEAD',
      [
        ['R1', actor],
        ['R2', dead],
        ['L1', location],
      ],
      [runtime.referenceHandle(actor), runtime.referenceHandle(dead), this.#location(location)],
    );
  }

  /**
   * Arrest (ARRT): a guard reached the criminal it arrests. Members: R1 the guard, R2 the
   * criminal, L1 the criminal's location, V1 the crime's type.
   */
  async arrest(guard: number, criminal: number, crime: number): Promise<boolean> {
    const runtime = this.#runtime;
    const location = await runtime.locationOf(criminal);
    return this.#raise(
      'ARRT',
      [
        ['R1', guard],
        ['R2', criminal],
        ['L1', location],
        ['V1', crime],
      ],
      [
        runtime.referenceHandle(guard),
        runtime.referenceHandle(criminal),
        this.#location(location),
        crime,
      ],
    );
  }

  /**
   * A guard reached the criminal it arrests (within reach to talk): Arrest, with the type of
   * the criminal's latest crime against the guard's crime faction (the engine's arrest carries
   * its crime; one for a bounty alone has none, and the engine's value is then 0).
   */
  async guardArrests(guard: number, criminal: number): Promise<boolean> {
    const runtime = this.#runtime;
    const faction = await runtime.actors.crimeFaction(guard);
    let crime = 0;
    for (const open of runtime.crime.ledger.open()) {
      if (open.criminal === criminal && open.faction === faction) crime = open.type;
    }
    return this.arrest(guard, criminal, crime);
  }

  /**
   * Actor Hello (AHEL): an actor turned its head to another actor (not the player), neither in
   * a scene. Members: L1 the actor's location, R1 the actor, R2 the other
   * (OnStoryHello(akLocation, akActor1, akActor2)).
   */
  async actorHello(actor: number, other: number): Promise<boolean> {
    const runtime = this.#runtime;
    const location = await runtime.locationOf(actor);
    return this.#raise(
      'AHEL',
      [
        ['L1', location],
        ['R1', actor],
        ['R2', other],
      ],
      [this.#location(location), runtime.referenceHandle(actor), runtime.referenceHandle(other)],
    );
  }

  /**
   * New Voice Power (NVPE): an actor came by a voice power (the player a shout: TeachWord's
   * first word of it; any actor a spell of the Voice Power type). Members: R1 the actor, F1 the
   * shout or spell.
   */
  newVoicePower(actor: number, power: number): Promise<boolean> {
    const runtime = this.#runtime;
    return this.#raise(
      'NVPE',
      [
        ['R1', actor],
        ['F1', power],
      ],
      [runtime.referenceHandle(actor), runtime.formHandle(power)],
    );
  }

  #location(location: number | undefined): Value {
    return location === undefined ? null : new ObjectHandle(location, 'location');
  }

  /** Tells the story manager (its queue); resolves true if the event started a quest. */
  #raise(type: string, members: readonly Member[], args: readonly Value[]): Promise<boolean> {
    const forms = new Map<string, number>();
    const values = new Map<string, number>();
    for (const [key, value] of members) {
      if (value === undefined) continue;
      (key.startsWith('V') ? values : forms).set(key, value);
    }
    const event: StoryEventData = { type, forms, values, args };
    return this.#runtime.storyManager.event(event);
  }
}
