// Natives of Actor and ActorBase (signatures: the game's Actor.pex and ActorBase.pex). What an
// actor is and has (actor values, factions, relationships, spells, perks, level, race, being
// dead, essential, a ghost, a teammate) is kept in the game state; what it does (packages,
// combat, idles, equipment shown, look-at) goes to the engine through the WorldBridge.
// Platform-independent. Notes: docs/scripting.md ("Actors").

import { hostileTo } from '../../../ai/combat-ai.ts';
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
      | 'noBleedoutRecovery'
      | 'attackOnSight'
      | 'allowPlayerDialogue'
      | 'allowBleedoutDialogue',
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
  act('setrace', async (actor, call) => {
    // The actor's own race (its base keeps its own); its 3D is made again in it (the player's
    // with the face chosen in the race menu: a werewolf and back keeps it).
    state.actor(actor).race = formOf(call.args[0]);
    world.raceChanged?.(actor);
    // The new race's abilities act, the old one's end.
    await runtime.magic.syncLasting(actor);
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
  // Association types (RELA's ASTP: ParentChild, Siblings, Spouse, Courting, ...): an
  // association with the other (any, without one named); ASTP DATA 0x1 is a family one; a
  // parent relationship is the other as the RELA's parent of a ParentChild association.
  const association = async (actor: number, other: number | undefined) => {
    if (other === undefined) return undefined;
    const relation = await actors.relationshipRecord(actor, other);
    return relation?.association === undefined
      ? undefined
      : { relation, association: relation.association };
  };
  ask('hasassociation', false, async (actor, call) => {
    const wanted = formOf(call.args[0]);
    const other = ref(call.args[1]);
    if (other === undefined) return (await actors.extremeRelationshipRank(actor, true)) !== 0;
    const found = await association(actor, other);
    return found !== undefined && (wanted === undefined || found.association === wanted);
  });
  ask('hasfamilyrelationship', false, async (actor, call) => {
    const found = await association(actor, ref(call.args[0]));
    const data = found && (await runtime.forms.record(found.association))?.fields.first('DATA');
    return ((data?.[0] ?? 0) & 0x1) !== 0;
  });
  ask('hasparentrelationship', false, async (actor, call) => {
    const other = ref(call.args[0]);
    const found = await association(actor, other);
    if (!found || other === undefined) return false;
    const editorId = (await runtime.forms.record(found.association))?.editorId ?? '';
    return (
      /parent/i.test(editorId) && found.relation.parent === (await actors.relationshipBase(other))
    );
  });

  // --- Spells, shouts, perks ------------------------------------------------------------------
  ask('addspell', false, async (actor, call) => {
    const spell = formOf(call.args[0]);
    if (spell === undefined) return false;
    const added = await actors.addSpell(actor, spell);
    // abVerbose (true unless given): the player's new spell is announced.
    if (added && actor === PLAYER_REF && bool(call.args[1], true)) {
      runtime.detach(runtime.spellMessage(spell));
    }
    // An ability, a disease: its effects act from now on.
    if (added) await runtime.magic.syncLasting(actor);
    return added;
  });
  ask('removespell', false, async (actor, call) => {
    const spell = formOf(call.args[0]);
    if (spell === undefined) return false;
    const removed = await actors.removeSpell(actor, spell);
    if (removed) await runtime.magic.syncLasting(actor);
    return removed;
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
  // Active magic (the magic system: magic-engine.ts).
  ask('dispelspell', false, (actor, call) => {
    const spell = formOf(call.args[0]);
    return spell === undefined ? false : runtime.magic.dispelSpell(actor, spell);
  });
  act('dispelallspells', (actor) => runtime.magic.dispelAll(actor));
  ask('hasmagiceffect', false, (actor, call) => {
    const effect = formOf(call.args[0]);
    return effect !== undefined && runtime.magic.hasEffect(actor, effect);
  });
  ask('hasmagiceffectwithkeyword', false, (actor, call) => {
    const keyword = formOf(call.args[0]);
    return keyword === undefined ? false : runtime.magic.hasEffectKeyword(actor, keyword);
  });
  // The spell applied to the target as from this actor's attack: delivered at once (its ward,
  // absorption, OnHit: casting-engine.ts), free.
  act('docombatspellapply', async (actor, call) => {
    const spell = formOf(call.args[0]);
    const target = ref(call.args[1]);
    if (spell === undefined || target === undefined) return;
    const item = await runtime.magic.item(spell);
    if (item) await runtime.casting.deliver(await runtime.casting.scripted(actor, item), target);
  });
  // Equipping spells and shouts: natives/equipment.ts. The voice's recovery (the shout meter
  // counts it down from what it was set to).
  act('setvoicerecoverytime', (actor, call) => {
    const seconds = Math.max(0, num(call.args[0]));
    state.actor(actor).voiceRecoveryTime = seconds;
    const casting = runtime.casting.state(actor);
    if (seconds > 0) casting.voiceRecoveryTotal = seconds;
    else delete casting.voiceRecoveryTotal;
  });
  ask('getvoicerecoverytime', 0, (actor) => state.actors.get(actor)?.voiceRecoveryTime ?? 0);
  // The dead target's soul into this actor's soul gems (Soul Trap's scripts call it).
  ask('trapsoul', false, async (actor, call) => {
    const victim = ref(call.args[0]);
    return victim !== undefined && runtime.magic.trapSoul(actor, victim);
  });

  // --- Equipment (natives/equipment.ts: the equip system) ------------------------------------
  ask('getgoldamount', 0, (actor) => runtime.itemCount(actor, GOLD));
  // TODO(M11): warmth (Survival Mode) of what it wears.
  ask('getwarmthrating', 0, () => 0);

  // --- Life and death ---------------------------------------------------------------------
  ask('isdead', false, (actor) => actors.isDead(actor));
  // An essential actor bleeds out instead (KillEssential, a script, clears Essential first).
  act('kill', (actor, call) => actors.scriptKill(actor, ref(call.args[0])));
  act('killsilent', (actor, call) => actors.scriptKill(actor, ref(call.args[0]), true));
  act('resurrect', (actor) => actors.resurrect(actor));
  ask('getkiller', null, (actor) => runtime.actorHandleOrNone(state.actors.get(actor)?.killer));
  // Deferred kills (the actor dies when the deferral ends, if it should have): TODO(M11).
  act('startdeferredkill', () => undefined);
  act('enddeferredkill', () => undefined);
  ask('isessential', false, (actor) => actors.isEssential(actor));
  ask('isghost', false, (actor) => actors.isGhost(actor));
  flag('setghost', 'ghost');
  ask('isbleedingout', false, (actor) => world.combat?.(actor)?.bleedingOut ?? false);
  flag('setnobleedoutrecovery', 'noBleedoutRecovery');
  ask(
    'getnobleedoutrecovery',
    false,
    (actor) => state.actors.get(actor)?.noBleedoutRecovery ?? false,
  );
  // Whether the player may talk to it while it bleeds out (src/shell/actors.ts: Talk).
  flag('allowbleedoutdialogue', 'allowBleedoutDialogue');
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
  // Summoned, reanimated or commanded by an effect (magic-engine.ts).
  ask('iscommandedactor', false, (actor) => runtime.magic.commander(actor) !== undefined);
  ask('isbribed', false, (actor) => state.actors.get(actor)?.bribed ?? false);
  flag('setbribed', 'bribed');
  ask('isintimidated', false, (actor) => state.actors.get(actor)?.intimidated ?? false);
  flag('setintimidated', 'intimidated');
  ask('willintimidatesucceed', false, (actor) => runtime.crime.intimidates(actor));
  ask('getbribeamount', 0, (actor) => runtime.crime.bribeAmount(actor));
  flag('setrestrained', 'restrained');
  flag('setdontmove', 'dontMove');
  ask('isalerted', false, (actor) => state.actors.get(actor)?.alerted ?? false);
  flag('setalert', 'alerted');
  ask('isalarmed', false, (actor) => world.alarmed?.(actor) ?? false);
  ask('isplayerslastriddenhorse', false, (actor) => runtime.lastHorse === actor);
  ask('getplayercontrols', false, (actor) => actor === PLAYER_REF);
  act('setplayercontrols', () => undefined);
  act('enableai', (actor, call) => {
    state.actor(actor).aiEnabled = bool(call.args[0], true);
    world.aiEnabled?.(actor, bool(call.args[0], true));
  });
  act('setvehicle', (actor, call) => {
    state.actor(actor).vehicle = ref(call.args[0]);
    world.vehicleChanged?.(actor);
  });
  act('setforcedlandingmarker', (actor, call) => {
    state.actor(actor).forcedLandingMarker = ref(call.args[0]);
  });
  ask('getforcedlandingmarker', null, (actor) =>
    runtime.referenceHandleOrNone(state.actors.get(actor)?.forcedLandingMarker),
  );

  // --- AI, combat, detection (src/shell/actor-ai.ts, actor-combat-ai.ts, actor-senses.ts) -----
  act('evaluatepackage', (actor) => world.evaluatePackage?.(actor));
  ask('getcurrentpackage', null, (actor) => object(runtime.currentPackage(actor), 'package'));
  act('movetopackagelocation', (actor) => world.moveToPackageLocation?.(actor));
  // It walks (or runs) to the reference; true once there (latent: src/shell/actor-movers.ts).
  ask('pathtoreference', false, async (actor, call) => {
    const target = ref(call.args[0]);
    if (target === undefined) return false;
    return (await world.pathTo?.(actor, target, num(call.args[1], 0.5))) ?? false;
  });
  act('startcombat', (actor, call) => {
    const target = ref(call.args[0]);
    if (target !== undefined) world.startCombat?.(actor, target);
  });
  act('stopcombat', (actor) => world.stopCombat?.(actor));
  // On the player: the guards stop pursuing them (a bribe, a persuasion: CrimeGuardsScript).
  act('stopcombatalarm', (actor) => {
    world.stopCombat?.(actor);
    world.alarm?.(actor, undefined, 'stop');
    if (actor === PLAYER_REF) runtime.crime.stopPursuit();
  });
  // In combat as the combat AI has it (src/shell/actor-combat-ai.ts): 1 fighting, 2 searching.
  ask('isincombat', false, (actor) => world.combat?.(actor)?.inCombat ?? false);
  ask('getcombatstate', 0, (actor) => world.combat?.(actor)?.combatState ?? 0);
  ask('getcombattarget', null, (actor) =>
    runtime.actorHandleOrNone(world.combat?.(actor)?.combatTarget),
  );
  // Detection (src/shell/actor-senses.ts): this actor detected by the other; its sight of one.
  ask('isdetectedby', false, (actor, call) => {
    const other = ref(call.args[0]);
    return other !== undefined && (world.detects?.(other, actor) ?? false);
  });
  ask('haslos', false, (actor, call) => {
    const other = ref(call.args[0]);
    return other !== undefined && (world.lineOfSight?.(actor, other) ?? false);
  });
  // Crime and factions (crime-engine.ts): how it regards the other, guards, arrests. Hostile:
  // it fights the other or would attack it on sight (src/ai/combat-ai.ts), or regards it so.
  ask('ishostiletoactor', false, async (actor, call) => {
    const other = ref(call.args[0]);
    if (other === undefined) return false;
    return (
      (await hostileTo(runtime, actor, other)) ||
      (await runtime.crime.reaction(actor, other)) === 'hostile'
    );
  });
  ask('isguard', false, (actor) => runtime.crime.isGuard(actor));
  ask('istrespassing', false, async (actor) =>
    actor === PLAYER_REF
      ? runtime.crime.trespassing((await runtime.placement(PLAYER_REF))?.cell)
      : false,
  );
  // The player is arrested while a guard arrests them or they are in jail.
  ask(
    'isarrested',
    false,
    (actor) =>
      actor === PLAYER_REF &&
      (state.crime.arrestingGuard !== undefined || state.crime.jail !== undefined),
  );
  ask('isarrestingtarget', false, (actor) => state.crime.arrestingGuard === actor);
  act('cleararrested', () => {
    delete state.crime.arrestingGuard;
  });
  // On the guard the player resists: its crime faction's guards attack them.
  act('setplayerresistingarrest', async (actor) => {
    const faction = await actors.crimeFaction(actor);
    if (faction !== undefined) runtime.crime.resistArrest(faction);
  });
  // Alarms: the actor, attacked by the player, raises one (an assault); or against a
  // trespasser. Those that hear it react (src/shell/actor-crime.ts).
  act('sendassaultalarm', async (actor) => {
    world.alarm?.(actor, PLAYER_REF, 'attack');
    await runtime.crime.assault(PLAYER_REF, actor);
  });
  act('sendtrespassalarm', (actor, call) => world.alarm?.(actor, ref(call.args[0]), 'trespass'));
  // Others attack this one on sight (src/ai/combat-reactions.ts: everyone's enemy).
  flag('setattackactoronsight', 'attackOnSight');
  act('setnotshowonstealthmeter', (actor, call) =>
    world.hideFromStealthMeter?.(actor, bool(call.args[0], true)),
  );
  // Whether the player may talk to it (src/shell/actors.ts: Talk).
  flag('allowpcdialogue', 'allowPlayerDialogue');
  // Whom it talks with: the player in conversation with it (and the other way round), else
  // the one its scene's lines address (whom it looks at). TODO(M13): conversations outside
  // scenes (the actors' own chatter).
  ask('getdialoguetarget', null, (actor) => {
    const speaker = runtime.dialogueSpeaker;
    if (speaker !== undefined && actor === speaker) return runtime.actorHandle(PLAYER_REF);
    if (speaker !== undefined && actor === PLAYER_REF) return runtime.actorHandle(speaker);
    return runtime.actorHandleOrNone(runtime.scenes.lookOf(actor)?.target);
  });
  // No vanilla script calls these (tools/papyrus-natives.ts --placeholders). TODO(M13): the
  // offsets and forced movements of the engine's movement controller.
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
  act('startsneaking', (actor) => world.startSneaking?.(actor));
  ask('isweapondrawn', false, (actor) => (world.combat?.(actor)?.weaponState ?? 0) !== 0);
  act('drawweapon', (actor) => world.drawWeapon?.(actor, true));
  act('sheatheweapon', (actor) => world.drawWeapon?.(actor, false));
  // What it uses: 0 not, 2 wants to (on its way), 3 in it, 4 wants to leave.
  ask('getsitstate', 0, (actor) => {
    const using = world.interaction?.(actor);
    return using && using.animationType !== 2 ? using.state : 0;
  });
  ask('getsleepstate', 0, (actor) => {
    const using = world.interaction?.(actor);
    return using?.animationType === 2 ? using.state : 0;
  });
  ask('isinkillmove', false, (actor) => world.combat?.(actor)?.killMove ?? false);
  ask('getlightlevel', 0, (actor) => world.lightLevel?.(actor) ?? 0);
  // Flying (src/shell/actor-flight.ts: the dragons): its flying state (FlyingState: 0 on the
  // ground, 1 taking off, 2 cruising, 3 hovering, 4 landing, 5 perching, 6 an action).
  ask('isflying', false, (actor) => {
    const flight = world.flight?.(actor);
    return flight !== undefined && flight.state !== 0 && flight.state !== 5;
  });
  ask('getflyingstate', 0, (actor) => world.flight?.(actor)?.state ?? 0);
  ask('isallowedtofly', false, (actor) =>
    world.flight?.(actor) !== undefined ? state.actors.get(actor)?.allowFlying !== false : false,
  );
  ask('canflyhere', false, (actor) => world.flight?.(actor)?.canFlyHere ?? false);
  act('setallowflying', (actor, call) => {
    state.actor(actor).allowFlying = bool(call.args[0], true);
  });
  // SetAllowFlyingEx(abAllowFlying, abAllowCrash, abAllowSearch).
  act('setallowflyingex', (actor, call) => {
    const own = state.actor(actor);
    own.allowFlying = bool(call.args[0], true);
    own.allowCrashLand = bool(call.args[1], true);
    own.allowFlyingSearch = bool(call.args[2], true);
  });
  // Riding (src/shell/actor-mounts.ts).
  ask('isonmount', false, (actor) => world.mountOf?.(actor) !== undefined);
  ask('isbeingridden', false, (actor) => world.riderOf?.(actor) !== undefined);
  ask('dismount', false, (actor) => world.dismount?.(actor) ?? false);

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
  act('setheadtracking', (actor, call) => world.headTracking?.(actor, bool(call.args[0])));
  act('setlookat', (actor, call) => world.lookAt?.(actor, ref(call.args[0]), 'script'));
  act('clearlookat', (actor) => world.lookAt?.(actor, undefined, 'script'));
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
  // Feeding on a target (a vampire's bite, Namira's cannibalism): a crime where it is seen
  // (crime-engine.ts vampireFeed). TODO(M10) 5.1: the feeding's paired animation.
  act('startvampirefeed', async (actor, call) => {
    const target = ref(call.args[0]);
    if (target !== undefined) await runtime.crime.vampireFeed(actor, target);
  });
  act('startcannibal', async (actor, call) => {
    const target = ref(call.args[0]);
    if (target === undefined) return;
    // The corpse is eaten (HasBeenEaten: it is not fed on again).
    state.actor(target).eaten = true;
    await runtime.crime.vampireFeed(actor, target);
  });
  // The doors of the actor's cell that it owns are unlocked (the player may come in: no longer
  // off limits to them).
  act('unlockowneddoorsincell', async (actor) => {
    const cell = (await runtime.placement(actor))?.cell;
    if (cell === undefined) return;
    for (const door of world.loadedReferences?.() ?? []) {
      if (runtime.forms.db.cellOfReference(door) !== cell) continue;
      const base = await runtime.baseOf(door);
      if (base === undefined || (await runtime.forms.record(base))?.type !== 'DOOR') continue;
      if ((await runtime.lock(door)).locked && (await runtime.mayUse(actor, door)))
        await runtime.setLocked(door, false);
    }
    runtime.crime.doorsLocked([cell], false, undefined);
  });

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
  // ActorBase.SetOutfit: natives/equipment.ts.
}
