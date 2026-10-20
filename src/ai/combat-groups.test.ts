import { describe, expect, it } from 'vitest';
import { CombatGroups } from './combat-groups.ts';

describe('combat groups', () => {
  it('puts allies that fight into one group and shares what they see', () => {
    const groups = new CombatGroups();
    const first = groups.join(1, []);
    // 2 fights beside 1; 3 has no ally in combat.
    expect(groups.join(2, [5, 1])).toBe(first);
    const other = groups.join(3, []);
    expect(other).not.toBe(first);
    expect(groups.size(2)).toBe(2);
    expect([...groups.allies(1)]).toEqual([2]);
    groups.saw(1, 9, [10, 20, 0], 4);
    expect(groups.lastSeen(2, 9)).toEqual({ at: [10, 20, 0], seen: 4 });
    expect(groups.lastSeen(3, 9)).toBeUndefined();
    // Joining again keeps its group.
    expect(groups.join(1, [3])).toBe(first);
  });

  it('lets members leave, forgets targets and drops empty groups', () => {
    const groups = new CombatGroups();
    groups.join(1, []);
    groups.join(2, [1]);
    groups.saw(2, 9, [0, 0, 0], 1);
    groups.forget(9);
    expect(groups.lastSeen(1, 9)).toBeUndefined();
    groups.leave(1);
    expect(groups.size(2)).toBe(1);
    expect(groups.groupOf(1)).toBeUndefined();
    groups.leave(2);
    expect([...groups.groups()]).toHaveLength(0);
    expect(groups.size(2)).toBe(0);
  });
});
