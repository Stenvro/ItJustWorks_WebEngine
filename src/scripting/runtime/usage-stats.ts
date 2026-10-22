// What the player uses most, for the journal's stats (UESP "Skyrim:Statistics"): Favorite Weapon
// (the melee weapon or bow used most: each swing or shot), Favorite Spell (the spell cast most:
// each cast of a spell, a concentration spell's each time it is let go), Favorite School (that
// school whose spells were cast most) and Favorite Shout (the shout shouted most). Kept in the
// game state (GameState.usage). TODO(M13): what the engine counts as a use is not documented
// (swings and casts here). Platform-independent.

import { actorValueName } from '../../world/actor-values.ts';
import type { CastEvent } from './casting-engine.ts';
import { PLAYER_REF } from './forms.ts';
import type { ScriptRuntime } from './runtime.ts';

/** The form used most (the first to reach the count on a tie), if any was used. */
export function mostUsed(counts: ReadonlyMap<number, number>): number | undefined {
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

export class UsageStats {
  readonly #runtime: ScriptRuntime;

  constructor(runtime: ScriptRuntime) {
    this.#runtime = runtime;
    runtime.casting.listeners.add((event) => {
      this.#cast(event);
    });
  }

  #count(counts: Map<number, number>, form: number | undefined): void {
    if (form !== undefined) counts.set(form, (counts.get(form) ?? 0) + 1);
  }

  /** The player swung a melee weapon or shot a bow (src/shell/actor-combat.ts). */
  weaponUsed(actor: number, weapon: number | undefined): void {
    if (actor === PLAYER_REF) this.#count(this.#runtime.state.usage.weapons, weapon);
  }

  #cast(event: CastEvent): void {
    if (event.actor !== PLAYER_REF) return;
    const usage = this.#runtime.state.usage;
    if (event.kind === 'shout') {
      this.#count(usage.shouts, event.delivered?.object);
      return;
    }
    // A spell fired, or a concentration spell let go (or run out of magicka) while it cast.
    const used =
      event.kind === 'fire' && event.delivered
        ? { via: event.delivered.via, item: event.delivered.item, cost: event.delivered.cost }
        : event.kind === 'stop' && event.cast
          ? { via: event.cast.castable.via, item: event.cast.castable.item, cost: event.cast.cost }
          : undefined;
    if (used?.via !== 'spell') return;
    this.#count(usage.spells, used.item.formId);
    this.#count(usage.schools, used.cost.school);
  }

  /** The journal's favorites: the names of the weapon, spell, school and shout used most. */
  async favorites(): Promise<{ weapon: string; spell: string; school: string; shout: string }> {
    const runtime = this.#runtime;
    const usage = runtime.state.usage;
    const name = async (form: number | undefined): Promise<string> =>
      form === undefined ? '' : ((await runtime.forms.record(form))?.text('FULL') ?? '');
    const school = mostUsed(usage.schools);
    const schoolName =
      school === undefined
        ? ''
        : ((await runtime.forms.actorValueForm(school))?.text('FULL') ?? actorValueName(school));
    return {
      weapon: await name(mostUsed(usage.weapons)),
      spell: await name(mostUsed(usage.spells)),
      school: schoolName,
      shout: await name(mostUsed(usage.shouts)),
    };
  }
}
