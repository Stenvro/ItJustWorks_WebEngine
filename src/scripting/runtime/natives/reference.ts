// Natives of ObjectReference (signatures: the game's ObjectReference.pex). The state a script
// can read back (placement, enable state, open and lock state, owners, destruction, items,
// linked references) is kept here; what the engine shows goes through the WorldBridge.
// Angles are degrees in Papyrus and radians in the game state. Platform-independent.
// Notes: docs/scripting.md ("Natives").

import { gameplayImpulse } from '../../../gameplay/magic/explosions.ts';
import { EntryPoint } from '../../../gameplay/perk-entry-points.ts';
import { ActorValue } from '../../../world/actor-values.ts';
import type { NativeCall } from '../../papyrus-vm.ts';
import { formatValue, ObjectHandle, type Value } from '../../values.ts';
import { PLAYER_REF } from '../forms.ts';
import type { ScriptRuntime } from '../runtime.ts';
import { questItems } from '../quest-items.ts';
import { bool, formOf, int, num, object, str, type Register } from './args.ts';

const DEG = 180 / Math.PI;

/**
 * Whether a lock is broken (ObjectReference.IsLockBroken), as observed in the original: its
 * failed tries reach one, or two when the player's Ignore Broken Lock entry point gives a value
 * (`ignore`, 0 without one).
 */
export function lockBroken(tries: number, ignore: number): boolean {
  return tries >= (Math.abs(ignore) > 0.0001 ? 2 : 1);
}

export function registerReference(n: Register, runtime: ScriptRuntime): void {
  const { state, world } = runtime;
  const ref = (value: Value | undefined): number | undefined => runtime.reference(value ?? null);
  const self = (call: { self: ObjectHandle | null }): number | undefined => ref(call.self);

  // --- Enable state ----------------------------------------------------------------------
  for (const [name, enable] of [
    ['enable', true],
    ['enablenowait', true],
    ['disable', false],
    ['disablenowait', false],
  ] as const) {
    n(`objectreference.${name}`, async (call) => {
      const reference = self(call);
      if (reference !== undefined) await runtime.setEnabled(reference, enable, call.where);
      return null;
    });
  }
  n('objectreference.isdisabled', async (call) => {
    const reference = self(call);
    return reference === undefined || !(await runtime.isEnabled(reference));
  });
  n('objectreference.delete', (call) => {
    const reference = self(call);
    if (reference !== undefined) runtime.deleteReference(reference);
    return null;
  });
  n('objectreference.deletewhenable', (call) => {
    const reference = self(call);
    if (reference !== undefined) runtime.deleteWhenAble(reference);
    return null;
  });
  n('objectreference.isdeleted', (call) => {
    const reference = self(call);
    return reference !== undefined && state.references.get(reference)?.deleted === true;
  });

  // --- What it is ---------------------------------------------------------------------
  n('objectreference.getbaseobject', async (call) => {
    const reference = self(call);
    const base = reference === undefined ? undefined : await runtime.baseOf(reference);
    return base === undefined ? null : runtime.formHandle(base);
  });
  n('objectreference.getlinkedref', async (call) => {
    const reference = self(call);
    const linked =
      reference === undefined
        ? undefined
        : await runtime.linkedReference(reference, formOf(call.args[0]) ?? 0);
    return linked === undefined ? null : runtime.referenceHandle(linked);
  });
  n('objectreference.getnthlinkedref', async (call) => {
    const reference = self(call);
    if (reference === undefined) return null;
    // The chain of linked references (no keyword): the 1st is the reference's own.
    let at: number | undefined = reference;
    for (let i = 0; i < int(call.args[0]) && at !== undefined; i++) {
      at = await runtime.linkedReference(at, 0);
    }
    return at === undefined || at === reference ? null : runtime.referenceHandle(at);
  });
  n('objectreference.hasreftype', async (call) => {
    const reference = self(call);
    const type = formOf(call.args[0]);
    return (
      reference !== undefined &&
      type !== undefined &&
      (await runtime.referenceTypes(reference)).includes(type)
    );
  });
  n('objectreference.getvoicetype', async (call) => {
    const reference = self(call);
    return reference === undefined ? null : object(await runtime.voiceType(reference), 'voicetype');
  });
  n('objectreference.getkey', async (call) => {
    const reference = self(call);
    return reference === undefined ? null : object((await runtime.lock(reference)).key, 'key');
  });

  // --- Placement ------------------------------------------------------------------------
  const placement = async (reference: number | undefined) =>
    reference === undefined ? undefined : runtime.placement(reference);
  for (const [axis, index] of [
    ['x', 0],
    ['y', 1],
    ['z', 2],
  ] as const) {
    n(
      `objectreference.getposition${axis}`,
      async (call) => (await placement(self(call)))?.position[index] ?? 0,
    );
    n(
      `objectreference.getangle${axis}`,
      async (call) => ((await placement(self(call)))?.rotation[index] ?? 0) * DEG,
    );
  }
  n('objectreference.setposition', (call) => {
    const reference = self(call);
    if (reference === undefined) return null;
    runtime.move(reference, [num(call.args[0]), num(call.args[1]), num(call.args[2])]);
    return null;
  });
  n('objectreference.setangle', async (call) => {
    const reference = self(call);
    if (reference === undefined) return null;
    const at = await runtime.placement(reference);
    runtime.move(reference, at?.position ?? [0, 0, 0], [
      num(call.args[0]) / DEG,
      num(call.args[1]) / DEG,
      num(call.args[2]) / DEG,
    ]);
    return null;
  });
  n('objectreference.moveto', async (call) => {
    const reference = self(call);
    const target = ref(call.args[0]);
    if (reference === undefined || target === undefined) return null;
    const at = await runtime.placement(target);
    if (!at) return null;
    const offset = [num(call.args[1]), num(call.args[2]), num(call.args[3])];
    const matchRotation = bool(call.args[4], true);
    const current = await runtime.placement(reference);
    runtime.move(
      reference,
      [
        at.position[0] + (offset[0] ?? 0),
        at.position[1] + (offset[1] ?? 0),
        at.position[2] + (offset[2] ?? 0),
      ],
      matchRotation ? [...at.rotation] : current?.rotation,
      at.cell,
      at.world,
    );
    return null;
  });
  n('objectreference.movetonode', async (call) => {
    // To the node of the target's model (its 3D must be loaded); its origin without one.
    const reference = self(call);
    const target = ref(call.args[0]);
    const at = target === undefined ? undefined : await runtime.placement(target);
    if (reference === undefined || target === undefined || !at) return null;
    const node = world.nodePlacement?.(target, str(call.args[1]));
    runtime.move(
      reference,
      node ? [...node.position] : [...at.position],
      node ? [...node.rotation] : [...at.rotation],
      at.cell,
      at.world,
    );
    return null;
  });
  n('objectreference.movetomyeditorlocation', (call) => {
    const reference = self(call);
    if (reference !== undefined) runtime.moveToEditorLocation(reference);
    return null;
  });
  // To where it would use the furniture: the marker it would take, facing its way (the
  // furniture's own place where the view does not hold it).
  n('objectreference.movetointeractionlocation', async (call) => {
    const reference = self(call);
    const target = ref(call.args[0]);
    const at = target === undefined ? undefined : await runtime.placement(target);
    if (reference === undefined || target === undefined || !at) return null;
    const from = (await runtime.placement(reference))?.position ?? at.position;
    const marker = await world.interactionLocation?.(target, from);
    if (marker) {
      runtime.move(reference, [...marker.position], [0, 0, marker.heading], at.cell, at.world);
    } else {
      runtime.move(reference, [...at.position], [...at.rotation], at.cell, at.world);
    }
    return null;
  });
  n('objectreference.getdistance', async (call) => {
    const a = await placement(self(call));
    const b = await placement(ref(call.args[0]));
    if (!a || !b) return 0;
    // References in different worlds or cells are infinitely far (a large number here).
    if (a.world !== b.world || (a.world === undefined && a.cell !== b.cell)) return 1e10;
    return Math.hypot(
      a.position[0] - b.position[0],
      a.position[1] - b.position[1],
      a.position[2] - b.position[2],
    );
  });
  n('objectreference.getheadingangle', async (call) => {
    const a = await placement(self(call));
    const b = await placement(ref(call.args[0]));
    if (!a || !b) return 0;
    // The angle from this reference's heading to the other (degrees, −180..180).
    const toOther = Math.atan2(b.position[0] - a.position[0], b.position[1] - a.position[1]);
    let angle = (toOther - a.rotation[2]) * DEG;
    angle = ((angle + 540) % 360) - 180;
    return angle;
  });
  n('objectreference.getparentcell', async (call) => {
    const at = await placement(self(call));
    return at?.cell === undefined ? null : object(at.cell, 'cell');
  });
  n('objectreference.getworldspace', async (call) => {
    const at = await placement(self(call));
    return at?.world === undefined ? null : object(at.world, 'worldspace');
  });
  n('objectreference.getcurrentlocation', async (call) => {
    const reference = self(call);
    return reference === undefined ? null : object(await runtime.locationOf(reference), 'location');
  });
  n('objectreference.geteditorlocation', async (call) => {
    const reference = self(call);
    return reference === undefined
      ? null
      : object(await runtime.editorLocation(reference), 'location');
  });
  n('objectreference.getscale', async (call) => (await placement(self(call)))?.scale ?? 1);
  n('objectreference.setscale', (call) => {
    const reference = self(call);
    if (reference !== undefined) {
      state.reference(reference).scale = num(call.args[0], 1);
      world.moved?.(reference);
    }
    return null;
  });
  for (const [name, axis] of [
    ['getwidth', 0],
    ['getlength', 1],
    ['getheight', 2],
  ] as const) {
    n(`objectreference.${name}`, async (call) => {
      const reference = self(call);
      return reference === undefined ? 0 : (await runtime.bounds(reference))[axis];
    });
  }
  n('objectreference.getmass', (call) => {
    const reference = self(call);
    return reference === undefined ? 0 : runtime.mass(reference);
  });
  n('objectreference.is3dloaded', (call) => {
    const reference = self(call);
    return reference !== undefined && (world.loaded?.(reference) ?? false);
  });

  // --- Items -------------------------------------------------------------------------------
  n('objectreference.additem', async (call) => {
    const reference = self(call);
    if (reference !== undefined)
      await runtime.addItem(
        reference,
        call.args[0] ?? null,
        Math.max(1, int(call.args[1], 1)),
        bool(call.args[2]),
      );
    return null;
  });
  n('objectreference.removeitem', async (call) => {
    const reference = self(call);
    if (reference !== undefined) {
      await runtime.removeItem(
        reference,
        call.args[0] ?? null,
        Math.max(1, int(call.args[1], 1)),
        bool(call.args[2]),
        ref(call.args[3]),
      );
    }
    return null;
  });
  n('objectreference.getitemcount', async (call) => {
    const reference = self(call);
    return reference === undefined ? 0 : runtime.itemCountOf(reference, call.args[0] ?? null);
  });
  n('objectreference.getallitemscount', async (call) => {
    const reference = self(call);
    if (reference === undefined) return 0;
    let total = 0;
    for (const count of (await runtime.inventory(reference)).values()) total += count;
    return total;
  });
  n('objectreference.iscontainerempty', async (call) => {
    const reference = self(call);
    if (reference === undefined) return true;
    for (const count of (await runtime.inventory(reference)).values()) if (count > 0) return false;
    return true;
  });
  // RemoveAllItems(akTransferTo, abKeepOwnership, abRemoveQuestItems): quest items (in a
  // running quest's Quest Object alias: quest-items.ts) stay unless abRemoveQuestItems.
  n('objectreference.removeallitems', async (call) => {
    const reference = self(call);
    if (reference === undefined) return null;
    const to = ref(call.args[0]);
    if (bool(call.args[2])) {
      await runtime.removeAllItems(reference, to);
      return null;
    }
    const kept = await questItems(runtime, reference);
    for (const [item, count] of [...(await runtime.inventory(reference))]) {
      const leaving = count - (kept.get(item) ?? 0);
      if (leaving > 0) {
        await runtime.removeItem(reference, runtime.formHandle(item), leaving, true, to);
      }
    }
    return null;
  });
  // RemoveAllStolenItems(akTransferTo): its stolen items go (to the other container).
  n('objectreference.removeallstolenitems', async (call) => {
    const reference = self(call);
    if (reference !== undefined) await runtime.crime.confiscate(reference, ref(call.args[0]));
    return null;
  });
  n('objectreference.dropobject', async (call) => {
    const reference = self(call);
    const item = formOf(call.args[0]);
    if (reference === undefined || item === undefined) return null;
    const count = Math.max(1, int(call.args[1], 1));
    const health = await runtime.removeItem(
      reference,
      call.args[0] ?? null,
      count,
      true,
      undefined,
    );
    const dropped = await runtime.placeAt(item, reference, count);
    runtime.dropped(dropped, health);
    return runtime.referenceHandle(dropped);
  });
  // An item reference's health as a fraction (1: whole; a tempered one's 1.1 and up): its own
  // (an improved item dropped from an inventory keeps it), else what the plugin placed it with
  // (REFR XHLT, a percent), else whole.
  n('objectreference.getitemhealthpercent', async (call) => {
    const reference = self(call);
    return reference === undefined ? 1 : runtime.itemHealth(reference);
  });
  n('objectreference.addinventoryeventfilter', (call) =>
    runtime.inventoryFilter(call.self, formOf(call.args[0]), 'add'),
  );
  n('objectreference.removeinventoryeventfilter', (call) =>
    runtime.inventoryFilter(call.self, formOf(call.args[0]), 'remove'),
  );
  n('objectreference.removeallinventoryeventfilters', (call) =>
    runtime.inventoryFilter(call.self, undefined, 'clear'),
  );
  // The base's container takes stolen items or not (crime-engine.ts allowStolen).
  n('objectreference.setcontainerallowstolenitems', async (call) => {
    const reference = self(call);
    if (reference !== undefined) await runtime.crime.allowStolen(reference, bool(call.args[0]));
    return null;
  });

  // --- Placing ---------------------------------------------------------------------------
  n('objectreference.placeatme', async (call) => {
    const reference = self(call);
    const form = formOf(call.args[0]);
    if (reference === undefined || form === undefined) return null;
    const created = await runtime.placeAt(form, reference, Math.max(1, int(call.args[1], 1)));
    if (bool(call.args[3])) await runtime.setEnabled(created, false);
    return runtime.referenceHandle(created);
  });
  n('objectreference.placeactoratme', async (call) => {
    const reference = self(call);
    const form = formOf(call.args[0]);
    if (reference === undefined || form === undefined) return null;
    return runtime.referenceHandle(await runtime.placeAt(form, reference, 1));
  });

  // --- Activation ----------------------------------------------------------------------
  n('objectreference.activate', async (call) => {
    const reference = self(call);
    if (reference === undefined) return false;
    return runtime.activate(reference, ref(call.args[0]), bool(call.args[1]));
  });
  n('objectreference.blockactivation', (call) => {
    const reference = self(call);
    if (reference !== undefined)
      state.reference(reference).activationBlocked = bool(call.args[0], true);
    return null;
  });
  n('objectreference.isactivationblocked', (call) => {
    const reference = self(call);
    return reference !== undefined && state.references.get(reference)?.activationBlocked === true;
  });
  n('objectreference.isactivatechild', async (call) => {
    const reference = self(call);
    const child = ref(call.args[0]);
    return (
      reference !== undefined &&
      child !== undefined &&
      (await runtime.activateParents(child)).includes(reference)
    );
  });

  // --- Doors, locks, owners, destruction --------------------------------------------------
  n('objectreference.setopen', (call) => {
    const reference = self(call);
    if (reference !== undefined) runtime.setOpen(reference, bool(call.args[0], true));
    return null;
  });
  n('objectreference.getopenstate', async (call) => {
    const reference = self(call);
    return reference === undefined ? 0 : runtime.openState(reference);
  });
  // Lock(abLock, abAsOwner): as its owner, no crime in it (the door's places open to the
  // player again, or off limits locked with them in: crime-engine.ts lockedAsOwner).
  n('objectreference.lock', async (call) => {
    const reference = self(call);
    if (reference === undefined) return null;
    const locked = bool(call.args[0], true);
    await runtime.setLocked(reference, locked);
    if (bool(call.args[1])) await runtime.crime.lockedAsOwner(reference, locked);
    return null;
  });
  n('objectreference.islocked', async (call) => {
    const reference = self(call);
    return reference !== undefined && (await runtime.lock(reference)).locked;
  });
  // The original's rule: the lock is broken once its failed tries reach one, or two while the
  // player has an Ignore Broken Lock perk entry that gives a value.
  n('objectreference.islockbroken', async (call) => {
    const reference = self(call);
    if (reference === undefined) return false;
    const tries = state.references.get(reference)?.lockTries ?? 0;
    if (tries === 0) return false;
    const ignore = await runtime.perks.apply(EntryPoint.ignoreBrokenLock, PLAYER_REF, 0);
    return lockBroken(tries, ignore);
  });
  n('objectreference.getlocklevel', async (call) => {
    const reference = self(call);
    return reference === undefined ? 0 : (await runtime.lock(reference)).level;
  });
  n('objectreference.setlocklevel', (call) => {
    const reference = self(call);
    if (reference !== undefined) state.reference(reference).lockLevel = int(call.args[0]);
    return null;
  });
  n('objectreference.getactorowner', async (call) => {
    const reference = self(call);
    return reference === undefined
      ? null
      : object((await runtime.owner(reference)).actor, 'actorbase');
  });
  n('objectreference.getfactionowner', async (call) => {
    const reference = self(call);
    return reference === undefined
      ? null
      : object((await runtime.owner(reference)).faction, 'faction');
  });
  n('objectreference.setactorowner', (call) => {
    const reference = self(call);
    if (reference !== undefined) {
      const owner = state.reference(reference);
      owner.ownerActor = formOf(call.args[0]) ?? 0;
      owner.ownerFaction = 0;
    }
    return null;
  });
  n('objectreference.setfactionowner', (call) => {
    const reference = self(call);
    if (reference !== undefined) {
      const owner = state.reference(reference);
      owner.ownerFaction = formOf(call.args[0]) ?? 0;
      owner.ownerActor = 0;
    }
    return null;
  });
  // Destruction (destruction-engine.ts): the reference's health, stages and destroyed state.
  n('objectreference.setdestroyed', (call) => {
    const reference = self(call);
    if (reference !== undefined)
      runtime.destruction.setDestroyed(reference, bool(call.args[0], true));
    return null;
  });
  n('objectreference.isdestroyed', (call) => {
    const reference = self(call);
    return reference !== undefined && runtime.destruction.isDestroyed(reference);
  });
  n('objectreference.getcurrentdestructionstage', (call) => {
    const reference = self(call);
    return reference === undefined ? 0 : runtime.destruction.stage(reference);
  });
  n('objectreference.damageobject', async (call) => {
    const reference = self(call);
    if (reference !== undefined) await runtime.damageObject(reference, num(call.args[0]));
    return null;
  });
  n('objectreference.blowup', async (call) => {
    const reference = self(call);
    if (reference !== undefined) await runtime.destruction.blowUp(reference);
    return null;
  });
  n('objectreference.cleardestruction', (call) => {
    const reference = self(call);
    if (reference !== undefined) runtime.destruction.clear(reference);
    return null;
  });

  // --- Map markers (the map: src/shell/map-menu.ts; discovery: compass.ts) -------------------
  n('objectreference.addtomap', (call) => {
    const reference = self(call);
    if (reference !== undefined) runtime.mapMarker(reference, true, bool(call.args[0]));
    return null;
  });
  n('objectreference.enablefasttravel', (call) => {
    const reference = self(call);
    if (reference !== undefined) runtime.mapMarker(reference, undefined, bool(call.args[0], true));
    return null;
  });
  n('objectreference.ismapmarkervisible', (call) => {
    const reference = self(call);
    return reference !== undefined && runtime.mapMarkerVisible(reference);
  });
  n('objectreference.canfasttraveltomarker', (call) => {
    const reference = self(call);
    return reference !== undefined && runtime.mapMarkerFastTravel(reference);
  });

  // --- Animation and physics (the engine) ----------------------------------------------------
  n('objectreference.playanimation', (call) => {
    const reference = self(call);
    return (
      reference !== undefined && (world.animationEvent?.(reference, str(call.args[0])) ?? false)
    );
  });
  n('objectreference.playanimationandwait', async (call) => {
    const reference = self(call);
    if (
      reference === undefined ||
      !(world.animationEvent?.(reference, str(call.args[0])) ?? false)
    ) {
      return false;
    }
    await call.latent(runtime.animationEventRaised(reference, str(call.args[1])));
    return true;
  });
  n('objectreference.waitforanimationevent', async (call) => {
    const reference = self(call);
    if (reference === undefined) return false;
    await call.latent(runtime.animationEventRaised(reference, str(call.args[0])));
    return true;
  });
  n('objectreference.playgamebryoanimation', (call) => {
    const reference = self(call);
    return (
      reference !== undefined &&
      (world.sequence?.(reference, str(call.args[0]), bool(call.args[1])) ?? false)
    );
  });
  for (const kind of ['bool', 'int', 'float'] as const) {
    n(`objectreference.getanimationvariable${kind}`, (call) => {
      const reference = self(call);
      const value =
        reference === undefined
          ? undefined
          : world.animationVariable?.(reference, str(call.args[0]));
      return kind === 'bool'
        ? (value ?? 0) !== 0
        : kind === 'int'
          ? Math.trunc(value ?? 0)
          : (value ?? 0);
    });
    n(`objectreference.setanimationvariable${kind}`, (call) => {
      const reference = self(call);
      if (reference !== undefined)
        world.setAnimationVariable?.(reference, str(call.args[0]), num(call.args[1]));
      return null;
    });
  }
  n('objectreference.setmotiontype', (call) => {
    const reference = self(call);
    if (reference !== undefined) {
      state.reference(reference).motionType = int(call.args[0]);
      // A script that moves an object wakes it (it no longer waits for the player's touch).
      world.motionTypeChanged?.(reference, int(call.args[0]));
    }
    return null;
  });
  n('objectreference.applyhavokimpulse', async (call) => {
    const reference = self(call);
    if (reference !== undefined) {
      // The magnitude is a gameplay impulse on each body, by its layer (explosions.ts).
      const settings = await runtime.casting.explosionSettings();
      world.impulse?.(
        reference,
        [num(call.args[0]), num(call.args[1]), num(call.args[2])],
        num(call.args[3]),
        (layer) => gameplayImpulse(1, layer, undefined, settings),
      );
    }
    return null;
  });
  n('objectreference.pushactoraway', (call) => {
    const reference = self(call);
    const pushed = ref(call.args[0]);
    if (reference !== undefined && pushed !== undefined)
      world.pushAway?.(pushed, reference, num(call.args[1]));
    return null;
  });
  n('objectreference.translateto', async (call) => {
    const reference = self(call);
    if (reference === undefined) return null;
    const a = call.args.map((value) => num(value));
    await runtime.translate(
      reference,
      [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0],
      [(a[3] ?? 0) / DEG, (a[4] ?? 0) / DEG, (a[5] ?? 0) / DEG],
      a[6] ?? 0,
    );
    return null;
  });
  n('objectreference.splinetranslateto', async (call) => {
    const reference = self(call);
    if (reference === undefined) return null;
    const a = call.args.map((value) => num(value));
    await runtime.translate(
      reference,
      [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0],
      [(a[3] ?? 0) / DEG, (a[4] ?? 0) / DEG, (a[5] ?? 0) / DEG],
      a[7] ?? 0,
    );
    return null;
  });
  n('objectreference.splinetranslatetorefnode', async (call) => {
    const reference = self(call);
    const target = ref(call.args[0]);
    const at = target === undefined ? undefined : await runtime.placement(target);
    if (reference !== undefined && at)
      await runtime.translate(reference, [...at.position], [...at.rotation], num(call.args[3]));
    return null;
  });
  n('objectreference.stoptranslation', (call) => {
    const reference = self(call);
    if (reference !== undefined) runtime.stopTranslation(reference);
    return null;
  });
  // ForceAddRagdollToWorld: a dead actor's ragdoll goes into the world at once (a hanged
  // corpse's OnLoad, before AddHavokBallAndSocketConstraint hangs it by its hands and feet).
  n('objectreference.forceaddragdolltoworld', async (call) => {
    const reference = self(call);
    if (reference !== undefined) await world.addRagdoll?.(reference);
    return null;
  });
  // ForceRemoveRagdollFromWorld: observed in the original, its counterpart (latent too: the
  // thread waits while the main thread takes the actor's ragdoll out of the physics world).
  n('objectreference.forceremoveragdollfromworld', async (call) => {
    const reference = self(call);
    if (reference !== undefined) await world.removeRagdoll?.(reference);
    return null;
  });
  for (const [name, added] of [
    ['objectreference.adddependentanimatedobjectreference', true],
    ['objectreference.removedependentanimatedobjectreference', false],
  ] as const) {
    n(name, (call) => {
      const reference = self(call);
      const dependent = ref(call.args[0]);
      return (
        reference !== undefined &&
        dependent !== undefined &&
        (world.dependentAnimated?.(reference, dependent, added) ?? false)
      );
    });
  }
  n('objectreference.hasnode', (call) => {
    const reference = self(call);
    return reference !== undefined && (world.hasNode?.(reference, str(call.args[0])) ?? false);
  });
  // PlayImpactEffect(akImpactEffect, asNodeName, afPickDirX..Z, afPickLength, ...): the impact
  // for the surface a ray from the node meets (its sound and decal). TODO(M13): the pick
  // direction turned by the node's rotation (abApplyNodeRotation, abUseNodeLocalRotation).
  n('objectreference.playimpacteffect', (call) => {
    const reference = self(call);
    const set = formOf(call.args[0]);
    if (reference === undefined || set === undefined) return false;
    const direction: [number, number, number] = [
      num(call.args[2]),
      num(call.args[3]),
      num(call.args[4], -1),
    ];
    return (
      world.impactEffect?.(reference, set, str(call.args[1]), direction, num(call.args[5], 512)) ??
      false
    );
  });
  // PlayTerrainEffect(asEffectModelName, asAttachBoneName): observed in the original, a
  // temporary terrain effect of the model at the reference (an actor's own kind of ground
  // under it), attached to the named node of its 3D where it has one; one it cannot set up is
  // the original's error "Could not set up terrain effect."
  n('objectreference.playterraineffect', (call) => {
    const reference = self(call);
    if (reference === undefined) return null;
    const shown = world.terrainEffect?.(reference, str(call.args[0]), str(call.args[1]));
    if (shown === false)
      runtime.warn(`${call.where()}: ${formatValue(call.self)} Could not set up terrain effect.`);
    return null;
  });
  // PlaySyncedAnimationSS(asAnimation1, akObj2, asAnimation2) and ...AndWaitSS(asAnimation1,
  // asEvent1, akObj2, asAnimation2, asEvent2): observed in the original, two references that
  // are no actors are sent an animation event each in the same call; true when either took.
  // A None second object, or an actor on either side, is the original's error and false. The
  // waiting one then waits for the events (asEvent1 from the first, asEvent2 from the second)
  // of those whose animation took.
  const synced = async (
    call: NativeCall,
    first: string,
    other: Value | undefined,
    second: string,
  ): Promise<readonly [number, number, boolean, boolean] | undefined> => {
    const reference = self(call);
    const partner = ref(other);
    if (reference === undefined) return undefined;
    if (partner === undefined) {
      runtime.warn(`${call.where()}: Cannot play an animation on a None object`);
      return undefined;
    }
    const isActor = async (value: Value): Promise<boolean> =>
      value instanceof ObjectHandle && (await runtime.formType(value)) === 'actor';
    if (await isActor(call.self)) {
      runtime.warn(
        `${call.where()}: ${formatValue(call.self)} is an Actor, and PlaySyncedAnimationSS should not be called on it.`,
      );
      return undefined;
    }
    if (await isActor(other ?? null)) {
      runtime.warn(
        `${call.where()}: ${formatValue(other ?? null)} is an Actor, and should not be passed to PlaySyncedAnimationSS.`,
      );
      return undefined;
    }
    const firstTook = world.animationEvent?.(reference, first) ?? false;
    const secondTook = world.animationEvent?.(partner, second) ?? false;
    return [reference, partner, firstTook, secondTook];
  };
  n('objectreference.playsyncedanimationss', async (call) => {
    const played = await synced(call, str(call.args[0]), call.args[1], str(call.args[2]));
    return played !== undefined && (played[2] || played[3]);
  });
  n('objectreference.playsyncedanimationandwaitss', async (call) => {
    const played = await synced(call, str(call.args[0]), call.args[2], str(call.args[3]));
    if (played === undefined || !(played[2] || played[3])) return false;
    const [reference, partner, firstTook, secondTook] = played;
    await call.latent(
      Promise.all([
        firstTook ? runtime.animationEventRaised(reference, str(call.args[1])) : undefined,
        secondTook ? runtime.animationEventRaised(partner, str(call.args[4])) : undefined,
      ]),
    );
    return true;
  });
  // A cart hitched to a horse: the horse pulls it (src/shell/actor-vehicles.ts).
  n('objectreference.tethertohorse', (call) => {
    const cart = self(call);
    const horse = ref(call.args[0]);
    if (cart === undefined || horse === undefined) return null;
    state.reference(cart).horse = horse;
    world.tether?.(cart, horse);
    return null;
  });

  // --- Combat, crime, dialogue, traps -----------------------------------------------------------
  n('objectreference.say', (call) => {
    const reference = self(call);
    if (reference !== undefined)
      runtime.say(reference, formOf(call.args[0]), ref(call.args[1]), bool(call.args[2]));
    return null;
  });
  n('objectreference.isindialoguewithplayer', (call) => {
    const reference = self(call);
    return reference !== undefined && reference === runtime.dialogueSpeaker;
  });
  // A noise here (detection: src/shell/actor-senses.ts): CreateDetectionEvent(akOwner,
  // aiSoundLevel: 0 loud, 1 normal, 2 silent, 3 very loud).
  n('objectreference.createdetectionevent', (call) => {
    const reference = self(call);
    if (reference !== undefined)
      world.detectionEvent?.(reference, ref(call.args[0]), int(call.args[1], 0));
    return null;
  });
  // SendStealAlarm(akThief): as if the thief stole this: an alarm, and the theft reported by
  // those who see the thief (crime-engine.ts).
  n('objectreference.sendstealalarm', async (call) => {
    const reference = self(call);
    const thief = ref(call.args[0]);
    if (reference === undefined) return null;
    world.alarm?.(reference, thief, 'steal');
    if (thief !== undefined) await runtime.crime.stealAlarm(thief, reference);
    return null;
  });
  // KnockAreaEffect(afMagnitude, afRadius): the actors within the radius are pushed away from
  // this reference (as PushActorAway).
  n('objectreference.knockareaeffect', async (call) => {
    const reference = self(call);
    const at = reference === undefined ? undefined : await runtime.placement(reference);
    if (reference === undefined || !at) return null;
    const radius = num(call.args[1]);
    for (const other of world.loadedReferences?.() ?? []) {
      if (other === reference || !(await runtime.actors.isActor(other))) continue;
      const there = await runtime.placement(other);
      if (!there) continue;
      const distance = Math.hypot(
        there.position[0] - at.position[0],
        there.position[1] - at.position[1],
        there.position[2] - at.position[2],
      );
      if (distance <= radius) world.pushAway?.(other, reference, num(call.args[0]));
    }
    return null;
  });
  // ProcessTrapHit(akTrap, afDamage, afPushback, velocity, position, material, stagger): a
  // trap's blow on this reference: the damage to an actor's health, blamed on the actor the
  // trap's doings are (SetActorCause), and the push away from the trap. TODO(M13): the
  // stagger (afStagger) and the hit's material impact (aeMaterial).
  n('objectreference.processtraphit', async (call) => {
    const reference = self(call);
    const trap = ref(call.args[0]);
    if (reference === undefined) return null;
    const cause = trap === undefined ? undefined : state.references.get(trap)?.actorCause;
    if (await runtime.actors.isActor(reference)) {
      await runtime.actors.damage(reference, ActorValue.health, num(call.args[1]), cause);
    }
    const pushback = num(call.args[2]);
    if (pushback > 0 && trap !== undefined) world.pushAway?.(reference, trap, pushback);
    return null;
  });
  // InterruptCast: what this reference (an actor, a trap's caster) casts stops (casting-engine.ts).
  n('objectreference.interruptcast', (call) => {
    const reference = self(call);
    if (reference !== undefined) runtime.casting.interrupt(reference);
    return null;
  });
  // Friends' and allies' blows never turn it on them (src/shell/actor-combat-ai.ts).
  n('objectreference.ignorefriendlyhits', (call) => {
    const reference = self(call);
    if (reference !== undefined)
      state.reference(reference).ignoreFriendlyHits = bool(call.args[0], true);
    return null;
  });
  n('objectreference.isignoringfriendlyhits', (call) => {
    const reference = self(call);
    return reference !== undefined && state.references.get(reference)?.ignoreFriendlyHits === true;
  });
  // A follower may not be asked to use it (the favor commands: src/shell/actor-favors.ts).
  n('objectreference.setnofavorallowed', (call) => {
    const reference = self(call);
    if (reference !== undefined) state.reference(reference).noFavor = bool(call.args[0], true);
    return null;
  });
  // The actor its doings are blamed on (a trap's hits: ProcessTrapHit).
  n('objectreference.setactorcause', (call) => {
    const reference = self(call);
    if (reference !== undefined) state.reference(reference).actorCause = ref(call.args[0]);
    return null;
  });
  // A magic effect with the keyword on it (magic-engine.ts).
  n('objectreference.haseffectkeyword', async (call) => {
    const reference = self(call);
    const keyword = formOf(call.args[0]);
    return (
      reference !== undefined &&
      keyword !== undefined &&
      (await runtime.magic.hasEffectKeyword(reference, keyword))
    );
  });
  n('objectreference.getcurrentscene', (call) => {
    const reference = self(call);
    return reference === undefined ? null : object(runtime.scenes.sceneOf(reference), 'scene');
  });
  n('objectreference.gettriggerobjectcount', (call) => {
    const reference = self(call);
    return reference === undefined ? 0 : (world.triggerCount?.(reference) ?? 0);
  });
  n('objectreference.isfurnitureinuse', (call) => {
    const reference = self(call);
    return reference !== undefined && (world.furnitureInUse?.(reference) ?? false);
  });
  n('objectreference.isfurnituremarkerinuse', (call) => {
    const reference = self(call);
    return (
      reference !== undefined && (world.furnitureInUse?.(reference, int(call.args[0])) ?? false)
    );
  });
  // CalculateEncounterLevel(aiDifficulty = 4), observed in the original: the level of the
  // reference's encounter zone (the player's level without one) times the difficulty's
  // fLeveledActorMult (0 easy to 3 very hard; any other: 1), rounded down, at least 1.
  n('objectreference.calculateencounterlevel', async (call) => {
    const reference = self(call);
    if (reference === undefined) return 0;
    const level = await runtime.progression.encounterLevel(reference);
    const difficulty = int(call.args[0], 4);
    const { leveling } = await runtime.progression.settings();
    const mult =
      difficulty >= 0 && difficulty < 4 ? (leveling.levelModifierMults[difficulty] ?? 1) : 1;
    return Math.max(1, Math.floor(Math.fround(mult * level)));
  });
  n('objectreference.reset', async (call) => {
    const reference = self(call);
    if (reference !== undefined) await runtime.resetReference(reference, ref(call.args[0]));
    return null;
  });
}
