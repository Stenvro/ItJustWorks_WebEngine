// Conformance: visual effects (engine map: Magic, effects, perks > Visual effects): the shaders,
// art and visuals magic effects put on what they reach.
//
// Sources:
// - The magic effects of the load order (MGEF DATA: hit and enchant shaders, casting, hit and
//   enchant art, hit and enchant visuals; xEdit, CommonLibSSE EffectSettingData), counted here.
// - The FX Persist flag (0x1000): the visuals last as long as the effect (Creation Kit "Magic
//   Effect").

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { itemGlow } from '../../../src/gameplay/magic/enchantment-glow.ts';
import type { GpuScene } from '../../../src/render/scene-renderer.ts';
import { PLAYER_REF } from '../../../src/scripting/runtime/forms.ts';
import type { MagicEffectShown } from '../../../src/scripting/runtime/magic-engine.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import {
  EffectShaderFlag,
  parseEffectShader,
  type EffectShaderRecord,
} from '../../../src/world/effect-shader-records.ts';
import {
  EffectFlag,
  parseMagicEffect,
  parseVisualEffect,
} from '../../../src/world/magic-effects.ts';
import { parseMagicItem } from '../../../src/world/magic-records.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

describe.skipIf(!hasGamedata())('the effects’ visuals across the load order (data)', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  const counts = {
    hitShader: 0,
    enchantShader: 0,
    castingArt: 0,
    hitArt: 0,
    enchantArt: 0,
    hitVisuals: 0,
    enchantVisuals: 0,
    imageSpace: 0,
    fxPersist: 0,
  };

  const formIdOf = async (type: string, editorId: string): Promise<number> => {
    for (const formId of db.formIdsOfType(type))
      if ((await db.get(formId))?.editorId === editorId) return formId;
    return 0;
  };

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    for (const formId of db.formIdsOfType('MGEF')) {
      const record = await db.get(formId);
      if (!record || record.deleted) continue;
      const e = parseMagicEffect(record);
      if (e.hitShader !== undefined) counts.hitShader++;
      if (e.enchantShader !== undefined) counts.enchantShader++;
      if (e.castingArt !== undefined) counts.castingArt++;
      if (e.hitEffectArt !== undefined) counts.hitArt++;
      if (e.enchantArt !== undefined) counts.enchantArt++;
      if (e.hitVisuals !== undefined) counts.hitVisuals++;
      if (e.enchantVisuals !== undefined) counts.enchantVisuals++;
      if (e.imageSpaceModifier !== undefined) counts.imageSpace++;
      if ((e.flags & EffectFlag.fxPersist) !== 0) counts.fxPersist++;
    }
  }, 300_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('counts the visuals the 1,731 magic effects carry', () => {
    expect(counts.fxPersist).toBe(927);
    expect(counts).toMatchObject({
      hitShader: 765,
      enchantShader: 191,
      castingArt: 731,
      hitArt: 359,
      enchantArt: 21,
      imageSpace: 260,
      // No vanilla effect names a visual effect (xEdit: DATA @120, @124); they work for a mod's
      // (shell/actor-effects.ts; gameplay/magic/enchantment-glow.ts).
      hitVisuals: 0,
      enchantVisuals: 0,
    });
  });

  it('gives an enchanted weapon its enchantment’s Enchant Shader to glow with', async () => {
    const sword = await db.get(await formIdOf('WEAP', 'EnchIronSwordFire01'));
    expect(sword).toBeDefined();
    if (!sword) return;
    const glow = await itemGlow((formId) => db.get(formId), sword.formId);
    const enchantment = sword.formIdField('EITM');
    const item = enchantment === undefined ? undefined : await db.get(enchantment);
    const magic = item && parseMagicItem(item);
    const effect = magic?.effects[0] && (await db.get(magic.effects[0].effect));
    expect(effect).toBeDefined();
    if (!effect) return;
    expect(glow?.enchantment).toBe(enchantment);
    expect(glow?.shader).toBe(parseMagicEffect(effect).enchantShader);
    expect(glow?.shader).toBeDefined();
  });
});

describe.skipIf(!hasGamedata())('the visuals in the sim', () => {
  let sim: Sim;

  beforeAll(async () => {
    sim = await openSim({ interior: 0x1605e, hour: 10 });
  }, 300_000);
  afterAll(async () => {
    await sim.close();
  });

  it('reads every visual effect (RFCT): its art an ARTO, its shader an EFSH', async () => {
    const ids = sim.db.formIdsOfType('RFCT');
    expect(ids).toHaveLength(168);
    let arts = 0;
    let shaders = 0;
    for (const formId of ids) {
      const record = await sim.db.get(formId);
      const visual = record && parseVisualEffect(record);
      expect(visual).toBeDefined();
      if (!visual) continue;
      if (visual.art !== undefined) {
        arts++;
        expect((await sim.db.get(visual.art))?.type).toBe('ARTO');
      }
      if (visual.shader !== undefined) {
        shaders++;
        expect((await sim.db.get(visual.shader))?.type).toBe('EFSH');
      }
    }
    expect(arts + shaders).toBeGreaterThan(0);
  }, 60_000);

  it('shows an effect’s hit shader and art on an object it reaches, once', async () => {
    const { magic, world } = sim.runtime;
    const firebolt = await sim.db.get(await sim.formId('SPEL', 'Firebolt'));
    const item = firebolt ? parseMagicItem(firebolt) : undefined;
    const first = item?.effects[0];
    const effect = first && (await magic.effect(first.effect));
    expect(item && effect).toBeTruthy();
    if (!item || !effect) return;
    const object = sim.world.placedObjects().find((placed) => placed.object.baseType === 'MISC');
    expect(object).toBeDefined();
    if (!object) return;
    const told: MagicEffectShown[] = [];
    const before = world.magicEffect?.bind(world);
    world.magicEffect = (shown) => {
      told.push(shown);
    };
    try {
      await magic.apply(item, object.object.reference, { caster: PLAYER_REF });
    } finally {
      if (before) world.magicEffect = before;
    }
    const shown = told.find((entry) => entry.target === object.object.reference);
    expect(shown).toMatchObject({
      event: 'start',
      onObject: true,
      shader: effect.hitShader,
      art: effect.hitEffectArt,
      persist: false,
    });
  }, 60_000);

  it('covers its target with a hit visual effect’s (RFCT) shader', async () => {
    const effects = sim.world.stage.effects;
    const scene = sim.world.session.render.scene;
    let visual: number | undefined;
    for (const formId of sim.db.formIdsOfType('RFCT')) {
      const record = await sim.db.get(formId);
      const shader = record && parseVisualEffect(record)?.shader;
      const shaderRecord = shader === undefined ? undefined : await sim.db.get(shader);
      const parsed = shaderRecord && parseEffectShader(shaderRecord);
      if (
        parsed &&
        parsed.fillTexture !== '' &&
        (parsed.flags & EffectShaderFlag.noMembraneShader) === 0
      ) {
        visual = formId;
        break;
      }
    }
    const target = sim.actors()[0]?.reference;
    expect(visual).toBeDefined();
    expect(target).toBeDefined();
    if (visual === undefined || target === undefined) return;
    const shown: MagicEffectShown = {
      event: 'start',
      key: 'a hit visual',
      effect: 0,
      archetype: 0,
      target,
      caster: undefined,
      shader: undefined,
      art: undefined,
      visuals: visual,
      light: undefined,
      persist: true,
      duration: 0,
      magnitude: 0,
      area: 0,
      associated: undefined,
    };
    let covers = 0;
    const overlay = scene.createOverlay.bind(scene);
    scene.createOverlay = (...args) => {
      covers++;
      return overlay(...args);
    };
    try {
      effects.effect(shown);
      await sim.step(0.5);
      effects.effect({ ...shown, event: 'stop' });
      await sim.step(0.1);
    } finally {
      scene.createOverlay = overlay;
    }
    expect(covers).toBeGreaterThan(0);
  }, 60_000);

  it('colours a shader’s fill by its colour keys over its age', async () => {
    const stage = sim.world.stage;
    const scene = sim.world.session.render.scene;
    // A shader whose keys differ, on an actor whose body is shown.
    let shader: EffectShaderRecord | undefined;
    for (const formId of sim.db.formIdsOfType('EFSH')) {
      const record = await sim.db.get(formId);
      if (!record) continue;
      const parsed = parseEffectShader(record);
      const [a, b] = parsed.membrane.colors;
      if (
        parsed.fillTexture !== '' &&
        (parsed.flags & EffectShaderFlag.noMembraneShader) === 0 &&
        a &&
        b &&
        b.time > a.time &&
        b.time < 1 &&
        a.color.some((c, i) => c * a.scale !== (b.color[i] ?? 0) * b.scale)
      ) {
        shader = parsed;
        break;
      }
    }
    expect(shader).toBeDefined();
    const actor = sim.actors()[0]?.reference;
    if (!shader || actor === undefined) return;
    const tints: (readonly [number, number, number])[] = [];
    const created = scene.createScene.bind(scene);
    const tinted = scene.tintScene.bind(scene);
    scene.createScene = () => ({ draws: [], destroy: () => undefined }) as unknown as GpuScene;
    scene.tintScene = (_scene, color) => {
      tints.push(color);
    };
    try {
      stage.effects.shader(shader.formId, actor, true, -1);
      for (let t = 0; t < 2.5; t += 0.25) await sim.step(0.25);
      stage.effects.shader(shader.formId, actor, false, 0);
      await sim.step(0.1);
    } finally {
      scene.createScene = created;
      scene.tintScene = tinted;
    }
    expect(tints.length).toBeGreaterThan(1);
    const first = tints[0];
    const last = tints.at(-1);
    expect(first && last && first.some((c, i) => Math.abs(c - (last[i] ?? 0)) > 1e-3)).toBe(true);
  }, 120_000);
});

describe('what the original shows that we do not yet', () => {
  it.todo('an effect shader’s holes (NAM7), addon models and ambient sound');
  it.todo('Particle Animated’s frame runs in a membrane’s particles');
});
