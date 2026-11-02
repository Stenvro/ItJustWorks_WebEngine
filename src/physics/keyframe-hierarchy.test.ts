import { describe, expect, it } from 'vitest';
import {
  blendObjectControl,
  driveHierarchy,
  HARD_KEYFRAME,
  integrate,
  type BodyFrame,
  type HierarchyBody,
  type HierarchyControl,
  type Quat,
} from './keyframe-hierarchy.ts';
import type { Vec3 } from '../render/math.ts';

/** An entry that must be there. */
function at<T>(list: readonly (T | undefined)[], i: number): T {
  const entry = list[i];
  if (entry === undefined) throw new Error(`no entry ${i}`);
  return entry;
}

const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };
const turnZ = (angle: number): Quat => ({
  x: 0,
  y: 0,
  z: Math.sin(angle / 2),
  w: Math.cos(angle / 2),
});

/** The rigid body ragdoll controls of most vanilla graphs (Havok's defaults). */
const GRAPH: HierarchyControl = {
  hierarchyGain: 0.17,
  velocityDamping: 0,
  accelerationGain: 1,
  velocityGain: 0.6,
  positionGain: 0.05,
  positionMaxLinearVelocity: 1.4,
  positionMaxAngularVelocity: 1.8,
  snapGain: 0.1,
  snapMaxLinearVelocity: 0.3,
  snapMaxAngularVelocity: 0.3,
  snapMaxLinearDistance: 0.03,
  snapMaxAngularDistance: 0.1,
};

/** A two-body chain (a bone and the one under it) animated along a path; returns the errors. */
function run(
  control: HierarchyControl,
  steps: number,
  pose: (t: number) => readonly [BodyFrame, BodyFrame],
): number[] {
  const dt = 1 / 60;
  let motion = pose(0).map((frame) => ({
    ...frame,
    linear: [0, 0, 0] as Vec3,
    angular: [0, 0, 0] as Vec3,
  }));
  let previous: readonly BodyFrame[] | undefined;
  const errors: number[] = [];
  for (let i = 1; i <= steps; i++) {
    const target = pose(i * dt);
    const bodies: HierarchyBody[] = target.map((frame, b) => ({
      parent: b - 1,
      control,
      target: frame,
      previous: previous?.[b],
      motion: at(motion, b),
    }));
    const velocities = driveHierarchy(bodies, dt);
    motion = motion.map((m, b) => {
      const v = at(velocities, b);
      return { ...integrate(m, v.linear, v.angular, dt), linear: v.linear, angular: v.angular };
    });
    errors.push(
      Math.max(
        ...motion.map((m, b) => {
          const t = at(target, b).position;
          return Math.hypot(m.position[0] - t[0], m.position[1] - t[1], m.position[2] - t[2]);
        }),
      ),
    );
    previous = target;
  }
  return errors;
}

/** The root swinging round the z axis while sliding along x; the child one unit out from it. */
const swing = (t: number): readonly [BodyFrame, BodyFrame] => {
  const angle = Math.sin(t * 3);
  const root: BodyFrame = { position: [t * 2, 0, 1], rotation: turnZ(angle) };
  const child: BodyFrame = {
    position: [t * 2 + Math.cos(angle), Math.sin(angle), 1],
    rotation: turnZ(angle),
  };
  return [root, child];
};

describe('keyframe hierarchy controller', () => {
  it('keyframes exactly with full gains (the blend collision objects of the data, 1 and 1)', () => {
    expect(blendObjectControl({ heirGain: 1, velocityGain: 1 })).toEqual(HARD_KEYFRAME);
    for (const error of run(HARD_KEYFRAME, 120, swing)) expect(error).toBeLessThan(1e-6);
  });

  it('follows the animation with the graph gains, behind it but within reach', () => {
    const errors = run(GRAPH, 240, swing);
    // Softly driven: it lags while the pose moves, never more than a fraction of the motion.
    expect(Math.max(...errors)).toBeGreaterThan(1e-3);
    expect(Math.max(...errors)).toBeLessThan(1);
  });

  it('comes to its pose at rest by position matching and snapping', () => {
    const still = (): readonly [BodyFrame, BodyFrame] => [
      { position: [0, 0, 1], rotation: IDENTITY },
      { position: [1, 0, 1], rotation: IDENTITY },
    ];
    const dt = 1 / 60;
    let motion = [
      {
        position: [0.5, 0, 1] as Vec3,
        rotation: turnZ(0.3),
        linear: [0, 0, 0] as Vec3,
        angular: [0, 0, 0] as Vec3,
      },
      {
        position: [1.4, 0.3, 1] as Vec3,
        rotation: IDENTITY,
        linear: [0, 0, 0] as Vec3,
        angular: [0, 0, 0] as Vec3,
      },
    ];
    const first = Math.hypot(at(motion, 0).position[0], 0);
    for (let i = 0; i < 600; i++) {
      const target = still();
      const velocities = driveHierarchy(
        target.map((frame, b) => ({
          parent: b - 1,
          control: GRAPH,
          target: frame,
          previous: frame,
          motion: at(motion, b),
        })),
        dt,
      );
      motion = motion.map((m, b) => {
        const v = at(velocities, b);
        return { ...integrate(m, v.linear, v.angular, dt), linear: v.linear, angular: v.angular };
      });
    }
    expect(Math.abs(at(motion, 0).position[0])).toBeLessThan(first / 100);
    expect(Math.hypot(at(motion, 1).position[0] - 1, at(motion, 1).position[1])).toBeLessThan(0.01);
  });

  it('limits position matching and snapping to their velocities', () => {
    const only: HierarchyControl = { ...GRAPH, hierarchyGain: 0, velocityGain: 0 };
    const [velocity] = driveHierarchy(
      [
        {
          parent: -1,
          control: only,
          target: { position: [5, 0, 0], rotation: turnZ(2) },
          previous: undefined,
          motion: {
            position: [0, 0, 0],
            rotation: IDENTITY,
            linear: [0, 0, 0],
            angular: [0, 0, 0],
          },
        },
      ],
      1 / 60,
    );
    const most = (a: number, b: number): number => a + b + 1e-9;
    expect(Math.hypot(...at([velocity], 0).linear)).toBeLessThanOrEqual(
      most(GRAPH.positionMaxLinearVelocity, GRAPH.snapMaxLinearVelocity),
    );
    expect(Math.hypot(...at([velocity], 0).angular)).toBeLessThanOrEqual(
      most(GRAPH.positionMaxAngularVelocity, GRAPH.snapMaxAngularVelocity),
    );
  });

  it('blends in from the bodies own velocities (durationToBlend)', () => {
    const body: HierarchyBody = {
      parent: -1,
      control: HARD_KEYFRAME,
      target: { position: [1, 0, 0], rotation: IDENTITY },
      previous: undefined,
      motion: { position: [0, 0, 0], rotation: IDENTITY, linear: [0, 0, -2], angular: [0, 0, 0] },
    };
    expect(at(driveHierarchy([body], 0.5, 0), 0).linear).toEqual([0, 0, -2]);
    const half = at(driveHierarchy([body], 0.5, 0.5), 0).linear;
    expect(half[0]).toBeCloseTo(1);
    expect(half[2]).toBeCloseTo(-1);
    expect(at(driveHierarchy([body], 0.5, 1), 0).linear[0]).toBeCloseTo(2);
  });
});
