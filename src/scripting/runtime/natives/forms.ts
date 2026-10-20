// Natives of the other form scripts: Faction (crime gold, reactions), Cell (owners, public),
// Location (keyword data, cleared, its references), Weather, the leveled lists scripts add to,
// Spell, Scroll, Weapon, Ingredient, Potion, Enchantment, MagicEffect, Armor, Light, and what
// the engine plays (Sound, SoundCategory, MusicType, ImageSpaceModifier, EffectShader,
// VisualEffect, ShaderParticleGeometry) through the WorldBridge. Signatures: the game's own
// .pex files. Platform-independent. Notes: docs/scripting.md ("Natives").

import { view } from '../../../formats/esm/fields.ts';
import { actorValueName } from '../../../world/actor-values.ts';
import type { NativeCall } from '../../papyrus-vm.ts';
import type { Value } from '../../values.ts';
import { PLAYER_REF } from '../forms.ts';
import type { ScriptRuntime } from '../runtime.ts';
import { bool, formOf, int, num, object, type Register } from './args.ts';

/** WTHR DATA flags (byte 11 in SSE: pleasant 0x1, cloudy 0x2, rainy 0x4, snow 0x8). */
const WEATHER_CLASSES = [0x1, 0x2, 0x4, 0x8] as const;
/** The gold item (Gold001). */
const GOLD = 0xf;
/** MGEF DATA flags: hostile. */
const EFFECT_HOSTILE = 0x1;

export function registerForms(n: Register, runtime: ScriptRuntime): void {
  const { state, world, forms } = runtime;
  const self = (call: NativeCall): number | undefined =>
    call.self && call.self.alias < 0 ? call.self.formId : undefined;
  const ref = (value: Value | undefined): number | undefined => runtime.reference(value ?? null);
  const on = (
    name: string,
    run: (formId: number, call: NativeCall) => void | Promise<void>,
  ): void => {
    n(name, async (call) => {
      const formId = self(call);
      if (formId !== undefined) await run(formId, call);
      return null;
    });
  };
  const ask = <T extends Value>(
    name: string,
    fallback: T,
    run: (formId: number, call: NativeCall) => T | Promise<T>,
  ): void => {
    n(name, async (call) => {
      const formId = self(call);
      return formId === undefined ? fallback : run(formId, call);
    });
  };

  // --- Faction --------------------------------------------------------------------------------
  // SetEnemy / SetAlly set both factions' combat reactions (Creation Kit: Faction script).
  const react = (faction: number, other: number, reaction: number): void => {
    state.faction(faction).reactions.set(other, reaction);
  };
  on('faction.setenemy', (faction, call) => {
    const other = formOf(call.args[0]);
    if (other === undefined) return;
    // Enemies, or neutral where asked (0 neutral, 1 enemy).
    react(faction, other, bool(call.args[1]) ? 0 : 1);
    react(other, faction, bool(call.args[2]) ? 0 : 1);
  });
  on('faction.setally', (faction, call) => {
    const other = formOf(call.args[0]);
    if (other === undefined) return;
    // Allies, or friends where asked (2 ally, 3 friend).
    react(faction, other, bool(call.args[1]) ? 3 : 2);
    react(other, faction, bool(call.args[2]) ? 3 : 2);
  });
  ask('faction.getreaction', 0, async (faction, call) => {
    const other = formOf(call.args[0]);
    if (other === undefined) return 0;
    const set = state.factions.get(faction)?.reactionModifiers.get(other);
    if (set !== undefined) return set;
    return (
      (await runtime.actors.faction(faction))?.reactions.find(
        (reaction) => reaction.faction === other,
      )?.modifier ?? 0
    );
  });
  on('faction.setreaction', (faction, call) => {
    const other = formOf(call.args[0]);
    if (other !== undefined) state.faction(faction).reactionModifiers.set(other, int(call.args[1]));
  });
  on('faction.modreaction', async (faction, call) => {
    const other = formOf(call.args[0]);
    if (other === undefined) return;
    const current =
      state.factions.get(faction)?.reactionModifiers.get(other) ??
      (await runtime.actors.faction(faction))?.reactions.find(
        (reaction) => reaction.faction === other,
      )?.modifier ??
      0;
    state.faction(faction).reactionModifiers.set(other, current + int(call.args[1]));
  });
  ask('faction.getcrimegold', 0, (faction) => {
    const entry = state.factions.get(faction);
    return entry ? entry.crimeGold + entry.crimeGoldViolent : 0;
  });
  ask(
    'faction.getcrimegoldnonviolent',
    0,
    (faction) => state.factions.get(faction)?.crimeGold ?? 0,
  );
  ask(
    'faction.getcrimegoldviolent',
    0,
    (faction) => state.factions.get(faction)?.crimeGoldViolent ?? 0,
  );
  // Crime gold set or changed by scripts counts as crime gold earned (the stats, infamy).
  on('faction.setcrimegold', (faction, call) => {
    const entry = state.faction(faction);
    runtime.crime.addBounty(faction, Math.max(0, int(call.args[0])) - entry.crimeGold, false);
  });
  on('faction.setcrimegoldviolent', (faction, call) => {
    const entry = state.faction(faction);
    runtime.crime.addBounty(faction, Math.max(0, int(call.args[0])) - entry.crimeGoldViolent, true);
  });
  on('faction.modcrimegold', (faction, call) => {
    runtime.crime.addBounty(faction, int(call.args[0]), bool(call.args[1]));
  });
  ask('faction.canpaycrimegold', false, async (faction) => {
    const entry = state.factions.get(faction);
    const owed = entry ? entry.crimeGold + entry.crimeGoldViolent : 0;
    return (await runtime.itemCount(PLAYER_REF, GOLD)) >= owed;
  });
  // PlayerPayCrimeGold(abRemoveStolenItems = true, abGoToJail = true).
  on('faction.playerpaycrimegold', (faction, call) =>
    runtime.crime.payFine(faction, bool(call.args[0], true), bool(call.args[1], true)),
  );
  // SendPlayerToJail(abRemoveInventory = true, abRealJail = true).
  on('faction.sendplayertojail', (faction, call) =>
    runtime.crime.jail(faction, bool(call.args[0], true), bool(call.args[1], true)),
  );
  // SendAssaultAlarm: the faction's members near the player are alarmed against them.
  on('faction.sendassaultalarm', async (faction) => {
    for (const actor of world.loadedReferences?.() ?? []) {
      if ((await runtime.actors.factionRank(actor, faction)) >= 0)
        world.alarm?.(actor, PLAYER_REF, 'attack');
    }
  });
  ask('faction.getinfamy', 0, (faction) => {
    const entry = state.factions.get(faction);
    return (entry?.infamy ?? 0) + (entry?.infamyViolent ?? 0);
  });
  ask('faction.getinfamyviolent', 0, (faction) => state.factions.get(faction)?.infamyViolent ?? 0);
  ask('faction.getinfamynonviolent', 0, (faction) => state.factions.get(faction)?.infamy ?? 0);
  // The value of the stolen items the player carries from the faction, seen being stolen or not.
  ask('faction.getstolenitemvaluecrime', 0, (faction) =>
    runtime.crime.stolenValue(PLAYER_REF, faction, true),
  );
  ask('faction.getstolenitemvaluenocrime', 0, (faction) =>
    runtime.crime.stolenValue(PLAYER_REF, faction, false),
  );
  // IsFactionInCrimeGroup(akOther): the other is in this faction's shared crime factions.
  ask('faction.isfactionincrimegroup', false, async (faction, call) => {
    const other = formOf(call.args[0]);
    return other !== undefined && (await runtime.crime.crimeGroup(faction)).includes(other);
  });
  // SetPlayerEnemy: its members are hostile to the player (crime-engine.ts reaction).
  on('faction.setplayerenemy', (faction, call) => {
    state.faction(faction).playerEnemy = bool(call.args[0], true);
  });
  on('faction.setplayerexpelled', (faction, call) => {
    state.faction(faction).playerExpelled = bool(call.args[0], true);
  });
  ask(
    'faction.isplayerexpelled',
    false,
    (faction) => state.factions.get(faction)?.playerExpelled ?? false,
  );

  // --- Cell -----------------------------------------------------------------------------------
  on('cell.setactorowner', (cell, call) => {
    const entry = state.cell(cell);
    entry.ownerActor = formOf(call.args[0]) ?? 0;
    entry.ownerFaction = 0;
  });
  on('cell.setfactionowner', (cell, call) => {
    const entry = state.cell(cell);
    entry.ownerFaction = formOf(call.args[0]) ?? 0;
    entry.ownerActor = 0;
  });
  ask('cell.getactorowner', null, async (cell) =>
    object((await runtime.cellOwner(cell)).actor, 'actorbase'),
  );
  ask('cell.getfactionowner', null, async (cell) =>
    object((await runtime.cellOwner(cell)).faction, 'faction'),
  );
  on('cell.setpublic', (cell, call) => {
    state.cell(cell).public = bool(call.args[0], true);
  });
  ask('cell.isinterior', false, async (cell) => {
    const data = (await forms.record(cell))?.fields.first('DATA');
    return data !== undefined && ((data[0] ?? 0) & 0x1) !== 0;
  });
  ask('cell.isattached', false, (cell) => world.cellAttached?.(cell) ?? false);
  on('cell.reset', (cell) => world.resetCell?.(cell));
  on('cell.setfogplanes', (cell, call) =>
    world.fog?.(cell, { near: num(call.args[0]), far: num(call.args[1]) }),
  );
  on('cell.setfogpower', (cell, call) => world.fog?.(cell, { power: num(call.args[0]) }));
  on('cell.setfogcolor', (cell, call) => {
    const a = call.args.map((value) => int(value));
    world.fog?.(cell, {
      nearColor: [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0],
      farColor: [a[3] ?? 0, a[4] ?? 0, a[5] ?? 0],
    });
  });

  // --- Location -------------------------------------------------------------------------------
  ask('location.getkeyworddata', 0, (location, call) => {
    const keyword = formOf(call.args[0]);
    return keyword === undefined
      ? 0
      : (state.locations.get(location)?.keywordData.get(keyword) ?? 0);
  });
  on('location.setkeyworddata', (location, call) => {
    const keyword = formOf(call.args[0]);
    if (keyword !== undefined) state.location(location).keywordData.set(keyword, num(call.args[1]));
  });
  ask('location.ischild', false, async (location, call) => {
    const other = formOf(call.args[0]);
    return (
      other !== undefined && other !== location && (await runtime.locationWithin(location, other))
    );
  });
  ask('location.hascommonparent', false, async (location, call) => {
    const other = formOf(call.args[0]);
    const filter = formOf(call.args[1]);
    if (other === undefined) return false;
    const mine = await runtime.locationParents(location);
    for (const parent of await runtime.locationParents(other)) {
      if (!mine.includes(parent)) continue;
      if (filter === undefined || (await runtime.location(parent))?.keywords.includes(filter))
        return true;
    }
    return false;
  });
  const refTypeCount = async (
    location: number,
    call: NativeCall,
    dead: boolean,
  ): Promise<number> => {
    const type = formOf(call.args[0]);
    const references = (await runtime.location(location))?.references ?? [];
    let count = 0;
    for (const entry of references) {
      if (entry.type !== type) continue;
      if ((await runtime.actors.isDead(entry.reference)) === dead) count++;
    }
    return count;
  };
  ask('location.getreftypealivecount', 0, (location, call) => refTypeCount(location, call, false));
  ask('location.getreftypedeadcount', 0, (location, call) => refTypeCount(location, call, true));
  ask('location.hasreftype', false, async (location, call) => {
    const type = formOf(call.args[0]);
    return ((await runtime.location(location))?.references ?? []).some(
      (entry) => entry.type === type,
    );
  });
  on('location.setcleared', (location, call) => {
    state.location(location).cleared = bool(call.args[0], true);
  });
  ask('location.iscleared', false, (location) => state.locations.get(location)?.cleared ?? false);
  ask('location.isloaded', false, (location) => world.locationLoaded?.(location) ?? false);

  // --- Weather (the sky system, M4) ----------------------------------------------------------
  on('weather.setactive', (weather, call) =>
    world.setWeather?.(weather, false, bool(call.args[0]), bool(call.args[1])),
  );
  on('weather.forceactive', (weather, call) =>
    world.setWeather?.(weather, true, bool(call.args[0]), false),
  );
  n('weather.releaseoverride', () => {
    world.releaseWeatherOverride?.();
    return null;
  });
  n('weather.getcurrentweather', () => object(world.currentWeather?.(), 'weather'));
  n('weather.getoutgoingweather', () => object(world.outgoingWeather?.(), 'weather'));
  n('weather.getcurrentweathertransition', () => world.weatherTransition?.() ?? 1);
  n('weather.getskymode', () => world.skyMode?.() ?? 3);
  n('weather.findweather', ({ args }) => object(world.findWeather?.(int(args[0])), 'weather'));
  // 0 pleasant, 1 cloudy, 2 rainy, 3 snow; −1 none.
  ask('weather.getclassification', -1, async (weather) => {
    const data = (await forms.record(weather))?.fields.first('DATA');
    const flags = data && data.length >= 12 ? (data[11] ?? 0) : 0;
    return WEATHER_CLASSES.findIndex((bit) => (flags & bit) !== 0);
  });

  // --- Leveled lists scripts add to -----------------------------------------------------------
  for (const kind of ['leveledactor', 'leveleditem', 'leveledspell']) {
    on(`${kind}.addform`, (list, call) => {
      const form = formOf(call.args[0]);
      if (form === undefined) return;
      const entries = state.leveledAdditions.get(list) ?? [];
      entries.push({
        formId: form,
        level: int(call.args[1], 1),
        count: Math.max(1, int(call.args[2], 1)),
      });
      state.leveledAdditions.set(list, entries);
    });
    on(`${kind}.revert`, (list) => {
      state.leveledAdditions.delete(list);
    });
  }

  // --- Magic items ----------------------------------------------------------------------------
  const hostile = async (formId: number): Promise<boolean> => {
    const record = await forms.record(formId);
    for (const efid of record?.fields.all('EFID') ?? []) {
      if (!record || efid.length < 4) continue;
      const data = (await forms.record(record.formIdAt(efid)))?.fields.first('DATA');
      if (data && data.length >= 4 && (view(data).getUint32(0, true) & EFFECT_HOSTILE) !== 0)
        return true;
    }
    return false;
  };
  for (const kind of ['spell', 'potion', 'enchantment', 'ingredient'])
    ask(`${kind}.ishostile`, false, (formId) => hostile(formId));
  // Cast(akSource, akTarget), RemoteCast(akSource, akBlameActor, akTarget): applied at once
  // (the magic system; TODO(M10) 5.3: the projectile's flight).
  for (const kind of ['spell', 'scroll']) {
    on(`${kind}.cast`, async (spell, call) => {
      const source = ref(call.args[0]);
      if (source !== undefined) await runtime.magic.cast(spell, source, ref(call.args[1]));
    });
  }
  on('spell.remotecast', async (spell, call) => {
    const source = ref(call.args[0]);
    if (source !== undefined)
      await runtime.magic.cast(spell, source, ref(call.args[2]), ref(call.args[1]));
  });
  on('spell.preload', () => undefined);
  on('spell.unload', () => undefined);
  on('weapon.fire', (weapon, call) => {
    const source = ref(call.args[0]);
    if (source !== undefined) world.fireWeapon?.(weapon, source, formOf(call.args[1]));
  });
  // The effects the player knows of an ingredient (GameState.ingredientEffects: the alchemy
  // and inventory menus show them).
  const learn = (ingredient: number, slots: readonly number[]): void => {
    const known = new Set(state.ingredientEffects.get(ingredient) ?? []);
    for (const slot of slots) known.add(slot);
    state.ingredientEffects.set(ingredient, known);
  };
  const effectCount = async (ingredient: number): Promise<number> =>
    (await forms.record(ingredient))?.fields.all('EFID').length ?? 0;
  on('ingredient.learneffect', async (ingredient, call) => {
    const slot = int(call.args[0]);
    if (slot >= 0 && slot < (await effectCount(ingredient))) learn(ingredient, [slot]);
  });
  // The first effect not known yet, learned: its index (−1 when all are known).
  ask('ingredient.learnnexteffect', -1, async (ingredient) => {
    const known = state.ingredientEffects.get(ingredient);
    const count = await effectCount(ingredient);
    for (let slot = 0; slot < count; slot++) {
      if (known?.has(slot)) continue;
      learn(ingredient, [slot]);
      return slot;
    }
    return -1;
  });
  on('ingredient.learnalleffects', async (ingredient) => {
    learn(
      ingredient,
      Array.from({ length: await effectCount(ingredient) }, (_, slot) => slot),
    );
  });
  ask('magiceffect.getassociatedskill', '', async (effect) => {
    const data = (await forms.record(effect))?.fields.first('DATA');
    // DATA: flags u32, base cost f32, related form, magic skill (actor value index, −1 none).
    const skill = data && data.length >= 16 ? view(data).getInt32(12, true) : -1;
    return skill < 0 ? '' : actorValueName(skill);
  });
  // TODO(M11): warmth (Survival Mode) from armor and lights.
  ask('armor.getwarmthrating', 0, () => 0);
  ask('light.getwarmthrating', 0, () => 0);

  // --- What the engine plays --------------------------------------------------------------
  ask('sound.play', 0, (sound, call) => {
    const source = ref(call.args[0]);
    return source === undefined ? 0 : (world.playSound?.(sound, source) ?? 0);
  });
  n('sound.playandwait', async (call) => {
    const sound = self(call);
    const source = ref(call.args[0]);
    if (sound === undefined || source === undefined) return false;
    await call.latent(world.playSoundAndWait?.(sound, source) ?? Promise.resolve());
    return true;
  });
  n('sound.stopinstance', ({ args }) => {
    world.stopSound?.(int(args[0]));
    return null;
  });
  n('sound.setinstancevolume', ({ args }) => {
    world.soundVolume?.(int(args[0]), num(args[1]));
    return null;
  });
  for (const action of ['mute', 'unmute', 'pause', 'unpause'] as const) {
    on(`soundcategory.${action}`, (category) => world.soundCategory?.(category, action, 0));
  }
  on('soundcategory.setvolume', (category, call) =>
    world.soundCategory?.(category, 'volume', num(call.args[0])),
  );
  on('soundcategory.setfrequency', (category, call) =>
    world.soundCategory?.(category, 'frequency', num(call.args[0])),
  );
  on('musictype.add', (music) => world.music?.(music, true));
  on('musictype.remove', (music) => world.music?.(music, false));
  on('imagespacemodifier.apply', (imod, call) =>
    world.imageSpace?.(imod, 'apply', num(call.args[0], 1)),
  );
  on('imagespacemodifier.remove', (imod) => world.imageSpace?.(imod, 'remove', 0));
  on('imagespacemodifier.applycrossfade', (imod, call) =>
    world.imageSpace?.(imod, 'crossfade', num(call.args[0], 1)),
  );
  // RemoveCrossFade is global: it fades out the cross-fade chain's last modifier, whichever.
  n('imagespacemodifier.removecrossfade', (call) => {
    world.imageSpace?.(0, 'removeCrossfade', num(call.args[0], 1));
    return null;
  });
  on('imagespacemodifier.popto', (imod, call) =>
    world.imageSpace?.(imod, 'popTo', num(call.args[1], 1), formOf(call.args[0])),
  );
  on('effectshader.play', (shader, call) => {
    const target = ref(call.args[0]);
    if (target !== undefined) world.effectShader?.(shader, target, true, num(call.args[1], -1));
  });
  on('effectshader.stop', (shader, call) => {
    const target = ref(call.args[0]);
    if (target !== undefined) world.effectShader?.(shader, target, false, 0);
  });
  on('visualeffect.play', (effect, call) => {
    const target = ref(call.args[0]);
    if (target !== undefined)
      world.visualEffect?.(effect, target, true, num(call.args[1], -1), ref(call.args[2]));
  });
  on('visualeffect.stop', (effect, call) => {
    const target = ref(call.args[0]);
    if (target !== undefined) world.visualEffect?.(effect, target, false, 0, undefined);
  });
  on('shaderparticlegeometry.apply', (spgd, call) =>
    world.particleGeometry?.(spgd, true, num(call.args[0])),
  );
  on('shaderparticlegeometry.remove', (spgd, call) =>
    world.particleGeometry?.(spgd, false, num(call.args[0])),
  );
}
