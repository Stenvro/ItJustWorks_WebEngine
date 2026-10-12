import { describe, expect, it } from 'vitest';
import { identity } from '../render/math.ts';
import type { CellData, ReferenceState } from './cell-loader.ts';
import { enabledReferences, findToggles, gameStartSelection } from './cell-upgrades.ts';

const MARKERS = {
  guildStageTwo: 0x10,
  ciceroEnable: 0x11,
  ciceroDisable: 0x12, // counterpart of ciceroEnable
  garrison: 0x13, // on in a new game
  kitchen: 0x14, // switched by a purchase script
  kitchenStart: 0x15,
};

function ref(
  editorId: string,
  parent?: number,
  options: { opposite?: boolean; disabled?: boolean } = {},
): ReferenceState {
  return {
    editorId,
    initiallyDisabled: options.disabled ?? false,
    parent:
      parent === undefined ? undefined : { formId: parent, opposite: options.opposite ?? false },
  };
}

const references = new Map<number, ReferenceState>([
  [MARKERS.guildStageTwo, ref('GuildStatusStageTwo', undefined, { disabled: true })],
  [MARKERS.ciceroEnable, ref('GuildCiceroMovesIn_Enable', undefined, { disabled: true })],
  [MARKERS.ciceroDisable, ref('GuildCiceroMovesIn_Disable')],
  [MARKERS.garrison, ref('GarrisonImperialEnableMarker')],
  [MARKERS.kitchen, ref('PlayerHouseDecorateKitchen', undefined, { disabled: true })],
  [MARKERS.kitchenStart, ref('PlayerHouseKitchenStart')],
  [0x100, ref('', MARKERS.guildStageTwo)],
  [0x101, ref('', MARKERS.ciceroEnable)],
  [0x102, ref('', MARKERS.ciceroDisable)],
  [0x103, ref('', MARKERS.garrison)],
  [0x104, ref('', MARKERS.garrison, { opposite: true })], // only without the garrison
  [0x105, ref('', MARKERS.kitchen)],
  [0x106, ref('', MARKERS.kitchenStart)],
  [0x107, ref('')], // always there
  [0x108, ref('', 0x105)], // follows the kitchen through a chain
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
    imageSpace: undefined,
    hasWater: false,
    waterHeight: undefined,
    waterType: undefined,
  },
  lighting: undefined,
  objects: [...references.keys()].map((reference) => ({
    reference,
    baseType: 'STAT',
    editorId: '',
    model: 'x.nif',
    world: identity(),
    water: undefined,
  })),
  lights: [],
  decals: [],
  references,
  skipped: [],
  entrance: [0, 0, 0],
};

/** Markers the player's actions switch; they are not quest states. */
const controlled = new Set([MARKERS.kitchen, MARKERS.kitchenStart]);

const visible = (
  selection: ReadonlySet<number>,
  scripted: ReadonlyMap<number, boolean> = new Map(),
): number[] => {
  const toggles = findToggles(data, controlled);
  const on = enabledReferences(data, toggles, selection, scripted);
  return [...references.keys()].filter((id) => id >= 0x100 && on(id));
};

describe('cell states', () => {
  const toggles = findToggles(data, controlled);

  it('lists quest states with readable labels, without the player-controlled markers', () => {
    expect(toggles.map((t) => [t.label, t.defaultOn])).toEqual([
      ['Garrison Imperial', true],
      ['Guild Cicero Moves In', false],
      ['Guild Status Stage Two', false],
    ]);
    // X_Disable switches with X_Enable.
    expect(toggles.find((t) => t.formId === MARKERS.ciceroEnable)?.replaces).toEqual([
      MARKERS.ciceroDisable,
    ]);
  });

  it('shows a new game as the plugins place it', () => {
    expect(visible(gameStartSelection(toggles))).toEqual([0x102, 0x103, 0x106, 0x107]);
  });

  it('switches a state with its counterpart and opposite-flagged references', () => {
    const selection = new Set([MARKERS.ciceroEnable]);
    expect(visible(selection)).toEqual([0x101, 0x104, 0x106, 0x107]);
  });

  it('takes what the scripts enabled and disabled, also through enable-parent chains', () => {
    const scripted = new Map([
      [MARKERS.kitchen, true],
      [MARKERS.kitchenStart, false],
    ]);
    expect(visible(gameStartSelection(toggles), scripted)).toEqual([
      0x102, 0x103, 0x105, 0x107, 0x108,
    ]);
  });
});
