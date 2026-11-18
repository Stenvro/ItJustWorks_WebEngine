// What the player uses most, for the journal's stats: Favorite Weapon, Favorite Spell, Favorite
// School and Favorite Shout. Observed in the original: the engine keeps the last 100 uses of
// each (weapons, spells, shouts: a window that drops its oldest as a use comes past 100; the
// save keeps the three lists), and a favorite is the one most often in its window; the school
// is the one most often among the window's spells' schools. A weapon's use is a swing of a melee
// weapon, or a shot of a bow, crossbow or staff (its release); a shout's, a shout let out.
// GameState.recentUses. TODO(M13): which of several tied for most the original names (its sort
// of the counts is not stable; ours names the first in the window), and which of the caster's
// moments count a spell's use (ours: each spell fired, a concentration spell's each time it is
// let go). Platform-independent.

import { actorValueName } from '../../world/actor-values.ts';
import type { CastEvent } from './casting-engine.ts';
import { PLAYER_REF } from './forms.ts';
import type { ScriptRuntime } from './runtime.ts';

/** How many of the last uses each list keeps (observed in the original). */
export const RECENT_USES = 100;

/** The form most often in a list (the first of those tied for most), if it holds any. */
export function mostUsed(uses: readonly number[]): number | undefined {
  const counts = new Map<number, number>();
  for (const form of uses) counts.set(form, (counts.get(form) ?? 0) + 1);
  let best: number | undefined;
  let most = 0;
  for (const [form, count] of counts) {
    if (count > most) {
      best = form;
      most = count;
    }
  }
  return best;
}

/** A use added to a window of the last RECENT_USES, its oldest dropped when it is full. */
export function addUse(uses: number[], form: number | undefined): void {
  if (form === undefined) return;
  if (uses.length >= RECENT_USES) uses.splice(0, uses.length - RECENT_USES + 1);
  uses.push(form);
}

export class UsageStats {
  readonly #runtime: ScriptRuntime;

  constructor(runtime: ScriptRuntime) {
    this.#runtime = runtime;
    runtime.casting.listeners.add((event) => {
      this.#cast(event);
    });
  }

  /** The player swung a melee weapon or loosed a bow, crossbow or staff (actor-combat.ts). */
  weaponUsed(actor: number, weapon: number | undefined): void {
    if (actor === PLAYER_REF) addUse(this.#runtime.state.recentUses.weapons, weapon);
  }

  #cast(event: CastEvent): void {
    if (event.actor !== PLAYER_REF) return;
    const uses = this.#runtime.state.recentUses;
    if (event.kind === 'shout') {
      addUse(uses.shouts, event.delivered?.object);
      return;
    }
    // A spell fired, or a concentration spell let go (or run out of magicka) while it cast.
    const used =
      event.kind === 'fire' && event.delivered
        ? {
            via: event.delivered.via,
            item: event.delivered.item,
            object: event.delivered.object,
          }
        : event.kind === 'stop' && event.cast
          ? {
              via: event.cast.castable.via,
              item: event.cast.castable.item,
              object: event.cast.castable.object,
            }
          : undefined;
    // A staff's is a weapon's use (the staff itself).
    if (used?.via === 'staff') addUse(uses.weapons, used.object);
    if (used?.via !== 'spell') return;
    addUse(uses.spells, used.item.formId);
  }

  /** The school (its skill) most often among the recent spells' schools. */
  async #school(): Promise<number | undefined> {
    const runtime = this.#runtime;
    const schools: number[] = [];
    for (const spell of runtime.state.recentUses.spells) {
      const item = await runtime.magic.item(spell);
      const main = item && (await runtime.casting.mainEffect(item));
      if (main && main.skill >= 0) schools.push(main.skill);
    }
    return mostUsed(schools);
  }

  /** The journal's favorites: the names of the weapon, spell, school and shout used most. */
  async favorites(): Promise<{ weapon: string; spell: string; school: string; shout: string }> {
    const runtime = this.#runtime;
    const uses = runtime.state.recentUses;
    const name = async (form: number | undefined): Promise<string> =>
      form === undefined ? '' : ((await runtime.forms.record(form))?.text('FULL') ?? '');
    const school = await this.#school();
    const schoolName =
      school === undefined
        ? ''
        : ((await runtime.forms.actorValueForm(school))?.text('FULL') ?? actorValueName(school));
    return {
      weapon: await name(mostUsed(uses.weapons)),
      spell: await name(mostUsed(uses.spells)),
      school: schoolName,
      shout: await name(mostUsed(uses.shouts)),
    };
  }
}
