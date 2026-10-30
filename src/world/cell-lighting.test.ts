import { describe, expect, it } from 'vitest';
import type { CellLight } from './cell-loader.ts';
import { lightingInRoom, pointLights } from './cell-lighting.ts';
import type { CellLighting } from './cell-records.ts';

const lighting = (fogNear: number): CellLighting => ({ fogNear }) as unknown as CellLighting;

describe('lightingInRoom', () => {
  const cell = lighting(1);
  const room = lighting(2);
  const data = { lighting: cell, roomLighting: [undefined, room] };

  it('takes the room’s own lighting template while the camera is in it', () => {
    expect(lightingInRoom(data, 1)).toBe(room);
  });

  it('keeps the cell’s lighting outside the rooms and in rooms without a template', () => {
    expect(lightingInRoom(data, -1)).toBe(cell);
    expect(lightingInRoom(data, 0)).toBe(cell);
    expect(lightingInRoom({ lighting: cell }, 1)).toBe(cell);
  });
});

describe('pointLights', () => {
  const light: CellLight = {
    reference: 0x1234,
    position: [0, 0, 0],
    radius: 256,
    color: [1, 1, 1],
    fade: 1,
    flags: 0,
    period: 1,
    intensityAmplitude: 0,
    movementAmplitude: 0,
  };

  it("passes on a reference's Doesn't Light Landscape flag (land leaves the light out)", () => {
    const [plain, unlit] = pointLights([light, { ...light, unlitLand: true }], 0);
    expect(plain?.lightsLand).toBeUndefined();
    expect(unlit?.lightsLand).toBe(false);
  });
});
