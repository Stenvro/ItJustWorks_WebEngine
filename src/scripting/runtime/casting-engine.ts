// Casting on the running game (docs/gameplay.md, "Casting and shouts"; the rules:
// src/gameplay/magic/casting.ts and shouts.ts): what each of an actor's casting sources casts
// (CommonLibSSE MagicSystem::CastingSource: 0 the left hand, 1 the right, 2 the voice, 3
// instant) — a spell (magicka), a staff (its charge), a scroll (used up), a power (once a day),
// a lesser power, a shout (the voice's recovery) — and its cast: begun (refused without the
// magicka, the charge or the day's power: the HUD's magicka meter blinks, the player hears
// sMagicCastPowerUsed / sMagicCastInsufficientItemCharge), charging, ready, released (a fire
// and forget spell fires: paid then), or held (a concentration spell spends its cost each
// second, ending as the magicka runs out). The world (src/shell/actor-casting.ts,
// player-casting.ts) animates casts and flies what they send (src/shell/magic-projectiles.ts);
// it hands back what hits: `deliver` puts the spell on a target through the magic system
// (resistances there), first past the target's ward (WardPower: it absorbs a hostile spell's
// damage up to its strength, or breaks and lets the rest through) and its Spell Absorption
// (AbsorbChance: the spell is absorbed, its cost the target's magicka), then the target hears
// OnHit and the caster's school is used by the spell's base cost. `area` reaches the actors
// within an effect's area, `explode` those within an explosion's radius (its own enchantment,
// damage and force). Shouts: the words an actor knows (the player's learned and unlocked,
// TeachWord / UnlockWord, a dragon soul each), the voice's recovery (ActorState
// voiceRecoveryTime, the HUD's shout meter). Conditions read what is cast now (IsCasting,
// IsDualCasting, GetCurrentCastingType, GetCurrentDeliveryType, IsCurrentSpell,
// SpellHasKeyword, GetCurrentShoutVariation, IsWardState). Platform-independent.

import {
  advanceCast,
  beginCast,
  CASTING_DEFAULTS,
  CASTING_SETTING_NAMES,
  castSkillUses,
  chargeSeconds,
  itemBaseCost,
  magickaCost,
  powerReady,
  releaseCast,
  type CastingSettings,
  type HandCast,
} from '../../gameplay/magic/casting.ts';
import { MagicValue, UNITS_PER_FOOT } from '../../gameplay/magic/effect-rules.ts';
import { EntryPoint } from '../../gameplay/perk-entry-points.ts';
import {
  SHOUT_DEFAULTS,
  shoutMeterPercent,
  shoutRecovery,
  wordsAvailable,
  wordToUnlock,
  type ShoutSettings,
} from '../../gameplay/magic/shouts.ts';
import { ActorValue } from '../../world/actor-values.ts';
import { EffectArchetype, EffectFlag, type MagicEffectRecord } from '../../world/magic-effects.ts';
import { Delivery, MagicSpellFlag, type MagicItemRecord } from '../../world/magic-records.ts';
import {
  ExplosionFlag,
  parseExplosion,
  parseProjectile,
  type ExplosionRecord,
  type ProjectileRecord,
} from '../../world/projectile-data.ts';
import { CastType, parseShout, type ShoutRecord } from '../../world/spell-records.ts';
import { PLAYER_REF } from './forms.ts';
import type { ActorCastingState, Vec3 } from './game-state.ts';
import type { ScriptRuntime } from './runtime.ts';

/** A point in the world (game units). */
type Point = readonly [number, number, number];

/** Casting sources (CommonLibSSE MagicSystem::CastingSource). */
export const CastingSource = { left: 0, right: 1, voice: 2, instant: 3 } as const;

/** How a cast is paid for. */
export type CastVia = 'spell' | 'staff' | 'scroll' | 'power' | 'lesserPower' | 'shout' | 'script';

/** What a source can cast: the magic item and what it comes by (a staff, a scroll, a shout). */
export interface Castable {
  readonly item: MagicItemRecord;
  readonly via: CastVia;
  readonly object?: number;
}

/** What a cast costs and trains. */
export interface CastCost {
  /** Its base cost (before the caster's skill): the uses it gives its school. */
  readonly base: number;
  /** Magicka a cast (a concentration spell: a second); 0 for what magicka does not pay. */
  readonly magicka: number;
  /** A staff's charge a cast. */
  readonly charge: number;
  /** The school (an actor value) it trains; undefined: none. */
  readonly school: number | undefined;
  /** Seconds it charges. */
  readonly chargeTime: number;
}

/** A cast going on. */
export interface ActiveCast {
  readonly actor: number;
  readonly source: number;
  readonly castable: Castable;
  readonly dual: boolean;
  readonly cost: CastCost;
  readonly hand: HandCast;
}

/** What reaches a target: the item cast, by whom, as strong and as costly as it was cast. */
export interface Delivered {
  readonly caster: number;
  readonly item: MagicItemRecord;
  readonly via: CastVia;
  readonly dual: boolean;
  /** The staff, scroll or shout it came by. */
  readonly object?: number | undefined;
  readonly cost: CastCost;
  /** Sent on by an explosion's spawned projectile this many times (chain lightning). */
  readonly chained?: number;
}

/** How a delivery reaches its target. */
export interface DeliverOptions {
  /** The target faces where it came from (a ward meets it). Default: true. */
  readonly facing?: boolean;
  /** A concentration spell's hit: the seconds it stands for (its effects at once by that). */
  readonly seconds?: number;
  /** Where it landed (a Target Location spell's summon or hazard stands there). */
  readonly at?: Point;
  /** Only these effect items (an area reaching only some). */
  readonly effects?: readonly number[];
}

export type CastEventKind = 'ready' | 'fire' | 'cancel' | 'stop' | 'refused' | 'ward' | 'shout';

/** What the world hears of casts (it animates them, flies what they send, shows refusals). */
export interface CastEvent {
  readonly actor: number;
  readonly source: number;
  readonly kind: CastEventKind;
  readonly cast?: ActiveCast;
  /** What fires (fire, shout). */
  readonly delivered?: Delivered;
  /** Why it was refused: magicka, charge, a power used today, the voice recovering. */
  readonly reason?: 'magicka' | 'charge' | 'power' | 'voice' | 'casting' | 'shouting';
  /** A ward hit: 1 it absorbed the spell, 2 it broke. */
  readonly ward?: 1 | 2;
  /** Words shouted. */
  readonly words?: number;
}

/** Why a cast did not begin ('started': it did). */
export type BeginResult = 'started' | 'nothing' | CastEvent['reason'];

/** What the AI casts for (src/shell/actor-casting.ts castAt). */
export type CastPurpose = 'attack' | 'heal' | 'summon' | 'ward' | 'buff';

/** How long the AI's and the conditions' ward state lasts after a hit (seconds). */
const WARD_STATE_SECONDS = 0.5;

/** A cast's magicka regeneration is held while it lasts this much after each frame (seconds). */
const CASTING_HOLD = 0.5;

/** Actor values. */
const HEALTH = ActorValue.health;
const MAGICKA = ActorValue.magicka;
const DRAGON_SOULS = ActorValue.dragonSouls;
const SHOUT_RECOVERY_MULT = 86;

/** KYWD MagicWard (Skyrim.esm): ward spells. */
const MAGIC_WARD = 0x1ea69;

export class CastingEngine {
  readonly #runtime: ScriptRuntime;
  /** Casts going on, by "actor:source". */
  readonly #casts = new Map<string, ActiveCast>();
  /** Casts ready as they began, not yet told. */
  readonly #readyAtOnce = new WeakSet<ActiveCast>();
  /** Actors' ward hits lately: the state and until when (the runtime's clock). */
  readonly #wards = new Map<number, { state: 1 | 2; until: number }>();
  /** Actors shouting now (the voice key held, an NPC's shout): since when. */
  readonly #shouting = new Map<number, number>();
  readonly #projectiles = new Map<number, Promise<ProjectileRecord | undefined>>();
  readonly #explosions = new Map<number, Promise<ExplosionRecord | undefined>>();
  readonly #shouts = new Map<number, Promise<ShoutRecord | undefined>>();
  #settings: Promise<{ casting: CastingSettings; shout: ShoutSettings }> | undefined;
  /** Seconds the engine has run (its own clock: ward states). */
  #clock = 0;
  /** When an actor last began casting an item ("actor:item": the AI's delays). */
  readonly #lastCast = new Map<string, number>();
  /** What the world hears of casts. */
  readonly listeners = new Set<(event: CastEvent) => void>();

  constructor(runtime: ScriptRuntime) {
    this.#runtime = runtime;
  }

  #emit(event: CastEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** The settings (GMSTs), read once. */
  settings(): Promise<{ casting: CastingSettings; shout: ShoutSettings }> {
    this.#settings ??= (async () => {
      const number = async (name: string, fallback: number): Promise<number> => {
        const value = await this.#runtime.gameSetting(name);
        return typeof value === 'number' ? value : fallback;
      };
      const casting: Record<string, number> = {};
      for (const [key, name] of Object.entries(CASTING_SETTING_NAMES))
        casting[key] = await number(name, CASTING_DEFAULTS[key as keyof CastingSettings]);
      return {
        casting: { ...CASTING_DEFAULTS, ...casting },
        shout: {
          time1: await number('fShoutTime1', SHOUT_DEFAULTS.time1),
          time2: await number('fShoutTime2', SHOUT_DEFAULTS.time2),
        },
      };
    })();
    return this.#settings;
  }

  /** What casting keeps of an actor. */
  state(actor: number): ActorCastingState {
    const states = this.#runtime.state.actorCasting;
    let state = states.get(actor);
    if (!state) {
      state = { powersUsed: new Map(), charge: new Map() };
      states.set(actor, state);
    }
    return state;
  }

  // --- Records ------------------------------------------------------------------------------

  projectile(formId: number): Promise<ProjectileRecord | undefined> {
    let entry = this.#projectiles.get(formId);
    if (!entry) {
      entry = this.#runtime.forms
        .record(formId)
        .then((record) => (record?.type === 'PROJ' ? parseProjectile(record) : undefined));
      this.#projectiles.set(formId, entry);
    }
    return entry;
  }

  explosion(formId: number): Promise<ExplosionRecord | undefined> {
    let entry = this.#explosions.get(formId);
    if (!entry) {
      entry = this.#runtime.forms
        .record(formId)
        .then((record) => (record?.type === 'EXPL' ? parseExplosion(record) : undefined));
      this.#explosions.set(formId, entry);
    }
    return entry;
  }

  shout(formId: number): Promise<ShoutRecord | undefined> {
    let entry = this.#shouts.get(formId);
    if (!entry) {
      entry = this.#runtime.forms
        .record(formId)
        .then((record) => (record?.type === 'SHOU' ? parseShout(record) : undefined));
      this.#shouts.set(formId, entry);
    }
    return entry;
  }

  /**
   * The effect that decides an item's school, projectile and art: its costliest (base cost ×
   * magnitude), as the magic menu shows its level.
   */
  async mainEffect(item: MagicItemRecord): Promise<MagicEffectRecord | undefined> {
    let best: MagicEffectRecord | undefined;
    let bestCost = -1;
    for (const entry of item.effects) {
      const effect = await this.#runtime.magic.effect(entry.effect);
      if (!effect) continue;
      const cost = effect.baseCost * Math.max(1, entry.magnitude);
      if (cost > bestCost) {
        best = effect;
        bestCost = cost;
      }
    }
    return best;
  }

  /** An item's base cost (before skill): its own, or its effects' (casting.ts itemBaseCost). */
  async baseCost(item: MagicItemRecord): Promise<number> {
    const { casting } = await this.settings();
    const costs = new Map<number, number>();
    for (const entry of item.effects)
      costs.set(entry.effect, (await this.#runtime.magic.effect(entry.effect))?.baseCost ?? 0);
    // An enchantment's cost is its own unless it is calculated (ENIT 0x1: no auto calc).
    const manual = item.type === 'ENCH' ? (item.flags & 0x1) !== 0 : undefined;
    return itemBaseCost(
      manual === undefined ? item : { ...item, flags: manual ? 0x1 : 0 },
      (effect) => costs.get(effect) ?? 0,
      casting,
    );
  }

  /** What casting an item costs an actor now (its school's skill), and trains. */
  async cost(actor: number, castable: Castable, dual = false): Promise<CastCost> {
    const { casting } = await this.settings();
    const item = castable.item;
    const base = await this.baseCost(item);
    const main = await this.mainEffect(item);
    const school = main && main.skill >= 0 ? main.skill : undefined;
    const charge = chargeSeconds(item.chargeTime, dual, casting);
    if (castable.via !== 'spell') {
      return {
        base,
        magicka: 0,
        charge: castable.via === 'staff' ? base : 0,
        // Staffs, scrolls, powers and shouts train nothing (UESP "Staffs", "Scrolls").
        school: undefined,
        chargeTime: charge,
      };
    }
    const skill =
      school === undefined ? 0 : (await this.#runtime.actors.value(actor, school)).current;
    // The perks change it (Mod Spell Cost: the schools' half-cost perks by the spell's casting
    // perk, Fortify <school> through the skill boost perks).
    const magicka = await this.#runtime.perks.apply(
      EntryPoint.modSpellCost,
      actor,
      magickaCost({ baseCost: base, skill, player: actor === PLAYER_REF, dual }, casting),
      [item.formId],
      { spell: item.formId },
    );
    return { base, magicka, charge: 0, school, chargeTime: charge };
  }

  /**
   * Whether an actor may dual cast a spell: a perk lets it (Can Dual Cast Spell: the schools'
   * Dual Casting perks, by the spell's school).
   */
  async canDualCast(actor: number, spell: number): Promise<boolean> {
    const value = await this.#runtime.perks.apply(EntryPoint.canDualCastSpell, actor, 0, [spell], {
      spell,
    });
    return value !== 0;
  }

  /** The magic menu's cost of a spell for the player (whole magicka). */
  async menuCost(spell: number): Promise<number> {
    const item = await this.#runtime.magic.item(spell);
    if (!item) return 0;
    return Math.round((await this.cost(PLAYER_REF, { item, via: 'spell' })).magicka);
  }

  /** What a source of an actor casts now: its hand's spell, staff or scroll, its voice's power. */
  async castable(actor: number, source: number): Promise<Castable | undefined> {
    const runtime = this.#runtime;
    const equipment = runtime.equipment;
    const state = await equipment.of(actor);
    const held =
      source === CastingSource.left
        ? state.left
        : source === CastingSource.right
          ? state.right
          : source === CastingSource.voice
            ? state.voice
            : undefined;
    if (held === undefined) return undefined;
    const record = await runtime.forms.record(held);
    if (!record) return undefined;
    if (record.type === 'SPEL' || record.type === 'SCRL') {
      const item = await runtime.magic.item(held);
      if (!item) return undefined;
      if (item.kind === 'scroll') return { item, via: 'scroll', object: held };
      if (item.kind === 'power') return { item, via: 'power' };
      if (item.kind === 'lesserPower') return { item, via: 'lesserPower' };
      return item.castType === CastType.constantEffect ? undefined : { item, via: 'spell' };
    }
    if (record.type === 'WEAP') {
      // A staff: a weapon whose enchantment is a staff enchantment (ENCH enchant type 0x0C).
      const enchantment = record.formIdField('EITM');
      const item = enchantment === undefined ? undefined : await runtime.magic.item(enchantment);
      return item?.kind === 'staffEnchantment' ? { item, via: 'staff', object: held } : undefined;
    }
    return undefined;
  }

  /**
   * The staffs an actor carries that hold charge, with their enchantments (what the combat AI
   * may fight with: src/shell/combat-casting.ts).
   */
  async staffs(
    actor: number,
  ): Promise<{ readonly staff: number; readonly item: MagicItemRecord }[]> {
    const runtime = this.#runtime;
    const staffs: { staff: number; item: MagicItemRecord }[] = [];
    for (const [form, count] of await runtime.inventory(actor)) {
      if (count <= 0) continue;
      const record = await runtime.forms.record(form);
      if (record?.type !== 'WEAP') continue;
      const enchantment = record.formIdField('EITM');
      const item = enchantment === undefined ? undefined : await runtime.magic.item(enchantment);
      if (item?.kind !== 'staffEnchantment') continue;
      const castable: Castable = { item, via: 'staff', object: form };
      if ((await this.charge(actor, castable)) < (await this.cost(actor, castable)).charge)
        continue;
      staffs.push({ staff: form, item });
    }
    return staffs;
  }

  // --- Casts ---------------------------------------------------------------------------------

  /** The cast going on from a source, if any. */
  casting(actor: number, source: number): ActiveCast | undefined {
    return this.#casts.get(`${String(actor)}:${String(source)}`);
  }

  /** Every cast of an actor now. */
  castsOf(actor: number): ActiveCast[] {
    return [...this.#casts.values()].filter((cast) => cast.actor === actor);
  }

  /**
   * A cast begins from a source (the attack button with a spell in the hand, the voice key
   * with a power). Refused: without magicka (a concentration spell: any; fire and forget: its
   * cost), a staff's charge, a power used today, while shouting. `dual`: both hands cast one
   * spell, with the Dual Casting perk of its school (canDualCast; else it is cast single).
   */
  async begin(
    actor: number,
    source: number,
    options: { dual?: boolean } = {},
  ): Promise<BeginResult> {
    const runtime = this.#runtime;
    if (this.casting(actor, source)) return 'casting';
    if (this.#shouting.has(actor)) return this.#refuse(actor, source, 'shouting');
    const castable = await this.castable(actor, source);
    if (!castable) return 'nothing';
    const dual =
      options.dual === true &&
      castable.via === 'spell' &&
      (await this.canDualCast(actor, castable.item.formId));
    const cost = await this.cost(actor, castable, dual);
    switch (castable.via) {
      case 'spell': {
        const magicka = (await runtime.actors.value(actor, MAGICKA)).current;
        const needed = castable.item.castType === CastType.concentration ? 0 : cost.magicka;
        // TODO(M13): what a concentration spell needs to begin (any magicka here).
        if (magicka <= 0 || magicka < needed - 1e-6) return this.#refuse(actor, source, 'magicka');
        break;
      }
      case 'staff':
        if ((await this.charge(actor, castable)) < cost.charge - 1e-6)
          return this.#refuse(actor, source, 'charge');
        break;
      case 'power':
        if (
          !powerReady(
            this.state(actor).powersUsed.get(castable.item.formId),
            runtime.state.gameDaysPassed,
          )
        )
          return this.#refuse(actor, source, 'power');
        break;
      case 'scroll':
        if ((await runtime.itemCount(actor, castable.item.formId)) <= 0) return 'nothing';
        break;
      default:
        break;
    }
    const cast: ActiveCast = {
      actor,
      source,
      castable,
      dual,
      cost,
      hand: beginCast(castable.item.castType, cost.chargeTime),
    };
    this.#casts.set(`${String(actor)}:${String(source)}`, cast);
    // When it last cast it (the combat AI waits out its effects' AI Delay Time: chooseSpell).
    this.#lastCast.set(`${String(actor)}:${String(castable.item.formId)}`, this.#clock);
    // Casting ends invisibility (UESP "Skyrim:Invisibility").
    runtime.magic.acted(actor);
    if (castable.via === 'spell')
      runtime.progression.holdRegeneration(actor, MAGICKA, CASTING_HOLD);
    // Ready at once (no charge time): told with the next frame, after the world showed its start.
    if (cast.hand.phase !== 'charging') this.#readyAtOnce.add(cast);
    return 'started';
  }

  /** A refusal: the HUD hears of the player's (the meter blinks; a power's message). */
  async #refuse(actor: number, source: number, reason: CastEvent['reason']): Promise<BeginResult> {
    const runtime = this.#runtime;
    if (reason === 'magicka') runtime.progression.refused(actor, 'magicka');
    if (actor === PLAYER_REF) {
      const setting =
        reason === 'power'
          ? 'sMagicCastPowerUsed'
          : reason === 'charge'
            ? 'sMagicCastInsufficientItemCharge'
            : reason === 'shouting'
              ? 'sMagicCastCastWhileShouting'
              : undefined;
      const text = setting === undefined ? undefined : await runtime.gameSetting(setting);
      if (typeof text === 'string' && text) runtime.world.notification?.(text);
    }
    this.#emit({ actor, source, kind: 'refused', reason });
    return reason;
  }

  /**
   * The source lets go: a ready fire and forget cast fires (paid now: magicka, the staff's
   * charge, the scroll, the day's power), one still charging is let go; a concentration
   * spell stops. Returns what fires (the world sends it on its way).
   */
  async release(actor: number, source: number): Promise<Delivered | undefined> {
    const key = `${String(actor)}:${String(source)}`;
    const cast = this.#casts.get(key);
    if (!cast) return undefined;
    this.#casts.delete(key);
    const outcome = releaseCast(cast.hand);
    if (outcome !== 'fire') {
      this.#emit({ actor, source, kind: outcome, cast });
      return undefined;
    }
    if (!(await this.#pay(cast))) {
      this.#emit({ actor, source, kind: 'cancel', cast });
      return undefined;
    }
    const delivered = this.#delivered(cast);
    this.#emit({ actor, source, kind: 'fire', cast, delivered });
    return delivered;
  }

  /** A cast stops without firing (staggered, the hand changed, the actor died). */
  interrupt(actor: number, source?: number): void {
    for (const [key, cast] of [...this.#casts]) {
      if (cast.actor !== actor || (source !== undefined && cast.source !== source)) continue;
      this.#casts.delete(key);
      cast.hand.phase = 'done';
      this.#emit({ actor, source: cast.source, kind: 'cancel', cast });
    }
    if (source === undefined || source === CastingSource.voice) this.#shouting.delete(actor);
  }

  /** What a concentration spell held sends now (each spray, each hit: no payment, `update` pays). */
  held(actor: number, source: number): Delivered | undefined {
    const cast = this.casting(actor, source);
    return cast?.hand.phase === 'casting' ? this.#delivered(cast) : undefined;
  }

  #delivered(cast: ActiveCast): Delivered {
    return {
      caster: cast.actor,
      item: cast.castable.item,
      via: cast.castable.via,
      dual: cast.dual,
      object: cast.castable.object,
      cost: cast.cost,
    };
  }

  /** A script's cast (Spell.Cast): free, training nothing. */
  async scripted(caster: number, item: MagicItemRecord): Promise<Delivered> {
    return {
      caster,
      item,
      via: 'script',
      dual: false,
      cost: { ...(await this.cost(caster, { item, via: 'script' })), school: undefined },
    };
  }

  /** Pays for a fire and forget cast as it fires. False: it cannot be paid now. */
  async #pay(cast: ActiveCast): Promise<boolean> {
    const runtime = this.#runtime;
    const { actor, castable, cost } = cast;
    switch (castable.via) {
      case 'spell': {
        const magicka = (await runtime.actors.value(actor, MAGICKA)).current;
        if (magicka < cost.magicka - 1e-6) {
          runtime.progression.refused(actor, 'magicka');
          return false;
        }
        await runtime.progression.spend(actor, MAGICKA, cost.magicka);
        return true;
      }
      case 'staff': {
        const left = await this.charge(actor, castable);
        if (left < cost.charge - 1e-6) return false;
        if (castable.object !== undefined)
          this.state(actor).charge.set(castable.object, left - cost.charge);
        return true;
      }
      case 'scroll': {
        // Read once: one is used up (TODO(M13): whether it leaves the hand at once).
        if ((await runtime.itemCount(actor, castable.item.formId)) <= 0) return false;
        await runtime.removeItem(
          actor,
          runtime.formHandle(castable.item.formId),
          1,
          true,
          undefined,
        );
        return true;
      }
      case 'power':
        this.state(actor).powersUsed.set(castable.item.formId, runtime.state.gameDaysPassed);
        return true;
      default:
        return true;
    }
  }

  /** A staff's charge left (its full charge, WEAP EAMT, until it is used). */
  async charge(actor: number, castable: Castable): Promise<number> {
    const staff = castable.object;
    if (staff === undefined) return 0;
    const kept = this.state(actor).charge.get(staff);
    if (kept !== undefined) return kept;
    const record = await this.#runtime.forms.record(staff);
    const eamt = record?.fields.first('EAMT');
    const full =
      eamt && eamt.length >= 2
        ? new DataView(eamt.buffer, eamt.byteOffset, eamt.byteLength).getUint16(0, true)
        : (castable.item.enchantment?.amount ?? 0);
    return full;
  }

  /**
   * Every frame: casts charge (ready as they are), concentration spells spend their cost for
   * the time held (stopping as the magicka runs out), voices recover.
   */
  update(seconds: number): void {
    if (seconds <= 0) return;
    this.#clock += seconds;
    const runtime = this.#runtime;
    for (const [key, cast] of [...this.#casts]) {
      const atOnce = this.#readyAtOnce.delete(cast);
      const { casting, began } = advanceCast(cast.hand, seconds);
      if (atOnce) this.#emit({ actor: cast.actor, source: cast.source, kind: 'ready', cast });
      if (cast.castable.via === 'spell')
        runtime.progression.holdRegeneration(cast.actor, MAGICKA, CASTING_HOLD);
      if (began) this.#emit({ actor: cast.actor, source: cast.source, kind: 'ready', cast });
      if (casting > 0 && cast.castable.via === 'spell' && cast.cost.magicka > 0)
        runtime.detach(this.#concentrate(key, cast, cast.cost.magicka * casting));
    }
    // The voice recovers (ActorState voiceRecoveryTime: SetVoiceRecoveryTime, shouts).
    for (const [actor, state] of runtime.state.actors) {
      const left = state.voiceRecoveryTime ?? 0;
      if (left <= 0) continue;
      state.voiceRecoveryTime = Math.max(0, left - seconds);
      if (state.voiceRecoveryTime === 0) {
        const casting = runtime.state.actorCasting.get(actor);
        if (casting) delete casting.voiceRecoveryTotal;
      }
    }
  }

  /** A concentration spell spends what it held for; out of magicka, it stops. */
  async #concentrate(key: string, cast: ActiveCast, amount: number): Promise<void> {
    const runtime = this.#runtime;
    // The time was held: it is paid even if the spell was let go meanwhile.
    const magicka = (await runtime.actors.value(cast.actor, MAGICKA)).current;
    await runtime.progression.spend(cast.actor, MAGICKA, amount);
    if (magicka - amount > 0 || this.#casts.get(key) !== cast) return;
    this.#casts.delete(key);
    cast.hand.phase = 'done';
    runtime.progression.refused(cast.actor, 'magicka');
    this.#emit({ actor: cast.actor, source: cast.source, kind: 'stop', cast, reason: 'magicka' });
  }

  // --- Delivery ------------------------------------------------------------------------------

  /**
   * A cast reaches a target (an actor or an object): past its ward and Spell Absorption, the
   * spell's effects through the magic system; a hostile spell's hit is heard (OnHit), the
   * caster's school is used. Returns how many effects took hold.
   */
  async deliver(
    delivered: Delivered,
    target: number,
    options: DeliverOptions = {},
  ): Promise<number> {
    const runtime = this.#runtime;
    const { caster, item } = delivered;
    const actor = await runtime.actors.isActor(target);
    const hostile = target !== caster && (await runtime.magic.hostile(item));
    let scale = options.seconds;
    if (actor && hostile && !(await runtime.actors.isDead(target))) {
      if (await this.#absorbed(delivered, target)) return 0;
      const ward = await this.#ward(delivered, target, options);
      if (ward === 'absorbed') return 0;
      if (ward !== undefined) scale = (scale ?? 1) * ward;
    }
    const concentration = options.seconds !== undefined;
    // A concentration spell's effects that last while it is held go on rather than anew.
    const kept = concentration
      ? runtime.magic.extendHeld(target, item.formId, caster, heldSeconds(options.seconds))
      : new Set<number>();
    const effects = (options.effects ?? item.effects.map((_, index) => index)).filter(
      (index) => !kept.has(index),
    );
    const applied =
      effects.length === 0
        ? 0
        : await runtime.magic.apply(item, target, {
            caster,
            ...(delivered.dual && { dual: true }),
            ...(delivered.via === 'staff' &&
              delivered.object !== undefined && { source: delivered.object }),
            effects,
            ...(scale !== undefined && { scale }),
            ...(concentration && { hold: heldSeconds(options.seconds) }),
            ...(options.at && { at: [options.at[0], options.at[1], options.at[2]] }),
          });
    if (applied > 0 && hostile && actor) {
      runtime.detach(
        runtime.sendEvent(target, 'OnHit', [
          runtime.referenceHandle(caster),
          runtime.formHandle(delivered.object ?? item.formId),
          null,
          false,
          false,
          false,
          false,
        ]),
      );
    }
    // The school is used by the spell's base cost (a concentration spell's: by the time).
    if (applied > 0 && delivered.cost.school !== undefined) {
      const { casting } = await this.settings();
      const uses =
        castSkillUses(delivered.cost.base, delivered.dual, casting) * (options.seconds ?? 1);
      await runtime.progression.useSkill(caster, delivered.cost.school, uses);
    }
    return applied + kept.size;
  }

  /**
   * Spell Absorption: a hostile spell, scroll or staff's (not a power's, a shout's or one that
   * disallows it) is absorbed by the target's AbsorbChance percent: it does nothing, the target
   * gains its magicka cost (UESP "Skyrim:Spell Absorption"). TODO(M13): the cap and the
   * magicka gained for staffs and scrolls (their base cost here).
   */
  async #absorbed(delivered: Delivered, target: number): Promise<boolean> {
    const runtime = this.#runtime;
    const { item } = delivered;
    if (!(delivered.via === 'spell' || delivered.via === 'scroll' || delivered.via === 'staff'))
      return false;
    if (item.type === 'SPEL' && (item.flags & MagicSpellFlag.disallowAbsorbReflect) !== 0)
      return false;
    const chance = (await runtime.actors.value(target, MagicValue.absorbChance)).current;
    if (chance <= 0 || Math.random() * 100 >= chance) return false;
    const gained = delivered.cost.magicka > 0 ? delivered.cost.magicka : delivered.cost.base;
    runtime.actors.restore(target, MAGICKA, gained);
    return true;
  }

  /**
   * A ward (WardPower, grown by a ward spell held) meets a hostile spell from the front: its
   * damage (the magnitudes of its hostile value effects on Health, Magicka or Stamina) up to the
   * ward's strength is absorbed, the strength taken down by it; more breaks the ward and the
   * rest passes (UESP "Skyrim:Ward"). Returns 'absorbed', the share that passes, or undefined
   * (no ward). TODO(M13): the engine's rule for effects without damage (taken as absorbed).
   */
  async #ward(
    delivered: Delivered,
    target: number,
    options: DeliverOptions,
  ): Promise<'absorbed' | number | undefined> {
    const runtime = this.#runtime;
    if (options.facing === false) return undefined;
    const power = (await runtime.actors.value(target, MagicValue.wardPower)).current;
    if (power <= 0) return undefined;
    let damage = 0;
    for (const entry of delivered.item.effects) {
      const effect = await runtime.magic.effect(entry.effect);
      if (!effect || (effect.flags & EffectFlag.hostile) === 0) continue;
      if (
        effect.actorValue === HEALTH ||
        effect.actorValue === MAGICKA ||
        effect.actorValue === ActorValue.stamina
      )
        damage += entry.magnitude * (options.seconds ?? 1);
    }
    const until = this.#clock + WARD_STATE_SECONDS;
    // The ward gives magicka back for what it takes (Mod Ward Magicka Absorption Pct: Ward
    // Absorb, a share of the damage it absorbs).
    const absorb = await runtime.perks.apply(
      EntryPoint.modWardMagickaAbsorptionPct,
      target,
      0,
      [delivered.item.formId],
      { spell: delivered.item.formId },
    );
    if (absorb > 0) runtime.actors.restore(target, MAGICKA, Math.min(damage, power) * absorb);
    if (damage <= power) {
      await runtime.actors.damage(target, MagicValue.wardPower, damage);
      this.#wards.set(target, { state: 1, until });
      this.#emit({ actor: target, source: CastingSource.instant, kind: 'ward', ward: 1 });
      return 'absorbed';
    }
    await runtime.actors.damage(target, MagicValue.wardPower, power);
    this.#wards.set(target, { state: 2, until });
    this.#emit({ actor: target, source: CastingSource.instant, kind: 'ward', ward: 2 });
    return (damage - power) / damage;
  }

  /**
   * An area: the actors within an effect's area (feet) of a point take the effects whose area
   * reaches them (`exclude`: the one hit directly, who has them already). Returns the actors
   * reached.
   */
  async area(
    delivered: Delivered,
    point: Point,
    options: { readonly exclude?: number; readonly seconds?: number } = {},
  ): Promise<number[]> {
    const runtime = this.#runtime;
    const areas = delivered.item.effects.map((entry) => entry.area * UNITS_PER_FOOT);
    const widest = Math.max(0, ...areas);
    if (widest <= 0) return [];
    const reached: number[] = [];
    for (const reference of runtime.world.loadedReferences?.() ?? []) {
      if (reference === options.exclude) continue;
      const at = runtime.world.livePlacement?.(reference)?.position;
      if (!at) continue;
      const distance = Math.hypot(at[0] - point[0], at[1] - point[1], at[2] - point[2]);
      if (distance > widest) continue;
      if (!(await runtime.actors.isActor(reference)) || (await runtime.actors.isDead(reference)))
        continue;
      const effects = areas.flatMap((area, index) => (distance <= area ? [index] : []));
      if (effects.length === 0) continue;
      // TODO(M13): line of sight from the point (SPIT 0x80000 "Area Effect Ignores LOS").
      const applied = await this.deliver(delivered, reference, {
        facing: false,
        effects,
        ...(options.seconds !== undefined && { seconds: options.seconds }),
      });
      if (applied > 0) reached.push(reference);
    }
    return reached;
  }

  /**
   * An explosion bursts at a point (a projectile's, an effect's): its enchantment on the actors
   * within its radius, its damage (Health, less with distance), its force pushing what is there
   * (the world's impulse); destructible objects within it take its damage and its enchantment
   * (destruction-engine.ts), `exclude` aside (the object whose destruction stage set it off). Its
   * knock-down flags (EXPL DATA) knock the actors down, pushed away from it by its force: Knock
   * Down Always all of them, Knock Down By Formula those whose health is below
   * fKnockdownCurrentHealthThreshold percent (TODO(M13): the engine's formula is not documented;
   * that setting is the one its name ties to it). Returns the actors reached.
   */
  async explode(
    caster: number | undefined,
    explosionId: number,
    point: Point,
    exclude?: number,
  ): Promise<number[]> {
    const runtime = this.#runtime;
    const explosion = await this.explosion(explosionId);
    if (!explosion || explosion.radius <= 0) return [];
    const enchantment =
      explosion.enchantment === undefined
        ? undefined
        : await runtime.magic.item(explosion.enchantment);
    const reached: number[] = [];
    for (const reference of runtime.world.loadedReferences?.() ?? []) {
      const at = runtime.world.livePlacement?.(reference)?.position;
      if (!at) continue;
      const offset: Vec3 = [at[0] - point[0], at[1] - point[1], at[2] - point[2]];
      const distance = Math.hypot(...offset);
      if (distance > explosion.radius) continue;
      const share = Math.max(0, 1 - distance / explosion.radius);
      if (explosion.force > 0 && distance > 0)
        runtime.world.impulse?.(reference, offset, explosion.force * share);
      if (!(await runtime.actors.isActor(reference)) || (await runtime.actors.isDead(reference)))
        continue;
      reached.push(reference);
      if (await this.#knocksDown(explosion, reference))
        runtime.world.knockDown?.(reference, [...point], explosion.force * share);
      if (explosion.damage > 0)
        await runtime.actors.damage(reference, HEALTH, explosion.damage * share, caster);
      if (enchantment)
        await this.deliver(
          {
            caster: caster ?? reference,
            item: enchantment,
            via: 'script',
            dual: false,
            cost: NO_COST,
          },
          reference,
          { facing: false },
        );
    }
    // Destructible objects: its damage (external), its enchantment's effects on objects (the
    // magic engine's: a Damage Health effect takes their health).
    const at: Vec3 = [point[0], point[1], point[2]];
    for (const { reference, share } of await runtime.destruction.within(
      at,
      explosion.radius,
      exclude,
    )) {
      if (explosion.damage > 0)
        await runtime.destruction.damage(reference, explosion.damage * share, {
          external: true,
          source: caster,
        });
      if (enchantment)
        await this.deliver(
          {
            caster: caster ?? reference,
            item: enchantment,
            via: 'script',
            dual: false,
            cost: NO_COST,
          },
          reference,
          { facing: false },
        );
    }
    return reached;
  }

  // --- Shouts and powers ---------------------------------------------------------------------

  /**
   * The words an actor knows of a shout in a row from the first: the player's learned and
   * unlocked (Game.TeachWord, Game.UnlockWord), an NPC all of them.
   */
  wordsKnown(actor: number, shout: ShoutRecord): number {
    if (actor !== PLAYER_REF) return shout.words.length;
    const learned = this.#runtime.wordsLearned;
    return wordsAvailable(shout.words, (word) => learned.get(word) === true);
  }

  /**
   * The voice key goes down (or an NPC begins a shout): with a shout in the voice whose first
   * word is known and the voice recovered it begins; while it recovers the HUD's shout meter
   * flashes (refused 'voice'); a power in the voice is cast as a spell (begin).
   */
  async beginShout(actor: number): Promise<BeginResult> {
    const runtime = this.#runtime;
    const voice = (await runtime.equipment.of(actor)).voice;
    if (voice === undefined) return 'nothing';
    if ((await runtime.forms.record(voice))?.type !== 'SHOU')
      return this.begin(actor, CastingSource.voice);
    const shout = await this.shout(voice);
    if (!shout || this.wordsKnown(actor, shout) === 0) return 'nothing';
    // The player shouts while its perks allow it (Mod Shout OK above 0: the player's
    // AllowShoutingPerk, the werewolf's howls). TODO(M13): whether the engine asks it of NPCs.
    if (actor === PLAYER_REF && (await runtime.perks.apply(EntryPoint.modShoutOk, actor, 0)) <= 0)
      return 'nothing';
    if (this.castsOf(actor).length > 0) {
      if (actor === PLAYER_REF) {
        const text = await runtime.gameSetting('sMagicCastShoutWhileCasting');
        if (typeof text === 'string' && text) runtime.world.notification?.(text);
      }
      this.#emit({ actor, source: CastingSource.voice, kind: 'refused', reason: 'casting' });
      return 'casting';
    }
    if ((runtime.state.actors.get(actor)?.voiceRecoveryTime ?? 0) > 0) {
      this.#emit({ actor, source: CastingSource.voice, kind: 'refused', reason: 'voice' });
      return 'voice';
    }
    this.#shouting.set(actor, this.#clock);
    runtime.magic.acted(actor);
    return 'started';
  }

  /** Seconds the voice key has been held (the shout begun), or undefined. */
  shoutHeld(actor: number): number | undefined {
    const since = this.#shouting.get(actor);
    return since === undefined ? undefined : this.#clock - since;
  }

  /**
   * The shout is let out with `words` words (at most those known): its spell of that many words
   * fires, the voice recovers for that word's time (× 1 − ShoutRecoveryMult). Returns what fires.
   */
  async releaseShout(actor: number, words: number): Promise<Delivered | undefined> {
    const runtime = this.#runtime;
    if (!this.#shouting.delete(actor)) return undefined;
    const voice = (await runtime.equipment.of(actor)).voice;
    const shout = voice === undefined ? undefined : await this.shout(voice);
    if (!shout || voice === undefined) return undefined;
    const count = Math.min(Math.max(1, words), this.wordsKnown(actor, shout));
    const word = shout.words[count - 1];
    const item = word && (await runtime.magic.item(word.spell));
    if (!item) return undefined;
    const mult = (await runtime.actors.value(actor, SHOUT_RECOVERY_MULT)).current;
    const recovery = shoutRecovery(shout.words, count, mult);
    const state = runtime.state.actor(actor);
    state.voiceRecoveryTime = recovery;
    const casting = this.state(actor);
    casting.voiceRecoveryTotal = recovery;
    casting.shoutVariation = count - 1;
    const delivered: Delivered = {
      caster: actor,
      item,
      via: 'shout',
      dual: false,
      object: voice,
      cost: { base: 0, magicka: 0, charge: 0, school: undefined, chargeTime: 0 },
    };
    this.#emit({ actor, source: CastingSource.voice, kind: 'shout', delivered, words: count });
    // The player's thu'um shakes the view as the controller rumbles: fShoutRumbleBigMotor
    // FrequencyV<n> and DurationV<n> by the words (TODO(M13): the camera's shake read from the
    // rumble's settings).
    if (actor === PLAYER_REF) {
      const strength = await runtime.gameSetting(`fShoutRumbleBigMotorFrequencyV${String(count)}`);
      const seconds = await runtime.gameSetting(`fShoutRumbleBigMotorDurationV${String(count)}`);
      if (typeof strength === 'number' && typeof seconds === 'number')
        runtime.world.shakeCamera?.(strength, seconds);
    }
    return delivered;
  }

  /** The shout meter: 100 recovered, less while the voice recovers. */
  voiceMeter(actor: number): number {
    const left = this.#runtime.state.actors.get(actor)?.voiceRecoveryTime ?? 0;
    const total = this.#runtime.state.actorCasting.get(actor)?.voiceRecoveryTotal ?? left;
    return shoutMeterPercent(left, total);
  }

  /** Whether an actor is shouting now (the voice key held). */
  isShouting(actor: number): boolean {
    return this.#shouting.has(actor);
  }

  /**
   * Whether an actor's hands hold magic and no weapon (spells or scrolls; staves are weapons):
   * drawn, it has magic out, not a weapon (IsWeaponOut against IsWeaponMagicOut).
   */
  async magicOnly(actor: number): Promise<boolean> {
    const runtime = this.#runtime;
    let magic = false;
    for (const source of [CastingSource.left, CastingSource.right]) {
      const castable = await this.castable(actor, source);
      if (castable?.via === 'spell' || castable?.via === 'scroll') magic = true;
      else if (
        (await runtime.equipment.weapon(
          actor,
          source === CastingSource.left ? 'left' : 'right',
        )) !== undefined
      )
        return false;
    }
    return magic;
  }

  /**
   * The player spends a dragon soul on a shout: its first learned and locked word is unlocked
   * (Game.UnlockWord). 'noSoul': none to spend (sFailSpendSoul); 'none': nothing to unlock.
   * `dryRun`: only what it would do.
   */
  async unlockWord(
    shoutId: number,
    options: { readonly dryRun?: boolean } = {},
  ): Promise<'unlocked' | 'noSoul' | 'none'> {
    const runtime = this.#runtime;
    const shout = await this.shout(shoutId);
    if (!shout) return 'none';
    const learned = runtime.wordsLearned;
    const word = wordToUnlock(shout.words, (id) => {
      const state = learned.get(id);
      return state === undefined ? false : state ? true : 'locked';
    });
    if (word === undefined) return 'none';
    if ((await runtime.actors.value(PLAYER_REF, DRAGON_SOULS)).current < 1) return 'noSoul';
    if (options.dryRun === true) return 'unlocked';
    runtime.actors.modify(PLAYER_REF, DRAGON_SOULS, -1);
    learned.set(word, true);
    return 'unlocked';
  }

  /** Whether an explosion knocks an actor down (its flags; by formula: its health is low). */
  async #knocksDown(explosion: ExplosionRecord, actor: number): Promise<boolean> {
    if ((explosion.flags & ExplosionFlag.knockDownAlways) !== 0) return true;
    if ((explosion.flags & ExplosionFlag.knockDownByFormula) === 0) return false;
    const threshold = await this.#runtime.gameSetting('fKnockdownCurrentHealthThreshold');
    const health = await this.#runtime.actors.value(actor, HEALTH);
    const percent = health.max > 0 ? (health.current / health.max) * 100 : 100;
    return percent < (typeof threshold === 'number' ? threshold : 50);
  }

  // --- The AI ------------------------------------------------------------------------------

  /**
   * The spell an NPC casts for a purpose now (the combat AI's: src/shell/combat-casting.ts): of
   * its spells (and what its hands hold), those that serve it (attack: hostile and sent at a
   * target; heal: restores its Health; summon: summons or raises; ward: a ward; buff: a Self
   * spell otherwise), that it has the magicka for and whose effects' AI Delay Time (MGEF) has
   * passed since it last cast it, the one worth most against `target` (spellWorth: through its
   * resistances and weaknesses), the costliest of those worth as much.
   */
  async chooseSpell(
    actor: number,
    purpose: CastPurpose,
    target?: number,
  ): Promise<MagicItemRecord | undefined> {
    const runtime = this.#runtime;
    const ids = new Set(await runtime.actors.spells(actor));
    const loadout = await runtime.equipment.of(actor);
    for (const held of [loadout.left, loadout.right]) if (held !== undefined) ids.add(held);
    const magicka = (await runtime.actors.value(actor, MAGICKA)).current;
    let best: { item: MagicItemRecord; cost: number; worth: number } | undefined;
    for (const id of ids) {
      const item = await runtime.magic.item(id);
      if (item?.kind !== 'spell' || item.castType === CastType.constantEffect) continue;
      if (!(await this.#serves(item, purpose))) continue;
      const cost = (await this.cost(actor, { item, via: 'spell' })).magicka;
      const needed = item.castType === CastType.concentration ? 0 : cost;
      if (magicka <= 0 || magicka < needed) continue;
      if (await this.#delayed(actor, item)) continue;
      const worth = await this.spellWorth(actor, item, purpose, target);
      if (worth <= 0) continue;
      if (!best || worth > best.worth || (worth === best.worth && cost > best.cost))
        best = { item, cost, worth };
    }
    return best?.item;
  }

  /**
   * What a spell (or a staff's enchantment, a shout's word) is worth to an NPC's combat AI for a
   * purpose (TODO(M13): the engine's CombatMagicCaster weighing is not documented; this reads
   * what the data give): for an attack, each effect's magnitude (by its seconds: a damage over
   * time counts whole) times the share its target keeps of it (magic-engine foresee: none where
   * its conditions or level cap leave the target out, its resistances' share of a hostile one:
   * the target's weaknesses and resistances choose the element), an effect without a magnitude
   * (paralysis, fear, a stagger's push) counting 1, plus each effect's MGEF Script Effect AI
   * Score; to heal, the Health it restores; for the others, its cost (the stronger the better).
   */
  async spellWorth(
    actor: number,
    item: MagicItemRecord,
    purpose: CastPurpose,
    target?: number,
  ): Promise<number> {
    const runtime = this.#runtime;
    let worth = 0;
    for (const [index, entry] of item.effects.entries()) {
      const effect = await runtime.magic.effect(entry.effect);
      if (!effect) continue;
      const amount = Math.max(0, entry.magnitude) * Math.max(1, entry.duration);
      if (purpose === 'attack') {
        if ((effect.flags & EffectFlag.hostile) === 0) continue;
        const share =
          target === undefined ? 1 : await runtime.magic.foresee(item, index, target, actor);
        worth += (amount > 0 ? amount : 1) * share + effect.aiScore * (share > 0 ? 1 : 0);
      } else if (purpose === 'heal') {
        if (effect.archetype === EffectArchetype.valueModifier && effect.actorValue === HEALTH)
          worth += amount;
      } else {
        worth += effect.aiScore;
      }
    }
    if (purpose !== 'attack' && purpose !== 'heal')
      worth += Math.max(1, (await this.cost(actor, { item, via: 'spell' })).magicka);
    return worth;
  }

  /** Whether the AI waits yet to cast an item again (its effects' MGEF AI Delay Time). */
  async #delayed(actor: number, item: MagicItemRecord): Promise<boolean> {
    const last = this.#lastCast.get(`${String(actor)}:${String(item.formId)}`);
    if (last === undefined) return false;
    let delay = 0;
    for (const entry of item.effects)
      delay = Math.max(delay, (await this.#runtime.magic.effect(entry.effect))?.aiDelay ?? 0);
    return this.#clock - last < delay;
  }

  /**
   * The potion an NPC drinks to restore an actor value (Health, Magicka, Stamina): of the
   * potions it carries, the one restoring the most (magnitude × its seconds). When it drinks
   * is the combat AI's (src/shell/actor-combat-ai.ts: below iAICombatRestoreHealthPercentage,
   * once every fCombatItemRestoreTimer).
   */
  async choosePotion(actor: number, value: number): Promise<number | undefined> {
    const runtime = this.#runtime;
    let best: { formId: number; amount: number } | undefined;
    for (const [formId, count] of await runtime.inventory(actor)) {
      if (count <= 0) continue;
      const item = await runtime.magic.item(formId);
      if (item?.kind !== 'potion') continue;
      let amount = 0;
      for (const entry of item.effects) {
        const effect = await runtime.magic.effect(entry.effect);
        if (
          effect?.archetype !== EffectArchetype.valueModifier ||
          effect.actorValue !== value ||
          (effect.flags & (EffectFlag.detrimental | EffectFlag.hostile | EffectFlag.recover)) !== 0
        )
          continue;
        amount += entry.magnitude * Math.max(1, entry.duration);
      }
      if (amount > 0 && (!best || amount > best.amount)) best = { formId, amount };
    }
    return best?.formId;
  }

  async #serves(item: MagicItemRecord, purpose: CastPurpose): Promise<boolean> {
    const runtime = this.#runtime;
    const effects: MagicEffectRecord[] = [];
    for (const entry of item.effects) {
      const effect = await runtime.magic.effect(entry.effect);
      if (effect) effects.push(effect);
    }
    const hostile = effects.some((effect) => (effect.flags & EffectFlag.hostile) !== 0);
    const archetypes = new Set(effects.map((effect) => effect.archetype));
    // A ward: MagicWard on the spell or (the vanilla wards') on its effects.
    const ward =
      item.keywords.includes(MAGIC_WARD) ||
      effects.some((effect) => effect.keywords.includes(MAGIC_WARD));
    const summons =
      archetypes.has(EffectArchetype.summonCreature) || archetypes.has(EffectArchetype.reanimate);
    switch (purpose) {
      case 'attack':
        return hostile && item.delivery !== Delivery.self && !summons;
      case 'heal':
        return (
          item.delivery === Delivery.self &&
          effects.some(
            (effect) =>
              effect.archetype === EffectArchetype.valueModifier &&
              effect.actorValue === HEALTH &&
              (effect.flags & (EffectFlag.detrimental | EffectFlag.hostile)) === 0,
          )
        );
      case 'summon':
        return summons;
      case 'ward':
        return ward;
      case 'buff':
        // A Self spell that lasts (armour, a cloak, Muffle): cast once, it stays on.
        return (
          item.delivery === Delivery.self &&
          item.castType === CastType.fireAndForget &&
          !hostile &&
          !summons &&
          !ward &&
          item.effects.some((entry) => entry.duration > 0)
        );
    }
  }

  // --- Conditions ----------------------------------------------------------------------------

  /** What a source casts now, or would cast (the idle tree asks before a cast begins). */
  async #current(actor: number, source: number): Promise<MagicItemRecord | undefined> {
    return this.casting(actor, source)?.castable.item ?? (await this.castable(actor, source))?.item;
  }

  /** GetCurrentCastingType(source): 0 constant .. 2 concentration; −1 none (as the game's). */
  async castingType(actor: number, source: number): Promise<number> {
    return (await this.#current(actor, source))?.castType ?? -1;
  }

  /** GetCurrentDeliveryType(source): 0 self .. 4 target location; −1 none. */
  async deliveryType(actor: number, source: number): Promise<number> {
    return (await this.#current(actor, source))?.delivery ?? -1;
  }

  /** SpellHasKeyword(source, keyword): what the source casts has the keyword. */
  async spellHasKeyword(actor: number, source: number, keyword: number): Promise<boolean> {
    return (await this.#current(actor, source))?.keywords.includes(keyword) ?? false;
  }

  /** IsCurrentSpell(spell, source): the source casts that spell now. */
  isCurrentSpell(actor: number, spell: number, source: number): boolean {
    return this.casting(actor, source)?.castable.item.formId === spell;
  }

  /** IsCasting: any source casts. */
  isCasting(actor: number): boolean {
    return this.castsOf(actor).length > 0;
  }

  /** IsDualCasting: a cast of both hands. */
  isDualCasting(actor: number): boolean {
    return this.castsOf(actor).some((cast) => cast.dual);
  }

  /** GetCurrentShoutVariation: the words of its last shout less one. */
  shoutVariation(actor: number): number {
    return this.#runtime.state.actorCasting.get(actor)?.shoutVariation ?? 0;
  }

  /** IsWardState(state): its ward just absorbed (1) or broke (2); 0 none. */
  wardState(actor: number): number {
    const ward = this.#wards.get(actor);
    return ward && ward.until >= this.#clock ? ward.state : 0;
  }
}

/** A delivery that costs and trains nothing (an explosion's enchantment). */
const NO_COST: CastCost = { base: 0, magicka: 0, charge: 0, school: undefined, chargeTime: 0 };

/** How long a concentration spell's held effects last past a hit (seconds: a few sprays). */
function heldSeconds(seconds: number | undefined): number {
  return Math.max(0.5, (seconds ?? 0) * 3);
}
