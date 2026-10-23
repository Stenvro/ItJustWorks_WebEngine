import { describe, expect, it } from 'vitest';
import {
  AT_ROOT,
  blendPose,
  easeTowards,
  hitchPlace,
  inVehicle,
  leaningRoot,
  movedBy,
  poleTurn,
  PoseEasing,
  riderEvent,
  TETHER_LEAN_EASE,
  tetherJoint,
  tipImpulse,
  type CartSettings,
  type VehiclePose,
} from './vehicles.ts';

/** The engine's built-in [Cart] defaults. */
const CART: CartSettings = {
  horseOffset: [0, 200, 0],
  cartPivot: [0, 3, 0.7],
  horsePivot: [0, 0, 0],
  cartRot1: 10,
  cartRot2: 10,
  limitMin: -0.75,
  limitMax: 0.75,
  mass: 130,
  wheelFriction: 100,
  wheelAngularDamping: 0.01,
  wheelGravity: 3.5,
  tipImpulse: 500,
  tetherOffset: [50, 163, 13],
  poleZOffset: -20,
};

describe('tethering a cart', () => {
  it('puts the horse ahead of the cart, turned as the cart is', () => {
    // MQ101's second cart faces 342.8°; its horse stood 415 ahead.
    const heading = (342.8 * Math.PI) / 180;
    const horse = hitchPlace(
      { position: [22603.1, -94730, 13901.5], rotation: [0, 0, heading] },
      13910.3,
      CART,
    );
    expect(horse.position[0]).toBeCloseTo(22603.1 + 200 * Math.sin(heading));
    expect(horse.position[1]).toBeCloseTo(-94730 + 200 * Math.cos(heading));
    expect(horse.position[2]).toBeCloseTo(13910.3);
    expect(horse.rotation[2]).toBeCloseTo(heading);
  });

  it("joins the FrontBar 210 units ahead and 49 up to the horse's spine", () => {
    const joint = tetherJoint(CART);
    expect(joint.a.pivot[1]).toBeCloseTo(210, 0);
    expect(joint.a.pivot[2]).toBeCloseTo(49, 0);
    expect(joint.b.pivot).toEqual([0, 0, 0]);
    expect(joint.maxDistance).toBeCloseTo(52.5, 1);
    expect(joint.minDistance).toBeCloseTo(-52.5, 1);
    // The FrontBar slides along its up tilted 10°, the spine along its y tilted 10°.
    expect(joint.a.axes[0][2]).toBeCloseTo(Math.cos(Math.PI / 18));
    expect(joint.b.axes[0][1]).toBeCloseTo(Math.cos(Math.PI / 18));
    for (const frame of [joint.a, joint.b]) {
      const [axis, perp] = frame.axes;
      expect(axis[0] * perp[0] + axis[1] * perp[1] + axis[2] * perp[2]).toBeCloseTo(0);
    }
  });

  it('turns the pole to point at the horse', () => {
    const turn = poleTurn([0, 60, 50], [0, 260, 130]);
    // Its length (the turned y, the matrix's second column) points along the way to the horse.
    const length = Math.hypot(200, 80);
    expect(turn[3]).toBeCloseTo(0);
    expect(turn[4]).toBeCloseTo(200 / length);
    expect(turn[5]).toBeCloseTo(80 / length);
    // Straight ahead it stays as it is.
    poleTurn([0, 0, 0], [0, 10, 0]).forEach((v, i) => {
      expect(v).toBeCloseTo([1, 0, 0, 0, 1, 0, 0, 0, 1][i] ?? 0);
    });
  });

  it('rights a cart tipping over, and leaves one that stands', () => {
    // Its right axis level, or rising and sinking up to 0.71.
    expect(tipImpulse(0, 1, CART)).toBeUndefined();
    expect(tipImpulse(0.5, 0.87, CART)).toBeUndefined();
    expect(tipImpulse(-0.7, 0.71, CART)).toBeUndefined();
    // Its right side up (lying on its left): a positive turn about its forward axis takes that
    // side down; lying on its right, a negative one; upside down too.
    expect(tipImpulse(0.8, 0.6, CART)).toBe(500);
    expect(tipImpulse(-0.8, 0.6, CART)).toBe(-500);
    expect(tipImpulse(-0.1, -0.99, CART)).toBe(-500);
  });
});

describe("following the horse's spine", () => {
  const at = (x: number): Float32Array =>
    Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1);

  it('eases into each new pose over the time the last one took', () => {
    const easing = new PoseEasing();
    const step = 1 / 60;
    expect(easing.step(at(0), step)[12]).toBe(0);
    // Six steps on (an update ten times a second) the pose moves 6: shown a sixth of the way
    // each step, there after six.
    for (let i = 0; i < 5; i++) easing.step(at(0), step);
    const shown = [1, 2, 3, 4, 5, 6].map(() => easing.step(at(6), step)[12] ?? 0);
    shown.forEach((x, i) => {
      expect(x).toBeCloseTo(i + 1, 4);
    });
    // Updated every step from then on, it follows at once.
    easing.step(at(7), step);
    expect(easing.step(at(8), step)[12]).toBeCloseTo(8, 4);
  });

  it('keeps a blended pose rigid', () => {
    const turned = Float32Array.of(0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1);
    const half = blendPose(at(0), turned, 0.5);
    expect(Math.hypot(half[0] ?? 0, half[1] ?? 0, half[2] ?? 0)).toBeCloseTo(1);
    expect(Math.hypot(half[4] ?? 0, half[5] ?? 0, half[6] ?? 0)).toBeCloseTo(1);
    expect((half[0] ?? 0) * (half[4] ?? 0) + (half[1] ?? 0) * (half[5] ?? 0)).toBeCloseTo(0);
    expect(half[12]).toBeCloseTo(5);
  });

  it('leans as the horse leans, easing towards it', () => {
    const slope: [number, number, number] = [0, -Math.sin(0.3), Math.cos(0.3)];
    let lean = easeTowards(undefined, [0, 0, 1], 1 / 60, TETHER_LEAN_EASE);
    for (let i = 0; i < 18; i++) lean = easeTowards(lean, slope, 1 / 60, TETHER_LEAN_EASE);
    // After 0.3 s about two thirds of the way.
    const angle = Math.acos(lean[2]);
    expect(angle).toBeGreaterThan(0.17);
    expect(angle).toBeLessThan(0.21);
    // Its root: facing its heading (north), pitched with the lean, at its feet.
    const root = leaningRoot([1, 2, 3], 0, slope, 1);
    expect(root[5]).toBeCloseTo(Math.cos(0.3));
    expect(root[6]).toBeCloseTo(Math.sin(0.3));
    expect(root[0]).toBeCloseTo(1);
    expect([root[12], root[13], root[14]]).toEqual([1, 2, 3]);
  });
});

describe('riding a vehicle', () => {
  it('stands at the vehicle root, turned with it', () => {
    const pose: VehiclePose = { position: [10, 20, 30], heading: Math.PI / 2, pitch: 0 };
    const at = inVehicle(pose, AT_ROOT);
    expect(at.position).toEqual([10, 20, 30]);
    expect(at.heading).toBeCloseTo(Math.PI / 2);
    // 100 forward in a vehicle facing east is 100 east.
    const ahead = inVehicle(pose, { position: [0, 100, 0], heading: 0 });
    expect(ahead.position[0]).toBeCloseTo(110);
    expect(ahead.position[1]).toBeCloseTo(20);
  });

  it('rises with a vehicle that pitches up', () => {
    const pose: VehiclePose = { position: [0, 0, 0], heading: 0, pitch: Math.PI / 6 };
    const seat = inVehicle(pose, { position: [0, -200, 0], heading: 0 });
    expect(seat.position[1]).toBeCloseTo(-200 * Math.cos(Math.PI / 6));
    expect(seat.position[2]).toBeCloseTo(-100);
  });

  it("is moved out by an exit's root motion in its own frame", () => {
    // CartPrisonerAExit: 380 back, turning 170° (counter-clockwise).
    const offset = movedBy(AT_ROOT, {
      translation: [-16.2, -379.8, 0],
      yaw: (170 * Math.PI) / 180,
    });
    expect(offset.position[1]).toBeCloseTo(-379.8);
    expect(offset.heading).toBeCloseTo((-170 * Math.PI) / 180);
    // Turned, its forward is the vehicle's back.
    const next = movedBy(offset, { translation: [0, 10, 0], yaw: 0 });
    expect(next.position[1]).toBeLessThan(offset.position[1]);
  });

  it("lets go at its exit's start and ends the ride at its end", () => {
    expect(riderEvent('ExitCartBegin')).toBe('detach');
    expect(riderEvent('NPCDetach')).toBe('detach');
    expect(riderEvent('ExitCartEnd')).toBe('end');
    expect(riderEvent('IdleStop')).toBeUndefined();
  });
});
