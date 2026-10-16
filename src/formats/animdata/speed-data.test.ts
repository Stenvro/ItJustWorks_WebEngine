import { describe, expect, it } from 'vitest';
import { encodeWindows1252 } from '../text.ts';
import { parseSpeedData, speedAtParameter, speedParameter } from './speed-data.ts';

interface Curve {
  direction: number;
  points: [number, number][];
}

/** A speed data file: the text head, then the binary tables. */
function speedFile(
  projects: { path: string; tables: { state: number; curves: Curve[] }[] }[],
): Uint8Array {
  const head = encodeWindows1252(
    `${String(projects.length)}\r\n${projects.map((p) => `${p.path}\r\n`).join('')}`,
  );
  const words: { u32?: number; i32?: number; f32?: number }[] = [];
  for (const project of projects) {
    words.push({ u32: 1 }, { u32: project.tables.length });
    for (const table of project.tables) {
      words.push({ i32: table.state }, { u32: table.curves.length });
      for (const curve of table.curves) {
        words.push({ f32: curve.direction }, { u32: curve.points.length });
        for (const [x, y] of curve.points) words.push({ f32: x }, { f32: y });
      }
    }
  }
  const bytes = new Uint8Array(head.length + words.length * 4);
  bytes.set(head);
  const view = new DataView(bytes.buffer);
  words.forEach((word, i) => {
    const at = head.length + i * 4;
    if (word.f32 !== undefined) view.setFloat32(at, word.f32, true);
    else if (word.i32 !== undefined) view.setInt32(at, word.i32, true);
    else view.setUint32(at, word.u32 ?? 0, true);
  });
  return bytes;
}

// Forward: walk at parameter 50 moves at 50, run at 300 moves at 250. Back (0.5): slower.
const FORWARD: Curve = {
  direction: 0,
  points: [
    [0, 5],
    [50, 50],
    [300, 250],
    [300, 250],
  ],
};
const RIGHT: Curve = {
  direction: 0.25,
  points: [
    [0, 5],
    [50, 40],
    [300, 200],
  ],
};
const BACK: Curve = {
  direction: 0.5,
  points: [
    [0, 5],
    [50, 30],
    [300, 150],
  ],
};
const FILE = speedFile([
  { path: 'TestCritterData\\TestCritter.spd', tables: [{ state: 0, curves: [FORWARD] }] },
  {
    path: 'TestCharacterData\\TestCharacter.spd',
    tables: [
      { state: 0, curves: [FORWARD, RIGHT, BACK] },
      { state: 3, curves: [] },
    ],
  },
]);

describe('parseSpeedData', () => {
  const projects = parseSpeedData(FILE);

  it('reads the text head, then each project tables of curves', () => {
    expect(projects.map((project) => project.name)).toEqual(['TestCritter', 'TestCharacter']);
    const character = projects[1];
    expect(character?.version).toBe(1);
    expect(character?.tables.map((table) => table.state)).toEqual([0, 3]);
    expect(character?.tables[0]?.curves.map((curve) => curve.direction)).toEqual([0, 0.25, 0.5]);
    expect(character?.tables[0]?.curves[2]?.points).toEqual([
      [0, 5],
      [50, 30],
      [300, 150],
    ]);
  });

  it('throws a FormatError on bytes after the last project or points beyond the end', () => {
    const longer = new Uint8Array(FILE.length + 4);
    longer.set(FILE);
    expect(() => parseSpeedData(longer)).toThrow(/4 bytes after the last project/);
    expect(() => parseSpeedData(FILE.subarray(0, FILE.length - 8))).toThrow();
    expect(() => parseSpeedData(encodeWindows1252('x\r\n'))).toThrow(/no project count/);
  });
});

describe('speed lookups', () => {
  const table = parseSpeedData(FILE)[1]?.tables[0];
  if (!table) throw new Error('no table');

  it('gives the speed of a blend parameter, linear between points and directions', () => {
    expect(speedAtParameter(table, 0, 175)).toBeCloseTo(150);
    expect(speedAtParameter(table, 0.5, 50)).toBeCloseTo(30);
    expect(speedAtParameter(table, 0.125, 50)).toBeCloseTo(45);
    expect(speedAtParameter(table, 0, 400)).toBeCloseTo(250);
  });

  it('inverts the curves for the speed sampler: the parameter that reaches a goal speed', () => {
    expect(speedParameter(table, 0, 50)).toBeCloseTo(50);
    expect(speedParameter(table, 0, 150)).toBeCloseTo(175);
    expect(speedParameter(table, 0.5, 30)).toBeCloseTo(50);
    // Below the slowest point: the first parameter; beyond the fastest: the last.
    expect(speedParameter(table, 0, 0)).toBe(0);
    expect(speedParameter(table, 0, 1000)).toBeCloseTo(300);
  });

  it('wraps directions past the last curve back to the first', () => {
    // 0.75 lies between back (0.5) and forward again (1.0).
    expect(speedAtParameter(table, 0.75, 50)).toBeCloseTo(40);
    expect(speedAtParameter(table, 1.25, 50)).toBeCloseTo(40);
  });
});
