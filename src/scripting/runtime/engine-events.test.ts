// The engine's own events to the scripts, where the runtime makes them (not the hub's relay,
// script-events.test.ts): registrations it answers (game-time updates, animation events, line
// of sight), the lock's change, the race switch and the natives that tell vampirism and
// lycanthropy. Expected moments and arguments: the base scripts' declarations and the Creation
// Kit's event pages.

import { describe, expect, it } from 'vitest';
import type { RecordDatabase } from '../../world/record-db.ts';
import type { NativeCall } from '../papyrus-vm.ts';
import { ScriptLibrary } from '../script-library.ts';
import { formatValue, ObjectHandle, type Value } from '../values.ts';
import { ScriptRuntime } from './runtime.ts';

const DOOR = 0x100;
const NPC = 0x200;
const QUEST = 0x300;
const VICTIM = 0x400;

/** A runtime without plugins whose sent events are listed: `event target (args)`. */
function runtime(): { runtime: ScriptRuntime; sent: string[] } {
  const db = {
    plugins: [],
    get: () => Promise.resolve(undefined),
    worldOfCell: () => undefined,
    cellOfReference: () => undefined,
    formIdsOfType: () => [],
  } as unknown as RecordDatabase;
  const made = new ScriptRuntime(db, new ScriptLibrary(() => Promise.resolve(undefined)));
  const sent: string[] = [];
  const show = (value: Value): string =>
    value instanceof ObjectHandle ? value.formId.toString(16) : formatValue(value);
  made.vm.sendEvent = (target: ObjectHandle, event: string, args: readonly Value[]) => {
    sent.push(`${event} ${target.formId.toString(16)} (${args.map(show).join(', ')})`);
    return Promise.resolve();
  };
  return { runtime: made, sent };
}

/** Lets the detached sends run. */
const settle = async (scripts: ScriptRuntime): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await scripts.vm.idle();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

/** Calls a native as a script would, on `self`. */
async function callNative(
  scripts: ScriptRuntime,
  script: string,
  name: string,
  self: ObjectHandle,
  args: Value[],
): Promise<Value> {
  const native = scripts.native(script, name);
  if (!native) throw new Error(`no native ${script}.${name}`);
  const call: NativeCall = {
    vm: scripts.vm,
    self,
    args,
    name: `${script}.${name}`,
    latent: (promise) => promise,
    where: () => 'test',
  };
  return native(call);
}

describe('natives that ask the shell and the quests', () => {
  it('answers UsingGamepad by the device last used, and IsStarting/IsStopping by the quests', async () => {
    const { runtime: scripts } = runtime();
    const quest = new ObjectHandle(QUEST, 'quest');
    const game = new ObjectHandle(0, 'game');
    expect(await callNative(scripts, 'game', 'usinggamepad', game, [])).toBe(false);
    scripts.world.usingGamepad = () => true;
    expect(await callNative(scripts, 'game', 'usinggamepad', game, [])).toBe(true);
    scripts.quests.starting.add(QUEST);
    expect(await callNative(scripts, 'quest', 'isstarting', quest, [])).toBe(true);
    expect(await callNative(scripts, 'quest', 'isstopping', quest, [])).toBe(false);
  });
});

describe('the events the runtime sends', () => {
  it('sends OnUpdateGameTime once the game hours registered for have passed', async () => {
    const { runtime: scripts, sent } = runtime();
    const quest = new ObjectHandle(QUEST, 'quest');
    // RegisterForSingleUpdateGameTime(2.0): two game hours.
    scripts.registerUpdate(quest, 2, true, false);
    scripts.vm.scheduler.advance(0, 1 / 24);
    await settle(scripts);
    expect(sent).toEqual([]);
    scripts.vm.scheduler.advance(0, 1 / 24);
    await settle(scripts);
    expect(sent).toEqual(['OnUpdateGameTime 300 ()']);
    // A single update is not sent again.
    scripts.vm.scheduler.advance(0, 4 / 24);
    await settle(scripts);
    expect(sent).toHaveLength(1);
  });

  it('sends OnUpdate each interval of real seconds until unregistered', async () => {
    const { runtime: scripts, sent } = runtime();
    const quest = new ObjectHandle(QUEST, 'quest');
    // RegisterForUpdate(0.5): every half second.
    scripts.registerUpdate(quest, 0.5, false, true);
    for (let i = 0; i < 4; i++) {
      scripts.vm.scheduler.advance(0.25, 0);
      await settle(scripts);
    }
    expect(sent).toEqual(['OnUpdate 300 ()', 'OnUpdate 300 ()']);
    scripts.unregisterUpdate(quest, false);
    scripts.vm.scheduler.advance(1, 0);
    await settle(scripts);
    expect(sent).toHaveLength(2);
  });

  it('sends OnAnimationEvent(the source, the event) to those registered for it', async () => {
    const { runtime: scripts, sent } = runtime();
    const quest = new ObjectHandle(QUEST, 'quest');
    scripts.registerAnimationEvent(quest, scripts.referenceHandle(NPC), 'weaponSwing', true);
    scripts.animationEvent(NPC, 'weaponLeftSwing');
    scripts.animationEvent(NPC, 'weaponSwing');
    await settle(scripts);
    expect(sent).toEqual(['OnAnimationEvent 300 (200, weaponSwing)']);
  });

  it('sends OnGainLOS and OnLostLOS(viewer, target) as the sight changes', async () => {
    const { runtime: scripts, sent } = runtime();
    const quest = new ObjectHandle(QUEST, 'quest');
    const viewer = scripts.referenceHandle(NPC);
    const seen = scripts.referenceHandle(VICTIM);
    scripts.registerLineOfSight(quest, viewer, seen, 'registerforlos');
    scripts.lineOfSightChanged(NPC, VICTIM, true);
    scripts.lineOfSightChanged(NPC, VICTIM, false);
    // A single gain is sent once, then its registration is gone.
    scripts.registerLineOfSight(quest, seen, viewer, 'registerforsinglelosgain');
    scripts.lineOfSightChanged(VICTIM, NPC, true);
    scripts.lineOfSightChanged(VICTIM, NPC, false);
    scripts.lineOfSightChanged(VICTIM, NPC, true);
    await settle(scripts);
    expect(sent).toEqual([
      'OnGainLOS 300 (200, 400)',
      'OnLostLOS 300 (200, 400)',
      'OnGainLOS 300 (400, 200)',
    ]);
  });

  it('sends OnLockStateChanged as a lock is locked or unlocked, not when it stays', async () => {
    const { runtime: scripts, sent } = runtime();
    await scripts.setLocked(DOOR, true);
    await scripts.setLocked(DOOR, true);
    await scripts.setLocked(DOOR, false);
    await settle(scripts);
    expect(sent).toEqual(['OnLockStateChanged 100 ()', 'OnLockStateChanged 100 ()']);
  });

  it('sends OnRaceSwitchComplete once SetRace’s new 3D stands', async () => {
    const { runtime: scripts, sent } = runtime();
    let made = (): void => undefined;
    scripts.world.raceChanged = () =>
      new Promise<void>((resolve) => {
        made = resolve;
      });
    await callNative(scripts, 'actor', 'setrace', scripts.actorHandle(NPC), [
      new ObjectHandle(0x500, 'race'),
    ]);
    await settle(scripts);
    expect(sent).toEqual([]);
    made();
    await settle(scripts);
    expect(sent).toEqual(['OnRaceSwitchComplete 200 ()']);
  });

  it('sends the vampirism and lycanthropy events the natives tell, and OnVampireFeed', async () => {
    const { runtime: scripts, sent } = runtime();
    const actor = scripts.actorHandle(NPC);
    await callNative(scripts, 'actor', 'sendvampirismstatechanged', actor, [true]);
    await callNative(scripts, 'actor', 'sendlycanthropystatechanged', actor, [false]);
    await callNative(scripts, 'actor', 'startvampirefeed', actor, [scripts.actorHandle(VICTIM)]);
    await settle(scripts);
    expect(sent).toEqual([
      'OnVampirismStateChanged 200 (True)',
      'OnLycanthropyStateChanged 200 (False)',
      'OnVampireFeed 200 (400)',
    ]);
  });

  it('puts the Vampire Feed and Cannibal packages on the feeder; one with no AI here feeds at once', async () => {
    const { runtime: scripts } = runtime();
    const put: string[] = [];
    let accepts = true;
    scripts.world.putCreatedPackage = (actor, kind, _runner, target) => {
      put.push(`${kind} ${actor.toString(16)} on ${target?.toString(16)}`);
      return accepts;
    };
    const actor = scripts.actorHandle(NPC);
    await callNative(scripts, 'actor', 'startvampirefeed', actor, [scripts.actorHandle(VICTIM)]);
    await callNative(scripts, 'actor', 'startcannibal', actor, [scripts.actorHandle(VICTIM)]);
    expect(put).toEqual(['vampireFeed 200 on 400', 'cannibal 200 on 400']);
    // The package feeds as it runs: not yet.
    expect(scripts.state.actors.get(NPC)?.feeding).toBeUndefined();
    accepts = false;
    await callNative(scripts, 'actor', 'startvampirefeed', actor, [scripts.actorHandle(VICTIM)]);
    expect(scripts.state.actors.get(NPC)?.feeding?.kind).toBe('vampire');
  });
});
