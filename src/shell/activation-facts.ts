// What the crosshair's prompt rule (src/gameplay/activation-prompt.ts) reads of the running game
// that only the scripts' state answers: whether a container or corpse holds anything, whether
// the player holds a lock's key, a container's owner, an actor's race flags (Allow PC Dialogue,
// Allow Pickpocket), its commander, whether a race or actor is a mount. The prompt is asked every
// frame and must answer at once: each fact is known from the frame after it is first asked and
// read again now and then (an item taken, a key picked up), as the HUD's crosshair would show it.

import { RaceAiFlag } from '../ai/race-combat-records.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import { referenceName } from '../scripting/runtime/quest-text.ts';
import type { GameSession } from './game-session.ts';

/** How long a fact read stays before it is read again (ms). */
const FRESH_MS = 500;

/** KYWD ActorTypeHorse, ActorTypeDragon (Skyrim.esm): what one rides. */
const ACTOR_TYPE_HORSE = 0x26110;
const ACTOR_TYPE_DRAGON = 0x35d59;

/** DOBJ SPFK: the Special Furniture keyword (its sit markers say Use, not Sit). */
const SPECIAL_FURNITURE = 'SPFK';

/** A fact read in the background: the last answer, and when it was asked for. */
interface Kept<T> {
  value: T | undefined;
  read: number;
  busy: boolean;
}

/** What an actor's prompt reads of it. */
export interface ActorPromptState {
  readonly talks: boolean;
  readonly pickpocketable: boolean;
  readonly teammate: boolean;
  /** The name of the actor that commands it, if any. */
  readonly commander: string | undefined;
  /** It carries nothing (a corpse's sEmpty). */
  readonly empty: boolean;
}

export class ActivationFacts {
  readonly #session: GameSession;
  readonly #kept = new Map<string, Kept<unknown>>();

  constructor(session: GameSession) {
    this.#session = session;
  }

  /** A fact by key: its last answer (undefined until read), read again when stale. */
  #fact<T>(key: string, read: () => Promise<T>, fresh = FRESH_MS): T | undefined {
    let kept = this.#kept.get(key) as Kept<T> | undefined;
    if (!kept) {
      kept = { value: undefined, read: -Infinity, busy: false };
      this.#kept.set(key, kept);
    }
    const now = performance.now();
    if (!kept.busy && (kept.read === -Infinity || now - kept.read > fresh)) {
      kept.busy = true;
      kept.read = now;
      const entry = kept;
      read().then(
        (value) => {
          entry.value = value;
          entry.busy = false;
        },
        () => {
          entry.busy = false;
        },
      );
    }
    return kept.value;
  }

  /** Whether a container (or a corpse) holds nothing. */
  empty(reference: number): boolean | undefined {
    return this.#fact(`empty:${reference}`, async () => {
      const runtime = this.#session.scriptsReady;
      if (!runtime) return false;
      for (const count of (await runtime.inventory(reference)).values())
        if (count > 0) return false;
      return true;
    });
  }

  /** Whether the player holds an item (a lock's key). */
  playerHas(item: number): boolean {
    return (
      this.#fact(
        `has:${item}`,
        async () => ((await this.#session.scriptsReady?.itemCount(PLAYER_REF, item)) ?? 0) > 0,
      ) === true
    );
  }

  /** The name of a reference's owner (XOWN: an actor or a faction), if it has one. */
  ownerName(reference: number): string | undefined {
    const name = this.#fact(
      `owner:${reference}`,
      async () => {
        const runtime = this.#session.scriptsReady;
        if (!runtime) return '';
        // Its owner, else its cell's: an actor (its base's name), else a faction.
        const owner = await runtime.crime.ownerOf(reference);
        if (owner.actor !== undefined) {
          const record = await runtime.forms.record(owner.actor);
          if (record?.type === 'NPC_') return record.text('FULL') ?? '';
          return referenceName(runtime, owner.actor);
        }
        if (owner.faction === undefined) return '';
        return (await runtime.forms.record(owner.faction))?.text('FULL') ?? '';
      },
      5000,
    );
    return name === '' ? undefined : name;
  }

  /** Whether a furniture base carries the Special Furniture keyword (DOBJ SPFK). */
  specialFurniture(base: number): boolean {
    return (
      this.#fact(
        `special:${base}`,
        async () => {
          const keyword = (await this.#session.defaultObjects()).get(SPECIAL_FURNITURE);
          const runtime = this.#session.scriptsReady;
          return keyword !== undefined && runtime !== undefined
            ? runtime.hasKeyword(base, keyword)
            : false;
        },
        Infinity,
      ) === true
    );
  }

  /** What an actor is ridden as (its keywords, its base's and its race's), if it is a mount. */
  mountKind(reference: number): 'horse' | 'dragon' | undefined {
    const kind = this.#fact(
      `mount:${reference}`,
      async () => {
        const runtime = this.#session.scriptsReady;
        if (!runtime) return '';
        if (await runtime.hasKeyword(reference, ACTOR_TYPE_HORSE)) return 'horse';
        if (await runtime.hasKeyword(reference, ACTOR_TYPE_DRAGON)) return 'dragon';
        return '';
      },
      Infinity,
    );
    return kind === 'horse' || kind === 'dragon' ? kind : undefined;
  }

  /** An actor's facts for its prompt (its race's flags, its own state), once known. */
  actor(reference: number, race: number): ActorPromptState | undefined {
    const runtime = this.#session.scriptsReady;
    const flags = this.#fact(
      `race:${race}`,
      async () => {
        const data = (await this.#session.scriptsReady?.forms.record(race))?.fields.first('DATA');
        return data && data.length >= 36
          ? new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(32, true)
          : 0;
      },
      Infinity,
    );
    if (flags === undefined || !runtime) return undefined;
    const own = runtime.state.actors.get(reference);
    const commanderRef = runtime.magic.commander(reference);
    const commander =
      commanderRef === undefined
        ? undefined
        : this.#fact(`name:${commanderRef}`, () => referenceName(runtime, commanderRef), 5000);
    return {
      // Actor.AllowPCDialogue's setting, else the race's Allow PC Dialogue.
      talks: own?.allowPlayerDialogue ?? (flags & RaceAiFlag.allowPcDialogue) !== 0,
      pickpocketable: (flags & RaceAiFlag.allowPickpocket) !== 0,
      teammate: own?.playerTeammate === true,
      commander: commander === '' ? undefined : commander,
      empty: this.empty(reference) === true,
    };
  }
}
