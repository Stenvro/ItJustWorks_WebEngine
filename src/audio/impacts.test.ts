import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../render/math.ts';
import type { Impact, ImpactDataSet } from '../world/impact-records.ts';
import type { MaterialType } from '../world/material-type.ts';
import { ImpactSounds, type ImpactHit, type ImpactRecords } from './impacts.ts';

const material = (
  formId: number,
  id: number,
  parent?: number,
  impactDataSet?: number,
): MaterialType => ({
  formId,
  editorId: `MATT${formId.toString(16)}`,
  name: '',
  id,
  parent,
  buoyancy: 0,
  flags: 0,
  impactDataSet,
});

const impact = (formId: number, sound?: number, heavySound?: number): Impact => ({
  formId,
  editorId: `IPCT${formId.toString(16)}`,
  duration: 0.25,
  orientation: 2,
  angleThreshold: 15,
  placementRadius: 16,
  soundLevel: 1,
  flags: 0,
  sound,
  heavySound,
  hazard: undefined,
  model: undefined,
});

// Ceramic (id 1, its own set) and a plate (id 2, a child of ceramic without a set) hitting
// stone (id 3), wood (id 4: a child of stone) or the landscape (dirt, form 0x50).
const materials = [
  material(0x10, 1, undefined, 0x100),
  material(0x20, 2, 0x10),
  material(0x30, 3),
  material(0x40, 4, 0x30),
  material(0x50, 5),
];
const sets = new Map<number, ImpactDataSet>([
  [
    0x100,
    {
      formId: 0x100,
      editorId: 'CeramicImpactSet',
      impacts: new Map([
        [0x30, 0x200],
        [0x50, 0x201],
      ]),
    },
  ],
]);
const impacts = new Map<number, Impact>([
  [0x200, impact(0x200, 0x1000, 0x1001)],
  [0x201, impact(0x201, 0x1002)],
]);

const records: ImpactRecords = {
  materialById: (id) => Promise.resolve(materials.find((m) => m.id === id)),
  material: (formId) => Promise.resolve(materials.find((m) => m.formId === formId)),
  impactDataSet: (formId) => Promise.resolve(sets.get(formId)),
  impact: (formId) => Promise.resolve(impacts.get(formId)),
  landMaterial: 0x50,
  landMaterialAt: () => undefined,
};

const hit = (overrides: Partial<ImpactHit>): ImpactHit => ({
  position: [1, 2, 3],
  speed: 100,
  material: 1,
  against: 3,
  againstKind: 'object',
  body: 7,
  ...overrides,
});

function sounds(): { impacts: ImpactSounds; played: [number, Vec3][] } {
  const played: [number, Vec3][] = [];
  const impacts = new ImpactSounds(records, { heavySpeed: 160, interval: 0.15 }, (sound, at) => {
    played.push([sound, at]);
  });
  return { impacts, played };
}

describe('impact sounds', () => {
  it('plays the light sound, or the heavy one from the heavy threshold', async () => {
    const { impacts, played } = sounds();
    await impacts.hit(hit({ speed: 100 }), 0);
    await impacts.hit(hit({ speed: 200, body: 8 }), 0);
    expect(played).toEqual([
      [0x1000, [1, 2, 3]],
      [0x1001, [1, 2, 3]],
    ]);
  });

  it('uses the parents of both materials, and the land material for the landscape', async () => {
    const { impacts, played } = sounds();
    // A plate (no set: ceramic's) on wood (no entry: stone's).
    await impacts.hit(hit({ material: 2, against: 4 }), 0);
    await impacts.hit(hit({ against: 0, againstKind: 'landscape', body: 8 }), 0);
    // A heavy hit without a heavy sound plays the light one.
    await impacts.hit(hit({ against: 0, againstKind: 'landscape', body: 9, speed: 500 }), 0);
    await impacts.hit(hit({ against: 0, againstKind: 'object', body: 10 }), 0);
    expect(played.map(([sound]) => sound)).toEqual([0x1000, 0x1002, 0x1002]);
  });

  it('lets one body sound at most once per interval', async () => {
    const { impacts, played } = sounds();
    await impacts.hit(hit({}), 0);
    await impacts.hit(hit({}), 0.1);
    await impacts.hit(hit({}), 0.2);
    expect(played).toHaveLength(2);
  });
});
