// An actor's combat state as the engine keeps it (CommonLibSSE ActorState: WEAPON_STATE,
// ATTACK_STATE_ENUM, KNOCK_STATE_ENUM, ACTOR_LIFE_STATE, wantBlocking, recoil, staggered),
// moved by what it is asked to do (draw, attack, block) and by the events its behavior graph
// raises (the clips' annotations: weaponDraw, preHitFrame, HitFrame, AttackWinStart, attackStop,
// arrowAttach, bowDrawn, arrowRelease, weaponSheathe, ...). What follows from an event (the
// weapon moving to the hand, a strike landing, an arrow loosed) comes back as effects for the
// engine to carry out. Conditions and natives read it (IsWeaponOut, GetAttackState,
// IsBlocking, IsBleedingOut, GetKnockStateEnum, ...). Plain data. Platform-independent.

/** WEAPON_STATE (CommonLibSSE ActorState.h). */
export const WeaponState = {
  sheathed: 0,
  wantToDraw: 1,
  drawing: 2,
  drawn: 3,
  wantToSheathe: 4,
  sheathing: 5,
} as const;

/** ATTACK_STATE_ENUM: GetAttackState's values (the idle tree's conditions read 6 and 8..12). */
export const AttackState = {
  none: 0,
  draw: 1,
  swing: 2,
  hit: 3,
  nextAttack: 4,
  followThrough: 5,
  bash: 6,
  bowDraw: 8,
  bowAttached: 9,
  bowDrawn: 10,
  bowReleasing: 11,
  bowReleased: 12,
  bowNextAttack: 13,
  bowFollowThrough: 14,
  fire: 15,
  firing: 16,
  fired: 17,
} as const;

/** KNOCK_STATE_ENUM: GetKnockStateEnum's values. */
export const KnockState = {
  normal: 0,
  explode: 1,
  explodeLeadIn: 2,
  out: 3,
  outLeadIn: 4,
  queued: 5,
  getUp: 6,
  down: 7,
  waitForTaskQueue: 8,
} as const;

/** ACTOR_LIFE_STATE. */
export const LifeState = {
  alive: 0,
  dying: 1,
  dead: 2,
  unconscious: 3,
  reanimate: 4,
  recycle: 5,
  restrained: 6,
  essentialDown: 7,
  bleedout: 8,
} as const;

/** Which hand an attack is made with. */
export type AttackHand = 'right' | 'left' | 'dual';

/** The attack under way. */
export interface CurrentAttack {
  /** The graph event that started it (the attack data's ATKE). */
  readonly event: string;
  readonly hand: AttackHand;
  readonly power: boolean;
  readonly bash: boolean;
  /** A bow's or crossbow's shot. */
  readonly ranged: boolean;
  /**
   * A killmove: the engine counts paired idles whose event begins "pa_Kill" (observed in the original;
   * the vampire's feeding bite and other paired idles are none).
   */
  readonly killMove: boolean;
  /** The targets it struck already (each once an attack). */
  readonly struck: Set<number>;
}

export interface CombatState {
  weapon: number;
  attack: number;
  current: CurrentAttack | undefined;
  /** It wants to block (the block key held, its AI) and it blocks now. */
  wantBlocking: boolean;
  blocking: boolean;
  staggered: boolean;
  recoiling: boolean;
  life: number;
  knock: number;
  /** In a paired animation (a killmove): as the one who leads it, or the one it is done to. */
  paired: 'lead' | 'support' | undefined;
  /** In a killmove (IsInKillMove): from its start until its graph's KillMoveEnd, or its end. */
  killMove: boolean;
  /** An arrow on the string, and how long the bow has been drawn (seconds). */
  arrowNocked: boolean;
  drawnFor: number;
  /** The last hit it dealt was critical (GetLastHitCritical). */
  lastHitCritical: boolean;
  /** Seconds since it began bleeding out. */
  bleedingFor: number;
}

export function newCombatState(): CombatState {
  return {
    weapon: WeaponState.sheathed,
    attack: AttackState.none,
    current: undefined,
    wantBlocking: false,
    blocking: false,
    staggered: false,
    recoiling: false,
    life: LifeState.alive,
    knock: KnockState.normal,
    paired: undefined,
    killMove: false,
    arrowNocked: false,
    drawnFor: 0,
    lastHitCritical: false,
    bleedingFor: 0,
  };
}

/** What the engine does as the graph's events come. */
export type CombatEffect =
  /** The weapon goes to the hand (weaponDraw) or to its sheath (weaponSheathe). */
  | { readonly kind: 'hand' }
  | { readonly kind: 'sheath' }
  /** The right hand's draw or sheathe begins: its weapon's equip or unequip sound. */
  | { readonly kind: 'draw-begin' }
  | { readonly kind: 'sheathe-begin' }
  /** A hand's swing: its weapon's swing sound (weaponSwing, weaponLeftSwing). */
  | { readonly kind: 'swing'; readonly hand: 'right' | 'left' }
  /** The strike lands now: its targets are looked for (HitFrame). */
  | { readonly kind: 'strike' }
  /** An arrow appears on the string (arrowAttach) or leaves the hand (arrowDetach). */
  | { readonly kind: 'arrow-attach' }
  | { readonly kind: 'arrow-detach' }
  /** The arrow flies (arrowRelease). */
  | { readonly kind: 'arrow-release' }
  /** The attack is over (attackStop). */
  | { readonly kind: 'attack-end' }
  /** A paired killmove's victim dies now (its graph's 2_KillActor). */
  | { readonly kind: 'kill-actor' }
  /**
   * Its killmove ends (KillMoveEnd; the victim's 2_KillMoveEnd): the victim dies by its
   * killer now if it has not yet, and both are in it no more.
   */
  | { readonly kind: 'killmove-end' }
  /** A decapitating killmove's victim loses its head now (its graph's 2_Decapitate). */
  | { readonly kind: 'decapitate' }
  /** The paired animation is over (PairEnd, pairedStop). */
  | { readonly kind: 'pair-end' }
  /** It got up from bleeding out (bleedOutStop's state left). */
  | { readonly kind: 'bleedout-end' };

const lower = (event: string): string => event.toLowerCase();

/** The attack data events of ranged attacks. */
const RANGED_STARTS = new Set([
  'bowattackstart',
  'crossbowattackstart',
  'crossbowdwarvenattackstart',
]);

/** An attack starts (its event sent to the graph). */
export function startAttack(
  state: CombatState,
  attack: Omit<CurrentAttack, 'struck' | 'ranged' | 'killMove'>,
): void {
  const event = lower(attack.event);
  const ranged = RANGED_STARTS.has(event);
  state.current = {
    ...attack,
    ranged,
    killMove: event.startsWith('pa_kill'),
    struck: new Set(),
  };
  state.attack = ranged ? AttackState.bowDraw : attack.bash ? AttackState.bash : AttackState.draw;
  state.blocking = attack.bash ? state.blocking : false;
}

/**
 * The engine handler classes the combat state answers (their names in the response files,
 * meshes\responses\actorresponse.txt: weaponSwing : WeaponRightSwingHandler, AttackWinStart and
 * AttackWinStartLeft : AttackWinStartHandler, attackStop and bashStop : AttackStopHandler).
 */
export const COMBAT_HANDLERS = [
  'RightHandWeaponDrawHandler',
  'RightHandWeaponSheatheHandler',
  'WeaponBeginDrawRightHandler',
  'WeaponBeginSheatheRightHandler',
  'AnticipateAttackHandler',
  'WeaponRightSwingHandler',
  'WeaponLeftSwingHandler',
  'HitFrameHandler',
  'AttackWinStartHandler',
  'AttackWinEndHandler',
  'AttackStopHandler',
  'ArrowAttachHandler',
  'ArrowDetachHandler',
  'ArrowReleaseHandler',
  'BowDrawnHandler',
  'BowReleaseHandler',
  'StaggeredStopHandler',
  'RecoilStopHandler',
  'PairedStopHandler',
  'KillMoveStartHandler',
  'KillMoveEndHandler',
] as const;

/**
 * The graph raised an event (an annotation of a clip, a trigger): the state moves on, and what
 * the engine has to do comes back. `handler` is the engine handler class the response files
 * give the event (src/animation/graph-events.ts); events they name none for are the actor's own
 * (WeapEquip_Out, blockStop, bowEnd: by their name).
 */
export function graphEvent(state: CombatState, event: string, handler?: string): CombatEffect[] {
  const effects: CombatEffect[] = [];
  const ranged = state.current?.ranged === true;
  if (handler !== undefined) {
    switch (handler.toLowerCase()) {
      // Drawing and sheathing (1HM_Equip: BeginWeaponDraw, weaponDraw at 0.6 s, WeapEquip_Out
      // at its end). Observed in the original: the begin handlers sound the right hand's
      // weapon's equip or unequip sound; weaponDraw's puts the weapons in the hands.
      case 'weaponbegindrawrighthandler':
        effects.push({ kind: 'draw-begin' });
        break;
      case 'weaponbeginsheatherighthandler':
        effects.push({ kind: 'sheathe-begin' });
        break;
      case 'righthandweapondrawhandler':
        effects.push({ kind: 'hand' });
        break;
      case 'righthandweaponsheathehandler':
        effects.push({ kind: 'sheath' });
        break;
      // A melee attack: wind-up, swing, the hit, the window for the next, the follow-through.
      case 'anticipateattackhandler':
        if (state.current && !ranged && state.attack !== AttackState.bash) {
          state.attack = AttackState.swing;
        }
        break;
      // Observed in the original: a hand's swing sets the attack state to swinging and
      // sounds that hand's weapon's swing (the left hand's for weaponLeftSwing: dual wielding).
      case 'weaponrightswinghandler':
      case 'weaponleftswinghandler':
        if (state.current && !ranged) {
          if (state.attack !== AttackState.bash) state.attack = AttackState.swing;
          const left = handler.toLowerCase() === 'weaponleftswinghandler';
          effects.push({ kind: 'swing', hand: left ? 'left' : 'right' });
        }
        break;
      // A killmove's clip strikes its victim at its hit frames too (observed in the
      // original: the handler strikes whether an attack is under way or not).
      case 'hitframehandler':
        if (state.current && !ranged) {
          if (state.attack !== AttackState.bash) state.attack = AttackState.hit;
          effects.push({ kind: 'strike' });
        } else if (!state.current && state.killMove && state.paired === 'lead') {
          effects.push({ kind: 'strike' });
        }
        break;
      // AttackWinStart and AttackWinStartLeft (the left hand's attacks) share their handlers:
      // the next attack's window opens (a bow's next shot), then the follow-through.
      case 'attackwinstarthandler':
        if (state.current) {
          state.attack = ranged ? AttackState.bowNextAttack : AttackState.nextAttack;
        }
        break;
      case 'attackwinendhandler':
        if (state.current) {
          state.attack = ranged ? AttackState.bowFollowThrough : AttackState.followThrough;
        }
        break;
      // A bow: nocked, drawn, loosed (bowReset takes the arrow off as arrowDetach does).
      case 'arrowattachhandler':
        state.arrowNocked = true;
        if (ranged) state.attack = AttackState.bowAttached;
        effects.push({ kind: 'arrow-attach' });
        break;
      case 'bowdrawnhandler':
        if (ranged) state.attack = AttackState.bowDrawn;
        break;
      case 'bowreleasehandler':
        if (ranged) state.attack = AttackState.bowReleasing;
        break;
      case 'arrowreleasehandler':
        if (ranged && state.arrowNocked) {
          state.attack = AttackState.bowReleased;
          state.arrowNocked = false;
          effects.push({ kind: 'arrow-release' });
        }
        break;
      case 'arrowdetachhandler':
        if (state.arrowNocked) {
          state.arrowNocked = false;
          effects.push({ kind: 'arrow-detach' });
        }
        break;
      // attackStop and bashStop.
      case 'attackstophandler':
        endAttack(state, effects);
        break;
      // Staggers and recoils end.
      case 'staggeredstophandler':
        state.staggered = false;
        break;
      case 'recoilstophandler':
        state.recoiling = false;
        break;
      case 'pairedstophandler':
        endPaired(state, effects);
        break;
      // Observed in the original: KillMoveStart's handler does nothing (the killmove was
      // marked as it began); KillMoveEnd's ends it (IsInKillMove), its victim killed by its
      // killer.
      case 'killmovestarthandler':
        break;
      case 'killmoveendhandler':
        state.killMove = false;
        effects.push({ kind: 'killmove-end' });
        break;
      default:
        break;
    }
    return effects;
  }
  switch (lower(event)) {
    // Magic drawn: MRh_and_MLh_Equip raises weaponDraw, then Magic_Equip_Out (0_master.hkx).
    case 'weapequip_out':
    case 'magic_equip_out':
      if (state.weapon === WeaponState.drawing || state.weapon === WeaponState.wantToDraw) {
        state.weapon = WeaponState.drawn;
      }
      break;
    // Magic put away: weaponSheathe, then Magic_Unequip_Out.
    case 'unequip_out':
    case 'magic_unequip_out':
      if (state.weapon === WeaponState.sheathing || state.weapon === WeaponState.wantToSheathe) {
        state.weapon = WeaponState.sheathed;
      }
      break;
    case 'bowend':
      endAttack(state, effects);
      break;
    // Blocking (blockStart's state; blockStop leaves it).
    case 'blockstartout':
      state.blocking = state.wantBlocking;
      break;
    case 'blockstop':
      state.blocking = false;
      break;
    // Paired animations: the side done to hears its partner's events with "2_" (only its graph
    // raises them; a clip's last frame may raise its 2_PairEnd before its 2_KillActor).
    case '2_killactor':
      effects.push({ kind: 'kill-actor' });
      break;
    case '2_decapitate':
      effects.push({ kind: 'decapitate' });
      break;
    case '2_killmoveend':
      if (state.killMove) {
        state.killMove = false;
        effects.push({ kind: 'killmove-end' });
      }
      break;
    case 'pairend':
    case '2_pairend':
      endPaired(state, effects);
      break;
    case 'bleedout_transoutend':
      if (state.life === LifeState.bleedout || state.life === LifeState.essentialDown) {
        state.life = LifeState.alive;
        state.bleedingFor = 0;
        effects.push({ kind: 'bleedout-end' });
      }
      break;
    default:
      break;
  }
  return effects;
}

/** The attack is over (attackStop, bashStop, bowEnd). */
function endAttack(state: CombatState, effects: CombatEffect[]): void {
  if (!state.current) return;
  state.current = undefined;
  state.attack = AttackState.none;
  state.drawnFor = 0;
  effects.push({ kind: 'attack-end' });
}

/**
 * The paired animation is over (pairedStop, PairEnd). A killmove is not (observed in the
 * original: IsInKillMove ends at KillMoveEnd or at the killmove's timer).
 */
function endPaired(state: CombatState, effects: CombatEffect[]): void {
  if (state.paired === undefined) return;
  state.paired = undefined;
  effects.push({ kind: 'pair-end' });
}

/** Whether a weapon (or magic) is out: drawing, drawn, or on its way back. */
export function weaponOut(state: CombatState): boolean {
  return state.weapon !== WeaponState.sheathed;
}

/** Whether it is attacking (IsAttacking: from the attack's start to its end). */
export function attacking(state: CombatState): boolean {
  return state.current !== undefined;
}

/** Whether it bleeds out (essential down or bleeding out). */
export function bleedingOut(state: CombatState): boolean {
  return state.life === LifeState.bleedout || state.life === LifeState.essentialDown;
}

/**
 * Whether it can act (attack, draw, block): alive, on its feet, not staggered, recoiling,
 * bleeding out or in a paired animation.
 */
export function canAct(state: CombatState): boolean {
  return (
    state.life === LifeState.alive &&
    state.knock === KnockState.normal &&
    !state.staggered &&
    !state.recoiling &&
    state.paired === undefined
  );
}
