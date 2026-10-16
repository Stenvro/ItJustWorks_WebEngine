// What actors' packages search the loaded area for (docs/ai.md, "Searching"): Find's search
// criteria, the food an actor eats, a target named by object (PTDA / PLDT type 1 and 2). A
// criterion names references by their object (a base object, a form list of them, a faction's
// members, an actor base) or by an object type (src/ai/object-types.ts: food, beds, melee
// weapons, ...); the search takes those within a radius of a place, nearest to the actor
// first, and, unless the actor may steal, only those it may use (src/scripting/runtime:
// mayUse). TODO(M13): how far round the engine searches where a place has no radius.

import { isOfObjectType, ObjectType } from '../ai/object-types.ts';
import { TargetType, type PackageTarget } from '../ai/package-records.ts';
import type { Vec3 } from '../render/math.ts';
import type { GameRecord } from '../world/record-db.ts';
import type { StageObject } from './actor-furniture.ts';
import type { GameSession } from './game-session.ts';

export interface ActorSearchOptions {
  readonly session: GameSession;
  /** The enabled objects and markers of the loaded area. */
  readonly objects: () => Iterable<StageObject>;
  /** The actors of the loaded area (their bases: placed and, for leveled ones, chosen). */
  readonly actors: () => Iterable<{
    readonly reference: number;
    readonly bases: readonly number[];
    readonly position: Vec3;
  }>;
}

export interface SearchRequest {
  /** Who searches: the nearest to it first; what it may use. */
  readonly actor: number;
  readonly from: Vec3;
  /** Where: within the radius of the centre. */
  readonly center: Vec3;
  readonly radius: number;
  /** It may take what is not its to use (Find's Allow Stealing). */
  readonly steal?: boolean;
}

/** A place without a radius is searched this far round (units). */
const NO_RADIUS = 256;

interface Candidate {
  readonly reference: number;
  readonly bases: readonly number[];
  readonly position: Vec3;
  readonly actor: boolean;
}

export class ActorSearch {
  readonly #options: ActorSearchOptions;
  readonly #records = new Map<number, Promise<GameRecord | undefined>>();

  constructor(options: ActorSearchOptions) {
    this.#options = options;
  }

  /**
   * The references a criterion names by object or object type within a request's place,
   * nearest to the searcher first (a specific reference, a linked one, an alias, self: the
   * package mind resolves those).
   */
  async find(criteria: PackageTarget, request: SearchRequest): Promise<number[]> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return [];
    const matches = await this.#matcher(criteria);
    if (!matches) return [];
    const radius = request.radius > 0 ? request.radius : NO_RADIUS;
    const found: { reference: number; distance: number }[] = [];
    for (const candidate of this.#candidates()) {
      if (candidate.reference === request.actor) continue;
      const [x, y, z] = candidate.position;
      const [cx, cy, cz] = request.center;
      if (Math.hypot(x - cx, y - cy, z - cz) > radius) continue;
      if (!(await matches(candidate))) continue;
      if (!candidate.actor && !request.steal) {
        if (!(await runtime.mayUse(request.actor, candidate.reference))) continue;
      }
      const [fx, fy, fz] = request.from;
      found.push({ reference: candidate.reference, distance: Math.hypot(x - fx, y - fy, z - fz) });
    }
    return found.sort((a, b) => a.distance - b.distance).map((entry) => entry.reference);
  }

  *#candidates(): Iterable<Candidate> {
    for (const object of this.#options.objects()) {
      yield {
        reference: object.reference,
        bases: [object.base],
        position: object.position,
        actor: false,
      };
    }
    for (const actor of this.#options.actors()) yield { ...actor, actor: true };
  }

  /** What a criterion asks of a candidate; undefined for criteria that name no object. */
  async #matcher(
    criteria: PackageTarget,
  ): Promise<((candidate: Candidate) => Promise<boolean>) | undefined> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return undefined;
    if (criteria.type === TargetType.objectType) {
      const type = criteria.value;
      return async (candidate) => {
        if (type === ObjectType.actorsAny) return candidate.actor;
        for (const base of candidate.bases) {
          const record = await this.#record(base);
          if (record && isOfObjectType(type, record)) return true;
        }
        return false;
      };
    }
    if (criteria.type !== TargetType.objectId) return undefined;
    const form = criteria.value;
    const record = await this.#record(form);
    if (record?.type === 'FLST') {
      // A form list: its references and base objects.
      const listed = new Set(await runtime.formList(form));
      return (candidate) =>
        Promise.resolve(
          listed.has(candidate.reference) || candidate.bases.some((base) => listed.has(base)),
        );
    }
    if (record?.type === 'FACT') {
      // A faction: its members.
      return async (candidate) =>
        candidate.actor && (await runtime.actors.factionRank(candidate.reference, form)) >= 0;
    }
    return (candidate) => Promise.resolve(candidate.bases.includes(form));
  }

  #record(formId: number): Promise<GameRecord | undefined> {
    let entry = this.#records.get(formId);
    if (!entry) {
      entry = this.#options.session.db.then((db) => db.get(formId)).catch(() => undefined);
      this.#records.set(formId, entry);
    }
    return entry;
  }
}
