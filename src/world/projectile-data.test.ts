import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import {
  ExplosionFlag,
  parseExplosion,
  parseProjectile,
  ProjectileFlag,
  ProjectileType,
} from './projectile-data.ts';

const record = (fields: [string, Uint8Array][]) => {
  const list = new Fields(fields.map(([type, data]) => ({ type, data })));
  const formIdAt = (data: Uint8Array, offset = 0): number =>
    new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
  return {
    formId: 0x12e84,
    editorId: 'Test',
    fields: list,
    formIdAt,
    formIdField: (field: string) => {
      const data = list.first(field);
      return data ? formIdAt(data) : undefined;
    },
    text: () => undefined,
  };
};
const zstring = (text: string): Uint8Array => new TextEncoder().encode(`${text}\0`);

describe('PROJ', () => {
  it('reads DATA (92 bytes), its model and sound level', () => {
    const data = new DataView(new ArrayBuffer(92));
    data.setUint16(0, ProjectileFlag.explosion, true);
    data.setUint16(2, ProjectileType.missile, true);
    data.setFloat32(4, 0, true);
    data.setFloat32(8, 3200, true);
    data.setFloat32(12, 10000, true);
    data.setUint32(16, 0x10fc0c, true);
    data.setUint32(36, 0x10fc09, true);
    data.setUint32(40, 0x3c8fe, true);
    data.setFloat32(48, 0.5, true);
    data.setFloat32(52, 10, true);
    data.setFloat32(68, 15, true);
    data.setFloat32(72, 10, true);
    data.setFloat32(80, 0.25, true);
    const vnam = new DataView(new ArrayBuffer(4));
    vnam.setUint32(0, 2, true);
    const projectile = parseProjectile(
      record([
        ['DATA', new Uint8Array(data.buffer)],
        ['MODL', zstring('Magic\\FireballProjectile02.nif')],
        ['VNAM', new Uint8Array(vnam.buffer)],
      ]),
    );
    expect(projectile).toMatchObject({
      flags: ProjectileFlag.explosion,
      type: ProjectileType.missile,
      speed: 3200,
      range: 10000,
      light: 0x10fc0c,
      explosion: 0x10fc09,
      sound: 0x3c8fe,
      fadeDuration: 0.5,
      impactForce: 10,
      coneSpread: 15,
      collisionRadius: 10,
      relaunchInterval: 0.25,
      model: 'Magic\\FireballProjectile02.nif',
      soundLevel: 2,
    });
    expect(projectile.muzzleFlashLight).toBeUndefined();
    expect(projectile.decal).toBeUndefined();
  });
});

describe('EXPL', () => {
  it('reads DATA (52 bytes) and the enchantment it applies', () => {
    const data = new DataView(new ArrayBuffer(52));
    data.setUint32(4, 0x3c8fc, true);
    data.setUint32(12, 0x2610b, true);
    data.setFloat32(24, 60, true);
    data.setFloat32(28, 2, true);
    data.setFloat32(32, 320, true);
    data.setFloat32(36, 1024, true);
    data.setUint32(44, ExplosionFlag.ignoreLosCheck, true);
    data.setUint32(48, 1, true);
    const eitm = new DataView(new ArrayBuffer(4));
    eitm.setUint32(0, 0x1cea5, true);
    const explosion = parseExplosion(
      record([
        ['DATA', new Uint8Array(data.buffer)],
        ['EITM', new Uint8Array(eitm.buffer)],
      ]),
    );
    expect(explosion).toMatchObject({
      sound: 0x3c8fc,
      impactDataSet: 0x2610b,
      force: 60,
      damage: 2,
      radius: 320,
      imageSpaceRadius: 1024,
      flags: ExplosionFlag.ignoreLosCheck,
      soundLevel: 1,
      enchantment: 0x1cea5,
    });
    expect(explosion.light).toBeUndefined();
    expect(explosion.spawnProjectile).toBeUndefined();
  });
});
