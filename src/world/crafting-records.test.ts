import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import {
  craftedItemInfo,
  parseRecipe,
  parseWorkbench,
  RecipeIndex,
  WorkbenchType,
  type Recipe,
} from './crafting-records.ts';

const u32s = (...values: number[]): Uint8Array => new Uint8Array(Uint32Array.from(values).buffer);
const u16 = (value: number): Uint8Array => new Uint8Array(Uint16Array.of(value).buffer);
const text = (value: string): Uint8Array => new TextEncoder().encode(`${value}\0`);
const condition = (fn: number, flags = 0): Uint8Array => {
  const data = new Uint8Array(32);
  data[0] = flags;
  new DataView(data.buffer).setUint16(8, fn, true);
  return data;
};
const record = (type: string, formId: number, fields: [string, Uint8Array][]) => ({
  formId,
  type,
  editorId: `Rec${formId.toString(16)}`,
  fields: new Fields(fields.map(([field, data]) => ({ type: field, data }))),
  formIdAt: (data: Uint8Array, offset = 0) =>
    new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true),
  text: (field: string) => {
    const data = fields.find(([f]) => f === field)?.[1];
    return data && new TextDecoder().decode(data.subarray(0, data.indexOf(0)));
  },
});

describe('crafting records', () => {
  it('read a recipe: components with counts, conditions, created object, count, workbench', () => {
    const recipe = parseRecipe(
      record('COBJ', 0x108cfc, [
        ['EDID', text('RecipeWeaponOrcishBow')],
        ['COCT', u32s(2)],
        ['CNTO', u32s(0x5ace4, 1)],
        ['CNTO', u32s(0x5ad99, 2)],
        // HasPerk OR GetItemCount.
        ['CTDA', condition(448, 0x01)],
        ['CTDA', condition(47)],
        ['CNAM', u32s(0x13984)],
        ['BNAM', u32s(0x88105)],
        ['NAM1', u16(24)],
      ]),
    );
    expect(recipe).toMatchObject({
      formId: 0x108cfc,
      created: 0x13984,
      createdCount: 24,
      workbench: 0x88105,
      components: [
        { item: 0x5ace4, count: 1 },
        { item: 0x5ad99, count: 2 },
      ],
    });
    expect(recipe.conditions.map((c) => [c.function, c.or])).toEqual([
      [448, true],
      [47, false],
    ]);
  });

  it('make one of a recipe without NAM1; no created object or workbench when missing or none', () => {
    const recipe = parseRecipe(record('COBJ', 1, [['CNAM', u32s(0)]]));
    expect(recipe).toMatchObject({ created: undefined, createdCount: 1, workbench: undefined });
    expect(recipe.components).toEqual([]);
  });

  it('read a workbench: bench type, skill (255: none), keywords; others are no workbench', () => {
    const forge = parseWorkbench(
      record('FURN', 0xbf9e1, [
        ['FULL', text('Blacksmith Forge')],
        ['KWDA', u32s(0x88105, 0x0)],
        ['WBDT', Uint8Array.of(WorkbenchType.createObject, 10)],
      ]),
    );
    expect(forge).toMatchObject({
      type: WorkbenchType.createObject,
      skill: 10,
      name: 'Blacksmith Forge',
      keywords: [0x88105],
    });
    const smelter = parseWorkbench(record('FURN', 2, [['WBDT', Uint8Array.of(1, 0xff)]]));
    expect(smelter?.skill).toBeUndefined();
    expect(parseWorkbench(record('FURN', 3, [['WBDT', Uint8Array.of(0, 0xff)]]))).toBeUndefined();
    expect(parseWorkbench(record('FURN', 4, []))).toBeUndefined();
  });

  it('tell food from other potions (ENIT flags 0x2)', () => {
    const enit = (flags: number) => u32s(5, flags, 0, 0, 0);
    expect(craftedItemInfo(record('ALCH', 1, [['ENIT', enit(0x2)]])).food).toBe(true);
    expect(craftedItemInfo(record('ALCH', 2, [['ENIT', enit(0x20000)]])).food).toBe(false);
    expect(craftedItemInfo(record('WEAP', 3, [['KWDA', u32s(0x1e718)]]))).toEqual({
      type: 'WEAP',
      keywords: [0x1e718],
      food: false,
    });
  });

  it('index recipes by workbench keyword and created object, in load order', () => {
    const recipe = (formId: number, created: number, workbench: number): Recipe => ({
      formId,
      editorId: '',
      created,
      createdCount: 1,
      workbench,
      components: [],
      conditions: [],
    });
    const index = new RecipeIndex([
      recipe(1, 100, 10),
      recipe(2, 200, 20),
      recipe(3, 100, 30),
      recipe(4, 300, 10),
    ]);
    expect(index.byWorkbenchKeyword(10).map((r) => r.formId)).toEqual([1, 4]);
    expect(index.byCreated(100).map((r) => r.formId)).toEqual([1, 3]);
    expect(index.forWorkbench([30, 10]).map((r) => r.formId)).toEqual([1, 3, 4]);
    expect(index.get(2)?.created).toBe(200);
    expect(index.workbenchCounts().get(10)).toBe(2);
  });
});
