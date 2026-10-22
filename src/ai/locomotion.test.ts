import { describe, expect, it } from 'vitest';
import type { MovementType } from '../world/movement.ts';
import {
  Locomotion,
  steer,
  taggedMovementType,
  type LocomotionFrame,
  type LocomotionGraph,
} from './locomotion.ts';

const degrees = (value: number): number => (value * Math.PI) / 180;

/** NPC_Default_MT's speeds and turn rates. */
const NPC_DEFAULT: MovementType = {
  formId: 1,
  editorId: 'NPC_Default_MT',
  name: 'NPCDefault',
  walk: { left: 80, right: 80, forward: 80, back: 72 },
  run: { left: 370, right: 370, forward: 370, back: 205 },
  rotateInPlace: { walk: degrees(180), run: degrees(180) },
  rotateWhileMoving: degrees(180),
};
const SPRINT: MovementType = {
  ...NPC_DEFAULT,
  editorId: 'NPC_Sprinting_MT',
  name: 'NPCSprinting',
  run: { left: 0, right: 0, forward: 500, back: 0 },
};

const TYPES = { walk: NPC_DEFAULT, run: NPC_DEFAULT };

describe('steer', () => {
  it('walks ahead at the walking speed', () => {
    const step = steer({ direction: [0, 1], gait: 'walk' }, 0, TYPES, 1 / 60);
    expect(step.velocity[0]).toBeCloseTo(0);
    expect(step.velocity[1]).toBeCloseTo(80);
    expect(step.heading).toBeCloseTo(0);
  });

  it('turns towards the way it goes at the turn rate, slowing for the turn left', () => {
    // Facing north, wanting east: it turns 3° in a sixtieth of a second at 180°/s.
    const step = steer({ direction: [1, 0], gait: 'run' }, 0, TYPES, 1 / 60);
    expect(step.heading).toBeCloseTo(degrees(3));
    // 87° still to turn: it goes on east at cos 87° of the speed of that direction.
    expect(step.velocity[1]).toBeCloseTo(0);
    expect(step.velocity[0]).toBeCloseTo(370 * Math.cos(degrees(87)), 3);
  });

  it('stands while it turns round', () => {
    const step = steer({ direction: [0, -1], gait: 'walk' }, 0, TYPES, 1 / 60);
    expect(Math.hypot(...step.velocity)).toBeCloseTo(0);
    expect(Math.abs(step.heading)).toBeCloseTo(degrees(3));
  });

  it('strafes at the side speed when it keeps a heading', () => {
    const step = steer({ direction: [1, 0], gait: 'run', face: 0 }, 0, TYPES, 1 / 60);
    expect(step.heading).toBeCloseTo(0);
    expect(step.velocity[0]).toBeCloseTo(370);
  });

  it('sprints at the sprint type speed and turns in place standing', () => {
    const sprint = steer(
      { direction: [0, 1], gait: 'sprint' },
      0,
      { walk: NPC_DEFAULT, run: NPC_DEFAULT, sprint: SPRINT },
      1 / 60,
    );
    expect(sprint.velocity[1]).toBeCloseTo(500);
    const turn = steer({ gait: 'walk', face: degrees(90) }, 0, TYPES, 0.25);
    expect(turn.heading).toBeCloseTo(degrees(45));
    expect(turn.velocity).toEqual([0, 0]);
  });
});

/** A graph that records what it is told. */
function recorder(): LocomotionGraph & {
  readonly values: Map<string, number>;
  readonly events: string[];
} {
  const values = new Map<string, number>();
  const events: string[] = [];
  return {
    values,
    events,
    setVariable: (name, value) => {
      values.set(name, value);
    },
    sendEvent: (name) => {
      events.push(name);
      return true;
    },
  };
}

const frame = (overrides: Partial<LocomotionFrame>): LocomotionFrame => ({
  velocity: [0, 0],
  heading: 0,
  seconds: 1 / 60,
  grounded: true,
  swimming: false,
  verticalSpeed: 0,
  sprinting: false,
  sneaking: false,
  ...overrides,
});

describe('Locomotion', () => {
  it('sets the speed and direction and starts and stops moving', () => {
    const graph = recorder();
    const locomotion = new Locomotion();
    locomotion.drive([graph], frame({}));
    expect(graph.events).toEqual([]);
    // Moving right of the facing.
    locomotion.drive([graph], frame({ velocity: [100, 0] }));
    expect(graph.values.get('Speed')).toBeCloseTo(100);
    expect(graph.values.get('Direction')).toBeCloseTo(0.25);
    expect(graph.values.get('iSyncIdleLocomotion')).toBe(1);
    expect(graph.events).toEqual(['moveStart']);
    locomotion.drive([graph], frame({}));
    expect(graph.events).toEqual(['moveStart', 'moveStop']);
  });

  it('tells a graph that holds it in an idle that it sets out (moveStart ends the idle)', () => {
    const graph = recorder();
    const locomotion = new Locomotion();
    locomotion.drive([graph], frame({}));
    // Held where it stands (bAnimationDriven) while its AI sends it off: moveStart at once.
    locomotion.drive([graph], frame({ settingOut: true }));
    expect(graph.events).toEqual(['moveStart']);
    expect(graph.values.get('Speed')).toBe(0);
    // Out of the idle it moves on as measured.
    locomotion.drive([graph], frame({ velocity: [0, 120] }));
    expect(graph.events).toEqual(['moveStart']);
  });

  it('drives graphs given once by a generator (the player body and first-person graphs)', () => {
    const body = recorder();
    const first = recorder();
    function* graphs(): Iterable<LocomotionGraph> {
      yield body;
      yield first;
    }
    const locomotion = new Locomotion();
    locomotion.drive(graphs(), frame({}));
    locomotion.drive(graphs(), frame({ velocity: [0, 300] }));
    expect(body.events).toEqual(['moveStart']);
    expect(first.events).toEqual(['moveStart']);
    expect(first.values.get('Direction')).toBe(0);
  });

  it('freezes and cross-blends the cyclic blends as the direction wraps round', () => {
    const order: string[] = [];
    const graph: LocomotionGraph = {
      setVariable: (name, value) => {
        if (name === 'Direction') order.push(`Direction=${value.toFixed(2)}`);
      },
      sendEvent: (name) => {
        if (name.startsWith('Cyclic')) order.push(name);
        return true;
      },
    };
    const locomotion = new Locomotion();
    // Ahead-left (0.95 of the turn), then ahead-right (0.05): across 0.
    const at = (turn: number): [number, number] => [
      100 * Math.sin(turn * 2 * Math.PI),
      100 * Math.cos(turn * 2 * Math.PI),
    ];
    locomotion.drive([graph], frame({ velocity: at(0.95) }));
    locomotion.drive([graph], frame({ velocity: at(0.9) }));
    locomotion.drive([graph], frame({ velocity: at(0.05) }));
    expect(order).toEqual([
      'Direction=0.95',
      'Direction=0.90',
      'CyclicFreeze',
      'Direction=0.05',
      'CyclicCrossBlend',
    ]);
    // Starting to move from standing is no wrap.
    order.length = 0;
    locomotion.drive([graph], frame({}));
    locomotion.drive([graph], frame({ velocity: at(0.75) }));
    expect(order).toEqual(['Direction=0.00', 'Direction=0.75']);
  });

  it('gives the turn rate in degrees per second (left positive) and lands from the air', () => {
    const graph = recorder();
    const locomotion = new Locomotion();
    locomotion.drive([graph], frame({}));
    locomotion.drive([graph], frame({ heading: degrees(1.5), seconds: 1 / 60 }));
    // A turn to the right (compass headings grow clockwise).
    expect(graph.values.get('TurnDelta')).toBeCloseTo(-90);
    locomotion.drive([graph], frame({ grounded: false, verticalSpeed: -10 }));
    expect(locomotion.drive([graph], frame({}))).toBe(true);
    expect(graph.events).toEqual(['JumpFall', 'JumpLand']);
  });
});

describe('taggedMovementType', () => {
  it('names the movement type whose iState variable holds the tagged state', () => {
    const graph = {
      taggedState: () => 2,
      variablesNamed: () => [
        { name: 'iState_NPCDefault', value: 0 },
        { name: 'iState_NPCSneaking', value: 2 },
      ],
    };
    expect(taggedMovementType(graph)).toBe('NPCSneaking');
    expect(taggedMovementType({ ...graph, taggedState: () => undefined })).toBeUndefined();
  });
});
