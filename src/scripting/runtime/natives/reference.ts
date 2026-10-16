// Natives of ObjectReference (signatures: the game's ObjectReference.pex). The state a script
// can read back (placement, enable state, open and lock state, owners, destruction, items,
// linked references) is kept here; what the engine shows goes through the WorldBridge.
// Angles are degrees in Papyrus and radians in the game state. Platform-independent.
// Notes: docs/scripting.md ("Natives").

import { ObjectHandle, type Value } from '../../values.ts';
import type { ScriptRuntime } from '../runtime.ts';
import { bool, formOf, int, num, object, str, type Register } from './args.ts';

const DEG = 180 / Math.PI;

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
      if (reference !== undefined) await runtime.setEnabled(reference, enable);
      return null;
    });
  }
  n('objectreference.isdisabled', async (call) => {
    const reference = self(call);
    return reference === undefined || !(await runtime.isEnabled(reference));
  });
  n('objectreference.delete', (call) => {
    const reference = self(call);
    if (reference !== undefined) {
      state.reference(reference).deleted = true;
      world.enableChanged?.(reference, false);
    }
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
  n('objectreference.movetointeractionlocation', async (call) => {
    // TODO(M10): the furniture's entry point; its place until then.
    const reference = self(call);
    const target = ref(call.args[0]);
    const at = target === undefined ? undefined : await runtime.placement(target);
    if (reference !== undefined && at)
      runtime.move(reference, [...at.position], [...at.rotation], at.cell, at.world);
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
  n('objectreference.removeallitems', async (call) => {
    const reference = self(call);
    // TODO(M11): quest items (in a Quest Object alias) stay unless abRemoveQuestItems.
    if (reference !== undefined) await runtime.removeAllItems(reference, ref(call.args[0]));
    return null;
  });
  n('objectreference.removeallstolenitems', () => null);
  n('objectreference.dropobject', async (call) => {
    const reference = self(call);
    const item = formOf(call.args[0]);
    if (reference === undefined || item === undefined) return null;
    const count = Math.max(1, int(call.args[1], 1));
    await runtime.removeItem(reference, call.args[0] ?? null, count, true, undefined);
    return runtime.referenceHandle(await runtime.placeAt(item, reference, count));
  });
  n('objectreference.getitemhealthpercent', () => 1);
  n('objectreference.addinventoryeventfilter', (call) =>
    runtime.inventoryFilter(call.self, formOf(call.args[0]), 'add'),
  );
  n('objectreference.removeinventoryeventfilter', (call) =>
    runtime.inventoryFilter(call.self, formOf(call.args[0]), 'remove'),
  );
  n('objectreference.removeallinventoryeventfilters', (call) =>
    runtime.inventoryFilter(call.self, undefined, 'clear'),
  );
  n('objectreference.setcontainerallowstolenitems', () => null);

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
  n('objectreference.lock', async (call) => {
    const reference = self(call);
    if (reference === undefined) return null;
    const before = await runtime.lock(reference);
    const entry = state.reference(reference);
    entry.locked = bool(call.args[0], true);
    // Locking what has no lock gives it a novice one. TODO(M11): abAsOwner (no crime).
    if (entry.locked && !before.locked && before.level === 0) entry.lockLevel = 1;
    world.lockChanged?.(reference);
    return null;
  });
  n('objectreference.islocked', async (call) => {
    const reference = self(call);
    return reference !== undefined && (await runtime.lock(reference)).locked;
  });
  n('objectreference.islockbroken', () => false);
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
  n('objectreference.setdestroyed', (call) => {
    const reference = self(call);
    if (reference !== undefined) {
      state.reference(reference).destroyed = bool(call.args[0], true);
      world.destructionChanged?.(reference);
    }
    return null;
  });
  n('objectreference.isdestroyed', (call) => {
    const reference = self(call);
    return reference !== undefined && state.references.get(reference)?.destroyed === true;
  });
  n('objectreference.getcurrentdestructionstage', (call) => {
    const reference = self(call);
    return reference === undefined ? 0 : (state.references.get(reference)?.destructionStage ?? 0);
  });
  n('objectreference.damageobject', async (call) => {
    const reference = self(call);
    if (reference !== undefined) await runtime.damageObject(reference, num(call.args[0]));
    return null;
  });
  n('objectreference.cleardestruction', (call) => {
    const reference = self(call);
    if (reference !== undefined) {
      const entry = state.reference(reference);
      entry.destroyed = false;
      entry.destructionStage = 0;
      world.destructionChanged?.(reference);
    }
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
  n('objectreference.applyhavokimpulse', (call) => {
    const reference = self(call);
    if (reference !== undefined) {
      world.impulse?.(
        reference,
        [num(call.args[0]), num(call.args[1]), num(call.args[2])],
        num(call.args[3]),
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
  n('objectreference.forceaddragdolltoworld', () => null);
  n('objectreference.forceremoveragdollfromworld', () => null);
  n('objectreference.adddependentanimatedobjectreference', () => true);
  n('objectreference.removedependentanimatedobjectreference', () => true);
  n('objectreference.hasnode', (call) => {
    const reference = self(call);
    return reference !== undefined && (world.hasNode?.(reference, str(call.args[0])) ?? false);
  });
  n('objectreference.playimpacteffect', () => true);
  n('objectreference.playterraineffect', () => null);
  n('objectreference.playsyncedanimationss', () => false);
  n('objectreference.playsyncedanimationandwaitss', () => false);
  n('objectreference.tethertohorse', () => null);

  // --- Combat, crime, dialogue (TODO(M10)/(M11)) ----------------------------------------------
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
  n('objectreference.createdetectionevent', () => null);
  n('objectreference.sendstealalarm', () => null);
  n('objectreference.knockareaeffect', () => null);
  n('objectreference.processtraphit', () => null);
  n('objectreference.interruptcast', () => null);
  n('objectreference.ignorefriendlyhits', () => null);
  n('objectreference.isignoringfriendlyhits', () => false);
  n('objectreference.setnofavorallowed', () => null);
  n('objectreference.setactorcause', () => null);
  n('objectreference.haseffectkeyword', () => false);
  n('objectreference.getcurrentscene', (call) => {
    const reference = self(call);
    return reference === undefined ? null : object(runtime.sceneOf(reference), 'scene');
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
  n('objectreference.calculateencounterlevel', () => 1);
  n('objectreference.reset', async (call) => {
    const reference = self(call);
    if (reference !== undefined) await runtime.resetReference(reference, ref(call.args[0]));
    return null;
  });
}
