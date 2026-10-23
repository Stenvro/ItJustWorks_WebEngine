import { describe, expect, it } from 'vitest';
import type { GraphChannels } from '../animation/behavior-runtime.ts';
import type { MovementType } from '../world/movement.ts';
import {
  Locomotion,
  MotionFeedback,
  steer,
  taggedMovementType,
  turnRate,
  Turning,
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
    // 87° still to turn: it goes ahead (the way it faces now) at cos 87° of the speed of the
    // way it wants to go.
    const speed = 370 * Math.cos(degrees(87));
    expect(step.velocity[0]).toBeCloseTo(speed * Math.sin(degrees(3)), 3);
    expect(step.velocity[1]).toBeCloseTo(speed * Math.cos(degrees(3)), 3);
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

describe("turning (the engine's angle controller)", () => {
  it('speeds up at its acceleration and stops on its goal without passing it', () => {
    let heading = 0;
    let rate = 0;
    const goal = degrees(90);
    const rates: number[] = [];
    for (let i = 0; i < 120; i++) {
      rate = turnRate(goal - heading, rate, degrees(180), degrees(720), 1 / 60);
      heading += rate / 60;
      rates.push(rate);
      expect(heading).toBeLessThanOrEqual(goal + 1e-9);
    }
    expect(heading).toBeCloseTo(goal, 3);
    // From standing it gains 12° a second each step, never more than its rate.
    expect(rates[0]).toBeCloseTo(degrees(12));
    expect(Math.max(...rates)).toBeLessThanOrEqual(degrees(180) + 1e-9);
    expect(rates[rates.length - 1]).toBe(0);
  });

  it('standing, settles on the heading and holds its facing within its tolerance', () => {
    const turning = new Turning();
    const types = { ...TYPES, angularAcceleration: 4 };
    let heading = 0;
    const tolerance = { tolerance: degrees(5), rateMult: 1, accelerationMult: 1 };
    for (let i = 0; i < 120; i++) {
      heading = steer(
        { gait: 'walk', face: degrees(30), turning: tolerance },
        heading,
        types,
        1 / 60,
        turning,
      ).heading;
    }
    expect(heading).toBeCloseTo(degrees(30), 2);
    expect(turning.settled).toBe(true);
    // A heading 3° off: it holds; 8° off: it turns again.
    const held = steer(
      { gait: 'walk', face: degrees(33), turning: tolerance },
      heading,
      types,
      1 / 60,
      turning,
    );
    expect(held.heading).toBeCloseTo(heading);
    const turned = steer(
      { gait: 'walk', face: degrees(38), turning: tolerance },
      heading,
      types,
      1 / 60,
      turning,
    );
    expect(turned.heading).toBeGreaterThan(heading);
    expect(turning.settled).toBe(false);
  });

  it('walks at a normalized pace between its walk and run speeds', () => {
    const step = steer({ direction: [0, 1], gait: 'walk', pace: 1.5 }, 0, TYPES, 1 / 60);
    expect(step.velocity[1]).toBeCloseTo(80 + 0.5 * (370 - 80));
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
  it("drives a latched graph by the movement at its updates (the graph's channels)", () => {
    const graph: ReturnType<typeof recorder> & { channels: GraphChannels | undefined } = {
      ...recorder(),
      channels: undefined,
    };
    const locomotion = new Locomotion();
    locomotion.latch(graph, frame({ velocity: [0, 80] }));
    // Nothing until the graph updates.
    expect(graph.events).toEqual([]);
    graph.channels?.read(0.2);
    expect(graph.events).toEqual(['moveStart']);
    // A frame's dip between two updates is not seen.
    locomotion.latch(graph, frame({ velocity: [0, 0] }));
    locomotion.latch(graph, frame({ velocity: [0, 80] }));
    graph.channels?.read(0.2);
    expect(graph.events).toEqual(['moveStart']);
    // Released: the graph's channels read nothing of it.
    locomotion.release();
    expect(graph.channels).toBeUndefined();
  });

  it('sets the speed and direction and starts and stops moving at 5 units a second', () => {
    const graph = recorder();
    const locomotion = new Locomotion();
    locomotion.drive([graph], frame({}));
    expect(graph.events).toEqual([]);
    // Slower than 5 units a second it stands.
    locomotion.drive([graph], frame({ velocity: [0, 4.9] }));
    expect(graph.events).toEqual([]);
    // Moving ahead.
    locomotion.drive([graph], frame({ velocity: [0, 100] }));
    expect(graph.values.get('Speed')).toBeCloseTo(100);
    expect(graph.values.get('Direction')).toBe(0);
    expect(graph.values.get('iSyncIdleLocomotion')).toBe(1);
    expect(graph.events).toEqual(['moveStart']);
    locomotion.drive([graph], frame({}));
    expect(graph.events).toEqual(['moveStart', 'moveStop']);
    expect(graph.values.get('iSyncIdleLocomotion')).toBe(0);
  });

  it('tells the graph as the way it goes changes half (forward and backward, left and right)', () => {
    const graph = recorder();
    const locomotion = new Locomotion();
    locomotion.drive([graph], frame({}));
    // Right of the facing: the back half begins at a quarter turn.
    locomotion.drive([graph], frame({ velocity: [100, 0] }));
    expect(graph.values.get('Direction')).toBeCloseTo(0.25);
    expect(graph.events).toEqual(['moveStart', 'moveBackward']);
    expect(graph.values.get('iSyncForwardState')).toBe(1);
    expect(graph.values.get('iSyncStrafeState')).toBe(0);
    // Ahead-left: the front half again, on the left.
    graph.events.length = 0;
    locomotion.drive([graph], frame({ velocity: [-50, 100] }));
    expect(graph.events).toEqual(['moveForward']);
    expect(graph.values.get('iSyncForwardState')).toBe(0);
    expect(graph.values.get('iSyncStrafeState')).toBe(1);
  });

  it('tells a graph that holds it in an idle that it sets out, and again once it lets go', () => {
    const graph = recorder();
    const locomotion = new Locomotion();
    locomotion.drive([graph], frame({}));
    // Held where it stands (bAnimationDriven) while its AI sends it off: moveStart at once.
    locomotion.drive([graph], frame({ settingOut: true }));
    expect(graph.events).toEqual(['moveStart']);
    expect(graph.values.get('Speed')).toBe(0);
    // Out of the idle it moves on: told again (the engine's idle stop performs the move again).
    locomotion.resume([graph]);
    locomotion.drive([graph], frame({ velocity: [0, 120] }));
    expect(graph.events).toEqual(['moveStart', 'moveStart']);
    // Standing still, nothing to resume.
    locomotion.drive([graph], frame({}));
    graph.events.length = 0;
    locomotion.resume([graph]);
    expect(graph.events).toEqual([]);
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

  it('ends a sprint before the movement and keeps iSyncSprintState with it', () => {
    const graph = recorder();
    const locomotion = new Locomotion();
    locomotion.drive([graph], frame({}));
    locomotion.drive([graph], frame({ velocity: [0, 500], sprinting: true }));
    expect(graph.values.get('iSyncSprintState')).toBe(1);
    // Stopping while sprinting: the sprint ends while the locomotion machine still runs.
    locomotion.drive([graph], frame({}));
    expect(graph.events).toEqual(['moveStart', 'SprintStart', 'SprintStop', 'moveStop']);
    expect(graph.values.get('iSyncSprintState')).toBe(0);
    // A sprint let go in the air: its sync variable has the graph land running.
    graph.events.length = 0;
    locomotion.drive([graph], frame({ velocity: [0, 500], sprinting: true }));
    locomotion.drive([graph], frame({ velocity: [0, 500], grounded: false, verticalSpeed: 10 }));
    locomotion.drive([graph], frame({ velocity: [0, 370] }));
    expect(graph.events).toEqual(['moveStart', 'SprintStart', 'SprintStop', 'JumpLandDirectional']);
    expect(graph.values.get('iSyncSprintState')).toBe(0);
  });

  it("freezes and cross-blends the player's cyclic blends on a large change at speed", () => {
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
    const freezeDirection = { angle: degrees(60), speed: 100 };
    const locomotion = new Locomotion();
    const at = (turn: number, speed = 370): [number, number] => [
      speed * Math.sin(turn * 2 * Math.PI),
      speed * Math.cos(turn * 2 * Math.PI),
    ];
    locomotion.drive([graph], frame({ velocity: at(0.95), freezeDirection }));
    // 18° across the wrap: no freeze.
    locomotion.drive([graph], frame({ velocity: at(0.0), freezeDirection }));
    // A quarter turn: frozen and cross-blended.
    locomotion.drive([graph], frame({ velocity: at(0.25), freezeDirection }));
    expect(order).toEqual([
      'Direction=0.95',
      'Direction=0.00',
      'CyclicFreeze',
      'Direction=0.25',
      'CyclicCrossBlend',
    ]);
    // Walking (slower than the freeze speed) and NPCs (no freeze): never.
    order.length = 0;
    locomotion.drive([graph], frame({ velocity: at(0.75, 80), freezeDirection }));
    const npc = new Locomotion();
    npc.drive([graph], frame({ velocity: at(0) }));
    npc.drive([graph], frame({ velocity: at(0.5) }));
    expect(order).toEqual(['Direction=0.75', 'Direction=0.00', 'Direction=0.50']);
  });

  it('gives the turn rate in degrees per second (left positive) and turns past 1° a second', () => {
    const graph = recorder();
    const locomotion = new Locomotion();
    locomotion.drive([graph], frame({}));
    locomotion.drive([graph], frame({ heading: degrees(1.5), seconds: 1 / 60 }));
    // A turn to the right (compass headings grow clockwise).
    expect(graph.values.get('TurnDelta')).toBeCloseTo(-90);
    expect(graph.values.get('iSyncTurnState')).toBe(0);
    // The turn its steering gives, rather than measured.
    locomotion.drive([graph], frame({ heading: degrees(1.5), turnRate: degrees(-45) }));
    expect(graph.values.get('TurnDelta')).toBeCloseTo(45);
    locomotion.drive([graph], frame({ heading: degrees(1.5), turnRate: degrees(0.5) }));
    expect(graph.values.get('iSyncTurnState')).toBe(1);
    locomotion.drive([graph], frame({ heading: degrees(1.5), turnRate: degrees(-30) }));
    expect(graph.values.get('iSyncTurnState')).toBe(2);
    expect(graph.events).toEqual(['turnRight', 'turnStop', 'turnLeft']);
  });

  it('falls and lands', () => {
    const graph = recorder();
    const locomotion = new Locomotion();
    locomotion.drive([graph], frame({}));
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

describe('the motion feedback to the graph', () => {
  it('tells what was wanted until what was made agrees for a while, then what was made', () => {
    const feedback = new MotionFeedback();
    // Facing +Y, wanting 300 ahead, made 290 (within 25): told 300 for half a second.
    let told = feedback.feed([0, 300], [0, 290], 0, 0.1);
    expect(told[1]).toBeCloseTo(300);
    for (let i = 0; i < 5; i++) told = feedback.feed([0, 300], [0, 290], 0, 0.1);
    expect(told[1]).toBeCloseTo(290);
    // Blocked: made nothing, far from what is wanted: what was wanted again.
    told = feedback.feed([0, 300], [0, 0], 0, 0.1);
    expect(told[1]).toBeCloseTo(300);
    // Slower than fMotionFeedbackMinSpeed (5): it stands, to its graph.
    told = feedback.feed([0, 3], [0, 0], 0, 0.1);
    expect(Math.hypot(...told)).toBe(0);
  });

  it('turns the direction told by at most a full turn a second', () => {
    const feedback = new MotionFeedback();
    feedback.feed([0, 300], [0, 0], 0, 0.1);
    // Wanting to go right (a quarter turn): a tenth of a second turns it 36° at most.
    const told = feedback.feed([300, 0], [0, 0], 0, 0.1);
    expect(Math.atan2(told[0], told[1])).toBeCloseTo((36 * Math.PI) / 180);
  });
});

describe('Locomotion falls and landings (the idle tree)', () => {
  it('asks for ActionFall while it falls and ActionLand as it lands, with the speed it came down at', async () => {
    const asked: string[] = [];
    let takes = false;
    const locomotion = new Locomotion({
      perform: (action) => {
        asked.push(action);
        return Promise.resolve(action === 'ActionFall' ? takes : true);
      },
    });
    const graph = recorder();
    locomotion.drive([graph], frame({}));
    // Off the ground, coming down: its fall is asked for; not taken (too slow), asked again
    // once 0.1 s has passed, not every frame.
    locomotion.drive([graph], frame({ grounded: false, verticalSpeed: -50 }));
    await Promise.resolve();
    await Promise.resolve();
    locomotion.drive([graph], frame({ grounded: false, verticalSpeed: -80 }));
    expect(asked).toEqual(['ActionFall']);
    takes = true;
    for (let i = 0; i < 6; i++) {
      locomotion.drive([graph], frame({ grounded: false, verticalSpeed: -400 }));
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(asked).toEqual(['ActionFall', 'ActionFall']);
    // No raw JumpFall: the idle the tree picks sends its own event.
    expect(graph.events).not.toContain('JumpFall');
    locomotion.drive([graph], frame({ grounded: true, verticalSpeed: 0 }));
    expect(asked).toEqual(['ActionFall', 'ActionFall', 'ActionLand']);
    expect(graph.values.get('VelocityZ')).toBe(-400);
  });
});
