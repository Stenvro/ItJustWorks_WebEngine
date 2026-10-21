// What spells, staffs, scrolls and shouts send flying (docs/ai.md, "Magic in combat"; the
// rules: src/gameplay/magic/projectile-flight.ts): a cast's projectile (its costliest effect's
// MGEF projectile, PROJ) leaves the caster's hand (the voice: its head) along the aim. Missiles,
// lobbers and arrow-like bolts fly through the physics steps, drawn as their model, sounding
// their flight sound, until they meet a surface (the physics world, the spell layer), an actor
// (its ragdoll bodies' owner, or its capsule) or their range; beams reach at once; flames are a
// concentration spell's sprays; cones sweep every actor within their spread at once. Where one
// ends: the actor hit takes the spell (the casting engine's deliver: wards, absorption, OnHit,
// skill), a Target Location spell takes effect there (summons, runes), the explosion bursts (its
// sound, the casting engine's explode), the area reaches those near (area), the effect's impact
// data set sounds on the surface hit, and the impact's sound level is a noise for detection.
// TODO(M11) visuals: the projectiles' lights (PROJ light, muzzle flash), the explosions' and
// impacts' models and decals, beams and cones drawn, the casting art in the hands (MGEF casting
// art, dual-cast art).

import {
  flightKind,
  inCone,
  launchFlight,
  normalize,
  pathHitsActor,
  pointAt,
  stepFlight,
  withinProximity,
  type ActorShape,
  type Flight,
} from '../gameplay/magic/projectile-flight.ts';
import { EntryPoint } from '../gameplay/perk-entry-points.ts';
import { Layer } from '../physics/collision-layers.ts';
import type { PhysicsWorld } from '../physics/physics-world.ts';
import type { Vec3 } from '../render/math.ts';
import type { Renderer } from '../render/renderer.ts';
import type { GpuScene, InstanceMotion, ModelInstance } from '../render/scene-renderer.ts';
import type { Delivered } from '../scripting/runtime/casting-engine.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { SoundInstance } from '../audio/sound-instance.ts';
import { meshPath } from '../world/actors.ts';
import { referenceMatrix } from '../world/cell-loader.ts';
import { EffectArchetype, type MagicEffectRecord } from '../world/magic-effects.ts';
import { Delivery } from '../world/magic-records.ts';
import { ProjectileFlag, type ProjectileRecord } from '../world/projectile-data.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

/** Something projectiles can meet: an actor and its shape now. */
export interface ProjectileTarget {
  readonly reference: number;
  readonly shape: ActorShape;
  /** Which way it faces (radians about z: a ward meets what comes from the front). */
  readonly heading: number;
}

export interface MagicProjectilesOptions {
  readonly session: GameSession;
  readonly renderer: Renderer;
  readonly terminal: Terminal;
  /** The living actors of the loaded area (the player too). */
  readonly targets: () => Iterable<ProjectileTarget>;
  /** A sound at a place is a noise the actors may hear (src/shell/actor-senses.ts). */
  readonly noise?: (at: Vec3, owner: number | undefined, soundLevel: number) => void;
  /** A hostile spell took hold on an actor (who was attacked, by whom). */
  readonly hit?: (target: number, caster: number) => void;
}

/** One projectile on its way. */
interface Flying {
  readonly delivered: Delivered;
  readonly projectile: ProjectileRecord;
  readonly effect: MagicEffectRecord | undefined;
  readonly flight: Flight;
  /** A concentration spray: the seconds of the spell it carries. */
  readonly seconds: number | undefined;
  /** Drawn: its instance (moved each frame) and scene. */
  instance: ModelInstance | undefined;
  scene: GpuScene | undefined;
  readonly motion: InstanceMotion;
  sound: Promise<SoundInstance | undefined> | undefined;
  done: boolean;
}

/** How far a ray steps past a caster's own bodies it starts inside (units, tries). */
const SELF_STEP = 4;
const SELF_TRIES = 8;

/** A projectile is at least this wide to those who see it coming (units). */
const THREAT_RADIUS = 8;

/** A human's capsule where a mover has none (units; TODO(M13): the race's bounds). */
const DEFAULT_HEIGHT = 128;
const DEFAULT_RADIUS = 24;

/** Physics layers that are actors (their hits are the actor's, not a surface's). */
const ACTOR_LAYERS: ReadonlySet<number> = new Set([
  Layer.biped,
  Layer.bipedNoCc,
  Layer.charController,
  Layer.deadBip,
]);

/** Archetypes a Target Location spell places where it lands. */
const PLACING: ReadonlySet<number> = new Set([
  EffectArchetype.summonCreature,
  EffectArchetype.spawnHazard,
  EffectArchetype.spawnScriptedRef,
]);

/** The capsule of an actor of a given height and scale (projectile-flight's ActorShape). */
export function actorShape(feet: Vec3, height: number | undefined, scale = 1): ActorShape {
  return {
    feet,
    height: height ?? DEFAULT_HEIGHT * scale,
    radius: DEFAULT_RADIUS * scale,
  };
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class MagicProjectiles {
  readonly #options: MagicProjectilesOptions;
  readonly #flying = new Set<Flying>();
  #physics: PhysicsWorld | undefined;

  constructor(options: MagicProjectilesOptions) {
    this.#options = options;
  }

  /** The physics world they fly in (undefined: the play ended; they are gone). */
  attach(physics: PhysicsWorld | undefined): void {
    this.#physics = physics;
    if (!physics) this.clear();
  }

  /**
   * What flies now, as the actors see it coming (the combat AI's threats: what they sidestep):
   * where each is, its way, how wide (its collision radius, at least a hand's), whose.
   */
  *threats(): Iterable<{
    readonly key: object;
    readonly position: Vec3;
    readonly velocity: Vec3;
    readonly radius: number;
    readonly source: number | undefined;
  }> {
    for (const flying of this.#flying) {
      if (flying.done) continue;
      yield {
        key: flying,
        position: flying.flight.position,
        velocity: flying.flight.velocity,
        radius: Math.max(THREAT_RADIUS, flying.projectile.collisionRadius),
        source: flying.delivered.caster,
      };
    }
  }

  /** Their drawn scenes. */
  *scenes(): Iterable<GpuScene> {
    for (const flying of this.#flying) if (flying.scene) yield flying.scene;
  }

  /**
   * A cast leaves `origin` along `direction` (a fire and forget spell released, a concentration
   * spell's spray with the `seconds` it carries, a shout, a script's cast). `target`: the actor
   * aimed at (a Target Actor spell reaches it; a Touch spell or one without a projectile
   * reaches it at once). Resolves once it is on its way.
   */
  async launch(
    delivered: Delivered,
    origin: Vec3,
    direction: Vec3,
    options: { readonly target?: number | undefined; readonly seconds?: number } = {},
  ): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return;
    const casting = runtime.casting;
    const effect = await casting.mainEffect(delivered.item);
    let projectile =
      effect?.projectile === undefined ? undefined : await casting.projectile(effect.projectile);
    // A Target Location spell reaches as far as its caster's perks let it (Mod Spell Range
    // (Target Loc.): Rune Master, five times).
    if (projectile && delivered.item.delivery === Delivery.targetLocation) {
      const range = await runtime.perks.apply(
        EntryPoint.modSpellRangeTargetLoc,
        delivered.caster,
        projectile.range,
        [delivered.item.formId],
        { spell: delivered.item.formId },
      );
      if (range !== projectile.range) projectile = { ...projectile, range };
    }
    const seconds = options.seconds;
    const at = (reference: number): Promise<number> =>
      this.#reach(runtime, delivered, reference, {
        ...(seconds !== undefined && { seconds }),
      });
    const delivery = delivered.item.delivery;
    // A Self spell is its caster's; a Touch spell (or one without a projectile) reaches the
    // actor aimed at.
    if (delivery === Delivery.self) {
      await at(delivered.caster);
      return;
    }
    if (!projectile || delivery === Delivery.touch) {
      if (options.target !== undefined) await at(options.target);
      else if (delivery === Delivery.targetLocation)
        await casting.deliver(delivered, delivered.caster);
      return;
    }
    const aim = normalize(direction);
    switch (flightKind(projectile)) {
      case 'cone':
        await this.#cone(runtime, delivered, projectile, origin, aim, seconds);
        return;
      case 'instant':
        await this.#instant(runtime, delivered, projectile, effect, origin, aim, seconds);
        return;
      default:
        this.#fly(delivered, projectile, effect, origin, aim, seconds);
    }
  }

  /** The spell reaches an actor; a hostile one that took hold is a hit (who attacked whom). */
  async #reach(
    runtime: ScriptRuntime,
    delivered: Delivered,
    target: number,
    options: { readonly facing?: boolean; readonly seconds?: number },
  ): Promise<number> {
    const applied = await runtime.casting.deliver(delivered, target, options);
    if (applied > 0 && target !== delivered.caster && (await runtime.magic.hostile(delivered.item)))
      this.#options.hit?.(target, delivered.caster);
    return applied;
  }

  /** A missile, lobber, bolt or spray takes flight (drawn as its model, with its sound). */
  #fly(
    delivered: Delivered,
    projectile: ProjectileRecord,
    effect: MagicEffectRecord | undefined,
    origin: Vec3,
    aim: Vec3,
    seconds: number | undefined,
  ): void {
    const { session, renderer, terminal } = this.#options;
    const flying: Flying = {
      delivered,
      projectile,
      effect,
      flight: launchFlight(projectile, origin, aim),
      seconds,
      instance: undefined,
      scene: undefined,
      motion: { version: 0 },
      sound: undefined,
      done: false,
    };
    this.#flying.add(flying);
    if (projectile.sound !== undefined) {
      flying.sound = session.soundSystem?.play(projectile.sound, () => flying.flight.position);
    }
    const path = projectile.model;
    if (!path) return;
    session
      .model(meshPath(path))
      .then((model) => {
        if (!model || flying.done) return;
        const instance: ModelInstance = {
          model,
          world: placementOf(flying.flight),
          motion: flying.motion,
        };
        flying.instance = instance;
        flying.scene = renderer.scene.createScene([instance]);
      })
      .catch((error: unknown) => {
        terminal.log('magic', `${projectile.editorId}: ${describe(error)}`, 'warn');
      });
  }

  /** A beam (or hitscan): the first surface or actor along its range, at once. */
  async #instant(
    runtime: ScriptRuntime,
    delivered: Delivered,
    projectile: ProjectileRecord,
    effect: MagicEffectRecord | undefined,
    origin: Vec3,
    aim: Vec3,
    seconds: number | undefined,
  ): Promise<void> {
    const range = projectile.range > 0 ? projectile.range : 10000;
    const end: Vec3 = pointAt(
      origin,
      [origin[0] + aim[0], origin[1] + aim[1], origin[2] + aim[2]],
      range,
    );
    const hit = this.#sweep(delivered.caster, origin, end, projectile.collisionRadius);
    const point = hit ? pointAt(origin, end, hit.t) : end;
    await this.#impact(runtime, delivered, projectile, effect, point, aim, hit, seconds);
  }

  /**
   * A cone (Unrelenting Force): every actor within its range and spread that it can see from
   * its apex takes the spell at once.
   */
  async #cone(
    runtime: ScriptRuntime,
    delivered: Delivered,
    projectile: ProjectileRecord,
    origin: Vec3,
    aim: Vec3,
    seconds: number | undefined,
  ): Promise<void> {
    const range = projectile.range > 0 ? projectile.range : 1000;
    for (const target of [...this.#options.targets()]) {
      if (target.reference === delivered.caster) continue;
      if (!inCone(origin, aim, range, projectile.coneSpread, target.shape)) continue;
      const middle: Vec3 = [
        target.shape.feet[0],
        target.shape.feet[1],
        target.shape.feet[2] + target.shape.height / 2,
      ];
      if (this.#blocked(delivered.caster, origin, middle)) continue;
      await this.#reach(runtime, delivered, target.reference, {
        facing: facing(target, origin),
        ...(seconds !== undefined && { seconds }),
      });
    }
    // Its sound from its apex (TODO(M11) visuals: the cone drawn).
    if (projectile.sound !== undefined)
      void this.#options.session.soundSystem?.play(projectile.sound, origin);
  }

  /** Whether a surface stands between two points (line of sight for cones and areas). */
  #blocked(caster: number, from: Vec3, to: Vec3): boolean {
    const physics = this.#physics;
    if (!physics) return false;
    const direction: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const distance = Math.hypot(...direction);
    const hit = physics.raycast(from, direction, distance, Layer.spell);
    return (
      hit !== undefined &&
      !ACTOR_LAYERS.has(hit.layer) &&
      hit.owner?.kind !== 'actor' &&
      hit.owner?.reference !== caster
    );
  }

  /**
   * What a path from `from` to `to` meets first: an actor (its capsule, or its bodies in the
   * physics world) or a surface; the caster's own bodies are passed through.
   */
  #sweep(
    caster: number,
    from: Vec3,
    to: Vec3,
    radius: number,
  ):
    | {
        readonly t: number;
        readonly actor?: ProjectileTarget;
        readonly material: number;
        readonly kind: 'object' | 'landscape' | 'actor' | undefined;
        readonly normal?: Vec3;
      }
    | undefined {
    let best:
      | {
          t: number;
          actor?: ProjectileTarget;
          material: number;
          kind: 'object' | 'landscape' | 'actor' | undefined;
          normal?: Vec3;
        }
      | undefined;
    const targets = new Map<number, ProjectileTarget>();
    for (const target of this.#options.targets()) {
      targets.set(target.reference, target);
      if (target.reference === caster) continue;
      const t = pathHitsActor(from, to, radius, target.shape);
      if (t !== undefined && (!best || t < best.t))
        best = { t, actor: target, material: 0, kind: 'actor' };
    }
    const physics = this.#physics;
    const length = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    if (!physics || length <= 0) return best;
    const direction: Vec3 = [
      (to[0] - from[0]) / length,
      (to[1] - from[1]) / length,
      (to[2] - from[2]) / length,
    ];
    let start = 0;
    for (let tries = 0; tries < SELF_TRIES && start < length; tries++) {
      const origin = pointAt(from, to, start / length);
      const hit = physics.raycast(origin, direction, length - start, Layer.spell);
      if (!hit) break;
      const distance = start + hit.distance;
      const owner = hit.owner;
      // The caster's own bodies (an actor's arm, a trap's casting object) are passed through.
      if (owner !== undefined && owner.kind !== 'landscape' && owner.reference === caster) {
        start = distance + SELF_STEP;
        continue;
      }
      const t = distance / length;
      if (best && best.t <= t) break;
      const actor =
        owner?.kind === 'actor' || ACTOR_LAYERS.has(hit.layer)
          ? owner && targets.get(owner.reference)
          : undefined;
      if (actor) best = { t, actor, material: 0, kind: 'actor' };
      else if (!ACTOR_LAYERS.has(hit.layer))
        best = { t, material: hit.material, kind: owner?.kind, normal: hit.normal };
      break;
    }
    return best;
  }

  /** Every frame: the flying fly on; those that met something or ran out end there. */
  frame(seconds: number): void {
    if (seconds <= 0 || this.#flying.size === 0) return;
    const runtime = this.#options.session.scriptsReady;
    for (const flying of [...this.#flying]) {
      if (flying.done) continue;
      const { from, to } = stepFlight(flying.flight, seconds);
      const hit = this.#sweep(flying.delivered.caster, from, to, flying.projectile.collisionRadius);
      // Its alternative trigger: within its proximity of an actor it bursts.
      const near =
        !hit &&
        (flying.projectile.flags & ProjectileFlag.altTrigger) !== 0 &&
        [...this.#options.targets()].some(
          (target) =>
            target.reference !== flying.delivered.caster &&
            withinProximity(flying.projectile, to, target.shape),
        );
      if (hit || near || flying.flight.spent) {
        const point = hit ? pointAt(from, to, hit.t) : to;
        flying.flight.position = point;
        this.#end(flying);
        if (runtime) {
          const aim = normalize(flying.flight.velocity);
          void this.#impact(
            runtime,
            flying.delivered,
            flying.projectile,
            flying.effect,
            point,
            aim,
            hit,
            flying.seconds,
          ).catch((error: unknown) => {
            this.#options.terminal.log('magic', `impact: ${describe(error)}`, 'warn');
          });
        }
        continue;
      }
      if (flying.instance) {
        flying.instance.world.set(placementOf(flying.flight));
        flying.motion.version++;
      }
    }
  }

  /**
   * Where a projectile ends: the actor hit takes the spell, a Target Location spell takes effect
   * there, its explosion bursts, its area reaches those near, its impact sounds on the surface.
   */
  async #impact(
    runtime: ScriptRuntime,
    delivered: Delivered,
    projectile: ProjectileRecord,
    effect: MagicEffectRecord | undefined,
    point: Vec3,
    aim: Vec3,
    hit:
      | {
          readonly actor?: ProjectileTarget;
          readonly material: number;
          readonly kind: 'object' | 'landscape' | 'actor' | undefined;
        }
      | undefined,
    seconds: number | undefined,
  ): Promise<void> {
    const casting = runtime.casting;
    const { session, noise } = this.#options;
    const actor = hit?.actor;
    const reached = hit !== undefined || (projectile.flags & ProjectileFlag.explosion) !== 0;
    if (delivered.item.delivery === Delivery.targetLocation) {
      // A Target Location spell makes what it makes where it landed, on whatever it met or
      // where it ran out (a summon, a hazard: magic-engine's `at`); its other effects reach
      // those near by its explosion and area.
      const effects: number[] = [];
      for (const [index, entry] of delivered.item.effects.entries()) {
        const archetype = (await runtime.magic.effect(entry.effect))?.archetype;
        if (archetype !== undefined && PLACING.has(archetype)) effects.push(index);
      }
      if (effects.length > 0)
        await casting.deliver(delivered, delivered.caster, { at: point, effects });
    } else if (actor) {
      await this.#reach(runtime, delivered, actor.reference, {
        facing: facing(actor, [point[0] - aim[0], point[1] - aim[1], point[2] - aim[2]]),
        ...(seconds !== undefined && { seconds }),
      });
    }
    // Its explosion (the projectile's, with the Explosion flag; else the effect's).
    const explosion =
      ((projectile.flags & ProjectileFlag.explosion) !== 0 ? projectile.explosion : undefined) ??
      effect?.explosion;
    if (explosion !== undefined && reached) {
      const record = await casting.explosion(explosion);
      if (record?.sound !== undefined) void session.soundSystem?.play(record.sound, point);
      if (record?.sound2 !== undefined) void session.soundSystem?.play(record.sound2, point);
      await casting.explode(delivered.caster, explosion, point);
      noise?.(point, delivered.caster, record?.soundLevel ?? 1);
    }
    if (reached) {
      await casting.area(delivered, point, {
        ...(actor && { exclude: actor.reference }),
        ...(seconds !== undefined && { seconds }),
      });
    }
    // The effect's impact on the surface hit (MGEF impact data set: its sound, a noise).
    if (hit && !actor && effect?.impactData !== undefined) {
      const impact = await session.soundSystem?.impactOfSet(
        effect.impactData,
        hit.material,
        hit.kind,
        point,
      );
      if (impact) noise?.(point, delivered.caster, impact.soundLevel);
    }
  }

  #end(flying: Flying): void {
    flying.done = true;
    this.#flying.delete(flying);
    flying.scene?.destroy();
    flying.scene = undefined;
    void flying.sound?.then((sound) => sound?.stop());
  }

  /** Every projectile goes (the play ended, the view changed). */
  clear(): void {
    for (const flying of [...this.#flying]) this.#end(flying);
  }
}

/** A flying projectile's world matrix: at its position, along its velocity. */
function placementOf(flight: Flight): Float32Array {
  const [vx, vy, vz] = flight.velocity;
  const yaw = Math.atan2(vx, vy);
  const pitch = Math.atan2(vz, Math.hypot(vx, vy));
  return referenceMatrix({ position: flight.position, rotation: [-pitch, 0, yaw], scale: 1 });
}

/** Whether a target faces a point (within 90° of its heading: a ward meets it). */
function facing(target: ProjectileTarget, from: Vec3): boolean {
  const dx = from[0] - target.shape.feet[0];
  const dy = from[1] - target.shape.feet[1];
  if (dx === 0 && dy === 0) return true;
  const toward = Math.atan2(dx, dy);
  const delta = Math.atan2(Math.sin(toward - target.heading), Math.cos(toward - target.heading));
  return Math.abs(delta) <= Math.PI / 2;
}
