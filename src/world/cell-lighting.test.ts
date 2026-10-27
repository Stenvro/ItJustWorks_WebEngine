import { describe, expect, it } from 'vitest';
import { lightingInRoom } from './cell-lighting.ts';
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
