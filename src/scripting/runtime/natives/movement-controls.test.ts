import { describe, expect, it } from 'vitest';
import type { RecordDatabase } from '../../../world/record-db.ts';
import type { NativeCall } from '../../papyrus-vm.ts';
import { ScriptLibrary } from '../../script-library.ts';
import { ObjectHandle, type Value } from '../../values.ts';
import { ScriptRuntime, type WorldBridge } from '../runtime.ts';
import { PLACEHOLDER_NATIVES, UNBOUND_NATIVES } from './placeholders.ts';

/** A runtime without plugins, its world the given hooks; its warnings collected. */
function runtime(world: WorldBridge, warnings: string[] = []): ScriptRuntime {
  const db = {
    plugins: [],
    get: () => Promise.resolve(undefined),
    worldOfCell: () => undefined,
    cellOfReference: () => undefined,
    formIdsOfType: () => [],
  } as unknown as RecordDatabase;
  return new ScriptRuntime(db, new ScriptLibrary(() => Promise.resolve(undefined)), {
    world,
    warn: (message) => warnings.push(message),
  });
}

const ACTOR = 0x1a2b3;
const OTHER = 0x1a2b4;
const actor = (formId: number): ObjectHandle => new ObjectHandle(formId, 'actor');
const ref = (formId: number): ObjectHandle => new ObjectHandle(formId, 'objectreference');

/** Calls a native on an object with arguments, its latent waits awaited. */
async function call(
  scripts: ScriptRuntime,
  name: string,
  self: ObjectHandle | null,
  args: Value[] = [],
): Promise<Value> {
  const [script = '', fn = ''] = name.split('.');
  const native = scripts.native(script, fn);
  if (!native) throw new Error(`no native ${name}`);
  return native({
    vm: scripts.vm,
    self,
    args,
    name,
    latent: (promise: Promise<unknown>) => promise,
    where: () => 'Test.OnInit()',
  } as unknown as NativeCall);
}

describe('the movement controller natives', () => {
  it('leaves no native a placeholder', () => {
    expect(PLACEHOLDER_NATIVES.size).toBe(0);
  });

  it("logs the original's unbound native error for the forced movements, which return None", async () => {
    const warnings: string[] = [];
    const scripts = runtime({}, warnings);
    expect(UNBOUND_NATIVES.size).toBe(10);
    expect(await call(scripts, 'actor.forcemovementspeedramp', actor(ACTOR), [1, 2])).toBeNull();
    expect(warnings).toEqual([
      'Test.OnInit(): error: Unbound native function "ForceMovementSpeedRamp" called',
    ]);
  });

  it('hands an actor the player’s controls with its AI off, and back (SetPlayerControls)', async () => {
    const asked: [number, boolean][] = [];
    const ai: [number, boolean][] = [];
    const scripts = runtime({
      playerControls: (who, on) => asked.push([who, on]),
      aiEnabled: (who, on) => ai.push([who, on]),
    });
    expect(await call(scripts, 'actor.getplayercontrols', actor(ACTOR))).toBe(false);
    await call(scripts, 'actor.setplayercontrols', actor(ACTOR), [true]);
    expect(await call(scripts, 'actor.getplayercontrols', actor(ACTOR))).toBe(true);
    expect(scripts.state.actor(ACTOR).aiEnabled).toBe(false);
    await call(scripts, 'actor.setplayercontrols', actor(ACTOR), [false]);
    expect(await call(scripts, 'actor.getplayercontrols', actor(ACTOR))).toBe(false);
    expect(scripts.state.actor(ACTOR).aiEnabled).toBe(true);
    expect(asked).toEqual([
      [ACTOR, true],
      [ACTOR, false],
    ]);
    expect(ai).toEqual([
      [ACTOR, false],
      [ACTOR, true],
    ]);
  });

  it('keeps an offset from an actor in radians until cleared (KeepOffsetFromActor)', async () => {
    const changed: number[] = [];
    const scripts = runtime({ keepOffsetChanged: (who) => changed.push(who) });
    await call(scripts, 'actor.keepoffsetfromactor', actor(ACTOR), [
      actor(OTHER),
      0,
      -100,
      0,
      0,
      0,
      90,
      300,
      50,
    ]);
    const keep = scripts.state.actor(ACTOR).keepOffset;
    expect(keep?.target).toBe(OTHER);
    expect(keep?.offset).toEqual([0, -100, 0]);
    expect(keep?.angle[2]).toBeCloseTo(Math.PI / 2);
    expect([keep?.catchUpRadius, keep?.followRadius]).toEqual([300, 50]);
    await call(scripts, 'actor.clearkeepoffsetfromactor', actor(ACTOR));
    expect(scripts.state.actor(ACTOR).keepOffset).toBeUndefined();
    expect(changed).toEqual([ACTOR, ACTOR]);
  });

  it('follows another actor with the camera, and the player again for None (SetCameraTarget)', async () => {
    const targets: (number | undefined)[] = [];
    const scripts = runtime({ cameraTarget: (target) => targets.push(target) });
    await call(scripts, 'game.setcameratarget', null, [actor(ACTOR)]);
    await call(scripts, 'game.setcameratarget', null, [null]);
    expect(targets).toEqual([ACTOR, undefined]);
  });
});

describe('the reference natives on animations, ragdolls and terrain effects', () => {
  it('sends two references their animations in one call, true when either took', async () => {
    const sent: [number, string][] = [];
    const scripts = runtime({
      animationEvent: (reference, event) => {
        sent.push([reference, event]);
        return reference === OTHER;
      },
    });
    const played = await call(scripts, 'objectreference.playsyncedanimationss', ref(ACTOR), [
      'Open',
      ref(OTHER),
      'Close',
    ]);
    expect(played).toBe(true);
    expect(sent).toEqual([
      [ACTOR, 'Open'],
      [OTHER, 'Close'],
    ]);
  });

  it("refuses a None partner with the original's line", async () => {
    const warnings: string[] = [];
    const scripts = runtime({ animationEvent: () => true }, warnings);
    const played = await call(scripts, 'objectreference.playsyncedanimationss', ref(ACTOR), [
      'Open',
      null,
      'Close',
    ]);
    expect(played).toBe(false);
    expect(warnings).toEqual(['Test.OnInit(): Cannot play an animation on a None object']);
  });

  it('waits for the events of those whose animation took (PlaySyncedAnimationAndWaitSS)', async () => {
    const scripts = runtime({ animationEvent: (reference) => reference === ACTOR });
    let done = false;
    const waiting = call(scripts, 'objectreference.playsyncedanimationandwaitss', ref(ACTOR), [
      'Open',
      'Opened',
      ref(OTHER),
      'Close',
      'Closed',
    ]).then((value) => {
      done = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(done).toBe(false);
    scripts.animationEvent(ACTOR, 'Opened');
    expect(await waiting).toBe(true);
  });

  it('takes a ragdoll out of the world, and shows a terrain effect or logs why not', async () => {
    const removed: number[] = [];
    const warnings: string[] = [];
    const effects: [number, string, string][] = [];
    const scripts = runtime(
      {
        removeRagdoll: (who) => {
          removed.push(who);
          return Promise.resolve();
        },
        terrainEffect: (reference, model, node) => {
          effects.push([reference, model, node]);
          return model !== '';
        },
      },
      warnings,
    );
    await call(scripts, 'objectreference.forceremoveragdollfromworld', actor(ACTOR));
    expect(removed).toEqual([ACTOR]);
    await call(scripts, 'objectreference.playterraineffect', ref(ACTOR), ['Dust.nif', 'Root']);
    await call(scripts, 'objectreference.playterraineffect', ref(ACTOR), ['', 'Root']);
    expect(effects).toEqual([
      [ACTOR, 'Dust.nif', 'Root'],
      [ACTOR, '', 'Root'],
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Could not set up terrain effect\.$/);
  });
});
