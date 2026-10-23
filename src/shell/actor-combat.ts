// Combat on the stage (docs/ai.md, "Combat"; docs/m10-plan.md 5.1): the player and the actors
// of the high process draw and sheathe, attack, block and bash through the idle tree (ActionDraw,
// ActionRightAttack, ActionRightPowerAttack, ActionLeftAttack, ActionRightRelease, ...: the
// first idle whose conditions hold sends its event to the actor's graph), and their graphs'
// annotations move them on (src/gameplay/combat/combat-state.ts): the weapon to the hand at
// weaponDraw, the strike at HitFrame, the arrow at arrowRelease. A strike hits the nearest actor
// within reach and inside the attack's strike angle (hit-test.ts); its damage is the equip
// system's weapon damage times the attack's, through sneak attacks, armour, blocks and the
// difficulty (damage.ts); it staggers or recoils (stagger.ts), sounds and bleeds (combat-
// impacts.ts), tells the target's scripts (OnHit) and uses the skills (the skill progression's
// useSkill). Health run out kills, or makes an essential or protected actor bleed out
// (bleedout.ts). A killing blow may be a killmove: a paired idle the two actors play together,
// the one it is done to placed before the attacker (killmove-camera.ts shows it). Arrows fly
// (combat-projectiles.ts). The enemy the player fights shows on the HUD, and combat music plays
// while anyone fights the player.
//
// Who fights whom, and how, is the combat AI's (src/shell/actor-combat-ai.ts: aggression,
// assistance, target choice, the combat style's movement and attacks, fleeing, searching): it
// sets each fighter's target and asks for its draws, attacks, blocks and releases here.

import { parseNpcCombat, parseRaceCombat } from '../ai/race-combat-records.ts';
import {
  behaviorGraphKey,
  readIdleTree,
  type IdleRecord,
  type IdleTree,
} from '../ai/idle-records.ts';
import type { BehaviorRuntime } from '../animation/behavior-runtime.ts';
import { partnerMark } from '../animation/paired-clips.ts';
import type { AnimationBinding } from '../formats/hkx/animation.ts';
import type { GraphEvent } from '../animation/graph-events.ts';
import type { ActorGraphSource } from './actor-graph-events.ts';
import { ActorValue } from '../world/actor-values.ts';
import { DefaultObjectUse } from '../world/default-objects.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ActorCombatState, ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { ObjectHandle } from '../scripting/values.ts';
import { EquippedItemType } from '../gameplay/equipment.ts';
import { WeaponType } from '../world/item-records.ts';
import type { WeaponStats } from '../scripting/runtime/equipment-engine.ts';
import {
  AttackSet,
  attackEventKind,
  DEFAULT_ATTACK,
  POWER_ATTACK_DEFAULT,
} from '../gameplay/combat/attacks.ts';
import type { AttackData } from '../ai/race-combat-records.ts';
import { bleedoutRecovered, bleedoutRegain } from '../gameplay/combat/bleedout.ts';
import { criticalHitChance, type AttackKind } from '../gameplay/combat/combat-hooks.ts';
import { SOUL_CAPACITY } from '../gameplay/crafting.ts';
import { soulSize } from '../gameplay/magic/effect-rules.ts';
import { EntryPoint } from '../gameplay/perk-entry-points.ts';
import {
  AmmoFlag,
  parseAmmo,
  parseProjectile,
  parseRaceHits,
  parseWeaponCombat,
  type ProjectileCombat,
  type RaceHits,
  type WeaponCombat,
} from '../gameplay/combat/combat-records.ts';
import {
  readCombatSettings,
  COMBAT_DEFAULTS,
  type CombatSettings,
} from '../gameplay/combat/combat-settings.ts';
import {
  AttackState,
  KnockState,
  LifeState,
  WeaponState,
  attacking,
  bleedingOut,
  canAct,
  graphEvent,
  newCombatState,
  startAttack,
  weaponOut,
  type CombatEffect,
  type CombatState,
} from '../gameplay/combat/combat-state.ts';
import {
  bashFactor,
  blockedShare,
  bowDrawPower,
  hitDamage,
  sneakAttackMult,
} from '../gameplay/combat/damage.ts';
import {
  blockCovers,
  headingTo,
  hitDirection,
  meleeReach,
  strikeTargets,
  turnBetween,
  type StrikeTarget,
} from '../gameplay/combat/hit-test.ts';
import { rangedKillCameraPlays } from '../gameplay/combat/ranged-kill-camera.ts';
import type { INI_DEFAULTS } from '../world/ini-settings.ts';
import { ARROW_TILT, tiltUp, WORLD_GRAVITY } from '../gameplay/combat/projectile.ts';
import { anglesOf, directionOf, npcSpread } from '../gameplay/combat/aim.ts';
import { ProjectileFlag } from '../world/projectile-data.ts';
import type { AimTarget, ProjectileAim, ShotKind } from './projectile-aim.ts';
import { blockStagger, recoilOf, staggerMagnitude } from '../gameplay/combat/stagger.ts';
import { Layer } from '../physics/collision-layers.ts';
import { transformPoint, type Vec3 } from '../render/math.ts';
import type { Renderer } from '../render/renderer.ts';
import type { GpuDecals } from '../render/decals.ts';
import type { GpuScene, InstanceVisibility } from '../render/scene-renderer.ts';
import type { StagedActor } from './actor-stage.ts';
import type { ActorMovers } from './actor-movers.ts';
import type { ActorBodies, BodyHolder } from './actor-bodies.ts';
import type { ActorKnockdowns } from './actor-knockdowns.ts';
import { RaceFlag } from '../world/actor-records.ts';
import type { PlacedActor } from './actors.ts';
import { HeldWeapons, type HeldModels } from './actor-weapons.ts';
import { WeaponBlood } from '../gameplay/combat/weapon-blood.ts';
import { armorSkill } from '../gameplay/inventory.ts';
import { CombatImpacts, type HitImpact } from './combat-impacts.ts';
import type { Impact } from '../world/impact-records.ts';
import { CombatProjectiles } from './combat-projectiles.ts';
import type { GameSession } from './game-session.ts';
import type { PlaySession } from './play-session.ts';
import type { PlayerAvatar } from './player-avatar.ts';
import type { CombatBridge } from './script-world.ts';
import type { Terminal } from './terminal.ts';
import { KillmoveCamera } from './killmove-camera.ts';
import { PlayerCombat, type CastingButtons } from './player-combat.ts';
import type { ActorTalk } from './actor-talk.ts';
import type { ActorSenses } from './actor-senses.ts';
import type { ActorAi } from './actor-ai.ts';
import {
  ActorCombatAi,
  type ActorCombatAiOptions,
  type CombatAiHost,
  type CombatCasting,
  type CombatFlight,
  type FighterView,
} from './actor-combat-ai.ts';
import type { Threat } from '../ai/combat-tactics.ts';
import { cellLight } from './magic-fx.ts';
import type { CellLight } from '../world/cell-loader.ts';
import { parseLight, type LightRecord } from '../world/cell-records.ts';

/** A human's shape for hits (its controller's radius and height at scale 1; game units). */
/** The vampire lord's graph's events to go up or down (standing, moving). */
const LEVITATION_TOGGLE = 'LevitationToggle';
const LEVITATION_TOGGLE_MOVING = 'LevitationToggleMoving';
const BODY_RADIUS = 20;
const BODY_HEIGHT = 128;
/** The chest a strike or shot comes from and aims at (of the height). */
const CHEST = 0.75;
/**
 * How long a kill estimate's armor reading of its target holds (game seconds). TODO(M13): how
 * often the engine values ShouldAttackKill is not known.
 */
const ESTIMATED_ARMOR_SECONDS = 2;
/**
 * The graphs' BSDirectAtModifier kinds (userInfo) the engine gives an actor's aim: 2 bows and
 * spells, 3 the dragon rider's (observed in the original: both get the same point); and how
 * far along its shot an NPC's aim is put.
 */
const AIM_KINDS = [2, 3] as const;
/** Where a crossbow's bolt is held (the engine's node for ammunition that is no arrow). */
const BOLT_NODE = 'NPC R MagicNode [RMag]';
/** The node a nocked shot of ammunition with these AMMO flags is held on (none: not shown). */
const ammoNode = (flags: number): string | undefined =>
  (flags & AmmoFlag.nonPlayable) !== 0
    ? undefined
    : (flags & AmmoFlag.nonBolt) !== 0
      ? 'WEAPON'
      : BOLT_NODE;
const BOW_AIM_DISTANCE = 2048;
/** How far along the player's view the engine puts their aim (observed in the original). */
const PLAYER_AIM_DISTANCE = 4000;
/** Seconds an attack waits for its graph to answer (see ActorCombat #unanswered). */
const ATTACK_ANSWER = 1.5;
/** Seconds a draw or sheathe waits for its graph's end (see ActorCombat #unansweredWeapon). */
const WEAPON_ANSWER = 4;
/** An attack event its graph refused this often at once and never took is not chosen again. */
const DEAD_REFUSALS = 8;
/** Fighters this far from the player are left alone (the high process's reach). */
const FIGHT_REACH = 4096;
/** How often a fighter's perks' graph variables are read again (seconds). */
const PERK_VARIABLE_SECONDS = 1;
/** How wide a flying arrow is to those it may hit and who dodge it (units). */
const SHOT_RADIUS = 8;
/**
 * A paired idle's event begins so; its partner's event is the rest (observed in the
 * original: "pa_KillMoveB" for the leader, "KillMoveB" for the one it is done to).
 */
const PAIRED_PREFIX = 'pa_';

/** One who fights: an actor of the stage or the player. */
interface Fighter {
  readonly reference: number;
  readonly player: boolean;
  readonly state: CombatState;
  /** Its body now, and the one its models and events were made for. */
  body: PlacedActor | undefined;
  hooked: PlacedActor | undefined;
  held: HeldWeapons | undefined;
  /** The player's weapons in first person: their first-person models on the arms. */
  firstHeld: HeldWeapons | undefined;
  heldFor: string | undefined;
  /** Its weapons' blood (both hands; new weapons come clean), for the weapons it was made for. */
  blood:
    { readonly right: WeaponBlood; readonly left: WeaponBlood; readonly for: string } | undefined;
  /** What its hands hold (the equip system's) and its attack data, once read. */
  gear: Gear | undefined;
  gearVersion: number;
  gearLoading: boolean;
  /** Its combat target (the combat AI's; the player's: the one they strike at). */
  target: number | undefined;
  /** When its current attack's power began to be held (the player's power attacks). */
  heldSince: number | undefined;
  /** The weapon state it was in when its drawn models last followed it. */
  inHand: boolean;
  /** Its hands' GetEquippedItemType codes as its graphs were last told (#graphVariables). */
  handTypes: { readonly right: number; readonly left: number } | undefined;
  /** Its draw's or sheathing's sound played at the graph's BeginWeaponDraw / BeginWeaponSheathe. */
  drawSounded: boolean;
  /** Bleeding out: seconds down; in a paired animation: seconds in it. */
  down: number;
  pairedFor: number;
  /** A killmove's victim: who leads it (the engine's myKiller, set as the killmove starts). */
  killer: number | undefined;
  /** In a paired animation, its graph has entered its synchronized clip. */
  synced: boolean;
  /**
   * A paired clip's partner on its way to its mark (#followMark): whose, since when (the
   * clock), and where it started once the clip is known.
   */
  toMark:
    | {
        readonly leader: number;
        readonly since: number;
        from:
          { readonly position: Vec3; readonly heading: number; readonly at: number } | undefined;
      }
    | undefined;
  /**
   * Its bleedout's regain under way: one at a time, or long frames start more of it than
   * finishes (each a chain of perk conditions), and the backlog makes the frames longer still.
   */
  bleeding: boolean;
  unbled: number;
  /** The last hit it dealt was critical. */
  lastCritical: boolean;
  /** When its current attack began, while it has not got past its wind-up (see #unanswered). */
  attackSince: number | undefined;
  /** Attack events its graph took (past their wind-up) and those it never did (#unanswered). */
  readonly liveAttacks: Set<string>;
  readonly deadAttacks: Set<string>;
  /**
   * The draw or sheathe its graph was asked for and when, while it is under way
   * (#unansweredWeapon).
   */
  weaponAsked: { readonly event: string; readonly since: number } | undefined;
  /** How often its graph refused each attack event at once, and all refusals (#unanswered). */
  readonly refusals: Map<string, number>;
  refusedAttacks: number;
  /** A package's UseWeapon practice it attacks in (src/shell/actor-practice.ts), if any. */
  practice: Practice | undefined;
  /** Its arms aim a drawn bow (#aimBow). */
  bowAimed: boolean;
  /** The combat target its combat head track was last set to (#combatLook). */
  lookedAt: number | undefined;
  /** What its left hand's graph override was told for which body (#graphVariables). */
  leftHand: { readonly body: PlacedActor | undefined; readonly kind: string } | undefined;
}

/** How a UseWeapon practice's attacks go (its procedure's parameters). */
export interface Practice {
  /** Where its shots go when its target is no fighter (an archery butt): a world point. */
  readonly aimAt: Vec3 | undefined;
  readonly doNoDamage: boolean;
  readonly alwaysHit: boolean;
  /** Its hits on an actor may start a fight. */
  readonly combatStartOnHit: boolean;
}

/** What a fighter's hands hold, for combat. */
interface Gear {
  readonly right: WeaponStats;
  readonly left: WeaponStats;
  readonly rightRecord: WeaponCombat | undefined;
  readonly leftRecord: WeaponCombat | undefined;
  readonly shield: number | undefined;
  readonly shieldRating: number;
  readonly projectile: ProjectileCombat | undefined;
  readonly ammoModel: string | undefined;
  /**
   * The node a nocked shot is held on (observed in the original): an arrow (AMMO non-bolt)
   * on WEAPON, where the bow animations hold it; a crossbow's bolt on NPC R MagicNode [RMag];
   * a non-playable one on none.
   */
  readonly ammoNode: string | undefined;
  readonly attacks: AttackSet;
  readonly race: RaceHits | undefined;
  /** A torch in the left hand (a LIGH that can be carried): its model and its light. */
  readonly torch: { readonly model: string | undefined; readonly light: LightRecord } | undefined;
  /** A hand holds a spell or a scroll (GetEquippedItemType 9: the graphs' casting clips). */
  readonly spells: { readonly right: boolean; readonly left: boolean };
}

export interface ActorCombatOptions {
  readonly session: GameSession;
  readonly renderer: Renderer;
  readonly terminal: Terminal;
  readonly movers: ActorMovers;
  readonly bodies: ActorBodies;
  readonly actors: () => Iterable<StagedActor>;
  readonly get: (reference: number) => StagedActor | undefined;
  /** The dead player's body (src/shell/player-death.ts): the killing blow pushes it. */
  readonly playerBody?: () => BodyHolder | undefined;
  /** What the actors say (their combat lines: Attack, Hit, Block, BleedOut, Death, ...). */
  readonly talk?: () => ActorTalk | undefined;
  /** What they notice (an attack heard, the attacked searching, sneak attacks' awareness). */
  readonly senses?: () => ActorSenses | undefined;
  /** The player's casting: drawn hands holding magic cast (src/shell/player-casting.ts). */
  readonly casting?: () => CastingButtons | undefined;
  /** Their packages (the combat override packages' places; evaluated as combat ends). */
  readonly ai?: () => ActorAi | undefined;
  /** Inside a cell (how far the fleeing run). */
  readonly interior?: () => boolean;
  /** An actor gets off its horse to fight; a horse ridden is its rider's to move. */
  readonly dismount?: (actor: number) => Promise<void>;
  /** Furniture holding an actor: it gets up to fight or flee. */
  readonly furniture?: ActorCombatAiOptions['furniture'];
  readonly ridden?: (actor: number) => boolean;
  /** NPCs' spells and shouts in combat (src/shell/combat-casting.ts). */
  readonly npcCasting?: () => CombatCasting | undefined;
  /** The fliers: dragons fighting from the air (src/shell/actor-flight.ts). */
  readonly flight?: () => CombatFlight | undefined;
  /** The knocked down (src/shell/actor-knockdowns.ts): their ragdolls and getting up. */
  readonly knockdowns?: () => ActorKnockdowns | undefined;
  /** What else flies at the actors: spells and breath (magic-projectiles.ts, actor-casting.ts). */
  readonly threats?: () => Iterable<Threat>;
  /** Where shots go: the player's aim assistance, an NPC's aim at its target. */
  readonly aim?: () => ProjectileAim | undefined;
  /** A killmove's victim loses its head (src/shell/actor-dismemberment.ts). */
  readonly decapitate?: (actor: number) => void;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class ActorCombat implements CombatBridge {
  readonly #options: ActorCombatOptions;
  readonly #fighters = new Map<number, Fighter>();
  /** The NPC archers' Archery, as read when they draw. */
  readonly #archery = new Map<number, number>();
  /** The graph variables each fighter's perks set (Set Boolean Graph Variable), when read. */
  readonly #perkVariables = new Map<number, { at: number; names: Set<string>; reading: boolean }>();
  readonly #impacts: CombatImpacts;
  readonly #projectiles: CombatProjectiles;
  #settings: CombatSettings = COMBAT_DEFAULTS;
  #settingsRead = false;
  #tree: Promise<IdleTree> | undefined;
  readonly #graphKeys = new Map<string, Promise<string | undefined>>();
  #play: PlaySession | undefined;
  #avatar: PlayerAvatar | undefined;
  readonly #playerVisibility: InstanceVisibility = { hidden: false };
  /** The player's first-person weapons: shown with the first-person arms. */
  readonly #firstPersonVisibility: InstanceVisibility = { hidden: true };
  #clock = 0;
  /**
   * The armor reduction of each kill estimate's target, kept a while: worked out piece by piece
   * through the perks' conditions, it is too dear for every estimate of every fighter (a hit
   * works it out afresh).
   */
  readonly #estimatedArmor = new Map<number, { readonly reduction: number; readonly at: number }>();
  /** The enemy bar's actor, its health shown (percent) and when that last changed. */
  #enemy: { readonly reference: number; changed: number; health: number } | undefined;
  #music: number | undefined;
  #musicOn = false;
  #equipListening: ScriptRuntime | undefined;
  #camera: KillmoveCamera | undefined;
  /** The kill camera's image-space modifier shown now. */
  #killCamImod: number | undefined;
  #input: PlayerCombat | undefined;
  /** Who fights whom and how (src/shell/actor-combat-ai.ts). */
  readonly #brain: ActorCombatAi;
  /** When a caster's spell last counted as a blow on a victim ("caster:victim"). */
  readonly #spellHits = new Map<string, number>();

  constructor(options: ActorCombatOptions) {
    this.#options = options;
    this.#brain = new ActorCombatAi({
      session: options.session,
      terminal: options.terminal,
      movers: options.movers,
      host: this.#host(),
      ...(options.senses && { senses: options.senses }),
      ...(options.talk && { talk: options.talk }),
      ...(options.ai && { ai: options.ai }),
      ...(options.interior && { interior: options.interior }),
      ...(options.dismount && { dismount: options.dismount }),
      ...(options.furniture && { furniture: options.furniture }),
      ...(options.ridden && { ridden: options.ridden }),
      ...(options.npcCasting && { casting: options.npcCasting }),
      ...(options.flight && { flight: options.flight }),
    });
    // The wait menu asks whether someone fights the player.
    options.session.combatWatch = this;
    this.#impacts = new CombatImpacts(options.session, options.renderer);
    this.#projectiles = new CombatProjectiles({
      session: options.session,
      renderer: options.renderer,
      stickDepth: () => this.#settings.missileStickDepth,
      shapes: () => this.#playerShape(),
      onActorHit: (shot) => {
        const payload = shot.payload as ShotPayload;
        void this.#arrowKept(payload.attacker, shot.target, shot.ammo);
        void this.#hit(payload.attacker, shot.target, {
          ...payload.kind,
          point: shot.point,
          direction: shot.direction,
          shot: payload,
        }).catch((error: unknown) => {
          this.#warn(`a shot's hit: ${describe(error)}`);
        });
      },
      onWorldHit: (point, direction, material, _ammo, reference, payload) => {
        // A destructible object takes the shot's damage (destruction-engine.ts); the hub tells
        // the object's hit (TESHitEvent: OnHit with the bow and the arrow's projectile).
        const shot = payload as ShotPayload;
        if (reference !== undefined)
          this.#options.session.scriptsReady?.events.emit('hit', {
            target: reference,
            aggressor: shot.attacker,
            source: shot.weapon,
            projectile: shot.projectile,
            powerAttack: false,
            sneakAttack: shot.kind.sneak,
            bashAttack: false,
            blocked: false,
          });
        if (reference !== undefined)
          void this.#options.session.scriptsReady?.destruction
            .damage(reference, shot.damage * shot.power, {
              external: true,
              source: shot.attacker,
            })
            .catch((error: unknown) => {
              this.#warn(`a shot's hit: ${describe(error)}`);
            });
        void this.#impacts.hit(
          {
            impactDataSet: undefined,
            materialId: material,
            position: point,
            direction,
            heavy: false,
          },
          this.#play?.physics,
        );
      },
    });
  }

  // --- The player ------------------------------------------------------------------------------

  /** The player plays (their avatar and session); undefined: the play ended. */
  attachPlayer(play: PlaySession | undefined, avatar: PlayerAvatar | undefined): void {
    this.#play = play;
    this.#avatar = avatar;
    const fighter = this.#fighters.get(PLAYER_REF);
    if (fighter) this.#drop(fighter);
    this.#input = undefined;
    if (play && avatar) {
      this.#fighters.set(PLAYER_REF, newFighter(PLAYER_REF, true));
      // Drawn (or being drawn), the third-person camera moves behind the back.
      play.player.weaponDrawn = () => {
        const state = this.weaponState(PLAYER_REF);
        return state >= WeaponState.wantToDraw && state <= WeaponState.drawn;
      };
      // In furniture or a menu the buttons are not the fight's.
      this.#input = new PlayerCombat(
        this,
        play.player,
        () => !play.seated && !play.dead && !play.knocked && !this.#options.session.menuMode,
        () => this.#options.casting?.(),
        // A bow zoomed (Eagle Eye): the view's factor (src/shell/time-flow.ts).
        (wanted, weapon) => this.#options.session.time.bowZoom(wanted, weapon),
      );
    }
    if (!play) {
      this.#projectiles.clear();
      this.#camera = undefined;
      this.#setMusic(false);
    }
  }

  /**
   * The player died (src/shell/player-death.ts): they fight no more (what they held goes, as
   * the dead's does), no fighter keeps them its target, and the combat AI's minds that fought
   * them find no target in them (the dead are none: actor-combat-ai.ts) and end their fights.
   */
  playerDied(): void {
    const fighter = this.#fighters.get(PLAYER_REF);
    if (fighter) this.#drop(fighter);
    this.#input = undefined;
    for (const other of this.#fighters.values()) {
      if (other.target === PLAYER_REF) other.target = undefined;
    }
    // A killmove on the player ends with them: the death camera takes the view.
    this.#camera = undefined;
  }

  /** The killmove camera the player looks through now (undefined: theirs). */
  get camera(): KillmoveCamera | undefined {
    return this.#camera;
  }

  // --- What is drawn ---------------------------------------------------------------------------

  /** The weapons' and shots' scenes. */
  *scenes(): Iterable<GpuScene> {
    for (const fighter of this.#fighters.values()) {
      const scene = fighter.held?.scene;
      if (scene) yield scene;
      const first = fighter.firstHeld?.scene;
      if (first) yield first;
    }
    yield* this.#projectiles.scenes();
  }

  /** The hits' decals (blood). */
  /**
   * ObjectReference.PlayImpactEffect: an impact data set's impact for the surface a ray from a
   * point finds within its length (its sound and decal for that surface's material); false if
   * the ray finds none.
   */
  impactAt(impactDataSet: number, from: Vec3, direction: Vec3, length: number): boolean {
    const physics = this.#play?.physics;
    if (!physics?.queriesCurrent) return false;
    const hit = physics.raycast(from, direction, Math.max(1, length), Layer.static);
    if (!hit) return false;
    const norm = Math.hypot(direction[0], direction[1], direction[2]) || 1;
    void this.#impacts.hit(
      {
        impactDataSet,
        materialId: hit.material,
        position: hit.point,
        direction: [direction[0] / norm, direction[1] / norm, direction[2] / norm],
        heavy: false,
      },
      physics,
    );
    return true;
  }

  decals(): Iterable<GpuDecals> {
    return this.#impacts.decals();
  }

  /**
   * An impact where something (a spell) met a surface or an actor: its sound and decal; resolves
   * the impact (IPCT) for what else it leaves (its model, its hazard: src/shell/magic-fx.ts).
   */
  surfaceImpact(hit: HitImpact): Promise<Impact | undefined> {
    return this.#impacts.hit(hit, this.#play?.physics);
  }

  // --- CombatBridge (what scripts ask and tell) ------------------------------------------------

  state(actor: number): ActorCombatState | undefined {
    const fighter = this.#fighters.get(actor);
    if (!fighter) return undefined;
    const state = fighter.state;
    return {
      weaponState: state.weapon,
      attackState: state.attack,
      attacking: attacking(state),
      powerAttacking: state.current?.power === true,
      wantBlocking: state.wantBlocking,
      blocking: state.blocking,
      staggered: state.staggered,
      recoiling: state.recoiling,
      bleedingOut: bleedingOut(state),
      knockState: state.knock,
      paired: state.paired !== undefined,
      killMove: state.killMove,
      movementDirection: this.#movementDirection(fighter),
      lastHitCritical: fighter.lastCritical,
      // The player is in combat while an actor fights them.
      inCombat: fighter.player ? this.#fightingPlayer() : this.#brain.combatState(actor) !== 0,
      combatState: fighter.player
        ? this.#fightingPlayer()
          ? 1
          : 0
        : this.#brain.combatState(actor),
      fleeing: this.#brain.fleeing(actor) || this.#options.ai?.()?.fleeing(actor) === true,
      observingCombat: this.#options.senses?.()?.reacting(actor) === 'spectator',
      friendHits: this.#brain.friendHits(actor),
      groupSize: this.#brain.groupSize(actor),
      combatTarget: fighter.target,
    };
  }

  /**
   * ShouldAttackKill, observed in the original: the attacker's next strike would kill the
   * target. Never one already dead, nor one that cannot be killed: an essential actor or a
   * child, nor a protected one but by the player (one raised from the dead always can be). The
   * strike is the engine's predicted hit: the weapon in the attacker's hand (its fists without
   * one) through the target's armour and the difficulty, times the attack data of its attack
   * under way (none: 1; no critical, no sneak attack), against the target's health now. Undefined:
   * not one of its fighters.
   */
  attackKills(attacker: number, target: number): Promise<boolean> | undefined {
    const fighter = this.#fighters.get(attacker);
    const victim = this.#fighters.get(target);
    if (!fighter || !victim) return undefined;
    return this.#attackKills(fighter, victim);
  }

  /**
   * IsLastHostileActor, observed in the original: the actors hostile to the player near
   * them (alive, fighting the player, within fHostileActorExteriorDistance, inside
   * fHostileActorInteriorDistance; fliers also within fHostileFlyingActorExteriorDistance) are
   * none, or the actor alone.
   */
  lastHostileActor(actor: number): boolean | undefined {
    const player = this.#fighters.get(PLAYER_REF);
    const at = player && this.#feet(player);
    if (!at) return undefined;
    const interior = this.#options.interior?.() === true;
    const reach = interior
      ? this.#settings.hostileActorInteriorDistance
      : this.#settings.hostileActorExteriorDistance;
    let others = 0;
    for (const fighter of this.#fighters.values()) {
      if (fighter.player || fighter.reference === actor) continue;
      if (fighter.target !== PLAYER_REF || fighter.state.life === LifeState.dead) continue;
      const feet = this.#feet(fighter);
      if (!feet) continue;
      const distance = Math.hypot(feet[0] - at[0], feet[1] - at[1], feet[2] - at[2]);
      const flying = this.#options.flight?.()?.isFlying(fighter.reference) === true;
      if (
        distance <= reach ||
        (flying && distance <= this.#settings.hostileFlyingActorExteriorDistance)
      ) {
        others++;
      }
    }
    return others === 0;
  }

  /** A fighter's combat target, if it has one. */
  targetOf(actor: number): number | undefined {
    return this.#fighters.get(actor)?.target;
  }

  /** Whether an actor plays a paired animation (a killmove: its death is its clip's). */
  paired(actor: number): boolean {
    return this.#fighters.get(actor)?.state.paired !== undefined;
  }

  startCombat(actor: number, target: number): void {
    if (actor === target || !this.#fighters.has(actor)) return;
    this.#brain.startCombat(actor, target);
  }

  stopCombat(actor: number): void {
    const fighter = this.#fighters.get(actor);
    if (!fighter) return;
    if (fighter.player) fighter.target = undefined;
    else this.#brain.stopCombat(actor);
  }

  /** Whether an actor fights another, or would attack it on sight (IsHostileToActor). */
  hostile(actor: number, target: number): boolean {
    const fighter = this.#fighters.get(actor);
    return fighter?.target === target || this.#brain.hostile(actor, target);
  }

  drawWeapon(actor: number, draw: boolean): void {
    const fighter = this.#fighters.get(actor);
    if (!fighter) return;
    if (draw) void this.draw(fighter.reference);
    else void this.sheathe(fighter.reference);
  }

  bleedout(actor: number, source: number | undefined): void {
    const fighter = this.#fighters.get(actor);
    if (!fighter || bleedingOut(fighter.state)) return;
    fighter.state.life = LifeState.bleedout;
    fighter.state.current = undefined;
    fighter.state.attack = AttackState.none;
    fighter.down = 0;
    // Its enemies leave it alone (UESP "Protected NPCs").
    for (const other of this.#fighters.values()) {
      if (other.target === actor) other.target = undefined;
    }
    if (fighter.target === source) fighter.target = undefined;
    void this.#act(fighter, 'ActionBleedoutStart');
    this.#bark(fighter.reference, 'BleedOut', source);
    // The hub tells it (TESEnterBleedoutEvent: OnEnterBleedout), as the engine does when an
    // actor's life state turns to bleeding out (observed in the original; the player's too).
    this.#options.session.scriptsReady?.events.emit('enterBleedout', { actor });
  }

  firstPerson(): boolean {
    return this.#play?.player.pov === 'first';
  }

  // --- Actions ---------------------------------------------------------------------------------

  /** Draws its weapon (ActionDraw); whether it began. */
  async draw(reference: number): Promise<boolean> {
    const fighter = this.#fighters.get(reference);
    if (!fighter || !canAct(fighter.state) || fighter.state.weapon !== WeaponState.sheathed) {
      return false;
    }
    fighter.state.weapon = WeaponState.wantToDraw;
    const event = await this.#act(fighter, 'ActionDraw');
    if (event === undefined) {
      fighter.state.weapon = WeaponState.sheathed;
      return false;
    }
    fighter.state.weapon = WeaponState.drawing;
    fighter.weaponAsked = { event: event.toLowerCase(), since: this.#clock };
    this.#setVariable(fighter, 'IsEquipping', 1);
    return true;
  }

  /**
   * A graph that levitates (the vampire lord's: it declares LevitationToggle) goes up or down
   * on Ready Weapon instead of drawing or sheathing (LevitationToggleMoving while it moves):
   * magic in the air, claws on the ground (UESP "Dawnguard:Vampire Lord"). TODO(M13): the
   * engine's own trigger is not documented. Whether it toggled.
   */
  toggleLevitation(reference: number): boolean {
    const fighter = this.#fighters.get(reference);
    const graph = fighter?.body?.behavior;
    if (!fighter || !graph?.declares(LEVITATION_TOGGLE) || !canAct(fighter.state)) return false;
    const moving = (graph.variable('Speed') ?? 0) > 0;
    return graph.sendEvent(moving ? LEVITATION_TOGGLE_MOVING : LEVITATION_TOGGLE);
  }

  /** Sheathes its weapon (ActionSheath); whether it began. */
  async sheathe(reference: number): Promise<boolean> {
    const fighter = this.#fighters.get(reference);
    if (fighter?.state.weapon !== WeaponState.drawn || attacking(fighter.state)) {
      return false;
    }
    fighter.state.weapon = WeaponState.wantToSheathe;
    const event = await this.#act(fighter, 'ActionSheath');
    if (event === undefined) {
      fighter.state.weapon = WeaponState.drawn;
      return false;
    }
    fighter.state.weapon = WeaponState.sheathing;
    fighter.weaponAsked = { event: event.toLowerCase(), since: this.#clock };
    this.#setVariable(fighter, 'IsUnequipping', 1);
    return true;
  }

  /**
   * An attack action (ActionRightAttack, ActionLeftAttack, ActionRightPowerAttack, ...) on its
   * target: its idle's event starts the attack (or draws, if the weapon is sheathed: the tree's
   * DrawWeapon idles). Power attacks and bashes cost stamina (the skill progression's costs);
   * without stamina a power attack is a plain one. Whether something played.
   */
  async attack(reference: number, action: string): Promise<boolean> {
    const fighter = this.#fighters.get(reference);
    const runtime = this.#options.session.scriptsReady;
    if (!fighter || !runtime || !canAct(fighter.state)) return false;
    const state = fighter.state;
    // In the attack's window the next one chains; otherwise one at a time.
    if (
      attacking(state) &&
      state.attack !== AttackState.nextAttack &&
      state.attack !== AttackState.followThrough &&
      state.attack !== AttackState.bash
    ) {
      return false;
    }
    if (fighter.player) fighter.target = this.#aimedAt(fighter);
    const target = fighter.target;
    // Power attacks need stamina (UESP "Damage": without it, a plain attack).
    if (action.includes('Power') && !(await runtime.progression.canPowerAttack(reference))) {
      runtime.progression.refused(reference, 'stamina');
      action = action.replace('PowerAttack', 'Attack');
    }
    const event =
      (await this.#act(fighter, action, target)) ?? this.#creatureAttack(fighter, action);
    if (event === undefined) return false;
    const lower = event.toLowerCase();
    if (lower === 'weapequip') {
      state.weapon = WeaponState.drawing;
      this.#setVariable(fighter, 'IsEquipping', 1);
      return true;
    }
    if (lower === 'blockstart') {
      state.wantBlocking = true;
      this.#setVariable(fighter, 'iWantBlock', 1);
      this.#setVariable(fighter, 'IsBlocking', 1);
      state.blocking = true;
      return true;
    }
    const data = fighter.gear?.attacks.of(event);
    const kind = attackEventKind(event, data);
    if (!kind) return true;
    const left = kind.left || action.includes('Left');
    const dual = action.includes('Dual');
    startAttack(state, {
      event,
      hand: dual ? 'dual' : left ? 'left' : 'right',
      power: kind.power,
      bash: kind.bash,
    });
    this.#setVariable(fighter, 'IsAttacking', 1);
    fighter.attackSince = this.#clock;
    if (kind.bash) this.#setVariable(fighter, 'IsBashing', 1);
    void this.#spendFor(fighter, data ?? DEFAULT_ATTACK, kind.power, kind.bash, dual);
    // Attacking ends its invisibility (the magic system); its combat line (an NPC's).
    runtime.magic.acted(reference);
    if (!fighter.player) {
      this.#bark(reference, kind.bash ? 'Bash' : kind.power ? 'PowerAttack' : 'Attack', target);
    }
    // A paired killmove: the one it is done to plays its part.
    if (lower.startsWith(PAIRED_PREFIX) && target !== undefined) this.#pair(fighter, target, event);
    return true;
  }

  /** The attack button let go (ActionRightRelease / ActionLeftRelease): a bow loosed, a block or bash ended. */
  async release(reference: number, action: string): Promise<void> {
    const fighter = this.#fighters.get(reference);
    if (!fighter) return;
    const event = await this.#act(fighter, action);
    if (event?.toLowerCase() === 'blockstop' || action === 'ActionLeftRelease') {
      fighter.state.wantBlocking = false;
      fighter.state.blocking = false;
      this.#setVariable(fighter, 'iWantBlock', 0);
      this.#setVariable(fighter, 'IsBlocking', 0);
    }
  }

  /** Blocks (true) or stops (false): the left hand's attack when it holds a shield or nothing. */
  async block(reference: number, on: boolean): Promise<void> {
    if (on) await this.attack(reference, 'ActionLeftAttack');
    else await this.release(reference, 'ActionLeftRelease');
  }

  /** Whether an actor fights (its target), for its AI (its packages wait meanwhile). */
  engaged(reference: number): boolean {
    const fighter = this.#fighters.get(reference);
    return (
      fighter !== undefined &&
      !fighter.player &&
      (this.#brain.engaged(reference) ||
        fighter.state.paired !== undefined ||
        bleedingOut(fighter.state))
    );
  }

  /**
   * What a fighter's hands hold (WeaponType; undefined: nothing) and whether its left holds a
   * shield: what the player's attack buttons do.
   */
  hands(reference: number):
    | {
        readonly right: number | undefined;
        readonly left: number | undefined;
        readonly shield: boolean;
      }
    | undefined {
    const gear = this.#fighters.get(reference)?.gear;
    if (!gear) return undefined;
    return {
      right: gear.right.weapon === undefined ? undefined : gear.right.weaponType,
      left: gear.left.weapon === undefined ? undefined : gear.left.weaponType,
      shield: gear.shield !== undefined,
    };
  }

  /** The weapon (WEAP) in a fighter's right hand, if any (the bow's zoom asks its perks). */
  weaponOf(reference: number): number | undefined {
    return this.#fighters.get(reference)?.gear?.right.weapon;
  }

  /**
   * Where a fighter's WEAPON node is in the world (its third-person body): what the graphs'
   * block anticipation turns toward (BSDirectAtModifier userInfo 1, src/shell/actor-looks.ts).
   */
  weaponPoint(reference: number): Vec3 | undefined {
    const fighter = this.#fighters.get(reference);
    if (!fighter) return undefined;
    const pose = fighter.player ? this.#avatar?.body.pose : fighter.body?.pose;
    const world = fighter.player
      ? this.#avatar?.placement.world
      : fighter.body?.instances[0]?.world;
    const node = pose?.world('WEAPON');
    return node && world
      ? transformPoint(world, [node[12] ?? 0, node[13] ?? 0, node[14] ?? 0])
      : undefined;
  }

  /** A fighter's combat state (the player's input reads it). */
  combatState(reference: number): CombatState | undefined {
    return this.#fighters.get(reference)?.state;
  }

  /** What an actor's weapon state is (sheathed, drawing, drawn, ...). */
  weaponState(reference: number): number {
    return this.#fighters.get(reference)?.state.weapon ?? WeaponState.sheathed;
  }

  // --- The frame -------------------------------------------------------------------------------

  /**
   * Every frame (real seconds since the last), after the actors' AI and before their skeletons
   * animate: fighters near the player join, their gear and models follow their equipment, the
   * AI fights, bleeding out heals, shots fly, the music and the enemy bar follow.
   */
  frame(seconds: number, focus: Vec3 | undefined): void {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return;
    this.#clock += seconds;
    this.#readSettings();
    this.#listenToEquipment(runtime);
    const seen = new Set<number>();
    for (const staged of this.#options.actors()) {
      if (staged.dead || staged.visibility.hidden) continue;
      // One fighting already fights on while it is loaded (a dragon orbits far beyond the reach).
      const near =
        !focus ||
        Math.hypot(staged.position[0] - focus[0], staged.position[1] - focus[1]) < FIGHT_REACH ||
        this.engaged(staged.reference);
      if (!near) continue;
      seen.add(staged.reference);
      let fighter = this.#fighters.get(staged.reference);
      if (!fighter) {
        fighter = newFighter(staged.reference, false);
        this.#fighters.set(staged.reference, fighter);
      }
      this.#follow(fighter, staged.placed, runtime);
      this.#unanswered(fighter);
      this.#unansweredWeapon(fighter);
    }
    const player = this.#fighters.get(PLAYER_REF);
    const avatar = this.#avatar;
    if (player && avatar) {
      seen.add(PLAYER_REF);
      this.#follow(player, avatar.body, runtime);
      avatar.facesAim = weaponOut(player.state);
      this.#input?.frame(seconds);
      this.#playerVisibility.hidden = this.#play?.bodyShown !== true;
      this.#firstPersonVisibility.hidden =
        this.#play?.bodyShown !== false || this.#play.dead || !runtime.firstPersonGeometry;
    }
    for (const fighter of [...this.#fighters.values()]) {
      if (!seen.has(fighter.reference)) {
        this.#drop(fighter);
        continue;
      }
      this.#update(fighter, seconds, runtime);
      this.#perkGraphVariables(fighter, runtime);
    }
    // Who fights whom, and how.
    this.#brain.frame(seconds);
    this.#projectiles.frame(seconds, this.#play?.physics);
    // Its shots last real seconds (the world's clock runs at their pace meanwhile).
    const realSeconds = seconds / Math.max(0.01, this.#options.session.time.multiplier);
    this.#camera?.update(realSeconds);
    // The kill camera is the player's while it plays: the world's clock at its shot's pace,
    // the shot's image-space modifier on.
    const play = this.#play;
    if (this.#camera?.done === true) this.#camera = undefined;
    this.#options.session.time.killCam = this.#camera?.timeMultiplier ?? 1;
    this.#killCamModifier(this.#camera?.imageSpaceModifier);
    if (play) {
      play.heldByPair = player?.state.paired !== undefined;
      if (this.#camera && play.cameraOverride === undefined) play.cameraOverride = this.#camera;
      else if (!this.#camera && play.cameraOverride instanceof KillmoveCamera) {
        play.cameraOverride = undefined;
      }
    }
    this.#enemyBar();
    this.#setMusic(this.#fightingPlayer());
  }

  /**
   * The kill camera's image-space modifier (its shot's, observed in the original): each
   * shot's cross-faded in over fVATSImageSpaceTransitionTime, faded out as the camera ends.
   */
  #killCamModifier(modifier: number | undefined): void {
    if (modifier === this.#killCamImod) return;
    const modifiers = this.#options.session.imageSpaceModifiers;
    const seconds = this.#settings.vatsImageSpaceTransitionTime;
    this.#killCamImod = modifier;
    if (modifier === undefined) void modifiers.removeCrossFade(seconds);
    else void modifiers.crossFade(modifier, seconds);
  }

  /**
   * The lights its fighters carry: each torch's (its LIGH's radius, colour and flicker) at its
   * flame. The viewers light the world with them; detection's light level counts them.
   */
  lights(): CellLight[] {
    const lights: CellLight[] = [];
    for (const fighter of this.#fighters.values()) {
      const torch = fighter.gear?.torch;
      if (!torch) continue;
      // The player in first person: the first-person arms' torch.
      const firstPerson = fighter.player && this.#play?.bodyShown === false;
      const at = (firstPerson ? fighter.firstHeld : fighter.held)?.torchLight();
      if (at) lights.push(cellLight(fighter.reference, at, torch.light, 1));
    }
    return lights;
  }

  /**
   * A fighter's body: its models made for what it holds (its graph's events come through the
   * stage's dispatch: graphEvent, heard).
   */
  #follow(fighter: Fighter, body: PlacedActor, runtime: ScriptRuntime): void {
    fighter.body = body;
    if (fighter.hooked !== body) {
      // Made again in another race (Actor.SetRace: a werewolf and back): its new graph starts
      // with nothing drawn and no attack (the werewolf's raises weaponDraw as it stands).
      if (fighter.hooked && fighter.hooked.look.race !== body.look.race) {
        fighter.state.weapon = WeaponState.sheathed;
        fighter.state.attack = AttackState.none;
        fighter.state.current = undefined;
      }
      fighter.hooked = body;
      fighter.gear = undefined;
      fighter.heldFor = undefined;
    }
    if (!fighter.gear && !fighter.gearLoading) void this.#loadGear(fighter, runtime);
  }

  /** What a fighter holds, read from the equip system (again when it changes). */
  async #loadGear(fighter: Fighter, runtime: ScriptRuntime): Promise<void> {
    fighter.gearLoading = true;
    const version = fighter.gearVersion;
    try {
      const gear = await this.#readGear(fighter, runtime);
      if (version !== fighter.gearVersion) return;
      fighter.gear = gear;
      this.#graphVariables(fighter, gear);
      await this.#makeModels(fighter, gear);
    } catch (error) {
      this.#warn(`${fighter.reference.toString(16)}: ${describe(error)}`);
    } finally {
      fighter.gearLoading = false;
    }
  }

  async #readGear(fighter: Fighter, runtime: ScriptRuntime): Promise<Gear> {
    const reference = fighter.reference;
    const equipment = runtime.equipment;
    const [right, left, shield, torchForm] = await Promise.all([
      equipment.weaponStats(reference, 'right'),
      equipment.weaponStats(reference, 'left'),
      equipment.shield(reference),
      equipment.torch(reference),
    ]);
    const forms = runtime.forms;
    const weapon = async (form: number | undefined): Promise<WeaponCombat | undefined> => {
      const record = form === undefined ? undefined : await forms.record(form);
      return record?.type === 'WEAP' ? parseWeaponCombat(record) : undefined;
    };
    const [rightRecord, leftRecord] = await Promise.all([
      weapon(right.weapon),
      weapon(left.weapon),
    ]);
    const shieldItem = shield === undefined ? undefined : await equipment.item(shield);
    const torchRecord = torchForm === undefined ? undefined : await forms.record(torchForm);
    const torch =
      torchRecord?.type === 'LIGH'
        ? { model: torchRecord.fields.zstring('MODL'), light: parseLight(torchRecord) }
        : undefined;
    const ammoRecord = right.ammo === undefined ? undefined : await forms.record(right.ammo);
    const ammo = ammoRecord?.type === 'AMMO' ? parseAmmo(ammoRecord) : undefined;
    const projectileRecord =
      ammo?.projectile === undefined ? undefined : await forms.record(ammo.projectile);
    // The attack data: its race's (or the race ATKR names) under its own (NPC_ ATKD).
    const raceId = await runtime.actors.raceOf(reference);
    const raceRecord = raceId === undefined ? undefined : await forms.record(raceId);
    const race = raceRecord?.type === 'RACE' ? parseRaceCombat(raceRecord) : undefined;
    const attackRaceRecord =
      race?.attackRace === undefined ? undefined : await forms.record(race.attackRace);
    const raceAttacks =
      attackRaceRecord?.type === 'RACE'
        ? parseRaceCombat(attackRaceRecord).attacks
        : (race?.attacks ?? []);
    const info = fighter.player ? undefined : await runtime.actors.info(reference);
    const npcRecord = info === undefined ? undefined : await forms.record(info.leveled);
    const own = npcRecord?.type === 'NPC_' ? parseNpcCombat(npcRecord).attacks : [];
    const loadout = await equipment.of(reference);
    const spell = async (form: number | undefined): Promise<boolean> => {
      const type = form === undefined ? undefined : (await forms.record(form))?.type;
      return type === 'SPEL' || type === 'SCRL';
    };
    const [rightSpell, leftSpell] = await Promise.all([spell(loadout.right), spell(loadout.left)]);
    return {
      right,
      left,
      rightRecord,
      leftRecord,
      shield,
      shieldRating: shieldItem?.armor?.rating ?? 0,
      projectile: projectileRecord?.type === 'PROJ' ? parseProjectile(projectileRecord) : undefined,
      ammoModel: right.ammo === undefined ? undefined : ammo?.model,
      ammoNode: ammoNode(ammo?.flags ?? AmmoFlag.nonBolt),
      attacks: new AttackSet(raceAttacks, own),
      race: raceRecord?.type === 'RACE' ? parseRaceHits(raceRecord) : undefined,
      torch,
      spells: { right: rightSpell, left: leftSpell },
    };
  }

  /**
   * The variables the engine sets on an actor's graphs for what it holds (CommonLibSSE's
   * graph channels): iRightHandType, iLeftHandType (GetEquippedItemType's codes),
   * iRightHandEquipped, iLeftHandEquipped, weaponSpeedMult, leftWeaponSpeedMult.
   */
  #graphVariables(fighter: Fighter, gear: Gear): void {
    // A spell (or a scroll) in a hand is its own type (9): the magic graph's manual selectors
    // pick the casting clips by it (MRh_ChargeLoop and the rest; other types play NullClips).
    const type = (stats: WeaponStats, shield: boolean, spell: boolean): number =>
      stats.weapon !== undefined
        ? stats.weaponType === WeaponType.crossbow
          ? EquippedItemType.crossbow
          : stats.weaponType
        : shield
          ? EquippedItemType.shield
          : spell
            ? EquippedItemType.spell
            : EquippedItemType.handToHand;
    const right = type(gear.right, false, gear.spells.right);
    const twoHanded =
      gear.right.weaponType >= WeaponType.twoHandSword &&
      gear.right.weaponType !== WeaponType.staff;
    // A torch in the left hand: its type (11), which the graphs hold up in the hand.
    const left = twoHanded
      ? right
      : gear.torch && gear.left.weapon === undefined && gear.shield === undefined
        ? EquippedItemType.torch
        : type(gear.left, gear.shield !== undefined, gear.spells.left);
    this.#setVariable(fighter, 'iRightHandType', right);
    this.#setVariable(fighter, 'iLeftHandType', left);
    fighter.handTypes = { right, left };
    this.#handsEquipped(fighter);
    this.#setVariable(fighter, 'weaponSpeedMult', gear.right.speed);
    this.#setVariable(fighter, 'leftWeaponSpeedMult', gear.left.speed);
    // The left hand's override (0_master's MT_LeftHandOverride) changes on the engine's equip
    // events, the names its transitions take: torchEquip, ShdEquip; torchUnequip and
    // WeapSoloEquip as a torch or a shield goes. Sent once a body for what it holds.
    // TODO(M13): when the engine sends them (here as the hands are read).
    const kind =
      left === EquippedItemType.torch ? 'torch' : gear.shield !== undefined ? 'shield' : 'other';
    const sent = fighter.leftHand;
    const before = sent && sent.body === fighter.body ? sent.kind : undefined;
    if (before !== kind) {
      const event =
        kind === 'torch'
          ? 'torchEquip'
          : kind === 'shield'
            ? 'ShdEquip'
            : before === 'torch'
              ? 'torchUnequip'
              : before === 'shield'
                ? 'WeapSoloEquip'
                : undefined;
      if (event) for (const graph of this.#graphs(fighter)) graph.sendEvent(event);
      fighter.leftHand = { body: fighter.body, kind };
    }
  }

  /**
   * iRightHandEquipped and iLeftHandEquipped (observed in the original): not flags but the
   * hands' GetEquippedItemType codes while the weapons are out, 0 while sheathed; the engine sets
   * them as the drawn weapon reaches the hand (the weaponDraw annotation's handler) and back to 0
   * as it is sheathed. The graphs' manual selectors index by them: the sprint's sides (a bow's,
   * a torch's, a shield's run), the jumps and shouts with a crossbow, the rider's staggers.
   */
  #handsEquipped(fighter: Fighter): void {
    const types = fighter.handTypes;
    this.#setVariable(fighter, 'iRightHandEquipped', fighter.inHand ? (types?.right ?? 0) : 0);
    this.#setVariable(fighter, 'iLeftHandEquipped', fighter.inHand ? (types?.left ?? 0) : 0);
  }

  /** Its weapons' models on its body (made again for another body or other weapons). */
  async #makeModels(fighter: Fighter, gear: Gear): Promise<void> {
    const body = fighter.body;
    if (!body) return;
    const held: HeldModels = {
      ...(gear.right.model !== undefined && {
        right: {
          model: gear.right.model,
          sheathed: gear.right.nodes.sheathed,
          drawn: gear.right.nodes.drawn,
        },
      }),
      ...(gear.left.model !== undefined && { left: { model: gear.left.model } }),
      ...(gear.ammoModel !== undefined && {
        ammo: gear.ammoModel,
        ammoNode: gear.ammoNode ?? null,
      }),
      ...(gear.torch?.model !== undefined && { torch: gear.torch.model }),
    };
    const key = `${String(gear.right.weapon)}:${String(gear.left.weapon)}:${String(gear.ammoModel)}:${String(gear.torch?.model)}`;
    if (fighter.heldFor === key && fighter.held) return;
    const placement = fighter.player ? this.#avatar?.placement : body.instances[0];
    const visibility = fighter.player
      ? this.#playerVisibility
      : this.#options.get(fighter.reference)?.visibility;
    if (!placement?.motion || !visibility) return;
    const blood = this.#blood(fighter, key);
    const made = await HeldWeapons.create(
      this.#options.session,
      this.#options.renderer,
      { pose: body.pose, world: placement.world, motion: placement.motion, visibility },
      held,
      blood,
      fighter.reference,
    );
    if (fighter.body !== body) {
      made?.destroy();
      return;
    }
    this.#weaponVariables(made, gear);
    fighter.held?.destroy();
    fighter.held = made;
    fighter.heldFor = key;
    if (fighter.player) await this.#makeFirstPersonModels(fighter, gear, key);
  }

  /** Its weapons' blood for the weapons `key` names (new weapons come clean). */
  #blood(fighter: Fighter, key: string): { right: WeaponBlood; left: WeaponBlood } {
    if (fighter.blood?.for !== key) {
      fighter.blood = {
        right: new WeaponBlood(this.#settings),
        left: new WeaponBlood(this.#settings),
        for: key,
      };
    }
    return fighter.blood;
  }

  /** The variables the engine set on the wielder's graphs, on its weapon's graph as it starts. */
  #weaponVariables(made: HeldWeapons | undefined, gear: Gear): void {
    made?.setVariable('weaponSpeedMult', gear.right.speed);
  }

  /**
   * The player's weapons in first person: each weapon's first-person model (WEAP WNAM, a STAT's
   * model) in the first-person arms' hands, the ammunition's with the bow; shown while the
   * arms are (src/shell/first-person-body.ts).
   */
  async #makeFirstPersonModels(fighter: Fighter, gear: Gear, key: string): Promise<void> {
    const arms = this.#avatar?.firstPersonBody;
    const runtime = this.#options.session.scriptsReady;
    if (!arms || !runtime) return;
    const model = async (stat: number | undefined): Promise<string | undefined> => {
      const record = stat === undefined ? undefined : await runtime.forms.record(stat);
      return record?.type === 'STAT' ? record.fields.zstring('MODL') : undefined;
    };
    const [right, left] = await Promise.all([
      model(gear.right.firstPersonModel),
      model(gear.left.firstPersonModel),
    ]);
    // A weapon without a first-person model (the bound bow) shows its world model.
    const rightModel = right ?? gear.right.model;
    const leftModel = left ?? gear.left.model;
    const held: HeldModels = {
      ...(rightModel !== undefined && {
        right: { model: rightModel, sheathed: undefined, drawn: gear.right.nodes.drawn },
      }),
      ...(leftModel !== undefined && { left: { model: leftModel } }),
      ...(gear.ammoModel !== undefined && {
        ammo: gear.ammoModel,
        ammoNode: gear.ammoNode ?? null,
      }),
      ...(gear.torch?.model !== undefined && { torch: gear.torch.model }),
    };
    const made = await HeldWeapons.create(
      this.#options.session,
      this.#options.renderer,
      {
        // The arms' pose as it is now (dressed anew, they take another).
        get pose() {
          return arms.pose;
        },
        world: arms.world,
        motion: arms.motion,
        visibility: this.#firstPersonVisibility,
      },
      held,
      // The same weapons' blood as in third person.
      this.#blood(fighter, key),
      fighter.reference,
    );
    if (fighter.heldFor !== key || this.#avatar?.firstPersonBody !== arms) {
      made?.destroy();
      return;
    }
    this.#weaponVariables(made, gear);
    fighter.firstHeld?.destroy();
    fighter.firstHeld = made;
  }

  /** One frame of a fighter: its models, its graph's flags, bleeding out, its AI. */
  #update(fighter: Fighter, seconds: number, runtime: ScriptRuntime): void {
    const state = fighter.state;
    // Knocked down or getting up it does not act (canAct).
    state.knock = this.#options.knockdowns?.()?.state(fighter.reference) ?? KnockState.normal;
    fighter.held?.update(fighter.inHand, state.arrowNocked, seconds);
    fighter.firstHeld?.update(fighter.inHand, state.arrowNocked, seconds);
    // Its weapons' blood dries.
    fighter.blood?.right.advance(seconds);
    fighter.blood?.left.advance(seconds);
    if (state.current?.ranged === true && state.arrowNocked) state.drawnFor += seconds;
    this.#combatLook(fighter);
    this.#aimBow(fighter);
    this.#followMark(fighter);
    // A synchronized scene lasts as long as its clips (observed in the original: an actor
    // is in a paired animation while it is in its scene): out of its paired clip, it is in its
    // pair no more, whether or not its graph said so (a bear killmove's leader raises no PairEnd).
    const synced = fighter.body?.behavior?.synchronizedClip() !== undefined;
    if (state.paired !== undefined && synced) fighter.synced = true;
    else if (state.paired !== undefined && fighter.synced) {
      fighter.synced = false;
      for (const effect of graphEvent(state, 'PairEnd')) this.#effect(fighter, effect);
    } else if (state.paired === undefined) fighter.synced = false;
    // The engine's killmove timer (observed in the original): fKillMoveMaxDuration after it began, an
    // actor is in its killmove no more (IsInKillMove). A paired animation that never says it
    // ended lets go then too.
    fighter.pairedFor =
      state.paired === undefined && !state.killMove ? 0 : fighter.pairedFor + seconds;
    if (fighter.pairedFor > this.#settings.killMoveMaxDuration) {
      fighter.pairedFor = 0;
      state.killMove = false;
      if (state.paired !== undefined) {
        state.paired = undefined;
        for (const graph of this.#graphs(fighter)) graph.pairedSide = undefined;
      }
    }
    if (bleedingOut(state)) {
      fighter.down += seconds;
      // The seconds since its last regain (frames while one was under way included).
      fighter.unbled += seconds;
      if (!fighter.bleeding) {
        fighter.bleeding = true;
        const since = fighter.unbled;
        fighter.unbled = 0;
        void this.#bleed(fighter, since, runtime).finally(() => {
          fighter.bleeding = false;
        });
      }
    }
  }

  /** Bleeding out: health regained, up again once recovered (ActionBleedoutStop). */
  async #bleed(fighter: Fighter, seconds: number, runtime: ScriptRuntime): Promise<void> {
    const actors = runtime.actors;
    const value = await actors.value(fighter.reference, ActorValue.health);
    let now = bleedoutRegain(value.current, value.max, seconds, this.#settings);
    // What it regains as its perks make it (Mod Recovered Health; no vanilla perk has one).
    if (now > value.current) {
      const regained = await runtime.perks.apply(
        EntryPoint.modRecoveredHealth,
        fighter.reference,
        now - value.current,
      );
      now = value.current + Math.max(0, regained);
      actors.restore(fighter.reference, ActorValue.health, now - value.current);
    }
    const noRecovery = runtime.state.actors.get(fighter.reference)?.noBleedoutRecovery === true;
    if (
      bleedingOut(fighter.state) &&
      bleedoutRecovered(
        { health: now, max: value.max, down: fighter.down, noRecovery },
        this.#settings,
      )
    ) {
      fighter.state.life = LifeState.alive;
      fighter.down = 0;
      await this.#act(fighter, 'ActionBleedoutStop');
    }
  }

  /** ShouldAttackKill (see attackKills). */
  async #attackKills(fighter: Fighter, victim: Fighter): Promise<boolean> {
    const gear = fighter.gear;
    if (!gear) return false;
    const current = fighter.state.current;
    const mult = current ? this.#attackData(fighter, current.event).damageMult : 1;
    return this.#predictedKill(fighter, victim, gear.right.damage * mult);
  }

  /**
   * The engine's predicted hit: whether a blow of some physical damage kills the victim now
   * (through its armour and the difficulty, no critical, no sneak attack), which it can.
   */
  async #predictedKill(fighter: Fighter, victim: Fighter, physical: number): Promise<boolean> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return false;
    const target = victim.reference;
    if (victim.state.life === LifeState.dead || (await runtime.actors.isDead(target))) return false;
    // Who cannot be killed (one raised from the dead always can).
    if (victim.state.life !== LifeState.reanimate) {
      if ((await runtime.actors.isEssential(target)) || (await runtime.actors.isChild(target))) {
        return false;
      }
      if (!fighter.player && (await runtime.actors.isProtected(target))) return false;
    }
    const health = (await runtime.actors.value(target, ActorValue.health)).current;
    let armor = this.#estimatedArmor.get(target);
    if (!armor || this.#clock - armor.at > ESTIMATED_ARMOR_SECONDS) {
      armor = {
        reduction: (await runtime.equipment.armorRating(target)).reduction,
        at: this.#clock,
      };
      this.#estimatedArmor.set(target, armor);
    }
    const damage = hitDamage(
      {
        physical,
        critical: 0,
        sneakMult: 1,
        armorReduction: armor.reduction,
        blocked: 0,
        difficulty: this.#difficulty(),
        attackerIsPlayer: fighter.player,
        targetIsPlayer: victim.player,
      },
      this.#settings,
    );
    return damage.total >= health;
  }

  // --- Graph events -----------------------------------------------------------------------------

  /**
   * An event of a fighter's graph (the stage's dispatch, src/shell/actor-graph-events.ts), with
   * the engine handler class the response files give it (undefined: one they name none for,
   * the fighter's own: WeapEquip_Out, blockStop). The player's first-person graph's count in
   * first person.
   */
  graphEvent(source: ActorGraphSource, event: GraphEvent, handler: string | undefined): void {
    const fighter = this.#fighters.get(source.reference);
    if (!fighter) return;
    if (source.firstPerson) {
      if (!fighter.player || this.#play?.player.pov !== 'first') return;
    } else if (fighter.body !== source.skeleton) return;
    this.#event(fighter, event, handler, source.firstPerson);
  }

  /** The events a fighter's graph raised reach its weapons' own graphs (a bow's). */
  heard(source: ActorGraphSource, events: readonly GraphEvent[]): void {
    const fighter = this.#fighters.get(source.reference);
    if (!fighter) return;
    if (source.firstPerson) fighter.firstHeld?.hear(events);
    else if (fighter.body === source.skeleton) fighter.held?.hear(events);
  }

  /** Who leads the paired animation an actor dies in (its killmove's killer), if anyone. */
  killerOf(reference: number): number | undefined {
    const killer = this.#fighters.get(reference)?.killer;
    if (killer !== undefined) return killer;
    for (const other of this.#fighters.values()) {
      if (other.state.paired === 'lead' && other.target === reference) return other.reference;
    }
    return undefined;
  }

  /** The one a fighter's killmove is done to (its partner in it), if any. */
  #victimOf(leader: Fighter): Fighter | undefined {
    for (const other of this.#fighters.values()) {
      if (other.state.paired === 'support' && other.killer === leader.reference) return other;
    }
    const target = leader.target === undefined ? undefined : this.#fighters.get(leader.target);
    return target?.state.paired === 'support' ? target : undefined;
  }

  #event(
    fighter: Fighter,
    event: GraphEvent,
    handler: string | undefined,
    firstPerson: boolean,
  ): void {
    // In first person the player's strikes follow the first-person graph; the body's graph
    // still moves the models.
    const strikes = !fighter.player || (this.#play?.player.pov === 'first') === firstPerson;
    const answer = handler?.toLowerCase();
    // Only the striking graph's release lets the arrow go: the other's (raised first, some
    // frames) would take the nocked arrow and the shot with it.
    const released = answer === 'arrowreleasehandler';
    const effects = !strikes && released ? [] : graphEvent(fighter.state, event.name, handler);
    for (const effect of effects) {
      if (!strikes && (effect.kind === 'strike' || effect.kind === 'arrow-release')) continue;
      this.#effect(fighter, effect);
    }
    const lower = answer === undefined ? event.name.toLowerCase() : undefined;
    // A creature's graph (the wolf's: combatStanceStart raises weaponDraw) has no equip clip
    // that ends with WeapEquip_Out: its weapon (its teeth and claws) is drawn at weaponDraw,
    // also unasked (the werewolf's graph starts in its combat stance once it has changed).
    if (
      answer === 'righthandweapondrawhandler' &&
      (fighter.state.weapon === WeaponState.drawing ||
        fighter.state.weapon === WeaponState.wantToDraw ||
        fighter.state.weapon === WeaponState.sheathed) &&
      !(fighter.body?.behavior?.declares('WeapEquip_Out') ?? true)
    ) {
      fighter.state.weapon = WeaponState.drawn;
      this.#setVariable(fighter, 'IsEquipping', 0);
    }
    if (lower === 'weapequip_out') this.#setVariable(fighter, 'IsEquipping', 0);
    // The player aiming a drawn bow (in its iron sights): those near may comment (PIRN,
    // PlayerinIronSights), once a draw (the graph whose strikes count).
    if (fighter.player && strikes && answer === 'bowdrawnhandler')
      void this.#options.talk?.()?.playerAction('PIRN');
    // So is its sheathing at weaponSheathe (no Unequip_Out follows).
    if (
      answer === 'righthandweaponsheathehandler' &&
      (fighter.state.weapon === WeaponState.sheathing ||
        fighter.state.weapon === WeaponState.wantToSheathe) &&
      !(fighter.body?.behavior?.declares('Unequip_Out') ?? true)
    ) {
      fighter.state.weapon = WeaponState.sheathed;
      this.#setVariable(fighter, 'IsUnequipping', 0);
    }
    if (lower === 'unequip_out') this.#setVariable(fighter, 'IsUnequipping', 0);
    // The vampire lord: its change ends lifting the player off (the graph's
    // LevitatePlayerStart), and up in the air its hands hold their spells at once.
    if (fighter.player && lower === 'levitateplayerstart') this.toggleLevitation(PLAYER_REF);
    if (lower === 'levitatestart' && fighter.state.weapon === WeaponState.sheathed)
      void this.draw(fighter.reference);
    // Landing, its hands let go of their spells: on the ground it stands out of combat.
    if (lower === 'landstart') {
      fighter.state.weapon = WeaponState.sheathed;
      fighter.state.attack = AttackState.none;
      fighter.state.current = undefined;
    }
    if (answer === 'attackstophandler') {
      this.#setVariable(fighter, 'IsAttacking', 0);
      this.#setVariable(fighter, 'IsBashing', 0);
    }
  }

  #effect(fighter: Fighter, effect: CombatEffect): void {
    const gear = fighter.gear;
    switch (effect.kind) {
      // The draw's and sheathing's sounds go as the graph begins them (BeginWeaponDraw,
      // BeginWeaponSheathe); graphs whose draw raises neither (an NPC's WeapEquip, creatures')
      // sound them as the weapon reaches the hand or the sheath. TODO(M13): where the engine
      // plays them for draws without the begin events is inferred.
      case 'draw-begin':
        this.#playSound(gear?.rightRecord?.sounds.equip, fighter);
        fighter.drawSounded = true;
        break;
      case 'sheathe-begin':
        this.#playSound(gear?.rightRecord?.sounds.unequip, fighter);
        fighter.drawSounded = true;
        break;
      case 'hand':
        fighter.inHand = true;
        this.#handsEquipped(fighter);
        if (!fighter.drawSounded) this.#playSound(gear?.rightRecord?.sounds.equip, fighter);
        fighter.drawSounded = false;
        break;
      case 'sheath':
        fighter.inHand = false;
        this.#handsEquipped(fighter);
        if (!fighter.drawSounded) this.#playSound(gear?.rightRecord?.sounds.unequip, fighter);
        fighter.drawSounded = false;
        break;
      case 'swing': {
        const left = effect.hand === 'left';
        const record = left ? gear?.leftRecord : gear?.rightRecord;
        this.#playSound(record?.sounds.swing, fighter);
        // The swing is heard (its weapon's sound level, VNAM) and, the player's, commented on.
        this.#options.senses?.()?.action(fighter.reference, record?.soundLevel ?? 1);
        if (fighter.player) void this.#options.talk?.()?.playerAction('SWMW');
        // The journal's Favorite Weapon counts the player's swings (usage-stats.ts).
        const hand = left ? gear?.left : gear?.right;
        this.#options.session.scriptsReady?.usage.weaponUsed(fighter.reference, hand?.weapon);
        void this.#swingSpell(fighter).catch((error: unknown) => {
          this.#warn(`a swing's spell: ${describe(error)}`);
        });
        break;
      }
      case 'strike':
        void this.#strike(fighter).catch((error: unknown) => {
          this.#warn(`a strike: ${describe(error)}`);
        });
        break;
      // Its Archery is read as each arrow is nocked (the shot strays by it as it is loosed).
      case 'arrow-attach':
        this.#readArchery(fighter);
        break;
      case 'arrow-release':
        this.#loose(fighter);
        break;
      case 'kill-actor':
        void this.#options.session.scriptsReady?.actors.kill(
          fighter.reference,
          this.killerOf(fighter.reference),
        );
        break;
      case 'killmove-end':
        void this.#endKillMove(fighter).catch((error: unknown) => {
          this.#warn(`a killmove's end: ${describe(error)}`);
        });
        break;
      case 'decapitate':
        this.#options.decapitate?.(fighter.reference);
        break;
      case 'pair-end':
        for (const graph of this.#graphs(fighter)) graph.pairedSide = undefined;
        if (this.#camera) this.#camera.done = true;
        break;
      default:
        break;
    }
  }

  // --- Strikes and hits -------------------------------------------------------------------------

  /** A melee strike lands (HitFrame): the nearest within reach and angle is hit, or a wall. */
  async #strike(fighter: Fighter): Promise<void> {
    const current = fighter.state.current;
    const feet = this.#feet(fighter);
    // A killmove's hit frames strike its victim, wherever the clip has it.
    if (fighter.state.paired === 'lead' && (current?.killMove ?? fighter.state.killMove)) {
      await this.#killMoveStrike(fighter);
      return;
    }
    if (!current || !feet) return;
    const data = this.#attackData(fighter, current.event);
    const strike = {
      origin: feet,
      heading: this.#heading(fighter),
      height: this.#size(fighter).height,
      reach: this.#reach(fighter, current.bash),
      attackAngle: data.attackAngle,
      strikeAngle: data.strikeAngle,
    };
    const kind: AttackKind = {
      power: current.power,
      bash: current.bash,
      sneak: false,
      ranged: false,
    };
    const targets: StrikeTarget[] = [];
    for (const other of this.#fighters.values()) {
      if (other === fighter || current.struck.has(other.reference)) continue;
      if (other.state.life === LifeState.dead || other.state.paired === 'support') continue;
      const at = this.#feet(other);
      if (!at) continue;
      targets.push({ reference: other.reference, feet: at, ...this.#size(other) });
    }
    // Sweep: a power attack hits everything in its arc (Set Sweep Attack).
    const sweeps = await this.#options.session.scriptsReady?.perks.apply(
      EntryPoint.setSweepAttack,
      fighter.reference,
      0,
      [this.#heldWeapon(fighter)],
      { attackType: data.attackType },
    );
    const contacts = strikeTargets(strike, targets, (sweeps ?? 0) !== 0);
    const physics = this.#play?.physics;
    const chest: Vec3 = [feet[0], feet[1], feet[2] + strike.height * CHEST];
    if (contacts.length === 0) {
      // Nothing to hit: a wall in reach before it recoils it.
      const forward: Vec3 = [Math.sin(strike.heading), Math.cos(strike.heading), 0];
      const wall = physics?.queriesCurrent
        ? physics.raycast(chest, forward, strike.reach, Layer.weapon)
        : undefined;
      if (wall && wall.owner?.kind !== 'actor') {
        const recoil = recoilOf(current, 'wall', undefined, this.#settings);
        if (recoil !== 'none')
          void this.#act(fighter, recoil === 'large' ? 'ActionRecoilLarge' : 'ActionRecoil');
        if (recoil !== 'none') fighter.state.recoiling = true;
        const set = current.hand === 'left' ? fighter.gear?.leftRecord : fighter.gear?.rightRecord;
        void this.#impacts.hit(
          {
            impactDataSet: set?.impactDataSet ?? fighter.gear?.race?.impactDataSet,
            materialId: wall.material,
            position: wall.point,
            direction: forward,
            heavy: current.power,
          },
          physics,
        );
        // A destructible object takes the blow (destruction-engine.ts): the weapon's damage.
        const struck = wall.owner?.kind === 'object' ? wall.owner.reference : 0;
        if (struck !== 0)
          void this.#objectHit(fighter, struck, data.damageMult).catch((error: unknown) => {
            this.#warn(`a blow on an object: ${describe(error)}`);
          });
      }
      return;
    }
    for (const contact of contacts) {
      current.struck.add(contact.target.reference);
      const at = contact.target.feet;
      const point: Vec3 = [at[0], at[1], at[2] + contact.target.height * CHEST];
      const way: Vec3 = [point[0] - chest[0], point[1] - chest[1], point[2] - chest[2]];
      const length = Math.hypot(...way) || 1;
      await this.#hit(fighter.reference, contact.target.reference, {
        ...kind,
        point,
        direction: [way[0] / length, way[1] / length, way[2] / length],
        shot: undefined,
      });
    }
  }

  /**
   * A strike meets an object: a destructible one takes the weapon's damage (as the equip system
   * reckons it, × the attack's), fists the unarmed damage; external damage (destruction-engine.ts).
   */
  async #objectHit(fighter: Fighter, reference: number, mult: number): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return;
    const stats = fighter.state.current?.hand === 'left' ? fighter.gear?.left : fighter.gear?.right;
    const damage =
      stats?.weapon === undefined
        ? (stats?.damage ?? 0)
        : await runtime.equipment.weaponDamage(fighter.reference, stats.weapon);
    // The hub tells the hit (TESHitEvent: the object's OnHit).
    const current = fighter.state.current;
    runtime.events.emit('hit', {
      target: reference,
      aggressor: fighter.reference,
      source: stats?.weapon,
      projectile: undefined,
      powerAttack: current?.power === true,
      sneakAttack: false,
      bashAttack: current?.bash === true,
      blocked: false,
    });
    await runtime.destruction.damage(reference, damage * mult, {
      external: true,
      source: fighter.reference,
    });
  }

  /**
   * A hit of an attacker on a target (a strike, a shot): its damage, the block, stagger or
   * recoil, its impact, the target's scripts told, the skills used, its health taken.
   */
  async #hit(
    attackerRef: number,
    targetRef: number,
    hit: AttackKind & {
      readonly point: Vec3;
      readonly direction: Vec3;
      readonly shot: ShotPayload | undefined;
    },
  ): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    const attacker = this.#fighters.get(attackerRef);
    const target = this.#fighters.get(targetRef);
    if (!runtime || !attacker || !target) return;
    if (target.state.life === LifeState.dead) return;
    const settings = this.#settings;
    const perks = runtime.perks;
    const gear = attacker.gear;
    const current = attacker.state.current;
    const left = current?.hand === 'left';
    const stats = left ? gear?.left : gear?.right;
    const record = left ? gear?.leftRecord : gear?.rightRecord;
    const data = hit.shot
      ? DEFAULT_ATTACK
      : current
        ? this.#attackData(attacker, current.event)
        : DEFAULT_ATTACK;
    // The physical damage: the weapon's (the equip system's, with skill and perks: Mod Attack
    // Damage against this target) × the attack's; a bash by the weapon's base damage or the
    // shield's rating × the Block skill (Mod Bashing Damage); a shot its bow's and arrow's × its
    // draw. Then the perks' Calculate Weapon Damage and, for a power attack, Mod Power Attack
    // Damage (the attack's type: IsAttackType).
    const weapon = hit.shot ? hit.shot.weapon : stats?.weapon;
    const context = { attackType: hit.shot ? undefined : data.attackType };
    const blockSkill = (await runtime.actors.value(attackerRef, ActorValue.firstSkill + 3)).current;
    let physical: number;
    if (hit.shot) {
      const shot = hit.shot;
      const ammoDamage =
        shot.ammo === undefined ? 0 : ((await runtime.equipment.item(shot.ammo))?.ammoDamage ?? 0);
      const damage =
        shot.weapon === undefined
          ? shot.damage
          : await runtime.equipment.weaponDamage(
              attackerRef,
              shot.weapon,
              ammoDamage,
              undefined,
              targetRef,
            );
      physical = damage * shot.power;
    } else if (hit.bash) {
      const shield = gear?.shield !== undefined && (stats?.weapon === undefined || left);
      const base = shield ? gear.shieldRating : (stats?.baseDamage ?? 0);
      physical = base * data.damageMult * bashFactor(blockSkill, shield, attacker.player, settings);
      physical = await perks.apply(EntryPoint.modBashingDamage, attackerRef, physical, [targetRef]);
    } else {
      const damage =
        stats?.weapon === undefined
          ? (stats?.damage ?? 0)
          : await runtime.equipment.weaponDamage(
              attackerRef,
              stats.weapon,
              0,
              undefined,
              targetRef,
            );
      physical = damage * data.damageMult;
    }
    if (!hit.bash) {
      physical = await perks.apply(
        EntryPoint.calculateWeaponDamage,
        attackerRef,
        physical,
        [weapon, targetRef],
        context,
      );
    }
    if (hit.power && !hit.bash) {
      physical = await perks.apply(
        EntryPoint.modPowerAttackDamage,
        attackerRef,
        physical,
        [weapon, targetRef],
        context,
      );
    }
    // A critical hit: the perks' chance (and the target's against it), the weapon's critical
    // damage (fists: × the setting) as the perks change it.
    const chance = criticalHitChance(
      await perks.apply(
        EntryPoint.calculateMyCriticalHitChance,
        attackerRef,
        0,
        [weapon, targetRef],
        context,
      ),
      stats?.critMult ?? 1,
      await perks.apply(EntryPoint.modEnemyCriticalHitChance, targetRef, 1, [weapon, attackerRef]),
    );
    const critical =
      chance > 0 && Math.random() < chance
        ? (await perks.apply(
            EntryPoint.calculateMyCriticalHitDamage,
            attackerRef,
            stats?.critDamage ?? 0,
            [weapon, targetRef],
            context,
          )) * (stats?.weapon === undefined ? settings.unarmedCritDamageMult : 1)
        : 0;
    attacker.lastCritical = critical > 0;
    // A sneak attack: the attacker sneaks and the target does not detect it (detection:
    // src/shell/actor-senses.ts; without it, one that does not fight the attacker).
    const sneaking = attacker.player
      ? this.#play?.player.sneaking === true
      : this.#options.movers.motion(attackerRef)?.sneaking === true;
    const senses = this.#options.senses?.();
    const aware = senses ? senses.detects(targetRef, attackerRef) : target.target === attackerRef;
    const sneak = sneaking && !aware && !hit.bash;
    const equipped =
      stats?.weaponType === WeaponType.crossbow
        ? EquippedItemType.crossbow
        : (stats?.weaponType ?? EquippedItemType.handToHand);
    // The perks multiply it (Mod Sneak Attack Mult: Backstab, Assassin's Blade, Deadly Aim).
    const sneakMult = sneak
      ? await perks.apply(
          EntryPoint.modSneakAttackMult,
          attackerRef,
          sneakAttackMult(equipped, settings),
          [weapon, targetRef],
          context,
        )
      : 1;
    // The block: the target blocks and faces the blow (fCombatHitConeAngle).
    const targetFeet = this.#feet(target) ?? hit.point;
    const attackerFeet = this.#feet(attacker) ?? hit.point;
    const blocks =
      target.state.blocking &&
      !hit.shot &&
      blockCovers(targetFeet, this.#heading(target), attackerFeet, settings.combatHitConeAngle);
    const targetGear = target.gear;
    const shielded = targetGear?.shield !== undefined;
    // An arrow at a raised shield may glance off (Mod Shield Deflect Arrow Chance, percent:
    // Deflect Arrows).
    if (
      hit.shot &&
      shielded &&
      target.state.blocking &&
      blockCovers(targetFeet, this.#heading(target), attackerFeet, settings.combatHitConeAngle)
    ) {
      const deflect = await perks.apply(EntryPoint.modShieldDeflectArrowChance, targetRef, 0);
      if (Math.random() * 100 < deflect) {
        void this.#act(target, 'ActionBlockHit');
        return;
      }
    }
    const targetBlockSkill = (await runtime.actors.value(targetRef, ActorValue.firstSkill + 3))
      .current;
    const blocked = blocks
      ? blockedShare(
          {
            shieldRating: shielded ? targetGear.shieldRating : undefined,
            attackerWeaponDamage: stats?.baseDamage ?? 0,
            blockSkill: targetBlockSkill,
            // The blocker's perks (Mod Percent Blocked: Shield Wall, Fortify Block).
            blockMult: await perks.apply(EntryPoint.modPercentBlocked, targetRef, 1),
            powerAttack: hit.power,
          },
          settings,
        )
      : 0;
    // The target's armour, as the attacker's perks pierce it (Mod Target Damage Resistance:
    // Bone Breaker, Skullcrusher), and what the target's perks take off the blow (Mod Incoming
    // Damage: Fortify Heavy / Light Armor while wearing it, Dragonhide, creatures' resistances).
    const armor = await runtime.equipment.armorRating(targetRef);
    const pierced = await perks.apply(
      EntryPoint.modTargetDamageResistance,
      attackerRef,
      armor.rating,
      [weapon, targetRef],
      context,
    );
    const reduction =
      pierced === armor.rating
        ? armor.reduction
        : await runtime.equipment.armorReduction(pierced, armor.pieces);
    const result = hitDamage(
      {
        physical,
        critical,
        sneakMult,
        armorReduction: reduction,
        blocked,
        incomingMult: await perks.apply(EntryPoint.modIncomingDamage, targetRef, 1, [
          attackerRef,
          weapon,
        ]),
        difficulty: this.#difficulty(),
        attackerIsPlayer: attacker.player,
        targetIsPlayer: target.player,
      },
      settings,
    );
    // Blocked: a plain attack recoils its attacker, the block takes the hit (ActionBlockHit),
    // a power attack staggers the blocker; the blocker's stamina pays for it.
    if (blocks) {
      void this.#act(target, 'ActionBlockHit');
      this.#bark(targetRef, 'Block', attackerRef);
      const recoil = recoilOf(
        hit,
        'block',
        shielded ? targetGear.shieldRating : undefined,
        settings,
      );
      if (recoil !== 'none') {
        attacker.state.recoiling = true;
        void this.#act(attacker, recoil === 'large' ? 'ActionRecoilLarge' : 'ActionRecoil');
      }
      const stagger = blockStagger(hit.power, result.blockedDamage, settings);
      if (stagger > 0) this.#stagger(target, stagger, attackerFeet);
      void runtime.progression
        .blockCost(result.blockedDamage)
        .then((cost) => runtime.progression.spend(targetRef, ActorValue.stamina, cost));
      // The Block skill: by the damage blocked (a shield's twice: UESP "Block").
      void runtime.progression.useSkill(
        targetRef,
        ActorValue.firstSkill + 3,
        result.blockedDamage * (shielded ? 2 : 1),
      );
    } else {
      const stagger = staggerMagnitude(
        {
          weaponStagger: hit.bash || stats?.weapon === undefined ? 1 : stats.stagger,
          attackStagger: hit.shot ? 0 : data.stagger,
          // The attacker's perks (Mod Target Stagger) and the target's (Mod Incoming Stagger).
          perkMult:
            (await perks.apply(EntryPoint.modTargetStagger, attackerRef, 1, [targetRef])) *
            (await perks.apply(EntryPoint.modIncomingStagger, targetRef, 1, [attackerRef])),
          targetMass: targetGear?.race?.mass ?? 1,
          targetIsPlayer: target.player,
        },
        settings,
      );
      if (stagger > 0) this.#stagger(target, stagger, attackerFeet);
      // An attack with a knockdown (ATKD: the beast forms' sprinting swipes, 1) knocks it down,
      // pushed as a killing blow of its damage pushes the dead (TODO(M13): the knockdown read
      // as a chance, the push as fDeathForce*).
      if (!hit.shot && data.knockdown > 0 && Math.random() < data.knockdown) {
        void this.knockDown(targetRef, attackerFeet, this.#pushForce(result.total, false));
      }
      // One lying knocked down: the blow pushes its ragdoll.
      this.#options
        .knockdowns?.()
        ?.push(
          targetRef,
          [hit.direction[0], hit.direction[1], hit.direction[2] + 0.25],
          this.#pushForce(result.total, hit.shot !== undefined),
        );
    }
    // Its impact: the weapon's impact data set (a bash or block: BIDS; fists: the race's)
    // against the target's flesh (its race's material).
    const impactSet =
      hit.bash || blocks
        ? (record?.blockBashImpactDataSet ?? record?.impactDataSet)
        : hit.shot
          ? hit.shot.impactDataSet
          : (record?.impactDataSet ?? gear?.race?.impactDataSet);
    void this.#impacts
      .hit(
        {
          impactDataSet: impactSet,
          ...(targetGear?.race?.material !== undefined && {
            materialForm: targetGear.race.material,
          }),
          position: hit.point,
          direction: hit.direction,
          heavy: hit.power,
        },
        this.#play?.physics,
      )
      .then(async (impact) => {
        // A weapon's blow that drew blood (its impact leaves a blood decal) bloodies the blade.
        if (!impact || hit.shot || hit.bash || blocks || stats?.weapon === undefined) return;
        if (!(await this.#impacts.bleeds(impact))) return;
        (left ? attacker.blood?.left : attacker.blood?.right)?.hit();
      })
      .catch((error: unknown) => {
        this.#warn(`a hit's impact: ${describe(error)}`);
      });
    // The skills: the weapon's by its base damage (UESP: experience follows the base damage
    // dealt), Sneak for a sneak attack (fSneakAttackSkillUsageMelee).
    const skill = hit.bash ? ActorValue.firstSkill + 3 : (stats?.skill ?? -1);
    if (skill >= 0 && !blocks) {
      void runtime.progression.useSkill(attackerRef, skill, stats?.baseDamage ?? 0);
    }
    if (sneak) void runtime.progression.useSkill(attackerRef, ActorValue.firstSkill + 9, 30);
    // The one hit uses the armour skills of what it wears (Light, Heavy Armor) by the blow's
    // damage before its armour (UESP "Skyrim:Light Armor": the incoming base damage), unblocked.
    if (!blocks && physical > 0) void this.#armourSkills(targetRef, physical);
    // The hub tells the hit (TESHitEvent: the target's OnHit with aggressor, source,
    // projectile, power, sneak, bash, blocked).
    runtime.events.emit('hit', {
      target: targetRef,
      aggressor: attackerRef,
      source: stats?.weapon,
      projectile: hit.shot?.projectile,
      powerAttack: hit.power,
      sneakAttack: sneak,
      bashAttack: hit.bash,
      blocked: blocks,
    });
    // It fights back, or lets a friend's blow pass (the combat AI: iFriendHitCombatAllowed);
    // a practice's blow without Allow Combat Start On Hit passes (no fight, search or crime).
    const passes = attacker.practice?.combatStartOnHit === false;
    if (!passes) this.#brain.hit(attackerRef, targetRef);
    if (attacker.player) this.#struck(targetRef);
    // Detection: the one attacked searches for its attacker; those near watch the fight.
    if (!passes) senses?.attackedBy(targetRef, attackerRef);
    // Crime: a blow on one that was not hostile to its attacker is an assault, reported by the
    // one hit and those who saw it (crime-engine.ts assault; the player's: TODO(M13) NPCs').
    if (!passes) void runtime.crime.assault(attackerRef, targetRef);
    // The weapon's enchantment and the poison on it (not a bash: the magic system); a diseased
    // creature's attack (its attack data's spell) may pass its disease on.
    if (!hit.bash && !blocks) await runtime.magic.weaponHit(attackerRef, targetRef, stats?.weapon);
    if (!hit.shot && !blocks && data.spell !== undefined) {
      await runtime.magic.contractDisease(targetRef, data.spell);
    }
    // The perks' spells on the one hit: a hit's (Apply Combat Hit Spell: Paralyzing Strike,
    // the creatures' poisons), a bash's (Apply Bashing Spell: Disarming Bash).
    if (!blocks) {
      const spell = hit.bash
        ? await perks.selectSpell(EntryPoint.applyBashingSpell, attackerRef, [targetRef], context)
        : await perks.selectSpell(
            EntryPoint.applyCombatHitSpell,
            attackerRef,
            [weapon, targetRef],
            context,
          );
      const item = spell === undefined ? undefined : await runtime.magic.item(spell);
      if (item) await runtime.magic.apply(item, targetRef, { caster: attackerRef, source: weapon });
    }
    // Its health; the killing blow pushes its ragdoll (fDeathForce*). The one hit says its
    // line (Hit); its death cry is the stage's (every death but a silent one: killed).
    // A practice with Do No Damage takes no health. Observed in the original: a blow on
    // one in a killmove does fCombatKillMoveDamageMult times its damage.
    if (result.total <= 0 || attacker.practice?.doNoDamage === true) return;
    const dealt = target.state.killMove
      ? result.total * this.#settings.killMoveDamageMult
      : result.total;
    await runtime.actors.damage(targetRef, ActorValue.health, dealt, attackerRef);
    if (await runtime.actors.isDead(targetRef)) {
      // One dying in its paired clip falls as the clip has it.
      if (target.state.paired === undefined) this.#deathPush(target, dealt, hit);
      if (weapon !== undefined && !hit.bash) await this.#siphonSoul(attackerRef, targetRef, weapon);
    } else if (!target.player) {
      this.#bark(targetRef, 'Hit', attackerRef);
    }
  }

  /**
   * An arrow that hits an actor may end up in its items (iArrowInventoryChance, percent, as the
   * shooter's perks change it: Mod Recover Arrow Chance, Hunter's Discipline).
   */
  async #arrowKept(shooter: number, target: number, ammo: number | undefined): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime || ammo === undefined) return;
    const chance = await runtime.perks.apply(
      EntryPoint.modRecoverArrowChance,
      shooter,
      this.#settings.arrowInventoryChance,
    );
    if (Math.random() * 100 < chance)
      await runtime.addItem(target, runtime.formHandle(ammo), 1, true);
  }

  /**
   * The behavior graph variables a fighter's perks set while their conditions hold (Set
   * Boolean Graph Variable: Quick Shot's bPerkQuickShot, Shield Charge's bPerkShieldCharge,
   * Quickdraw's bPerkQuickdraw), read again each PERK_VARIABLE_SECONDS: 1 while they hold, 0
   * once they no longer do.
   */
  #perkGraphVariables(fighter: Fighter, runtime: ScriptRuntime): void {
    const kept = this.#perkVariables.get(fighter.reference) ?? {
      at: -Infinity,
      names: new Set<string>(),
      reading: false,
    };
    this.#perkVariables.set(fighter.reference, kept);
    if (kept.reading || this.#clock - kept.at < PERK_VARIABLE_SECONDS) return;
    kept.reading = true;
    kept.at = this.#clock;
    void runtime.perks
      .texts(EntryPoint.setBooleanGraphVariable, fighter.reference)
      .then((names) => {
        const now = new Set(names);
        for (const name of kept.names) if (!now.has(name)) this.#setVariable(fighter, name, 0);
        for (const name of now) this.#setVariable(fighter, name, 1);
        kept.names = now;
      })
      .catch((error: unknown) => {
        this.#warn(`a perk's graph variable: ${describe(error)}`);
      })
      .finally(() => {
        kept.reading = false;
      });
  }

  /** The weapon in the hand that attacks now (the right's unless the left attacks). */
  #heldWeapon(fighter: Fighter): number | undefined {
    const left = fighter.state.current?.hand === 'left';
    return (left ? fighter.gear?.left : fighter.gear?.right)?.weapon;
  }

  /**
   * A killing blow with an enchanted weapon takes a share of the victim's soul into its charge
   * (Mod Soul Pct Captured to Weapon: Soul Siphon, creatures only by its conditions), the share
   * of the soul's charge (its size by the victim's level, SOUL_CAPACITY).
   */
  async #siphonSoul(attacker: number, victim: number, weapon: number): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return;
    const share = await runtime.perks.apply(EntryPoint.modSoulPctCapturedToWeapon, attacker, 0, [
      victim,
      weapon,
    ]);
    if (share <= 0) return;
    const charge = await runtime.crafting.charge(attacker, weapon);
    if (!charge || charge.max <= 0) return;
    const soul = SOUL_CAPACITY[soulSize(await runtime.actors.level(victim), false)] ?? 0;
    runtime.crafting.setCharge(
      attacker,
      weapon,
      Math.min(charge.max, charge.current + soul * share),
      charge.max,
    );
  }

  /**
   * An attacker swings at the one it fights: that one's perks may cast a spell on it (Apply
   * Weapon Swing Spell: Quick Reflexes slows time for a player blocking a power attack).
   */
  async #swingSpell(fighter: Fighter): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    const owner = fighter.target;
    if (!runtime || owner === undefined) return;
    const spell = await runtime.perks.selectSpell(EntryPoint.applyWeaponSwingSpell, owner, [
      fighter.reference,
      this.#heldWeapon(fighter),
    ]);
    const item = spell === undefined ? undefined : await runtime.magic.item(spell);
    if (item) await runtime.magic.apply(item, owner, { caster: owner });
  }

  /** A combat line (src/shell/actor-talk.ts bark): an actor's, by its topic subtype. */
  #bark(actor: number, subtype: string, target?: number, interrupt = false): void {
    if (actor === PLAYER_REF) return;
    const talk = this.#options.talk?.();
    if (!talk) return;
    talk.bark(actor, subtype, target ?? PLAYER_REF, { interrupt }).catch((error: unknown) => {
      this.#warn(`a combat line: ${describe(error)}`);
    });
  }

  /** The blow that killed pushes the ragdoll by its damage (fDeathForce{Ranged}*). */
  #deathPush(
    target: Fighter,
    damage: number,
    hit: { readonly direction: Vec3; readonly shot: ShotPayload | undefined },
  ): void {
    const staged = target.player
      ? this.#options.playerBody?.()
      : this.#options.get(target.reference);
    if (!staged) return;
    void this.#options.bodies.push(
      staged,
      hit.direction,
      this.#pushForce(damage, hit.shot !== undefined),
    );
  }

  /** The push a blow of some damage gives a ragdoll (fDeathForce{Ranged}Min..Max by damage). */
  #pushForce(damage: number, ranged: boolean): number {
    const s = this.#settings;
    const [dMin, dMax, fMin, fMax] = ranged
      ? [
          s.deathForceRangedDamageMin,
          s.deathForceRangedDamageMax,
          s.deathForceRangedForceMin,
          s.deathForceRangedForceMax,
        ]
      : [s.deathForceDamageMin, s.deathForceDamageMax, s.deathForceForceMin, s.deathForceForceMax];
    const t = Math.min(1, Math.max(0, (damage - dMin) / Math.max(1e-6, dMax - dMin)));
    return fMin + (fMax - fMin) * t;
  }

  /** A hit's armour skills: each skill of the armour worn (any piece of it) by the damage. */
  async #armourSkills(target: number, damage: number): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return;
    const skills = new Set<number>();
    for (const form of await runtime.equipment.worn(target)) {
      const item = await runtime.equipment.item(form);
      const skill = item && armorSkill(item);
      if (skill !== undefined) skills.add(skill);
    }
    for (const skill of skills) await runtime.progression.useSkill(target, skill, damage);
  }

  /** Staggers a fighter by a magnitude from where the blow came (ActionStaggerStart). */
  #stagger(fighter: Fighter, magnitude: number, from: Vec3): void {
    const feet = this.#feet(fighter);
    if (!feet || fighter.state.paired !== undefined || bleedingOut(fighter.state)) return;
    this.#setVariable(fighter, 'staggerMagnitude', magnitude);
    this.#setVariable(
      fighter,
      'staggerDirection',
      hitDirection(feet, this.#heading(fighter), from),
    );
    void this.#act(fighter, 'ActionStaggerStart').then((event) => {
      if (event !== undefined && event !== '00NextClip') {
        fighter.state.staggered = true;
        fighter.state.current = undefined;
        fighter.state.attack = AttackState.none;
      }
    });
  }

  // --- Bows ---------------------------------------------------------------------------------------

  /**
   * Where its arrows leave from: its WEAPON node, the drawing hand (the player's first-person
   * arms' in first person), else before its chest.
   */
  #bowFrom(fighter: Fighter, feet: Vec3): Vec3 {
    let pose: { world(name: string): Float32Array | undefined } | undefined;
    let world: Float32Array | undefined;
    if (fighter.player) {
      const avatar = this.#avatar;
      const arms = avatar?.firstPersonBody;
      if (arms && this.#play?.bodyShown === false) {
        pose = arms.pose;
        world = arms.world;
      } else if (avatar) {
        pose = avatar.body.pose;
        world = avatar.placement.world;
      }
    } else {
      pose = fighter.body?.pose;
      world = fighter.body?.instances[0]?.world;
    }
    const node = pose?.world('WEAPON');
    if (node && world) return transformPoint(world, [node[12] ?? 0, node[13] ?? 0, node[14] ?? 0]);
    const scale = this.#scale(fighter);
    return [feet[0], feet[1], feet[2] + BODY_HEIGHT * scale * CHEST + 10 * scale];
  }

  /**
   * Which way a shot goes from `from` (src/shell/projectile-aim.ts): the player's along the view
   * tilted up, turned by the aim assistance toward what the crosshair is on; an NPC's at its
   * target's upper body where it will be (a practice's point that is no fighter: an archery
   * butt), on the arrow's arc, then astray by fBowNPCSpreadAngle as far as its Archery lacks
   * (`stray`; Always Hit: none); else along its facing.
   */
  #bowAim(fighter: Fighter, from: Vec3, power: number, stray: boolean): Vec3 {
    const projectile = fighter.gear?.projectile;
    const shot: ShotKind = {
      speed: (projectile?.speed ?? 0) * Math.max(0.35, power),
      gravity: (projectile?.gravity ?? 0) * WORLD_GRAVITY,
      ammunition: fighter.gear?.right.weaponType === WeaponType.crossbow ? 'bolt' : 'arrow',
      uncorrected: ((projectile?.flags ?? 0) & ProjectileFlag.disableCombatAimCorrection) !== 0,
    };
    const aim = this.#options.aim?.();
    if (fighter.player && this.#play) {
      const aimed = aim?.player(from, shot);
      if (aimed) return aimed;
      const player = this.#play.player;
      return tiltUp(
        player.forward,
        player.pov === 'first' ? ARROW_TILT.firstPerson : ARROW_TILT.thirdPerson,
      );
    }
    const target = fighter.target === undefined ? undefined : this.#fighters.get(fighter.target);
    const feetThere = target && this.#feet(target);
    // A practice's target that is no fighter (an archery butt): its point.
    const aimAt = feetThere ? undefined : fighter.practice?.aimAt;
    const there = feetThere ?? aimAt;
    if (!there) {
      const heading = this.#heading(fighter);
      return [Math.sin(heading), Math.cos(heading), 0];
    }
    const aimed: AimTarget = {
      reference: target?.reference ?? 0,
      feet: there,
      height: target ? this.#size(target).height : 0,
      radius: 0,
    };
    if (!aim) {
      const way: Vec3 = [
        there[0] - from[0],
        there[1] - from[1],
        there[2] + aimed.height * CHEST - from[2],
      ];
      return tiltUp(way, ARROW_TILT.thirdPerson);
    }
    const direction = aim.npc(from, aimed, shot, stray ? 'bow' : 'none');
    if (!stray) return direction;
    const archery = this.#archery.get(fighter.reference) ?? 0;
    return directionOf(
      npcSpread(
        anglesOf(direction),
        archery,
        aim.settings.bowNpcSpreadAngle,
        Math.random(),
        Math.random(),
      ),
    );
  }

  /** An NPC's Archery (the third skill), read as it draws (its arrows stray by what it lacks). */
  #readArchery(fighter: Fighter): void {
    const runtime = this.#options.session.scriptsReady;
    if (fighter.player || !runtime) return;
    void runtime.actors.value(fighter.reference, ActorValue.firstSkill + 2).then((value) => {
      this.#archery.set(fighter.reference, value.current);
    });
  }

  /**
   * The aim the engine gives the graphs' BSDirectAtModifiers of bows (userInfo 2, as an aimed
   * spell's: src/shell/actor-casting.ts; observed in the original): an NPC's is where its
   * combat aim points, which here is where its shot would go (a point along it), whenever it
   * holds a bow or a crossbow out and has something to shoot at, so its spine has turned to it
   * by the time the arrow is nocked (the modifier eases on by its gain); the player's is the
   * point 4000 units along their view (their graph's direct-at is off, IsNPC 0, but a mounted
   * player's bow, horsebehavior's MC_BSDirectAtModifier_Bow, uses it). The modifier turns the
   * spine so that the WEAPON bone, where the nocked arrow lies, points at it.
   */
  #aimBow(fighter: Fighter): void {
    const gear = fighter.gear;
    const ranged =
      gear !== undefined &&
      (gear.right.weaponType === WeaponType.bow || gear.right.weaponType === WeaponType.crossbow);
    const feet = this.#feet(fighter);
    let point: Vec3 | undefined;
    if (fighter.player) {
      const player = this.#play?.player;
      if (player && feet) {
        const eye = player.eye;
        const look = player.forward;
        point = [
          eye[0] + look[0] * PLAYER_AIM_DISTANCE,
          eye[1] + look[1] * PLAYER_AIM_DISTANCE,
          eye[2] + look[2] * PLAYER_AIM_DISTANCE,
        ];
      }
    } else if (ranged && fighter.inHand && feet) {
      const shooting =
        (fighter.target !== undefined && this.#fighters.has(fighter.target)) ||
        fighter.practice?.aimAt !== undefined;
      if (shooting) {
        const from = this.#bowFrom(fighter, feet);
        const aim = this.#bowAim(fighter, from, 1, false);
        point = [
          from[0] + aim[0] * BOW_AIM_DISTANCE,
          from[1] + aim[1] * BOW_AIM_DISTANCE,
          from[2] + aim[2] * BOW_AIM_DISTANCE,
        ];
      }
    }
    if (!point) {
      if (fighter.bowAimed) {
        fighter.bowAimed = false;
        for (const graph of this.#graphs(fighter)) {
          for (const kind of AIM_KINDS) graph.setDirectAtTarget(kind, undefined);
        }
      }
      return;
    }
    fighter.bowAimed = true;
    for (const graph of this.#graphs(fighter)) {
      for (const kind of AIM_KINDS) graph.setDirectAtTarget(kind, point);
    }
  }

  /**
   * An NPC's combat target is its combat head track (HEAD_TRACK_TYPE combat): it looks at whom
   * it fights, and its graph's block anticipation turns toward that one's weapon
   * (src/shell/actor-looks.ts). A practice's target is none (its package's head track is).
   */
  #combatLook(fighter: Fighter): void {
    if (fighter.player) return;
    const target = this.#brain.engaged(fighter.reference) ? fighter.target : undefined;
    if (fighter.lookedAt === target) return;
    fighter.lookedAt = target;
    this.#options.session.scriptWorld.lookTargets.lookAt(fighter.reference, target, 'combat');
  }

  /** The arrow leaves the bow (arrowRelease): a shot along the aim, its damage by the draw. */
  #loose(fighter: Fighter): void {
    const gear = fighter.gear;
    const runtime = this.#options.session.scriptsReady;
    const feet = this.#feet(fighter);
    if (!gear?.projectile || gear.right.ammo === undefined || !runtime || !feet) return;
    // The journal's Favorite Weapon counts the player's shots (usage-stats.ts).
    runtime.usage.weaponUsed(fighter.reference, gear.right.weapon);
    const from = this.#bowFrom(fighter, feet);
    const power = bowDrawPower(fighter.state.drawnFor, gear.right.speed);
    // An NPC's shot strays (fBowNPCSpreadAngle by its Archery); Always Hit: none.
    const aim = this.#bowAim(fighter, from, power, fighter.practice?.alwaysHit !== true);
    const ammo = gear.right.ammo;
    const payload: ShotPayload = {
      attacker: fighter.reference,
      damage: gear.right.shotDamage,
      weapon: gear.right.weapon,
      ammo,
      power,
      impactDataSet: gear.rightRecord?.impactDataSet,
      projectile: gear.projectile.formId,
      kind: { power: false, bash: false, sneak: false, ranged: true },
    };
    // Always Hit: the shot flies onto its target's chest, wherever it runs.
    const target = fighter.practice?.alwaysHit === true ? fighter.target : undefined;
    const homing =
      target === undefined
        ? undefined
        : (): Vec3 | undefined => {
            const aimed = this.#fighters.get(target);
            if (!aimed) return undefined;
            const feet = this.#feet(aimed);
            return feet && [feet[0], feet[1], feet[2] + this.#size(aimed).height * CHEST];
          };
    const before = new Set([...this.#projectiles.flying()].map((shot) => shot.key));
    // The shot is in flight as soon as it is loosed (its model follows).
    void this.#projectiles.loose({
      shooter: fighter.reference,
      ammo,
      projectile: gear.projectile,
      from,
      aim,
      power: Math.max(0.35, power),
      payload,
      ...(homing && { homing }),
    });
    if (fighter.player) {
      const shot = [...this.#projectiles.flying()].find((flying) => !before.has(flying.key));
      this.#rangedKillCamera(fighter, from, aim, power, shot?.key).catch((error: unknown) => {
        this.#warn(`a shot's kill camera: ${describe(error)}`);
      });
    }
    this.#playSound(gear.rightRecord?.sounds.attack, fighter);
    // The player's shot with a bow (not a crossbow) is told with its draw and whether they look
    // into the sun (TESPlayerBowShotEvent: OnPlayerBowShot; observed in the original).
    if (
      fighter.player &&
      gear.right.weaponType === WeaponType.bow &&
      gear.right.weapon !== undefined
    )
      runtime.events.emit('playerBowShot', {
        weapon: gear.right.weapon,
        ammo,
        power,
        sunGazing: this.#options.session.scriptWorld.sunGazed(aim),
      });
    // The shot is heard; the player's commented on (ShootBow).
    this.#options.senses?.()?.action(fighter.reference, gear.rightRecord?.soundLevel ?? 1);
    if (fighter.player) void this.#options.talk?.()?.playerAction('FIWE');
    // An arrow used: the player's quiver empties (the equip system's count); an NPC with one
    // never runs out (UESP "Skyrim:Arrows": NPCs have unlimited arrows as long as they carry
    // one), so archers shoot on through a fight.
    if (fighter.player) {
      void runtime.removeItem(fighter.reference, runtime.formHandle(ammo), 1, true, undefined);
    }
    fighter.state.drawnFor = 0;
  }

  // --- Killmoves -------------------------------------------------------------------------------

  /**
   * A paired idle an actor plays on a target outside an attack (the vampire's feeding bite,
   * StartVampireFeed's IdleVampireFeed): the target plays its side, at the leader.
   */
  pairIdle(leader: number, target: number, event: string): void {
    const fighter = this.#fighters.get(leader);
    if (fighter) this.#pair(fighter, target, event);
  }

  /**
   * A paired idle played on a target (an attack action's "pa_" idle, a feeding bite): the
   * leader plays "pa_<name>", the target "<name>" (its graph's VictimBehavior), each its side of
   * the synchronized clip, the target at its mark before the leader (#toMark). Observed in the
   * original: an idle whose event begins "pa_Kill" starts a killmove. The leader's
   * attack state is drawing, both are in a killmove (IsInKillMove) until their KillMoveEnd or
   * fKillMoveMaxDuration, the victim's killer (myKiller) is the leader, and both have their
   * deaths deferred (StartDeferredKill: a blow that empties their health kills them as the
   * deferral ends, at KillMoveEnd). The victim dies at its KillActor or its KillMoveEnd, by its
   * killer. A killmove the player leads plays in the kill camera (#killCamera); one done to the
   * player turns the camera to third person.
   */
  #pair(leader: Fighter, victimRef: number, event: string): void {
    const victim = this.#fighters.get(victimRef);
    if (!victim || !this.#feet(leader)) return;
    const runtime = this.#options.session.scriptsReady;
    leader.state.paired = 'lead';
    victim.state.paired = 'support';
    const killMove = event.toLowerCase().startsWith('pa_kill');
    if (killMove) {
      for (const fighter of [leader, victim]) {
        fighter.state.killMove = true;
        fighter.pairedFor = 0;
        runtime?.actors.startDeferredKill(fighter.reference);
      }
      victim.killer = leader.reference;
      if (leader.state.current) leader.state.attack = AttackState.draw;
    }
    // Whatever the victim did ends.
    victim.state.current = undefined;
    victim.state.attack = AttackState.none;
    victim.state.blocking = false;
    // The leader plays the clip's first side, the victim its "2_" side (one skeleton both:
    // the side is theirs to set, src/animation/paired-clips.ts).
    for (const graph of this.#graphs(leader)) graph.pairedSide = 'first';
    for (const graph of this.#graphs(victim)) {
      graph.pairedSide = 'second';
      graph.sendEvent(event.slice(PAIRED_PREFIX.length));
    }
    victim.toMark = { leader: leader.reference, since: this.#clock, from: undefined };
    if (!victim.player) this.#options.movers.request(victimRef, undefined);
    if (killMove && leader.player) this.#killCamera(leader, victim);
    if (killMove && victim.player) this.#play?.player.setPov('third');
  }

  /**
   * The partner of a paired clip goes to its mark (observed in the original: the
   * synchronized clip's get-to-mark): where the clip puts it from its leader as it begins
   * (src/animation/paired-clips.ts partnerMark: a killmove's victim 72.8 units before a man,
   * 157 before a bear), turned as the clip turns it (bReorientSupportChar), over the clip's
   * fGetToMarkTime (the vanilla killmoves: at once, the vampire lord's feeding 0.05 s), unless the clip ignores its mark
   * (bSyncClipIgnoreMarkPlacement). Read as the clip begins to play; not there after
   * [Animation] fMaxTimeToMarkSec, the scene plays where they stand.
   */
  #followMark(fighter: Fighter): void {
    const mark = fighter.toMark;
    if (!mark) return;
    const leader = this.#fighters.get(mark.leader);
    const leaderFeet = leader && this.#feet(leader);
    if (!leader || !leaderFeet || fighter.state.paired !== 'support') {
      fighter.toMark = undefined;
      return;
    }
    const maxTime = this.#options.session.ini.number('Animation', 'fMaxTimeToMarkSec');
    if (this.#clock - mark.since > maxTime) {
      fighter.toMark = undefined;
      return;
    }
    // The synchronized clip its graph (else its leader's) plays now, once its clip is loaded.
    let sync: ReturnType<BehaviorRuntime['synchronizedClip']>;
    let binding: AnimationBinding | undefined;
    for (const graph of [...this.#graphs(fighter), ...this.#graphs(leader)]) {
      sync = graph.synchronizedClip();
      binding = sync?.binding;
      if (sync && binding) break;
    }
    if (!sync || !binding) return;
    const place = partnerMark(binding);
    if (!place || sync.ignoreMarkPlacement) {
      fighter.toMark = undefined;
      return;
    }
    const heading = this.#heading(leader);
    const [x, y, z] = place.offset;
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    const at: Vec3 = [
      leaderFeet[0] + x * cos + y * sin,
      leaderFeet[1] - x * sin + y * cos,
      leaderFeet[2] + z,
    ];
    // The yaw is counter-clockwise, the heading clockwise.
    const facing = sync.reorientSupport ? heading - place.yaw : this.#heading(fighter);
    const now = this.#feet(fighter) ?? at;
    mark.from ??= { position: now, heading: this.#heading(fighter), at: this.#clock };
    const share =
      sync.getToMarkTime > 0 ? Math.min(1, (this.#clock - mark.from.at) / sync.getToMarkTime) : 1;
    const from = mark.from.position;
    const position: Vec3 = [
      from[0] + (at[0] - from[0]) * share,
      from[1] + (at[1] - from[1]) * share,
      from[2] + (at[2] - from[2]) * share,
    ];
    const turned = mark.from.heading + turnBetween(mark.from.heading, facing) * share;
    if (fighter.player) {
      this.#play?.player.teleport(position, turned);
    } else {
      const staged = this.#options.get(fighter.reference);
      if (staged) {
        staged.position = position;
        staged.heading = turned;
        this.#options.movers.teleport(staged);
      }
    }
    if (share >= 1) fighter.toMark = undefined;
  }

  /** A killmove's end (KillMoveEnd): its victim dies by its killer, deaths deferred come. */
  async #endKillMove(fighter: Fighter): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return;
    fighter.state.killMove = false;
    const killer = fighter.killer;
    fighter.killer = undefined;
    if (killer !== undefined && !(await runtime.actors.isDead(fighter.reference))) {
      await runtime.actors.kill(fighter.reference, killer);
    }
    await runtime.actors.endDeferredKill(fighter.reference);
  }

  /** A killmove's hit frame: its victim takes the blow (#hit: × fCombatKillMoveDamageMult). */
  async #killMoveStrike(leader: Fighter): Promise<void> {
    const victim = this.#victimOf(leader);
    const from = this.#feet(leader);
    const at = victim && this.#feet(victim);
    if (!victim || !from || !at || victim.state.life === LifeState.dead) return;
    const chest: Vec3 = [from[0], from[1], from[2] + this.#size(leader).height * CHEST];
    const point: Vec3 = [at[0], at[1], at[2] + this.#size(victim).height * CHEST];
    const way: Vec3 = [point[0] - chest[0], point[1] - chest[1], point[2] - chest[2]];
    const length = Math.hypot(...way) || 1;
    await this.#hit(leader.reference, victim.reference, {
      power: true,
      bash: false,
      sneak: false,
      ranged: false,
      point,
      direction: [way[0] / length, way[1] / length, way[2] / length],
      shot: undefined,
    });
  }

  /**
   * The kill camera of a killmove the player leads (observed in the original: the
   * player's melee action with a paired target event starts the kill camera, whatever the
   * view): the kill cameras' tree gives its shots (killmove-camera.ts); a first-person shot
   * keeps the player's own view.
   */
  #killCamera(leader: Fighter, victim: Fighter): void {
    const play = this.#play;
    if (!play) return;
    void KillmoveCamera.choose(this.#options.session, {
      attacker: () => this.#feet(leader),
      attackerHeading: () => this.#heading(leader),
      target: () => this.#feet(victim),
      targetHeading: () => this.#heading(victim),
      attackerRef: leader.reference,
      targetRef: victim.reference,
      physics: play.physics,
      maxSeconds: this.#settings.vatsSafetyMaxTime,
    }).then((camera) => {
      if (camera && leader.state.paired === 'lead') this.#camera = camera;
    });
  }

  /**
   * The kill camera of the player's bow or crossbow shot (observed in the original): as
   * the shot leaves, if no kill camera plays, [VATS] bVATSDisable is off and the player does
   * not ride, and at most one actor fights the player ([VATS] bVATSMultipleCombatants: any),
   * the living actor the shot flies at within its projectile's range, with a bow drawn to at
   * least 0.8 of its power (a crossbow: always), whom the shot is predicted to kill ([VATS]
   * bVATSAllowNoKill: any), on the odds of a selective ranged kill camera ([VATS]
   * bVATSRangedSelective; ranged-kill-camera.ts), the shot's way to it clear ([VATS]
   * bVATSIgnoreProjectileTest: not tested). The camera then rides the projectile through the
   * kill cameras' tree, for at most fVATSSafetyMaxTimeRanged.
   */
  async #rangedKillCamera(
    fighter: Fighter,
    from: Vec3,
    aim: Vec3,
    power: number,
    key: object | undefined,
  ): Promise<void> {
    const play = this.#play;
    const session = this.#options.session;
    const runtime = session.scriptsReady;
    const gear = fighter.gear;
    if (!play || !runtime || !gear?.projectile || key === undefined || this.#camera) return;
    const vats = (name: keyof (typeof INI_DEFAULTS)['VATS']): number =>
      session.ini.number('VATS', name);
    if (vats('bVATSDisable') !== 0) return;
    if (runtime.world.mountOf?.(fighter.reference) !== undefined) return;
    if (this.enemiesOfPlayer().length > 1 && vats('bVATSMultipleCombatants') === 0) return;
    const speed = gear.projectile.speed * Math.min(1, Math.max(0.35, power));
    const victim = this.#shotAt(fighter, from, aim, Math.min(10000, gear.projectile.range), {
      speed,
      gravity: WORLD_GRAVITY * gear.projectile.gravity,
    });
    if (!victim || victim.state.life === LifeState.dead) return;
    const bow = gear.right.weaponType === WeaponType.bow;
    if (bow && power < 0.8) return;
    const allowNoKill = vats('bVATSAllowNoKill') !== 0;
    const fatal = await this.#predictedKill(fighter, victim, gear.right.shotDamage * power);
    if (!fatal && !allowNoKill) return;
    if (vats('bVATSRangedSelective') !== 0) {
      const feet = this.#feet(fighter);
      const at = this.#feet(victim);
      if (!feet || !at) return;
      const senses = this.#options.senses?.();
      const detected = senses
        ? senses.detects(victim.reference, fighter.reference)
        : victim.target === fighter.reference;
      const health = await runtime.actors.value(fighter.reference, ActorValue.health);
      const plays = rangedKillCameraPlays(
        {
          distance: Math.hypot(at[0] - feet[0], at[1] - feet[1], at[2] - feet[2]),
          playerLevel: await runtime.actors.level(fighter.reference),
          targetLevel: await runtime.actors.level(victim.reference),
          playerHealth: health.max > 0 ? health.current / health.max : 1,
          sneakKill: play.player.sneaking && !detected,
          threat: victim.target === fighter.reference && victim.state.life === LifeState.alive,
        },
        {
          longDistance: vats('fVATSRangedLongDistance'),
          lowHealthPercent: vats('fVATSRangedLowHealthPercent'),
          percentMin: vats('fVATSRangedPercentMin'),
          percentSneakKill: vats('fVATSRangedPercentSneakKill'),
          percentTargetNoThreat: vats('fVATSRangedPercentTargetNoThreat'),
          targetLowLevelMult: vats('fVATSRangedTargetLowLevelMult'),
        },
      );
      if (!plays) return;
    }
    if (vats('bVATSIgnoreProjectileTest') === 0 && !this.#seen(fighter, victim)) return;
    const projectile = (): { position: Vec3; heading: number } | undefined => {
      for (const shot of this.#projectiles.flying()) {
        if (shot.key !== key) continue;
        const [vx, vy] = shot.velocity;
        return { position: shot.position, heading: Math.atan2(vx, vy) };
      }
      return undefined;
    };
    const camera = await KillmoveCamera.choose(session, {
      attacker: () => this.#feet(fighter),
      attackerHeading: () => this.#heading(fighter),
      target: () => this.#feet(victim),
      targetHeading: () => this.#heading(victim),
      projectile,
      projectileType: gear.projectile.type,
      maxSeconds: this.#settings.vatsSafetyMaxTimeRanged,
      fatal,
      attackerRef: fighter.reference,
      targetRef: victim.reference,
      physics: play.physics,
    });
    // Another may have begun while this one was chosen.
    if (camera && this.camera === undefined) this.#camera = camera;
  }

  /**
   * The actor a shot from a point along an aim flies at within a range: the nearest along it
   * whose body (an upright cylinder) its flight passes through, falling under its gravity (not
   * the shooter or its mount).
   */
  #shotAt(
    fighter: Fighter,
    from: Vec3,
    aim: Vec3,
    range: number,
    flight: { readonly speed: number; readonly gravity: number },
  ): Fighter | undefined {
    const mount = this.#options.session.scriptsReady?.world.mountOf?.(fighter.reference);
    let best: { fighter: Fighter; along: number } | undefined;
    for (const other of this.#fighters.values()) {
      if (other === fighter || other.reference === mount) continue;
      const feet = this.#feet(other);
      if (!feet) continue;
      const size = this.#size(other);
      const middle: Vec3 = [feet[0], feet[1], feet[2] + size.height / 2];
      const along =
        (middle[0] - from[0]) * aim[0] +
        (middle[1] - from[1]) * aim[1] +
        (middle[2] - from[2]) * aim[2];
      if (along < 0 || along > range) continue;
      const x = from[0] + aim[0] * along;
      const y = from[1] + aim[1] * along;
      const seconds = flight.speed > 0 ? along / flight.speed : 0;
      const z = from[2] + aim[2] * along - 0.5 * flight.gravity * seconds * seconds;
      if (Math.hypot(x - feet[0], y - feet[1]) > size.radius) continue;
      if (z < feet[2] || z > feet[2] + size.height) continue;
      if (!best || along < best.along) best = { fighter: other, along };
    }
    return best?.fighter;
  }

  // --- The combat AI's view --------------------------------------------------------------------

  /** What the combat AI sees of the fighters and asks of them. */
  #host(): CombatAiHost {
    return {
      fighters: () => this.#views(),
      fighter: (reference) => {
        const fighter = this.#fighters.get(reference);
        return fighter && this.#view(fighter);
      },
      setTarget: (reference, target) => {
        const fighter = this.#fighters.get(reference);
        if (fighter && !fighter.player) fighter.target = target;
      },
      draw: (reference) => this.draw(reference),
      sheathe: (reference) => this.sheathe(reference),
      attack: (reference, action) => this.attack(reference, action),
      release: (reference, action) => this.release(reference, action),
      block: (reference, on) => this.block(reference, on),
      act: (reference, action, target) => {
        const fighter = this.#fighters.get(reference);
        return fighter ? this.#act(fighter, action, target) : Promise.resolve(undefined);
      },
      threats: () => this.#threats(),
    };
  }

  *#views(): Iterable<FighterView> {
    for (const fighter of this.#fighters.values()) yield this.#view(fighter);
  }

  #view(fighter: Fighter): FighterView {
    const gear = fighter.gear;
    const size = this.#size(fighter);
    const right = gear?.right;
    const bow =
      right !== undefined &&
      (right.weaponType === WeaponType.bow || right.weaponType === WeaponType.crossbow) &&
      gear?.projectile !== undefined &&
      right.ammo !== undefined;
    const twoHanded =
      right?.weapon !== undefined &&
      right.weaponType >= WeaponType.twoHandSword &&
      right.weaponType !== WeaponType.staff;
    let powerChance = 0;
    let canBash = false;
    for (const attack of gear?.attacks.all() ?? []) {
      const kind = attackEventKind(attack.event, attack);
      if (kind?.bash) canBash = true;
      else if (kind?.power) powerChance = Math.max(powerChance, attack.attackChance);
    }
    return {
      reference: fighter.reference,
      player: fighter.player,
      state: fighter.state,
      target: fighter.target,
      feet: this.#feet(fighter),
      heading: this.#heading(fighter),
      reach: this.#reach(fighter, false),
      radius: size.radius,
      height: size.height,
      gear: gear && {
        weapon: gear.right.weapon,
        weaponType: gear.right.weaponType,
        bow,
        shield: gear.shield !== undefined,
        canBlock:
          gear.shield !== undefined ||
          twoHanded ||
          (gear.right.weapon !== undefined && gear.left.weapon === undefined),
        damage: gear.right.damage,
        shotDamage: gear.right.shotDamage,
        range: gear.projectile?.range ?? 0,
        canBash,
        powerChance,
      },
    };
  }

  /** The arrows and bolts in flight and who loosed them (detection: those who see them pass). */
  *shots(): Iterable<{ readonly position: Vec3; readonly source: number }> {
    for (const shot of this.#projectiles.flying()) {
      yield { position: shot.position, source: shot.shooter };
    }
  }

  /** What flies at the actors now: the arrows, spells and breath. */
  *#threats(): Iterable<Threat> {
    for (const shot of this.#projectiles.flying()) {
      yield {
        key: shot.key,
        position: shot.position,
        velocity: shot.velocity,
        radius: SHOT_RADIUS,
        source: shot.shooter,
      };
    }
    yield* this.#options.threats?.() ?? [];
  }

  // --- Helpers ---------------------------------------------------------------------------------

  /** Plays an action's idle on a fighter (its target the conditions' Target); its event. */
  async #act(fighter: Fighter, action: string, target?: number): Promise<string | undefined> {
    const runtime = this.#options.session.scriptsReady;
    const body = fighter.body;
    if (!runtime || !body) return undefined;
    this.#tree ??= this.#options.session.db.then((db) => readIdleTree(db));
    const tree = await this.#tree;
    const parent = tree.action(action);
    const graph = await this.#graphKey(body.look.behavior);
    if (!parent || graph === undefined) return undefined;
    const subject = new ObjectHandle(fighter.reference, 'actor');
    const resolve = (on: number | undefined): Promise<IdleRecord | undefined> => {
      const context = on === undefined ? {} : { target: runtime.referenceHandle(on) };
      return tree.resolveAsync(parent.formId, graph, (candidate) =>
        runtime.conditionsHold(candidate.conditions, subject, undefined, context),
      );
    };
    let idle = await resolve(target);
    // A paired idle ("pa_<name>") plays only if its target's graph takes "<name>" now (observed
    // in the original: the target's side is played first, the leader's only once it
    // was taken; the player's attack is then asked again without its target: a plain attack).
    // A killmove's victim with its weapon sheathed has none.
    if (
      target !== undefined &&
      idle?.event?.toLowerCase().startsWith(PAIRED_PREFIX) === true &&
      !this.#partnerTakes(target, idle.event.slice(PAIRED_PREFIX.length))
    ) {
      idle = await resolve(undefined);
    }
    const event = idle?.event;
    if (event === undefined) return undefined;
    let taken = false;
    for (const runtimeGraph of this.#graphs(fighter))
      taken = runtimeGraph.sendEvent(event) || taken;
    return taken ? event : undefined;
  }

  /** Whether a paired idle's target would take its side's event now (its body's graph). */
  #partnerTakes(target: number, event: string): boolean {
    const partner = this.#fighters.get(target);
    const graph = partner?.body?.behavior;
    return graph?.wouldHandle(event) === true;
  }

  /**
   * An attack its graph did not take. Refused at once (no state its graph is in answers the
   * event then: an attack asked for while the last one's end still blends out), the attack
   * ends at the next frame, and the AI asks again at its next decision (the combat tree's
   * attack idle), as the engine's action fails when the graph does not take its event. Still
   * in its wind-up after ATTACK_ANSWER seconds (an event its graph names but no state of it
   * answers: the canine graphs' attackStart_AttackRight1, a dog's), the attack ends; an event
   * its graph never took is not chosen again, so that it fights on.
   */
  #unanswered(fighter: Fighter): void {
    const since = fighter.attackSince;
    const current = fighter.state.current;
    if (since === undefined) return;
    const event = current?.event.toLowerCase();
    // Its wind-up: a swing's draw, a bow's draw, a bash.
    const attack = fighter.state.attack;
    const windUp =
      attack === AttackState.draw || attack === AttackState.bowDraw || attack === AttackState.bash;
    if (!current || event === undefined || !windUp) {
      if (event !== undefined) fighter.liveAttacks.add(event);
      fighter.attackSince = undefined;
      return;
    }
    const answers = this.#graphs(fighter).map((graph) => graph.answered(event));
    if (answers.includes(true)) {
      // Taken: it plays on, however long its wind-up.
      fighter.liveAttacks.add(event);
      fighter.attackSince = undefined;
      return;
    }
    if (answers.includes(false)) {
      fighter.attackSince = undefined;
      fighter.refusedAttacks++;
      // One its graph refuses again and again and never took is not chosen again either.
      const refusals = (fighter.refusals.get(event) ?? 0) + 1;
      fighter.refusals.set(event, refusals);
      if (!fighter.liveAttacks.has(event) && refusals >= DEAD_REFUSALS) {
        fighter.deadAttacks.add(event);
      }
      graphEvent(fighter.state, 'attackStop', 'AttackStopHandler');
      this.#setVariable(fighter, 'IsAttacking', 0);
      this.#setVariable(fighter, 'IsBashing', 0);
      return;
    }
    if (this.#clock - since < ATTACK_ANSWER) return;
    fighter.attackSince = undefined;
    if (!fighter.liveAttacks.has(event)) fighter.deadAttacks.add(event);
    graphEvent(fighter.state, 'attackStop', 'AttackStopHandler');
    this.#setVariable(fighter, 'IsAttacking', 0);
    this.#setVariable(fighter, 'IsBashing', 0);
  }

  /**
   * A draw or sheathe its graph did not take (refused at once: no state it is in answers the
   * event), or that never got to its end (WEAPON_ANSWER seconds without the graph's weaponDraw
   * or weaponSheathe: the transition was cut short): the weapon is where it was before (refused)
   * or away (cut short), so that the AI asks again, as the engine's weapon state follows its
   * graph. Without this a fighter could wait for good in drawing or sheathing.
   */
  #unansweredWeapon(fighter: Fighter): void {
    const asked = fighter.weaponAsked;
    if (!asked) return;
    const state = fighter.state;
    const drawing = state.weapon === WeaponState.drawing;
    if (!drawing && state.weapon !== WeaponState.sheathing) {
      fighter.weaponAsked = undefined;
      return;
    }
    const answers = this.#graphs(fighter).map((graph) => graph.answered(asked.event));
    const refused = answers.includes(false) && !answers.includes(true);
    if (!refused && this.#clock - asked.since < WEAPON_ANSWER) return;
    fighter.weaponAsked = undefined;
    state.weapon = refused && !drawing ? WeaponState.drawn : WeaponState.sheathed;
    this.#setVariable(fighter, 'IsEquipping', 0);
    this.#setVariable(fighter, 'IsUnequipping', 0);
  }

  /**
   * An attack of an actor whose idle tree has none for the action (creatures: the wolf's graph
   * has no ActionRightAttack idles): one of its attack data (its race's ATKD / ATKE) of the
   * action's kind (power or not; bashes for a bash) whose event its graph has (the canine race's
   * data serves wolves and dogs: attackStart_AttackRight1 is a dog's), at random by their attack
   * chances, its event sent to the graph. Inferred from the data: the creatures' attacks are their races'
   * attack events. TODO(M13): how the engine picks among them (the attack angle, distance).
   */
  #creatureAttack(fighter: Fighter, action: string): string | undefined {
    const attacks = fighter.gear?.attacks;
    if (fighter.player || !attacks || !action.includes('Attack')) return undefined;
    const power = action.includes('Power');
    const bash = action.includes('Bash');
    const graphs = this.#graphs(fighter);
    const choices = [...attacks.all()].filter((attack) => {
      const kind = attackEventKind(attack.event, attack);
      return (
        kind?.power === power &&
        kind.bash === bash &&
        !fighter.deadAttacks.has(attack.event.toLowerCase()) &&
        graphs.some((graph) => graph.declares(attack.event))
      );
    });
    let total = 0;
    for (const attack of choices) total += Math.max(0, attack.attackChance);
    let pick = Math.random() * total;
    for (const attack of choices) {
      pick -= Math.max(0, attack.attackChance);
      if (pick > 0) continue;
      let taken = false;
      for (const graph of graphs) taken = graph.sendEvent(attack.event) || taken;
      return taken ? attack.event : undefined;
    }
    return undefined;
  }

  #graphKey(project: string | undefined): Promise<string | undefined> {
    if (project === undefined) return Promise.resolve(undefined);
    let entry = this.#graphKeys.get(project);
    if (!entry) {
      entry = this.#options.session.animation
        .behaviors(project)
        .then((behaviors) => {
          const file = behaviors?.character.behavior;
          return file === undefined ? undefined : behaviorGraphKey(file);
        })
        .catch(() => undefined);
      this.#graphKeys.set(project, entry);
    }
    return entry;
  }

  /** A fighter's graphs (the player's body and first-person graphs). */
  #graphs(fighter: Fighter): BehaviorRuntime[] {
    const graphs: BehaviorRuntime[] = [];
    const body = fighter.body?.behavior;
    if (body) graphs.push(body);
    if (fighter.player) {
      const first = this.#avatar?.firstPerson?.behavior;
      if (first) graphs.push(first);
    }
    return graphs;
  }

  #setVariable(fighter: Fighter, name: string, value: number): void {
    for (const graph of this.#graphs(fighter)) graph.setVariable(name, value);
    // Its weapons' graphs (a bow's) share the wielder's variables.
    fighter.held?.setVariable(name, value);
    fighter.firstHeld?.setVariable(name, value);
  }

  /** The attack data of an event (killmoves and events without data: a power attack's). */
  #attackData(fighter: Fighter, event: string): AttackData {
    const data = fighter.gear?.attacks.of(event);
    if (data) return data;
    return event.toLowerCase().startsWith(PAIRED_PREFIX) ? POWER_ATTACK_DEFAULT : DEFAULT_ATTACK;
  }

  /** Stamina for a power attack or bash (the skill progression's costs). */
  async #spendFor(
    fighter: Fighter,
    data: AttackData,
    power: boolean,
    bash: boolean,
    dual: boolean,
  ): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime || (!power && !bash)) return;
    const progression = runtime.progression;
    const weight = fighter.gear?.rightRecord?.weight ?? 0;
    let cost = bash
      ? await progression.bashCost(power)
      : await progression.powerAttackCost(weight, {
          dualWield: dual,
          attackStaminaMult: data.staminaMult,
        });
    // The perks change a power attack's (Mod Power Attack Stamina: Fighting Stance, Champion's
    // Stance).
    if (power) {
      cost = await runtime.perks.apply(EntryPoint.modPowerAttackStamina, fighter.reference, cost, [
        this.#heldWeapon(fighter),
      ]);
    }
    await progression.spend(fighter.reference, ActorValue.stamina, cost);
  }

  /** How far it strikes (its weapon's reach, a bash's, its fists' by its race). */
  #reach(fighter: Fighter, bash: boolean): number {
    const gear = fighter.gear;
    return meleeReach(
      {
        weaponReach: gear?.right.weapon === undefined ? undefined : gear.right.reach,
        bash,
        unarmedReach: gear?.race?.unarmedReach ?? 96,
        scale: this.#scale(fighter),
      },
      this.#settings,
    );
  }

  /**
   * A fighter's shape for blows: its controller's (its skeleton's bound: a dragon's is a
   * dragon's), in the air the one it had on the ground, else a human's by its scale.
   */
  #size(fighter: Fighter): { readonly radius: number; readonly height: number } {
    const scale = this.#scale(fighter);
    if (!fighter.player) {
      const movers = this.#options.movers;
      const radius = movers.radius(fighter.reference);
      const height = movers.height(fighter.reference);
      if (radius !== undefined && height !== undefined) return { radius, height };
      const flown = this.#options.flight?.()?.shape(fighter.reference);
      if (flown) return flown;
    }
    return { radius: BODY_RADIUS * scale, height: BODY_HEIGHT * scale };
  }

  #scale(fighter: Fighter): number {
    const body = fighter.body;
    return body ? body.look.scale * body.actor.scale : 1;
  }

  #feet(fighter: Fighter): Vec3 | undefined {
    if (fighter.player) return this.#play?.player.feet;
    return this.#options.get(fighter.reference)?.position;
  }

  #heading(fighter: Fighter): number {
    if (fighter.player) return this.#avatar?.bodyYaw ?? this.#play?.player.yaw ?? 0;
    return this.#options.get(fighter.reference)?.heading ?? 0;
  }

  /** GetMovementDirection: 0 none, 1 forward, 2 right, 3 back, 4 left. */
  #movementDirection(fighter: Fighter): number {
    let x: number;
    let y: number;
    if (fighter.player) {
      const motion = this.#play?.player.motion;
      if (!motion?.moving) return 0;
      x = motion.inputX;
      y = motion.inputY;
    } else {
      const moved = this.#options.movers.state(fighter.reference);
      if (!moved) return 0;
      const [vx, vy] = moved.velocity;
      if (Math.hypot(vx, vy) < 5) return 0;
      const heading = this.#heading(fighter);
      // Into the actor's frame: x right, y forward.
      x = vx * Math.cos(heading) - vy * Math.sin(heading);
      y = vx * Math.sin(heading) + vy * Math.cos(heading);
    }
    if (Math.abs(y) >= Math.abs(x)) return y >= 0 ? 1 : 3;
    return x >= 0 ? 2 : 4;
  }

  /**
   * The actor the player's attack is aimed at (the attack action's target: its idles'
   * conditions run on it), observed in the original: the actors near (not the player's
   * mount; the dead too) within the reach of the player's weapon (fists: their race's; a bash's
   * reach; mounted, [Combat] fMountedAttackRange) between the two bodies' edges, inside
   * fCombatHitConeAngle of the player's facing (the dead: fCombatDeadActorHitConeMult times as
   * wide), the one nearest that facing; its current target first if it still is in reach.
   */
  #aimedAt(fighter: Fighter): number | undefined {
    const feet = this.#feet(fighter);
    if (!feet) return undefined;
    const heading = this.#play?.player.yaw ?? this.#heading(fighter);
    const mount = this.#options.session.scriptsReady?.world.mountOf?.(fighter.reference);
    const reach =
      mount !== undefined
        ? this.#options.session.ini.number('Combat', 'fMountedAttackRange')
        : this.#reach(fighter, false);
    const radius = this.#size(fighter).radius;
    const cone = this.#settings.combatHitConeAngle;
    /** How far off the facing an actor in reach is (degrees), if it may be struck. */
    const off = (other: Fighter): number | undefined => {
      if (other === fighter || other.reference === mount) return undefined;
      const at = this.#feet(other);
      if (!at) return undefined;
      const between =
        Math.hypot(at[0] - feet[0], at[1] - feet[1], at[2] - feet[2]) -
        radius -
        this.#size(other).radius;
      if (between > reach) return undefined;
      const angle = Math.abs(turnBetween(heading, headingTo(feet, at))) * (180 / Math.PI);
      const dead = other.state.life === LifeState.dead;
      return angle <= (dead ? cone * this.#settings.deadActorHitConeMult : cone)
        ? angle
        : undefined;
    };
    const current = fighter.target === undefined ? undefined : this.#fighters.get(fighter.target);
    if (current && off(current) !== undefined) return current.reference;
    let best: { reference: number; angle: number; fighter: Fighter } | undefined;
    for (const other of this.#fighters.values()) {
      const angle = off(other);
      if (angle === undefined) continue;
      if (!best || angle <= best.angle)
        best = { reference: other.reference, angle, fighter: other };
    }
    // The player must see it (a wall between: none).
    return best && this.#seen(fighter, best.fighter) ? best.reference : undefined;
  }

  /** Whether nothing but actors stands between two fighters' chests. */
  #seen(from: Fighter, to: Fighter): boolean {
    const physics = this.#play?.physics;
    const a = this.#feet(from);
    const b = this.#feet(to);
    if (!physics?.queriesCurrent || !a || !b) return true;
    const start: Vec3 = [a[0], a[1], a[2] + this.#size(from).height * CHEST];
    const end: Vec3 = [b[0], b[1], b[2] + this.#size(to).height * CHEST];
    const way: Vec3 = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
    const length = Math.hypot(way[0], way[1], way[2]);
    if (length < 1) return true;
    const hit = physics.raycast(
      start,
      [way[0] / length, way[1] / length, way[2] / length],
      length,
      Layer.weapon,
    );
    return !hit || hit.owner?.kind === 'actor';
  }

  /** Whether someone fights the player now (the wait menu's sNoWaitHostileActorsNear). */
  get fightingPlayer(): boolean {
    return this.#fightingPlayer();
  }

  /** The living actors fighting the player now (the compass's enemies). */
  enemiesOfPlayer(): number[] {
    const found: number[] = [];
    for (const fighter of this.#fighters.values()) {
      if (
        fighter.target === PLAYER_REF &&
        fighter.state.life === LifeState.alive &&
        !fighter.player
      )
        found.push(fighter.reference);
    }
    return found;
  }

  #fightingPlayer(): boolean {
    for (const fighter of this.#fighters.values()) {
      if (fighter.target === PLAYER_REF && fighter.state.life === LifeState.alive) return true;
    }
    return false;
  }

  /**
   * Combat music (DOBJ BTMS, MUSCombat) while anyone fights the player; it ends with its
   * finale as the fight does (the music system's ducking and cue points).
   */
  #setMusic(on: boolean): void {
    if (on === this.#musicOn) return;
    const sounds = this.#options.session.soundSystem;
    if (!sounds) return;
    this.#musicOn = on;
    if (on) {
      void this.#options.session.defaultObjects().then((objects) => {
        const music = objects.get(DefaultObjectUse.battleMusic);
        if (music === undefined || !this.#musicOn) return;
        this.#music = music;
        sounds.music.add(music);
      });
    } else if (this.#music !== undefined) {
      sounds.music.remove(this.#music);
      this.#music = undefined;
    }
  }

  /**
   * The HUD's enemy bar: the one the player hit last. Observed in the original: it shows
   * while that actor lives and is hostile to the player; one that is not stays
   * iEnemyHealthDisplayTime ms after its health last changed, and only while it is within
   * iEnemyHealthDisplayAngle degrees of the camera's heading. Its health shows as 1..100
   * percent.
   */
  #enemyBar(): void {
    const hud = this.#options.session.hud;
    const enemy = this.#enemy;
    if (!enemy) return;
    const fighter = this.#fighters.get(enemy.reference);
    const runtime = this.#options.session.scriptsReady;
    if (!fighter?.body || !runtime || fighter.state.life === LifeState.dead) {
      this.#hideEnemyBar();
      return;
    }
    const ini = this.#options.session.ini;
    if (!this.hostile(enemy.reference, PLAYER_REF)) {
      const shown =
        (this.#clock - enemy.changed) * 1000 <= ini.number('Interface', 'iEnemyHealthDisplayTime');
      const feet = this.#feet(fighter);
      const player = this.#play?.player;
      let inView = true;
      if (feet && player) {
        const heading = Math.atan2(feet[0] - player.feet[0], feet[1] - player.feet[1]);
        const off = Math.abs(
          Math.atan2(Math.sin(heading - player.yaw), Math.cos(heading - player.yaw)),
        );
        inView = (off * 180) / Math.PI <= ini.number('Interface', 'iEnemyHealthDisplayAngle');
      }
      if (!shown || !inView) {
        this.#hideEnemyBar();
        return;
      }
    }
    const name = fighter.body.look.name || fighter.body.look.editorId;
    void runtime.actors.value(enemy.reference, ActorValue.health).then((value) => {
      if (this.#enemy !== enemy) return;
      const fraction = value.max > 0 ? value.current / value.max : 0;
      const health = fraction > 0 ? Math.min(100, Math.max(1, fraction * 100)) : 0;
      if (health !== enemy.health) {
        enemy.health = health;
        enemy.changed = this.#clock;
      }
      if (health <= 0) {
        this.#hideEnemyBar();
        return;
      }
      hud.enemy({ name, health });
    });
  }

  #hideEnemyBar(): void {
    if (this.#enemy) this.#options.session.hud.enemy(undefined);
    this.#enemy = undefined;
  }

  /** The player struck an actor: its bar shows (its health changes from now). */
  #struck(reference: number): void {
    if (this.#enemy?.reference === reference) {
      this.#enemy.changed = this.#clock;
      return;
    }
    this.#enemy = { reference, changed: this.#clock, health: Number.NaN };
  }

  /** The player's shape for shots (they have no bodies on BIPED). */
  *#playerShape(): Iterable<{ reference: number; feet: Vec3; radius: number; height: number }> {
    const player = this.#play?.player;
    if (!player || !this.#fighters.has(PLAYER_REF)) return;
    yield {
      reference: PLAYER_REF,
      feet: player.feet,
      radius: BODY_RADIUS,
      height: BODY_HEIGHT * player.height,
    };
  }

  #playSound(sound: number | undefined, fighter: Fighter): void {
    if (sound === undefined) return;
    const sounds = this.#options.session.soundSystem;
    const feet = this.#feet(fighter);
    if (!sounds || !feet) return;
    const at = fighter.body?.pose.world('WEAPON');
    const world = fighter.player
      ? this.#avatar?.placement.world
      : fighter.body?.instances[0]?.world;
    const place: Vec3 =
      at && world ? transformPoint(world, [at[12] ?? 0, at[13] ?? 0, at[14] ?? 0]) : feet;
    void sounds.play(sound, place, 0, fighter.reference);
  }

  #difficulty(): number {
    return this.#options.session.ini.number('GamePlay', 'iDifficulty');
  }

  #readSettings(): void {
    if (this.#settingsRead) return;
    this.#settingsRead = true;
    void this.#options.session.settings().then((settings) => {
      this.#settings = readCombatSettings((name) => settings.number(name));
    });
  }

  /** The equip system's changes: what an actor holds is read again. */
  #listenToEquipment(runtime: ScriptRuntime): void {
    if (this.#equipListening === runtime) return;
    this.#equipListening = runtime;
    runtime.equipment.listeners.add((change) => {
      const fighter = this.#fighters.get(change.actor);
      if (!fighter) return;
      fighter.gearVersion++;
      fighter.gear = undefined;
    });
    // The skill progression's regeneration in combat.
    runtime.progression.inCombat = (actor) =>
      actor === PLAYER_REF ? this.#fightingPlayer() : this.#brain.combatState(actor) !== 0;
  }

  #drop(fighter: Fighter): void {
    fighter.held?.destroy();
    fighter.firstHeld?.destroy();
    if (fighter.lookedAt !== undefined) {
      this.#options.session.scriptWorld.lookTargets.lookAt(fighter.reference, undefined, 'combat');
    }
    this.#fighters.delete(fighter.reference);
    this.#perkVariables.delete(fighter.reference);
  }

  #warn(message: string): void {
    this.#options.terminal.log('combat', message, 'warn');
  }

  /** An actor left the stage or died: it fights no more. */
  remove(reference: number): void {
    const fighter = this.#fighters.get(reference);
    if (fighter && !fighter.player) this.#drop(fighter);
    for (const other of this.#fighters.values()) {
      if (other.target === reference) other.target = undefined;
    }
    this.#brain.remove(reference);
    this.#estimatedArmor.delete(reference);
  }

  clear(): void {
    this.#brain.clear();
    this.#estimatedArmor.clear();
    for (const fighter of [...this.#fighters.values()]) this.#drop(fighter);
    this.#projectiles.clear();
    this.#impacts.clear();
    this.#setMusic(false);
  }

  /**
   * Knocked down (a ragdoll that gets up: src/shell/actor-knockdowns.ts): GetKnockStateEnum's
   * value.
   */
  knockState(reference: number): number {
    return (
      this.#options.knockdowns?.()?.state(reference) ??
      this.#fighters.get(reference)?.state.knock ??
      KnockState.normal
    );
  }

  /**
   * Its knock state changed (src/shell/actor-knockdowns.ts): down, it stops what it did (an
   * attack, a block, a stagger) and acts no more until it is up.
   */
  knockChanged(reference: number, knock: number): void {
    const fighter = this.#fighters.get(reference);
    if (!fighter) return;
    const state = fighter.state;
    state.knock = knock;
    if (knock === KnockState.normal) return;
    state.current = undefined;
    state.attack = AttackState.none;
    state.staggered = false;
    state.recoiling = false;
    if (state.blocking || state.wantBlocking) {
      state.blocking = false;
      state.wantBlocking = false;
      this.#setVariable(fighter, 'iWantBlock', 0);
      this.#setVariable(fighter, 'IsBlocking', 0);
    }
    this.#setVariable(fighter, 'IsAttacking', 0);
    this.#setVariable(fighter, 'IsBashing', 0);
  }

  /**
   * A package's UseWeapon practice (src/shell/actor-practice.ts): its fighter attacks `target`
   * (its combat target meanwhile) as the practice says; undefined: the practice ended.
   */
  practice(actor: number, target: number | undefined, practice: Practice | undefined): void {
    const fighter = this.#fighters.get(actor);
    if (!fighter || fighter.player) return;
    fighter.practice = practice;
    // Not a fight of the combat AI's: only its target to aim and strike at.
    if (!this.#brain.engaged(actor)) fighter.target = target;
  }

  /**
   * A hostile spell that took hold on an actor (src/shell/magic-projectiles.ts): as a blow does,
   * its victim turns on its caster (the combat AI: at once on an enemy or a neutral, a friend's
   * after iFriendHitCombatAllowed), and the caster shows on the HUD's enemy bar if it is the
   * player's.
   */
  spellHit(caster: number, victim: number): void {
    if (caster === victim) return;
    // A held spell's sprays (Flames: one every relaunch interval) count as one blow a second.
    const key = `${String(caster)}:${String(victim)}`;
    const last = this.#spellHits.get(key);
    if (last !== undefined && this.#clock - last < 1) return;
    this.#spellHits.set(key, this.#clock);
    if (this.#spellHits.size > 256) this.#spellHits.clear();
    this.#brain.hit(caster, victim);
    if (caster === PLAYER_REF && victim !== PLAYER_REF) this.#struck(victim);
  }

  /**
   * Knocks an actor down (Actor.PushActorAway and KnockAreaEffect, an explosion's knock-down
   * flags, an attack's knockdown): its idle tree's ActionKnockdown says how (the humans'
   * NPCKnockDown, the bear's, the giant's: "Ragdoll"; mammoths, atronachs and wisps: a
   * stagger), and its ragdoll is pushed away from `from` by `force` (an impulse on its bodies,
   * Havok units; negative pulls). A race with No Knockdowns (RACE DATA), or a graph with no
   * knock-down, staggers at full strength instead (UESP "Unrelenting Force": those immune to
   * the ragdoll are staggered). One lying already is pushed again.
   */
  async knockDown(reference: number, from: Vec3 | undefined, force: number): Promise<void> {
    const fighter = this.#fighters.get(reference);
    const knockdowns = this.#options.knockdowns?.();
    const feet = fighter && this.#feet(fighter);
    if (!fighter || !knockdowns || !feet) return;
    if (bleedingOut(fighter.state) || fighter.state.paired !== undefined) return;
    const away: Vec3 = from
      ? [feet[0] - from[0], feet[1] - from[1], 0]
      : [Math.sin(this.#heading(fighter)), Math.cos(this.#heading(fighter)), 0];
    const length = Math.hypot(away[0], away[1]) || 1;
    // Away and a little up (TODO(M13): the engine's push direction is not documented).
    const sign = force < 0 ? -1 : 1;
    const direction: Vec3 = [(sign * away[0]) / length, (sign * away[1]) / length, 0.5];
    const push = { direction, force: Math.abs(force) };
    if (knockdowns.holds(reference)) {
      knockdowns.push(reference, direction, push.force);
      return;
    }
    const immune = ((fighter.body?.look.raceFlags ?? 0) & RaceFlag.noKnockdowns) !== 0;
    const event = immune ? undefined : (await this.#act(fighter, 'ActionKnockdown'))?.toLowerCase();
    if (event === 'ragdoll' || event === 'ragdollinstant') {
      await knockdowns.knockDown(reference, push);
      return;
    }
    // No idle for it (a graph the tree has none for: draugr): its graph's own Ragdoll.
    if (event === undefined && !immune && fighter.body?.behavior?.sendEvent('Ragdoll') === true) {
      await knockdowns.knockDown(reference, push);
      return;
    }
    if (event !== 'staggerstart') this.stagger(reference, 1, from);
  }

  /**
   * Staggers an actor by a magnitude (0..1) from where the blow came (the Stagger effect's
   * magnitude, weighed against its mass; a hit's: #hit), through ActionStaggerStart.
   */
  stagger(reference: number, magnitude: number, from: Vec3 | undefined): void {
    const fighter = this.#fighters.get(reference);
    const feet = fighter && this.#feet(fighter);
    if (!fighter || !feet || magnitude <= 0) return;
    const heading = this.#heading(fighter);
    this.#stagger(
      fighter,
      Math.min(1, magnitude),
      from ?? [feet[0] + Math.sin(heading), feet[1] + Math.cos(heading), feet[2]],
    );
  }

  /**
   * Paralysis begins or ends on an actor: it falls as its ragdoll (its graph's Ragdoll) and lies
   * until it ends, then gets up. TODO(M13): the paralysed fall stiff in the game (the ragdoll's
   * powered controls holding the pose); here they fall limp.
   */
  paralyze(reference: number, on: boolean): void {
    const knockdowns = this.#options.knockdowns?.();
    if (!knockdowns) return;
    knockdowns.paralyze(reference, on);
    if (!on || knockdowns.holds(reference)) return;
    const fighter = this.#fighters.get(reference);
    if (!fighter || bleedingOut(fighter.state) || fighter.state.paired !== undefined) return;
    fighter.body?.behavior?.sendEvent('Ragdoll');
    void knockdowns.knockDown(reference);
  }

  /**
   * Grab Actor (the Vampire Lord's Vampiric Grip): its target goes limp as its ragdoll
   * (its graph's Ragdoll) and hangs before its caster, at the caster's chest
   * fMagicGrabActorMinDistance ahead (observed in the original: the hold's distance),
   * while the effect lasts; then it is flung away from its caster with fMagicGrabActorThrowForce
   * (as an explosion's knock-down pushes), falls and gets up. TODO(M13): the engine holds it
   * before the camera (the player's grab); an NPC caster's hold is taken as before its chest.
   */
  grabActor(caster: number | undefined, target: number, on: boolean): void {
    const knockdowns = this.#options.knockdowns?.();
    if (!knockdowns || target === PLAYER_REF) return;
    const holder = caster === undefined ? undefined : this.#fighters.get(caster);
    const runtime = this.#options.session.scriptsReady;
    const setting = async (name: string, fallback: number): Promise<number> => {
      const value = await runtime?.gameSetting(name);
      return typeof value === 'number' ? value : fallback;
    };
    if (!on) {
      knockdowns.hold(target, undefined);
      const from = holder && this.#feet(holder);
      const fighter = this.#fighters.get(target);
      const at = fighter && this.#feet(fighter);
      if (!from || !at) return;
      void setting('fMagicGrabActorThrowForce', 25).then((force) => {
        const way: Vec3 = [at[0] - from[0], at[1] - from[1], at[2] - from[2]];
        const length = Math.hypot(...way) || 1;
        void knockdowns.knockDown(target, {
          direction: [way[0] / length, way[1] / length, way[2] / length],
          force,
        });
      });
      return;
    }
    const fighter = this.#fighters.get(target);
    if (!holder || !fighter || bleedingOut(fighter.state)) return;
    if (!knockdowns.holds(target)) fighter.body?.behavior?.sendEvent('Ragdoll');
    void Promise.all([
      knockdowns.knockDown(target),
      setting('fMagicGrabActorMinDistance', 90),
    ]).then(([down, distance]) => {
      if (!down) return;
      knockdowns.hold(target, (): Vec3 | undefined => {
        const feet = this.#feet(holder);
        if (!feet) return undefined;
        const heading = this.#heading(holder);
        const scale = this.#scale(holder);
        return [
          feet[0] + Math.sin(heading) * distance,
          feet[1] + Math.cos(heading) * distance,
          feet[2] + BODY_HEIGHT * scale * CHEST,
        ];
      });
    });
  }

  /**
   * A Stagger effect on an actor (its magnitude: Unrelenting Force's 0.75, 1.25, 1.5; the
   * spells' 0.05 .. 1), weighed against its mass as a hit's stagger is (stagger.ts), from its
   * caster's side.
   */
  staggerEffect(reference: number, magnitude: number, caster: number | undefined): void {
    const fighter = this.#fighters.get(reference);
    if (!fighter) return;
    const weighed = staggerMagnitude(
      {
        weaponStagger: magnitude,
        attackStagger: 1,
        perkMult: 1,
        targetMass: fighter.gear?.race?.mass ?? 1,
        targetIsPlayer: fighter.player,
      },
      this.#settings,
    );
    const source = caster === undefined ? undefined : this.#fighters.get(caster);
    this.stagger(reference, weighed, source && this.#feet(source));
  }
}

/** What a shot carries to its hit. */
interface ShotPayload {
  readonly attacker: number;
  /** The bow's shot damage (bow and arrow, with skill and perks) and its draw. */
  readonly damage: number;
  /** The bow and the arrow (the damage against the one hit: its perks). */
  readonly weapon: number | undefined;
  readonly ammo: number | undefined;
  readonly power: number;
  readonly impactDataSet: number | undefined;
  readonly projectile: number;
  readonly kind: AttackKind;
}

function newFighter(reference: number, player: boolean): Fighter {
  return {
    reference,
    player,
    state: newCombatState(),
    body: undefined,
    hooked: undefined,
    held: undefined,
    firstHeld: undefined,
    heldFor: undefined,
    blood: undefined,
    gear: undefined,
    gearVersion: 0,
    gearLoading: false,
    target: undefined,
    heldSince: undefined,
    inHand: false,
    handTypes: undefined,
    drawSounded: false,
    down: 0,
    pairedFor: 0,
    killer: undefined,
    synced: false,
    toMark: undefined,
    bleeding: false,
    unbled: 0,
    lastCritical: false,
    attackSince: undefined,
    liveAttacks: new Set(),
    deadAttacks: new Set(),
    refusals: new Map(),
    refusedAttacks: 0,
    weaponAsked: undefined,
    practice: undefined,
    bowAimed: false,
    lookedAt: undefined,
    leftHand: undefined,
  };
}
