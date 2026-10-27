// The relay from the game's event hub to the scripts (docs/scripting.md, "Events"): each
// happening the hub tells becomes the scripts' On* event, sent to whom the engine sends it and
// with its arguments, as the engine's own relay does (observed in the original: one event
// sink per event source). A reference's event goes to the reference's scripts, then to the
// aliases that hold it and, for an actor, to the scripts of the magic effects on it
// (ScriptRuntime.sendEvent); the player's own events (a bow shot, the end of a fast travel, a
// loaded game) go to the player; registered events (sleep, tracked stats) to every object that
// registered for them. Kinds without a script event (quest stages, scenes, topic infos, waits,
// perk entries) are the story manager's and the other consumers'. Platform-independent.

import type { EventHub, GameEventKind, GameEventListener, GameEvents } from './event-hub.ts';
import { PLAYER_REF } from './forms.ts';
import type { ObjectHandle, Value } from '../values.ts';

/** What the relay needs of the running game (ScriptRuntime gives it). */
export interface ScriptEventHost {
  readonly events: EventHub;
  /** An event to a form's scripts, the aliases holding it and the magic effects on it. */
  sendEvent(target: number, event: string, args?: readonly Value[]): Promise<void>;
  /** An event to every object registered for a kind (OnSleepStart, OnTrackedStatsEvent). */
  registeredEvent(
    kind: 'sleep' | 'trackedstats',
    event: string,
    args: readonly Value[],
  ): Promise<void>;
  referenceHandle(reference: number): ObjectHandle;
  actorHandle(reference: number): ObjectHandle;
  formHandle(formId: number): ObjectHandle;
  /** Whether a reference is an actor that lives (a trap's hits reach only those). */
  livingActor(reference: number): Promise<boolean>;
  /** Whether an equipped item's own scripts hear of it (an item's, not a spell's or shout's). */
  itemScripted(item: number): Promise<boolean>;
  /** Whether a reference was deleted (its reset is not told). */
  deleted(reference: number): boolean;
}

/** The Papyrus event of each kind and state (for the docs and the tests). */
export const SCRIPT_EVENTS = {
  activate: ['OnActivate'],
  actorLocationChange: ['OnLocationChange'],
  bookRead: ['OnRead'],
  cellAttachDetach: ['OnCellAttach', 'OnCellDetach'],
  cellFullyLoaded: ['OnCellLoad'],
  combat: ['OnCombatStateChanged'],
  containerChanged: ['OnContainerChanged', 'OnItemRemoved', 'OnItemAdded'],
  death: ['OnDying', 'OnDeath'],
  destructionStageChanged: ['OnDestructionStageChanged'],
  enterBleedout: ['OnEnterBleedout'],
  equip: ['OnObjectEquipped', 'OnObjectUnequipped', 'OnEquipped', 'OnUnequipped'],
  fastTravelEnd: ['OnPlayerFastTravelEnd'],
  furniture: ['OnSit', 'OnGetUp'],
  grabRelease: ['OnGrab', 'OnRelease'],
  hit: ['OnHit'],
  loadGame: ['OnPlayerLoadGame'],
  lockChanged: ['OnLockStateChanged'],
  magicEffectApply: ['OnMagicEffectApply'],
  magicWardHit: ['OnWardHit'],
  moveAttachDetach: ['OnAttachedToCell', 'OnDetachedFromCell'],
  objectLoaded: ['OnLoad', 'OnUnload'],
  objectTranslation: [
    'OnTranslationFailed',
    'OnTranslationComplete',
    'OnTranslationAlmostComplete',
  ],
  openClose: ['OnOpen', 'OnClose'],
  package: ['OnPackageStart', 'OnPackageChange', 'OnPackageEnd'],
  playerBowShot: ['OnPlayerBowShot'],
  reset: ['OnReset'],
  sell: ['OnSell'],
  sleep: ['OnSleepStart', 'OnSleepStop'],
  spellCast: ['OnSpellCast'],
  switchRaceComplete: ['OnRaceSwitchComplete'],
  trackedStats: ['OnTrackedStatsEvent'],
  trapHit: ['OnTrapHitStart', 'OnTrapHit', 'OnTrapHitStop'],
  trigger: ['OnTrigger'],
  triggerEnterLeave: ['OnTriggerEnter', 'OnTriggerLeave'],
} as const satisfies Partial<Record<keyof GameEvents, readonly string[]>>;

const TRANSLATION = SCRIPT_EVENTS.objectTranslation;

/**
 * Relays the hub's events to the scripts from now on; returns what stops it. The engine never
 * waits for a script's handler (Creation Kit, "Threading Notes (Papyrus)": an event is queued
 * and the engine goes on): each event's sends start at once, in the order the hub tells them,
 * and a producer that waits (EventHub.emitted) waits only for the engine's own listeners. So
 * a death goes on to the crime while WIDeadBodyCleanupScript's OnDeath waits half a game day,
 * and an EquipItem returns while the player's aliases' OnObjectEquipped wait for a frame.
 */
export function relayScriptEvents(host: ScriptEventHost): () => void {
  const events = host.events;
  const hub = {
    on: <K extends GameEventKind>(kind: K, listener: GameEventListener<K>): (() => void) =>
      events.on(kind, (event) => {
        const sending = listener(event);
        if (sending instanceof Promise) {
          sending.catch((error: unknown) => {
            events.onError(kind, error);
          });
        }
      }),
  };
  const ref = (reference: number | undefined): Value =>
    reference === undefined ? null : host.referenceHandle(reference);
  const actor = (reference: number | undefined): Value =>
    reference === undefined ? null : host.actorHandle(reference);
  const form = (formId: number | undefined): Value =>
    formId === undefined ? null : host.formHandle(formId);
  const send = (target: number, event: string, args: readonly Value[] = []): Promise<void> =>
    host.sendEvent(target, event, args);

  const stops = [
    hub.on('activate', (e) => send(e.target, 'OnActivate', [ref(e.actor)])),
    hub.on('actorLocationChange', (e) =>
      send(e.actor, 'OnLocationChange', [form(e.from), form(e.to)]),
    ),
    hub.on('bookRead', (e) =>
      e.reference === undefined ? undefined : send(e.reference, 'OnRead'),
    ),
    hub.on('cellAttachDetach', (e) =>
      send(e.reference, e.attached ? 'OnCellAttach' : 'OnCellDetach'),
    ),
    hub.on('cellFullyLoaded', (e) =>
      Promise.all(e.references.map((reference) => send(reference, 'OnCellLoad'))),
    ),
    // The target goes along only if it is an actor (the producer tells actors only).
    hub.on('combat', (e) => send(e.actor, 'OnCombatStateChanged', [actor(e.target), e.state])),
    hub.on('containerChanged', (e) => {
      const sends: Promise<void>[] = [];
      if (e.reference !== undefined)
        sends.push(send(e.reference, 'OnContainerChanged', [ref(e.to), ref(e.from)]));
      if (e.from !== undefined)
        sends.push(
          send(e.from, 'OnItemRemoved', [form(e.item), e.count, ref(e.reference), ref(e.to)]),
        );
      if (e.to !== undefined)
        sends.push(
          send(e.to, 'OnItemAdded', [form(e.item), e.count, ref(e.reference), ref(e.from)]),
        );
      return Promise.all(sends);
    }),
    hub.on('death', (e) => send(e.actor, e.dead ? 'OnDeath' : 'OnDying', [actor(e.killer)])),
    hub.on('destructionStageChanged', (e) =>
      send(e.reference, 'OnDestructionStageChanged', [e.oldStage, e.newStage]),
    ),
    hub.on('enterBleedout', (e) => send(e.actor, 'OnEnterBleedout')),
    // The actor's scripts hear what it (un)equipped, then the item's own scripts who did it.
    hub.on('equip', async (e) => {
      await send(e.actor, e.equipped ? 'OnObjectEquipped' : 'OnObjectUnequipped', [
        form(e.item),
        ref(e.reference),
      ]);
      const item = e.reference ?? e.item;
      if (e.reference !== undefined || (await host.itemScripted(e.item)))
        await send(item, e.equipped ? 'OnEquipped' : 'OnUnequipped', [host.actorHandle(e.actor)]);
    }),
    hub.on('fastTravelEnd', (e) => send(PLAYER_REF, 'OnPlayerFastTravelEnd', [e.hours])),
    hub.on('furniture', (e) => send(e.actor, e.entered ? 'OnSit' : 'OnGetUp', [ref(e.furniture)])),
    hub.on('grabRelease', (e) => send(e.reference, e.grabbed ? 'OnGrab' : 'OnRelease')),
    hub.on('hit', (e) =>
      send(e.target, 'OnHit', [
        ref(e.aggressor),
        form(e.source),
        form(e.projectile),
        e.powerAttack,
        e.sneakAttack,
        e.bashAttack,
        e.blocked,
      ]),
    ),
    hub.on('loadGame', () => send(PLAYER_REF, 'OnPlayerLoadGame')),
    hub.on('lockChanged', (e) => send(e.reference, 'OnLockStateChanged')),
    hub.on('magicEffectApply', (e) =>
      send(e.target, 'OnMagicEffectApply', [ref(e.caster), form(e.effect)]),
    ),
    hub.on('magicWardHit', (e) =>
      send(e.target, 'OnWardHit', [ref(e.caster), form(e.spell), e.status]),
    ),
    hub.on('moveAttachDetach', (e) =>
      send(e.reference, e.attached ? 'OnAttachedToCell' : 'OnDetachedFromCell'),
    ),
    hub.on('objectLoaded', (e) => send(e.reference, e.loaded ? 'OnLoad' : 'OnUnload')),
    hub.on('objectTranslation', (e) => send(e.reference, TRANSLATION[e.result])),
    hub.on('openClose', (e) => send(e.reference, e.opened ? 'OnOpen' : 'OnClose', [ref(e.actor)])),
    hub.on('package', (e) => {
      const event =
        e.type === 'start'
          ? 'OnPackageStart'
          : e.type === 'change'
            ? 'OnPackageChange'
            : 'OnPackageEnd';
      return send(e.actor, event, [form(e.package)]);
    }),
    hub.on('playerBowShot', (e) =>
      send(PLAYER_REF, 'OnPlayerBowShot', [form(e.weapon), form(e.ammo), e.power, e.sunGazing]),
    ),
    // A deleted reference's reset is not told.
    hub.on('reset', (e) => (host.deleted(e.reference) ? undefined : send(e.reference, 'OnReset'))),
    // To the item sold, if it is a reference of its own, with the actor that sold it.
    hub.on('sell', (e) =>
      e.reference === undefined ? undefined : send(e.reference, 'OnSell', [actor(e.seller)]),
    ),
    hub.on('sleep', (e) =>
      e.started
        ? host.registeredEvent('sleep', 'OnSleepStart', [e.start ?? 0, e.end ?? 0])
        : host.registeredEvent('sleep', 'OnSleepStop', [e.interrupted]),
    ),
    hub.on('spellCast', (e) => send(e.caster, 'OnSpellCast', [form(e.spell)])),
    hub.on('switchRaceComplete', (e) => send(e.actor, 'OnRaceSwitchComplete')),
    hub.on('trackedStats', (e) =>
      host.registeredEvent('trackedstats', 'OnTrackedStatsEvent', [e.stat, e.value]),
    ),
    // A trap's hits reach its scripts only on living actors.
    hub.on('trapHit', async (e) => {
      if (!(await host.livingActor(e.target))) return;
      if (e.phase === 'stop') {
        await send(e.trap, 'OnTrapHitStop', [ref(e.target)]);
        return;
      }
      await send(e.trap, e.phase === 'start' ? 'OnTrapHitStart' : 'OnTrapHit', [
        ref(e.target),
        ...e.velocity,
        ...e.position,
        e.material ?? 0,
        e.initial,
        e.motionType,
      ]);
    }),
    hub.on('trigger', (e) => send(e.trigger, 'OnTrigger', [ref(e.reference)])),
    hub.on('triggerEnterLeave', (e) =>
      send(e.trigger, e.entered ? 'OnTriggerEnter' : 'OnTriggerLeave', [ref(e.reference)]),
    ),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
