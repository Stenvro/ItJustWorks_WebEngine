// A combat style for the combat suites' formula cases: the Creation Kit's defaults (UESP CSTY)
// with the values a case sets.

import { NO_STYLE } from '../../../src/ai/combat-profile.ts';
import type { CombatStyle } from '../../../src/ai/combat-style-records.ts';

export function styleWith(
  general: Partial<CombatStyle['general']> = {},
  rest: Partial<Omit<CombatStyle, 'general'>> = {},
): CombatStyle {
  return { ...NO_STYLE, ...rest, general: { ...NO_STYLE.general, ...general } };
}
