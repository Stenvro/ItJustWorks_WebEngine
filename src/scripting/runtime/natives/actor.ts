// Natives of Actor and ActorBase (signatures: the game's Actor.pex and ActorBase.pex). What an
// actor is and has (actor values, factions, relationships, spells, perks, level, race, being
// dead, essential, a ghost, a teammate) is kept in the game state; what it does (packages,
// combat, idles, equipment shown, look-at) goes to the engine through the WorldBridge.
// Platform-independent. Notes: docs/scripting.md ("Actors").

import { NpcFlag } from '../../../world/actor-records.ts';
import { ActorValue } from '../../../world/actor-values.ts';
import type { NativeCall } from '../../papyrus-vm.ts';
import type { Value } from '../../values.ts';
import { PLAYER_REF } from '../forms.ts';
import type { ScriptRuntime } from '../runtime.ts';
import { bool, formOf, int, num, object, str, type Register } from './args.ts';

/** The gold item (Gold001), counted by GetGoldAmount. */
const GOLD = 0xf;

export function registerActor(n: Register, runtime: ScriptRuntime): void {
  const { state, actors, world } = runtime;
  const self = (call: NativeCall): number | undefined => runtime.reference(call.self);
  const ref = (value: Value | undefined): number | undefined => runtime.reference(value ?? null);
  /** A native on an actor that does something (returns None). */
  const act = (
    name: string,
    run: (actor: number, call: NativeCall) => void | Promise<void>,
  ): void => {
    n(`actor.${name}`, async (call) => {
      const actor = self(call);
      if (actor !== undefined) await run(actor, call);
      return null;
    });
  };
  /** A native on an actor that answers. */
  const ask = <T extends Value>(
    name: string,
    fallback: T,
    run: (actor: number, call: NativeCall) => T | Promise<T>,
  ): void => {
    n(`actor.${name}`, async (call) => {
      const actor = self(call);
      return actor === undefined ? fallback : run(actor, call);
    });
  };
  const flag = (
    name: string,
    key:
      | 'ghost'
      | 'restrained'
      | 'doingFavor'
      | 'alerted'
      | 'unconscious'
      | 'bribed'
      | 'intimidated'
      | 'dontMove'
      | 'noBleedoutRecovery',
  ): void => {
    act(name, (actor, call) => {
      state.actor(actor)[key] = bool(call.args[0], true);
    });
  };

  // --- Actor values ---------------------------------------------------------------------------
  const valueOf = async (
    actor: number,
    call: NativeCall,
    pick: 'base' | 'max' | 'current',
  ): Promise<number> => {
    const index = actors.actorValue(str(call.args[0]));
    return index === undefined ? 0 : (await actors.value(actor, index))[pick];
  };
  ask('getactorvalue', 0, (actor, call) => valueOf(actor, call, 'current'));
  ask('getav', 0, (actor, call) => valueOf(actor, call, 'current'));
  ask('getbaseactorvalue', 0, (actor, call) => valueOf(actor, call, 'base'));
  ask('getbaseav', 0, (actor, call) => valueOf(actor, call, 'base'));
  ask('getactorvaluemax', 0, (actor, call) => valueOf(actor, call, 'max'));
  ask('getactorvaluepercentage', 0, async (actor, call) => {
    const index = actors.actorValue(str(call.args[0]));
    if (index === undefined) return 0;
    const value = await actors.value(actor, index);
    return value.max > 0 ? value.current / value.max : 1;
  });
  const change = (
    name: string,
    run: (actor: number, index: number, amount: number) => void | Promise<void>,
  ): void => {
    act(name, async (actor, call) => {
      const index = actors.actorValue(str(call.args[0]));
      if (index !== undefined) await run(actor, index, num(call.args[1]));
    });
  };
  change('setactorvalue', (actor, index, value) => {
    actors.setBase(actor, index, value);
  });
  change('setav', (actor, index, value) => {
    actors.setBase(actor, index, value);
  });
  change('modactorvalue', (actor, index, amount) => {
    actors.modify(actor, index, amount);
  });
  change('modav', (actor, index, amount) => {
    actors.modify(actor, index, amount);
  });
  change('damageactorvalue', (actor, index, amount) => actors.damage(actor, index, amount));
  change('damageav', (actor, index, amount) => actors.damage(actor, index, amount));
  change('restoreactorvalue', (actor, index, amount) => {
    actors.restore(actor, index, amount);
  });
  change('restoreav', (actor, index, amount) => {
    actors.restore(actor, index, amount);
  });
  change('forceactorvalue', (actor, index, value) => actors.force(actor, index, value));
  change('forceav', (actor, index, value) => actors.force(actor, index, value));
  act('resethealthandlimbs', (actor) => {
    actors.restore(actor, ActorValue.health, Number.POSITIVE_INFINITY);
  });

  // --- Level, race, sex ---------------------------------------------------------------------
  ask('getlevel', 1, (actor) => actors.level(actor));
  ask('getrace', null, async (actor) => object(await actors.raceOf(actor), 'race'));
  act('setrace', (actor, call) => {
    // The actor's own race (its base keeps its own); its 3D is made again in it (the player's
    // with the face chosen in the race menu: a werewolf and back keeps it).
    state.actor(actor).race = formOf(call.args[0]);
    world.raceChanged?.(actor);
  });
  ask('getleveledactorbase', null, async (actor) =>
    object((await actors.info(actor))?.leveled, 'actorbase'),
  );
  ask('ischild', false, (actor) => actors.isChild(actor));

  // --- Factions -------------------------------------------------------------------------------
  ask('getfactionrank', -2, async (actor, call) => {
    const faction = formOf(call.args[0]);
    return faction === undefined ? -2 : actors.factionRank(actor, faction);
  });
  ask('isinfaction', false, async (actor, call) => {
    const faction = formOf(call.args[0]);
    return faction !== undefined && (await actors.factionRank(actor, faction)) >= 0;
  });
  act('setfactionrank', (actor, call) => {
    const faction = formOf(call.args[0]);
    if (faction !== undefined) actors.setFactionRank(actor, faction, int(call.args[1]));
  });
  act('modfactionrank', async (actor, call) => {
    const faction = formOf(call.args[0]);
    if (faction === undefined) return;
    // Only a member's rank changes.
    const rank = await actors.factionRank(actor, faction);
    if (rank >= 0) actors.setFactionRank(actor, faction, Math.max(0, rank + int(call.args[1])));
  });
  act('removefromfaction', (actor, call) => {
    const faction = formOf(call.args[0]);
    if (faction !== undefined) actors.setFactionRank(actor, faction, -2);
  });
  act('removefromallfactions', (actor) => actors.removeFromAllFactions(actor));
  ask('getcrimefaction', null, async (actor) =>
    object(await actors.crimeFaction(actor), 'faction'),
  );
  act('setcrimefaction', (actor, call) => {
    state.actor(actor).crimeFaction = formOf(call.args[0]) ?? null;
  });
  ask('getfactionreaction', 0, async (actor, call) => {
    const other = ref(call.args[0]);
    if (other === undefined) return 0;
    // The friendliest reaction between any of their factions (0 neutral .. 3 friend; 1 enemy).
    let reaction: number | undefined;
    const theirs = await actors.factionsOf(other);
    for (const [faction, rank] of await actors.factionsOf(actor)) {
      if (rank < 0) continue;
      for (const [otherFaction, otherRank] of theirs) {
        if (otherRank < 0) continue;
        const value = await actors.factionReaction(faction, otherFaction);
        if (value !== undefined && (reaction === undefined || value === 1 || value > reaction))
          reaction = value;
      }
    }
    return reaction ?? 0;
  });

  // --- Relationships ----------------------------------------------------------------------
  ask('getrelationshiprank', 0, async (actor, call) => {
    const other = ref(call.args[0]);
    return other === undefined ? 0 : actors.relationshipRank(actor, other);
  });
  act('setrelationshiprank', async (actor, call) => {
    const other = ref(call.args[0]);
    if (other !== undefined) await actors.setRelationshipRank(actor, other, int(call.args[1]));
  });
  ask('gethighestrelationshiprank', 0, (actor) => actors.extremeRelationshipRank(actor, true));
  ask('getlowestrelationshiprank', 0, (actor) => actors.extremeRelationshipRank(actor, false));
  // TODO(M11): association types (ASTP) of relationships: family, parent, spouse, ...
  ask('hasassociation', false, () => false);
  ask('hasfamilyrelationship', false, () => false);
  ask('hasparentrelationship', false, () => false);

  // --- Spells, shouts, perks ------------------------------------------------------------------
  ask('addspell', false, async (actor, call) => {
    const spell = formOf(call.args[0]);
    if (spell === undefined) return false;
    const added = await actors.addSpell(actor, spell);
    // abVerbose (true unless given): the player's new spell is announced.
    if (added && actor === PLAYER_REF && bool(call.args[1], true)) {
      runtime.detach(runtime.spellMessage(spell));
    }
    return added;
  });
  ask('removespell', false, (actor, call) => {
    const spell = formOf(call.args[0]);
    return spell === undefined ? false : actors.removeSpell(actor, spell);
  });
  ask('hasspell', false, (actor, call) => {
    const spell = formOf(call.args[0]);
    return spell === undefined ? false : actors.hasSpell(actor, spell);
  });
  ask('addshout', false, (actor, call) => {
    const shout = formOf(call.args[0]);
    return shout === undefined ? false : actors.addSpell(actor, shout);
  });
  ask('removeshout', false, (actor, call) => {
    const shout = formOf(call.args[0]);
    return shout === undefined ? false : actors.removeSpell(actor, shout);
  });
  act('addperk', (actor, call) => {
    const perk = formOf(call.args[0]);
    if (perk !== undefined) actors.setPerk(actor, perk, true);
  });
  act('removeperk', (actor, call) => {
    const perk = formOf(call.args[0]);
    if (perk !== undefined) actors.setPerk(actor, perk, false);
  });
  ask('hasperk', false, (actor, call) => {
    const perk = formOf(call.args[0]);
    return perk === undefined ? false : actors.hasPerk(actor, perk);
  });
  // Active magic (TODO(M11): the magic system casts, applies and dispels effects).
  ask('dispelspell', false, () => false);
  act('dispelallspells', () => undefined);
  ask('hasmagiceffect', false, () => false);
  ask('hasmagiceffectwithkeyword', false, () => false);
  act('docombatspellapply', (actor, call) => {
    const spell = formOf(call.args[0]);
    if (spell !== undefined) world.castSpell?.(spell, actor, ref(call.args[1]));
  });
  ask('getequippedspell', null, () => null);
  act('equipspell', (actor, call) => {
    const spell = formOf(call.args[0]);
    if (spell !== undefined) state.actor(actor).equipped.add(spell);
  });
  act('unequipspell', (actor, call) => {
    const spell = formOf(call.args[0]);
    if (spell !== undefined) state.actor(actor).equipped.delete(spell);
  });
  ask('getequippedshout', null, () => null);
  act('equipshout', (actor, call) => {
    const shout = formOf(call.args[0]);
    if (shout !== undefined) state.actor(actor).equipped.add(shout);
  });
  act('unequipshout', (actor, call) => {
    const shout = formOf(call.args[0]);
    if (shout !== undefined) state.actor(actor).equipped.delete(shout);
  });
  act('setvoicerecoverytime', (actor, call) => {
    state.actor(actor).voiceRecoveryTime = num(call.args[0]);
  });
  ask('getvoicerecoverytime', 0, (actor) => state.actors.get(actor)?.voiceRecoveryTime ?? 0);
  ask('trapsoul', false, () => false);

  // --- Equipment (TODO(M11): the equip system, slots and what is shown) ---------------------
  act('equipitem', async (actor, call) => {
    const item = formOf(call.args[0]);
    if (item === undefined) return;
    // Equipping an item the actor does not have gives it one (Creation Kit: EquipItem).
    if ((await runtime.itemCount(actor, item)) === 0)
      await runtime.addItem(actor, call.args[0] ?? null, 1, true);
    state.actor(actor).equipped.add(item);
    world.equipmentChanged?.(actor);
  });
  act('unequipitem', (actor, call) => {
    const item = formOf(call.args[0]);
    if (item !== undefined && state.actor(actor).equipped.delete(item))
      world.equipmentChanged?.(actor);
  });
  act('unequipall', (actor) => {
    state.actor(actor).equipped.clear();
    world.equipmentChanged?.(actor);
  });
  act('unequipitemslot', () => undefined);
  ask('isequipped', false, (actor, call) => {
    const item = formOf(call.args[0]);
    return item !== undefined && (state.actors.get(actor)?.equipped.has(item) ?? false);
  });
  // What it wears: what scripts equipped and its outfit's armor (TODO(M11): the equip system).
  ask('wornhaskeyword', false, async (actor, call) => {
    const keyword = formOf(call.args[0]);
    if (keyword === undefined) return false;
    for (const item of await runtime.actors.worn(actor)) {
      if (await runtime.hasKeyword(item, keyword)) return true;
    }
    return false;
  });
  ask('getequippedweapon', null, () => null);
  ask('getequippedshield', null, () => null);
  ask('getequippedarmorinslot', null, () => null);
  ask('getequippeditemtype', 0, () => 0);
  act('setoutfit', (actor, call) => {
    const outfit = formOf(call.args[0]);
    if (bool(call.args[1])) state.actor(actor).sleepOutfit = outfit;
    else state.actor(actor).outfit = outfit;
    world.equipmentChanged?.(actor);
  });
  ask('getgoldamount', 0, (actor) => runtime.itemCount(actor, GOLD));
  ask('getwarmthrating', 0, () => 0);
  ask('isoverencumbered', false, () => false);

  // --- Life and death ---------------------------------------------------------------------
  ask('isdead', false, (actor) => actors.isDead(actor));
  act('kill', (actor, call) => actors.kill(actor, ref(call.args[0])));
  act('killsilent', (actor, call) => actors.kill(actor, ref(call.args[0]), true));
  act('resurrect', (actor) => actors.resurrect(actor));
  ask('getkiller', null, (actor) => runtime.actorHandleOrNone(state.actors.get(actor)?.killer));
  // Deferred kills (the actor dies when the deferral ends, if it should have): TODO(M11).
  act('startdeferredkill', () => undefined);
  act('enddeferredkill', () => undefined);
  ask('isessential', false, (actor) => actors.isEssential(actor));
  ask('isghost', false, (actor) => actors.isGhost(actor));
  flag('setghost', 'ghost');
  ask('isbleedingout', false, () => false);
  flag('setnobleedoutrecovery', 'noBleedoutRecovery');
  ask(
    'getnobleedoutrecovery',
    false,
    (actor) => state.actors.get(actor)?.noBleedoutRecovery ?? false,
  );
  act('allowbleedoutdialogue', () => undefined);
  ask('isunconscious', false, (actor) => state.actors.get(actor)?.unconscious ?? false);
  flag('setunconscious', 'unconscious');
  act('setcriticalstage', (actor, call) => world.criticalStage?.(actor, int(call.args[0])));
  act('attachashpile', (actor, call) => world.ashPile?.(actor, formOf(call.args[0])));

  // --- Standing with the player -------------------------------------------------------------
  ask('isplayerteammate', false, (actor) => state.actors.get(actor)?.playerTeammate ?? false);
  act('setplayerteammate', (actor, call) => {
    const entry = state.actor(actor);
    entry.playerTeammate = bool(call.args[0], true);
    entry.canDoFavor = bool(call.args[1], true);
  });
  ask('isdoingfavor', false, (actor) => state.actors.get(actor)?.doingFavor ?? false);
  flag('setdoingfavor', 'doingFavor');
  ask('iscommandedactor', false, () => false);
  ask('isbribed', false, (actor) => state.actors.get(actor)?.bribed ?? false);
  flag('setbribed', 'bribed');
  ask('isintimidated', false, (actor) => state.actors.get(actor)?.intimidated ?? false);
  flag('setintimidated', 'intimidated');
  ask('willintimidatesucceed', false, () => false);
  ask('getbribeamount', 0, () => 0);
  flag('setrestrained', 'restrained');
  flag('setdontmove', 'dontMove');
  ask('isalerted', false, (actor) => state.actors.get(actor)?.alerted ?? false);
  flag('setalert', 'alerted');
  ask('isalarmed', false, () => false);
  ask('isplayerslastriddenhorse', false, (actor) => runtime.lastHorse === actor);
  ask('getplayercontrols', false, (actor) => actor === PLAYER_REF);
  act('setplayercontrols', () => undefined);
  act('enableai', (actor, call) => {
    state.actor(actor).aiEnabled = bool(call.args[0], true);
    world.aiEnabled?.(actor, bool(call.args[0], true));
  });
  act('setvehicle', (actor, call) => {
    state.actor(actor).vehicle = ref(call.args[0]);
  });
  act('setforcedlandingmarker', (actor, call) => {
    state.actor(actor).forcedLandingMarker = ref(call.args[0]);
  });
  ask('getforcedlandingmarker', null, (actor) =>
    runtime.referenceHandleOrNone(state.actors.get(actor)?.forcedLandingMarker),
  );

  // --- AI, combat, detection (TODO(M10): packages, combat and detection run) ------------------
  act('evaluatepackage', (actor) => world.evaluatePackage?.(actor));
  ask('getcurrentpackage', null, (actor) => object(world.currentPackage?.(actor), 'package'));
  act('movetopackagelocation', (actor) => world.moveToPackageLocation?.(actor));
  ask('pathtoreference', false, () => false);
  act('startcombat', (actor, call) => {
    const target = ref(call.args[0]);
    if (target !== undefined) world.startCombat?.(actor, target);
  });
  act('stopcombat', (actor) => world.stopCombat?.(actor));
  act('stopcombatalarm', (actor) => world.stopCombat?.(actor));
  ask('isincombat', false, () => false);
  ask('getcombatstate', 0, () => 0);
  ask('getcombattarget', null, () => null);
  ask('isdetectedby', false, () => false);
  ask('haslos', false, () => false);
  ask('ishostiletoactor', false, () => false);
  ask('isguard', false, () => false);
  ask('istrespassing', false, () => false);
  ask('isarrested', false, () => false);
  ask('isarrestingtarget', false, () => false);
  act('cleararrested', () => undefined);
  act('setplayerresistingarrest', () => undefined);
  act('sendassaultalarm', () => undefined);
  act('sendtrespassalarm', () => undefined);
  act('setattackactoronsight', () => undefined);
  act('setnotshowonstealthmeter', () => undefined);
  act('allowpcdialogue', () => undefined);
  ask('getdialoguetarget', null, () => null);
  act('keepoffsetfromactor', () => undefined);
  act('clearkeepoffsetfromactor', () => undefined);
  for (const name of [
    'forcemovementdirection',
    'forcemovementdirectionramp',
    'forcemovementrotationspeed',
    'forcemovementrotationspeedramp',
    'forcemovementspeed',
    'forcemovementspeedramp',
    'forcetargetangle',
    'forcetargetdirection',
    'forcetargetspeed',
    'clearforcedmovement',
  ]) {
    act(name, () => undefined);
  }
  ask('isrunning', false, (actor) => world.motion?.(actor)?.running ?? false);
  ask('issprinting', false, (actor) => world.motion?.(actor)?.sprinting ?? false);
  ask('issneaking', false, (actor) => world.motion?.(actor)?.sneaking ?? false);
  act('startsneaking', () => undefined);
  ask('isweapondrawn', false, () => false);
  act('drawweapon', () => undefined);
  // What it uses: 0 not, 2 wants to (on its way), 3 in it, 4 wants to leave.
  ask('getsitstate', 0, (actor) => {
    const using = world.interaction?.(actor);
    return using && using.animationType !== 2 ? using.state : 0;
  });
  ask('getsleepstate', 0, (actor) => {
    const using = world.interaction?.(actor);
    return using?.animationType === 2 ? using.state : 0;
  });
  ask('isinkillmove', false, () => false);
  ask('getlightlevel', 0, (actor) => world.lightLevel?.(actor) ?? 0);
  // Flying and riding.
  ask('isflying', false, () => false);
  ask('getflyingstate', 0, () => 0);
  ask('isallowedtofly', false, () => false);
  ask('canflyhere', false, () => false);
  act('setallowflying', () => undefined);
  act('setallowflyingex', () => undefined);
  ask('isonmount', false, () => false);
  ask('isbeingridden', false, () => false);
  ask('dismount', false, () => false);

  // --- Animation and look -------------------------------------------------------------------
  ask('playidle', false, (actor, call) => {
    const idle = formOf(call.args[0]);
    return idle !== undefined && (world.playIdle?.(actor, idle, undefined) ?? false);
  });
  ask('playidlewithtarget', false, (actor, call) => {
    const idle = formOf(call.args[0]);
    return idle !== undefined && (world.playIdle?.(actor, idle, ref(call.args[1])) ?? false);
  });
  act('playsubgraphanimation', (actor, call) => {
    world.animationEvent?.(actor, str(call.args[0]));
  });
  act('setsubgraphfloatvariable', (actor, call) => {
    world.setAnimationVariable?.(actor, str(call.args[0]), num(call.args[1]));
  });
  act('setalpha', (actor, call) => world.setAlpha?.(actor, num(call.args[0]), bool(call.args[1])));
  act('setheadtracking', () => undefined);
  act('setlookat', (actor, call) => world.lookAt?.(actor, ref(call.args[0])));
  act('clearlookat', (actor) => world.lookAt?.(actor, undefined));
  act('setexpressionoverride', (actor, call) =>
    world.expression?.(actor, int(call.args[0]), int(call.args[1])),
  );
  act('clearexpressionoverride', (actor) => world.expression?.(actor, undefined, 0));
  act('seteyetexture', () => undefined);
  act('clearextraarrows', () => undefined);

  // --- Menus ----------------------------------------------------------------------------------
  // TODO(M11): OpenInventory's abForceOpen (else only a follower's opens).
  act('openinventory', (actor) => void world.menu?.({ name: 'Container Menu', actor }));
  act('showbartermenu', (actor) => void world.menu?.({ name: 'Barter Menu', actor }));
  // Latent: the favor points once the menu closes.
  ask('showgiftmenu', 0, async (actor, call) => {
    const list = formOf(call.args[1]);
    return (
      (await world.menu?.({
        name: 'Gift Menu',
        actor,
        giving: bool(call.args[0]),
        filter: list,
        showStolen: bool(call.args[2]),
        useFavorPoints: bool(call.args[3], true),
      })) ?? 0
    );
  });

  // --- Lycanthropy and vampirism (their scripts listen for these) ----------------------------
  act('sendlycanthropystatechanged', () => undefined);
  act('sendvampirismstatechanged', () => undefined);
  act('startvampirefeed', () => undefined);
  act('startcannibal', () => undefined);
  act('unlockowneddoorsincell', () => undefined);

  // --- ActorBase ------------------------------------------------------------------------------
  const base = (call: NativeCall): number | undefined =>
    call.self && call.self.alias < 0 ? call.self.formId : undefined;
  const baseFlag = (name: string, key: 'essential' | 'protected' | 'invulnerable'): void => {
    n(`actorbase.set${name}`, (call) => {
      const formId = base(call);
      if (formId !== undefined) state.actorBase(formId)[key] = bool(call.args[0], true);
      return null;
    });
  };
  baseFlag('essential', 'essential');
  baseFlag('protected', 'protected');
  baseFlag('invulnerable', 'invulnerable');
  const baseStats = async (call: NativeCall) => {
    const formId = base(call);
    const record = formId === undefined ? undefined : await runtime.forms.record(formId);
    return record?.type === 'NPC_' ? runtime.actors.baseStats(record.formId) : undefined;
  };
  n('actorbase.isessential', async (call) => {
    const formId = base(call);
    const set = formId === undefined ? undefined : state.actorBases.get(formId)?.essential;
    return set ?? (((await baseStats(call))?.flags ?? 0) & NpcFlag.essential) !== 0;
  });
  n('actorbase.isprotected', async (call) => {
    const formId = base(call);
    const set = formId === undefined ? undefined : state.actorBases.get(formId)?.protected;
    return set ?? (((await baseStats(call))?.flags ?? 0) & NpcFlag.protected) !== 0;
  });
  n('actorbase.isinvulnerable', async (call) => {
    const formId = base(call);
    const set = formId === undefined ? undefined : state.actorBases.get(formId)?.invulnerable;
    return set ?? (((await baseStats(call))?.flags ?? 0) & NpcFlag.invulnerable) !== 0;
  });
  n(
    'actorbase.isunique',
    async (call) => (((await baseStats(call))?.flags ?? 0) & NpcFlag.unique) !== 0,
  );
  // The Player base's race and sex are the race menu's choice (GameState.playerAppearance).
  n('actorbase.getsex', async (call) => {
    const formId = base(call);
    return formId === undefined ? -1 : runtime.actors.baseSex(formId);
  });
  n('actorbase.getrace', async (call) => {
    const formId = base(call);
    return object(formId === undefined ? undefined : await runtime.actors.baseRace(formId), 'race');
  });
  n('actorbase.getclass', async (call) => object((await baseStats(call))?.class, 'class'));
  n('actorbase.getgiftfilter', async (call) =>
    object((await baseStats(call))?.giftFilter, 'formlist'),
  );
  n('actorbase.getdeadcount', (call) => {
    const formId = base(call);
    return formId === undefined ? 0 : runtime.deadCount(formId);
  });
  n('actorbase.setoutfit', (call) => {
    const formId = base(call);
    if (formId === undefined) return null;
    const outfit = formOf(call.args[0]);
    if (bool(call.args[1])) state.actorBase(formId).sleepOutfit = outfit;
    else state.actorBase(formId).outfit = outfit;
    return null;
  });
}
