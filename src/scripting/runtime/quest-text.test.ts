import { describe, expect, it } from 'vitest';
import type { QuestRecord } from '../../world/quest-records.ts';
import { questText } from './quest-text.ts';
import type { ScriptRuntime } from './runtime.ts';

const QUEST = 0x100;
const GLOBAL = 0x200;
const REFERENCE = 0x300;
const NPC = 0x400;
const TEMPLATE = 0x500;

interface FakeRecord {
  type: string;
  editorId?: string;
  texts: Record<string, string>;
  forms: Record<string, number>;
  fields: { f32(type: string): number | undefined };
  text(type: string): string | undefined;
  formIdField(type: string): number | undefined;
}

const record = (
  type: string,
  editorId: string,
  texts: Record<string, string>,
  forms: Record<string, number> = {},
  value?: number,
): FakeRecord => ({
  type,
  editorId,
  texts,
  forms,
  fields: { f32: (field) => (field === 'FLTV' ? value : undefined) },
  text: (field) => texts[field],
  formIdField: (field) => forms[field],
});

const records = new Map<number, FakeRecord>([
  [GLOBAL, record('GLOB', 'NirnrootCount', {}, {}, 3)],
  [NPC, record('NPC_', 'Ingun', {}, { TPLT: TEMPLATE })],
  [TEMPLATE, record('NPC_', 'IngunTemplate', { FULL: 'Ingun Black-Briar', SHRT: 'Ingun' })],
]);

const runtime = {
  forms: { record: (formId: number) => Promise.resolve(records.get(formId)) },
  state: {
    globals: new Map([[GLOBAL, 7.6]]),
    quests: new Map([[QUEST, { aliases: new Map([[0, REFERENCE]]) }]]),
  },
  baseOf: (reference: number) => Promise.resolve(reference === REFERENCE ? NPC : undefined),
} as unknown as ScriptRuntime;

const quest = {
  formId: QUEST,
  textGlobals: [GLOBAL],
  aliases: [
    { id: 0, name: 'Ingun', location: false, displayName: undefined },
    { id: 1, name: 'Empty', location: false, displayName: undefined },
  ],
} as unknown as QuestRecord;

describe('questText', () => {
  it('fills in alias names, through NPC templates', async () => {
    expect(await questText(runtime, quest, 'Talk to <Alias=Ingun>')).toBe(
      'Talk to Ingun Black-Briar',
    );
    expect(await questText(runtime, quest, 'Ask <Alias.ShortName=ingun>')).toBe('Ask Ingun');
  });

  it("fills in the quest's text globals as whole numbers", async () => {
    expect(await questText(runtime, quest, 'Nirnroot (<Global=NirnrootCount>/20)')).toBe(
      'Nirnroot (7/20)',
    );
  });

  it('leaves tags it cannot fill as they are', async () => {
    expect(await questText(runtime, quest, 'Find <Alias=Empty> and <Global=Other>')).toBe(
      'Find <Alias=Empty> and <Global=Other>',
    );
  });
});
