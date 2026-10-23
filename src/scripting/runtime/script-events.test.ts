import { describe, expect, it } from 'vitest';
import { ObjectHandle, type Value } from '../values.ts';
import { EventHub } from './event-hub.ts';
import { PLAYER_REF } from './forms.ts';
import { relayScriptEvents, type ScriptEventHost } from './script-events.ts';

const DOOR = 0x100;
const NPC = 0x200;
const CHEST = 0x300;
const ITEM = 0x400;
const LETTER = 0x500;
const DEAD = 0x600;

/** A host that writes down what the scripts get: `event target (args)`. */
function relayed(options: { deleted?: number } = {}): { hub: EventHub; sent: string[] } {
  const hub = new EventHub();
  const sent: string[] = [];
  const show = (value: Value): string =>
    value instanceof ObjectHandle
      ? `${value.type} ${value.formId.toString(16)}`
      : typeof value === 'object' && value !== null
        ? 'array'
        : String(value);
  const host: ScriptEventHost = {
    events: hub,
    sendEvent: (target, event, args = []) => {
      sent.push(`${event} ${target.toString(16)} (${args.map(show).join(', ')})`);
      return Promise.resolve();
    },
    registeredEvent: (kind, event, args) => {
      sent.push(`${event} registered:${kind} (${args.map(show).join(', ')})`);
      return Promise.resolve();
    },
    referenceHandle: (reference) => new ObjectHandle(reference, 'objectreference'),
    actorHandle: (reference) => new ObjectHandle(reference, 'actor'),
    formHandle: (formId) => new ObjectHandle(formId, 'form'),
    livingActor: (reference) => Promise.resolve(reference === NPC || reference === PLAYER_REF),
    itemScripted: (item) => Promise.resolve(item === ITEM),
    deleted: (reference) => reference === options.deleted,
  };
  relayScriptEvents(host);
  return { hub, sent };
}

describe('the relay from the event hub to the scripts', () => {
  it("tells an actor's combat state with its target", async () => {
    const { hub, sent } = relayed();
    await hub.emitted('combat', { actor: NPC, target: PLAYER_REF, state: 1 });
    await hub.emitted('combat', { actor: NPC, target: undefined, state: 0 });
    expect(sent).toEqual([
      'OnCombatStateChanged 200 (actor 14, 1)',
      'OnCombatStateChanged 200 (null, 0)',
    ]);
  });

  it('opens and closes with the one who did it, enters bleedout, grabs and releases', async () => {
    const { hub, sent } = relayed();
    await hub.emitted('openClose', { reference: DOOR, actor: PLAYER_REF, opened: true });
    await hub.emitted('openClose', { reference: DOOR, actor: undefined, opened: false });
    await hub.emitted('enterBleedout', { actor: NPC });
    await hub.emitted('grabRelease', { reference: ITEM, grabbed: true });
    await hub.emitted('grabRelease', { reference: ITEM, grabbed: false });
    expect(sent).toEqual([
      'OnOpen 100 (objectreference 14)',
      'OnClose 100 (null)',
      'OnEnterBleedout 200 ()',
      'OnGrab 400 ()',
      'OnRelease 400 ()',
    ]);
  });

  it('tells triggers: entering, leaving and being inside', async () => {
    const { hub, sent } = relayed();
    await hub.emitted('triggerEnterLeave', { trigger: DOOR, reference: NPC, entered: true });
    await hub.emitted('trigger', { trigger: DOOR, reference: NPC });
    await hub.emitted('triggerEnterLeave', { trigger: DOOR, reference: NPC, entered: false });
    expect(sent).toEqual([
      'OnTriggerEnter 100 (objectreference 200)',
      'OnTrigger 100 (objectreference 200)',
      'OnTriggerLeave 100 (objectreference 200)',
    ]);
  });

  it("tells a cast to its caster, a hit to its target, a ward's hit with its status", async () => {
    const { hub, sent } = relayed();
    await hub.emitted('spellCast', { caster: PLAYER_REF, spell: 0x12fcd });
    await hub.emitted('hit', {
      target: DOOR,
      aggressor: PLAYER_REF,
      source: 0x12fcd,
      projectile: 0x10fbed,
      powerAttack: false,
      sneakAttack: true,
      bashAttack: false,
      blocked: false,
    });
    await hub.emitted('magicWardHit', {
      target: NPC,
      caster: PLAYER_REF,
      spell: 0x12fcd,
      status: 2,
    });
    expect(sent).toEqual([
      'OnSpellCast 14 (form 12fcd)',
      'OnHit 100 (objectreference 14, form 12fcd, form 10fbed, false, true, false, false)',
      'OnWardHit 200 (objectreference 14, form 12fcd, 2)',
    ]);
  });

  it("names translations as the engine's codes say: failed, complete, almost complete", async () => {
    const { hub, sent } = relayed();
    await hub.emitted('objectTranslation', { reference: DOOR, result: 2 });
    await hub.emitted('objectTranslation', { reference: DOOR, result: 1 });
    await hub.emitted('objectTranslation', { reference: DOOR, result: 0 });
    expect(sent).toEqual([
      'OnTranslationAlmostComplete 100 ()',
      'OnTranslationComplete 100 ()',
      'OnTranslationFailed 100 ()',
    ]);
  });

  it('tells a move between containers to the item, the old and the new container', async () => {
    const { hub, sent } = relayed();
    await hub.emitted('containerChanged', {
      from: CHEST,
      to: PLAYER_REF,
      item: ITEM,
      count: 1,
      reference: LETTER,
    });
    await hub.emitted('containerChanged', {
      from: undefined,
      to: CHEST,
      item: ITEM,
      count: 3,
      reference: undefined,
    });
    expect(sent).toEqual([
      'OnContainerChanged 500 (objectreference 14, objectreference 300)',
      'OnItemRemoved 300 (form 400, 1, objectreference 500, objectreference 14)',
      'OnItemAdded 14 (form 400, 1, objectreference 500, objectreference 300)',
      'OnItemAdded 300 (form 400, 3, null, null)',
    ]);
  });

  it("tells the player's own events to the player", async () => {
    const { hub, sent } = relayed();
    await hub.emitted('playerBowShot', {
      weapon: 0x139b5,
      ammo: 0x1397d,
      power: 1,
      sunGazing: true,
    });
    await hub.emitted('fastTravelEnd', { hours: 7.5 });
    await hub.emitted('loadGame', {});
    expect(sent).toEqual([
      'OnPlayerBowShot 14 (form 139b5, form 1397d, 1, true)',
      'OnPlayerFastTravelEnd 14 (7.5)',
      'OnPlayerLoadGame 14 ()',
    ]);
  });

  it('tells registered events to those registered', async () => {
    const { hub, sent } = relayed();
    await hub.emitted('trackedStats', { stat: 'Locks Picked', value: 3 });
    await hub.emitted('sleep', { started: true, interrupted: false, start: 10, end: 10.25 });
    await hub.emitted('sleep', { started: false, interrupted: true });
    expect(sent).toEqual([
      'OnTrackedStatsEvent registered:trackedstats (Locks Picked, 3)',
      'OnSleepStart registered:sleep (10, 10.25)',
      'OnSleepStop registered:sleep (true)',
    ]);
  });

  it("tells a trap's hits only on living actors, by its contact's phase", async () => {
    const { hub, sent } = relayed();
    const hit = {
      trap: DOOR,
      velocity: [1, 2, 3] as const,
      position: [4, 5, 6] as const,
      material: undefined,
      initial: true,
      motionType: 1,
    };
    await hub.emitted('trapHit', { ...hit, target: NPC, phase: 'start' });
    await hub.emitted('trapHit', { ...hit, target: NPC, phase: 'hit' });
    await hub.emitted('trapHit', { ...hit, target: DEAD, phase: 'hit' });
    await hub.emitted('trapHit', { ...hit, target: NPC, phase: 'stop' });
    expect(sent).toEqual([
      'OnTrapHitStart 100 (objectreference 200, 1, 2, 3, 4, 5, 6, 0, true, 1)',
      'OnTrapHit 100 (objectreference 200, 1, 2, 3, 4, 5, 6, 0, true, 1)',
      'OnTrapHitStop 100 (objectreference 200)',
    ]);
  });

  it('tells resets but for deleted references, sales to the item sold if it is one', async () => {
    const { hub, sent } = relayed({ deleted: LETTER });
    await hub.emitted('reset', { reference: DOOR });
    await hub.emitted('reset', { reference: LETTER });
    await hub.emitted('sell', { seller: PLAYER_REF, item: ITEM, count: 1, reference: LETTER });
    await hub.emitted('sell', { seller: PLAYER_REF, item: ITEM, count: 2, reference: undefined });
    expect(sent).toEqual(['OnReset 100 ()', 'OnSell 500 (actor 14)']);
  });

  it('tells cells, locations, equipment and moves into and out of the attached area', async () => {
    const { hub, sent } = relayed();
    await hub.emitted('moveAttachDetach', { reference: NPC, attached: true });
    await hub.emitted('moveAttachDetach', { reference: NPC, attached: false });
    await hub.emitted('cellFullyLoaded', { cell: undefined, references: [DOOR, CHEST] });
    await hub.emitted('actorLocationChange', { actor: NPC, from: undefined, to: 0x18a56 });
    await hub.emitted('equip', { actor: NPC, item: ITEM, reference: undefined, equipped: true });
    await hub.emitted('equip', {
      actor: NPC,
      item: 0x12fcd,
      reference: undefined,
      equipped: false,
    });
    expect(sent).toEqual([
      'OnAttachedToCell 200 ()',
      'OnDetachedFromCell 200 ()',
      'OnCellLoad 100 ()',
      'OnCellLoad 300 ()',
      'OnLocationChange 200 (null, form 18a56)',
      'OnObjectEquipped 200 (form 400, null)',
      'OnEquipped 400 (actor 200)',
      'OnObjectUnequipped 200 (form 12fcd, null)',
    ]);
  });
});
