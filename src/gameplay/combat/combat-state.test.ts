import { describe, expect, it } from 'vitest';
import { AttackSet, attackEventKind } from './attacks.ts';
import {
  AttackState,
  WeaponState,
  attacking,
  canAct,
  graphEvent,
  newCombatState,
  startAttack,
  weaponOut,
} from './combat-state.ts';
import { AttackFlag, type AttackData } from '../../ai/race-combat-records.ts';
import { ARROW_TILT, WORLD_GRAVITY, fly, launch, pointing, spent, tiltUp } from './projectile.ts';

/** The engine handlers of the events these tests raise (as the response files map them). */
const HANDLERS: Readonly<Record<string, string>> = {
  beginweapondraw: 'WeaponBeginDrawRightHandler',
  beginweaponsheathe: 'WeaponBeginSheatheRightHandler',
  weapondraw: 'RightHandWeaponDrawHandler',
  weaponsheathe: 'RightHandWeaponSheatheHandler',
  prehitframe: 'AnticipateAttackHandler',
  weaponswing: 'WeaponRightSwingHandler',
  weaponleftswing: 'WeaponLeftSwingHandler',
  hitframe: 'HitFrameHandler',
  attackwinstart: 'AttackWinStartHandler',
  attackwinstartleft: 'AttackWinStartHandler',
  attackwinend: 'AttackWinEndHandler',
  attackwinendleft: 'AttackWinEndHandler',
  attackstop: 'AttackStopHandler',
  bashstop: 'AttackStopHandler',
  arrowattach: 'ArrowAttachHandler',
  arrowdetach: 'ArrowDetachHandler',
  bowreset: 'ArrowDetachHandler',
  arrowrelease: 'ArrowReleaseHandler',
  bowdrawn: 'BowDrawnHandler',
  bowrelease: 'BowReleaseHandler',
  staggerstop: 'StaggeredStopHandler',
  recoilstop: 'RecoilStopHandler',
  pairedstop: 'PairedStopHandler',
  killmovestart: 'KillMoveStartHandler',
  killmoveend: 'KillMoveEndHandler',
};

const effectsOf = (events: string[], state = newCombatState()) =>
  events.flatMap((event) => graphEvent(state, event, HANDLERS[event.toLowerCase()]));

const kinds = (events: string[], state = newCombatState()): string[] =>
  effectsOf(events, state).map((effect) => effect.kind);

describe('the combat state', () => {
  it('draws at weaponDraw and is drawn at WeapEquip_Out (1HM_Equip), sheathes back', () => {
    const state = newCombatState();
    state.weapon = WeaponState.drawing;
    expect(weaponOut(state)).toBe(true);
    expect(kinds(['weaponDraw'], state)).toEqual(['hand']);
    expect(state.weapon).toBe(WeaponState.drawing);
    kinds(['WeapEquip_Out'], state);
    expect(state.weapon).toBe(WeaponState.drawn);
    state.weapon = WeaponState.sheathing;
    expect(kinds(['weaponSheathe', 'Unequip_Out'], state)).toEqual(['sheath']);
    expect(state.weapon).toBe(WeaponState.sheathed);
  });

  it('draws magic (MRh_and_MLh_Equip: Magic_Equip_Out) and puts it away (Magic_Unequip_Out)', () => {
    const state = newCombatState();
    state.weapon = WeaponState.drawing;
    expect(kinds(['weaponDraw', 'Magic_Equip_Out'], state)).toEqual(['hand']);
    expect(state.weapon).toBe(WeaponState.drawn);
    state.weapon = WeaponState.sheathing;
    expect(kinds(['weaponSheathe', 'Magic_Unequip_Out'], state)).toEqual(['sheath']);
    expect(state.weapon).toBe(WeaponState.sheathed);
  });

  it('goes through an attack as its annotations come (GetAttackState)', () => {
    const state = newCombatState();
    startAttack(state, { event: 'attackStart', hand: 'right', power: false, bash: false });
    expect(state.attack).toBe(AttackState.draw);
    expect(attacking(state)).toBe(true);
    expect(kinds(['preHitFrame', 'weaponSwing'], state)).toEqual(['swing']);
    expect(state.attack).toBe(AttackState.swing);
    expect(kinds(['HitFrame'], state)).toEqual(['strike']);
    expect(state.attack).toBe(AttackState.hit);
    kinds(['AttackWinStart'], state);
    expect(state.attack).toBe(AttackState.nextAttack);
    expect(kinds(['attackStop'], state)).toEqual(['attack-end']);
    expect(state.attack).toBe(AttackState.none);
    expect(attacking(state)).toBe(false);
  });

  it('keeps a bash in its own state and strikes at its hit frame', () => {
    const state = newCombatState();
    startAttack(state, { event: 'bashStart', hand: 'right', power: false, bash: true });
    expect(state.attack).toBe(AttackState.bash);
    expect(kinds(['HitFrame'], state)).toEqual(['strike']);
    expect(state.attack).toBe(AttackState.bash);
  });

  it('nocks, draws and looses an arrow (the bow states 8..12)', () => {
    const state = newCombatState();
    startAttack(state, { event: 'bowAttackStart', hand: 'right', power: false, bash: false });
    expect(state.attack).toBe(AttackState.bowDraw);
    expect(kinds(['arrowAttach'], state)).toEqual(['arrow-attach']);
    expect(state.attack).toBe(AttackState.bowAttached);
    kinds(['bowDrawn'], state);
    expect(state.attack).toBe(AttackState.bowDrawn);
    kinds(['BowRelease'], state);
    expect(state.attack).toBe(AttackState.bowReleasing);
    expect(kinds(['arrowRelease'], state)).toEqual(['arrow-release']);
    expect(state.attack).toBe(AttackState.bowReleased);
    // A bow does not strike at a hit frame.
    expect(kinds(['HitFrame'], state)).toEqual([]);
  });

  it('cannot act while staggered or in a paired animation, until it ends', () => {
    const state = newCombatState();
    state.staggered = true;
    expect(canAct(state)).toBe(false);
    kinds(['staggerStop'], state);
    expect(canAct(state)).toBe(true);
    state.paired = 'support';
    expect(kinds(['2_KillActor', '2_PairEnd'], state)).toEqual(['kill-actor', 'pair-end']);
    expect(state.paired).toBeUndefined();
  });

  it("swings the left hand's weapon at weaponLeftSwing, its window by AttackWin*Left", () => {
    const state = newCombatState();
    startAttack(state, { event: 'attackStartLeftHand', hand: 'left', power: false, bash: false });
    expect(effectsOf(['weaponLeftSwing'], state)).toEqual([{ kind: 'swing', hand: 'left' }]);
    expect(state.attack).toBe(AttackState.swing);
    kinds(['AttackWinStartLeft'], state);
    expect(state.attack).toBe(AttackState.nextAttack);
    kinds(['AttackWinEndLeft'], state);
    expect(state.attack).toBe(AttackState.followThrough);
    // The right hand's swing sounds the right weapon.
    startAttack(state, { event: 'attackStart', hand: 'right', power: false, bash: false });
    expect(effectsOf(['weaponSwing'], state)).toEqual([{ kind: 'swing', hand: 'right' }]);
  });

  it('sounds the draw and the sheathing as they begin (BeginWeaponDraw, BeginWeaponSheathe)', () => {
    expect(kinds(['BeginWeaponDraw', 'weaponDraw'])).toEqual(['draw-begin', 'hand']);
    expect(kinds(['BeginWeaponSheathe', 'weaponSheathe'])).toEqual(['sheathe-begin', 'sheath']);
  });

  it('answers by the handler the response files give, not by the event name', () => {
    const state = newCombatState();
    startAttack(state, { event: 'attackStart', hand: 'right', power: false, bash: false });
    // An event remapped to no handler does nothing; another remapped to the swing swings.
    expect(graphEvent(state, 'weaponSwing', 'SomeOtherHandler')).toEqual([]);
    expect(graphEvent(state, 'myEvent', 'WeaponRightSwingHandler')).toEqual([
      { kind: 'swing', hand: 'right' },
    ]);
    // bowReset takes the arrow off as arrowDetach does.
    state.arrowNocked = true;
    expect(kinds(['bowReset'], state)).toEqual(['arrow-detach']);
  });

  it('is in a killmove until KillMoveEnd (KillMoveStart changes nothing)', () => {
    const state = newCombatState();
    state.paired = 'lead';
    state.killMove = true;
    kinds(['KillMoveStart'], state);
    expect(state.killMove).toBe(true);
    kinds(['KillMoveEnd'], state);
    expect(state.killMove).toBe(false);
    expect(state.paired).toBe('lead');
    state.killMove = true;
    expect(kinds(['pairedStop'], state)).toEqual(['pair-end']);
    expect(state.killMove).toBe(false);
  });
});

const attack = (event: string, flags: number, damageMult = 1): AttackData => ({
  event,
  damageMult,
  attackChance: 1,
  spell: undefined,
  flags,
  attackAngle: 0,
  strikeAngle: 35,
  stagger: 0,
  attackType: undefined,
  knockdown: 0,
  recoveryTime: 0,
  staminaMult: 1,
});

describe('attack data', () => {
  it("takes the actor's own over its race's, by event", () => {
    const set = new AttackSet(
      [attack('attackStart', 0), attack('bashStart', AttackFlag.bashAttack, 0.5)],
      [attack('AttackStart', 0, 1.5)],
    );
    expect(set.of('attackstart')?.damageMult).toBe(1.5);
    expect(set.of('bashStart')?.damageMult).toBe(0.5);
    expect(set.of('blockStart')).toBeUndefined();
  });

  it('tells power attacks, bashes and left-hand attacks', () => {
    expect(
      attackEventKind('x', attack('x', AttackFlag.powerAttack | AttackFlag.leftAttack)),
    ).toEqual({
      power: true,
      bash: false,
      left: true,
    });
    expect(attackEventKind('pa_KillMoveB', undefined)?.power).toBe(true);
    expect(attackEventKind('bowAttackStart', undefined)).toEqual({
      power: false,
      bash: false,
      left: false,
    });
    expect(attackEventKind('blockStart', undefined)).toBeUndefined();
  });
});

describe('arrows in flight', () => {
  it('fly at their speed and fall under the PROJ gravity times the world', () => {
    const flight = launch([0, 0, 100], [0, 1, 0], 3600);
    for (let i = 0; i < 60; i++) fly(flight, 1 / 60, 0.35 * WORLD_GRAVITY);
    expect(flight.position[1]).toBeCloseTo(3600, 0);
    // About ½ g t² after a second (the step makes it a little more).
    expect(100 - flight.position[2]).toBeGreaterThan(115);
    expect(100 - flight.position[2]).toBeLessThan(125);
    expect(spent(flight, 3000, 0)).toBe(true);
    expect(pointing(flight.velocity).pitch).toBeLessThan(0);
  });

  it('are tilted up as loosed and slower when partly drawn', () => {
    const aim = tiltUp([0, 1, 0], ARROW_TILT.thirdPerson);
    expect(Math.atan2(aim[2], aim[1]) * (180 / Math.PI)).toBeCloseTo(2.5);
    const weak = launch([0, 0, 0], [0, 1, 0], 3600, 0.5);
    expect(weak.velocity[1]).toBeCloseTo(1800);
  });
});
