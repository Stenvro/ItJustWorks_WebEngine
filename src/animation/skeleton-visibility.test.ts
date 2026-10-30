import { describe, expect, it } from 'vitest';
import { ActorPose, ActorSkeleton, type RigData } from './skeleton.ts';

const rig: RigData = {
  names: ['Root', 'WEAPON', 'Blade', 'SHIELD'],
  parents: Int16Array.of(-1, 0, 1, 0),
  local: new Float32Array(4 * 16),
  visibilitySlots: ['hkvis:weapon'],
};

describe('visibility slots', () => {
  const pose = new ActorPose(new ActorSkeleton(rig, undefined));
  const graph = (
    value: number,
    weight: number,
  ): {
    skeleton: { floatSlots: string[] };
    floatSlots: Float32Array;
    floatSlotWeights: Float32Array;
  } => ({
    skeleton: { floatSlots: ['hkVis:Weapon', 'hkFade:AnimObjectA'] },
    floatSlots: Float32Array.of(value, 0),
    floatSlotWeights: Float32Array.of(weight, 1),
  });

  it('hides a node and its subtree while its hkVis slot is exactly 0', () => {
    pose.showBySlots(graph(0, 1));
    expect(Array.from(pose.hidden ?? [])).toEqual([0, 1, 1, 0]);
    expect(pose.hiddenNode('weapon')).toBe(true);
    expect(pose.hiddenNode('SHIELD')).toBe(false);
  });

  it('shows it at any other value', () => {
    pose.showBySlots(graph(0.01, 1));
    expect(pose.hidden).toBeUndefined();
  });

  it('leaves alone the slots the model has no controller for (a draugr has none)', () => {
    const bare = new ActorPose(new ActorSkeleton({ ...rig, visibilitySlots: [] }, undefined));
    bare.showBySlots(graph(0, 1));
    expect(bare.hidden).toBeUndefined();
  });

  it('reads the value whatever its weight (an unset slot holds its reference value)', () => {
    pose.showBySlots(graph(0, 0));
    expect(pose.hiddenNode('Blade')).toBe(true);
  });
});
