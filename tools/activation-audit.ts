// Surveys every placed reference of the load order (REFR, ACHR) through the crosshair's prompt
// rule (src/gameplay/activation-prompt.ts) as the game starts: per base type how many the
// crosshair takes, each prompt's verb, and why the rest show none. Facts are the plugins' as
// placed (owned: XOWN by someone other than the player; locked: XLOC; harvestable: PFIG; dead:
// "starts dead"); actors are shown standing and, sneaking, as the player sneaks up on them.
//
//   node tools/activation-audit.ts                   every base type, counts
//   node tools/activation-audit.ts --type FURN       one base type, with sample editor ids
//   node tools/activation-audit.ts --verb sActivate  the bases whose prompt is that verb

import { view } from '../src/formats/esm/fields.ts';
import { RecordFlag } from '../src/formats/esm/record.ts';
import {
  actorPrompt,
  crosshairTakes,
  objectPrompt,
  type ActivationPrompt,
  type ObjectPromptFacts,
} from '../src/gameplay/activation-prompt.ts';
import { lockDifficulty, lockLevelSetting } from '../src/gameplay/lockpicking.ts';
import { RaceAiFlag } from '../src/ai/race-combat-records.ts';
import { BookFlag } from '../src/world/item-records.ts';
import { LightFlag } from '../src/world/cell-records.ts';
import { DefaultObjects } from '../src/world/default-objects.ts';
import { RecordDatabase, type GameRecord } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const argument = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const onlyType = argument('--type')?.toUpperCase();
const onlyVerb = argument('--verb');

const db = await RecordDatabase.open(await Vfs.mount(openGameFolder()));
const defaults = await DefaultObjects.read(db);
const specialFurniture = defaults.get('SPFK');

/** The player (PlayerRef's base) and PlayerFaction: what they own is the player's. */
const PLAYER_OWNERS = new Set([0x7, 0x14, 0xdb1]);
const ACTOR_TYPE_HORSE = 0x26110;

const bases = new Map<number, Promise<GameRecord | undefined>>();
const base = (formId: number): Promise<GameRecord | undefined> => {
  let pending = bases.get(formId);
  if (!pending) {
    pending = db.get(formId);
    bases.set(formId, pending);
  }
  return pending;
};

const u32 = (data: Uint8Array | undefined, offset: number): number =>
  data && data.length >= offset + 4 ? view(data).getUint32(offset, true) : 0;
const keywords = (record: GameRecord): number[] => {
  const kwda = record.fields.first('KWDA');
  const out: number[] = [];
  if (kwda) for (let at = 0; at + 4 <= kwda.length; at += 4) out.push(record.formIdAt(kwda, at));
  return out;
};

/** An actor base's NPC_ (a leveled list's first entry, a template's), at most a few steps. */
async function npcOf(formId: number, depth = 0): Promise<GameRecord | undefined> {
  const record = await base(formId);
  if (!record || depth > 6) return undefined;
  if (record.type === 'LVLN') {
    const entry = record.fields.first('LVLO');
    return entry && entry.length >= 8 ? npcOf(record.formIdAt(entry, 4), depth + 1) : undefined;
  }
  return record.type === 'NPC_' ? record : undefined;
}

/** ACBS template flags: the template gives the traits (race, name, ...). */
const USE_TRAITS = 0x1;

/** The NPC whose traits (race, name) an NPC has: its template's while it uses its traits. */
async function traitsOf(npc: GameRecord, depth = 0): Promise<GameRecord> {
  const acbs = npc.fields.first('ACBS');
  const templateFlags = acbs && acbs.length >= 20 ? view(acbs).getUint16(18, true) : 0;
  const template = npc.formIdField('TPLT');
  if ((templateFlags & USE_TRAITS) === 0 || !template || depth > 6) return npc;
  const next = await npcOf(template);
  return next ? traitsOf(next, depth + 1) : npc;
}

/** An NPC's name (FULL; a template's when it has none). */
async function npcName(npc: GameRecord, depth = 0): Promise<string> {
  const name = npc.text('FULL') ?? '';
  if (name !== '' || depth > 6) return name;
  const template = npc.formIdField('TPLT');
  const next = template ? await npcOf(template) : undefined;
  return next ? npcName(next, depth + 1) : '';
}

interface Row {
  refs: number;
  taken: number;
  readonly verbs: Map<string, number>;
  readonly none: Map<string, number>;
  readonly samples: Map<string, string[]>;
}
const rows = new Map<string, Row>();
const rowOf = (type: string): Row => {
  let row = rows.get(type);
  if (!row) {
    row = { refs: 0, taken: 0, verbs: new Map(), none: new Map(), samples: new Map() };
    rows.set(type, row);
  }
  return row;
};
const bump = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};
const sample = (row: Row, key: string, editorId: string): void => {
  const list = row.samples.get(key) ?? [];
  if (list.length < 6 && !list.includes(editorId)) list.push(editorId);
  row.samples.set(key, list);
};
const verbName = (prompt: ActivationPrompt): string =>
  'setting' in prompt.verb ? prompt.verb.setting : `"${prompt.verb.text}"`;

function record(type: string, editorId: string, prompt: ActivationPrompt | undefined, why: string) {
  const row = rowOf(type);
  if (prompt) {
    const key = verbName(prompt) + (prompt.detail ? ` +${prompt.detail}` : '');
    row.taken++;
    bump(row.verbs, key);
    sample(row, key, editorId);
  } else {
    bump(row.none, why);
    sample(row, `none: ${why}`, editorId);
  }
}

/** What the survey keeps of a placed reference. */
interface PlacedFacts {
  readonly type: string;
  readonly base: number;
  readonly flags: number;
  readonly editorId: string;
  readonly owned: boolean;
  readonly lockLevel: number | undefined;
  readonly count: number | undefined;
  readonly loadDoor: boolean;
  readonly open: boolean;
}

function placedFacts(ref: GameRecord): PlacedFacts | undefined {
  const baseId = ref.formIdField('NAME');
  if (baseId === undefined) return undefined;
  const owner = ref.formIdField('XOWN');
  const count = ref.fields.first('XCNT');
  return {
    type: ref.type,
    base: baseId,
    flags: ref.flags,
    editorId: ref.editorId ?? '',
    owned: owner !== undefined && owner !== 0 && !PLAYER_OWNERS.has(owner),
    lockLevel: ref.fields.first('XLOC')?.[0],
    count: count && count.length >= 4 ? view(count).getInt32(0, true) : undefined,
    loadDoor: ref.fields.has('XTEL'),
    open: ref.fields.has('ONAM'),
  };
}

function objectFacts(ref: PlacedFacts, object: GameRecord): ObjectPromptFacts {
  const crime = ref.owned;
  const lock =
    (object.type === 'DOOR' || object.type === 'CONT') && ref.lockLevel !== undefined
      ? { level: lockLevelSetting(lockDifficulty(ref.lockLevel)), playerHasKey: false }
      : undefined;
  const facts: ObjectPromptFacts = {
    baseType: object.type,
    name: object.text('FULL') ?? '',
    ...(crime && { crime }),
    ...(lock && { lock }),
    ...(ref.count !== undefined && { count: ref.count }),
  };
  switch (object.type) {
    case 'ACTI':
    case 'TACT':
    case 'FLOR': {
      const text = object.text('RNAM');
      return {
        ...facts,
        ...(text !== undefined && { activateText: text }),
        ...(object.type === 'FLOR' && { harvestable: (object.formIdField('PFIG') ?? 0) !== 0 }),
      };
    }
    case 'TREE':
      return { ...facts, harvestable: (object.formIdField('PFIG') ?? 0) !== 0 };
    case 'LIGH': {
      const data = object.fields.first('DATA');
      return { ...facts, carryable: (u32(data, 12) & LightFlag.canCarry) !== 0 };
    }
    case 'BOOK': {
      const data = object.fields.first('DATA');
      const flags = data?.[0] ?? 0;
      return {
        ...facts,
        teachesSpell: (flags & BookFlag.teachesSpell) !== 0 && u32(data, 4) !== 0,
      };
    }
    case 'DOOR':
      return { ...facts, open: ref.open, ...(ref.loadDoor && { destination: '(destination)' }) };
    case 'CONT': {
      const showsOwner = ((object.fields.first('DATA')?.[0] ?? 0) & 0x4) !== 0;
      return {
        ...facts,
        empty: !object.fields.has('CNTO'),
        ...(showsOwner && crime && { shownOwner: '(owner)' }),
      };
    }
    case 'FURN': {
      const first = object.fields
        .all('FNPR')
        .map((data) => (data.length >= 2 ? view(data).getUint16(0, true) : 0))[0];
      return {
        ...facts,
        furniture: {
          firstMarker:
            first === undefined
              ? undefined
              : (first & 2) !== 0
                ? 'sleep'
                : (first & 1) !== 0
                  ? 'sit'
                  : 'lean',
          workbench: (object.fields.first('WBDT')?.[0] ?? 0) !== 0,
          special: specialFurniture !== undefined && keywords(object).includes(specialFurniture),
        },
      };
    }
    case 'PROJ':
      return { ...facts, pickUp: (u32(object.fields.first('DATA'), 0) & 0x40) !== 0 };
    default:
      return facts;
  }
}

/** Why an object shows no prompt (the rule's first refusal). */
function noneReason(facts: ObjectPromptFacts): string {
  if (facts.name === '') return 'no name';
  if (!crosshairTakes(facts.baseType, facts.name, facts.carryable))
    return facts.baseType === 'LIGH' ? 'light not carried' : 'static';
  if (facts.baseType === 'FLOR' || facts.baseType === 'TREE') return 'no ingredient';
  if (facts.baseType === 'PROJ') return 'cannot be picked up';
  return 'other';
}

const refs: PlacedFacts[] = [];
await db.scan(
  ['REFR', 'ACHR'],
  (flags) => (flags & RecordFlag.deleted) === 0,
  (ref) => {
    const facts = placedFacts(ref);
    if (facts) refs.push(facts);
  },
);
const races = new Map<number, Promise<{ flags: number; horse: boolean }>>();
const raceOf = (formId: number): Promise<{ flags: number; horse: boolean }> => {
  let pending = races.get(formId);
  if (!pending) {
    pending = base(formId).then((race) => ({
      flags: u32(race?.fields.first('DATA'), 32),
      horse: race !== undefined && keywords(race).includes(ACTOR_TYPE_HORSE),
    }));
    races.set(formId, pending);
  }
  return pending;
};

for (const ref of refs) {
  const baseId = ref.base;
  if (ref.type === 'ACHR') {
    rowOf('ACHR').refs++;
    const placedNpc = await npcOf(baseId);
    if (!placedNpc) {
      record('ACHR', ref.editorId, undefined, 'no actor base');
      continue;
    }
    const npc = await traitsOf(placedNpc);
    const race = await raceOf(npc.formIdField('RNAM') ?? 0);
    const dead = (ref.flags & RecordFlag.startsDead) !== 0;
    const facts = {
      name: await npcName(npc),
      dead,
      rideable: !dead && race.horse,
      sneaking: false,
      pickpocketable: (race.flags & RaceAiFlag.allowPickpocket) !== 0,
      teammate: false,
      talks: (race.flags & RaceAiFlag.allowPcDialogue) !== 0,
    };
    const editorId = npc.editorId ?? '';
    const standing = actorPrompt(facts);
    const kind = dead ? 'ACHR dead' : 'ACHR';
    record(
      kind,
      editorId,
      standing,
      facts.name === '' ? 'no name' : facts.talks ? 'other' : 'race: no PC dialogue',
    );
    if (!dead) {
      record(
        'ACHR sneaking',
        editorId,
        actorPrompt({ ...facts, sneaking: true }),
        facts.name === '' ? 'no name' : 'race: no pickpocketing',
      );
    }
    continue;
  }
  const object = await base(baseId);
  if (!object) continue;
  rowOf(object.type).refs++;
  if ((object.flags & RecordFlag.isMarker) !== 0) {
    record(object.type, object.editorId ?? '', undefined, 'editor marker (not drawn)');
    continue;
  }
  const facts = objectFacts(ref, object);
  const prompt = objectPrompt(facts);
  record(object.type, object.editorId ?? '', prompt, prompt ? '' : noneReason(facts));
}
console.log(`${refs.length} placed references (REFR, ACHR) in the load order`);
console.log(
  'type            refs   prompt  verbs (count)                                    none (count)',
);
for (const [type, row] of [...rows].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (onlyType && !type.startsWith(onlyType)) continue;
  const verbs = [...row.verbs]
    .sort((a, b) => b[1] - a[1])
    .map(([verb, n]) => `${verb} ${n}`)
    .join(', ');
  const none = [...row.none]
    .sort((a, b) => b[1] - a[1])
    .map(([why, n]) => `${why} ${n}`)
    .join(', ');
  const refsShown = type.startsWith('ACHR ') ? '' : String(row.refs);
  console.log(
    `${type.padEnd(15)} ${refsShown.padStart(6)} ${String(row.taken).padStart(7)}  ${verbs.padEnd(48)} ${none}`,
  );
  if (onlyType) {
    for (const [key, list] of row.samples) console.log(`    ${key}: ${list.join(', ')}`);
  }
}
if (onlyVerb) {
  console.log(`\nbases whose prompt is ${onlyVerb}:`);
  for (const [type, row] of rows) {
    for (const [key, list] of row.samples) {
      if (key.startsWith(onlyVerb)) console.log(`  ${type}: ${list.join(', ')}`);
    }
  }
}
