// What the actors of the loaded area notice (docs/ai.md, "Detection"; docs/m10-plan.md 4.1):
// every actor of the high process tests the player and the other actors of the high process
// every fDetectionUpdateTimeMin to Max seconds (the nearer the player, the more often) with
// the detection formula (src/ai/detection.ts): its eyes against the target's head and chest
// through the physics world (rays on the line-of-sight layer, L_LINEOFSIGHT: what it collides
// with blocks sight, a bucket on the head too), its view cone, the distance, the light on the
// target (src/ai/light-level.ts: the view's lighting there, the sun where nothing is between),
// how the target moves (walking, running, sneaking, swimming), the armour it wears, the noise
// of its actions, and the two Sneak skills. Each pair's state (src/ai/detection-states.ts)
// moves and is told: the stealth eye on the HUD (src/shell/hud-stealth.ts), OnGainLOS /
// OnLostLOS for the pairs scripts watch, the detection natives and conditions (through
// ScriptWorld.senses), the actors' reactions (searching what they noticed or heard, the dead,
// spectating fights, guards' warnings: src/ai/reactions.ts, or the packages of their override
// lists, NPC_ / alias SPOR, OCOR, GWOR), and the API combat (5.2) and crime (M11) build on:
// `detections` (who detects whom and how much, events), `noise` (a detection event: who heard
// a noise where), `action` (an attack's or a spell's sound), `attacked`, `fight` (spectators),
// `warn`, and Detections' `witness` / `offence` (the player seen stealing, trespassing, ...).

import {
  angleOff,
  detectionLevel,
  detectionLight,
  detectionReach,
  detectionSkill,
  eventDistance,
  eventLevel,
  inViewCone,
  loudness,
  movementNoise,
  readDetectionSettings,
  sightReach,
  type DetectionLevel,
  type DetectionSettings,
  type Observer,
  type Target,
} from '../ai/detection.ts';
import { EntryPoint } from '../gameplay/perk-entry-points.ts';
import { aliasOverrideLists } from '../ai/detection-records.ts';
import type { DetectionReport } from '../ai/combat-groups.ts';
import { Detections, type DetectionEvent, type WitnessedAct } from '../ai/detection-states.ts';
import { brightestAmbient, lightLevel, type LightProbe } from '../ai/light-level.ts';
import { InterruptFlag, PackageFlag, type PackageRecord } from '../ai/package-records.ts';
import {
  parseNpcCombat,
  parseRaceCombat,
  RaceSize,
  type OverridePackageLists,
} from '../ai/race-combat-records.ts';
import { Reaction, type ReactionKind } from '../ai/reactions.ts';
import type { CharacterBody } from '../physics/character.ts';
import { Layer } from '../physics/collision-layers.ts';
import type { Vec3 } from '../render/math.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ActorMotion, ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { TemplateFlag } from '../world/actor-records.ts';
import { resolveActorTemplates } from '../world/actor-templates.ts';
import { actorValueIndex } from '../world/actor-values.ts';
import { seededRandom } from '../world/actors.ts';
import { parseItem } from '../world/item-records.ts';
import type { ActorAi } from './actor-ai.ts';
import type { ActorFurniture } from './actor-furniture.ts';
import type { ActorMovers, MoverWorld } from './actor-movers.ts';
import type { StagedActor } from './actor-stage.ts';
import type { GameSession } from './game-session.ts';
import type { StealthReading } from './hud-stealth.ts';
import type { ScriptSenses } from './script-world.ts';

/** The play the senses work in: its physics, and the player as detection sees them. */
export interface SensesWorld extends MoverWorld {
  readonly player?: {
    readonly character: CharacterBody;
    sneaking: boolean;
    readonly yaw: number;
    readonly eye: Vec3;
  };
  playerMotion?(): ActorMotion;
}

export interface ActorSensesOptions {
  readonly session: GameSession;
  readonly movers: ActorMovers;
  readonly furniture: ActorFurniture;
  readonly ai: ActorAi;
  /** The actors of the loaded area, and one by its reference. */
  readonly actors: () => Iterable<StagedActor>;
  readonly get: (reference: number) => StagedActor | undefined;
  /** The view's lighting near a place (undefined: unlit, as the dark). */
  readonly light?: (at: Vec3) => LightProbe | undefined;
  /** The view shows an interior (detection's reach and light inside). */
  readonly interior: boolean;
  /** The projectiles in flight (arrows, bolts, spells) and who sent them. */
  readonly projectiles?: () => Iterable<{
    readonly position: Vec3;
    readonly source: number | undefined;
  }>;
  /**
   * An actor says a line of a topic subtype (by name or code) to a target (src/shell/actor-talk.ts,
   * bark).
   */
  readonly bark?: (actor: number, subtype: string, target: number | undefined) => Promise<boolean>;
  /** The camera (the player's sight for OnGainLOS: what is on screen). */
  readonly camera?: () =>
    { readonly position: Vec3; readonly forward?: Vec3; readonly fovY?: number } | undefined;
  /** Whether an actor flies now (noticed fSneakFlyingDistanceMult times as far). */
  readonly flying?: (actor: number) => boolean;
}

/** What detection weighs of an actor that is read now and then (its values, gear, race). */
interface Profile {
  /** Its Sneak skill as detection counts it (the player's: detectionSkill). */
  readonly skill: number;
  /** ... as a target, with its perks (Mod Detection Sneak Skill). */
  readonly sneak: number;
  readonly blindness: number;
  readonly nightEye: boolean;
  readonly invisible: boolean;
  readonly noiseMult: number;
  readonly armourWeight: number;
  readonly size: number;
  readonly teammate: boolean;
  readonly overrides: OverridePackageLists | undefined;
  /**
   * As a target, its perks' factors on the light on it and on how its moving shows (Mod
   * Detection Light, Movement: the engine asks the target's perks), and whether its running
   * does not count (Ignore Running During Detection; nor its moving while it sneaks).
   */
  readonly lightMult: number;
  readonly movementMult: number;
  readonly ignoreRunning: boolean;
}

const DEFAULT_PROFILE: Profile = {
  skill: 15,
  sneak: 15,
  blindness: 0,
  nightEye: false,
  invisible: false,
  noiseMult: 1,
  armourWeight: 0,
  size: RaceSize.medium,
  teammate: false,
  overrides: undefined,
  lightMult: 1,
  movementMult: 1,
  ignoreRunning: false,
};

/** An actor as the senses see it now. */
interface Body {
  readonly reference: number;
  readonly feet: Vec3;
  readonly heading: number;
  readonly eye: Vec3;
  readonly chest: Vec3;
  /** Its height as it stands, sits or lies (units): where lines of sight aim at it. */
  readonly height: number;
  readonly sleeping: boolean;
  readonly motion: ActorMotion | undefined;
}

/** An actor's profile is read again this often (seconds). */
const PROFILE_SECONDS = 3;
/** The light on an actor is measured again this often (seconds). */
const LIGHT_SECONDS = 0.5;
/** A pair's sight is kept this long (seconds). */
const SIGHT_SECONDS = 0.25;
/** The pairs scripts watch (RegisterForLOS) are looked at this often (seconds). */
const LOS_WATCH_SECONDS = 0.25;
/** A detection test this recent answers GetDetected (else it is made anew; seconds). */
const FRESH_SECONDS = 1;
/** An actor without a controller is this tall (units, times its scale; a human's bound). */
const ACTOR_HEIGHT = 128;
/** Its eyes and chest are at these shares of its height: standing, sitting, lying. */
const EYES = { standing: 0.92, sitting: 0.62, lying: 0.2 } as const;
const CHEST = { standing: 0.6, sitting: 0.42, lying: 0.15 } as const;
/** The sun is looked for this far along its direction (units). */
const SUN_RAY = 8192;
/** A sight ray counts as reaching what it aimed at within this of it (units). */
const RAY_SLACK = 16;
/** The camera's frame is about this wide against its height (OnGainLOS for the player). */
const SCREEN_ASPECT = 16 / 9;
/** A camera that does not say its field of view sees this far either side (radians). */
const SCREEN_HALF_WIDTH = (50 * Math.PI) / 180;
/** A reference that is not an actor is looked at this far over its origin (units). */
const OBJECT_LIFT = 16;
/** A fight is over (for spectators) once its last blow is this old with none since (seconds). */
const FIGHT_SECONDS = 1;
/** The level of a target beyond detection's reach (the engine's). */
const OUT_OF_REACH = -1000;
/** A projectile seen passing is an event of this loudness (the engine's). */
const PROJECTILE_LOUDNESS = 50;
/**
 * Lines of sight aim at these shares of a target's height (the engine's): its head; an
 * important target's middle, head and legs, in that order. A sneaking target is this much as tall.
 */
const LOS_POINTS = [0.85] as const;
const LOS_POINTS_IMPORTANT = [0.5, 0.85, 0.15] as const;
const SNEAKING_HEIGHT = 0.57;

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export class ActorSenses implements ScriptSenses {
  readonly #options: ActorSensesOptions;
  #settings = readDetectionSettings();
  #settingsRead = false;
  /** Who knows of whom (the API: src/ai/detection-states.ts). */
  readonly detections: Detections;
  /**
   * Whether an actor is in combat (it perceives with fSneakAlertMod; it does not react to what
   * it notices), its combat target (it notices others less: fSneakCombatMod and
   * fDetectionCombatNonTargetDistanceMult; it looks harder at its target: three points), and
   * whether an observer is hostile to a target (it searches for one it lost): set by the
   * combat AI (src/shell/actor-combat-ai.ts).
   */
  inCombat: (actor: number) => boolean = () => false;
  combatTarget: (actor: number) => number | undefined = () => undefined;
  hostile: (observer: number, target: number) => boolean = () => false;
  /**
   * Told of each detection test of a target and each event of it an observer noticed (level 0
   * at the event's place): the combat groups keep their targets by it (src/ai/combat-groups.ts).
   */
  tested: ((observer: number, target: number, report: DetectionReport) => void) | undefined;
  #world: SensesWorld | undefined;
  #clock = 0;
  readonly #due = new Map<number, number>();
  readonly #corpseDue = new Map<number, number>();
  readonly #tested = new Map<string, number>();
  readonly #profiles = new Map<number, { profile: Profile; read: number }>();
  readonly #profiling = new Set<number>();
  readonly #lights = new Map<number, { level: number; ambient: number; at: number }>();
  readonly #sights = new Map<string, { clear: boolean; at: number }>();
  readonly #actions = new Map<number, { loudness: number; until: number }>();
  /** The LOS of the pairs scripts watch, as last told. */
  readonly #watched = new Map<string, boolean>();
  #watchDue = 0;
  /** Placements of references that are not actors (OnGainLOS targets), read now and then. */
  readonly #placements = new Map<number, { at: Vec3 | undefined; read: number }>();
  /** The dead of the play: when they died (game hours), and who looked at them. */
  readonly #corpses = new Map<number, number>();
  readonly #seenCorpses = new Map<number, Set<number>>();
  /** Actors a script set sneaking (StartSneaking): the package they did it in. */
  readonly #sneakers = new Map<number, number | undefined>();
  readonly #sneaking = new Set<number>();
  /** Actors seen sneaking (the start of sneaking casts the perks' spell). */
  readonly #wasSneaking = new Set<number>();
  /** Actors that do not open the stealth eye (SetNotShowOnStealthMeter). */
  readonly #unseenOnMeter = new Set<number>();
  #detectedCount = 0;
  #hiddenCount = 0;
  #aware = false;
  readonly #packages = new Map<number, PackageRecord | undefined>();
  readonly #raceSizes = new Map<number, number>();
  readonly #armour = new Map<number, number>();
  readonly #questLists = new Map<number, Map<number, OverridePackageLists>>();
  /** The reactions running (the engine's own), and the override lists running. */
  readonly #reactions = new Map<number, Reaction>();
  readonly #overriding = new Map<number, { list: number; kind: ReactionKind; until: number }>();
  /** Fights for spectators: by a combatant, where and when the last blow fell. */
  readonly #fights = new Map<number, { at: Vec3; last: number }>();
  /** Guards warning: whom. */
  readonly #warnings = new Map<number, number>();
  readonly #random = seededRandom(0x5ea5e);

  constructor(options: ActorSensesOptions) {
    this.#options = options;
    this.detections = new Detections(() => this.#settings);
    this.detections.listen((event) => {
      this.#countDetected(event);
      this.#heard(event);
    });
  }

  /** Detection's settings (the load order's once read). */
  get settings(): DetectionSettings {
    return this.#settings;
  }

  /** The play the senses work in (undefined: none). They answer the scripts and the HUD. */
  attach(world: SensesWorld | undefined): void {
    this.#world = world;
    const { session } = this.#options;
    if (world) {
      session.scriptWorld.senses = this;
      session.hud.stealth = () => this.stealth();
    } else {
      if (session.scriptWorld.senses === this) session.scriptWorld.senses = undefined;
      for (const reaction of this.#reactions.values()) reaction.cancel();
      this.#reactions.clear();
      this.#overriding.clear();
      session.hud.stealth = undefined;
    }
  }

  /** An actor left the loaded area: what it knew and what was known of it go. */
  remove(reference: number): void {
    this.detections.forget(reference);
    this.#due.delete(reference);
    this.#corpseDue.delete(reference);
    this.#profiles.delete(reference);
    this.#lights.delete(reference);
    this.#sneakers.delete(reference);
    this.#sneaking.delete(reference);
    this.#seenCorpses.delete(reference);
    this.#corpses.delete(reference);
    this.#reactions.get(reference)?.cancel();
    this.#reactions.delete(reference);
    this.#overriding.delete(reference);
    this.#warnings.delete(reference);
  }

  /** An actor died on the stage: its body may be found (observe dead body). */
  killed(reference: number): void {
    this.detections.forget(reference);
    this.#reactions.get(reference)?.cancel();
    this.#reactions.delete(reference);
    this.#overriding.delete(reference);
    this.#corpses.set(reference, this.#gameHours());
  }

  #gameHours(): number {
    const session = this.#options.session;
    return session.gameDaysPassed * 24 + session.gameHour;
  }

  // --- Every frame ----------------------------------------------------------------------

  /** Every frame (real seconds), after the actors' AI. */
  frame(seconds: number): void {
    const runtime = this.#options.session.scriptsReady;
    const world = this.#world;
    if (!runtime || !world) return;
    if (!this.#settingsRead) {
      this.#settingsRead = true;
      void this.#options.session.settings().then((settings) => {
        this.#settings = readDetectionSettings(settings);
      });
    }
    this.#clock += seconds;
    const now = this.#clock;
    const settings = this.#settings;
    const bodies = this.#bodies();
    const player = bodies.get(PLAYER_REF);
    // A complex scene (iAINumberActorsComplexScene actors or more) tests less often
    // (fDetectionUpdateTime*Complex); at most iUpdateDetectionsAllowedPerFrame tests a frame,
    // the rest wait for the next (observed in the original).
    const complex = bodies.size - 1 >= settings.complexSceneActors;
    const least = complex ? settings.updateTimeMinComplex : settings.updateTimeMin;
    const most = complex ? settings.updateTimeMaxComplex : settings.updateTimeMax;
    const allowed = this.#options.session.ini.number('General', 'iUpdateDetectionsAllowedPerFrame');
    let tests = 0;
    const flying = [...(this.#options.projectiles?.() ?? [])];
    for (const body of bodies.values()) {
      if (body.reference === PLAYER_REF) continue;
      // Its AI disabled (EnableAI false), it notices nothing (it is still seen).
      if (!this.#options.movers.runsAi(body.reference)) continue;
      const due = this.#due.get(body.reference);
      if (due !== undefined && due > now) continue;
      if (due !== undefined && tests >= allowed) continue;
      // Near the player at the least time, far ones at the most. TODO(M13): how the engine
      // picks between them (here by the distance to the player).
      const reach = detectionReach(settings, !this.#options.interior);
      const share = player ? Math.min(1, distance(body.feet, player.feet) / reach) : 1;
      const interval = least + (most - least) * share;
      // The first test is spread over an interval (not all on one frame).
      this.#due.set(
        body.reference,
        due === undefined ? now + interval * this.#random() : now + interval,
      );
      if (due === undefined) continue;
      for (const target of bodies.values()) {
        if (target.reference === body.reference) continue;
        this.#test(runtime, body, target);
        tests++;
      }
      this.#projectilesSeen(body, bodies, flying);
      this.#lookForTheDead(body, now);
    }
    this.detections.tick(now);
    this.#watchLineOfSight(runtime, bodies);
    this.#sneakingFrame(bodies);
    this.#sneakSpells(runtime, bodies);
    this.#reactionsFrame(seconds);
    this.#stealthFrame();
  }

  /**
   * An actor that begins to sneak gets its perks' spell (Apply Sneaking Spell: Shadow Warrior's
   * moment of invisibility in combat, the Nightingale's Shadowcloak).
   */
  #sneakSpells(runtime: ScriptRuntime, bodies: Map<number, Body>): void {
    for (const body of bodies.values()) {
      const actor = body.reference;
      const sneaking = body.motion?.sneaking === true;
      if (sneaking === this.#wasSneaking.has(actor)) continue;
      if (!sneaking) {
        this.#wasSneaking.delete(actor);
        continue;
      }
      this.#wasSneaking.add(actor);
      runtime.detach(
        (async () => {
          const spell = await runtime.perks.selectSpell(EntryPoint.applySneakingSpell, actor);
          const item = spell === undefined ? undefined : await runtime.magic.item(spell);
          if (item) await runtime.magic.apply(item, actor, { caster: actor });
        })(),
      );
    }
  }

  /** The player and the living actors of the high process, as the senses see them now. */
  #bodies(): Map<number, Body> {
    const bodies = new Map<number, Body>();
    const { movers, furniture } = this.#options;
    const world = this.#world;
    const player = world?.player;
    if (player) {
      const feet = player.character.feet;
      const height = player.character.shape.height;
      bodies.set(PLAYER_REF, {
        reference: PLAYER_REF,
        feet,
        heading: player.yaw,
        eye: player.eye,
        chest: [feet[0], feet[1], feet[2] + height * CHEST.standing],
        height,
        sleeping: false,
        motion: world.playerMotion?.(),
      });
    }
    for (const staged of this.#options.actors()) {
      const reference = staged.reference;
      if (staged.dead || staged.visibility.hidden || !movers.inHighProcess(reference)) continue;
      const using = furniture.interaction(reference);
      const posture =
        using?.state === 3 ? (using.animationType === 2 ? 'lying' : 'sitting') : 'standing';
      const height =
        movers.height(reference) ??
        ACTOR_HEIGHT * staged.placed.actor.scale * staged.placed.look.scale;
      const [x, y, z] = staged.position;
      bodies.set(reference, {
        reference,
        feet: staged.position,
        heading: staged.heading,
        eye: [x, y, z + height * EYES[posture]],
        chest: [x, y, z + height * CHEST[posture]],
        height: (height * EYES[posture]) / EYES.standing,
        sleeping: posture === 'lying',
        motion: movers.motion(reference),
      });
    }
    return bodies;
  }

  /** One observer tests one target: its state moves (detections.observe). */
  #test(runtime: ScriptRuntime, observer: Body, target: Body): DetectionLevel | undefined {
    const result = this.#level(runtime, observer, target);
    const level = result?.inReach === true ? result.level : undefined;
    this.detections.observe(observer.reference, target.reference, level, target.feet, this.#clock);
    this.#tested.set(`${String(observer.reference)}:${String(target.reference)}`, this.#clock);
    this.tested?.(observer.reference, target.reference, {
      level: level ?? OUT_OF_REACH,
      lineOfSight: result?.lineOfSight === true,
      at: target.feet,
    });
    return result;
  }

  /**
   * The detection formula for a pair (undefined: beyond its reach), with the inputs as the
   * engine gathers them (observed in the original): the reach (× fDetectionCombatNonTargetDistanceMult for
   * an observer in combat and a target other than its combat target, not the player); within
   * the reach of its line of sight off its facing (sightReach), its lines of sight
   * (#sight); seen within its view cone; the target's light, its moving and running (its perks:
   * Ignore Running During Detection), its armour, noise, size, invisibility, its skill when it
   * sneaks; the observer's skill, sleep, blindness, its combat and combat target.
   */
  #level(
    runtime: ScriptRuntime,
    observer: Body,
    target: Body,
  ): (DetectionLevel & { readonly lineOfSight: boolean }) | undefined {
    const settings = this.#settings;
    const exterior = !this.#options.interior;
    const flying = this.#options.flying;
    const inCombat = this.inCombat(observer.reference);
    const combatTarget = this.combatTarget(observer.reference);
    const otherThanTarget = inCombat && combatTarget !== target.reference;
    const reach =
      detectionReach(
        settings,
        exterior,
        flying?.(target.reference) === true || flying?.(observer.reference) === true,
      ) *
      (otherThanTarget && target.reference !== PLAYER_REF
        ? settings.combatNonTargetDistanceMult
        : 1);
    const apart = distance(observer.feet, target.feet);
    if (apart >= reach) return undefined;
    const off = angleOff(observer.heading, observer.feet, target.feet);
    const lineOfSight =
      apart < sightReach(settings, off, reach, exterior) &&
      this.#sight(
        observer,
        target,
        target.reference === PLAYER_REF ||
          observer.reference === PLAYER_REF ||
          combatTarget === target.reference,
      );
    const seen = lineOfSight && inViewCone(settings, off);
    const watcher = this.#profile(runtime, observer.reference);
    const watched = this.#profile(runtime, target.reference);
    const motion = target.motion;
    const sneaking = motion?.sneaking === true;
    const running =
      !watched.ignoreRunning && (motion?.running === true || motion?.sprinting === true);
    const moving = motion?.moving === true && !(watched.ignoreRunning && sneaking);
    const action = this.#actions.get(target.reference);
    const observerInput: Observer = {
      skill: watcher.skill,
      sleeping: observer.sleeping,
      inCombat,
      otherThanTarget: combatTarget !== undefined && combatTarget !== target.reference,
      blindness: watcher.blindness,
    };
    const light = detectionLight(settings, this.#lightOn(target), {
      nightEye: watcher.nightEye,
      exterior,
      ambient: this.#ambient(target),
    });
    const targetInput: Target = {
      moving,
      running,
      sneaking,
      skill: watched.sneak,
      armourWeight: watched.armourWeight,
      noiseMult: watched.noiseMult,
      actionSound: action && action.until > this.#clock ? action.loudness : 0,
      light: Math.round(light * watched.lightMult),
      motion:
        (1 + (running ? settings.lightRunMult : 0) + (moving ? settings.lightMoveMult : 0)) *
        watched.movementMult,
      size: watched.size,
      invisible: watched.invisible,
    };
    const result = detectionLevel(settings, {
      observer: observerInput,
      target: targetInput,
      distance: apart,
      reach,
      exterior,
      lineOfSight,
      seen,
    });
    // A level of 0 is none (the engine keeps 0 for an event's place).
    return { ...result, level: result.level === 0 ? -1 : result.level, lineOfSight };
  }

  /**
   * The projectiles of a target an observer sees pass (observed in the original): the
   * player's within fDetectProjectileDistancePlayer of the observer, an actor's in combat within
   * fDetectProjectileDistanceNPC; in its line of sight and its view cone, the projectile is an
   * event of loudness 50 in the light of detection events (eventLevel): above 0 the observer
   * knows the target is where the projectile is.
   */
  #projectilesSeen(
    observer: Body,
    bodies: Map<number, Body>,
    flying: readonly { readonly position: Vec3; readonly source: number | undefined }[],
  ): void {
    const settings = this.#settings;
    const exterior = !this.#options.interior;
    for (const shot of flying) {
      const source = shot.source;
      if (source === undefined || source === observer.reference) continue;
      if (!bodies.has(source)) continue;
      if (source !== PLAYER_REF && !this.inCombat(source)) continue;
      const near =
        source === PLAYER_REF ? settings.projectileDistancePlayer : settings.projectileDistanceNpc;
      const apart = distance(observer.eye, shot.position);
      if (apart > near) continue;
      const off = angleOff(observer.heading, observer.feet, shot.position);
      if (!inViewCone(settings, off)) continue;
      if (this.#ray(observer.eye, shot.position, observer.reference, source) === false) continue;
      const level = eventLevel(
        settings,
        { loudness: PROJECTILE_LOUDNESS },
        { sleeping: observer.sleeping },
        { distance: apart, exterior, lineOfSight: true, seen: true },
      );
      this.#noticed(observer.reference, shot.position, source, level);
    }
  }

  /**
   * An observer noticed a target's event (a noise, a projectile) at a place at a level: above 0
   * it is alerted there and knows the target is there (its detection level 0 at the place:
   * told to the combat groups).
   */
  #noticed(observer: number, at: Vec3, owner: number | undefined, level: number): boolean {
    if (!this.detections.hear(observer, at, owner, level, this.#clock)) return false;
    if (owner !== undefined && owner !== observer) {
      this.tested?.(observer, owner, { level: 0, lineOfSight: false, at, event: at });
    }
    return true;
  }

  /**
   * Whether an observer has a line of sight to a target (observed in the original): from
   * its eyes to the target's head (0.85 of its height); to an important target (the player, the
   * observer's combat target, or any for the player) to its middle, head or legs (0.5, 0.85,
   * 0.15 of its height), each × 0.57 while it sneaks, the first clear one counting.
   */
  #sight(observer: Body, target: Body, important: boolean): boolean {
    const key = `${String(observer.reference)}:${String(target.reference)}`;
    const kept = this.#sights.get(key);
    if (kept && this.#clock - kept.at < SIGHT_SECONDS) return kept.clear;
    const crouch = target.motion?.sneaking === true ? SNEAKING_HEIGHT : 1;
    const shares = important ? LOS_POINTS_IMPORTANT : LOS_POINTS;
    let result: boolean | undefined;
    for (const share of shares) {
      const [x, y, z] = target.feet;
      const point: Vec3 = [x, y, z + target.height * crouch * share];
      const clear = this.#ray(observer.eye, point, observer.reference, target.reference);
      if (clear === undefined) continue;
      result = clear;
      if (clear) break;
    }
    const clear = result ?? kept?.clear ?? false;
    this.#sights.set(key, { clear, at: this.#clock });
    return clear;
  }

  /**
   * Whether a ray on the line-of-sight layer gets from one point to another: through the
   * observer's own bodies (its eyes are inside its head's), to the target's (undefined: the
   * physics cannot be asked now).
   */
  #ray(from: Vec3, to: Vec3, own: number, target: number): boolean | undefined {
    const physics = this.#world?.physics;
    if (!physics?.queriesCurrent) return undefined;
    const length = distance(from, to);
    if (length < 1) return true;
    const direction: Vec3 = [
      (to[0] - from[0]) / length,
      (to[1] - from[1]) / length,
      (to[2] - from[2]) / length,
    ];
    const hit = physics.raycast(from, direction, length, Layer.lineOfSight, undefined, own);
    if (!hit || hit.distance >= length - RAY_SLACK) return true;
    return hit.owner?.reference === target && hit.owner.kind !== 'landscape';
  }

  /** The light level on a body (measured every LIGHT_SECONDS). */
  #lightOn(body: Body): number {
    const kept = this.#lights.get(body.reference);
    if (kept && this.#clock - kept.at < LIGHT_SECONDS) return kept.level;
    const probe = this.#options.light?.(body.chest);
    let level = 0;
    let ambient = 0;
    if (probe) {
      // Inside the cell's directional light lights everything; outside only where nothing
      // stands between the sun and the actor.
      const [dx, dy, dz] = probe.sunDirection;
      const sunlit =
        probe.interior ||
        (this.#ray(
          body.chest,
          [
            body.chest[0] + dx * SUN_RAY,
            body.chest[1] + dy * SUN_RAY,
            body.chest[2] + dz * SUN_RAY,
          ],
          body.reference,
          -1,
        ) ??
          true);
      level = lightLevel(probe, body.chest, sunlit);
      ambient = brightestAmbient(probe);
    }
    this.#lights.set(body.reference, { level, ambient, at: this.#clock });
    return level;
  }

  /** The brightest channel of the ambient light where a body is (0..1: the interior's mod). */
  #ambient(body: Body): number {
    this.#lightOn(body);
    return this.#lights.get(body.reference)?.ambient ?? 0;
  }

  // --- Profiles ---------------------------------------------------------------------------

  /** What detection weighs of an actor (read again every PROFILE_SECONDS). */
  #profile(runtime: ScriptRuntime, reference: number): Profile {
    const kept = this.#profiles.get(reference);
    if ((!kept || this.#clock - kept.read > PROFILE_SECONDS) && !this.#profiling.has(reference)) {
      this.#profiling.add(reference);
      void this.#readProfile(runtime, reference)
        .then((profile) => {
          this.#profiles.set(reference, { profile, read: this.#clock });
        })
        .catch(() => {
          this.#profiles.set(reference, { profile: DEFAULT_PROFILE, read: this.#clock });
        })
        .finally(() => this.#profiling.delete(reference));
    }
    return kept?.profile ?? DEFAULT_PROFILE;
  }

  async #readProfile(runtime: ScriptRuntime, reference: number): Promise<Profile> {
    const value = async (name: string): Promise<{ base: number; current: number }> => {
      const index = actorValueIndex(name);
      return index === undefined ? { base: 0, current: 0 } : runtime.actors.value(reference, index);
    };
    const [sneak, blindness, nightEye, invisibility, noise, worn] = await Promise.all([
      value('Sneak'),
      value('Blindness'),
      value('NightEye'),
      value('Invisibility'),
      value('MovementNoiseMult'),
      runtime.actors.worn(reference),
    ]);
    // What it wears weighs what its perks make it (Mod Armor Weight: Conditioning).
    const perks = runtime.perks;
    let armourWeight = 0;
    for (const item of worn) {
      const weight = await this.#armourWeight(runtime, item);
      armourWeight +=
        weight > 0 ? await perks.apply(EntryPoint.modArmorWeight, reference, weight, [item]) : 0;
    }
    const staged = this.#options.get(reference);
    // The playable races are all of medium size (RACE DATA).
    const size = staged ? await this.#raceSize(runtime, staged.placed.look.race) : RaceSize.medium;
    // Its Sneak as detection counts it (the player's: fPlayerDetectionSneakMult × skill +
    // Base), and as a target its perks on it (Mod Detection Sneak Skill: Stealth), as the
    // engine applies them (observed in the original).
    const skill = detectionSkill(this.#settings, sneak.current, reference === PLAYER_REF);
    return {
      skill,
      sneak: await perks.apply(EntryPoint.modDetectionSneakSkill, reference, skill),
      // As a target, its perks on the light on it and on how its moving shows (Mod Detection
      // Light / Movement: the engine asks the target's perks), and Ignore Running During
      // Detection. TODO(M13): conditions on the observer (the perks' second tab) are not
      // given here: one profile serves all observers.
      lightMult: await perks.apply(EntryPoint.modDetectionLight, reference, 1),
      movementMult: await perks.apply(EntryPoint.modDetectionMovement, reference, 1),
      ignoreRunning:
        (await perks.apply(EntryPoint.ignoreRunningDuringDetection, reference, 0)) !== 0,
      blindness: blindness.current,
      nightEye: nightEye.current > 0,
      invisible: invisibility.current > 0,
      // Muffle (the spell, the enchantment, Muffled Movement and Silence's abilities: their
      // modifiers of MovementNoiseMult) quiets its movement.
      noiseMult: movementNoise(noise.current),
      armourWeight,
      size,
      teammate: runtime.state.actors.get(reference)?.playerTeammate === true,
      overrides: staged ? await this.#overrideLists(runtime, staged) : undefined,
    };
  }

  async #armourWeight(runtime: ScriptRuntime, item: number): Promise<number> {
    let weight = this.#armour.get(item);
    if (weight === undefined) {
      const record = await runtime.forms.record(item);
      weight = record?.type === 'ARMO' ? (parseItem(record)?.weight ?? 0) : 0;
      this.#armour.set(item, weight);
    }
    return weight;
  }

  async #raceSize(runtime: ScriptRuntime, race: number): Promise<number> {
    let size = this.#raceSizes.get(race);
    if (size === undefined) {
      const record = await runtime.forms.record(race);
      size = record?.type === 'RACE' ? parseRaceCombat(record).size : RaceSize.medium;
      this.#raceSizes.set(race, size);
    }
    return size;
  }

  /**
   * An actor's override package lists: those of the quest aliases that hold it (before its
   * own), else its NPC_'s (of the one its templates give the default package list from,
   * template flag 0x400).
   */
  async #overrideLists(
    runtime: ScriptRuntime,
    staged: StagedActor,
  ): Promise<OverridePackageLists | undefined> {
    let lists: OverridePackageLists | undefined;
    const merge = (more: OverridePackageLists): void => {
      lists = {
        spectator: lists?.spectator ?? more.spectator,
        observeCorpse: lists?.observeCorpse ?? more.observeCorpse,
        guardWarn: lists?.guardWarn ?? more.guardWarn,
        combat: lists?.combat ?? more.combat,
      };
    };
    for (const [quest, state] of runtime.state.quests) {
      if (!state.running) continue;
      for (const [alias, held] of state.aliases) {
        if (held !== staged.reference) continue;
        let byAlias = this.#questLists.get(quest);
        if (!byAlias) {
          const record = await runtime.forms.record(quest);
          byAlias = record?.type === 'QUST' ? aliasOverrideLists(record) : new Map();
          this.#questLists.set(quest, byAlias);
        }
        const own = byAlias.get(alias);
        if (own) merge(own);
      }
    }
    const db = runtime.forms.db;
    const level = await runtime.actors.level(staged.reference);
    const templates = await resolveActorTemplates(
      (formId) => db.get(formId),
      staged.placed.look.base,
      staged.reference,
      level,
    );
    const npc = templates && (await db.get(templates.part(TemplateFlag.defaultPackages)));
    if (npc?.type === 'NPC_') merge(parseNpcCombat(npc).overridePackages);
    return lists;
  }

  // --- The scripts' questions (ScriptSenses) ------------------------------------------

  /**
   * GetLightLevel (observed in the original): the light on it as detection weighs it
   * (detectionLight, without night eye) × fSneakLightMult, outside × fSneakLightExteriorMult.
   */
  lightLevel(actor: number): number {
    const body = this.#bodies().get(actor);
    if (!body) return 0;
    const settings = this.#settings;
    const exterior = !this.#options.interior;
    const light = detectionLight(settings, this.#lightOn(body), {
      nightEye: false,
      exterior,
      ambient: this.#ambient(body),
    });
    return light * (exterior ? settings.lightExteriorMult : settings.lightMult);
  }

  /** Whether an observer detects a target now (a test made anew unless one is fresh). */
  detects(observer: number, target: number): boolean {
    if (observer === target) return true;
    const runtime = this.#options.session.scriptsReady;
    const tested = this.#tested.get(`${String(observer)}:${String(target)}`);
    if (runtime && (tested === undefined || this.#clock - tested > FRESH_SECONDS)) {
      const bodies = this.#bodies();
      const watcher = bodies.get(observer);
      const watched = bodies.get(target);
      if (watcher && watched) this.#test(runtime, watcher, watched);
    }
    return this.detections.detects(observer, target);
  }

  /** Whether an actor sneaks now (the player: their sneaking; another: its movement). */
  sneaking(actor: number): boolean {
    if (actor === PLAYER_REF) return this.#world?.player?.sneaking === true;
    return this.#options.movers.motion(actor)?.sneaking === true;
  }

  /** Whether nothing blocks an actor's eyes from a place (combat's lost check). */
  sees(actor: number, at: Vec3): boolean {
    const body = this.#bodies().get(actor);
    if (!body) return false;
    const point: Vec3 = [at[0], at[1], at[2] + body.height * LOS_POINTS_IMPORTANT[0]];
    return this.#ray(body.eye, point, actor, -1) ?? false;
  }

  /**
   * Whether a viewer sees a reference: an actor within its view cone and reach with nothing
   * between (its eyes to the reference's head, chest or middle); the player what is on
   * screen with nothing between the camera and it.
   */
  lineOfSight(viewer: number, target: number): boolean {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return false;
    return this.#sees(runtime, this.#bodies(), viewer, target) ?? false;
  }

  #sees(
    runtime: ScriptRuntime,
    bodies: Map<number, Body>,
    viewer: number,
    target: number,
  ): boolean | undefined {
    const seen = bodies.get(target);
    const points: Vec3[] = seen ? [seen.eye, seen.chest] : [];
    if (!seen) {
      const at = this.#placementOf(runtime, target);
      if (!at) return false;
      points.push([at[0], at[1], at[2] + OBJECT_LIFT]);
    }
    const middle = points[points.length - 1] ?? [0, 0, 0];
    if (viewer === PLAYER_REF) {
      const camera = this.#options.camera?.();
      const forward = camera?.forward;
      if (!camera || !forward) return false;
      const to: Vec3 = [
        middle[0] - camera.position[0],
        middle[1] - camera.position[1],
        middle[2] - camera.position[2],
      ];
      const length = Math.hypot(...to) || 1;
      const cos = (to[0] * forward[0] + to[1] * forward[1] + to[2] * forward[2]) / length;
      const half =
        camera.fovY === undefined
          ? SCREEN_HALF_WIDTH
          : Math.atan(Math.tan(camera.fovY / 2) * SCREEN_ASPECT);
      if (cos < Math.cos(half)) return false;
      return points.some((point) => this.#ray(camera.position, point, PLAYER_REF, target) === true);
    }
    const eyes = bodies.get(viewer);
    if (!eyes) return false;
    const settings = this.#settings;
    const exterior = !this.#options.interior;
    const reach = sightReach(
      settings,
      angleOff(eyes.heading, eyes.feet, middle),
      detectionReach(settings, exterior),
      exterior,
    );
    if (distance(eyes.eye, middle) >= reach) return false;
    return points.some((point) => this.#ray(eyes.eye, point, viewer, target) === true);
  }

  /** Where a reference that is not an actor is (read now and then: it may be moved). */
  #placementOf(runtime: ScriptRuntime, reference: number): Vec3 | undefined {
    const live = runtime.world.livePlacement?.(reference);
    if (live) return live.position;
    const kept = this.#placements.get(reference);
    if (!kept || this.#clock - kept.read > PROFILE_SECONDS) {
      this.#placements.set(reference, { at: kept?.at, read: this.#clock });
      void runtime.placement(reference).then((at) => {
        this.#placements.set(reference, { at: at?.position, read: this.#clock });
      });
    }
    return kept?.at;
  }

  alarmed(actor: number): boolean {
    return this.detections.alarmed(actor);
  }

  attacked(actor: number): boolean {
    return this.detections.attackedBy(actor) !== undefined;
  }

  alerted(actor: number): boolean {
    return this.detections.alerted(actor) !== undefined;
  }

  /** CreateDetectionEvent: a noise at a reference, of an owner. */
  detectionEvent(at: number, owner: number | undefined, soundLevel: number): void {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return;
    const place = this.#bodies().get(at)?.feet ?? this.#placementOf(runtime, at);
    if (place) this.noise(place, owner, soundLevel);
  }

  alarm(
    source: number,
    criminal: number | undefined,
    act: 'attack' | 'trespass' | 'steal' | 'stop',
  ): void {
    if (act === 'stop') {
      this.detections.stopAlarm(source);
      return;
    }
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return;
    const bodies = this.#bodies();
    const at = bodies.get(source)?.feet ?? this.#placementOf(runtime, source);
    // Observed in the original: the actors of the criminal's process level hear it within
    // iCrimeAlarmRecDistance of the criminal; the others (here: those beyond the high process)
    // within iCrimeAlarmLowRecDistance of one who raised it.
    const by =
      (criminal === undefined ? undefined : bodies.get(criminal)?.feet) ??
      (criminal === undefined ? undefined : this.#placementOf(runtime, criminal)) ??
      at;
    const hearers: number[] = [];
    if (at && by) {
      for (const body of bodies.values()) {
        if (body.reference === PLAYER_REF || body.reference === source) continue;
        if (distance(body.feet, by) <= this.#settings.alarmDistance) hearers.push(body.reference);
      }
      for (const staged of this.#options.actors()) {
        const reference = staged.reference;
        if (bodies.has(reference) || reference === source || staged.dead) continue;
        if (!this.#options.movers.runsAi(reference)) continue;
        if (distance(staged.position, at) <= this.#settings.lowAlarmDistance) {
          hearers.push(reference);
        }
      }
    }
    const crime: WitnessedAct = act;
    this.detections.alarm(source, hearers, this.#clock, criminal, crime);
  }

  startSneaking(actor: number): void {
    if (actor === PLAYER_REF) {
      const player = this.#world?.player;
      if (player) player.sneaking = true;
      return;
    }
    this.#sneakers.set(actor, this.#options.ai.current(actor)?.id);
  }

  hideFromStealthMeter(actor: number, hidden: boolean): void {
    if (hidden) this.#unseenOnMeter.add(actor);
    else this.#unseenOnMeter.delete(actor);
  }

  // --- The API of combat (5.2) and crime (M11) ----------------------------------------------

  /**
   * A detection event: a noise at a place, of an owner (none: of nothing), at a sound level
   * (0 loud, 1 normal, 2 silent, 3 very loud). The actors of the high process within its
   * distance (eventDistance) test it (src/ai/detection.ts, eventLevel: a line of sight to the
   * place, seen within the view cone); those that hear it are alerted there, and know its owner
   * is there. Returns those that heard it.
   */
  noise(at: Vec3, owner: number | undefined, soundLevel: number): number[] {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return [];
    const heard: number[] = [];
    const settings = this.#settings;
    const exterior = !this.#options.interior;
    const loud = loudness(settings, soundLevel);
    const reach = eventDistance(settings, loud, owner === PLAYER_REF);
    for (const body of this.#bodies().values()) {
      if (body.reference === PLAYER_REF || body.reference === owner) continue;
      const apart = distance(body.feet, at);
      if (apart >= reach) continue;
      const clear = this.#ray(body.eye, at, body.reference, owner ?? -1) ?? true;
      const off = angleOff(body.heading, body.feet, at);
      const level = eventLevel(
        settings,
        { loudness: loud },
        { sleeping: body.sleeping },
        { distance: apart, exterior, lineOfSight: clear, seen: clear && inViewCone(settings, off) },
      );
      if (this.#noticed(body.reference, at, owner, level)) heard.push(body.reference);
    }
    return heard;
  }

  /**
   * An actor's action sounds (an attack with its weapon's VNAM sound level, a spell's casting
   * sound level, a shout): for fDetectionActionTimer it adds to what its observers hear.
   */
  action(actor: number, soundLevel: number): void {
    this.#actions.set(actor, {
      loudness: loudness(this.#settings, soundLevel),
      until: this.#clock + this.#settings.actionTimer,
    });
  }

  /**
   * An actor was attacked by another (combat: 5.1): it searches for the attacker. Combat's
   * hits tell crime as well (ScriptRuntime.crime.assault in actor-combat.ts); kills reach it
   * through ActorEngine.kill (murder).
   */
  attackedBy(victim: number, attacker: number): void {
    const at = this.#bodies().get(attacker)?.feet;
    if (at) this.detections.attack(victim, attacker, at, this.#clock);
    this.fight(attacker, victim);
  }

  /**
   * A blow in a fight between two actors (combat: 5.2): the actors that notice it within
   * fAIInteriorSpectatorDetection / Exterior and whose package lets them observe combat watch
   * it (their spectator override list, else the engine's spectating).
   */
  fight(attacker: number, victim: number): void {
    const bodies = this.#bodies();
    const a = bodies.get(attacker);
    const b = bodies.get(victim);
    if (!a || !b) return;
    const at: Vec3 = [(a.feet[0] + b.feet[0]) / 2, (a.feet[1] + b.feet[1]) / 2, a.feet[2]];
    this.#fights.set(attacker, { at, last: this.#clock });
    this.#fights.set(victim, { at, last: this.#clock });
    const reach = this.#options.interior
      ? this.#settings.spectatorDetectionInterior
      : this.#settings.spectatorDetectionExterior;
    for (const body of bodies.values()) {
      const reference = body.reference;
      if (reference === PLAYER_REF || reference === attacker || reference === victim) continue;
      if (distance(body.feet, at) > reach) continue;
      if (
        !this.detections.detects(reference, attacker) &&
        !this.detections.detects(reference, victim)
      ) {
        continue;
      }
      this.#react('spectator', reference, at, attacker);
    }
  }

  /**
   * A guard warns a trespasser (crime: M11), or stops (undefined): its guard warn override list,
   * else the engine's warning.
   */
  warn(guard: number, target: number | undefined): void {
    if (target === undefined) {
      this.#warnings.delete(guard);
      return;
    }
    const at = this.#bodies().get(target)?.feet;
    if (!at) return;
    this.#warnings.set(guard, target);
    this.#react('warn', guard, at, target);
  }

  // --- Reactions ----------------------------------------------------------------------------

  /** The override package list an actor's situation runs now (ActorAi), if any. */
  overridePackages(actor: number): number | undefined {
    return this.#overriding.get(actor)?.list;
  }

  /** An actor's reaction ends at once (it went into combat): its package is chosen again. */
  endReaction(actor: number): void {
    const reaction = this.#reactions.get(actor);
    if (reaction) {
      reaction.cancel();
      this.#reactions.delete(actor);
      this.#options.ai.hold(actor, false);
    }
    if (this.#overriding.delete(actor)) this.#options.ai.evaluate(actor);
  }

  /** The combat override package list (ECOR: its aliases', else its NPC_'s) of an actor. */
  combatOverrides(actor: number): number | undefined {
    return this.#profiles.get(actor)?.profile.overrides?.combat;
  }

  /** What an actor reacts to now (the engine's reaction or an override list), if anything. */
  reacting(actor: number): ReactionKind | undefined {
    return this.#reactions.get(actor)?.kind ?? this.#overriding.get(actor)?.kind;
  }

  /** What detection told: the actors that noticed or heard something react. */
  #heard(event: DetectionEvent): void {
    switch (event.kind) {
      case 'noticed': {
        // Something near: one sneaking, or one it is hostile to.
        const sneaking =
          event.target === PLAYER_REF
            ? this.#world?.player?.sneaking === true
            : this.#sneaking.has(event.target);
        if (!sneaking && !this.hostile(event.observer, event.target)) return;
        const at = this.detections.lastKnown(event.observer, event.target);
        if (at) this.#react('search', event.observer, at, event.target);
        return;
      }
      case 'searching':
        if (event.at && this.hostile(event.observer, event.target)) {
          this.#react('search', event.observer, event.at, event.target);
        }
        return;
      case 'heard':
        this.#react('search', event.observer, event.at, event.owner);
        return;
      default:
        return;
    }
  }

  /**
   * An actor reacts to something, if it may: its AI runs, it is not talking, in a scene or in
   * furniture, nor reacting already, and its package lets it (its interrupt flags: reactions to
   * the player's actions, greeting corpses, observing combat). Its override list for the
   * situation runs if it has one; else the engine's reaction.
   */
  #react(kind: ReactionKind, actor: number, at: Vec3, subject: number | undefined): boolean {
    const { movers, furniture, ai, session } = this.#options;
    const runtime = session.scriptsReady;
    if (!runtime || this.reacting(actor) !== undefined || this.inCombat(actor)) return false;
    if (!movers.runsAi(actor) || furniture.holds(actor)) return false;
    if (runtime.dialogueSpeaker === actor || runtime.scenes.sceneOf(actor) !== undefined)
      return false;
    const running = ai.current(actor);
    const pack = running && this.#package(running.id);
    if (kind !== 'warn') {
      if (!pack) return false;
      const wanted =
        kind === 'search'
          ? InterruptFlag.reactionToPlayerActions
          : kind === 'corpse'
            ? InterruptFlag.greetCorpseBehavior
            : InterruptFlag.observeCombatBehavior;
      if ((pack.interruptFlags & wanted) === 0) return false;
      if (kind === 'search' && (pack.flags & PackageFlag.noCombatAlert) !== 0) return false;
    }
    const lists = this.#profiles.get(actor)?.profile.overrides;
    const list =
      kind === 'spectator'
        ? lists?.spectator
        : kind === 'corpse'
          ? lists?.observeCorpse
          : kind === 'warn'
            ? lists?.guardWarn
            : undefined;
    if (list !== undefined) {
      this.#overriding.set(actor, {
        list,
        kind,
        until: this.#clock + this.#settings.stateExpireTime,
      });
      ai.evaluate(actor);
      return true;
    }
    const staged = this.#options.get(actor);
    if (!staged) return false;
    const reaction = new Reaction(
      kind,
      at,
      subject,
      {
        position: () => staged.position,
        travel: (to, arrive) => movers.travel(actor, to, 'walk', arrive),
        face: (heading) => {
          movers.request(
            actor,
            heading === undefined ? undefined : { gait: 'walk', face: heading },
          );
        },
        stop: () => {
          movers.stop(actor);
        },
        // The topic subtype's line (src/shell/actor-talk.ts, bark), to what it reacts to.
        say: (subtype) => {
          void this.#options.bark?.(actor, subtype, subject);
        },
      },
      {
        ...this.#settings,
        spectatorDistance: this.#options.interior
          ? this.#settings.spectatorDistanceInterior
          : this.#settings.spectatorDistanceExterior,
      },
      this.#random,
    );
    ai.hold(actor, true);
    this.#reactions.set(actor, reaction);
    return true;
  }

  /** The running package's record (read once). */
  #package(id: number): PackageRecord | undefined {
    if (!this.#packages.has(id)) {
      this.#packages.set(id, undefined);
      void this.#options.session
        .packageData()
        .then((data) => data.package(id))
        .then((pack) => {
          this.#packages.set(id, pack);
        });
    }
    return this.#packages.get(id);
  }

  /** The reactions go on; those that end let their actors go back to their packages. */
  #reactionsFrame(seconds: number): void {
    const { ai } = this.#options;
    for (const [actor, reaction] of this.#reactions) {
      const situation = this.#situation(actor, reaction);
      if (reaction.update(seconds, situation)) continue;
      this.#reactions.delete(actor);
      if (reaction.kind === 'search') this.detections.calm(actor);
      ai.hold(actor, false);
    }
    for (const [actor, overriding] of this.#overriding) {
      const over =
        overriding.until <= this.#clock ||
        (overriding.kind === 'warn' && !this.#warnings.has(actor)) ||
        (overriding.kind === 'spectator' && !this.#fightGoesOn(actor));
      if (!over) continue;
      this.#overriding.delete(actor);
      ai.evaluate(actor);
    }
  }

  /** What a reaction answers now: the fight, the one warned, the one searched for. */
  #situation(actor: number, reaction: Reaction): { at?: Vec3 | undefined; over?: boolean } {
    const subject = reaction.subject;
    switch (reaction.kind) {
      case 'search': {
        // Found (detected: one hostile to it is combat's from here), or given up.
        const known = subject === undefined ? 'unseen' : this.detections.state(actor, subject);
        return {
          over:
            known === 'detected' ||
            (known === 'unseen' && this.detections.alerted(actor) === undefined),
        };
      }
      case 'spectator': {
        const fight = subject === undefined ? undefined : this.#fights.get(subject);
        return { at: fight?.at, over: !this.#fightGoesOn(subject) };
      }
      case 'warn': {
        const at = subject === undefined ? undefined : this.#bodies().get(subject)?.feet;
        return { at, over: !this.#warnings.has(actor) };
      }
      default:
        return {};
    }
  }

  #fightGoesOn(combatant: number | undefined): boolean {
    const fight = combatant === undefined ? undefined : this.#fights.get(combatant);
    return fight !== undefined && this.#clock - fight.last < FIGHT_SECONDS;
  }

  /**
   * Every fCheckDeadBodyTimer an actor looks for the dead: one that died within
   * iHoursToClearCorpses, in its sight and line of sight, that it has not looked at yet.
   */
  #lookForTheDead(observer: Body, now: number): void {
    if (this.#corpses.size === 0) return;
    const due = this.#corpseDue.get(observer.reference);
    if (due !== undefined && due > now) return;
    this.#corpseDue.set(observer.reference, now + this.#settings.checkDeadBodyTimer);
    const hours = this.#gameHours();
    const seen = this.#seenCorpses.get(observer.reference) ?? new Set<number>();
    this.#seenCorpses.set(observer.reference, seen);
    const settings = this.#settings;
    const exterior = !this.#options.interior;
    for (const [corpse, died] of this.#corpses) {
      if (seen.has(corpse) || hours - died > settings.hoursToClearCorpses) continue;
      const body = this.#options.get(corpse);
      const world = body?.placed.instances[0]?.world;
      if (!body || !world) continue;
      const at: Vec3 = [world[12] ?? 0, world[13] ?? 0, (world[14] ?? 0) + OBJECT_LIFT];
      const reach = sightReach(
        settings,
        angleOff(observer.heading, observer.feet, at),
        detectionReach(settings, exterior),
        exterior,
      );
      if (distance(observer.eye, at) >= reach) continue;
      if (this.#ray(observer.eye, at, observer.reference, corpse) !== true) continue;
      seen.add(corpse);
      this.detections.corpseSeen(observer.reference, corpse);
      // The story manager's Dead Body, as the engine raises it with the reaction to a body
      // (not by one in combat). TODO(M13): the engine reacts within fDeadReactionDistance
      // (400 units) of the body; ours from where it is seen.
      const runtime = this.#options.session.scriptsReady;
      if (runtime && runtime.world.combat?.(observer.reference)?.inCombat !== true)
        runtime.detach(runtime.storyEvents.deadBody(observer.reference, corpse));
      this.#react('corpse', observer.reference, at, corpse);
      return;
    }
  }

  /** OnGainLOS / OnLostLOS for the pairs scripts watch (RegisterForLOS). */
  #watchLineOfSight(runtime: ScriptRuntime, bodies: Map<number, Body>): void {
    if (this.#clock < this.#watchDue) return;
    this.#watchDue = this.#clock + LOS_WATCH_SECONDS;
    const watched = runtime.lineOfSightWatched;
    const keys = new Set<string>();
    for (const { viewer, seen } of watched) {
      const key = `${String(viewer)}:${String(seen)}`;
      if (keys.has(key)) continue;
      keys.add(key);
      const sees = this.#sees(runtime, bodies, viewer, seen);
      if (sees === undefined) continue;
      // The first look tells how it is; then each change.
      if (this.#watched.get(key) === sees) continue;
      this.#watched.set(key, sees);
      runtime.lineOfSightChanged(viewer, seen, sees);
    }
    for (const key of [...this.#watched.keys()]) if (!keys.has(key)) this.#watched.delete(key);
  }

  /**
   * The actors that sneak: those whose package says Always Sneak (PKDT 0x20000), those a script
   * set sneaking (StartSneaking, until their package changes).
   */
  #sneakingFrame(bodies: Map<number, Body>): void {
    const { ai, movers } = this.#options;
    for (const body of bodies.values()) {
      const actor = body.reference;
      if (actor === PLAYER_REF) continue;
      const running = ai.current(actor);
      if (this.#sneakers.has(actor) && this.#sneakers.get(actor) !== running?.id) {
        this.#sneakers.delete(actor);
      }
      const wanted =
        this.#sneakers.has(actor) || ((running?.flags ?? 0) & PackageFlag.alwaysSneak) !== 0;
      if (wanted === this.#sneaking.has(actor)) continue;
      if (wanted) this.#sneaking.add(actor);
      else this.#sneaking.delete(actor);
      movers.sneak(actor, wanted);
    }
  }

  // --- The stealth meter ------------------------------------------------------------------

  /** Whether an observer counts for the stealth eye: alive, not a teammate, not hidden from it. */
  #onMeter(observer: number): boolean {
    if (this.#unseenOnMeter.has(observer)) return false;
    return this.#profiles.get(observer)?.profile.teammate !== true;
  }

  /** DETECTED as an actor detects the player, HIDDEN as the last one aware loses them. */
  #stealthFrame(): void {
    let aware = false;
    for (const { observer, state } of this.detections.detectors(PLAYER_REF)) {
      if ((state === 'detected' || state === 'searching') && this.#onMeter(observer)) aware = true;
    }
    if (this.#aware && !aware) this.#hiddenCount++;
    this.#aware = aware;
  }

  /** What the HUD's stealth meter shows (src/shell/hud-stealth.ts). */
  stealth(): StealthReading {
    let eye = 0;
    for (const { observer } of this.detections.detectors(PLAYER_REF)) {
      if (this.#onMeter(observer)) eye = Math.max(eye, this.detections.eye(observer, PLAYER_REF));
    }
    return {
      sneaking: this.#world?.player?.sneaking === true,
      eye,
      detected: this.#detectedCount,
      hidden: this.#hiddenCount,
    };
  }

  /** Counts the player detected (the HUD flashes DETECTED). */
  #countDetected(event: DetectionEvent): void {
    if (event.kind === 'detected' && event.target === PLAYER_REF && this.#onMeter(event.observer)) {
      this.#detectedCount++;
    }
  }
}
