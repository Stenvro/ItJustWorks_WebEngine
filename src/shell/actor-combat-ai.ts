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
import {
  CombatGroups,
  readCombatGroupSettings,
  type CombatGroupWorld,
  type DetectionReport,
  type GroupTarget,
} from '../ai/combat-groups.ts';
import { CombatProfiles, NO_STYLE, type CombatProfile } from '../ai/combat-profile.ts';
import { FightReaction, reactionOf } from '../ai/combat-reactions.ts';
import {
  abortsRun,
  aimUpdateTime,
  around,
  backoffGoal,
  bearing,
  chooseCloseMovement,
  circleAngle,
  circleDistantGoals,
  circleGoals,
  combatTurning,
  COMBAT_MOVEMENT_DEFAULTS,
  fallbackGoal,
  readCombatMovementSettings,
  strafeGoal,
  surroundGoal,
  TargetLocations,
  type CloseBehaviour,
  type CombatMovementSettings,
  type MovementRun,
  type MovementTarget,
} from '../ai/combat-movement.ts';
import { CombatSearch } from '../ai/combat-search.ts';
import { readDetectionSettings } from '../ai/detection.ts';
import {
  advanceRadii,
  ATTACK_DECISION_SECONDS,
  avoidsThreat,
  blockTime,
  bowHoldTime,
  castChance,
  chooseAttack,
  chooseEquipment,
  chooseSupport,
  chooseManeuver,
  choosesBlock,
  circleChance,
  circleDistantChance,
  fallbackChance,
  dodgeDirection,
  flankDistance,
  maneuverDirection,
  maneuverTime,
  maxOptimalRange,
  minEquipTime,
  offensiveMult,
  rangedAttackChance,
  threatens,
  type EquipKind,
  type EquipOption,
  type Maneuver,
  type Opponent,
  type Threat,
} from '../ai/combat-tactics.ts';
import { InterruptFlag, PackageFlag } from '../ai/package-records.ts';
import { CombatStyleFlag, type CombatStyle } from '../ai/combat-style-records.ts';
import { withinReach } from '../ai/flight.ts';
import type { Gait, MoveRequest, TurnParameters } from '../ai/locomotion.ts';
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
import { CastingSource } from '../scripting/runtime/casting-engine.ts';
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
import type { FlightFight, FlightTarget } from './actor-flight.ts';
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
  /** What flies at the actors now (arrows, spells, breath). */
  threats(): Iterable<Threat>;
}

/** One of the casts or potions an actor in combat uses for itself (combat-tactics chooseSupport). */
export type CombatSupport =
  | { readonly kind: 'heal' | 'summon' }
  | { readonly kind: 'potion'; readonly value: number }
  | { readonly kind: 'ward' | 'buff' };

/**
 * What magic and shouts in combat give the AI (5.3's casting): the offensive spells, staffs and
 * shouts an actor may fight with against a target, scored with its weapons; the cast itself (a
 * concentration spell held while `hold` holds); its support (healing, potions, summons, wards,
 * buffs). src/shell/combat-casting.ts.
 */
export interface CombatCasting {
  options(actor: number, target?: number): Promise<readonly EquipOption[]>;
  castAt(
    actor: number,
    hand: 'left' | 'right' | 'voice',
    target: number,
    option: EquipOption,
  ): Promise<boolean>;
  support(actor: number, purpose: CombatSupport, target?: number): Promise<boolean>;
}

/**
 * The fliers' fights (src/shell/actor-flight.ts: dragons): a flier that may fly fights from the
 * air by its combat style's flight section; those on the ground cannot strike one overhead.
 */
export interface CombatFlight {
  /** Whether an actor may fly in its fight now (CanFly: a flier allowed to, unhurt, where flying is). */
  mayFly(actor: number): boolean;
  /** Whether an actor is in the air now. */
  isFlying(actor: number): boolean;
  /** Whether an actor sits on a perch now. */
  perched(actor: number): boolean;
  /**
   * One frame of a flier's fight (the combat tree's Flight subtree: its style's flight section,
   * its offensive mult and farthest optimal range as the engine weighs them): true while the
   * flight has it (the ground fight waits).
   */
  fight(actor: number, target: FlightTarget, fight: FlightFight): boolean;
  /** Its fight ended (its packages take it on from there). */
  endFight(actor: number): void;
  /** The shape it had on the ground (its size for blows in the air). */
  shape(actor: number): { readonly radius: number; readonly height: number } | undefined;
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
  /**
   * Furniture holding an actor (src/shell/actor-furniture.ts): one in combat gets up out of
   * its chair, bed or workstation before it fights or flees (it has no controller meanwhile).
   */
  readonly furniture?: {
    holds(actor: number): boolean;
    leave(actor: number): Promise<void>;
  };
  /** A horse its rider moves: its own AI waits. */
  readonly ridden?: (actor: number) => boolean;
  /** Spells, staffs and shouts in combat (M10 5.3). */
  readonly casting?: () => CombatCasting | undefined;
  /** The fliers' fights (M10 5.4). */
  readonly flight?: () => CombatFlight | undefined;
}

type Mode = 'idle' | 'fight' | 'search' | 'flee' | 'yield';

/** What the AI reads of an actor now and then (PROFILE_SECONDS: src/ai/combat-profile.ts). */
type Profile = CombatProfile;

/** One actor's combat. */
interface Mind {
  readonly reference: number;
  mode: Mode;
  /**
   * Its package ignores combat (PKDT Ignore Combat): its fight waits while the package runs
   * (see ActorCombatAi.frame).
   */
  ignoring: boolean;
  target: number | undefined;
  /** Those it fights whatever its reaction (attacked by, helping against, StartCombat). */
  readonly enemies: Set<number>;
  /** Blows from friends and allies it let pass, by attacker. */
  readonly friendHits: Map<number, number>;
  /** Those it turned on for their blows (a quarrel the player may yield). */
  readonly quarrels: Set<number>;
  /**
   * Those it attacked by its aggro radius (it warned them off): its enemies for the fight, as
   * those it attacks on sight (it does not accept their yield).
   */
  readonly aggroed: Set<number>;
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
  /**
   * The movement behaviour under way (combat-movement.ts: an advance, a circle, a fallback, ...),
   * and when the selector runs next.
   */
  run: MovementRun | undefined;
  nextRun: number;
  /** Its travel over the navmeshes to a run's goal (a way round what the straight line meets). */
  runTravel: Vec3 | undefined;
  /** Where it stood when its run last made way, and when (it gives up a run it is stuck in). */
  runFrom: Vec3 | undefined;
  runFromAt: number;
  /** The point it faces (its aim controller's: its target's place), and when it is taken again. */
  aim: Vec3 | undefined;
  nextAim: number;
  nextAttack: number;
  /** When it last attacked, shot or cast (its clock; undefined: not yet in this fight). */
  lastAttack: number | undefined;
  /** When it was last hurt (a blow landed or blocked; undefined: not in this fight). */
  damagedAt: number | undefined;
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
  /** It held a weapon in this fight (one disarmed picks one up again). */
  armed: boolean;
  /** Its support (heals, potions, summons, wards, buffs): when next weighed, last restored. */
  nextSupport: number;
  healthRestoredAt: number;
  magickaRestoredAt: number;
  supporting: boolean;
  /** It gets up out of the furniture that holds it. */
  gettingUp: boolean;
  /** The combat state last told (TESCombatEvent), and the target told with it. */
  told: CombatStateValue;
  toldTarget: number | undefined;
}

/** GetCombatState: 0 not in combat, 1 in combat, 2 searching. */
type CombatStateValue = 0 | 1 | 2;

/** An actor weighs its fight this often (seconds). TODO(M13): the engine's rates. */
const DECIDE_SECONDS = 0.25;
/** Its profile (AI values, style, what it carries) is read again this often. */
const PROFILE_SECONDS = 3;
/** Reactions between two actors are valued again this often. */
const REACTION_SECONDS = 5;
/** Without detection, an actor knows those within this (units). */
const NEAR_SIGHT = 2048;
/** A far target is chased over the navmeshes beyond this past its reach (units). */
const CHASE_BEYOND = 512;
/** ... its way taken again once the target moved this far from it, or after this long when
 * no way was found (seconds). */
const CHASE_SLACK = 192;
const CHASE_RETRY = 1;
/** It strikes when its target is within this of its facing (radians). */
const STRIKE_ANGLE = Math.PI / 6;
/**
 * Its support (heals, potions, summons, wards, buffs) is weighed this often, and its attacks wait
 * this long after a support cast (seconds). TODO(M13): the engine's rates.
 */
const SUPPORT_SECONDS = 1;
const SUPPORT_CAST_SECONDS = 1.5;
/** A fighter left without a weapon picks one up lying this near, reached this near (units). */
const PICK_UP_REACH = 1024;
const PICK_UP_ARRIVE = 64;
/** A dodge lasts this long (seconds). */
const DODGE_SECONDS = 0.6;
/** A shout is tried this often (the combat tree's wait after Cast Shout; seconds). */
const SHOUT_DECISION_SECONDS = 1;
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
/**
 * A movement behaviour gives up after this long (seconds; TODO(M13): the engine's combat paths
 * end at their goal or by their abort rules, with no time of their own).
 */
const ADVANCE_SECONDS = 5;
/** A behaviour has reached its goal within the pathing radius and this (units). */
const RUN_ARRIVE_SLACK = 6;
/** A behaviour's abort rule is checked this often (seconds; the engine's behaviours' 0.1 s). */
const RUN_CHECK_SECONDS = 0.1;
/** A behaviour that made no more than this way (units) in this long (seconds) is stuck. */
const RUN_PROGRESS = 8;
const RUN_STUCK_SECONDS = 1;

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
  #movement: CombatMovementSettings = COMBAT_MOVEMENT_DEFAULTS;
  #turning: TurnParameters = combatTurning(COMBAT_MOVEMENT_DEFAULTS);
  /** [Combat] bCombatPathSprinting: an advance from afar sprints. */
  #sprints = true;
  /** The places round each target its attackers hold (combat-movement.ts). */
  readonly #locations = new TargetLocations();
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
    const mind = this.#minds.get(reference);
    return mind !== undefined && mind.mode !== 'idle' && !mind.ignoring;
  }

  /** GetCombatState: 0 not in combat, 1 in combat, 2 searching. */
  combatState(reference: number): CombatStateValue {
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

  /** An actor's combat style, once its profile is read. */
  styleOf(reference: number): CombatStyle | undefined {
    return this.#minds.get(reference)?.profile?.style;
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
    mind.damagedAt = this.#clock;
    // Its group knows where the blow came from (the target's stealth points drop).
    this.#groups.attacked(
      victim,
      attacker,
      this.#options.host.fighter(attacker)?.feet,
      this.#clock,
    );
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
    // A script may have it ignore friends' blows (IgnoreFriendlyHits): a friend or ally never
    // makes it turn.
    const friendly = reaction === FightReaction.friend || reaction === FightReaction.ally;
    if (friendly && runtime.state.references.get(mind.reference)?.ignoreFriendlyHits === true) {
      return;
    }
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
      // Gone from the fight: its combat ends (told as it ends).
      if (mind.told !== 0) this.#tellState(mind, 0);
      mind.search?.cancel();
      this.#groups.leave(reference);
      this.#minds.delete(reference);
    }
    this.#groups.forget(reference);
    this.#locations.release(reference);
    this.#health.delete(reference);
    this.#spectating.delete(reference);
    for (const other of this.#minds.values()) {
      other.enemies.delete(reference);
      other.aggroed.delete(reference);
      other.friendHits.delete(reference);
      other.warned.delete(reference);
      other.lastKnown.delete(reference);
    }
  }

  clear(): void {
    for (const mind of this.#minds.values()) mind.search?.cancel();
    this.#minds.clear();
    this.#groups.clear();
    this.#locations.clear();
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
    // The groups' knowledge of their targets: stealth points, searching, targets given up (its
    // members forget them: what they fight ends with them).
    for (const { member, target } of this.#groups.update(this.#groupWorld, this.#clock)) {
      for (const ally of [member, ...this.#groups.allies(member)]) {
        const mind = this.#minds.get(ally);
        if (!mind) continue;
        mind.enemies.delete(target);
        mind.quarrels.delete(target);
        mind.aggroed.delete(target);
        mind.lastKnown.delete(target);
        mind.next = 0;
      }
    }
    for (const view of views.values()) {
      if (view.player || runtime.state.actors.get(view.reference)?.dead === true) continue;
      if (this.#options.ridden?.(view.reference) === true) continue;
      const mind = this.#mind(view.reference);
      // The console's tcai stops all combat AI: as an ignoring package's, its fight waits.
      if (!runtime.debug.combatAi || this.#ignoresCombat(mind)) continue;
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
    // Each change of an actor's combat state is told (below).
    for (const mind of this.#minds.values()) {
      const state = this.combatState(mind.reference);
      if (state !== mind.told) this.#tellState(mind, state);
    }
  }

  /**
   * Whether an actor's package ignores combat now (PKDT Ignore Combat), so its fight waits.
   * Observed in the original: as an actor's package changes, its process is marked as
   * ignoring combat by that flag (a procedure's flag override can set it too: TODO(M13), the
   * running package's flags here do not take the overrides), and while it is
   * its combat controller's behaviour tree stands stopped (it neither fights, flees nor
   * searches; it is still in combat with its enemies); once its package no longer ignores
   * combat, the tree (Combat, LowCombat) starts again. So an actor attacked while it runs such
   * a package goes on with it: MQ101's Lokir runs from the archers on MQ101LokirtoMarker2Package
   * whether or not their first arrow fells him.
   */
  #ignoresCombat(mind: Mind): boolean {
    const running = this.#options.ai?.()?.current(mind.reference);
    const ignoring = running !== undefined && (running.flags & PackageFlag.ignoreCombat) !== 0;
    if (ignoring === mind.ignoring) return ignoring;
    mind.ignoring = ignoring;
    if (ignoring && mind.mode !== 'idle') {
      // Its moves stop: its package moves it now.
      const movers = this.#options.movers;
      movers.request(mind.reference, undefined);
      if (movers.travelOf(mind.reference)) movers.stop(mind.reference);
      this.#releaseBlock(mind, this.#options.host.fighter(mind.reference));
      this.#options.ai?.()?.evaluate(mind.reference);
    } else if (!ignoring && mind.mode !== 'idle') {
      // Its fight takes up again at once.
      mind.next = 0;
    }
    return ignoring;
  }

  /**
   * An actor's combat state changed: the hub tells it with its target (TESCombatEvent: the
   * actor's OnCombatStateChanged, the story manager, the HUD), as the engine does when an actor
   * enters or leaves combat and when its combat group turns to searching and back (observed in
   * the original). Leaving combat is told with the target it last fought.
   */
  #tellState(mind: Mind, state: CombatStateValue): void {
    const target = state === 0 ? mind.toldTarget : (mind.target ?? mind.toldTarget);
    mind.told = state;
    mind.toldTarget = target;
    this.#options.session.scriptsReady?.events.emit('combat', {
      actor: mind.reference,
      target,
      state,
    });
  }

  /** Detection asks combat: who is in combat, who fights whom, who is hostile to whom. */
  #hook(senses: ActorSenses | undefined): void {
    if (!senses || this.#hooked === senses) return;
    this.#hooked = senses;
    senses.inCombat = (actor) =>
      actor === PLAYER_REF ? this.#fightingPlayer() : this.combatState(actor) !== 0;
    senses.combatTarget = (actor) => this.#combatTarget(actor);
    // In combat, its own search for a lost target is the combat AI's.
    senses.hostile = (observer, target) =>
      !this.engaged(observer) && this.hostile(observer, target);
    // What a member detects of its group's targets is the group's (combat-groups.ts).
    senses.tested = (observer, target, report) => {
      this.#report(observer, target, report);
    };
  }

  /** An actor's combat target (the player's: whom they fight), undefined: none. */
  #combatTarget(actor: number): number | undefined {
    if (actor === PLAYER_REF) return this.#options.host.fighter(PLAYER_REF)?.target;
    const mind = this.#minds.get(actor);
    return mind && mind.mode !== 'idle' ? mind.target : undefined;
  }

  /** A member's detection of a target: its group's knowledge of it moves. */
  #report(member: number, target: number, report: DetectionReport): void {
    const mind = this.#minds.get(member);
    if (!mind || mind.mode === 'idle') return;
    this.#groups.report(member, target, report, this.#groupWorld, this.#clock);
  }

  /** What the combat groups ask of the fight (combat-groups.ts CombatGroupWorld). */
  readonly #groupWorld: CombatGroupWorld = {
    combatTarget: (member) => this.#combatTarget(member),
    fleeing: (member) => this.#minds.get(member)?.mode === 'flee',
    position: (actor) => this.#options.host.fighter(actor)?.feet,
    present: (actor) => {
      const view = this.#options.host.fighter(actor);
      const dead = this.#options.session.scriptsReady?.state.actors.get(actor)?.dead === true;
      return view !== undefined && !dead && view.state.life !== LifeState.dead;
    },
    detects: (member) => this.#options.movers.inHighProcess(member),
    sneaking: (target) => this.#options.senses?.()?.sneaking(target) === true,
    invisible: (target) =>
      this.#options.session.scriptsReady?.magic.aiState(target).invisible ?? false,
    sees: (member, at) => this.#options.senses?.()?.sees(member, at) ?? false,
  };

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
        ignoring: false,
        target: undefined,
        enemies: new Set(),
        friendHits: new Map(),
        quarrels: new Set(),
        aggroed: new Set(),
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
        run: undefined,
        nextRun: 0,
        runTravel: undefined,
        runFrom: undefined,
        runFromAt: 0,
        aim: undefined,
        nextAim: 0,
        nextAttack: 0,
        lastAttack: undefined,
        damagedAt: undefined,
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
        armed: false,
        nextSupport: 0,
        healthRestoredAt: -Infinity,
        magickaRestoredAt: -Infinity,
        supporting: false,
        gettingUp: false,
        told: 0,
        toldTarget: undefined,
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
      // Attacked by one it does not detect: into combat, its group knowing only where the blow
      // came from (it searches: combat-groups.ts).
      const remembered = candidates.find((candidate) => mind.enemies.has(candidate.reference));
      if (remembered) this.#enter(mind, remembered.reference, true);
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
    // Lost and found: its group searches once it lost all its targets, and fights again once
    // it finds one (observed in the original: combat-groups.ts).
    const searching = this.#groups.searching(mind.reference);
    if (mind.mode === 'fight' && searching && mind.target !== undefined) {
      this.#bark(mind.reference, 'CombatToLost', mind.target);
      this.#search(mind, mind.target);
      return;
    }
    if (mind.mode === 'search' && !searching) {
      const found = selectTarget(detected, mind.target, this.#settings) ?? mind.target ?? target;
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
    const playerEnemy =
      this.#onSight(mind, profile, magic, PLAYER_REF) || mind.aggroed.has(PLAYER_REF);
    if (mind.mode === 'fight') {
      // The player yields a quarrel of their blows: it accepts once they held off a while. So
      // do those that took up the fight against them (the guards of a crime, whose arrest
      // follows: src/shell/actor-crime.ts; those who helped them); one that attacks the player
      // on sight (its faction wants them dead) stays their enemy.
      if (
        acceptsYield({
          fightsPlayer,
          playerEnemy,
          heldOff: this.#playerHeldOff(),
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
   * Those an actor would fight that it knows of now: out of combat, those it detects and its
   * enemies where it last knew them; in combat, its group's targets (detected while the group
   * has not lost them, where the group last knew them) and new ones it detects (they become its
   * group's); with their distance, threat and whether they attack it.
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
      const own = senses
        ? senses.detections.state(mind.reference, reference)
        : flat(feet, other.feet) < NEAR_SIGHT
          ? 'detected'
          : 'unseen';
      const sees = own === 'detected';
      const tracked =
        mind.mode === 'idle' ? undefined : this.#groups.target(mind.reference, reference);
      const lastKnown = sees
        ? other.feet
        : (this.#knownPlace(tracked) ??
          senses?.detections.lastKnown(mind.reference, reference) ??
          mind.lastKnown.get(reference));
      const detected = tracked ? !tracked.lost : sees;
      const remembered =
        tracked !== undefined || (lastKnown !== undefined && mind.enemies.has(reference));
      if (!sees && !remembered) continue;
      if (!this.#hostileTo(mind, view, profile, magic, other, views, sees || detected)) continue;
      if (mind.mode !== 'idle' && !tracked) this.#track(mind, reference);
      // A copy: the position seen is the actor's own, and it moves on.
      if (lastKnown) mind.lastKnown.set(reference, [lastKnown[0], lastKnown[1], lastKnown[2]]);
      const health = this.#health.get(reference)?.points ?? 100;
      const where = sees || tracked?.known === true ? other.feet : (lastKnown ?? other.feet);
      candidates.push({
        reference,
        distance: flat(feet, where),
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
    // The aggro radius of one that would not attack on sight: it warns those not its friends or
    // allies that come close, then attacks them (inferred: vanilla's wolves and bears are
    // unaggressive with an aggro radius, and attack the player who comes near; TODO(M13)). Once
    // it attacks, the other is its enemy for the fight.
    if (
      profile.aggroRadius &&
      detected &&
      mind.mode === 'idle' &&
      !(running && (running.interrupts & InterruptFlag.aggroRadiusBehavior) === 0) &&
      this.#aggro(mind, view, other, profile.aggroRadius)
    ) {
      mind.aggroed.add(reference);
      return this.#join(mind, reference);
    }
    // No one takes up a fight against a player who yields (else those who took it up keep each
    // other in it: each helps the other against the player, and the yield never ends it).
    if (reference === PLAYER_REF && this.#playerHeldOff() >= this.#settings.acceptYieldTime) {
      return false;
    }
    // Helping: one it helps fights `other`, or `other` fights one it helps.
    const assistance = profile.teammate
      ? Math.max(profile.assistance, Assistance.helpsFriendsAndAllies)
      : profile.assistance;
    for (const fighter of views.values()) {
      if (fighter.reference === mind.reference) continue;
      const target = this.#fightTarget(fighter, views);
      if (target === undefined) continue;
      if (fighter.reference === reference && target !== mind.reference) {
        // `other` attacks `target`: help the victim; guards help any innocent (the crime
        // itself, its bounty and the guards' arrest: src/shell/actor-crime.ts).
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
    // Its combat group: of an ally already fighting beside it; its target becomes the group's.
    const allies: number[] = [];
    for (const other of this.#minds.values()) {
      if (other === mind || other.mode === 'idle') continue;
      const reaction = this.#reaction(reference, other.reference);
      if (reaction === FightReaction.ally || reaction === FightReaction.friend) {
        allies.push(other.reference);
      }
    }
    this.#groups.join(reference, allies);
    this.#setTarget(mind, target);
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
    if (mind.target !== target) {
      this.#stopRun(mind);
      this.#locations.release(mind.reference);
      mind.aim = undefined;
    }
    mind.target = target;
    mind.maneuverUntil = 0;
    this.#options.host.setTarget(mind.reference, target);
    if (mind.mode !== 'idle') this.#track(mind, target);
  }

  /**
   * A target of its group (combat-groups.ts): new ones begin with nearly all their stealth
   * points; what it detects of it now is told at once (later tests tell the rest).
   */
  #track(mind: Mind, target: number): void {
    const known = this.#groups.addTarget(mind.reference, target);
    if (!known || known.levels.has(mind.reference)) return;
    const senses = this.#options.senses?.();
    const level = senses?.detections.level(mind.reference, target);
    const at = this.#options.host.fighter(target)?.feet;
    if (!senses || level === undefined || !at) return;
    const report: DetectionReport = {
      level,
      lineOfSight: senses.detections.detects(mind.reference, target),
      at,
    };
    this.#groups.report(mind.reference, target, report, this.#groupWorld, this.#clock);
  }

  /** Where a group last knew a target to be: seen, else where it attacked from or was heard. */
  #knownPlace(known: GroupTarget | undefined): Vec3 | undefined {
    if (!known) return undefined;
    const places: [Vec3 | undefined, number][] = [
      [known.lastKnown, known.lastKnownTime],
      [known.attackedAt, known.attackedTime],
      [known.eventAt, known.eventTime],
    ];
    let best: Vec3 | undefined;
    let when = -Infinity;
    for (const [at, time] of places) {
      if (at && time > when) {
        best = at;
        when = time;
      }
    }
    return best;
  }

  /**
   * Its search for its group's lost targets begins (CombatSearch: to where the group last knew
   * its target to be).
   */
  #search(mind: Mind, target: number): void {
    const at =
      this.#knownPlace(this.#groups.target(mind.reference, target)) ??
      mind.lastKnown.get(target) ??
      this.#options.host.fighter(target)?.feet;
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

  /** How long the player has held off: weapon away and no blow struck (their yield). */
  #playerHeldOff(): number {
    return this.#clock - Math.max(this.#playerBlow, this.#playerArmed);
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
    mind.run = undefined;
    mind.runTravel = undefined;
    mind.aim = undefined;
    this.#locations.release(reference);
    mind.search?.cancel();
    mind.search = undefined;
    mind.chase = undefined;
    mind.leash = undefined;
    mind.fleeWay = undefined;
    mind.scaredFrom = undefined;
    mind.enemies.clear();
    mind.friendHits.clear();
    mind.quarrels.clear();
    mind.aggroed.clear();
    mind.lastKnown.clear();
    // What a script's StartCombat made it hostile to ends with its combat (crime-engine.ts).
    const actorState = this.#options.session.scriptsReady?.state.actors.get(reference);
    if (actorState) delete actorState.combatTargets;
    mind.sheatheAt = this.#clock + SHEATHE_DELAY;
    if (mind.packageStyle !== undefined) {
      mind.packageStyle = undefined;
      mind.profileRead = -Infinity;
    }
    const host = this.#options.host;
    host.setTarget(reference, undefined);
    this.#releaseBlock(mind, host.fighter(reference));
    this.#options.flight?.()?.endFight(reference);
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
    // Its AI disabled (EnableAI false) or not running: it does nothing of itself, nor draws,
    // equips or sheathes.
    if (!this.#options.movers.runsAi(mind.reference)) return;
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
    // In a chair, a bed or at a workstation it gets up first (its exit idle), then fights,
    // flees or searches: the furniture holds it meanwhile (no controller to move it).
    const furniture = this.#options.furniture;
    if (furniture?.holds(mind.reference) === true) {
      if (!mind.gettingUp) {
        mind.gettingUp = true;
        void furniture
          .leave(mind.reference)
          .catch((error: unknown) => {
            this.#warn(`${mind.reference.toString(16)} getting up: ${describe(error)}`);
          })
          .finally(() => {
            mind.gettingUp = false;
          });
      }
      return;
    }
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
    // Where its group knows the target to be: where it is while the group follows it (detected
    // lately, near where), else where the group last knew it (combat-groups.ts).
    const known = this.#groups.target(reference, target.reference);
    const there =
      known === undefined || known.known
        ? (target.feet ?? mind.lastKnown.get(target.reference))
        : (this.#knownPlace(known) ?? target.feet);
    if (!there) return;
    const flight = this.#options.flight?.();
    // A flier's fight is the combat tree's Flight subtree while it can fly or is not on the
    // ground (observed in the original: the Flight Link); landed for a ground attack, or
    // unable to fly on the ground, it fights here.
    if (
      flight !== undefined &&
      (flight.mayFly(reference) || flight.isFlying(reference) || flight.perched(reference))
    ) {
      const opponent = this.#opponent(mind, target.reference);
      const flown = flight.fight(
        reference,
        {
          reference: target.reference,
          feet: there,
          height: target.height,
          radius: target.radius,
          heading: target.heading,
        },
        {
          flight: profile.style.flight,
          offensive: offensiveMult(profile.style, opponent, this.#settings),
          styleOptimal: maxOptimalRange(profile.style, opponent, this.#settings),
          attackedAgo: mind.damagedAt === undefined ? undefined : this.#clock - mind.damagedAt,
        },
      );
      if (flown) return;
    }
    // A target in the air is as far as it is (its height counts: bows and spells reach it).
    const aloft = flight?.isFlying(target.reference) === true;
    const distance = aloft
      ? Math.hypot(feet[0] - there[0], feet[1] - there[1], feet[2] - there[2])
      : flat(feet, there);
    const facing = headingTo(feet, there);
    // What it fights with (its style's scores), now and then.
    if (this.#clock >= mind.nextEquip && !mind.equipping) {
      mind.nextEquip = this.#clock + this.#equipWait(mind.equipped?.kind);
      void this.#chooseEquipment(mind, view, distance).catch((error: unknown) => {
        mind.equipping = false;
        this.#warn(`${reference.toString(16)} equipment: ${describe(error)}`);
      });
    }
    if (mind.equipping) return;
    // One that would flee at once (a coward, uncornered) does not take up its weapon to fight:
    // its next decision has it flee or yield.
    if (state.weapon === WeaponState.sheathed && this.#wouldFlee(mind, profile)) return;
    if (state.weapon === WeaponState.sheathed) {
      void host.draw(reference);
      return;
    }
    if (state.weapon !== WeaponState.drawn) return;
    // Where it faces: its aim point (its aim controller's), not its target's place this frame.
    const ranged =
      view.gear?.bow === true || mind.equipped?.kind === 'magic' || mind.equipped?.kind === 'staff';
    const face = this.#aimFace(
      mind,
      view,
      target,
      there,
      ranged,
      distance <= view.reach + target.radius,
    );
    if (this.#dodge(mind, view, face)) return;
    // Its combat override package's place: back to it, and fight from there.
    const leash = mind.leash;
    const tethered = leash !== undefined && flat(feet, leash.center) > leash.radius;
    if (tethered && !mind.chase) {
      mind.chase = leash.center;
      void movers.travel(reference, leash.center, 'run', leash.radius / 2).then(() => {
        if (mind.chase === leash.center) mind.chase = undefined;
      });
    }
    // What it does for itself now and then (heals, potions, summons, wards, buffs).
    if (this.#clock >= mind.nextSupport && !mind.supporting) {
      mind.nextSupport = this.#clock + SUPPORT_SECONDS;
      mind.supporting = true;
      void this.#support(mind, view, target.reference)
        .catch((error: unknown) => {
          this.#warn(`${reference.toString(16)} support: ${describe(error)}`);
        })
        .finally(() => {
          mind.supporting = false;
        });
    }
    const option = mind.equipped;
    const casts =
      option && (option.kind === 'magic' || option.kind === 'staff' || option.kind === 'shout');
    if (casts) {
      this.#cast(mind, view, target.reference, option, distance, facing, face);
      return;
    }
    if (view.gear?.bow === true) {
      this.#shoot(mind, view, target, profile, distance, facing, there, tethered);
      return;
    }
    this.#defend(mind, view, target, distance);
    this.#melee(mind, view, target, profile, distance, facing, there, tethered);
    if (this.#clock >= mind.nextLine) {
      mind.nextLine = this.#clock + this.#between(this.#settings.tauntMin, this.#settings.tauntMax);
      this.#bark(reference, 'Taunt', target.reference);
    }
  }

  /** Close combat: its close movement about its reach (combat-movement.ts), and its attacks. */
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
    const face = this.#aimFace(mind, view, target, there, false, distance <= reach);
    // Its combat override package's place: it does not leave it for a target beyond.
    const leash = mind.leash;
    if (leash && flat(there, leash.center) > leash.radius + reach) {
      this.#stopRun(mind);
      movers.request(reference, this.#standing(face));
      return;
    }
    // Far: over the navmeshes, running, its way taken again as the target moves.
    if (distance > reach + CHASE_BEYOND) {
      this.#stopRun(mind);
      this.#chase(mind, there, reach * 0.8, distance);
      return;
    }
    if (mind.chase) {
      mind.chase = undefined;
      movers.stop(reference);
    }
    const style = profile.style;
    const opponent = this.#opponent(mind, target.reference);
    // Its advance radii (its style's defensive against offensive mult; a defensive one keeps its
    // distance a while after it was hurt).
    const radii = advanceRadii(
      style,
      {
        ...opponent,
        targetStaggered: target.state.staggered,
        reach: view.reach,
        targetReach: target.reach,
        sinceDamaged: mind.damagedAt === undefined ? undefined : this.#clock - mind.damagedAt,
      },
      this.#settings,
    );
    // Where it fights from: its reach and its inner advance radius.
    const range = reach + radii.inner;
    const state = view.state;
    const feet = view.feet ?? there;
    const moving = this.#movementTarget(target, there);
    this.#updateRun(mind, view, moving, range, distance);
    if (!mind.run && this.#clock >= mind.nextRun && !attacking(state)) {
      mind.nextRun = this.#clock + DECIDE_SECONDS;
      mind.run = this.#chooseRun(
        mind,
        view,
        target,
        moving,
        style,
        opponent,
        radii,
        range,
        distance,
      );
    }
    // An attack plays where it stands: its controller does not move it meanwhile.
    // (its clip's own root motion carries it: a forward power attack's lunge).
    if (attacking(state)) movers.request(reference, { ...this.#standing(face), rootMotion: true });
    else this.#driveRun(mind, feet, face, distance);
    // Its attack: within reach and facing it, in its own time; not at one above its reach (a
    // flier overhead: it waits for it to come down).
    if (distance > reach || Math.abs(turnBetween(view.heading, facing)) > STRIKE_ANGLE) return;
    if (
      !withinReach(
        { feet, height: view.height, reach: view.reach },
        { feet: there, height: target.height },
      )
    ) {
      return;
    }
    if (this.#clock < mind.nextAttack) return;
    // The engine's rule (observed in the original): a new attack waits while it is still in its last one,
    // but no longer than fCombatAttackAnimationDrivenDelayTime after it chose that one; in the
    // last one's chain window the next one follows. Refused by its graph, it asks again at its
    // next decision (the combat tree's attack idle: ATTACK_DECISION_SECONDS).
    const chaining =
      state.attack === AttackState.nextAttack || state.attack === AttackState.followThrough;
    const sinceLast = mind.lastAttack === undefined ? Infinity : this.#clock - mind.lastAttack;
    if (
      attacking(state) &&
      !chaining &&
      !state.blocking &&
      sinceLast <= this.#settings.attackAnimationDrivenDelayTime
    ) {
      return;
    }
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
        ...opponent,
        sinceLastAttack: mind.lastAttack === undefined ? undefined : this.#clock - mind.lastAttack,
      },
      this.#random,
      this.#settings,
    );
    mind.nextAttack = this.#clock + ATTACK_DECISION_SECONDS;
    if (choice === 'none') return;
    // Its last attack is the one its graph took (the engine notes the time as the action
    // succeeds).
    const asked = this.#clock;
    const action =
      choice === 'power' || choice === 'powerBash' ? 'ActionRightPowerAttack' : 'ActionRightAttack';
    void this.#options.host.attack(reference, action).then((began) => {
      if (began) mind.lastAttack = asked;
    });
  }

  /**
   * After a far target over the navmeshes, running (sprinting while it is farther than
   * fCombatApproachTargetSprintStopRange, [Combat] bCombatPathSprinting); the way taken again as
   * it moves on, and a moment after a way that could not be found.
   */
  #chase(mind: Mind, there: Vec3, arrive: number, distance: number): void {
    if (this.#clock < mind.chaseRetry) return;
    if (mind.chase && flat(mind.chase, there) <= CHASE_SLACK) return;
    const to: Vec3 = [there[0], there[1], there[2]];
    mind.chase = to;
    const gait: Gait =
      this.#sprints && distance > this.#movement.approachSprintStopRange ? 'sprint' : 'run';
    void this.#options.movers.travel(mind.reference, to, gait, arrive).then((arrived) => {
      if (mind.chase !== to) return;
      mind.chase = undefined;
      if (!arrived) mind.chaseRetry = this.#clock + CHASE_RETRY;
    });
  }

  // --- How it moves and faces near its target (combat-movement.ts) -------------------------------

  /**
   * The heading it faces: towards its aim point, its target's place as its aim controller took
   * it last (again every fCombatAimMeleeUpdateTime; fCombatAimProjectileUpdateTime for a shooter;
   * observed in the original), not where the target is this frame.
   */
  #aimFace(
    mind: Mind,
    view: FighterView,
    target: FighterView,
    there: Vec3,
    ranged: boolean,
    withinReach: boolean,
  ): number {
    if (!mind.aim || this.#clock >= mind.nextAim) {
      mind.aim = [there[0], there[1], there[2]];
      mind.nextAim =
        this.#clock + aimUpdateTime(ranged, target.player, withinReach, this.#movement);
    }
    const feet = view.feet ?? there;
    return headingTo(feet, mind.aim);
  }

  /** Standing where it is, facing `face`, turning as the combat movement does. */
  #standing(face: number | undefined): MoveRequest {
    return { gait: 'walk', face, turning: this.#turning };
  }

  /** Its target as the movement behaviours read it. */
  #movementTarget(target: FighterView, there: Vec3): MovementTarget {
    const velocity = this.#options.movers.motion(target.reference)?.velocity;
    const ahead = this.#movement.anticipateTime;
    return {
      feet: there,
      heading: target.heading,
      anticipated: velocity
        ? [there[0] + velocity[0] * ahead, there[1] + velocity[1] * ahead, there[2]]
        : there,
      isPlayer: target.player,
    };
  }

  /** Its movement behaviour ends (and its travel to it, if it went round something). */
  #stopRun(mind: Mind): void {
    mind.run = undefined;
    mind.runFrom = undefined;
    if (mind.runTravel) {
      mind.runTravel = undefined;
      this.#options.movers.stop(mind.reference);
    }
  }

  /** A behaviour run to a goal at a pace (normalized combat speed), for at most `seconds`. */
  #newRun(
    behaviour: MovementRun['behaviour'],
    goal: Vec3 | undefined,
    pace: number,
    seconds: number,
    options: { readonly sprint?: boolean; readonly wait?: number } = {},
  ): MovementRun {
    return {
      behaviour,
      goal,
      pace,
      sprint: options.sprint === true,
      until: this.#clock + seconds,
      wait: 0,
      waitTime: options.wait ?? 0,
      check: this.#clock,
    };
  }

  /**
   * How far straight from `from` to `to` the navmesh allows (a goal cut short there), or
   * undefined when it cannot get `least` units along it.
   */
  #straightGoal(mind: Mind, from: Vec3, to: Vec3, least: number): Vec3 | undefined {
    const whole = flat(from, to);
    const got = this.#options.movers.straightReach(mind.reference, to, from);
    if (got >= whole - 1) return to;
    if (got < least) return undefined;
    const t = got / Math.max(1, whole);
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, to[2]];
  }

  /**
   * The close movement selector (combat-movement.ts chooseCloseMovement; a flanking style's
   * stalk and flank, chooseManeuver): the first behaviour of its tries whose goal can be found.
   */
  #chooseRun(
    mind: Mind,
    view: FighterView,
    target: FighterView,
    moving: MovementTarget,
    style: CombatProfile['style'],
    opponent: Opponent,
    radii: { readonly inner: number; readonly outer: number },
    range: number,
    distance: number,
  ): MovementRun | undefined {
    mind.side = this.#random() < 0.5 ? -1 : 1;
    const feet = view.feet ?? moving.feet;
    if ((style.flags & CombatStyleFlag.flanking) !== 0) {
      mind.maneuver = chooseManeuver(
        style,
        {
          distance,
          reach: view.reach + target.radius,
          ranged: false,
          allies: opponent.allies,
          previous: mind.maneuver,
          radii,
        },
        this.#random,
        this.#settings,
      );
      const seconds = maneuverTime(style, mind.maneuver, this.#random, this.#settings);
      if (mind.maneuver === 'flank') {
        return this.#newRun('flank', feet, this.#movement.speedRun, seconds);
      }
      if (mind.maneuver === 'stalk') {
        // Round it just out of its reach for its stalk time: a circle at its distance.
        const run = this.#startRun('circle', mind, view, target, moving, style, range, distance);
        if (run) return { ...run, behaviour: 'stalk', until: this.#clock + seconds };
      }
    }
    const tries = chooseCloseMovement(
      {
        distance,
        range,
        outer: radii.outer,
        outOfPosition: this.#locations.outOfPosition(
          mind.reference,
          target.reference,
          feet,
          moving.feet,
          this.#movement,
        ),
        fallbackChance: fallbackChance(style, this.#settings),
        circleChance: circleChance(style, this.#settings),
        circleDistantChance: circleDistantChance(style, this.#settings),
      },
      this.#random,
      this.#movement,
    );
    for (const behaviour of tries) {
      const run = this.#startRun(behaviour, mind, view, target, moving, style, range, distance);
      if (run) return run;
    }
    return undefined;
  }

  /** A behaviour started: its goal, or undefined when it has none now (the next is tried). */
  #startRun(
    behaviour: CloseBehaviour,
    mind: Mind,
    view: FighterView,
    target: FighterView,
    moving: MovementTarget,
    style: CombatProfile['style'],
    range: number,
    distance: number,
  ): MovementRun | undefined {
    const settings = this.#movement;
    const reference = mind.reference;
    const movers = this.#options.movers;
    const feet = view.feet;
    if (!feet) return undefined;
    const self = { feet, heading: view.heading, radius: view.radius };
    const least = Math.max(view.radius, settings.circleMinMovementDistance);
    switch (behaviour) {
      case 'advance':
      case 'reposition': {
        // A place round its target (its target locations), at its range less the pathing radius.
        const place = this.#locations.choose(
          reference,
          feet,
          target.reference,
          moving.feet,
          Math.max(view.radius + target.radius, range - settings.targetLocationPathingRadius),
          view.radius,
          (from, to) => movers.straightReach(reference, to, from),
          settings,
        );
        if (!place) return undefined;
        this.#locations.reserve(reference, place.reservation);
        const run = this.#newRun(behaviour, place.point, settings.speedRun, ADVANCE_SECONDS, {
          sprint: this.#sprints,
        });
        // A straight line there the navmesh does not allow: over the navmeshes round it.
        if (movers.straightReach(reference, place.point) < flat(feet, place.point) - 1) {
          const to = place.point;
          mind.runTravel = to;
          void movers
            .travel(reference, to, 'run', settings.targetLocationPathingRadius)
            .then(() => {
              if (mind.runTravel === to) mind.runTravel = undefined;
            });
        }
        return run;
      }
      case 'surround': {
        const wanted = surroundGoal(self, moving, range, settings);
        const goal = wanted && this.#straightGoal(mind, feet, wanted, least);
        return goal && this.#newRun('surround', goal, settings.speedRun, ADVANCE_SECONDS);
      }
      case 'circle': {
        const angle = circleAngle(
          style.closeRange.circleMult,
          moving.isPlayer,
          view.radius,
          distance,
          this.#random,
          settings,
        );
        for (const wanted of circleGoals(self, moving, range, angle, mind.side, settings)) {
          const goal = this.#straightGoal(mind, feet, wanted, least);
          if (!goal) continue;
          // The place it goes to round its target is its reservation (others keep off it).
          const at = bearing(moving.feet, goal);
          const width = this.#locations.of(reference)?.width ?? 0;
          if (!this.#locations.free(reference, target.reference, at, width)) continue;
          this.#locations.reserve(reference, { target: target.reference, angle: at, width });
          return this.#newRun('circle', goal, settings.speedFastWalk, ADVANCE_SECONDS);
        }
        return undefined;
      }
      case 'circleDistant': {
        const angle = circleAngle(
          style.closeRange.circleMult,
          moving.isPlayer,
          view.radius,
          distance,
          this.#random,
          settings,
        );
        for (const wanted of circleDistantGoals(self, moving, angle, mind.side, settings)) {
          const goal = this.#straightGoal(mind, feet, wanted, least);
          if (goal)
            return this.#newRun('circleDistant', goal, settings.speedFastWalk, ADVANCE_SECONDS);
        }
        return undefined;
      }
      case 'fallback': {
        const wanted = fallbackGoal(self, moving, this.#random, settings);
        const goal =
          wanted &&
          this.#straightGoal(
            mind,
            feet,
            wanted,
            Math.max(view.radius, settings.fallbackMinMovementDistance),
          );
        if (!goal) return undefined;
        const wait =
          settings.fallbackWaitTimeMin +
          this.#random() * (settings.fallbackWaitTimeMax - settings.fallbackWaitTimeMin);
        return this.#newRun('fallback', goal, settings.speedFastWalk, ADVANCE_SECONDS, { wait });
      }
      case 'backoff': {
        const wanted = backoffGoal(self, moving, range, settings);
        const goal =
          wanted && this.#straightGoal(mind, feet, wanted, settings.fallbackMinMovementDistance);
        return goal && this.#newRun('backoff', goal, settings.speedFastWalk, ADVANCE_SECONDS);
      }
      case 'idle':
        return this.#newRun('idle', undefined, settings.speedWalk, DECIDE_SECONDS);
    }
  }

  /**
   * The behaviour under way, checked: it ends at its goal (a fallback waits there first), at its
   * time, by its abort rule (every 0.1 s), stuck (no way made for a while), or (an advance) once
   * its target is within its range; an advance's place follows its target.
   */
  #updateRun(
    mind: Mind,
    view: FighterView,
    target: MovementTarget,
    range: number,
    distance: number,
  ): void {
    const run = mind.run;
    const feet = view.feet;
    if (!run || !feet) return;
    const end = (): void => {
      this.#stopRun(mind);
    };
    if (this.#clock >= run.until) {
      end();
      return;
    }
    if (run.wait > 0) {
      if (this.#clock >= run.wait) end();
      return;
    }
    const advancing = run.behaviour === 'advance' || run.behaviour === 'reposition';
    // Its approach stops within its range (the approach speed controller's inner radius), its
    // place's pathing radius inside it (it is out of range again only beyond its range).
    if (advancing && distance <= range - this.#movement.targetLocationPathingRadius) {
      end();
      return;
    }
    if (run.behaviour === 'flank') {
      // A quarter round its target, its flank distance beyond its reach (it follows the target).
      const style = mind.profile?.style ?? NO_STYLE;
      const direction = maneuverDirection(
        'flank',
        feet,
        target.feet,
        mind.side,
        range + flankDistance(style, this.#settings),
      );
      run.goal = [feet[0] + direction[0] * 64, feet[1] + direction[1] * 64, feet[2]];
      if (distance <= range) end();
      return;
    }
    // At its goal: an advance within the pathing radius of its place (so within its range).
    const goal = run.goal;
    const arrive = this.#movement.targetLocationPathingRadius + (advancing ? 0 : RUN_ARRIVE_SLACK);
    if (goal && flat(feet, goal) <= arrive) {
      if (run.waitTime > 0) {
        run.goal = undefined;
        run.wait = this.#clock + run.waitTime;
      } else {
        end();
      }
      return;
    }
    if (this.#clock >= run.check) {
      run.check = this.#clock + RUN_CHECK_SECONDS;
      if (
        abortsRun(
          run,
          { feet, heading: view.heading, radius: view.radius },
          target,
          range,
          this.#movement,
        )
      ) {
        end();
        return;
      }
      // Stuck: no way made towards its goal for a while (something the navmesh did not show).
      if (goal) {
        if (!mind.runFrom || flat(mind.runFrom, feet) > RUN_PROGRESS) {
          mind.runFrom = [...feet];
          mind.runFromAt = this.#clock;
        } else if (this.#clock - mind.runFromAt > RUN_STUCK_SECONDS) {
          end();
          return;
        }
      }
      // An advance's place moves with its target.
      const own = advancing && !mind.runTravel ? this.#locations.of(mind.reference) : undefined;
      if (own) {
        const away = Math.max(view.radius, range - this.#movement.targetLocationPathingRadius);
        run.goal = this.#straightGoal(mind, feet, around(target.feet, own.angle, away), 0) ?? goal;
      }
    }
  }

  /** It goes the way of its behaviour, or stands, facing `face`. */
  #driveRun(mind: Mind, feet: Vec3, face: number, distance: number): void {
    const movers = this.#options.movers;
    const run = mind.run;
    if (mind.runTravel) return;
    const goal = run?.goal;
    if (!run || !goal) {
      movers.request(mind.reference, this.#standing(face));
      return;
    }
    const dx = goal[0] - feet[0];
    const dy = goal[1] - feet[1];
    const left = Math.hypot(dx, dy);
    if (left < 1e-3) {
      movers.request(mind.reference, this.#standing(face));
      return;
    }
    const settings = this.#movement;
    // An advance runs (sprints from afar), walking the last of its way; the others at their pace.
    const advancing = run.behaviour === 'advance' || run.behaviour === 'reposition';
    const pace =
      advancing && left <= settings.approachSlowdownDistance ? settings.speedWalk : run.pace;
    const gait: Gait =
      run.sprint && left > settings.approachSprintStopRange ? 'sprint' : pace >= 2 ? 'run' : 'walk';
    // Far from its target an advance faces the way it goes (its aim tracks within
    // fCombatCloseRangeTrackTargetDistance).
    const facing =
      advancing && distance > settings.closeRangeTrackTargetDistance ? undefined : face;
    movers.request(mind.reference, {
      direction: [dx / left, dy / left],
      gait,
      ...(gait === 'walk' && { pace }),
      face: facing,
      turning: this.#turning,
    });
  }

  /**
   * A shooter's movement (combat-tactics chooseManeuver at range): to its optimal range, back
   * (a fallback's way and wait), aside by fCombatStrafeDistanceMin .. Max, or standing; each a
   * straight way the navmesh allows, else it stands. TODO(M13): the ranged movement tree (Use
   * Cover, Find Attack Location, Maintain Optimal Range, Strafe) is not read; the speeds are the
   * close movement's.
   */
  #rangedRun(
    mind: Mind,
    view: FighterView,
    target: MovementTarget,
    maneuver: Maneuver,
    optimal: number,
    seconds: number,
  ): MovementRun {
    const settings = this.#movement;
    const feet = view.feet ?? target.feet;
    const self = { feet, heading: view.heading, radius: view.radius };
    const least = Math.max(view.radius, settings.fallbackMinMovementDistance);
    let goal: Vec3 | undefined;
    switch (maneuver) {
      case 'advance':
        goal = this.#straightGoal(
          mind,
          feet,
          around(target.feet, bearing(target.feet, feet), optimal),
          least,
        );
        if (goal) return this.#newRun('advance', goal, settings.speedWalk, seconds);
        break;
      case 'fallback': {
        const wanted = fallbackGoal(self, target, this.#random, settings);
        goal = wanted && this.#straightGoal(mind, feet, wanted, least);
        if (goal) {
          const wait =
            settings.fallbackWaitTimeMin +
            this.#random() * (settings.fallbackWaitTimeMax - settings.fallbackWaitTimeMin);
          return this.#newRun('fallback', goal, settings.speedFastWalk, seconds, { wait });
        }
        break;
      }
      case 'strafe':
        goal = this.#straightGoal(
          mind,
          feet,
          strafeGoal(self, target, mind.side, this.#random, settings),
          least,
        );
        if (goal) return this.#newRun('strafe', goal, settings.speedFastWalk, seconds);
        break;
      default:
        break;
    }
    return this.#newRun('hold', undefined, settings.speedWalk, seconds);
  }

  /**
   * At range with a bow: the style's distance and strafing; draw (by its ranged attack chance,
   * a decision every ATTACK_DECISION_SECONDS), hold (its hold time), loose.
   */
  #shoot(
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
    const host = this.#options.host;
    const reference = mind.reference;
    const style = profile.style;
    const opponent = this.#opponent(mind, target.reference);
    const range = view.gear?.range ?? this.#settings.maximumProjectileRange;
    const face = this.#aimFace(mind, view, target, there, true, false);
    if (!tethered) {
      if (distance > range) {
        this.#stopRun(mind);
        this.#chase(mind, there, range * 0.8, distance);
        return;
      }
      if (mind.chase) {
        mind.chase = undefined;
        movers.stop(reference);
      }
      const optimal = Math.min(range, maxOptimalRange(style, opponent, this.#settings));
      const moving = this.#movementTarget(target, there);
      this.#updateRun(mind, view, moving, optimal, distance);
      if (!mind.run && this.#clock >= mind.nextRun) {
        mind.nextRun = this.#clock + DECIDE_SECONDS;
        mind.maneuver = chooseManeuver(
          style,
          {
            distance,
            reach: range,
            ranged: true,
            allies: opponent.allies,
            previous: mind.maneuver,
            optimalRange: optimal,
          },
          this.#random,
          this.#settings,
        );
        mind.side = this.#random() < 0.5 ? -1 : 1;
        const seconds = maneuverTime(style, mind.maneuver, this.#random, this.#settings);
        mind.run = this.#rangedRun(mind, view, moving, mind.maneuver, optimal, seconds);
      }
      this.#driveRun(mind, view.feet ?? there, face, 0);
    }
    const state = view.state;
    // Observed in the original: held its hold time, the bow is loosed once its target lies
    // within fCombatRangedProjectileFiringArc of its aim (else it looks again a quarter second
    // later; TODO(M13): the line of fire it also asks for); held past
    // fCombatRangedAttackMaximumHoldTime it is let down unloosed (ActionRightInterrupt:
    // CancelBowAttack). Its facing gates only a new draw: a drawn bow waiting on its archer's
    // turn was never loosed (Helgen's archers held theirs drawn).
    const off = Math.abs(turnBetween(view.heading, facing));
    if (state.attack === AttackState.bowDrawn && state.drawnFor >= mind.bowHold) {
      if (state.drawnFor > this.#settings.rangedAttackMaximumHoldTime) {
        void host.release(reference, 'ActionRightInterrupt');
        mind.nextAttack = this.#clock + ATTACK_DECISION_SECONDS;
      } else if (off <= (this.#settings.rangedProjectileFiringArc * Math.PI) / 180) {
        void host.release(reference, 'ActionRightRelease');
        mind.nextAttack = this.#clock + ATTACK_DECISION_SECONDS;
      }
      return;
    }
    if (off > STRIKE_ANGLE) return;
    if (!attacking(state) && this.#clock >= mind.nextAttack) {
      mind.nextAttack = this.#clock + ATTACK_DECISION_SECONDS;
      const sinceLastAttack =
        mind.lastAttack === undefined ? undefined : this.#clock - mind.lastAttack;
      const chance = rangedAttackChance(style, { ...opponent, sinceLastAttack }, this.#settings);
      if (this.#random() >= chance) return;
      const asked = this.#clock;
      void host.attack(reference, 'ActionRightAttack').then((began) => {
        if (began) mind.lastAttack = asked;
      });
      mind.bowHold = bowHoldTime(
        style,
        { ...opponent, distance, radii: view.radius + target.radius },
        this.#random,
        this.#settings,
      );
    }
  }

  /**
   * A spell, staff or shout it fights with (5.3's castAt): facing its target within the
   * option's range and not casting already, it casts at a decision every ATTACK_DECISION_SECONDS
   * (the combat tree's cast idles) by its cast chance (a spell or staff: castChance; a shout
   * whenever its voice has recovered), src/shell/actor-casting.ts castAt and shoutAt (a
   * concentration spell held while it serves).
   */
  #cast(
    mind: Mind,
    view: FighterView,
    target: number,
    option: EquipOption,
    distance: number,
    facing: number,
    face: number,
  ): void {
    const movers = this.#options.movers;
    const reference = mind.reference;
    this.#stopRun(mind);
    if (distance > option.range) {
      movers.request(reference, {
        direction: [Math.sin(facing), Math.cos(facing)],
        gait: 'run',
        face,
        turning: this.#turning,
      });
      return;
    }
    movers.request(reference, this.#standing(face));
    if (this.#clock < mind.nextAttack || Math.abs(turnBetween(view.heading, facing)) > STRIKE_ANGLE)
      return;
    const casting = this.#options.casting?.();
    const runtime = this.#options.session.scriptsReady;
    const shout = option.kind === 'shout';
    mind.nextAttack = this.#clock + (shout ? SHOUT_DECISION_SECONDS : ATTACK_DECISION_SECONDS);
    if (!casting || !runtime) return;
    const source = shout ? CastingSource.voice : CastingSource.right;
    if (runtime.casting.casting(reference, source)) return;
    if (!shout) {
      const style = mind.profile?.style ?? NO_STYLE;
      const opponent = this.#opponent(mind, target);
      const chance = castChance(style, opponent, option.concentration === true, this.#settings);
      if (this.#random() >= chance) return;
    }
    mind.lastAttack = this.#clock;
    void casting.castAt(reference, shout ? 'voice' : 'right', target, option);
  }

  /**
   * What it does for itself (combat-tactics chooseSupport): a ward against a spell coming at
   * it, its healing spell or a potion below its style's restore shares, a summons when none of
   * its stands, a buff not on it.
   */
  async #support(mind: Mind, view: FighterView, target: number): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    const casting = this.#options.casting?.();
    const reference = mind.reference;
    if (!runtime || !casting || view.player) return;
    const share = async (index: number): Promise<number> => {
      const value = await runtime.actors.value(reference, index);
      return value.max > 0 ? value.current / value.max : 1;
    };
    const spells = runtime.casting;
    const ward = this.#threatened(mind, view)
      ? await spells.chooseSpell(reference, 'ward')
      : undefined;
    const summon = await spells.chooseSpell(reference, 'summon');
    const buff = await spells.chooseSpell(reference, 'buff');
    const choice = chooseSupport(
      {
        health: await share(ActorValue.health),
        magicka: await share(ActorValue.magicka),
        sinceHealthRestore: this.#clock - mind.healthRestoredAt,
        sinceMagickaRestore: this.#clock - mind.magickaRestoredAt,
        canHeal: (await spells.chooseSpell(reference, 'heal')) !== undefined,
        potions: {
          health: (await spells.choosePotion(reference, ActorValue.health)) !== undefined,
          magicka: (await spells.choosePotion(reference, ActorValue.magicka)) !== undefined,
        },
        canSummon: summon !== undefined && (await runtime.magic.summonsOf(reference)).length === 0,
        canBuff: buff !== undefined && !runtime.magic.hasItemOn(reference, buff.formId),
        canWard: ward !== undefined,
      },
      mind.profile?.style ?? NO_STYLE,
      this.#settings,
    );
    if (!choice || mind.mode !== 'fight') return;
    const purpose: CombatSupport =
      choice.kind === 'potion'
        ? {
            kind: 'potion',
            value: choice.value === 'health' ? ActorValue.health : ActorValue.magicka,
          }
        : { kind: choice.kind };
    if (!(await casting.support(reference, purpose, target))) return;
    if (choice.kind === 'heal' || (choice.kind === 'potion' && choice.value === 'health')) {
      mind.healthRestoredAt = this.#clock;
    }
    if (choice.kind === 'potion' && choice.value === 'magicka') {
      mind.magickaRestoredAt = this.#clock;
    }
    // Its attacks wait while it casts for itself, and after a potion the combat tree's wait.
    const wait =
      choice.kind === 'potion' ? this.#settings.drinkPotionWaitTime : SUPPORT_CAST_SECONDS;
    mind.nextAttack = Math.max(mind.nextAttack, this.#clock + wait);
  }

  /** Whether a spell or a breath comes at it now (the threats it would dodge). */
  #threatened(mind: Mind, view: FighterView | undefined): boolean {
    const feet = view?.feet;
    if (!view || !feet) return false;
    for (const threat of this.#options.host.threats()) {
      if (threat.source === mind.reference) continue;
      if (threatens(threat, feet, view.radius, view.height) !== undefined) return true;
    }
    return false;
  }

  /**
   * It blocks a blow coming at it (its style's block chance), and lets go as the blow ends or
   * after its block time. TODO(M13): phase 5, the combat tree's sustained Block and Block Attack.
   */
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
    mind.blockUntil = this.#clock + blockTime(style, this.#settings);
    void this.#options.host.block(mind.reference, true);
  }

  #releaseBlock(mind: Mind, view: FighterView | undefined): void {
    if (view?.state.blocking !== true) return;
    mind.blockUntil = 0;
    void this.#options.host.block(mind.reference, false);
  }

  /**
   * A threat coming at it (an arrow, a spell, a breath): by its style's avoid
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
        turning: this.#turning,
      });
      return true;
    }
    // An attack under way is not broken off for a threat (its controller does not move it).
    if (attacking(view.state)) return false;
    const style = mind.profile?.style ?? NO_STYLE;
    for (const threat of this.#options.host.threats()) {
      if (threat.source === mind.reference || mind.dodged.has(threat.key)) continue;
      if (threatens(threat, feet, view.radius, view.height) === undefined) continue;
      mind.dodged.add(threat.key);
      if (!avoidsThreat(style, this.#random, this.#settings)) continue;
      mind.dodge = dodgeDirection(threat, feet);
      mind.dodgeUntil = this.#clock + DODGE_SECONDS;
      // The dodge takes its movement over (the combat tree's Interrupt Movement Resource).
      this.#stopRun(mind);
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

  /** Whether it would flee now, not cornered (as #decide weighs it). */
  #wouldFlee(mind: Mind, profile: Profile): boolean {
    if (this.#clock < mind.corneredUntil) return false;
    const magic = this.#options.session.scriptsReady?.magic.aiState(mind.reference);
    return shouldFlee(
      {
        health: mind.health,
        confidence: profile.confidence,
        modifier: mind.modifier,
        afraid: magic?.fleeing === true,
        rallied: magic?.rallied === true || magic?.frenzied === true,
      },
      this.#settings,
    );
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

  /** Its target as the group offensive mult weighs it (combat-tactics offensiveMult). */
  #opponent(mind: Mind, target: number): Opponent {
    return { targetIsPlayer: target === PLAYER_REF, allies: this.#alliesOn(mind, target) };
  }

  /**
   * How long what it took up is kept before it weighs again: its kind's
   * fCombatInventoryMinEquipTime*, and no sooner than what it carries is read again.
   */
  #equipWait(kind: EquipKind | undefined): number {
    return Math.max(minEquipTime(kind, this.#settings), PROFILE_SECONDS);
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
    const spells = casting ? await casting.options(mind.reference, mind.target) : [];
    const current = view.gear?.weapon;
    const options = [...profile.options, ...spells].map((option) => ({
      ...option,
      equipped:
        option.kind === 'unarmed'
          ? current === undefined
          : option.kind === 'melee' || option.kind === 'ranged' || option.kind === 'staff'
            ? option.id === current
            : mind.equipped?.id === option.id,
    }));
    const best = chooseEquipment(options, distance, profile.style, this.#settings);
    if (!best) return;
    // Left with its fists after it held a weapon (disarmed: its weapon on the ground), it picks
    // up a weapon lying near.
    if (current !== undefined) mind.armed = true;
    if (mind.armed && best.kind === 'unarmed' && current === undefined) {
      if (await this.#pickUpWeapon(mind, view, runtime)) return;
    }
    // Not in the middle of an attack (a bow drawn, a swing): the weapon changes once it is
    // over. Changed under a drawn bow, the archer's hands held the sword while its graph stood
    // in the bow's drawn state, whose release and cancel idles ask for a bow: it held the bow
    // drawn for good (the combat scenario's guards, 39 s).
    if (!best.equipped && attacking(view.state)) return;
    mind.equipped = best;
    if (best.equipped) return;
    // Taken up, it is kept a while (fCombatInventoryMinEquipTime*).
    mind.nextEquip = this.#clock + this.#equipWait(best.kind);
    // Spells are taken up as they are cast (castAt); a staff is a weapon in the hand.
    if (best.kind === 'magic' || best.kind === 'shout') return;
    // Another weapon: sheathed first, then taken up (and arrows for a bow), then drawn again.
    mind.equipping = true;
    try {
      const host = this.#options.host;
      if (view.state.weapon !== WeaponState.sheathed) {
        await host.sheathe(mind.reference);
        await this.#until(
          () => host.fighter(mind.reference)?.state.weapon === WeaponState.sheathed,
        );
        // Its graph did not put it away (it attacks again, it is staggered): no change now.
        if (host.fighter(mind.reference)?.state.weapon !== WeaponState.sheathed) {
          mind.nextEquip = this.#clock;
          return;
        }
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

  /**
   * A weapon lying in the world within PICK_UP_REACH of a fighter left without one (disarmed:
   * UESP "Skyrim:Disarm", the disarmed take their weapon back): it runs there and picks it up
   * (equipped as its profile is read again). Whether it went for one. TODO(M13): the engine's
   * reach and how it weighs the weapon against its fists.
   */
  async #pickUpWeapon(mind: Mind, view: FighterView, runtime: ScriptRuntime): Promise<boolean> {
    const feet = view.feet;
    if (!feet) return false;
    let best: { reference: number; at: Vec3; distance: number } | undefined;
    // The loaded cells' references and those made in the game (a disarmed weapon dropped).
    const near = new Set([
      ...(runtime.world.loadedReferences?.() ?? []),
      ...runtime.state.created.keys(),
    ]);
    for (const reference of near) {
      const at = runtime.world.livePlacement?.(reference)?.position;
      if (!at) continue;
      const distance = flat(feet, at);
      if (distance > PICK_UP_REACH || (best && distance >= best.distance)) continue;
      const state = runtime.state.references.get(reference);
      if (state?.container || state?.deleted === true) continue;
      const base = await runtime.baseOf(reference);
      const item = base === undefined ? undefined : await runtime.equipment.item(base);
      if (item?.type !== 'WEAP' || !item.weapon) continue;
      if (
        item.weapon.weaponType > WeaponType.twoHandAxe &&
        item.weapon.weaponType !== WeaponType.bow
      )
        continue;
      best = { reference, at: [at[0], at[1], at[2]], distance };
    }
    if (!best) return false;
    mind.equipping = true;
    try {
      const movers = this.#options.movers;
      if (best.distance > PICK_UP_ARRIVE)
        await movers.travel(mind.reference, best.at, 'run', PICK_UP_ARRIVE);
      const still = runtime.state.references.get(best.reference);
      if (still?.container || still?.deleted === true) return true;
      const base = await runtime.baseOf(best.reference);
      await runtime.pickUp(best.reference, mind.reference);
      // In its hand (it picked it up to fight with it), its profile read again.
      if (base !== undefined) {
        await runtime.equipment.equip(mind.reference, base, { hand: 'right' });
        await this.#equipAmmo(mind.reference, base, runtime);
      }
      mind.profileRead = -Infinity;
      mind.nextEquip = this.#clock + this.#equipWait('melee');
    } finally {
      mind.equipping = false;
    }
    return true;
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
      this.#movement = readCombatMovementSettings((name) => settings.number(name));
      this.#sprints = this.#options.session.ini.bool('Combat', 'bCombatPathSprinting');
      this.#turning = combatTurning(this.#movement);
      this.#groups.settings = readCombatGroupSettings((name) => settings.number(name));
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
