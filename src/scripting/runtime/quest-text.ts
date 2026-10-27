// The texts a quest shows (its name, its objectives) with their tags filled in, as the
// Creation Kit's "Text Replacement" describes them: `<Alias=Name>` is the name of what fills the
// quest's alias of that name (the alias's display name, ALDN, if it has one), `<Alias.ShortName=
// Name>` its short name (an NPC's SHRT, else its name), `<Global=EditorId>` the value of one of
// the quest's text display globals (QTGL) as a whole number; the pronouns of the actor that
// fills an alias by its sex (`<Alias.Pronoun=Name>` he / she, `.PronounObj` him / her,
// `.PronounPos` his / hers, `.PronounPosObj` his / her, `.PronounRef` and `.PronounInt` himself /
// herself: the settings sPronoun*Male / *Female) and its race's name (`<Alias.Race=Name>`). A tag
// that cannot be filled (an empty alias, a global the quest does not list, a pronoun of what is
// no actor) stays as it is, as it does in the game. Platform-independent.

import type { QuestRecord } from '../../world/quest-records.ts';
import { PLAYER_REF } from './forms.ts';
import type { ScriptRuntime } from './runtime.ts';

const TAG =
  /<(Alias|Alias\.ShortName|Alias\.Pronoun(?:Obj|Pos|PosObj|Ref|Int)?|Alias\.Race|Global)=([^>]+)>/gi;

/** The pronoun tags' settings: sPronoun<kind>Male / sPronoun<kind>Female. */
const PRONOUNS: Readonly<Record<string, string>> = {
  'alias.pronoun': 'sPronoun',
  'alias.pronounobj': 'sPronounObj',
  'alias.pronounpos': 'sPronounPos',
  'alias.pronounposobj': 'sPronounPosObj',
  'alias.pronounref': 'sPronounRef',
  'alias.pronounint': 'sPronounInt',
};

/** How deep NPC templates are followed for a name (TPLT chains are short). */
const TEMPLATE_DEPTH = 8;

/** A quest's text with its tags filled in. */
export async function questText(
  runtime: ScriptRuntime,
  quest: QuestRecord,
  text: string,
): Promise<string> {
  const tags = [...text.matchAll(TAG)];
  if (tags.length === 0) return text;
  const filled = await Promise.all(
    tags.map(async ([whole, kind = '', name = '']) => {
      const lower = kind.toLowerCase();
      const pronoun = PRONOUNS[lower];
      const value =
        lower === 'global'
          ? await globalText(runtime, quest, name)
          : pronoun !== undefined
            ? await pronounText(runtime, quest, name, pronoun)
            : lower === 'alias.race'
              ? await raceText(runtime, quest, name)
              : await aliasText(runtime, quest, name, lower === 'alias.shortname');
      return value ?? whole;
    }),
  );
  let index = 0;
  return text.replace(TAG, () => filled[index++] ?? '');
}

async function globalText(
  runtime: ScriptRuntime,
  quest: QuestRecord,
  editorId: string,
): Promise<string | undefined> {
  const wanted = editorId.trim().toLowerCase();
  for (const formId of quest.textGlobals) {
    const record = await runtime.forms.record(formId);
    if (record?.editorId?.toLowerCase() !== wanted) continue;
    const value = runtime.state.globals.get(formId) ?? record.fields.f32('FLTV') ?? 0;
    return String(Math.trunc(value));
  }
  return undefined;
}

/** The actor that fills a quest's reference alias (by its name), if one does. */
async function aliasActor(
  runtime: ScriptRuntime,
  quest: QuestRecord,
  aliasName: string,
): Promise<number | undefined> {
  const wanted = aliasName.trim().toLowerCase();
  const alias = quest.aliases.find((entry) => entry.name.toLowerCase() === wanted);
  if (!alias || alias.location) return undefined;
  const filled = runtime.state.quests.get(quest.formId)?.aliases.get(alias.id);
  if (filled === undefined || !(await runtime.actors.isActor(filled))) return undefined;
  return filled;
}

/** A pronoun of the actor in an alias, by its sex (sPronoun...Male / ...Female). */
async function pronounText(
  runtime: ScriptRuntime,
  quest: QuestRecord,
  aliasName: string,
  setting: string,
): Promise<string | undefined> {
  const actor = await aliasActor(runtime, quest, aliasName);
  if (actor === undefined) return undefined;
  const female = await runtime.actors.isFemale(actor);
  const text = await runtime.gameSetting(`${setting}${female ? 'Female' : 'Male'}`);
  return typeof text === 'string' && text !== '' ? text : undefined;
}

/** The name of the race of the actor in an alias. */
async function raceText(
  runtime: ScriptRuntime,
  quest: QuestRecord,
  aliasName: string,
): Promise<string | undefined> {
  const actor = await aliasActor(runtime, quest, aliasName);
  const race = actor === undefined ? undefined : await runtime.actors.raceOf(actor);
  const name = race === undefined ? undefined : (await runtime.forms.record(race))?.text('FULL');
  return name === '' ? undefined : name;
}

async function aliasText(
  runtime: ScriptRuntime,
  quest: QuestRecord,
  aliasName: string,
  short: boolean,
): Promise<string | undefined> {
  const wanted = aliasName.trim().toLowerCase();
  const alias = quest.aliases.find((entry) => entry.name.toLowerCase() === wanted);
  if (!alias) return undefined;
  if (alias.displayName !== undefined && alias.displayName !== 0) {
    const message = await runtime.forms.record(alias.displayName);
    const name = message?.text('FULL') ?? message?.text('DESC');
    if (name) return name;
  }
  const filled = runtime.state.quests.get(quest.formId)?.aliases.get(alias.id);
  if (filled === undefined) return undefined;
  const name = alias.location
    ? ((await runtime.forms.record(filled))?.text('FULL') ?? '')
    : await referenceName(runtime, filled, short);
  return name === '' ? undefined : name;
}

/**
 * A reference's name: its base's (an NPC's from its templates, if it has none of its own); the
 * player's as chosen in the race menu.
 */
export async function referenceName(
  runtime: ScriptRuntime,
  reference: number,
  short = false,
): Promise<string> {
  if (reference === PLAYER_REF) return runtime.actors.playerName();
  // An alias holding it names it (its display name, ALDN).
  const aliased = runtime.aliasDisplayName(reference);
  if (aliased !== undefined) return aliased;
  let base = await runtime.baseOf(reference);
  for (let depth = 0; base !== undefined && depth < TEMPLATE_DEPTH; depth++) {
    const record = await runtime.forms.record(base);
    if (!record) return '';
    const shortName = short ? record.text('SHRT') : undefined;
    if (shortName) return shortName;
    const name = record.text('FULL');
    if (name) return name;
    if (record.type !== 'NPC_') return '';
    base = record.formIdField('TPLT');
  }
  return '';
}
