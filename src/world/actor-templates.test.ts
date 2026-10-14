import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { TemplateFlag } from './actor-records.ts';
import { resolveActorTemplates } from './actor-templates.ts';

type Source = NonNullable<Awaited<ReturnType<Parameters<typeof resolveActorTemplates>[0]>>>;

const u32s = (...values: number[]): Uint8Array => new Uint8Array(Uint32Array.from(values).buffer);
const npc = (formId: number, templateFlags: number, template?: number) => {
  const acbs = new DataView(new ArrayBuffer(24));
  acbs.setUint16(18, templateFlags, true);
  const fields: { type: string; data: Uint8Array }[] = [
    { type: 'ACBS', data: new Uint8Array(acbs.buffer) },
  ];
  if (template !== undefined) fields.push({ type: 'TPLT', data: u32s(template) });
  return { formId, type: 'NPC_', editorId: '', fields: new Fields(fields), formIdAt };
};
const leveled = (formId: number, entries: number[]) => {
  const fields = entries.map((entry) => {
    const lvlo = new DataView(new ArrayBuffer(12));
    lvlo.setUint16(0, 1, true);
    lvlo.setUint32(4, entry, true);
    lvlo.setUint16(8, 1, true);
    return { type: 'LVLO', data: new Uint8Array(lvlo.buffer) };
  });
  return { formId, type: 'LVLN', editorId: '', fields: new Fields(fields), formIdAt };
};
function formIdAt(data: Uint8Array, offset = 0): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

describe('actor templates', () => {
  it('take each part from the template its flags name, a leveled template picked once', async () => {
    const records = new Map<number, Source>([
      // The placed NPC takes its traits and stats from a leveled list of two NPCs.
      [0x10, npc(0x10, TemplateFlag.traits | TemplateFlag.stats, 0x20)],
      [0x20, leveled(0x20, [0x30, 0x40])],
      [0x30, npc(0x30, 0)],
      [0x40, npc(0x40, 0)],
    ]);
    const get = (formId: number) => Promise.resolve(records.get(formId));
    for (let reference = 0x1000; reference < 0x1010; reference++) {
      const templates = await resolveActorTemplates(get, 0x10, reference, 1);
      expect(templates?.placed).toBe(0x10);
      // Both parts come from the same pick; the inventory is the placed NPC's own.
      expect(templates?.part(TemplateFlag.stats)).toBe(templates?.part(TemplateFlag.traits));
      expect([0x30, 0x40]).toContain(templates?.part(TemplateFlag.traits));
      expect(templates?.part(TemplateFlag.inventory)).toBe(0x10);
    }
  });

  it('come down a leveled base to one NPC, the same for the same reference', async () => {
    const records = new Map<number, Source>([
      [0x20, leveled(0x20, [0x30, 0x40])],
      [0x30, npc(0x30, 0)],
      [0x40, npc(0x40, 0)],
    ]);
    const get = (formId: number) => Promise.resolve(records.get(formId));
    const first = await resolveActorTemplates(get, 0x20, 0x5000, 1);
    const again = await resolveActorTemplates(get, 0x20, 0x5000, 1);
    expect(first?.placed).toBe(again?.placed);
  });
});
