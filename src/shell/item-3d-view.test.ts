import { describe, expect, it } from 'vitest';
import { transformPoint } from '../render/math.ts';
import {
  itemMatrix,
  itemScale,
  markerRotation,
  mouseTurn,
  NO_ROTATION,
  stickTurn,
  turned,
  zoomStep,
} from './item-3d-view.ts';

const round = (c: number): number => Math.round(c * 1000) / 1000 + 0;

const apply = (r: readonly number[], v: readonly number[]): number[] =>
  [0, 1, 2].map((row) =>
    [0, 1, 2].reduce((sum, col) => sum + (r[row * 3 + col] ?? 0) * (v[col] ?? 0), 0),
  );

describe('the item menus 3D view', () => {
  it('stands a model without a marker as modelled', () => {
    expect(markerRotation(undefined)).toEqual(NO_ROTATION);
  });

  it('turns by the marker as x, then y, then z in thousandths of a radian', () => {
    // A quarter turn about z alone: +X goes to −Y (the NIF's turn direction).
    const z = markerRotation({ rotation: [0, 0, 1571], zoom: 1 });
    expect(apply(z, [1, 0, 0]).map(round)).toEqual([0, -1, 0]);
    // x (a quarter) and z (a quarter): R = Rx·Rz, so +X goes through z first, then x.
    const xz = markerRotation({ rotation: [1571, 0, 1571], zoom: 1 });
    expect(apply(xz, [1, 0, 0]).map(round)).toEqual([0, 0, 1]);
  });

  it('scales by the bound radius, the place, the marker zoom and a screen wider than 16:9', () => {
    const base = { boundRadiusScale: 12.5, radius: 25, placeScale: 1.87, aspect: 16 / 9 };
    expect(itemScale({ ...base, marker: undefined })).toBeCloseTo(0.935);
    expect(itemScale({ ...base, marker: { rotation: [0, 0, 0], zoom: 2 } })).toBeCloseTo(1.87);
    expect(itemScale({ ...base, marker: undefined, aspect: 32 / 9 })).toBeCloseTo(0.4675);
    expect(itemScale({ ...base, marker: undefined, radius: 0 })).toBeCloseTo(1.87);
  });

  it('puts the bound centre at the place however it is turned', () => {
    const rotation = turned(markerRotation({ rotation: [300, 700, 1100], zoom: 1 }), 0.4, -0.2);
    const world = itemMatrix(rotation, 2, [3, -4, 5], [-38, -500, 16]);
    const at = transformPoint(world, [3, -4, 5]);
    expect(at[0]).toBeCloseTo(-38);
    expect(at[1]).toBeCloseTo(-500);
    expect(at[2]).toBeCloseTo(16);
  });

  it('turns about the menu axes before the item rotation', () => {
    // An item turned a quarter about x, then dragged a quarter about the menu's up axis: its
    // +X goes about the menu's Z, not its own.
    const tilted = markerRotation({ rotation: [1571, 0, 0], zoom: 1 });
    const dragged = turned(tilted, Math.PI / 2, 0);
    expect(apply(dragged, [1, 0, 0]).map(round)).toEqual([0, -1, 0]);
  });

  it('turns by the mouse as the mouse look scales it', () => {
    const settings = { speed: 50, sensitivity: 0.0125, xScale: 0.02, yScale: 0.85, invertY: false };
    const turn = mouseTurn(80, 0, 1 / 60, settings);
    expect(turn.aboutUp).toBeCloseTo(-1);
    expect(turn.aboutAcross).toBeCloseTo(0);
    expect(mouseTurn(0, 10, 0.02, settings).aboutAcross).toBeCloseTo(
      10 * 50 * 0.02 * 0.0125 * 0.85,
    );
    expect(mouseTurn(0, 10, 0.02, { ...settings, invertY: true }).aboutAcross).toBeLessThan(0);
  });

  it('turns by a stick on its stronger axis alone', () => {
    const across = stickTurn(0.8, 0.3, 0.5, 3);
    expect(across.aboutUp).toBeCloseTo(-1.2);
    expect(across.aboutAcross).toBe(0);
    const upDown = stickTurn(0.3, -0.8, 0.5, 3);
    expect(upDown.aboutUp).toBe(0);
    expect(upDown.aboutAcross).toBeCloseTo(1.2);
  });

  it('zooms in a straight line at the zoom speed', () => {
    expect(zoomStep(0, true, 0.2, 1.5)).toBeCloseTo(0.3);
    expect(zoomStep(0.9, true, 0.2, 1.5)).toBe(1);
    expect(zoomStep(0.1, false, 0.2, 1.5)).toBe(0);
  });
});
