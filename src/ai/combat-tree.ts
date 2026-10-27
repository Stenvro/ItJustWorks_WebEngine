// The combat behaviour tree (docs/ai.md, "The combat behaviour tree"): the original's combat is
// a tree built in code, its subtrees named in the executable (CombatBehaviorTree{Combat, Melee,
// Ranged, Magic, Shout, Block, UsePotion, CloseMovement, FlankingMovement, RangedMovement,
// Movement, FindAttackLocation, UseCover, Hide, DodgeThreat, CheckUnreachableTarget, ExitWater,
// ReturnToCombatArea, LowCombat, ...}). Here it is data for the runtime in behaviour-tree.ts:
//
// - Combat, the root: Flee while it flees (Flee To Ally, away, cower; back to the fight once
//   cornered), else Dodge Threat (a dodge stops the rest while it runs), else, side by side, the
//   equipment's actions, the movement priority list and the taunts.
// - Equipment (Action Equipment Selector): one subtree per slot that holds something, in
//   parallel: the right hand (Melee, Ranged or Magic), the left hand (Magic, or a weapon's left
//   attacks), shield and weapon (Block), spell and weapon (the left hand's Magic beside a
//   weapon), dual (Prepare Dual Cast), the voice (Shout) and Use Potion.
// - Movement, a priority list in the engine's order (the first whose condition holds runs, the
//   higher ones stop the lower): Essential Down, Hide, Return To Combat Area, Exit Water,
//   Acquire Weapon, Check Unreachable Target, Ranged Movement (Use Cover first), Flanking
//   Movement, Close Movement (Fallback To Ranged, the chase, the Close Movement selector).
// - Low Combat, the low process's root: Flee, Attack Low, Pursue, Search.
//
// The leaves are names: the values (CombatValue) and actions (CombatAction) the AI gives
// (src/shell/actor-combat-ai.ts), weighted by its combat style (CSTY) and the fCombat* settings.
// Where the engine's rule is not read, the version here is marked TODO(M13).
// Platform-independent.

import type { Expr, NodeSpec, TreeAction, TreeRegistry } from './behaviour-tree.ts';

/** The values the combat tree reads (conditions, chances, times). */
export const COMBAT_VALUES = [
  // The equipment slots.
  'rightMelee',
  'rightBow',
  'rightMagic',
  'leftShield',
  'leftWeapon',
  'leftMagic',
  'dualCast',
  'voiceShout',
  'canBlock',
  // The movement list's conditions.
  'tethered',
  'targetBeyondLeash',
  'inWater',
  'essentialDown',
  'mayAcquireWeapon',
  'unseen',
  'unreachable',
  'hasRangedOption',
  'rangedMovement',
  'mayUseCover',
  'flanking',
  'farAway',
  'beyondRange',
  'outOfRange',
  'outOfPosition',
  'mayChooseRun',
  // Melee.
  'mayAttack',
  'mayAttackLeft',
  'specialAttackChance',
  // Ranged.
  'shotHeld',
  'shotOverheld',
  'shotInArc',
  'mayDraw',
  'rangedAttackChance',
  'rangedUnready',
  // Magic and shouts.
  'mayCast',
  'mayCastLeft',
  'concentration',
  'castChance',
  'castChanceLeft',
  'dualCastChance',
  'mayShout',
  // Block.
  'blocking',
  'blockOver',
  'blowComing',
  'blockChance',
  'blockAttackChance',
  'mayBlockAttack',
  // Flee.
  'fleeing',
  'cornered',
  'fleeSafe',
  'allyNear',
  // Low Combat (the low process's tree).
  'lowInReach',
  'groupSearching',
  // Support.
  'maySupport',
  // The style's movement chances.
  'fallbackChance',
  'circleChance',
  'circleDistantChance',
  'backoffChance',
  // Idles.
  'attackIdle',
  'shoutIdle',
  'mayTaunt',
] as const;
export type CombatValue = (typeof COMBAT_VALUES)[number];

/** The actions (the tree's leaves) the AI performs. */
export const COMBAT_ACTIONS = [
  'dodgeThreat',
  'returnToCombatArea',
  'holdPosition',
  'exitWater',
  'hide',
  'fallbackToRanged',
  // Use Cover.
  'findCover',
  'waitBehindCover',
  'attackFromCover',
  // Acquire Weapon.
  'findWeapon',
  'moveToWeapon',
  'pickUpWeapon',
  // Low Combat, Search.
  'pursue',
  'attackLow',
  'search',
  'chase',
  'trackRun',
  'decideRun',
  'driveRun',
  'maintainOptimalRange',
  // Close movement behaviours.
  'advance',
  'surround',
  'circleDistant',
  'reposition',
  'circle',
  'fallback',
  'backoff',
  'closeIdle',
  'flankingManeuver',
  'flank',
  'stalk',
  // Melee.
  'chooseAttack',
  'attack',
  'powerAttack',
  'bash',
  'powerBash',
  'specialAttack',
  'offensiveBash',
  'leftAttack',
  // Ranged.
  'drawShot',
  'releaseShot',
  'cancelShot',
  'equipRanged',
  // Magic, shouts.
  'castRight',
  'castLeft',
  'castConcentration',
  'prepareDualCast',
  'castShout',
  // Block.
  'noteBlow',
  'block',
  'releaseBlock',
  'noteBlockAttack',
  'blockAttack',
  'holdBlock',
  // Flee.
  'fightCornered',
  'stopFleeing',
  'fleeToAlly',
  'fleeThroughDoor',
  'fleeToCover',
  'fleeAway',
  'cower',
  // Support, voice.
  'support',
  'taunt',
] as const;
export type CombatAction = (typeof COMBAT_ACTIONS)[number];

/** The attack the melee chooser picked (blackboard data "attack"): its child's index. */
export const AttackPick = {
  none: -1,
  attack: 0,
  power: 1,
  bash: 2,
  powerBash: 3,
  special: 4,
  offensiveBash: 5,
} as const;

const v = (value: CombatValue): Expr => ({ value });
const and = (a: Expr, b: Expr): Expr => ({ op: '&&', a, b });
const or = (a: Expr, b: Expr): Expr => ({ op: '||', a, b });
const not = (a: Expr): Expr => ({ not: a });
const act = (action: CombatAction): NodeSpec => ({ node: 'action', action });
const when = (test: Expr, child: NodeSpec): NodeSpec => ({ node: 'conditional', if: test, child });
const watch = (test: Expr, child: NodeSpec): NodeSpec => ({
  node: 'dynamicConditional',
  if: test,
  child,
});
const seq = (...children: NodeSpec[]): NodeSpec => ({ node: 'sequence', children });
const first = (...children: NodeSpec[]): NodeSpec => ({ node: 'fallbackSelector', children });
/** A priority list: checked from the top each tick (a chase ends once the target is near). */
const pick = (...children: NodeSpec[]): NodeSpec => ({ node: 'dynamicSelector', children });
const link = (tree: string): NodeSpec => ({ node: 'link', tree });
const chance = (p: Expr, child: NodeSpec, otherwise?: NodeSpec): NodeSpec =>
  otherwise
    ? { node: 'random', chance: p, child, otherwise }
    : { node: 'random', chance: p, child };
const ok = (child: NodeSpec): NodeSpec => ({ node: 'forceSuccess', child });
const test = (value: Expr): NodeSpec => ({ node: 'value', value });

/**
 * The Close Movement selector (observed in the original; combat-movement.ts chooseCloseMovement): out of
 * range Advance, Surround, Circle Distant (by its chance); out of position Reposition, Surround
 * (Find Attack Location); in range Fallback or Circle (the style's chances), Backoff
 * (fCombatBackoffChance); else the Close Movement Idle. The first whose goal is found runs.
 */
export const CLOSE_MOVEMENT_SELECTOR: NodeSpec = first(
  when(
    v('outOfRange'),
    first(
      act('advance'),
      act('surround'),
      chance(v('circleDistantChance'), act('circleDistant')),
      act('closeIdle'),
    ),
  ),
  when(v('outOfPosition'), first(link('FindAttackLocation'), act('closeIdle'))),
  first(
    chance(v('fallbackChance'), act('fallback'), chance(v('circleChance'), act('circle'))),
    chance(v('backoffChance'), act('backoff')),
    act('closeIdle'),
  ),
);

/** A melee hand's attack: the chooser, then the attack it picked; then the attack idle. */
function melee(): NodeSpec {
  return seq(
    test(v('mayAttack')),
    ok(
      seq(act('chooseAttack'), {
        node: 'childSelector',
        choose: { data: 'attack' },
        children: [
          act('attack'),
          act('powerAttack'),
          act('bash'),
          act('powerBash'),
          act('specialAttack'),
          act('offensiveBash'),
        ],
      }),
    ),
    { node: 'idle', seconds: v('attackIdle') },
  );
}

/** A hand's spell: a concentration spell held, else an immediate one, by its cast chance. */
function magic(hand: 'castRight' | 'castLeft'): NodeSpec {
  const left = hand === 'castLeft';
  const castChance = v(left ? 'castChanceLeft' : 'castChance');
  return seq(
    test(v(left ? 'mayCastLeft' : 'mayCast')),
    ok(
      first(
        ...(left
          ? []
          : [seq(test(v('concentration')), chance(castChance, act('castConcentration')))]),
        chance(castChance, act(hand)),
      ),
    ),
    { node: 'idle', seconds: v('attackIdle') },
  );
}

/**
 * Dual: one spell in both hands, dual cast by fCombatMagicDualCastChance, else cast single by its
 * cast chance (the right hand's Magic gives way to it).
 */
const DUAL: NodeSpec = seq(
  test(v('mayCast')),
  ok(
    first(
      chance(v('dualCastChance'), act('prepareDualCast')),
      chance(v('castChance'), act('castRight')),
    ),
  ),
  { node: 'idle', seconds: v('attackIdle') },
);

/** The combat tree's subtrees, by name. */
export const COMBAT_TREES: Readonly<Record<string, NodeSpec>> = {
  Combat: {
    node: 'dynamicSelector',
    children: [
      // Fleeing (its strength ratio below its confidence's: combat-ai.ts shouldFlee).
      watch(v('fleeing'), link('Flee')),
      link('DodgeThreat'),
      {
        node: 'spawnParallel',
        children: [link('Equipment'), link('Movement'), seq(test(v('mayTaunt')), act('taunt'))],
      },
    ],
  },
  DodgeThreat: act('dodgeThreat'),
  Equipment: {
    node: 'equipment',
    slots: [
      { slot: 'right', when: v('rightMelee'), child: link('Melee') },
      { slot: 'right', when: v('rightBow'), child: link('Ranged') },
      { slot: 'right', when: and(v('rightMagic'), not(v('dualCast'))), child: link('Magic') },
      {
        slot: 'left',
        when: and(v('leftWeapon'), not(v('leftShield'))),
        child: seq(test(v('mayAttackLeft')), act('leftAttack'), {
          node: 'idle',
          seconds: v('attackIdle'),
        }),
      },
      { slot: 'left', when: and(v('leftMagic'), not(v('rightMelee'))), child: link('MagicLeft') },
      {
        slot: 'shieldAndWeapon',
        when: and(v('rightMelee'), v('canBlock')),
        child: link('Block'),
      },
      {
        slot: 'spellAndWeapon',
        when: and(v('leftMagic'), v('rightMelee')),
        child: link('MagicLeft'),
      },
      {
        slot: 'dual',
        when: v('dualCast'),
        child: { node: 'context', context: 'magic', child: DUAL },
      },
      { slot: 'voice', when: v('voiceShout'), child: link('Shout') },
      { slot: 'potion', when: true, child: link('UsePotion') },
    ],
  },
  Melee: { node: 'context', context: 'melee', child: melee() },
  Ranged: {
    node: 'context',
    context: 'ranged',
    child: first(
      seq(test(v('rangedUnready')), act('equipRanged')),
      // Held its hold time: loosed within the firing arc, let down held too long.
      seq(
        test(v('shotHeld')),
        first(
          seq(test(v('shotOverheld')), act('cancelShot')),
          seq(test(v('shotInArc')), act('releaseShot')),
        ),
        { node: 'idle', seconds: v('attackIdle') },
      ),
      // A new draw by its ranged attack chance; the ranged attack idle either way.
      seq(test(v('mayDraw')), ok(chance(v('rangedAttackChance'), act('drawShot'))), {
        node: 'idle',
        seconds: v('attackIdle'),
      }),
    ),
  },
  Magic: { node: 'context', context: 'magic', child: magic('castRight') },
  MagicLeft: { node: 'context', context: 'magic', child: magic('castLeft') },
  Shout: seq(test(v('mayShout')), act('castShout'), { node: 'idle', seconds: v('shoutIdle') }),
  Block: {
    node: 'context',
    context: 'block',
    child: first(
      // Blocking: held (sustained while its target stays near) until its block time ran out or
      // its target is gone or backs off; meanwhile the block attack, the shield bash out of the
      // block, by its block attack chance once per opening.
      seq(
        test(v('blocking')),
        first(
          seq(test(v('blockOver')), act('releaseBlock')),
          seq(
            test(v('mayBlockAttack')),
            act('noteBlockAttack'),
            chance(v('blockAttackChance'), act('blockAttack')),
          ),
          ok(act('holdBlock')),
        ),
      ),
      // A blow coming: blocked by its block chance (each blow weighed once).
      seq(test(v('blowComing')), act('noteBlow'), chance(v('blockChance'), act('block'))),
    ),
  },
  // Flee (observed in the original: Flee Context, Start Flee, the Flee Selector's Flee To Ally, Flee Through
  // Door, Flee To Cover, Flee, Unrestricted Flee, Boost Confidence): back to the fight once
  // cornered (Boost Confidence), done once safe; else to an ally fCombatFleeAllyDistanceMin ..
  // Max away, through a door (fCombatFleeUseDoorChance), to cover hidden from its enemy
  // (fCombatFleeCover*), away from its enemy, else it cowers.
  Flee: {
    node: 'context',
    context: 'flee',
    child: pick(
      watch(v('cornered'), act('fightCornered')),
      watch(v('fleeSafe'), act('stopFleeing')),
      first(
        when(v('allyNear'), act('fleeToAlly')),
        act('fleeThroughDoor'),
        act('fleeToCover'),
        act('fleeAway'),
        act('cower'),
      ),
    ),
  },
  UsePotion: seq(test(v('maySupport')), act('support')),
  // Movement (observed in the original: the Movement Parallel runs Check Unreachable Target and Acquire
  // Weapon beside the Movement Selector, a dynamic selector checked every 0.25 s whose entries,
  // first to last, are Essential Down, Flight, Flee, Hide, Return To Combat Area, Exit Water,
  // Search, Ranged Movement (its weapon's range beyond fCombatRangedDistance), Flanking Movement
  // (the style's flanking flag) and Close Movement). Flight and Flee run from the root here
  // (actor-flight.ts; the Flee subtree), Search in the search mode (combat-search.ts); Acquire
  // Weapon and Check Unreachable Target take the movement over while they act, as their
  // movement resource does in the engine.
  Movement: {
    node: 'dynamicSelector',
    children: [
      watch(v('essentialDown'), { node: 'idle', seconds: 10000 }),
      watch(and(v('unseen'), v('rangedMovement')), link('Hide')),
      watch(v('tethered'), link('ReturnToCombatArea')),
      watch(v('inWater'), link('ExitWater')),
      watch(v('mayAcquireWeapon'), link('AcquireWeapon')),
      watch(
        or(v('targetBeyondLeash'), and(v('unreachable'), not(v('hasRangedOption')))),
        link('CheckUnreachableTarget'),
      ),
      watch(v('rangedMovement'), link('RangedMovement')),
      watch(v('flanking'), link('FlankingMovement')),
      link('CloseMovement'),
    ],
  },
  ReturnToCombatArea: act('returnToCombatArea'),
  CheckUnreachableTarget: act('holdPosition'),
  ExitWater: act('exitWater'),
  // Acquire Weapon (Find Weapon Sequence, Move to Weapon, the pick-up).
  AcquireWeapon: {
    node: 'context',
    context: 'acquireWeapon',
    child: seq(act('findWeapon'), act('moveToWeapon'), act('pickUpWeapon')),
  },
  // Low Combat: the low process's root (observed in the original: the Low Combat Selector, checked every
  // second: Flee while it flees, Attack (CombatBehaviorAttackLow) within
  // fCombatLowMaxAttackDistance, else Pursue its target, Search once its group searches).
  LowCombat: {
    node: 'dynamicSelector',
    children: [
      watch(v('fleeing'), link('Flee')),
      watch(and(v('lowInReach'), not(v('groupSearching'))), act('attackLow')),
      watch(not(v('groupSearching')), act('pursue')),
      link('Search'),
    ],
  },
  // Search (Wait to Start Search, then the Search Selector and Investigate Selector): the search
  // of combat-search.ts.
  Search: { node: 'context', context: 'search', child: act('search') },
  Hide: act('hide'),
  FallbackToRanged: act('fallbackToRanged'),
  // Use Cover (Find Cover Sequence, then the Use Cover Repeat: Wait Behind Cover, Attack From
  // Cover, with the cover flag up).
  UseCover: {
    node: 'context',
    context: 'cover',
    child: seq(act('findCover'), {
      node: 'repeat',
      child: seq(act('waitBehindCover'), act('attackFromCover')),
    }),
  },
  // Ranged Movement (its selector's first entry Use Cover, then Maintain Optimal Range: in range
  // strafing or circling, out of range closing in).
  RangedMovement: pick(
    watch(v('beyondRange'), act('chase')),
    watch(v('mayUseCover'), link('UseCover')),
    seq(
      act('trackRun'),
      ok(seq(test(v('mayChooseRun')), act('decideRun'), act('maintainOptimalRange'))),
      act('driveRun'),
    ),
  ),
  // Close Movement: Fallback To Ranged against a target it cannot reach, the chase, else the
  // Close Movement selector.
  CloseMovement: pick(
    watch(and(v('unreachable'), v('hasRangedOption')), link('FallbackToRanged')),
    watch(v('farAway'), act('chase')),
    seq(
      act('trackRun'),
      ok(seq(test(v('mayChooseRun')), act('decideRun'), link('CloseMovementSelector'))),
      act('driveRun'),
    ),
  ),
  CloseMovementSelector: CLOSE_MOVEMENT_SELECTOR,
  // Flanking Movement (observed in the original: Stalk, then the Flank Selector: Flank, Chase, Flank
  // Distant, Watch Target): the chase when far, the maneuver (flank or stalk), Flank Distant
  // out of range, else the close movement selector.
  FlankingMovement: pick(
    watch(and(v('farAway'), not(v('rangedMovement'))), act('chase')),
    seq(
      act('trackRun'),
      ok(
        seq(
          test(v('mayChooseRun')),
          act('decideRun'),
          first(
            link('FlankSequence'),
            when(v('outOfRange'), act('circleDistant')),
            link('CloseMovementSelector'),
          ),
        ),
      ),
      act('driveRun'),
    ),
  ),
  FlankSequence: seq(act('flankingManeuver'), {
    node: 'childSelector',
    choose: { data: 'maneuver' },
    children: [act('flank'), act('stalk')],
  }),
  FindAttackLocation: first(act('reposition'), act('surround')),
};

/** The combat tree's registry: the trees above with the AI's values and actions. */
export function combatRegistry<C>(
  values: Readonly<Record<CombatValue, (ctx: C) => number | boolean>>,
  actions: Readonly<Record<CombatAction, TreeAction<C>>>,
  contexts: TreeRegistry<C>['contexts'] = {},
): TreeRegistry<C> {
  return { trees: COMBAT_TREES, values, actions, contexts };
}

/** For the conformance cases: an expression's names, so a test can read what a tree weighs. */
export const combatExpr = { v, and, or, not };
