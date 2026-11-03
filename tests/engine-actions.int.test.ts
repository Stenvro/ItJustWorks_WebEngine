// Integration test: the engine's rarer actions on the local game data (docs/animation.md, "Idles
// and actions"): at the moment each is performed (src/gameplay/combat/combat-actions.ts, the
// movers' path end, the stage's summon), its idle tree gives the event that plays: the force
// equip's swap in the hand, the crossbow's reload, the dual release's staff bash release, the
// block's anticipation, the path end's turn into the arrival heading, a summon's appearing; the
// engine's own (observed in the original): a graph made while its actor lies dead dropping to its
// ragdoll, a resurrected creature's graph reset, the vampire lord taking to the water's surface,
// the shield change (nothing to play).
// Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { behaviorGraphKey, readIdleTree, type IdleTree } from '../src/ai/idle-records.ts';
import { conditionFunctionName } from '../src/scripting/condition-functions.ts';
import { evaluateConditionsWith, type Condition } from '../src/scripting/conditions.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const HUMAN = 'Actors\\Character\\Behaviors\\0_master.hkx';
const FLAME_ATRONACH = 'Actors\\AtronachFlame\\Behaviors\\AtronachFlameBehavior.hkx';
const CHICKEN = 'Actors\\Ambient\\Chicken\\Behaviors\\ChickenBehavior.hkx';
const BEAR = 'Actors\\Bear\\Behaviors\\BearBehavior.hkx';
const DRAGON = 'Actors\\Dragon\\Behaviors\\DragonBehavior.hkx';
const VAMPIRE_LORD = 'Actors\\VampireLord\\Behaviors\\VampireLord.hkx';

/** A hand's GetEquippedItemType / GetReplacedItemType: by the condition's hand (0 left, 1 right). */
interface Hands {
  readonly left: number;
  readonly right: number;
}

describe.skipIf(!hasGamedata())('the engine’s rarer actions on the local game data', () => {
  let vfs: Vfs;
  let tree: IdleTree;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    tree = await readIdleTree(await RecordDatabase.open(vfs));
  }, 120_000);
  afterAll(async () => {
    await vfs.close();
  });

  /**
   * The event an action plays on a graph, the conditions valued by `values` (by function name;
   * the hand functions by `equipped` and `replaced`), others 0.
   */
  const perform = (
    action: string,
    graphFile: string,
    values: Record<string, number> = {},
    equipped?: Hands,
    replaced?: Hands,
  ): string | undefined => {
    const parent = tree.action(action);
    if (!parent) return 'no action';
    const valueOf = (condition: Condition): number => {
      const name = conditionFunctionName(condition.function);
      const hands = name === 'GetEquippedItemType' ? equipped : undefined;
      const before = name === 'GetReplacedItemType' ? replaced : undefined;
      const hand = hands ?? before;
      if (hand) return condition.raw1 === 1 ? hand.right : hand.left;
      return values[name] ?? 0;
    };
    return tree.resolve(parent.formId, behaviorGraphKey(graphFile), (idle) =>
      evaluateConditionsWith(idle.conditions, valueOf),
    )?.event;
  };

  it('ActionForceEquip swaps what changed in the hand while the weapon is out', () => {
    const out = { IsWeaponMagicOut: 1 };
    // The sword in the right hand swapped for a dagger, the shield kept.
    expect(
      perform('ActionForceEquip', HUMAN, out, { left: 10, right: 2 }, { left: -1, right: 1 }),
    ).toBe('WeapOutRightReplaceForceEquip');
    // Only the left hand: the shield for a torch (the tree's first child that takes it).
    expect(
      perform('ActionForceEquip', HUMAN, out, { left: 11, right: 1 }, { left: 10, right: -1 }),
    ).toBe('WeapOutLeftReplaceForceEquip');
    // Magic out, the right hand's spell changed.
    expect(
      perform('ActionForceEquip', HUMAN, out, { left: 9, right: 9 }, { left: -1, right: 9 }),
    ).toBe('MagicForceEquipRight');
  });

  it('ActionReload reloads a crossbow', () => {
    expect(perform('ActionReload', HUMAN, { GetWeaponAnimType: 12 })).toBe('reloadStart');
    expect(perform('ActionReload', HUMAN, { GetWeaponAnimType: 7 })).toBeUndefined();
  });

  it('ActionDualRelease plays the staff bash release with a staff in the left hand', () => {
    expect(perform('ActionDualRelease', HUMAN, {}, { left: 8, right: 9 })).toBe('StaffBashRelease');
    expect(perform('ActionDualRelease', HUMAN, {}, { left: 9, right: 9 })).toBeUndefined();
  });

  it('ActionBlockAnticipate raises the block to meet the blow', () => {
    expect(perform('ActionBlockAnticipate', HUMAN)).toBe('blockAnticipateStart');
  });

  it('ActionPathEnd turns into the heading arrived with, by its angle from the facing', () => {
    const end = (angle: number): string | undefined =>
      perform('ActionPathEnd', HUMAN, { GetPathingTargetAngleOffset: angle });
    expect(end(90)).toBe('NPC_TurnRight90');
    expect(end(150)).toBe('NPC_TurnRight180');
    expect(end(200)).toBe('NPC_TurnLeft180');
    expect(end(270)).toBe('NPC_TurnLeft90');
    expect(end(20)).toBeUndefined();
  });

  it('ActionSummonedStart shows a summoned atronach appearing', () => {
    expect(perform('ActionSummonedStart', FLAME_ATRONACH)).toBe('summonStart');
  });

  it('ActionRagdollInstant drops a graph made while its actor lies dead to its ragdoll', () => {
    expect(perform('ActionRagdollInstant', CHICKEN)).toBe('RagdollInstant');
  });

  it('ActionResetAnimationGraph resets a resurrected creature’s graph', () => {
    expect(perform('ActionResetGraph', BEAR)).toBe('returnToDefault');
    expect(perform('ActionResetGraph', DRAGON)).toBe('Reset');
  });

  it('ActionWaterwalkStart floats the vampire lord over the water', () => {
    expect(perform('ActionWaterwalkStart', VAMPIRE_LORD)).toBe('WaterWalkStart');
  });

  it('ActionShieldChange has nothing to play in any vanilla graph', () => {
    expect(perform('ActionShieldChange', HUMAN)).toBeUndefined();
  });
});
