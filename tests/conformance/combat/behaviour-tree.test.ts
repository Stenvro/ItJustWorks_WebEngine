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

import { describe, it } from 'vitest';

describe('the node classes', () => {
  it.todo('Root, Link, Wrapper nodes: a tree and the subtrees it links  [RTTI]');
  it.todo('Sequence, Parallel, Spawn Parallel, Dynamic / Child / Fallback Selector  [RTTI]');
  it.todo('Conditional and Dynamic Conditional nodes, Expressions (Unary, Binary, Func)  [RTTI]');
  it.todo('Value nodes and Blackboard data (Set Blackboard Data, Enable Blackboard Flag)  [RTTI]');
  it.todo('Create Context nodes: each subtree’s context (Melee, Ranged, Magic, Block, …)  [RTTI]');
  it.todo('Repeat, Pause, Idle, Force Success, Force Fail, Random node  [RTTI]');
  it.todo('Action Equipment Selector: one action per equipment slot, in parallel  [RTTI]');
});

describe('the subtrees', () => {
  it.todo('Combat: the root parallel of actions and movement  [RTTI]');
  it.todo('Melee: Attack, Bash, Special Attack, the attack idle (0.25 s)  [RTTI, docs/ai.md]');
  it.todo('Ranged: Ranged Attack, Equip Ranged Weapon, the ranged attack idle  [RTTI]');
  it.todo('Magic: Cast Immediate / Concentration Spell, Prepare Dual Cast  [RTTI]');
  it.todo('Shout: Equip Shout, Cast Shout  [RTTI]');
  it.todo('Block: Block, Block Attack  [RTTI]');
  it.todo('Use Potion: Drink Potion  [RTTI]');
  it.todo('Acquire Weapon: Find Weapon, Acquire Item / Resource  [RTTI]');
  it.todo('Close Movement: Advance, Backoff, Circle, Fallback, Surround, Strafe  [RTTI]');
  it.todo('Flanking Movement: Flank, Flank Distant, Stalk, Circle Distant  [RTTI]');
  it.todo('Ranged Movement: Maintain Optimal Range, Reposition, Fallback To Ranged  [RTTI]');
  it.todo('Find Attack Location: Find (Ally / Lateral) Attack Location  [RTTI]');
  it.todo('Use Cover: Find Cover, Attack From Cover, Wait Behind Cover  [RTTI]');
  it.todo('Hide  [RTTI]');
  it.todo('Flee: Flee, Flee To Ally, Flee To Cover, Flee Through Door  [RTTI]');
  it.todo('Search: Search Center, Location, Wander, Investigate Door  [RTTI]');
  it.todo('Dodge Threat  [RTTI]');
  it.todo('Check Unreachable Target  [RTTI]');
  it.todo('Exit Water, Return To Combat Area  [RTTI]');
  it.todo('Low Combat (Attack Low)  [RTTI]');
  it.todo('Flight: Takeoff, Land, Hover, Orbit, Dive Bomb, Perch / Ground / Flying Attack  [RTTI]');
});
