import { describe, expect, it } from 'vitest';
import {
  AT_ROOT,
  inVehicle,
  movedBy,
  PRISONER_CARRIAGE,
  tetherPlace,
  tow,
  wagonAt,
  wagonPose,
  type VehiclePose,
} from './vehicles.ts';

const NORTH: VehiclePose = { position: [0, 0, 0], heading: 0, pitch: 0 };

describe('towing a wagon', () => {
  it('has its rear axle a wheelbase behind its pivot', () => {
    const state = wagonAt(NORTH, PRISONER_CARRIAGE);
    expect(state.rear[1]).toBeCloseTo(-214.85);
    expect(wagonPose(state).heading).toBeCloseTo(0);
  });

  it('keeps a horse already in the shafts and brings one that stands off', () => {
    // MQ101's first cart: its horse 207.6 ahead and 35.4 right of its pivot.
    const near = tetherPlace(NORTH, { position: [35.4, 207.6, 0], heading: 0 }, PRISONER_CARRIAGE);
    expect(near.moved).toBe(false);
    // The second cart's horse stands 411 ahead: it is put in the shafts.
    const far = tetherPlace(
      { position: [100, 100, 5], heading: Math.PI / 2, pitch: 0 },
      { position: [511, 100, 7], heading: 1.4 },
      PRISONER_CARRIAGE,
    );
    expect(far.moved).toBe(true);
    expect(far.position[0]).toBeCloseTo(310.6);
    expect(far.position[1]).toBeCloseTo(100);
    expect(far.heading).toBeCloseTo(Math.PI / 2);
  });

  it('follows a horse going straight, its wheels turning by the way they roll', () => {
    let state = wagonAt(NORTH, PRISONER_CARRIAGE);
    for (let y = 210.6; y <= 210.6 + 100; y += 10) {
      state = tow(state, [0, y, 0], PRISONER_CARRIAGE);
    }
    const pose = wagonPose(state);
    expect(pose.position[1]).toBeCloseTo(100);
    expect(pose.heading).toBeCloseTo(0);
    expect(state.steer).toBeCloseTo(0);
    expect(state.frontSpin).toBeCloseTo(100 / PRISONER_CARRIAGE.frontWheelRadius);
    expect(state.rearSpin).toBeCloseTo(100 / PRISONER_CARRIAGE.rearWheelRadius);
  });

  it('turns behind a horse that turns, its front axle first', () => {
    let state = wagonAt(NORTH, PRISONER_CARRIAGE);
    // The horse turns east on a curve.
    const steps = 60;
    for (let i = 1; i <= steps; i++) {
      const angle = ((Math.PI / 2) * i) / steps;
      const radius = 600;
      state = tow(
        state,
        [radius - radius * Math.cos(angle), 210.6 + radius * Math.sin(angle), 0],
        PRISONER_CARRIAGE,
      );
      // The front axle leads the body (turned right), within its hinge.
      expect(state.steer).toBeGreaterThanOrEqual(0);
      expect(state.steer).toBeLessThanOrEqual(PRISONER_CARRIAGE.maxSteer);
    }
    const pose = wagonPose(state);
    expect(pose.heading).toBeGreaterThan(0.6);
    expect(pose.heading).toBeLessThan(Math.PI / 2);
    // The pivot stays the tether from the horse.
    expect(Math.hypot(600 - pose.position[0], 210.6 + 600 - pose.position[1])).toBeCloseTo(
      PRISONER_CARRIAGE.tether,
    );
  });

  it('stands on the ground and pitches with it', () => {
    let state = wagonAt(NORTH, PRISONER_CARRIAGE);
    // A slope rising to the north, 1 unit up per 10.
    const ground = (_x: number, y: number): number => y / 10;
    state = tow(state, [0, 220.6, 22], PRISONER_CARRIAGE, ground);
    const pose = wagonPose(state);
    expect(pose.position[2]).toBeCloseTo(1);
    expect(pose.pitch).toBeCloseTo(Math.atan2(state.front[2] - state.rear[2], 214.85), 2);
    expect(pose.pitch).toBeGreaterThan(0);
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
});
