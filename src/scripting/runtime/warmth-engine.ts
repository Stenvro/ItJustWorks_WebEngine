// Survival Mode's warmth in the running game (the rules: src/gameplay/warmth.ts): a piece of
// armor's (Armor.GetWarmthRating), a light's (Light.GetWarmthRating) and an actor's
// (Actor.GetWarmthRating, the condition GetActorWarmth: what it wears, the torch it holds and its
// Fortify Warmth effects). Survival_NeedCold reads the player's every cold update.
// Platform-independent. Notes: docs/gameplay.md ("Survival Mode").

import {
  armorWarmth,
  lightWarmth,
  WARMTH_BONUS_VALUE,
  WarmthKeywordId,
  type WarmthKeywords,
} from '../../gameplay/warmth.ts';
import { parseItem } from '../../world/item-records.ts';
import type { ScriptRuntime } from './runtime.ts';

/** LIGH DATA flags: it can be carried (a torch). */
const LIGHT_CARRIED = 0x2;

export class WarmthEngine {
  readonly #runtime: ScriptRuntime;
  #keywords: WarmthKeywords | undefined;
  readonly #armor = new Map<number, Promise<number>>();

  constructor(runtime: ScriptRuntime) {
    this.#runtime = runtime;
  }

  /** Update.esm's warmth keywords in the load order. */
  keywords(): WarmthKeywords {
    const db = this.#runtime.forms.db;
    this.#keywords ??= {
      warm: db.formIdOf('Update.esm', WarmthKeywordId.armorWarm),
      cold: db.formIdOf('Update.esm', WarmthKeywordId.armorCold),
      bodyAndHead: db.formIdOf('Update.esm', WarmthKeywordId.bodyAndHead),
    };
    return this.#keywords;
  }

  /**
   * Armor.GetWarmthRating: by its slots and keywords. An enchanted variant made from a template
   * (TNAM: EnchArmorDaedricHelmet... from ArmorDaedricHelmet) has its template's keywords, which
   * Update.esm gave only the templates. TODO(M13): that the engine reads the template's is the
   * plausible reading of the data, not documented.
   */
  armor(formId: number): Promise<number> {
    let pending = this.#armor.get(formId);
    if (!pending) {
      pending = (async () => {
        const forms = this.#runtime.forms;
        const record = await forms.record(formId);
        const item = record ? parseItem(record) : undefined;
        if (!record || !item?.armor) return 0;
        const template = record.formIdField('TNAM');
        const templateRecord = template === undefined ? undefined : await forms.record(template);
        const keywords = [
          ...item.keywords,
          ...((templateRecord && parseItem(templateRecord)?.keywords) ?? []),
        ];
        return armorWarmth(item.armor.slots, keywords, this.keywords());
      })();
      this.#armor.set(formId, pending);
    }
    return pending;
  }

  /** Light.GetWarmthRating: a light that can be carried (a torch). */
  async light(formId: number): Promise<number> {
    const data = (await this.#runtime.forms.record(formId))?.fields.first('DATA');
    const flags =
      data && data.length >= 16
        ? new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(12, true)
        : 0;
    return lightWarmth((flags & LIGHT_CARRIED) !== 0);
  }

  /** An object's warmth: armor's or a light's (0 for anything else). */
  async of(formId: number): Promise<number> {
    const type = (await this.#runtime.forms.record(formId))?.type;
    if (type === 'ARMO') return this.armor(formId);
    if (type === 'LIGH') return this.light(formId);
    return 0;
  }

  /**
   * Actor.GetWarmthRating: its worn pieces' warmth, its torch's and its Fortify Warmth effects
   * (the actor value they raise).
   */
  async actor(actor: number): Promise<number> {
    const runtime = this.#runtime;
    let total = 0;
    for (const form of await runtime.equipment.worn(actor)) total += await this.armor(form);
    const torch = await runtime.equipment.torch(actor);
    if (torch !== undefined) total += await this.light(torch);
    total += (await runtime.actors.value(actor, WARMTH_BONUS_VALUE)).current;
    return total;
  }
}
