// Conformance: the combat behaviour tree (engine map: Combat > Behaviour tree). The original's
// combat is a behaviour tree built in code: a root Combat parallel runs the equipment slots'
// actions beside a movement priority list.
//
// Source: the executable's class names (RTTI, observed in the original; docs/ai.md, The attack decision):
// the trees CombatBehaviorTree{Combat, Melee, Ranged, Magic, Shout, Block, UsePotion,
// AcquireWeapon, CloseMovement, FlankingMovement, RangedMovement, Movement, FindAttackLocation,
// UseCover, Hide, Flee, Search, DodgeThreat, CheckUnreachableTarget, ExitWater,
// ReturnToCombatArea, LowCombat, Flight}, their node classes CombatBehaviorTree{RootNode,
// LinkNode, WrapperNode, ConditionalNode, ValueNode, CreateContextNode, Action,
// ActionEquipmentSelector, NodeObject} and the behaviours (CombatBehavior*).
//
// Ours: src/ai/behaviour-tree.ts (the runtime), src/ai/combat-tree.ts (the trees as data), run
// by src/shell/actor-combat-ai.ts. The cases run the trees with values set by hand and actions
// that note what they did.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BehaviourTree,
  type NodeSpec,
  type Status,
  type TreeAction,
  type TreeInstance,
} from '../../../src/ai/behaviour-tree.ts';
import {
  COMBAT_ACTIONS,
  COMBAT_TREES,
  COMBAT_VALUES,
  combatRegistry,
  type CombatAction,
  type CombatValue,
} from '../../../src/ai/combat-tree.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

// --- The node classes, on a small tree --------------------------------------------------------

interface Toy {
  readonly values: Record<string, number | boolean>;
  readonly log: string[];
  readonly results: Record<string, Status>;
}

function toy(trees: Record<string, NodeSpec>, root = 'Root', random = () => 0.5) {
  const ctx: Toy = { values: {}, log: [], results: {} };
  const names = ['a', 'b', 'c', 'd'];
  const actions: Record<string, TreeAction<Toy>> = {};
  for (const name of names) {
    actions[name] = {
      tick: (c) => {
        c.log.push(name);
        return c.results[name] ?? 'success';
      },
      halt: (c) => {
        c.log.push(`halt ${name}`);
      },
    };
  }
  actions.useContext = (c, run) => {
    c.log.push(`context ${String((run.context('melee') as { made: number } | undefined)?.made)}`);
    return 'success';
  };
  const values = new Proxy(
    {},
    {
      get: (_, name: string) => (c: Toy) => c.values[name] ?? false,
    },
  );
  let made = 0;
  const tree = new BehaviourTree<Toy>(
    {
      trees,
      actions,
      values,
      funcs: { max: (_, args) => Math.max(...args) },
      contexts: {
        melee: {
          create: () => ({ made: ++made }),
          dispose: (c) => c.log.push('dispose'),
        },
      },
    },
    root,
  );
  const instance = tree.instance(random);
  return { ctx, tree, instance, tick: (seconds = 0.1) => instance.tick(ctx, seconds) };
}

const a: NodeSpec = { node: 'action', action: 'a' };
const b: NodeSpec = { node: 'action', action: 'b' };
const c: NodeSpec = { node: 'action', action: 'c' };

describe('the node classes', () => {
  it('Root, Link, Wrapper nodes: a tree and the subtrees it links  [RTTI]', () => {
    const t = toy({
      Root: {
        node: 'sequence',
        children: [
          { node: 'link', tree: 'Sub' },
          { node: 'link', tree: 'Sub' },
        ],
      },
      Sub: { node: 'wrapper', name: 'Inner', child: a },
    });
    expect(t.tree.subtrees()).toEqual(['Root', 'Sub', 'Inner', 'Sub', 'Inner']);
    expect(t.tick()).toBe('success');
    expect(t.ctx.log).toEqual(['a', 'a']);
    expect(t.instance.active.has('Sub')).toBe(true);
    // A tree that links itself stops at the link depth.
    expect(() => toy({ Root: { node: 'link', tree: 'Root' } })).toThrow(/too deep/);
  });

  it('Sequence, Parallel, Spawn Parallel, Dynamic / Child / Fallback Selector  [RTTI]', () => {
    // Sequence: from the running child on; fails at the first failure.
    let t = toy({ Root: { node: 'sequence', children: [a, b, c] } });
    t.ctx.results.b = 'running';
    expect(t.tick()).toBe('running');
    t.ctx.results.b = 'failure';
    expect(t.tick()).toBe('failure');
    expect(t.ctx.log).toEqual(['a', 'b', 'b']);
    // Fallback Selector: from the running child on; succeeds at the first success.
    t = toy({ Root: { node: 'fallbackSelector', children: [a, b, c] } });
    t.ctx.results.a = 'failure';
    t.ctx.results.b = 'running';
    expect(t.tick()).toBe('running');
    t.ctx.results.a = 'success';
    t.ctx.results.b = 'success';
    expect(t.tick()).toBe('success');
    expect(t.ctx.log).toEqual(['a', 'b', 'b']);
    // Dynamic Selector: from the top each tick; a higher child stops a lower one running.
    t = toy({ Root: { node: 'dynamicSelector', children: [a, b] } });
    t.ctx.results.a = 'failure';
    t.ctx.results.b = 'running';
    t.tick();
    t.ctx.results.a = 'running';
    t.tick();
    expect(t.ctx.log).toEqual(['a', 'b', 'a', 'halt b']);
    // Child Selector: the child an expression picks.
    t = toy({ Root: { node: 'childSelector', choose: { value: 'pick' }, children: [a, b, c] } });
    t.ctx.values.pick = 2;
    t.tick();
    expect(t.ctx.log).toEqual(['c']);
    // Parallel: all children each tick; fails when any does (by default).
    t = toy({ Root: { node: 'parallel', children: [a, b] } });
    t.ctx.results.a = 'running';
    t.ctx.results.b = 'failure';
    expect(t.tick()).toBe('failure');
    expect(t.ctx.log).toEqual(['a', 'b', 'halt a']);
    t = toy({ Root: { node: 'parallel', succeed: 'any', children: [a, b] } });
    t.ctx.results.a = 'running';
    expect(t.tick()).toBe('success');
    // Spawn Parallel: each child started again as it ends; it runs on.
    t = toy({ Root: { node: 'spawnParallel', children: [a, b] } });
    expect(t.tick()).toBe('running');
    expect(t.tick()).toBe('running');
    expect(t.ctx.log).toEqual(['a', 'b', 'a', 'b']);
  });

  it('Conditional and Dynamic Conditional nodes, Expressions (Unary, Binary, Func)  [RTTI]', () => {
    const expr = {
      op: '&&',
      a: { not: { value: 'off' } },
      b: { op: '>', a: { func: 'max', args: [{ value: 'x' }, 1] }, b: 2 },
    } as const;
    let t = toy({ Root: { node: 'conditional', if: expr, child: a, else: b } });
    t.ctx.values.x = 3;
    t.tick();
    t.ctx.values.x = 0;
    t.tick();
    expect(t.ctx.log).toEqual(['a', 'b']);
    // A running child keeps a Conditional; a Dynamic Conditional stops it once its test fails.
    t = toy({ Root: { node: 'dynamicConditional', if: { value: 'on' }, child: a } });
    t.ctx.values.on = true;
    t.ctx.results.a = 'running';
    expect(t.tick()).toBe('running');
    t.ctx.values.on = false;
    expect(t.tick()).toBe('failure');
    expect(t.ctx.log).toEqual(['a', 'halt a']);
  });

  it('Value nodes and Blackboard data (Set Blackboard Data, Enable Blackboard Flag)  [RTTI]', () => {
    const t = toy({
      Root: {
        node: 'sequence',
        children: [
          { node: 'setData', key: 'n', value: { op: '+', a: { value: 'x' }, b: 1 } },
          { node: 'value', value: { op: '==', a: { data: 'n' }, b: 5 } },
          { node: 'enableFlag', flag: 'busy', child: a },
          { node: 'value', value: { not: { flag: 'busy' } } },
        ],
      },
    });
    t.ctx.values.x = 4;
    t.ctx.results.a = 'running';
    expect(t.tick()).toBe('running');
    expect(t.instance.flags.has('busy')).toBe(true);
    expect(t.instance.blackboard.get('n')).toBe(5);
    t.ctx.results.a = 'success';
    expect(t.tick()).toBe('success');
    expect(t.instance.flags.has('busy')).toBe(false);
  });

  it('Create Context nodes: each subtree’s context (Melee, Ranged, Magic, Block, …)  [RTTI]', () => {
    const t = toy({
      Root: { node: 'context', context: 'melee', child: { node: 'action', action: 'useContext' } },
    });
    t.tick();
    t.tick();
    // Made as the subtree starts, dropped as it ends: a new one each run.
    expect(t.ctx.log).toEqual(['context 1', 'dispose', 'context 2', 'dispose']);
  });

  it('Repeat, Pause, Idle, Force Success, Force Fail, Random node  [RTTI]', () => {
    let t = toy({ Root: { node: 'repeat', times: 2, child: a } });
    expect(t.tick()).toBe('running');
    expect(t.tick()).toBe('success');
    t = toy({ Root: { node: 'sequence', children: [{ node: 'pause', seconds: 0.15 }, a] } });
    expect(t.tick(0.1)).toBe('running');
    expect(t.tick(0.1)).toBe('running');
    expect(t.tick(0.1)).toBe('success');
    t = toy({ Root: { node: 'idle', seconds: 1 } });
    t.tick();
    expect(t.instance.active.has('Idle')).toBe(true);
    t = toy({ Root: { node: 'forceSuccess', child: a } });
    t.ctx.results.a = 'failure';
    expect(t.tick()).toBe('success');
    t = toy({ Root: { node: 'forceFail', child: a } });
    expect(t.tick()).toBe('failure');
    t = toy({ Root: { node: 'random', chance: 0.4, child: a, otherwise: b } }, 'Root', () => 0.5);
    t.tick();
    t = toy({ Root: { node: 'random', chance: 0.6, child: a, otherwise: b } }, 'Root', () => 0.5);
    t.tick();
    expect(t.ctx.log).toEqual(['a']);
  });

  it('Action Equipment Selector: one action per equipment slot, in parallel  [RTTI]', () => {
    const t = toy({
      Root: {
        node: 'equipment',
        slots: [
          { slot: 'right', when: { value: 'sword' }, child: a },
          { slot: 'left', when: { value: 'shield' }, child: b },
          { slot: 'voice', when: { value: 'shout' }, child: c },
        ],
      },
    });
    t.ctx.values.sword = true;
    t.ctx.values.shield = true;
    t.ctx.results.b = 'running';
    expect(t.tick()).toBe('running');
    expect([...t.instance.slots]).toEqual(['right', 'left']);
    // A slot emptied stops its action.
    t.ctx.values.shield = false;
    t.tick();
    expect(t.ctx.log).toEqual(['a', 'b', 'a', 'halt b']);
    t.ctx.values.sword = false;
    expect(t.tick()).toBe('failure');
  });
});

// --- The combat tree's subtrees ---------------------------------------------------------------

interface Fighter {
  readonly values: Partial<Record<CombatValue, number | boolean>>;
  readonly results: Partial<Record<CombatAction, Status>>;
  log: string[];
}

function fighter(values: Fighter['values'] = {}, random = () => 0.5) {
  const ctx: Fighter = {
    values: { attackIdle: 0.25, shoutIdle: 1, ...values },
    results: {},
    log: [],
  };
  const valueOf = Object.fromEntries(
    COMBAT_VALUES.map((name) => [name, (f: Fighter) => f.values[name] ?? false]),
  ) as Record<CombatValue, (f: Fighter) => number | boolean>;
  const actions = Object.fromEntries(
    COMBAT_ACTIONS.map((name): [CombatAction, TreeAction<Fighter>] => [
      name,
      (f, run): Status => {
        f.log.push(name);
        if (name === 'chooseAttack')
          run.blackboard.set('attack', f.values.mayAttack === true ? 1 : -1);
        if (name === 'flankingManeuver') run.blackboard.set('maneuver', 1);
        const fails = name === 'dodgeThreat' || name === 'findCover';
        return f.results[name] ?? (fails ? 'failure' : 'success');
      },
    ]),
  ) as Record<CombatAction, TreeAction<Fighter>>;
  const tree = new BehaviourTree(combatRegistry(valueOf, actions), 'Combat');
  const instance: TreeInstance<Fighter> = tree.instance(random);
  return {
    ctx,
    tree,
    instance,
    tick(seconds = 0.1): string[] {
      ctx.log = [];
      instance.tick(ctx, seconds);
      return ctx.log;
    },
  };
}

describe('the subtrees', () => {
  it('Combat: the root parallel of actions and movement  [RTTI]', () => {
    const t = fighter({ rightMelee: true, canBlock: true, maySupport: true, mayTaunt: true });
    const log = t.tick();
    // Equipment, Movement and the taunt in one tick; the slots side by side.
    expect(log).toContain('support');
    expect(log).toContain('driveRun');
    expect(log).toContain('taunt');
    expect([...t.instance.slots]).toEqual(['right', 'shieldAndWeapon', 'potion']);
    expect(t.instance.active.has('Movement')).toBe(true);
    // A dodge stops the rest while it runs.
    t.ctx.results.dodgeThreat = 'running';
    expect(t.tick()).toEqual(['dodgeThreat']);
  });

  it('Melee: Attack, Bash, Special Attack, the attack idle (0.25 s)  [RTTI, docs/ai.md]', () => {
    const t = fighter({ rightMelee: true, mayAttack: true });
    expect(t.tick()).toEqual(expect.arrayContaining(['chooseAttack', 'powerAttack']));
    // The attack idle: no new choice for 0.25 s.
    expect(t.tick(0.1)).not.toContain('chooseAttack');
    expect(t.tick(0.1)).not.toContain('chooseAttack');
    t.tick(0.1);
    expect(t.tick(0.1)).toContain('chooseAttack');
    expect(t.tree.actionsOf('Melee')).toEqual([
      'chooseAttack',
      'attack',
      'powerAttack',
      'bash',
      'powerBash',
      'specialAttack',
    ]);
  });

  it('Ranged: Ranged Attack, Equip Ranged Weapon, the ranged attack idle  [RTTI]', () => {
    // A draw by its chance, then the idle; held, loosed only within the firing arc.
    const t = fighter({
      rightBow: true,
      rangedMovement: true,
      mayDraw: true,
      rangedAttackChance: 1,
    });
    expect(t.tick()).toContain('drawShot');
    t.ctx.values.mayDraw = false;
    t.ctx.values.shotHeld = true;
    t.tick(0.3);
    expect(t.tick()).not.toContain('releaseShot');
    t.ctx.values.shotInArc = true;
    expect(t.tick(0.3)).toContain('releaseShot');
    // Held too long: let down.
    t.ctx.values.shotOverheld = true;
    t.tick(0.3);
    expect(t.tick(0.3)).toContain('cancelShot');
    // A bow without its arrows: they go on first.
    const unready = fighter({ rightBow: true, rangedMovement: true, rangedUnready: true });
    expect(unready.tick()).toContain('equipRanged');
  });

  it('Magic: Cast Immediate / Concentration Spell, Prepare Dual Cast  [RTTI]', () => {
    const t = fighter({ rightMagic: true, rangedMovement: true, mayCast: true, castChance: 1 });
    expect(t.tick()).toContain('castRight');
    const held = fighter({ rightMagic: true, mayCast: true, castChance: 1, concentration: true });
    expect(held.tick()).toContain('castConcentration');
    const dual = fighter({ rightMagic: true, mayCast: true, dualCast: true });
    expect(dual.tick()).toContain('prepareDualCast');
    // By its cast chance.
    const unlikely = fighter({ rightMagic: true, mayCast: true, castChance: 0.2 });
    expect(unlikely.tick()).not.toContain('castRight');
  });

  it('Shout: Equip Shout, Cast Shout  [RTTI]', () => {
    const t = fighter({ voiceShout: true, mayShout: true, rangedMovement: true });
    expect(t.tick()).toContain('castShout');
    // Its shout idle (1 s).
    expect(t.tick(0.5)).not.toContain('castShout');
    t.tick(0.6);
    expect(t.tick()).toContain('castShout');
  });

  it('Block: Block, Block Attack  [RTTI]', () => {
    const t = fighter({ rightMelee: true, canBlock: true, blowComing: true, blockChance: 1 });
    expect(t.tick()).toEqual(expect.arrayContaining(['noteBlow', 'block']));
    t.ctx.values.blowComing = false;
    t.ctx.values.blocking = true;
    expect(t.tick()).toContain('blockAttack');
    t.ctx.values.blockOver = true;
    expect(t.tick()).toContain('releaseBlock');
    // By its block chance.
    const unlikely = fighter({
      rightMelee: true,
      canBlock: true,
      blowComing: true,
      blockChance: 0.2,
    });
    expect(unlikely.tick()).not.toContain('block');
  });

  it('Use Potion: Drink Potion  [RTTI]', () => {
    const t = fighter({ maySupport: true });
    expect(t.tick()).toContain('support');
    t.ctx.values.maySupport = false;
    expect(t.tick()).not.toContain('support');
  });

  it.todo('Acquire Weapon: Find Weapon, Acquire Item / Resource  [RTTI]');

  it('Close Movement: Advance, Backoff, Circle, Fallback, Surround, Strafe  [RTTI]', () => {
    // Far: the chase; near, the run under way is kept and a new one chosen when due.
    const far = fighter({ rightMelee: true, farAway: true });
    expect(far.tick()).toContain('chase');
    const out = fighter({ rightMelee: true, mayChooseRun: true, outOfRange: true });
    out.ctx.results.advance = 'failure';
    expect(out.tick()).toEqual(
      expect.arrayContaining(['trackRun', 'decideRun', 'advance', 'surround', 'driveRun']),
    );
    const near = fighter({ rightMelee: true, mayChooseRun: true, fallbackChance: 1 }, () => 0);
    expect(near.tick()).toContain('fallback');
    const circling = fighter({ rightMelee: true, mayChooseRun: true, circleChance: 1 }, () => 0.5);
    expect(circling.tick()).toContain('circle');
    const backing = fighter({ rightMelee: true, mayChooseRun: true, backoffChance: 1 }, () => 0.5);
    expect(backing.tick()).toContain('backoff');
  });

  it('Flanking Movement: Flank, Flank Distant, Stalk, Circle Distant  [RTTI]', () => {
    const t = fighter({ rightMelee: true, mayChooseRun: true, flanking: true });
    expect(t.tick()).toEqual(expect.arrayContaining(['flankingManeuver', 'stalk']));
    expect(t.tree.actionsOf('FlankingMovement')).toEqual(['flankingManeuver', 'flank', 'stalk']);
  });

  it('Ranged Movement: Maintain Optimal Range, Reposition, Fallback To Ranged  [RTTI]', () => {
    const t = fighter({ rightBow: true, rangedMovement: true, mayChooseRun: true });
    expect(t.tick()).toContain('maintainOptimalRange');
    const beyond = fighter({ rightMagic: true, rangedMovement: true, beyondRange: true });
    expect(beyond.tick()).toContain('chase');
    // A melee fighter whose target it cannot reach falls back to ranged.
    const stuck = fighter({ rightMelee: true, unreachable: true, hasRangedOption: true });
    expect(stuck.tick()).toContain('fallbackToRanged');
  });

  it('Find Attack Location: Find (Ally / Lateral) Attack Location  [RTTI]', () => {
    const t = fighter({ rightMelee: true, mayChooseRun: true, outOfPosition: true });
    t.ctx.results.reposition = 'failure';
    expect(t.tick()).toEqual(expect.arrayContaining(['reposition', 'surround']));
  });

  it('Use Cover: Find Cover, Attack From Cover, Wait Behind Cover  [RTTI]', () => {
    // Tried first by a ranged fighter (TODO(M13): no cover is found yet, so ranged movement runs).
    const t = fighter({ rightBow: true, rangedMovement: true, mayChooseRun: true });
    const log = t.tick();
    expect(log.indexOf('findCover')).toBeLessThan(log.indexOf('maintainOptimalRange'));
  });

  it('Hide  [RTTI]', () => {
    const t = fighter({
      rightBow: true,
      rangedMovement: true,
      unseen: true,
      mayDraw: true,
      rangedAttackChance: 1,
    });
    const log = t.tick();
    expect(log).toContain('hide');
    expect(log).not.toContain('driveRun');
    // It still shoots from hiding.
    expect(log).toContain('drawShot');
  });

  it.todo('Flee: Flee, Flee To Ally, Flee To Cover, Flee Through Door  [RTTI]');
  it.todo('Search: Search Center, Location, Wander, Investigate Door  [RTTI]');

  it('Dodge Threat  [RTTI]', () => {
    const t = fighter({ rightMelee: true, mayAttack: true });
    t.ctx.results.dodgeThreat = 'running';
    expect(t.tick()).toEqual(['dodgeThreat']);
    t.ctx.results.dodgeThreat = 'failure';
    expect(t.tick()).toContain('chooseAttack');
  });

  it('Check Unreachable Target  [RTTI]', () => {
    const t = fighter({ rightMelee: true, targetBeyondLeash: true, farAway: true });
    const log = t.tick();
    expect(log).toContain('holdPosition');
    expect(log).not.toContain('chase');
  });

  it('Exit Water, Return To Combat Area  [RTTI]', () => {
    const t = fighter({ rightMelee: true, tethered: true, inWater: true });
    expect(t.tick()).toContain('returnToCombatArea');
    // Back in its area, in the water: Exit Water comes next in the list.
    t.ctx.values.tethered = false;
    expect(t.tick()).toContain('exitWater');
  });

  it('Low Combat (Attack Low)  [RTTI]', () => {
    const t = fighter({ rightMelee: true, lowCombat: true });
    expect(t.tick()).toContain('attackLow');
  });

  it.todo('Flight: Takeoff, Land, Hover, Orbit, Dive Bomb, Perch / Ground / Flying Attack  [RTTI]');

  it('names every subtree of the original it runs', () => {
    for (const name of [
      'Combat',
      'Melee',
      'Ranged',
      'Magic',
      'Shout',
      'Block',
      'UsePotion',
      'CloseMovement',
      'FlankingMovement',
      'RangedMovement',
      'Movement',
      'FindAttackLocation',
      'UseCover',
      'Hide',
      'DodgeThreat',
      'CheckUnreachableTarget',
      'ExitWater',
      'ReturnToCombatArea',
      'LowCombat',
    ]) {
      expect(COMBAT_TREES[name], name).toBeDefined();
    }
  });
});

// --- In the game: a bandit with sword and shield and a mage, each against a wolf -------------

const BANNERED_MARE = 0x1605e;

describe.skipIf(!hasGamedata())('the combat tree in a fight (headless simulation)', () => {
  let sim: Sim;
  let bandit = 0;
  let mage = 0;
  let wolves: number[] = [];
  const mageDistances: number[] = [];

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(1);
    // The patrons leave the fight to the four (they would take on the bandits).
    for (const actor of sim.actors()) {
      if (actor.reference !== PLAYER_REF) await sim.kill(actor.reference);
    }
    bandit = await sim.place(await sim.formId('NPC_', 'EncBandit01Melee1HTankNordM'), PLAYER_REF);
    mage = await sim.place(await sim.formId('NPC_', 'EncBandit01MagicNordM'), PLAYER_REF);
    const wolf = await sim.formId('NPC_', 'EncWolf');
    wolves = [await sim.place(wolf, PLAYER_REF), await sim.place(wolf, PLAYER_REF)];
    const combat = sim.world.stage.combat;
    combat.startCombat(wolves[0] ?? 0, bandit);
    combat.startCombat(bandit, wolves[0] ?? 0);
    combat.startCombat(wolves[1] ?? 0, mage);
    combat.startCombat(mage, wolves[1] ?? 0);
    for (let i = 0; i < 80; i++) {
      // Each wolf kept on its own opponent (the player stands near and would draw them).
      combat.startCombat(wolves[0] ?? 0, bandit);
      combat.startCombat(wolves[1] ?? 0, mage);
      await sim.step(0.25);
      const d = await sim.distance(mage, wolves[1] ?? 0);
      if (d !== undefined) mageDistances.push(d);
    }
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  const hits = () => sim.world.log.game('hit');

  it('the sword-and-shield bandit attacks the wolves, its block slot beside its sword', () => {
    // Through the player's eyes: the fight's graphs update at the animation rate LOD's pace
    // (behind the camera every fAnimInterpMaxTime), and its blows still land.
    expect(sim.world.session.render.view?.camera).toBeDefined();
    expect(hits().some((hit) => hit.aggressor === bandit && wolves.includes(hit.target))).toBe(
      true,
    );
    // A raised block needs a bite coming at it; when one came, it was weighed by its block chance.
    // TODO(M13): the wolves bite the player standing by rather than the bandit, so the block
    // itself is shown by the Block subtree's case above, not here.
  });

  it('the mage casts at its wolf and keeps its distance a while', () => {
    const casts = sim.world.log.game('spellCast').filter((cast) => cast.caster === mage);
    expect(casts.length).toBeGreaterThan(0);
    expect(Math.max(...mageDistances)).toBeGreaterThan(256);
  });
});
