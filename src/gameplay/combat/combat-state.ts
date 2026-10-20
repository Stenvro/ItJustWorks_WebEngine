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
  /** A paired killmove (pa_...). */
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
  /** The swing's sound (weaponSwing). */
  | { readonly kind: 'swing' }
  /** The strike lands now: its targets are looked for (HitFrame). */
  | { readonly kind: 'strike' }
  /** An arrow appears on the string (arrowAttach) or leaves the hand (arrowDetach). */
  | { readonly kind: 'arrow-attach' }
  | { readonly kind: 'arrow-detach' }
  /** The arrow flies (arrowRelease). */
  | { readonly kind: 'arrow-release' }
  /** The attack is over (attackStop). */
  | { readonly kind: 'attack-end' }
  /** A paired killmove's victim dies now (its graph's KillActor). */
  | { readonly kind: 'kill-actor' }
  /** The paired animation is over (PairEnd, pairedStop). */
  | { readonly kind: 'pair-end' }
  /** It got up from bleeding out (bleedOutStop's state left). */
  | { readonly kind: 'bleedout-end' };

const lower = (event: string): string => event.toLowerCase();

/** The attack data events of ranged attacks. */
const RANGED_STARTS = new Set(['bowattackstart', 'crossbowattackstart', 'crossbowdwarvenattackstart']);

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
    killMove: event.startsWith('pa_'),
    struck: new Set(),
  };
  state.attack = ranged
    ? AttackState.bowDraw
    : attack.bash
      ? AttackState.bash
      : AttackState.draw;
  state.blocking = attack.bash ? state.blocking : false;
}

/**
 * The graph raised an event (an annotation of a clip, a trigger): the state moves on, and what
 * the engine has to do comes back.
 */
export function graphEvent(state: CombatState, event: string): CombatEffect[] {
  const effects: CombatEffect[] = [];
  const ranged = state.current?.ranged === true;
  switch (lower(event)) {
    // Drawing and sheathing (1HM_Equip: weaponDraw at 0.6 s, WeapEquip_Out at its end).
    case 'weapondraw':
      effects.push({ kind: 'hand' });
      break;
    case 'weapequip_out':
      if (state.weapon === WeaponState.drawing || state.weapon === WeaponState.wantToDraw) {
        state.weapon = WeaponState.drawn;
      }
      break;
    case 'weaponsheathe':
      effects.push({ kind: 'sheath' });
      break;
    case 'unequip_out':
      if (state.weapon === WeaponState.sheathing || state.weapon === WeaponState.wantToSheathe) {
        state.weapon = WeaponState.sheathed;
      }
      break;
    // A melee attack: wind-up, swing, the hit, the window for the next, the follow-through.
    case 'prehitframe':
      if (state.current && !ranged && state.attack !== AttackState.bash) {
        state.attack = AttackState.swing;
      }
      break;
    case 'weaponswing':
      if (state.current && !ranged) effects.push({ kind: 'swing' });
      break;
    case 'hitframe':
      if (state.current && !ranged) {
        if (state.attack !== AttackState.bash) state.attack = AttackState.hit;
        effects.push({ kind: 'strike' });
      }
      break;
    case 'attackwinstart':
      if (state.current) {
        state.attack = ranged ? AttackState.bowNextAttack : AttackState.nextAttack;
      }
      break;
    case 'attackwinend':
      if (state.current) {
        state.attack = ranged ? AttackState.bowFollowThrough : AttackState.followThrough;
      }
      break;
    // A bow: nocked, drawn, loosed.
    case 'arrowattach':
      state.arrowNocked = true;
      if (ranged) state.attack = AttackState.bowAttached;
      effects.push({ kind: 'arrow-attach' });
      break;
    case 'bowdrawn':
      if (ranged) state.attack = AttackState.bowDrawn;
      break;
    case 'bowrelease':
      if (ranged) state.attack = AttackState.bowReleasing;
      break;
    case 'arrowrelease':
      if (ranged && state.arrowNocked) {
        state.attack = AttackState.bowReleased;
        state.arrowNocked = false;
        effects.push({ kind: 'arrow-release' });
      }
      break;
    case 'arrowdetach':
      if (state.arrowNocked) {
        state.arrowNocked = false;
        effects.push({ kind: 'arrow-detach' });
      }
      break;
    case 'attackstop':
    case 'bashstop':
    case 'bowend':
      if (state.current) {
        state.current = undefined;
        state.attack = AttackState.none;
        state.drawnFor = 0;
        effects.push({ kind: 'attack-end' });
      }
      break;
    // Blocking (blockStart's state; blockStop leaves it).
    case 'blockstartout':
      state.blocking = state.wantBlocking;
      break;
    case 'blockstop':
      state.blocking = false;
      break;
    // Staggers and recoils end.
    case 'staggerstop':
      state.staggered = false;
      break;
    case 'recoilstop':
      state.recoiling = false;
      break;
    // Paired animations.
    case 'killactor':
    case '2_killactor':
      if (state.paired === 'support') effects.push({ kind: 'kill-actor' });
      break;
    case 'pairend':
    case '2_pairend':
    case 'pairedstop':
      if (state.paired !== undefined) {
        state.paired = undefined;
        effects.push({ kind: 'pair-end' });
      }
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
