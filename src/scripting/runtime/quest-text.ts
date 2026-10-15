// The texts a quest shows (its name, its objectives) with their tags filled in, as the
// Creation Kit's "Text Replacement" describes them: `<Alias=Name>` is the name of what fills the
// quest's alias of that name (the alias's display name, ALDN, if it has one), `<Alias.ShortName=
// Name>` its short name (an NPC's SHRT, else its name), `<Global=EditorId>` the value of one of
// the quest's text display globals (QTGL) as a whole number. A tag that cannot be filled (an
// empty alias, a global the quest does not list) stays as it is, as it does in the game.
// TODO(M11): the pronoun and race tags (<Alias.PronounObj=...>, ...), used by no vanilla quest
// text the HUD or journal shows. Platform-independent.

import type { QuestRecord } from '../../world/quest-records.ts';
import { PLAYER_REF } from './forms.ts';
import type { ScriptRuntime } from './runtime.ts';

const TAG = /<(Alias|Alias\.ShortName|Global)=([^>]+)>/gi;

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
      const value =
        kind.toLowerCase() === 'global'
          ? await globalText(runtime, quest, name)
          : await aliasText(runtime, quest, name, kind.toLowerCase() === 'alias.shortname');
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
