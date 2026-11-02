import { describe, expect, it } from 'vitest';
import type { SavedProjectile } from '../save/world-save.ts';
import type { ProjectileRecord } from '../world/projectile-data.ts';
import { ProjectileType } from '../world/projectile-data.ts';
import type { GameSession } from './game-session.ts';
import type { RenderPort } from '../render/render-port.ts';
import type { Terminal } from './terminal.ts';
import { MagicProjectiles } from './magic-projectiles.ts';

const CASTER = 0x1001;
const SPELL = 0x2001;

/** A projectile record of a kind (no model: nothing is drawn). */
function projectile(formId: number, type: number, extra: Partial<ProjectileRecord> = {}) {
  return {
    formId,
    editorId: `Projectile${formId.toString(16)}`,
    flags: 0,
    type,
    gravity: 0,
    speed: 1000,
    range: 2000,
    light: undefined,
    muzzleFlashLight: undefined,
    tracerChance: 0,
    proximity: 0,
    timer: 0,
    explosion: undefined,
    sound: undefined,
    muzzleFlashDuration: 0,
    fadeDuration: 0,
    impactForce: 0,
    countdownSound: undefined,
    disableSound: undefined,
    defaultWeaponSource: undefined,
    coneSpread: 15,
    collisionRadius: 10,
    lifetime: 0,
    relaunchInterval: 0.25,
    decal: undefined,
    collisionLayer: undefined,
    model: undefined,
    muzzleFlashModel: undefined,
    soundLevel: 1,
    ...extra,
  } satisfies ProjectileRecord;
}

const CONE = projectile(0x3001, ProjectileType.cone, { speed: 500, range: 1500 });
const MISSILE = projectile(0x3002, ProjectileType.missile);
const SPRAY = projectile(0x3003, ProjectileType.flame);
const RECORDS = new Map([CONE, MISSILE, SPRAY].map((record) => [record.formId, record]));

/** Projectiles with just what a save and its load use: the runtime's records, no 3D. */
function projectiles(): MagicProjectiles {
  const runtime = {
    magic: {
      item: (formId: number) =>
        Promise.resolve(formId === SPELL ? { formId, effects: [], delivery: 0 } : undefined),
    },
    casting: {
      projectile: (formId: number) => Promise.resolve(RECORDS.get(formId)),
      cost: () => Promise.resolve(0),
      mainEffect: () => Promise.resolve(undefined),
    },
  };
  const session = {
    scriptsReady: runtime,
    settings: () => new Promise(() => undefined),
    model: () => Promise.resolve(undefined),
  };
  return new MagicProjectiles({
    session: session as unknown as GameSession,
    renderer: {} as RenderPort,
    terminal: { log: () => undefined } as unknown as Terminal,
    targets: () => [],
  });
}

const cast = { item: SPELL, via: 'spell', caster: CASTER, dual: false } as const;

describe('magic projectiles in a save', () => {
  it("keep a cone's wave sweeping out, its sprays and missiles, and give them back", async () => {
    const saved: SavedProjectile[] = [
      {
        projectile: CONE.formId,
        ...cast,
        position: [0, 0, 0],
        velocity: [0, 1, 0],
        traveled: 400,
        age: 0.8,
        kind: 'cone',
        reached: [0x1002],
        seconds: 0.5,
      },
      {
        projectile: MISSILE.formId,
        ...cast,
        position: [10, 20, 30],
        velocity: [0, 1000, 0],
        traveled: 300,
        age: 0.3,
        graph: { sequences: { states: [4], variables: [] } },
      },
      {
        projectile: SPRAY.formId,
        ...cast,
        position: [0, 150, 0],
        velocity: [0, 1000, 0],
        traveled: 150,
        age: 0.15,
        kind: 'spray',
        origin: [0, 0, 0],
      },
    ];
    const magic = projectiles();
    await magic.restore(saved);
    const again = magic.save();
    const cone = again.find((entry) => entry.kind === 'cone');
    expect(cone).toMatchObject({
      projectile: CONE.formId,
      position: [0, 0, 0],
      velocity: [0, 1, 0],
      traveled: 400,
      reached: [0x1002],
      seconds: 0.5,
      caster: CASTER,
    });
    expect(cone?.age).toBeCloseTo(0.8);
    const missile = again.find((entry) => entry.projectile === MISSILE.formId);
    expect(missile).toMatchObject({ position: [10, 20, 30], traveled: 300, age: 0.3 });
    expect(missile?.kind).toBeUndefined();
    // The spray flies on from where it left, carrying its concentration seconds.
    const spray = again.find((entry) => entry.kind === 'spray');
    expect(spray).toMatchObject({ origin: [0, 0, 0], position: [0, 150, 0], seconds: 0.25 });
  });

  it('keep a Magelight stuck where it struck for the seconds it has left', async () => {
    const magic = projectiles();
    await magic.restore([
      {
        projectile: MISSILE.formId,
        ...cast,
        position: [5, 5, 5],
        velocity: [0, 0, 0],
        traveled: 600,
        age: 1,
        resting: true,
        kind: 'stuck',
        left: 30,
      },
    ]);
    magic.frame(10);
    const [stuck] = magic.save();
    expect(stuck).toMatchObject({ kind: 'stuck', position: [5, 5, 5] });
    expect(stuck?.left).toBeCloseTo(20);
    magic.frame(21);
    expect(magic.save()).toEqual([]);
  });
});
