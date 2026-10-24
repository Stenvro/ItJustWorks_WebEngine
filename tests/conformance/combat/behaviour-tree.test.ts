// Conformance: the combat behaviour tree (engine map: Combat > Behaviour tree). The original's
// combat is a behaviour tree built in code: a root Combat parallel runs the equipment slots'
// actions beside a movement priority list.
//
// Source: the original's class names (observed in the original; docs/ai.md, The attack decision):
// the trees CombatBehaviorTree{Combat, Melee, Ranged, Magic, Shout, Block, UsePotion,
// AcquireWeapon, CloseMovement, FlankingMovement, RangedMovement, Movement, FindAttackLocation,
// UseCover, Hide, Flee, Search, DodgeThreat, CheckUnreachableTarget, ExitWater,
// ReturnToCombatArea, LowCombat, Flight}, their node classes CombatBehaviorTree{RootNode,
// LinkNode, WrapperNode, ConditionalNode, ValueNode, CreateContextNode, Action,
// ActionEquipmentSelector, NodeObject} and the behaviours (CombatBehavior*).

import { describe, it } from 'vitest';

describe('the node classes', () => {
  it.todo('Root, Link, Wrapper nodes: a tree and the subtrees it links  [original]');
  it.todo('Sequence, Parallel, Spawn Parallel, Dynamic / Child / Fallback Selector  [original]');
  it.todo('Conditional and Dynamic Conditional nodes, Expressions (Unary, Binary, Func)  [original]');
  it.todo('Value nodes and Blackboard data (Set Blackboard Data, Enable Blackboard Flag)  [original]');
  it.todo('Create Context nodes: each subtree’s context (Melee, Ranged, Magic, Block, …)  [original]');
  it.todo('Repeat, Pause, Idle, Force Success, Force Fail, Random node  [original]');
  it.todo('Action Equipment Selector: one action per equipment slot, in parallel  [original]');
});

describe('the subtrees', () => {
  it.todo('Combat: the root parallel of actions and movement  [original]');
  it.todo('Melee: Attack, Bash, Special Attack, the attack idle (0.25 s)  [original, docs/ai.md]');
  it.todo('Ranged: Ranged Attack, Equip Ranged Weapon, the ranged attack idle  [original]');
  it.todo('Magic: Cast Immediate / Concentration Spell, Prepare Dual Cast  [original]');
  it.todo('Shout: Equip Shout, Cast Shout  [original]');
  it.todo('Block: Block, Block Attack  [original]');
  it.todo('Use Potion: Drink Potion  [original]');
  it.todo('Acquire Weapon: Find Weapon, Acquire Item / Resource  [original]');
  it.todo('Close Movement: Advance, Backoff, Circle, Fallback, Surround, Strafe  [original]');
  it.todo('Flanking Movement: Flank, Flank Distant, Stalk, Circle Distant  [original]');
  it.todo('Ranged Movement: Maintain Optimal Range, Reposition, Fallback To Ranged  [original]');
  it.todo('Find Attack Location: Find (Ally / Lateral) Attack Location  [original]');
  it.todo('Use Cover: Find Cover, Attack From Cover, Wait Behind Cover  [original]');
  it.todo('Hide  [original]');
  it.todo('Flee: Flee, Flee To Ally, Flee To Cover, Flee Through Door  [original]');
  it.todo('Search: Search Center, Location, Wander, Investigate Door  [original]');
  it.todo('Dodge Threat  [original]');
  it.todo('Check Unreachable Target  [original]');
  it.todo('Exit Water, Return To Combat Area  [original]');
  it.todo('Low Combat (Attack Low)  [original]');
  it.todo('Flight: Takeoff, Land, Hover, Orbit, Dive Bomb, Perch / Ground / Flying Attack  [original]');
});
