// What a speaker's lines can be told apart by before their conditions run. Most of the game's
// greetings and chatter belong to one actor or one voice: of the 6,542 Hello infos 4,719 name
// their speaker (GetIsID run on the subject) and 706 its voice types (GetIsVoiceType), of the
// 713 Idle infos 409 and 179 (`node tools/talk-info.ts --survey`). An info whose conditions
// name another actor, another voice type or another alias's reference fails for this speaker
// whatever its other conditions say, so a speaker's line is found by valuing only the infos
// that may be its own. The grouping is the engine's, as ScriptRuntime.conditionsHold groups
// them (a condition's OR joins it with the next; OR groups bind tighter than ANDs).
// Platform-independent.

import { ConditionRunOn, type Condition } from '../conditions.ts';

/** UESP "Skyrim Mod:Function Indices": the functions decided from the speaker alone. */
const GET_IS_ID = 72;
const GET_IS_VOICE_TYPE = 426;
const GET_IS_ALIAS_REF = 566;

/** What is known of a speaker without running a condition. */
export interface SpeakerFacts {
  readonly reference: number;
  /** Its base object (as GetIsID compares it), if known. */
  readonly base: number | undefined;
  /** Whether its voice type is, or is in, a form (a VTYP or a form list); undefined: not known. */
  readonly voiceIs?: (form: number) => boolean | undefined;
  /** Whether an alias (by id) of the condition's quest holds it; undefined: not known. */
  readonly aliasIs?: (alias: number) => boolean | undefined;
}

const OPERATORS = [
  (a: number, b: number) => a === b,
  (a: number, b: number) => a !== b,
  (a: number, b: number) => a > b,
  (a: number, b: number) => a >= b,
  (a: number, b: number) => a < b,
  (a: number, b: number) => a <= b,
] as const;

/** One condition's result from the facts alone (undefined: it must be valued). */
function known(condition: Condition, facts: SpeakerFacts): boolean | undefined {
  if (condition.runOn !== ConditionRunOn.subject) return undefined;
  if (typeof condition.comparand !== 'number') return undefined;
  let value: boolean | undefined;
  switch (condition.function) {
    case GET_IS_ID:
      value =
        condition.form === facts.reference ||
        (facts.base !== undefined && condition.form === facts.base);
      break;
    case GET_IS_VOICE_TYPE:
      value = facts.voiceIs?.(condition.form);
      break;
    case GET_IS_ALIAS_REF:
      value = facts.aliasIs?.(condition.raw1);
      break;
    default:
      return undefined;
  }
  if (value === undefined) return undefined;
  const compare = OPERATORS[condition.operator];
  return compare ? compare(value ? 1 : 0, condition.comparand) : undefined;
}

/**
 * Whether conditions fail for a speaker on what is known of it alone (false: they may hold,
 * and must be valued).
 */
export function failsForSpeaker(conditions: readonly Condition[], facts: SpeakerFacts): boolean {
  // An OR group: true if one of it is, false if all are, else not known.
  let group: boolean | undefined | 'none' = 'none';
  const join = (a: boolean | undefined | 'none', b: boolean | undefined): boolean | undefined => {
    if (a === 'none') return b;
    if (a === true || b === true) return true;
    return a === false && b === false ? false : undefined;
  };
  for (const condition of conditions) {
    group = join(group, known(condition, facts));
    if (condition.or) continue;
    if (group === false) return true;
    group = 'none';
  }
  return group === false;
}
