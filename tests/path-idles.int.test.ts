// Integration test: the path idles on the local game data (docs/ai.md, "Paths"): the human
// graph's ActionPathStart picks the turn an actor sets out with by the way its path goes against
// its facing (GetPathingTargetAngleOffset, 0..360 clockwise) and the speed it is asked
// (GetPathingTargetSpeed), and none while it already moves. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { behaviorGraphKey, readIdleTree, type IdleTree } from '../src/ai/idle-records.ts';
import { conditionFunctionName } from '../src/scripting/condition-functions.ts';
import { evaluateConditionsWith } from '../src/scripting/conditions.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

describe.skipIf(!hasGamedata())('path idles on the local game data', () => {
  let vfs: Vfs;
  let tree: IdleTree;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    tree = await readIdleTree(await RecordDatabase.open(vfs));
  }, 120_000);
  afterAll(async () => {
    await vfs.close();
  });

  /** The event ActionPathStart plays for an actor going `speed`, asked `target`, aimed `angle`. */
  const pathStart = (speed: number, target: number, angle: number): string | undefined => {
    const action = tree.action('ActionPathStart');
    if (!action) return 'no action';
    const values: Record<string, number> = {
      GetMovementSpeed: speed,
      GetPathingTargetSpeed: target,
      GetPathingTargetAngleOffset: angle,
      IsSneaking: 0,
    };
    const graph = behaviorGraphKey('Actors\\Character\\Behaviors\\0_master.hkx');
    return tree.resolve(action.formId, graph, (idle) =>
      evaluateConditionsWith(idle.conditions, (c) => values[conditionFunctionName(c.function)]),
    )?.event;
  };

  it('turns on the spot when the path starts behind or beside a standing actor', () => {
    expect(pathStart(0, 0, 90)).toBe('NPC_TurnRight90');
    expect(pathStart(0, 0, 200)).toBe('NPC_TurnLeft180');
  });

  it('turns into a walk when asked to go, and plays nothing while it already moves', () => {
    expect(pathStart(0, 80, 270)).toMatch(/^NPC_TurnToWalk/);
    expect(pathStart(0, 0, 0)).toBeUndefined();
    expect(pathStart(80, 80, 90)).toBeUndefined();
  });
});
