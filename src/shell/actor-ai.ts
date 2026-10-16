// The AI of the actors of the loaded area (docs/ai.md, "Packages"): every living actor that
// moves by itself (src/shell/actor-movers.ts) runs its AI packages (src/ai/package-runtime.ts,
// the procedures: src/ai/procedure-runs.ts) once the running game's scripts are there: the
// game's time, quests and scripts choose its package; its controller goes where the package
// sends it. The scripts hear of it (OnPackageStart, OnPackageChange, OnPackageEnd and the
// packages' own fragments) and ask after it (GetCurrentPackage, EvaluatePackage).

import { ActorPackages, type PackageBody, type PackageMind } from '../ai/package-runtime.ts';
import { LocationType, TargetType, type PackageRecord } from '../ai/package-records.ts';
import { PROCEDURES } from '../ai/procedure-runs.ts';
import { parseIdleMarker } from '../ai/idle-records.ts';
import { RaceFlag } from '../world/actor-records.ts';
import { ObjectHandle } from '../scripting/values.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { seededRandom } from '../world/actors.ts';
import type { Vec3 } from '../render/math.ts';
import type { StagedActor } from './actor-stage.ts';
import type { ActorFurniture, FurnitureUser } from './actor-furniture.ts';
import type { ActorMovers } from './actor-movers.ts';
import type { GameSession } from './game-session.ts';

/** An "in cell" place reaches this far round where the actor is (game units). */
const IN_CELL_RADIUS = 1024;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class ActorAi {
  readonly #session: GameSession;
  readonly #movers: ActorMovers;
  readonly #furniture: ActorFurniture;
  readonly #userOf: (staged: StagedActor) => FurnitureUser;
  readonly #actors = new Map<number, { packages: ActorPackages; staged: StagedActor }>();
  readonly #mind: PackageMind;

  constructor(
    session: GameSession,
    movers: ActorMovers,
    furniture: ActorFurniture,
    userOf: (staged: StagedActor) => FurnitureUser,
  ) {
    this.#session = session;
    this.#movers = movers;
    this.#furniture = furniture;
    this.#userOf = userOf;
    this.#mind = this.#makeMind();
  }

  /** The package running for an actor now (GetCurrentPackage), if its AI runs. */
  current(reference: number): { id: number; procedure: string | undefined } | undefined {
    return this.#actors.get(reference)?.packages.current;
  }

  /** EvaluatePackage: the actor chooses its package again. */
  evaluate(reference: number): void {
    this.#actors.get(reference)?.packages.evaluate();
  }

  /** The actor leaves its AI (it left the stage, died). */
  remove(reference: number): void {
    const entry = this.#actors.get(reference);
    if (!entry) return;
    entry.packages.stop();
    this.#actors.delete(reference);
  }

  /**
   * Every frame (real seconds): the actors of the high process run their packages; those that
   * no longer are (far, dead, gone) leave them.
   */
  frame(actors: Iterable<StagedActor>, seconds: number): void {
    const runtime = this.#session.scriptsReady;
    const live = new Set<number>();
    for (const staged of actors) {
      if (!runtime || staged.dead || !this.#movers.inHighProcess(staged.reference)) continue;
      live.add(staged.reference);
      let entry = this.#actors.get(staged.reference);
      if (entry?.staged !== staged) {
        entry?.packages.stop();
        entry = {
          staged,
          packages: new ActorPackages(
            staged.reference,
            this.#mind,
            this.#body(staged),
            PROCEDURES,
            seededRandom(staged.reference ^ 0x2545f491),
          ),
        };
        this.#actors.set(staged.reference, entry);
      }
      entry.packages.update(seconds);
    }
    for (const reference of [...this.#actors.keys()]) {
      if (!live.has(reference)) this.remove(reference);
    }
  }

  /**
   * What an actor's packages move: its controller (travel, stop, turning) and the furniture
   * it uses (it gets up before it goes anywhere).
   */
  #body(staged: StagedActor): PackageBody {
    const movers = this.#movers;
    const furniture = this.#furniture;
    const reference = staged.reference;
    const user = this.#userOf(staged);
    const face = (heading: number | undefined): void => {
      movers.request(
        reference,
        heading === undefined ? undefined : { gait: 'walk', face: heading },
      );
    };
    return {
      reference,
      position: () => staged.position,
      heading: () => staged.heading,
      travel: async (to, gait, arrive) => {
        await furniture.leave(user);
        return movers.travel(reference, to, gait, arrive);
      },
      stop: () => {
        movers.stop(reference);
      },
      face,
      useFurniture: (target, types) =>
        furniture.use(
          user,
          target,
          (to, arrive) => movers.travel(reference, to, 'walk', arrive),
          face,
          types === undefined ? {} : { types },
        ),
      leaveFurniture: () => furniture.leave(user),
      takeIdleMarker: (marker) => furniture.takeMarker(reference, marker),
      leaveIdleMarker: () => {
        furniture.leaveMarker(user);
      },
      playIdle: (idle) => furniture.playIdle(user, idle),
    };
  }

  /** What the packages ask of the game: the running game's scripts and records. */
  #makeMind(): PackageMind {
    const session = this.#session;
    const runtime = (): ScriptRuntime | undefined => session.scriptsReady;
    const placementOf = async (
      reference: number,
    ): Promise<{ position: Vec3; heading: number } | undefined> => {
      const at = await runtime()?.placement(reference);
      return at && { position: [...at.position], heading: at.rotation[2] };
    };
    const staged = (actor: number): StagedActor | undefined => this.#actors.get(actor)?.staged;
    return {
      time: () => session.gameTime(),
      day: () => Math.floor(session.gameDaysPassed),
      package: async (formId) => (await session.packageData()).package(formId),
      packagesOf: async (actor) => {
        const data = await session.packageData();
        const own = staged(actor)?.placed.look.packages ?? [];
        // The packages of the quest aliases that hold it first, by quest priority. TODO(M10)
        // 3.1: its default package list (NPC_ DPLT) after its own.
        const aliases = runtime()
          ? await data.aliasPackages({
              reference: actor,
              base: 0,
              npc: 0,
              race: 0,
              female: false,
              factions: new Map(),
              packages: own,
              space: { kind: 'interior', cell: 0 },
              linked: () => undefined,
            })
          : [];
        return [...(aliases ?? []), ...own];
      },
      conditionsHold: async (conditions, actor, data) => {
        const scripts = runtime();
        if (!scripts || conditions.length === 0) return true;
        return scripts.conditionsHold(conditions, new ObjectHandle(actor, 'actor'), undefined, {
          packageData: (input) => {
            const value = data.inputs.get(input)?.value;
            if (value?.kind === 'bool') return value.value ? 1 : 0;
            if (value?.kind === 'int' || value?.kind === 'float') return value.value;
            return value === undefined ? undefined : 'none';
          },
          packageTarget: (input) => {
            const value = data.inputs.get(input)?.value;
            return value?.kind === 'singleRef' && value.target.type === TargetType.specificReference
              ? value.target.value
              : undefined;
          },
        });
      },
      place: async (location, actor) => {
        const scripts = runtime();
        const self = staged(actor);
        switch (location.type) {
          case LocationType.nearReference: {
            const at = await placementOf(location.form);
            return at && { ...at, radius: location.radius, reference: location.form };
          }
          case LocationType.nearLinkedReference: {
            const linked = await scripts?.linkedReference(actor, location.form);
            const at = linked === undefined ? undefined : await placementOf(linked);
            return at && { ...at, radius: location.radius, reference: linked };
          }
          case LocationType.nearEditorLocation: {
            const at = await scripts?.editorPlacement(actor);
            return (
              at && {
                position: [...at.position],
                radius: location.radius,
                heading: at.rotation[2],
              }
            );
          }
          case LocationType.inCell: {
            // Anywhere in the cell: round the actor, if it is in that cell.
            const at = await scripts?.placement(actor);
            return self && at?.cell === location.form
              ? { position: self.position, radius: Math.max(location.radius, IN_CELL_RADIUS) }
              : undefined;
          }
          // TODO(M10) 3.1: where the package started (here: where it is).
          case LocationType.nearPackageStart:
          case LocationType.nearSelf:
            return self && { position: self.position, radius: location.radius };
          default:
            // Alias references and locations, objects found by searching: TODO(M10) 3.2.
            return undefined;
        }
      },
      target: async (target, actor) => {
        const scripts = runtime();
        switch (target.type) {
          case TargetType.specificReference:
            return target.value === 0 ? undefined : target.value;
          case TargetType.linkedReference:
            return scripts?.linkedReference(actor, target.value);
          case TargetType.self:
            return actor;
          default:
            // Objects and types found by searching, alias references: TODO(M10) 3.2.
            return undefined;
        }
      },
      placement: placementOf,
      linked: async (reference, keyword) => runtime()?.linkedReference(reference, keyword),
      around: (center, radius, actor) => {
        const flags = staged(actor)?.placed.look.raceFlags ?? 0;
        return this.#furniture.spots(center, radius, (flags & RaceFlag.child) !== 0);
      },
      idleMarker: async (reference) => {
        const scripts = runtime();
        const base = await scripts?.baseOf(reference);
        const record = base === undefined ? undefined : await scripts?.forms.record(base);
        const at = await placementOf(reference);
        if (record?.type !== 'IDLM' || !at) return undefined;
        return { ...parseIdleMarker(record), reference, ...at };
      },
      packageEvent: (actor, event, pack) => {
        void this.#packageEvent(actor, event, pack);
      },
    };
  }

  /**
   * The scripts hear of a package: the actor's OnPackageStart (the new package), OnPackageChange
   * (the one left), OnPackageEnd (one that ended), and the package's own fragments (begin as it
   * starts, change as it is left, end as it ends).
   */
  async #packageEvent(
    actor: number,
    event: 'begin' | 'change' | 'end',
    pack: PackageRecord,
  ): Promise<void> {
    const scripts = this.#session.scriptsReady;
    if (!scripts) return;
    try {
      const handle = (record: PackageRecord): ObjectHandle =>
        new ObjectHandle(record.formId, 'package');
      if (event === 'begin') {
        await scripts.sendEvent(actor, 'OnPackageStart', [handle(pack)]);
      } else if (event === 'change') {
        await scripts.sendEvent(actor, 'OnPackageChange', [handle(pack)]);
      } else {
        await scripts.sendEvent(actor, 'OnPackageEnd', [handle(pack)]);
      }
      const attachments = await scripts.forms.attachments(pack.formId);
      for (const fragment of attachments?.fragments ?? []) {
        if (fragment.stage !== event) continue;
        await scripts.vm.call(new ObjectHandle(pack.formId, fragment.script), fragment.function, [
          scripts.referenceHandle(actor),
        ]);
      }
    } catch (error) {
      scripts.vm.warn(`package ${pack.editorId}: ${describe(error)}`);
    }
  }
}
