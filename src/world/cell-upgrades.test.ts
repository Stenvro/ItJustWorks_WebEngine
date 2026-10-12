import { describe, expect, it } from 'vitest';
import { identity } from '../render/math.ts';
import type { CellData, ReferenceState } from './cell-loader.ts';
import {
  allUpgradesSelection,
  enabledReferences,
  findUpgrades,
  gameStartSelection,
  toggleUpgrade,
} from './cell-upgrades.ts';

/** A small player home: dining room, kitchen, and two alternatives for one room. */
const MARKERS = {
  diningStart: 0x10,
  dining: 0x11,
  lab: 0x12,
  bedroom: 0x13, // from a later plugin
  labStart: 0x14,
  kitchen: 0x15,
};

let nextSpot = 0;

function ref(
  editorId: string,
  parent?: number,
  options: { opposite?: boolean; disabled?: boolean; spot?: string } = {},
): ReferenceState {
  return {
    editorId,
    initiallyDisabled: options.disabled ?? false,
    parent:
      parent === undefined ? undefined : { formId: parent, opposite: options.opposite ?? false },
    placementKey: options.spot ?? `spot-${nextSpot++}`,
  };
}

const references = new Map<number, ReferenceState>([
  [MARKERS.diningStart, ref('PlayerHouseDiningRoomStart')],
  [MARKERS.dining, ref('PlayerHouseDecorateDiningRoom', undefined, { disabled: true })],
  [MARKERS.lab, ref('PlayerHouseAlchemyLaboratory', undefined, { disabled: true })],
  [MARKERS.bedroom, ref('PlayerHouseChildBedroom', undefined, { disabled: true })],
  [MARKERS.labStart, ref('PlayerHouseAlchemyLaboratoryStart')],
  [MARKERS.kitchen, ref('PlayerHouseDecorateKitchen', undefined, { disabled: true })],
  [0x100, ref('', MARKERS.diningStart)], // crate
  [0x101, ref('', MARKERS.dining)], // table
  [0x102, ref('', MARKERS.dining)], // wall that belongs to the dining room
  [0x103, ref('', MARKERS.lab, { spot: 'room-wall' })],
  [0x104, ref('', MARKERS.bedroom, { spot: 'room-wall' })],
  [0x105, ref('', MARKERS.labStart)], // hay
  [0x106, ref('', MARKERS.kitchen)],
  [0x107, ref('', MARKERS.kitchen, { opposite: true })], // only without the kitchen upgrade
  [0x108, ref('')], // always there
]);

const data: CellData = {
  cell: {
    formId: 1,
    editorId: 'Home',
    name: 'Home',
    interior: true,
    lighting: undefined,
    inheritFlags: 0,
    lightingTemplate: undefined,
  },
  lighting: undefined,
  objects: [...references.keys()].map((reference) => ({
    reference,
    baseType: 'STAT',
    editorId: '',
    model: 'x.nif',
    world: identity(),
  })),
  lights: [],
  references,
  skipped: [],
  entrance: [0, 0, 0],
};

const visible = (selection: ReadonlySet<number>): number[] => {
  const upgrades = findUpgrades(data);
  const on = enabledReferences(data, upgrades, selection);
  return [...references.keys()].filter((id) => id >= 0x100 && on(id));
};

describe('cell upgrades', () => {
  const upgrades = findUpgrades(data);
  const byLabel = (label: string): number => {
    const upgrade = upgrades.find((u) => u.label === label);
    if (!upgrade) throw new Error(`no upgrade ${label}`);
    return upgrade.formId;
  };

  it('finds the upgrades with readable labels and their relations', () => {
    expect(upgrades.map((u) => u.label)).toEqual([
      'Alchemy Laboratory',
      'Child Bedroom',
      'Dining Room',
      'Kitchen',
    ]);
    const lab = upgrades.find((u) => u.label === 'Alchemy Laboratory');
    expect(lab?.alternatives).toEqual([MARKERS.bedroom]);
    expect(lab?.replaces).toEqual([MARKERS.labStart]);
    // The alternative shares the room's Start marker.
    expect(upgrades.find((u) => u.label === 'Child Bedroom')?.replaces).toEqual([MARKERS.labStart]);
    expect(upgrades.find((u) => u.label === 'Dining Room')?.replaces).toEqual([
      MARKERS.diningStart,
    ]);
  });

  it('shows the unfurnished home at game start', () => {
    expect(visible(gameStartSelection(upgrades))).toEqual([0x100, 0x105, 0x107, 0x108]);
  });

  it('switches a room with its walls and replaces only its own Start state', () => {
    const selection = toggleUpgrade(
      upgrades,
      gameStartSelection(upgrades),
      byLabel('Dining Room'),
      true,
    );
    expect(visible(selection)).toEqual([0x101, 0x102, 0x105, 0x107, 0x108]);
  });

  it('keeps alternatives exclusive', () => {
    let selection = toggleUpgrade(upgrades, new Set(), byLabel('Alchemy Laboratory'), true);
    selection = toggleUpgrade(upgrades, selection, byLabel('Child Bedroom'), true);
    expect([...selection]).toEqual([MARKERS.bedroom]);
    expect(visible(selection)).toContain(0x104);
    expect(visible(selection)).not.toContain(0x103);
    expect(visible(selection)).not.toContain(0x105);
  });

  it('turns opposite-flagged references off with their parent on', () => {
    const selection = toggleUpgrade(upgrades, new Set(), byLabel('Kitchen'), true);
    expect(visible(selection)).toContain(0x106);
    expect(visible(selection)).not.toContain(0x107);
  });

  it('selects every upgrade, keeping the earliest of alternatives', () => {
    const all = allUpgradesSelection(upgrades);
    expect(all.has(MARKERS.lab)).toBe(true);
    expect(all.has(MARKERS.bedroom)).toBe(false);
    expect(visible(all)).toEqual([0x101, 0x102, 0x103, 0x106, 0x108]);
  });
});
