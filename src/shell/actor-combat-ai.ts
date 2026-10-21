// The combat AI on the stage (docs/ai.md, "Combat AI"; docs/m10-plan.md 5.2): who of the actors
// of the high process fights whom, and how. Its decisions are src/ai/combat-ai.ts (aggression,
// assistance, targets, fleeing, yielding), src/ai/combat-tactics.ts (the combat style's
// equipment, movement, attacks, blocks, dodges), src/ai/combat-groups.ts and src/ai/combat-
// search.ts; the reactions between actors src/ai/combat-reactions.ts (crime's at M11). Combat's
// mechanics are src/shell/actor-combat.ts (the host here): the AI asks it to draw, attack,
// block and release, and sets each fighter's combat target.
//
// Every DECIDE_SECONDS an actor weighs those it knows of (detection: src/shell/actor-senses.ts;
// what its combat group sees): the ones it attacks on sight (its aggression against its
// reaction to them; its aggro radius warns first), those that attacked it (friends and allies
// after iFriendHitCombatAllowed blows), those that fight one it helps (its assistance; guards
// help the innocent; teammates the player), and those StartCombat set it on. It fights the one
// target selection picks, searches for one it lost, flees by its confidence, yields to the
// player, and ends its combat when it knows of no enemy (its packages go on: src/shell/actor-
// ai.ts waits while it is engaged; its combat override package list, ECOR, keeps it to its
// place meanwhile). Its lines are the detection and combat topic subtypes (NormalToCombat,
// AlertToCombat, CombatToLost, LostIdle, LostToCombat, LostToNormal, CombatToNormal, Taunt,
// Flee, Yield, AcceptYield, AvoidThreat, AllyKilled, Hit for friendly fire, ObserveCombat).

import {
  acceptsYield,
  actorStrength,
  aggroResponse,
  Assistance,
  assists,
  attacksOnSight,
  confidenceModifier,
  readCombatAiSettings,
  COMBAT_AI_DEFAULTS,
  Confidence,
  selectTarget,
  shouldFlee,
  threatRatio,
  turnsOnAttacker,
  yields,
  type CombatAiSettings,
  type TargetCandidate,
} from '../ai/combat-ai.ts';
import { CombatGroups } from '../ai/combat-groups.ts';
import { CombatProfiles, NO_STYLE, type CombatProfile } from '../ai/combat-profile.ts';
import { FightReaction, reactionOf } from '../ai/combat-reactions.ts';
import { CombatSearch } from '../ai/combat-search.ts';
import { readDetectionSettings } from '../ai/detection.ts';
import {
  attackInterval,
  avoidsThreat,
  chooseAttack,
  chooseEquipment,
  chooseManeuver,
  choosesBlock,
  dodgeDirection,
  maneuverDirection,
  MANEUVER_SECONDS,
  threatens,
  type EquipOption,
  type Maneuver,
  type Threat,
} from '../ai/combat-tactics.ts';
import { InterruptFlag, PackageFlag } from '../ai/package-records.ts';
import type { Gait } from '../ai/locomotion.ts';
import {
  AttackState,
  attacking,
  bleedingOut,
  canAct,
  LifeState,
  WeaponState,
  type CombatState,
} from '../gameplay/combat/combat-state.ts';
import { headingTo, turnBetween } from '../gameplay/combat/hit-test.ts';
import type { Vec3 } from '../render/math.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { MagicAiState } from '../scripting/runtime/magic-engine.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { ActorValue } from '../world/actor-values.ts';
import { AmmoFlag, WeaponType } from '../world/item-records.ts';
import { seededRandom } from '../world/actors.ts';
import type { ActorAi } from './actor-ai.ts';
import type { ActorMovers } from './actor-movers.ts';
import type { ActorSenses } from './actor-senses.ts';
import type { ActorTalk } from './actor-talk.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

/** What a fighter holds, as the AI weighs it. */
export interface FighterGear {
  /** The right hand's weapon (undefined: fists) and its WeaponType. */
  readonly weapon: number | undefined;
  readonly weaponType: number;
  /** A bow or crossbow with its ammunition and its projectile. */
  readonly bow: boolean;
  readonly shield: boolean;
  /**
   * Its left hand's action blocks (a shield, a two-handed weapon, or a one-handed weapon with
   * the left hand free), rather than swinging a left weapon or fist.
   */
  readonly canBlock: boolean;
  /** Its blow's damage (the equip system's), a shot's, and how far a shot flies. */
  readonly damage: number;
  readonly shotDamage: number;
  readonly range: number;
  /** Its attack data has a bash, and its power attacks' chance (ATKD). */
  readonly canBash: boolean;
  readonly powerChance: number;
}

/** A fighter as combat has it now (the player too). */
export interface FighterView {
  readonly reference: number;
  readonly player: boolean;
  readonly state: CombatState;
  readonly target: number | undefined;
  readonly feet: Vec3 | undefined;
  readonly heading: number;
  /** Its melee reach (units), and its body's radius and height. */
  readonly reach: number;
  readonly radius: number;
  readonly height: number;
  readonly gear: FighterGear | undefined;
}

/** What combat's mechanics give the AI (src/shell/actor-combat.ts). */
export interface CombatAiHost {
  fighters(): Iterable<FighterView>;
  fighter(reference: number): FighterView | undefined;
  /** Sets a fighter's combat target (undefined: it fights no one). */
  setTarget(reference: number, target: number | undefined): void;
  draw(reference: number): Promise<boolean>;
  sheathe(reference: number): Promise<boolean>;
  attack(reference: number, action: string): Promise<boolean>;
  release(reference: number, action: string): Promise<void>;
  block(reference: number, on: boolean): Promise<void>;
  /** Plays an action's idle (ActionIdleWarn, ActionIdle, ...); its event, if one played. */
  act(reference: number, action: string, target?: number): Promise<string | undefined>;
  /** What flies at the actors now (arrows; spells and breath: 5.3, 5.4). */
  threats(): Iterable<Threat>;
}

/**
 * What magic and shouts in combat give the AI (M10 5.3: `castAt` and NPC shouting): the
 * offensive spells and shouts an actor may fight with, scored with its weapons, and the cast
 * itself (src/shell/combat-casting.ts; staffs are weapons in its profile).
 */
export interface CombatCasting {
  options(actor: number): Promise<readonly EquipOption[]>;
  castAt(
    actor: number,
    hand: 'left' | 'right' | 'voice',
    target: number,
    option: EquipOption,
  ): Promise<boolean>;
}

export interface ActorCombatAiOptions {
  readonly session: GameSession;
  readonly terminal: Terminal;
  readonly movers: ActorMovers;
  readonly host: CombatAiHost;
  readonly senses?: () => ActorSenses | undefined;
  readonly talk?: () => ActorTalk | undefined;
  readonly ai?: () => ActorAi | undefined;
  /** Inside a cell (fFleeDistanceInterior) or outside. */
  readonly interior?: () => boolean;
  /** Off its horse before it fights (TODO(M13): mounted combat, RACE allowMountedCombat). */
  readonly dismount?: (actor: number) => Promise<void>;
  /** A horse its rider moves: its own AI waits. */
  readonly ridden?: (actor: number) => boolean;
  /** Spells, staffs and shouts in combat (M10 5.3). */
  readonly casting?: () => CombatCasting | undefined;
}

type Mode = 'idle' | 'fight' | 'search' | 'flee' | 'yield';

/** What the AI reads of an actor now and then (PROFILE_SECONDS: src/ai/combat-profile.ts). */
type Profile = CombatProfile;

/** One actor's combat. */
interface Mind {
  readonly reference: number;
  mode: Mode;
  target: number | undefined;
  /** Those it fights whatever its reaction (attacked by, helping against, StartCombat). */
  readonly enemies: Set<number>;
  /** Blows from friends and allies it let pass, by attacker. */
  readonly friendHits: Map<number, number>;
  /** Those it turned on for their blows (a quarrel the player may yield). */
  readonly quarrels: Set<number>;
  profile: Profile | undefined;
  profileRead: number;
  profiling: boolean;
  next: number;
  /** Its health (share and points) and the odds' confidence modifier, as last read. */
  health: number;
  healthPoints: number;
  modifier: number;
  nextOdds: number;
  maneuver: Maneuver;
  maneuverUntil: number;
  side: number;
  nextAttack: number;
  /** How long it holds its bow drawn this shot (seconds). */
  bowHold: number;
  blockUntil: number;
  blockedSwing: object | undefined;
  dodgeUntil: number;
  dodge: readonly [number, number];
  readonly dodged: WeakSet<object>;
  equipped: EquipOption | undefined;
  nextEquip: number;
  equipping: boolean;
  search: CombatSearch | undefined;
  nextLine: number;
  /** Fleeing: its way away under way, cornered until, scared by a fight until. */
  fleeWay: Promise<boolean> | undefined;
  fleeFailed: boolean;
  fleeRetry: number;
  corneredUntil: number;
  scaredFrom: Vec3 | undefined;
  scaredUntil: number;
  yieldedAt: number;
  yieldUntil: number;
  /** Aggro radius warnings: since when it warns each. */
  readonly warned: Map<number, number>;
  nextWarn: number;
  /** Where its combat override package keeps it (undefined: anywhere). */
  leash: { readonly center: Vec3; readonly radius: number } | undefined;
  /** Its chase over the navmeshes towards a far target, and when it may look for a way again. */
  chase: Vec3 | undefined;
  chaseRetry: number;
  sheatheAt: number | undefined;
  /** Where its targets were last known, by target. */
  readonly lastKnown: Map<number, Vec3>;
  /** A combat style its combat override package gives (PACK CNAM). */
  packageStyle: number | undefined;
}

/** An actor weighs its fight this often (seconds). TODO(M13): the engine's rates. */
const DECIDE_SECONDS = 0.25;
/** Its profile (AI values, style, what it carries) is read again this often. */
const PROFILE_SECONDS = 3;
/** Reactions between two actors are valued again this often. */
const REACTION_SECONDS = 5;
/** Without detection, an actor knows those within this (units). */
const NEAR_SIGHT = 2048;
/** What its group saw this lately counts as seen (seconds). */
const GROUP_SIGHT = 2;
/** A far target is chased over the navmeshes beyond this past its reach (units). */
const CHASE_BEYOND = 512;
/** ... its way taken again once the target moved this far from it, or after this long when
 * no way was found (seconds). */
const CHASE_SLACK = 192;
const CHASE_RETRY = 1;
/** It strikes when its target is within this of its facing (radians). */
const STRIKE_ANGLE = Math.PI / 6;
/** A block lasts at most this long (seconds) without a blow coming. */
const BLOCK_SECONDS = 1.2;
/** A dodge lasts this long (seconds). */
const DODGE_SECONDS = 0.6;
/** A bow is held drawn this long before it looses (seconds, at random between). */
const BOW_HOLD = [0.3, 1.2] as const;
/** After combat it sheathes its weapon this long after (seconds). TODO(M13). */
const SHEATHE_DELAY = 3;
/** A cornered actor fights this long before it flees again (seconds). */
const CORNERED_SECONDS = 10;
/** A cowardly spectator flees a fight this long after its last blow (seconds). */
const SCARED_SECONDS = 10;
/** A warning (ActionIdleWarn) is played again this often (seconds). */
const WARN_SECONDS = 3;
/**
 * A teammate fights within this (× fCombatTeammateFollowRadiusMult) of the player: its follow
 * package's radius. TODO(M13): the follow package's own.
 */
const TEAMMATE_FOLLOW_RADIUS = 512;
/** A fleeing actor that got nowhere cowers this long before it tries again (seconds). */
const COWER_SECONDS = 2;

const flat = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class ActorCombatAi {
  readonly #options: ActorCombatAiOptions;
  readonly #minds = new Map<number, Mind>();
  readonly #groups = new CombatGroups();
  readonly #reactions = new Map<string, { value: number | undefined; read: number }>();
  readonly #reacting = new Set<string>();
  readonly #profiles = new CombatProfiles();
  readonly #health = new Map<number, { share: number; points: number; read: number }>();
  readonly #random = seededRandom(0xc0ba7);
  readonly #spectating = new Set<number>();
  #settings: CombatAiSettings = COMBAT_AI_DEFAULTS;
  #settingsRead = false;
  /** The running game its reactions were valued in. */
  #runtime: ScriptRuntime | undefined;
  #hooked: ActorSenses | undefined;
  #clock = 0;
  /** When the player last struck, and last had a weapon out (their yield). */
  #playerBlow = -Infinity;
  #playerArmed = -Infinity;

  constructor(options: ActorCombatAiOptions) {
    this.#options = options;
  }

  // --- What combat and the scripts ask -----------------------------------------------------------

  /** Whether an actor's combat holds it (its packages wait): fighting, searching, fleeing. */
  engaged(reference: number): boolean {
    const mode = this.#minds.get(reference)?.mode;
    return mode !== undefined && mode !== 'idle';
  }

  /** GetCombatState: 0 not in combat, 1 in combat, 2 searching. */
  combatState(reference: number): number {
    switch (this.#minds.get(reference)?.mode) {
      case 'fight':
      case 'flee':
        return 1;
      case 'search':
        return 2;
      default:
        return 0;
    }
  }

  /** IsFleeing: it flees a fight (or fear has it flee). */
  fleeing(reference: number): boolean {
    return this.#minds.get(reference)?.mode === 'flee';
  }

  /** Whether an actor fights another (for detection: it detects it down to iAICombatMinDetection). */
  fights(observer: number, target: number): boolean {
    const mind = this.#minds.get(observer);
    return mind !== undefined && mind.mode !== 'idle' && mind.target === target;
  }

  /**
   * Whether an actor is hostile to another (IsHostileToActor; detection: one not in combat
   * searches for one it is hostile to that it noticed or lost): it fights it, remembers it as
   * an enemy, or would attack it on sight (frenzied: anyone).
   */
  hostile(observer: number, target: number): boolean {
    const mind = this.#minds.get(observer);
    if (!mind) return false;
    if (mind.enemies.has(target) || (mind.mode !== 'idle' && mind.target === target)) return true;
    if (this.#options.session.scriptsReady?.magic.aiState(observer).frenzied === true) return true;
    const reaction = this.#reaction(observer, target);
    return (
      reaction !== undefined &&
      mind.profile !== undefined &&
      attacksOnSight(mind.profile.aggression, reaction)
    );
  }

  /** StartCombat: the actor fights the target (whatever its reaction). */
  startCombat(actor: number, target: number): void {
    if (actor === target || actor === PLAYER_REF) return;
    const mind = this.#mind(actor);
    mind.enemies.add(target);
    mind.next = 0;
    if (mind.mode !== 'idle') this.#setTarget(mind, target);
    else if (this.#options.host.fighter(actor)) this.#enter(mind, target, false);
  }

  /** StopCombat: the actor ends its combat (it may fight again if it meets an enemy). */
  stopCombat(actor: number): void {
    const mind = this.#minds.get(actor);
    if (!mind) {
      this.#options.host.setTarget(actor, undefined);
      return;
    }
    mind.enemies.clear();
    mind.friendHits.clear();
    if (mind.mode !== 'idle') this.#end(mind, 'stopped');
  }

  /**
   * A blow landed (or was blocked) of an attacker on a victim: the victim turns on its attacker
   * (an enemy or a neutral at once; a friend or ally after iFriendHitCombatAllowed blows, with
   * its friendly fire comment meanwhile); a yielding actor struck by the player fights on.
   */
  hit(attacker: number, victim: number): void {
    if (attacker === victim) return;
    if (attacker === PLAYER_REF) this.#playerBlow = this.#clock;
    if (victim === PLAYER_REF) return;
    const mind = this.#mind(victim);
    if (mind.mode === 'yield' && attacker === PLAYER_REF) {
      mind.enemies.add(PLAYER_REF);
      mind.mode = 'fight';
      mind.next = 0;
      return;
    }
    if (mind.enemies.has(attacker) || (mind.mode !== 'idle' && mind.target === attacker)) return;
    void this.#attacked(mind, attacker).catch((error: unknown) => {
      this.#warn(`a blow on ${victim.toString(16)}: ${describe(error)}`);
    });
  }

  async #attacked(mind: Mind, attacker: number): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return;
    const reaction = await reactionOf(runtime, mind.reference, attacker);
    const hits = (mind.friendHits.get(attacker) ?? 0) + 1;
    if (turnsOnAttacker(reaction, hits, mind.mode !== 'idle', this.#settings)) {
      mind.friendHits.delete(attacker);
      mind.enemies.add(attacker);
      mind.quarrels.add(attacker);
      mind.next = 0;
      return;
    }
    mind.friendHits.set(attacker, hits);
    // Friendly fire: its comment (the Hit infos weigh GetFriendHit), if its package allows.
    const interrupts = this.#options.ai?.()?.current(mind.reference)?.interrupts;
    if (interrupts === undefined || (interrupts & InterruptFlag.friendlyFireComments) !== 0) {
      this.#bark(mind.reference, 'Hit', attacker);
    }
  }

  /** GetFriendHit: the blows from friends an actor let pass. */
  friendHits(reference: number): number {
    let hits = 0;
    for (const count of this.#minds.get(reference)?.friendHits.values() ?? []) hits += count;
    return hits;
  }

  /** GetCombatGroupMemberCount: how many fight in its combat group (0: none). */
  groupSize(reference: number): number {
    return this.#groups.size(reference);
  }

  /** An actor left the stage or died: its combat ends, and others' memory of it goes. */
  remove(reference: number): void {
    const mind = this.#minds.get(reference);
    if (mind) {
      mind.search?.cancel();
      this.#groups.leave(reference);
      this.#minds.delete(reference);
    }
    this.#groups.forget(reference);
    this.#health.delete(reference);
    this.#spectating.delete(reference);
    for (const other of this.#minds.values()) {
      other.enemies.delete(reference);
      other.friendHits.delete(reference);
      other.warned.delete(reference);
      other.lastKnown.delete(reference);
    }
  }

  clear(): void {
    for (const mind of this.#minds.values()) mind.search?.cancel();
    this.#minds.clear();
    this.#groups.clear();
    this.#reactions.clear();
    this.#health.clear();
    this.#spectating.clear();
  }

  // --- The frame -----------------------------------------------------------------------------------

  /** Every frame (seconds), after combat's mechanics: every NPC fighter weighs and acts. */
  frame(seconds: number): void {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return;
    this.#clock += seconds;
    this.#readSettings();
    const senses = this.#options.senses?.();
    this.#hook(senses);
    const views = new Map<number, FighterView>();
    for (const view of this.#options.host.fighters()) views.set(view.reference, view);
    const player = views.get(PLAYER_REF);
    if (player && player.state.weapon !== WeaponState.sheathed) this.#playerArmed = this.#clock;
    for (const view of views.values()) {
      if (view.player || runtime.state.actors.get(view.reference)?.dead === true) continue;
      if (this.#options.ridden?.(view.reference) === true) continue;
      const mind = this.#mind(view.reference);
      this.#refreshProfile(mind, runtime);
      if (this.#clock >= mind.next) {
        mind.next = this.#clock + DECIDE_SECONDS;
        this.#decide(mind, view, views, runtime, senses);
      }
      this.#act(mind, view, views, seconds);
    }
    for (const [reference, mind] of this.#minds) {
      if (views.has(reference)) continue;
      if (runtime.state.actors.get(reference)?.dead === true) this.#fallen(reference, runtime);
      if (mind.mode !== 'idle') this.#end(mind, 'stopped', true);
      this.remove(reference);
    }
    this.#spectators(senses);
  }

  /** Detection asks combat: who is in combat, who fights whom, who is hostile to whom. */
  #hook(senses: ActorSenses | undefined): void {
    if (!senses || this.#hooked === senses) return;
    this.#hooked = senses;
    senses.inCombat = (actor) =>
      actor === PLAYER_REF ? this.#fightingPlayer() : this.combatState(actor) !== 0;
    // In combat, its own search for a lost target is the combat AI's.
    senses.hostile = (observer, target) =>
      !this.engaged(observer) && this.hostile(observer, target);
    senses.detections.inCombat = (observer, target) => this.fights(observer, target);
  }

  #fightingPlayer(): boolean {
    for (const mind of this.#minds.values()) {
      if (mind.mode !== 'idle' && mind.target === PLAYER_REF) return true;
    }
    return false;
  }

  #mind(reference: number): Mind {
    let mind = this.#minds.get(reference);
    if (!mind) {
      mind = {
        reference,
        mode: 'idle',
        target: undefined,
        enemies: new Set(),
        friendHits: new Map(),
        quarrels: new Set(),
        profile: undefined,
        profileRead: -Infinity,
        profiling: false,
        next: this.#clock + this.#random() * DECIDE_SECONDS,
        health: 1,
        healthPoints: 1,
        modifier: 0,
        nextOdds: 0,
        maneuver: 'advance',
        maneuverUntil: 0,
        side: 1,
        nextAttack: 0,
        bowHold: 0,
        blockUntil: 0,
        blockedSwing: undefined,
        dodgeUntil: 0,
        dodge: [0, 0],
        dodged: new WeakSet(),
        equipped: undefined,
        nextEquip: 0,
        equipping: false,
        search: undefined,
        nextLine: 0,
        fleeWay: undefined,
        fleeFailed: false,
        fleeRetry: 0,
        corneredUntil: 0,
        scaredFrom: undefined,
        scaredUntil: 0,
        yieldedAt: -Infinity,
        yieldUntil: 0,
        warned: new Map(),
        nextWarn: 0,
        leash: undefined,
        chase: undefined,
        chaseRetry: 0,
        sheatheAt: undefined,
        lastKnown: new Map(),
        packageStyle: undefined,
      };
      this.#minds.set(reference, mind);
    }
    return mind;
  }

  // --- Deciding ------------------------------------------------------------------------------------

  #decide(
    mind: Mind,
    view: FighterView,
    views: ReadonlyMap<number, FighterView>,
    runtime: ScriptRuntime,
    senses: ActorSenses | undefined,
  ): void {
    const profile = mind.profile;
    const state = view.state;
    if (!profile || bleedingOut(state) || state.paired !== undefined) return;
    if (!this.#options.movers.runsAi(mind.reference)) return;
    void this.#readHealth(mind, runtime).catch(() => undefined);
    const magic = runtime.magic.aiState(mind.reference);
    if (magic.paralyzed) return;
    // Calmed: it does not fight.
    if (magic.calmed) {
      if (mind.mode !== 'idle') this.#end(mind, 'stopped');
      return;
    }
    if (mind.mode === 'yield') {
      if (this.#clock < mind.yieldUntil) return;
      mind.mode = 'fight';
    }
    const candidates = this.#candidates(mind, view, views, profile, magic, senses);
    const detected = candidates.filter((candidate) => candidate.detected);
    // A cowardly spectator runs from the fight it saw.
    if (mind.mode === 'idle' && mind.scaredFrom && this.#clock < mind.scaredUntil) {
      if (detected.length === 0) {
        senses?.endReaction(mind.reference);
        mind.mode = 'flee';
        mind.fleeWay = undefined;
        this.#bark(mind.reference, 'Flee');
        return;
      }
    }
    if (mind.mode === 'idle') {
      // Into combat: on sight of an enemy; attacked by one it does not see, it searches.
      if (detected.length > 0) {
        const target = selectTarget(detected, undefined, this.#settings);
        const alerted = senses?.detections.alerted(mind.reference) !== undefined;
        if (target !== undefined) this.#enter(mind, target, alerted);
        return;
      }
      const remembered = candidates.find((candidate) => mind.enemies.has(candidate.reference));
      if (remembered) {
        this.#enter(mind, remembered.reference, true);
        this.#search(mind, remembered.reference);
      }
      return;
    }
    if (mind.mode === 'flee' && mind.scaredFrom) {
      if (this.#clock >= mind.scaredUntil) this.#end(mind, 'stopped');
      return;
    }
    if (candidates.length === 0) {
      this.#end(mind, mind.mode === 'search' ? 'lost' : 'won');
      return;
    }
    // Its target: the one target selection picks (it may switch).
    const target = selectTarget(candidates, mind.target, this.#settings);
    if (target !== undefined && target !== mind.target) this.#setTarget(mind, target);
    const sees = detected.some((candidate) => candidate.reference === mind.target);
    // Lost and found.
    if (mind.mode === 'fight' && detected.length === 0 && mind.target !== undefined) {
      this.#bark(mind.reference, 'CombatToLost', mind.target);
      this.#search(mind, mind.target);
      return;
    }
    if (mind.mode === 'search' && detected.length > 0) {
      const found = sees ? mind.target : selectTarget(detected, undefined, this.#settings);
      mind.search?.cancel();
      mind.search = undefined;
      mind.mode = 'fight';
      if (found !== undefined) this.#setTarget(mind, found);
      this.#bark(mind.reference, 'LostToCombat', found);
      return;
    }
    if (mind.mode === 'search') return;
    // The odds, now and then (fCombatThreatRatioUpdateTime).
    if (this.#clock >= mind.nextOdds) {
      mind.nextOdds = this.#clock + this.#settings.threatRatioUpdateTime;
      mind.modifier = confidenceModifier(this.#odds(mind, candidates), this.#settings);
    }
    const flee = shouldFlee(
      {
        health: mind.health,
        confidence: profile.confidence,
        modifier: mind.modifier,
        afraid: magic.fleeing,
        rallied: magic.rallied || magic.frenzied,
      },
      this.#settings,
    );
    const fightsPlayer = mind.target === PLAYER_REF;
    const playerEnemy = this.#onSight(mind, profile, magic, PLAYER_REF);
    if (mind.mode === 'fight') {
      // The player yields a quarrel of their blows: it accepts once they held off a while.
      if (
        acceptsYield({
          fightsPlayer: fightsPlayer && mind.quarrels.has(PLAYER_REF),
          playerEnemy,
          heldOff: this.#clock - Math.max(this.#playerBlow, this.#playerArmed),
          settings: this.#settings,
        })
      ) {
        mind.enemies.delete(PLAYER_REF);
        mind.quarrels.delete(PLAYER_REF);
        this.#bark(mind.reference, 'AcceptYield');
        mind.next = 0;
        return;
      }
      if (flee && this.#clock >= mind.corneredUntil) {
        if (
          yields({
            fightsPlayer,
            playerEnemy,
            wouldFlee: true,
            sinceLastYield: this.#clock - mind.yieldedAt,
            settings: this.#settings,
          })
        ) {
          this.#yield(mind);
          return;
        }
        mind.mode = 'flee';
        mind.fleeWay = undefined;
        mind.fleeFailed = false;
        this.#releaseBlock(mind, view);
        this.#bark(mind.reference, 'Flee', mind.target);
      }
      return;
    }
    // Fleeing: back to the fight once it would not flee, or cornered.
    if (!flee) {
      mind.mode = 'fight';
      return;
    }
    const enemy = mind.target === undefined ? undefined : views.get(mind.target);
    const near = enemy?.feet && view.feet ? flat(enemy.feet, view.feet) : Number.POSITIVE_INFINITY;
    if (mind.fleeFailed && near < this.#settings.corneredDistance && !magic.fleeing) {
      mind.corneredUntil = this.#clock + CORNERED_SECONDS;
      mind.mode = 'fight';
      return;
    }
    if (near > this.#fleeDistance() && detected.length === 0) this.#end(mind, 'stopped');
  }

  /**
   * Those an actor would fight that it knows of now: detected (or seen by its group), or known
   * where it last was; with their distance, threat and whether they attack it.
   */
  #candidates(
    mind: Mind,
    view: FighterView,
    views: ReadonlyMap<number, FighterView>,
    profile: Profile,
    magic: MagicAiState,
    senses: ActorSenses | undefined,
  ): TargetCandidate[] {
    const feet = view.feet;
    if (!feet) return [];
    const runtime = this.#options.session.scriptsReady;
    const candidates: TargetCandidate[] = [];
    const leash = profile.teammate ? views.get(PLAYER_REF)?.feet : undefined;
    for (const other of views.values()) {
      const reference = other.reference;
      if (reference === mind.reference || !other.feet) continue;
      if (other.state.life === LifeState.dead || bleedingOut(other.state)) continue;
      if (runtime?.state.actors.get(reference)?.dead === true) continue;
      // Teammates fight near the player (fCombatTeammateFollowRadiusMult).
      if (
        leash &&
        flat(leash, other.feet) > this.#settings.teammateFollowRadiusMult * TEAMMATE_FOLLOW_RADIUS
      ) {
        continue;
      }
      const known = senses
        ? senses.detections.state(mind.reference, reference)
        : flat(feet, other.feet) < NEAR_SIGHT
          ? 'detected'
          : 'unseen';
      const group = this.#groups.lastSeen(mind.reference, reference);
      const groupSees = group !== undefined && this.#clock - group.seen < GROUP_SIGHT;
      const detected = known === 'detected' || groupSees;
      const lastKnown =
        known === 'detected'
          ? other.feet
          : groupSees
            ? group.at
            : (senses?.detections.lastKnown(mind.reference, reference) ??
              mind.lastKnown.get(reference));
      // Not detected, it counts where it was last known: one it fights or remembers, or (in
      // combat) one detection still searches for.
      const remembered =
        lastKnown !== undefined &&
        (mind.enemies.has(reference) ||
          (mind.mode !== 'idle' && (mind.target === reference || known !== 'unseen')));
      if (!detected && !remembered) continue;
      if (!this.#hostileTo(mind, view, profile, magic, other, views, detected)) continue;
      if (known === 'detected') {
        mind.lastKnown.set(reference, other.feet);
        this.#groups.saw(mind.reference, reference, other.feet, this.#clock);
      } else if (lastKnown) {
        mind.lastKnown.set(reference, lastKnown);
      }
      const health = this.#health.get(reference)?.points ?? 100;
      candidates.push({
        reference,
        distance: flat(feet, detected ? other.feet : (lastKnown ?? other.feet)),
        detected,
        attacking: this.#fightTarget(other, views) === mind.reference,
        threat: actorStrength(health, other.gear?.damage ?? 1),
      });
    }
    return candidates;
  }

  /** Whether `mind` fights `other` now (see the file's comment). */
  #hostileTo(
    mind: Mind,
    view: FighterView,
    profile: Profile,
    magic: MagicAiState,
    other: FighterView,
    views: ReadonlyMap<number, FighterView>,
    detected: boolean,
  ): boolean {
    const reference = other.reference;
    if (magic.frenzied) return true;
    if (mind.enemies.has(reference)) return true;
    const reaction = this.#reaction(mind.reference, reference);
    if (reaction === undefined) return false;
    // A package that ignores combat (PKDT Ignore Combat) keeps it out of fights it would pick.
    const running = this.#options.ai?.()?.current(mind.reference);
    if (running && (running.flags & PackageFlag.ignoreCombat) !== 0) return false;
    if (attacksOnSight(profile.aggression, reaction)) {
      if (mind.mode !== 'idle' || !profile.aggroRadius || !detected) return true;
      // Its aggro radius, where its package has the behaviour.
      if (running && (running.interrupts & InterruptFlag.aggroRadiusBehavior) === 0) return true;
      return this.#aggro(mind, view, other, profile.aggroRadius);
    }
    const close = reaction === FightReaction.ally || reaction === FightReaction.friend;
    if (close) return false;
    // Helping: one it helps fights `other`, or `other` fights one it helps.
    const assistance = profile.teammate
      ? Math.max(profile.assistance, Assistance.helpsFriendsAndAllies)
      : profile.assistance;
    for (const fighter of views.values()) {
      if (fighter.reference === mind.reference) continue;
      const target = this.#fightTarget(fighter, views);
      if (target === undefined) continue;
      if (fighter.reference === reference && target !== mind.reference) {
        // `other` attacks `target`: help the victim; guards help any innocent (TODO(M11):
        // crime's guards and their warnings, bounties).
        const victim = this.#reaction(mind.reference, target);
        if (victim !== undefined && assists(assistance, victim)) return this.#join(mind, reference);
        if (profile.guard && victim !== FightReaction.enemy && this.#innocent(target, reference)) {
          return this.#join(mind, reference);
        }
      } else if (target === reference) {
        // `fighter` fights `other`: help it.
        const ally = this.#reaction(mind.reference, fighter.reference);
        if (ally !== undefined && assists(assistance, ally)) return this.#join(mind, reference);
      }
    }
    return false;
  }

  /**
   * Whom a fighter fights now, if it does: an actor its combat (fighting, not searching), the
   * player one they struck lately (GetAttacked's fDetectionStateExpireTime); the one fought
   * alive and on its feet.
   */
  #fightTarget(fighter: FighterView, views: ReadonlyMap<number, FighterView>): number | undefined {
    let target: number | undefined;
    if (fighter.player) {
      target = fighter.target;
      const struck = this.#options.senses?.()?.detections.attackedBy(target ?? -1);
      if (struck !== PLAYER_REF) return undefined;
    } else {
      const mind = this.#minds.get(fighter.reference);
      target = mind?.mode === 'fight' ? mind.target : undefined;
    }
    const victim = target === undefined ? undefined : views.get(target);
    if (!victim || victim.state.life === LifeState.dead || bleedingOut(victim.state)) {
      return undefined;
    }
    return target;
  }

  /**
   * Whether a victim did not bring a fight on itself: it did not strike its attacker first
   * (GetAttacked), and it would not attack it on sight itself (a bandit attacked is no
   * innocent).
   */
  #innocent(victim: number, attacker: number): boolean {
    if (this.#options.senses?.()?.detections.attackedBy(attacker) === victim) return false;
    const mind = this.#minds.get(victim);
    const magic = this.#options.session.scriptsReady?.magic.aiState(victim);
    if (!mind?.profile || !magic) return true;
    return !this.#onSight(mind, mind.profile, magic, attacker);
  }

  /** It takes up another's fight: it remembers `enemy` as its own. */
  #join(mind: Mind, enemy: number): true {
    mind.enemies.add(enemy);
    return true;
  }

  /** Whether it would attack the player on sight (they are its enemy, not just its quarrel). */
  #onSight(mind: Mind, profile: Profile, magic: MagicAiState, other: number): boolean {
    if (magic.frenzied) return true;
    const reaction = this.#reaction(mind.reference, other);
    return reaction !== undefined && attacksOnSight(profile.aggression, reaction);
  }

  /**
   * The aggro radius (AIDT): one it would attack on sight is left alone beyond the warn radius,
   * warned within it (ActionIdleWarn, facing it), attacked within the attack radius or once
   * warned within the warn-or-attack radius.
   */
  #aggro(
    mind: Mind,
    view: FighterView,
    other: FighterView,
    radii: readonly [number, number, number],
  ): boolean {
    const feet = view.feet;
    const there = other.feet;
    if (!feet || !there) return false;
    const since = mind.warned.get(other.reference);
    const response = aggroResponse(
      flat(feet, there),
      radii,
      since === undefined ? 0 : this.#clock - since,
    );
    if (response === 'ignore') {
      // Out of its warn radius: it turns back to what its package has it do.
      if (mind.warned.delete(other.reference))
        this.#options.movers.request(mind.reference, undefined);
      return false;
    }
    if (response === 'attack') return true;
    if (since === undefined) mind.warned.set(other.reference, this.#clock);
    this.#options.movers.request(mind.reference, { gait: 'walk', face: headingTo(feet, there) });
    if (this.#clock >= mind.nextWarn) {
      mind.nextWarn = this.#clock + WARN_SECONDS;
      void this.#options.host.act(mind.reference, 'ActionIdleWarn', other.reference);
    }
    return false;
  }

  /** The fight's odds for its side: its targets' strength against its group's. */
  #odds(mind: Mind, candidates: readonly TargetCandidate[]): number {
    const side = [actorStrength(mind.healthPoints, this.#damageOf(mind.reference))];
    for (const ally of this.#groups.allies(mind.reference)) {
      side.push(actorStrength(this.#health.get(ally)?.points ?? 100, this.#damageOf(ally)));
    }
    return threatRatio(
      candidates.map((candidate) => candidate.threat),
      side,
    );
  }

  #damageOf(reference: number): number {
    return this.#options.host.fighter(reference)?.gear?.damage ?? 1;
  }

  // --- Entering, leaving ---------------------------------------------------------------------------

  /** Into combat with a target (NormalToCombat, or AlertToCombat when it was alerted). */
  #enter(mind: Mind, target: number, alerted: boolean): void {
    const reference = mind.reference;
    mind.mode = 'fight';
    mind.warned.clear();
    mind.sheatheAt = undefined;
    mind.nextLine = this.#clock + this.#between(this.#settings.tauntMin, this.#settings.tauntMax);
    mind.nextEquip = 0;
    this.#setTarget(mind, target);
    // Its combat group: of an ally already fighting beside it.
    const allies: number[] = [];
    for (const other of this.#minds.values()) {
      if (other === mind || other.mode === 'idle') continue;
      const reaction = this.#reaction(reference, other.reference);
      if (reaction === FightReaction.ally || reaction === FightReaction.friend) {
        allies.push(other.reference);
      }
    }
    this.#groups.join(reference, allies);
    // Its package's way gives way to the fight; off its horse.
    const movers = this.#options.movers;
    this.#options.senses?.()?.endReaction(reference);
    if (movers.travelOf(reference)) movers.stop(reference);
    void this.#options.dismount?.(reference);
    void this.#leash(mind);
    this.#bark(reference, alerted ? 'AlertToCombat' : 'NormalToCombat', target);
  }

  /** Its combat override package's place (ECOR), if it has one. */
  async #leash(mind: Mind): Promise<void> {
    mind.leash = undefined;
    mind.packageStyle = undefined;
    const list = this.#options.senses?.()?.combatOverrides(mind.reference);
    if (list === undefined) return;
    const found = await this.#options.ai?.()?.combatPlace(mind.reference, list);
    if (mind.mode === 'idle' || !found) return;
    mind.packageStyle = found.combatStyle;
    if (found.place) {
      mind.leash = { center: found.place.position, radius: Math.max(64, found.place.radius) };
    }
    if (found.combatStyle !== undefined) mind.profileRead = -Infinity;
  }

  #setTarget(mind: Mind, target: number): void {
    mind.target = target;
    mind.maneuverUntil = 0;
    this.#options.host.setTarget(mind.reference, target);
  }

  /** Its search for a lost target begins (CombatSearch: to where it was last known). */
  #search(mind: Mind, target: number): void {
    const at = mind.lastKnown.get(target) ?? this.#options.host.fighter(target)?.feet;
    const movers = this.#options.movers;
    const reference = mind.reference;
    mind.mode = 'search';
    this.#releaseBlock(mind, this.#options.host.fighter(reference));
    mind.chase = undefined;
    movers.request(reference, undefined);
    mind.nextLine =
      this.#clock + this.#between(this.#settings.searchLineMin, this.#settings.searchLineMax);
    if (!at) {
      this.#end(mind, 'lost');
      return;
    }
    const settings = this.#options.senses?.()?.settings ?? readDetectionSettings();
    mind.search?.cancel();
    mind.search = new CombatSearch(
      at,
      {
        position: () => this.#options.host.fighter(reference)?.feet,
        travel: (to, arrive, run) => movers.travel(reference, to, run ? 'run' : 'walk', arrive),
        face: (heading) => {
          movers.request(reference, { gait: 'walk', face: heading });
        },
        stop: () => {
          movers.stop(reference);
          movers.request(reference, undefined);
        },
      },
      settings,
      this.#random,
    );
  }

  /** It yields to the player (Yield): out of the fight for fCombatYieldTime, weapon away. */
  #yield(mind: Mind): void {
    mind.mode = 'yield';
    mind.yieldedAt = this.#clock;
    mind.yieldUntil = this.#clock + this.#settings.yieldTime;
    mind.enemies.delete(PLAYER_REF);
    this.#releaseBlock(mind, this.#options.host.fighter(mind.reference));
    this.#options.movers.request(mind.reference, undefined);
    void this.#options.host.sheathe(mind.reference);
    this.#bark(mind.reference, 'Yield');
  }

  /**
   * Its combat ends: it won (CombatToNormal), gave up its search (LostToNormal), or was
   * stopped. It leaves its group, stands, sheathes a while after, and its packages go on.
   */
  #end(mind: Mind, how: 'won' | 'lost' | 'stopped', silent = false): void {
    const reference = mind.reference;
    const target = mind.target;
    if (!silent && how === 'won') this.#bark(reference, 'CombatToNormal', target);
    if (!silent && how === 'lost') this.#bark(reference, 'LostToNormal', target);
    mind.mode = 'idle';
    mind.target = undefined;
    mind.search?.cancel();
    mind.search = undefined;
    mind.chase = undefined;
    mind.leash = undefined;
    mind.fleeWay = undefined;
    mind.scaredFrom = undefined;
    mind.enemies.clear();
    mind.friendHits.clear();
    mind.quarrels.clear();
    mind.lastKnown.clear();
    mind.sheatheAt = this.#clock + SHEATHE_DELAY;
    if (mind.packageStyle !== undefined) {
      mind.packageStyle = undefined;
      mind.profileRead = -Infinity;
    }
    const host = this.#options.host;
    host.setTarget(reference, undefined);
    this.#releaseBlock(mind, host.fighter(reference));
    this.#groups.leave(reference);
    const movers = this.#options.movers;
    movers.request(reference, undefined);
    if (movers.travelOf(reference)) movers.stop(reference);
    if (how === 'lost') this.#options.senses?.()?.detections.calm(reference);
    this.#options.ai?.()?.evaluate(reference);
  }

  // --- Acting --------------------------------------------------------------------------------------

  #act(
    mind: Mind,
    view: FighterView,
    views: ReadonlyMap<number, FighterView>,
    seconds: number,
  ): void {
    const host = this.#options.host;
    const state = view.state;
    if (mind.mode === 'idle') {
      // After combat its weapon goes away (unless its package keeps it drawn).
      if (mind.sheatheAt !== undefined && this.#clock >= mind.sheatheAt) {
        mind.sheatheAt = undefined;
        const flags = this.#options.ai?.()?.current(mind.reference)?.flags ?? 0;
        if (state.weapon === WeaponState.drawn && (flags & PackageFlag.weaponDrawn) === 0) {
          void host.sheathe(mind.reference);
        }
      }
      return;
    }
    if (!canAct(state) || bleedingOut(state)) return;
    switch (mind.mode) {
      case 'search': {
        if (this.#clock >= mind.nextLine) {
          mind.nextLine =
            this.#clock + this.#between(this.#settings.searchLineMin, this.#settings.searchLineMax);
          this.#bark(mind.reference, 'LostIdle', mind.target);
        }
        if (mind.search?.update(seconds) === 'gave-up') this.#end(mind, 'lost');
        return;
      }
      case 'flee':
        this.#flee(mind, view, views);
        return;
      case 'yield': {
        const player = views.get(PLAYER_REF)?.feet;
        if (player && view.feet) {
          this.#options.movers.request(mind.reference, {
            gait: 'walk',
            face: headingTo(view.feet, player),
          });
        }
        return;
      }
      default:
        this.#fight(mind, view, views);
    }
  }

  /** Fighting its target: what it holds, how it moves, its attacks, blocks and dodges. */
  #fight(mind: Mind, view: FighterView, views: ReadonlyMap<number, FighterView>): void {
    const profile = mind.profile;
    const target = mind.target === undefined ? undefined : views.get(mind.target);
    const feet = view.feet;
    if (!profile || !target || !feet) return;
    const host = this.#options.host;
    const movers = this.#options.movers;
    const reference = mind.reference;
    const state = view.state;
    const there = target.feet ?? mind.lastKnown.get(target.reference);
    if (!there) return;
    const distance = flat(feet, there);
    const facing = headingTo(feet, there);
    // What it fights with (its style's scores), now and then.
    if (this.#clock >= mind.nextEquip && !mind.equipping) {
      mind.nextEquip = this.#clock + this.#settings.inventoryUpdateTime;
      void this.#chooseEquipment(mind, view, distance).catch((error: unknown) => {
        mind.equipping = false;
        this.#warn(`${reference.toString(16)} equipment: ${describe(error)}`);
      });
    }
    if (mind.equipping) return;
    if (state.weapon === WeaponState.sheathed) {
      void host.draw(reference);
      return;
    }
    if (state.weapon !== WeaponState.drawn) return;
    if (this.#dodge(mind, view, facing)) return;
    // Its combat override package's place: back to it, and fight from there.
    const leash = mind.leash;
    const tethered = leash !== undefined && flat(feet, leash.center) > leash.radius;
    if (tethered && !mind.chase) {
      mind.chase = leash.center;
      void movers.travel(reference, leash.center, 'run', leash.radius / 2).then(() => {
        if (mind.chase === leash.center) mind.chase = undefined;
      });
    }
    const option = mind.equipped;
    const casting =
      option && (option.kind === 'magic' || option.kind === 'staff' || option.kind === 'shout');
    if (casting) {
      this.#cast(mind, view, target.reference, option, distance, facing);
      return;
    }
    if (view.gear?.bow === true) {
      this.#shoot(mind, view, profile, distance, facing, there, tethered);
      return;
    }
    this.#defend(mind, view, target, distance);
    this.#melee(mind, view, target, profile, distance, facing, there, tethered);
    if (this.#clock >= mind.nextLine) {
      mind.nextLine = this.#clock + this.#between(this.#settings.tauntMin, this.#settings.tauntMax);
      this.#bark(reference, 'Taunt', target.reference);
    }
  }

  /** Close combat: the style's maneuvers about its reach, and its attacks. */
  #melee(
    mind: Mind,
    view: FighterView,
    target: FighterView,
    profile: Profile,
    distance: number,
    facing: number,
    there: Vec3,
    tethered: boolean,
  ): void {
    const movers = this.#options.movers;
    const reference = mind.reference;
    const reach = view.reach + target.radius;
    if (tethered) return;
    // Its combat override package's place: it does not leave it for a target beyond.
    const leash = mind.leash;
    if (leash && flat(there, leash.center) > leash.radius + reach) {
      movers.request(reference, { gait: 'walk', face: facing });
      return;
    }
    // Far: over the navmeshes, running, its way taken again as the target moves.
    if (distance > reach + CHASE_BEYOND) {
      this.#chase(mind, there, reach * 0.8);
      return;
    }
    if (mind.chase) {
      mind.chase = undefined;
      movers.stop(reference);
    }
    const style = profile.style;
    if (this.#clock >= mind.maneuverUntil) {
      mind.maneuver = chooseManeuver(
        style,
        {
          distance,
          reach,
          ranged: false,
          targetAttacking: attacking(target.state) && target.target === reference,
          allies: this.#alliesOn(mind, target.reference),
        },
        this.#random,
        this.#settings,
      );
      mind.maneuverUntil = this.#clock + this.#between(...MANEUVER_SECONDS);
      mind.side = this.#random() < 0.5 ? -1 : 1;
    }
    const state = view.state;
    const feet = view.feet ?? there;
    const standing =
      attacking(state) ||
      (mind.maneuver === 'advance' && distance <= reach * 0.85) ||
      (mind.maneuver === 'stalk' && distance <= reach * 1.5 && distance > reach) ||
      mind.maneuver === 'hold';
    if (standing) {
      movers.request(reference, { gait: 'walk', face: facing });
    } else {
      const direction = maneuverDirection(mind.maneuver, feet, there, mind.side);
      const gait: Gait = mind.maneuver === 'advance' && distance > reach * 2 ? 'run' : 'walk';
      movers.request(reference, { direction, gait, face: facing });
    }
    // Its attack: within reach and facing it, in its own time.
    if (distance > reach || Math.abs(turnBetween(view.heading, facing)) > STRIKE_ANGLE) return;
    if (this.#clock < mind.nextAttack) return;
    const chaining =
      state.attack === AttackState.nextAttack || state.attack === AttackState.followThrough;
    if (attacking(state) && !chaining && !state.blocking) return;
    const gear = view.gear;
    const choice = chooseAttack(
      style,
      {
        targetStaggered: target.state.staggered,
        targetBlocking: target.state.blocking,
        targetAttacking: attacking(target.state),
        targetPowerAttacking: target.state.current?.power === true,
        targetRecoiling: target.state.recoiling,
        blocking: state.blocking,
        canBash: gear?.canBash === true,
        powerChance: gear?.powerChance ?? 0,
        allies: this.#alliesOn(mind, target.reference),
      },
      this.#random,
    );
    mind.nextAttack = this.#clock + attackInterval(style, this.#random);
    const host = this.#options.host;
    switch (choice) {
      case 'attack':
      case 'bash':
        void host.attack(reference, 'ActionRightAttack');
        break;
      case 'power':
      case 'powerBash':
        void host.attack(reference, 'ActionRightPowerAttack');
        break;
      default:
        break;
    }
  }

  /**
   * After a far target over the navmeshes, running; the way taken again as it moves on, and a
   * moment after a way that could not be found.
   */
  #chase(mind: Mind, there: Vec3, arrive: number): void {
    if (this.#clock < mind.chaseRetry) return;
    if (mind.chase && flat(mind.chase, there) <= CHASE_SLACK) return;
    const to: Vec3 = [there[0], there[1], there[2]];
    mind.chase = to;
    void this.#options.movers.travel(mind.reference, to, 'run', arrive).then((arrived) => {
      if (mind.chase !== to) return;
      mind.chase = undefined;
      if (!arrived) mind.chaseRetry = this.#clock + CHASE_RETRY;
    });
  }

  /** At range with a bow: the style's distance and strafing; draw, hold, loose. */
  #shoot(
    mind: Mind,
    view: FighterView,
    profile: Profile,
    distance: number,
    facing: number,
    there: Vec3,
    tethered: boolean,
  ): void {
    const movers = this.#options.movers;
    const host = this.#options.host;
    const reference = mind.reference;
    const range = view.gear?.range ?? 4096;
    if (!tethered) {
      if (distance > range) {
        this.#chase(mind, there, range * 0.8);
        return;
      }
      if (mind.chase) {
        mind.chase = undefined;
        movers.stop(reference);
      }
      if (this.#clock >= mind.maneuverUntil) {
        mind.maneuver = chooseManeuver(
          profile.style,
          {
            distance,
            reach: range,
            ranged: true,
            targetAttacking: false,
            allies: this.#alliesOn(mind, mind.target ?? 0),
          },
          this.#random,
          this.#settings,
        );
        mind.maneuverUntil = this.#clock + this.#between(...MANEUVER_SECONDS);
        mind.side = this.#random() < 0.5 ? -1 : 1;
      }
      const feet = view.feet ?? there;
      if (mind.maneuver === 'hold') {
        movers.request(reference, { gait: 'walk', face: facing });
      } else {
        const direction = maneuverDirection(mind.maneuver, feet, there, mind.side);
        movers.request(reference, { direction, gait: 'walk', face: facing });
      }
    }
    const state = view.state;
    if (Math.abs(turnBetween(view.heading, facing)) > STRIKE_ANGLE) return;
    // Loose once drawn and held a moment; else draw (TODO(M13): its line of fire).
    if (state.attack === AttackState.bowDrawn && state.drawnFor >= mind.bowHold) {
      void host.release(reference, 'ActionRightRelease');
      mind.nextAttack = this.#clock + attackInterval(profile.style, this.#random);
    } else if (!attacking(state) && this.#clock >= mind.nextAttack) {
      void host.attack(reference, 'ActionRightAttack');
      mind.bowHold = this.#between(...BOW_HOLD);
      mind.nextAttack = this.#clock + 0.5;
    }
  }

  /**
   * A spell, staff or shout it fights with (5.3's castAt): facing its target within the
   * option's range, it casts. TODO(M10) 5.3: the casting itself is magic's.
   */
  #cast(
    mind: Mind,
    view: FighterView,
    target: number,
    option: EquipOption,
    distance: number,
    facing: number,
  ): void {
    const movers = this.#options.movers;
    const reference = mind.reference;
    if (distance > option.range) {
      movers.request(reference, {
        direction: [Math.sin(facing), Math.cos(facing)],
        gait: 'run',
        face: facing,
      });
      return;
    }
    movers.request(reference, { gait: 'walk', face: facing });
    if (this.#clock < mind.nextAttack || Math.abs(turnBetween(view.heading, facing)) > STRIKE_ANGLE)
      return;
    const casting = this.#options.casting?.();
    const style = mind.profile?.style ?? NO_STYLE;
    mind.nextAttack = this.#clock + attackInterval(style, this.#random) * 2;
    if (!casting) return;
    const hand = option.kind === 'shout' ? 'voice' : 'right';
    void casting.castAt(reference, hand, target, option);
  }

  /** It blocks a blow coming at it (its style's defensive mult), and lets go after. */
  #defend(mind: Mind, view: FighterView, target: FighterView, distance: number): void {
    const state = view.state;
    const swing = target.state.current;
    const coming =
      swing !== undefined &&
      !swing.ranged &&
      target.target === mind.reference &&
      distance <= target.reach + view.radius + 32;
    if (state.blocking) {
      if (!coming || this.#clock >= mind.blockUntil) this.#releaseBlock(mind, view);
      return;
    }
    if (!coming || mind.blockedSwing === swing || attacking(state)) return;
    if (view.gear?.canBlock !== true) return;
    mind.blockedSwing = swing;
    const style = mind.profile?.style ?? NO_STYLE;
    const shield = view.gear.shield;
    if (!choosesBlock(style, shield, this.#random, this.#settings)) return;
    mind.blockUntil = this.#clock + BLOCK_SECONDS;
    void this.#options.host.block(mind.reference, true);
  }

  #releaseBlock(mind: Mind, view: FighterView | undefined): void {
    if (view?.state.blocking !== true) return;
    mind.blockUntil = 0;
    void this.#options.host.block(mind.reference, false);
  }

  /**
   * A threat coming at it (an arrow; a spell or a breath: 5.3, 5.4): by its style's avoid
   * threat chance it sidesteps out of the line (AvoidThreat). Whether it dodges now.
   */
  #dodge(mind: Mind, view: FighterView, facing: number): boolean {
    const feet = view.feet;
    if (!feet) return false;
    if (this.#clock < mind.dodgeUntil) {
      this.#options.movers.request(mind.reference, {
        direction: mind.dodge,
        gait: 'run',
        face: facing,
      });
      return true;
    }
    const style = mind.profile?.style ?? NO_STYLE;
    for (const threat of this.#options.host.threats()) {
      if (threat.source === mind.reference || mind.dodged.has(threat.key)) continue;
      if (threatens(threat, feet, view.radius, view.height) === undefined) continue;
      mind.dodged.add(threat.key);
      if (!avoidsThreat(style, this.#random)) continue;
      mind.dodge = dodgeDirection(threat, feet);
      mind.dodgeUntil = this.#clock + DODGE_SECONDS;
      this.#bark(mind.reference, 'AvoidThreat', threat.source);
      return true;
    }
    return false;
  }

  /**
   * Fleeing: running from its enemy over the navmeshes, fFleeDistance away; where it cannot go
   * on it cowers (ActionIdle: the idles IsFleeing picks) until cornered.
   */
  #flee(mind: Mind, view: FighterView, views: ReadonlyMap<number, FighterView>): void {
    const feet = view.feet;
    const from =
      mind.scaredFrom ??
      (mind.target === undefined ? undefined : views.get(mind.target)?.feet) ??
      (mind.target === undefined ? undefined : mind.lastKnown.get(mind.target));
    if (!feet || !from || mind.fleeWay || this.#clock < mind.fleeRetry) return;
    this.#releaseBlock(mind, view);
    const away = Math.hypot(feet[0] - from[0], feet[1] - from[1]) || 1;
    const reach = this.#fleeDistance();
    const to: Vec3 = [
      feet[0] + ((feet[0] - from[0]) / away) * reach,
      feet[1] + ((feet[1] - from[1]) / away) * reach,
      feet[2],
    ];
    const way = this.#options.movers.travel(mind.reference, to, 'run', 256);
    mind.fleeWay = way;
    void way.then((arrived) => {
      if (mind.fleeWay !== way) return;
      mind.fleeWay = undefined;
      mind.fleeFailed = !arrived;
      // Nowhere further: it cowers a moment before it tries again.
      mind.fleeRetry = this.#clock + COWER_SECONDS;
      void this.#options.host.act(mind.reference, 'ActionIdle');
    });
  }

  #fleeDistance(): number {
    return this.#options.interior?.() === true
      ? this.#settings.fleeDistanceInterior
      : this.#settings.fleeDistanceExterior;
  }

  /** How many others of its group fight the same target. */
  #alliesOn(mind: Mind, target: number): number {
    let count = 0;
    for (const ally of this.#groups.allies(mind.reference)) {
      if (this.#minds.get(ally)?.target === target) count++;
    }
    return count;
  }

  /**
   * What it fights with (its style's equipment scores against the range): it takes up the best
   * of what it carries (sheathing first), or fights with its fists.
   */
  async #chooseEquipment(mind: Mind, view: FighterView, distance: number): Promise<void> {
    const profile = mind.profile;
    const runtime = this.#options.session.scriptsReady;
    if (!profile || !runtime) return;
    const casting = this.#options.casting?.();
    const spells = casting ? await casting.options(mind.reference) : [];
    const current = view.gear?.weapon;
    const options = [...profile.options, ...spells].map((option) => ({
      ...option,
      equipped:
        option.kind === 'unarmed'
          ? current === undefined
          : option.kind === 'melee' || option.kind === 'ranged'
            ? option.id === current
            : mind.equipped?.id === option.id,
    }));
    const best = chooseEquipment(options, distance, profile.style, this.#settings);
    if (!best) return;
    mind.equipped = best;
    if (best.kind === 'magic' || best.kind === 'staff' || best.kind === 'shout') return;
    if (best.equipped) return;
    // Another weapon: sheathed first, then taken up (and arrows for a bow), then drawn again.
    mind.equipping = true;
    try {
      const host = this.#options.host;
      if (view.state.weapon !== WeaponState.sheathed) {
        await host.sheathe(mind.reference);
        await this.#until(
          () => host.fighter(mind.reference)?.state.weapon === WeaponState.sheathed,
        );
      }
      const equipment = runtime.equipment;
      if (best.kind === 'unarmed') {
        if (current !== undefined) await equipment.unequip(mind.reference, current);
      } else if (best.id !== undefined) {
        await equipment.equip(mind.reference, best.id, { hand: 'right' });
        if (best.kind === 'ranged') await this.#equipAmmo(mind.reference, best.id, runtime);
      }
    } finally {
      mind.equipping = false;
    }
  }

  /** Arrows for a bow, bolts for a crossbow: the best it carries. */
  async #equipAmmo(actor: number, weapon: number, runtime: ScriptRuntime): Promise<void> {
    const equipment = runtime.equipment;
    const arrows = (await equipment.item(weapon))?.weapon?.weaponType === WeaponType.bow;
    let best: { id: number; damage: number } | undefined;
    for (const [form, count] of await runtime.inventory(actor)) {
      if (count <= 0) continue;
      const item = await equipment.item(form);
      if (item?.type !== 'AMMO') continue;
      if ((((item.ammoFlags ?? 0) & AmmoFlag.nonBolt) !== 0) !== arrows) continue;
      const damage = item.ammoDamage ?? 0;
      if (!best || damage > best.damage) best = { id: form, damage };
    }
    if (best && (await equipment.ammo(actor)) !== best.id) await equipment.equip(actor, best.id);
  }

  /** Resolves once a test holds (or after a while). */
  #until(test: () => boolean, limit = 3000): Promise<void> {
    return new Promise((resolve) => {
      const started = Date.now();
      const check = (): void => {
        if (test() || Date.now() - started > limit) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
  }

  // --- Spectators and the fallen ----------------------------------------------------------------

  /**
   * Those watching a fight (detection's spectating: their package lets them observe combat)
   * say their ObserveCombat line; a cowardly one runs from it instead.
   */
  #spectators(senses: ActorSenses | undefined): void {
    if (!senses) return;
    for (const mind of this.#minds.values()) {
      const reference = mind.reference;
      const watching = mind.mode === 'idle' && senses.reacting(reference) === 'spectator';
      if (!watching) {
        this.#spectating.delete(reference);
        continue;
      }
      if (this.#spectating.has(reference)) continue;
      this.#spectating.add(reference);
      if (mind.profile?.confidence === Confidence.cowardly) {
        const fighter = this.#nearestFight(reference);
        if (fighter) {
          mind.scaredFrom = fighter;
          mind.scaredUntil = this.#clock + SCARED_SECONDS;
          mind.next = 0;
          continue;
        }
      }
      this.#bark(reference, 'ObserveCombat');
    }
  }

  /** Where the nearest fight to an actor is (a fighter's feet). */
  #nearestFight(reference: number): Vec3 | undefined {
    const feet = this.#options.host.fighter(reference)?.feet;
    if (!feet) return undefined;
    let best: { at: Vec3; distance: number } | undefined;
    for (const view of this.#options.host.fighters()) {
      if (view.target === undefined || !view.feet || view.reference === reference) continue;
      const distance = flat(feet, view.feet);
      if (!best || distance < best.distance) best = { at: view.feet, distance };
    }
    return best?.at;
  }

  /** A member of a combat group died: one of the others says AllyKilled. */
  #fallen(member: number, runtime: ScriptRuntime): void {
    for (const other of this.#groups.allies(member)) {
      if (runtime.state.actors.get(other)?.dead === true) continue;
      this.#bark(other, 'AllyKilled', member);
      return;
    }
  }

  // --- Reading ---------------------------------------------------------------------------------------

  /** How `actor` regards `other` (combat-reactions.ts), as last valued (undefined: not yet). */
  #reaction(actor: number, other: number): number | undefined {
    const key = `${String(actor)}:${String(other)}`;
    const kept = this.#reactions.get(key);
    const runtime = this.#options.session.scriptsReady;
    if (
      runtime &&
      (!kept || this.#clock - kept.read > REACTION_SECONDS) &&
      !this.#reacting.has(key)
    ) {
      this.#reacting.add(key);
      if (this.#runtime !== runtime) {
        this.#runtime = runtime;
        this.#reactions.clear();
      }
      void reactionOf(runtime, actor, other)
        .then((value) => {
          this.#reactions.set(key, { value, read: this.#clock });
        })
        .catch(() => {
          this.#reactions.set(key, { value: undefined, read: this.#clock });
        })
        .finally(() => this.#reacting.delete(key));
    }
    return kept?.value;
  }

  #refreshProfile(mind: Mind, runtime: ScriptRuntime): void {
    if (mind.profiling || this.#clock - mind.profileRead < PROFILE_SECONDS) return;
    mind.profiling = true;
    const view = this.#options.host.fighter(mind.reference);
    const held = view && {
      weapon: view.gear?.weapon,
      range: view.gear?.range ?? 0,
      reach: view.reach,
    };
    void this.#profiles
      .read(runtime, mind.reference, mind.packageStyle, held)
      .then((profile) => {
        mind.profile = profile;
      })
      .catch((error: unknown) => {
        this.#warn(`${mind.reference.toString(16)}: ${describe(error)}`);
      })
      .finally(() => {
        mind.profiling = false;
        mind.profileRead = this.#clock;
      });
  }

  async #readHealth(mind: Mind, runtime: ScriptRuntime): Promise<void> {
    const kept = this.#health.get(mind.reference);
    if (kept && this.#clock - kept.read < DECIDE_SECONDS) return;
    const value = await runtime.actors.value(mind.reference, ActorValue.health);
    const share = value.max > 0 ? value.current / value.max : 0;
    mind.health = share;
    mind.healthPoints = value.current;
    this.#health.set(mind.reference, { share, points: value.current, read: this.#clock });
    // The player's too, for the odds.
    const player = this.#health.get(PLAYER_REF);
    if (!player || this.#clock - player.read > 1) {
      const own = await runtime.actors.value(PLAYER_REF, ActorValue.health);
      this.#health.set(PLAYER_REF, {
        share: own.max > 0 ? own.current / own.max : 0,
        points: own.current,
        read: this.#clock,
      });
    }
  }

  #readSettings(): void {
    if (this.#settingsRead) return;
    this.#settingsRead = true;
    void this.#options.session.settings().then((settings) => {
      this.#settings = readCombatAiSettings((name) => settings.number(name));
    });
  }

  #between(min: number, max: number): number {
    return min + (max - min) * this.#random();
  }

  /** A line of a topic subtype (src/shell/actor-talk.ts bark). */
  #bark(actor: number, subtype: string, target?: number): void {
    const talk = this.#options.talk?.();
    if (!talk) return;
    talk.bark(actor, subtype, target ?? PLAYER_REF).catch((error: unknown) => {
      this.#warn(`a ${subtype} line: ${describe(error)}`);
    });
  }

  #warn(message: string): void {
    this.#options.terminal.log('combat', message, 'warn');
  }
}
