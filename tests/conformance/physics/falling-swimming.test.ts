// Conformance: falling and swimming (engine map: Physics > Falling, swimming). Falls take health
// by the engine's formula, from the player and every other actor; under water an actor's breath
// runs down and the player drowns. Skipped without game data where it needs it.
//
// Sources:
// - The engine's rule, observed in the original (src/gameplay/falling.ts, src/gameplay/breath.ts;
//   docs/gameplay.md, "Breath and drowning"):
//   - a landing after a fall higher than fJumpFallHeightMin takes ((height − min) ×
//     fJumpFallHeightMult)^fJumpFallHeightExponent, the player by those settings and every other
//     actor by the ones ending in "NPC"; one getting up from a ragdoll measures against a quarter
//     of the minimum; water takes nothing;
//   - breath lasts fActorSwimBreathBase + fActorSwimBreathMult × 50 s (the engine passes 50);
//     under water (submersion 0.875, the engine's constant) it runs down, out of it (or with
//     Water Breathing) it is whole at once; gone, the player loses fActorSwimBreathDamage of their
//     base health a second (through fDiffMultHPToPC), with the NPCHumanDrowning sound; other
//     actors never drown; coming up after fActorLeaveWaterBreathTimer (4 s) under water says
//     Leave Water Breath (LWBS, subtype 102).
// - The settings' built-in values (the engine's defaults) and Skyrim.esm's (node tools/gmst-info.ts
//   --prefix fJumpFall, --prefix fActorSwim): fJumpFallHeightMin 600, Mult 0.1, Exponent 1.65
//   (Skyrim.esm 1.45); MinNPC 300 (Skyrim.esm 450), MultNPC 0.1, ExponentNPC 1.65;
//   fActorSwimBreathBase 10, Mult 0.5 (Skyrim.esm 0.2), Damage 0.2 (Skyrim.esm 0.08);
//   fActorLeaveWaterBreathTimer 4.
// - UESP "Skyrim:Damage" (falling) for the formula's shape.
// - The data: interface\hudmenu.swf has no breath meter of any name (the vanilla game shows none);
//   the settings fFallLegDamageMult, iFallLegDamageChance are built-in only, no plugin sets them.
// - Inferred (TODO(M13) in src/gameplay/falling.ts, src/shell/time-flow.ts): the leg's damage is
//   read from the settings' names; the drowning sound's repeat from the damage's second.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { allTags, readSwf, SwfTagCode, tagBody } from '../../../src/formats/swf/swf.ts';
import {
  Breath,
  BREATH_DEFAULTS,
  drowningDamage,
  maxBreath,
  UNDERWATER_SUBMERSION,
} from '../../../src/gameplay/breath.ts';
import {
  FALL_LEG_DEFAULTS,
  fallDamage,
  fallLegDamage,
  NPC_FALL,
  PLAYER_FALL,
  RAGDOLL_FALL_SHARE,
} from '../../../src/gameplay/falling.ts';
import { Layer } from '../../../src/physics/collision-layers.ts';
import { actorFell } from '../../../src/shell/time-flow.ts';
import { ObjectHandle } from '../../../src/scripting/values.ts';
import { ActorValue, actorValueIndex } from '../../../src/world/actor-values.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

/** Skyrim.esm's settings (GMST). */
const ESM_PLAYER_FALL = { ...PLAYER_FALL, exponent: 1.45 };
const ESM_NPC_FALL = { ...NPC_FALL, min: 450 };
const ESM_BREATH = { ...BREATH_DEFAULTS, mult: 0.2, damage: 0.08 };

describe('falling damage (the engine’s formula)', () => {
  it('takes nothing up to fJumpFallHeightMin (600 for the player, 450 for NPCs)', () => {
    expect(fallDamage(600, ESM_PLAYER_FALL)).toBe(0);
    expect(fallDamage(450, ESM_NPC_FALL)).toBe(0);
  });

  it('takes ((1000 − 600) × 0.1)^1.45 ≈ 210.4 from the player falling 1000 units', () => {
    expect(fallDamage(1000, ESM_PLAYER_FALL)).toBeCloseTo(Math.pow(40, 1.45), 6);
    expect(fallDamage(1000, ESM_PLAYER_FALL)).toBeCloseTo(210.4, 1);
  });

  it('takes ((1000 − 450) × 0.1)^1.65 ≈ 744 from an NPC falling 1000 units', () => {
    expect(fallDamage(1000, ESM_NPC_FALL)).toBeCloseTo(Math.pow(55, 1.65), 6);
    expect(fallDamage(1000, ESM_NPC_FALL)).toBeCloseTo(744.0, 0);
  });

  it('measures one getting up from a ragdoll against a quarter of the minimum', () => {
    expect(fallDamage(300, ESM_PLAYER_FALL, RAGDOLL_FALL_SHARE)).toBeCloseTo(Math.pow(15, 1.45), 6);
    expect(RAGDOLL_FALL_SHARE).toBe(0.25);
  });

  it('hurts a leg on a hard landing: fFallLegDamageMult (0.5), iFallLegDamageChance (50)', () => {
    expect(FALL_LEG_DEFAULTS).toEqual({ mult: 0.5, chance: 50 });
    expect(fallLegDamage(100, 49.9)).toBe(50);
    expect(fallLegDamage(100, 50)).toBe(0);
    expect(fallLegDamage(0, 0)).toBe(0);
    expect(fallLegDamage(100, 10, { mult: 0.25, chance: 11 })).toBe(25);
  });
});

describe('breath and drowning (the engine’s rule)', () => {
  it('lasts fActorSwimBreathBase + fActorSwimBreathMult × 50: 20 s with Skyrim.esm, 35 built in', () => {
    expect(maxBreath(ESM_BREATH)).toBe(20);
    expect(maxBreath(BREATH_DEFAULTS)).toBe(35);
  });

  it('runs down only under water (0.875 of the height), and is whole again on coming up', () => {
    const breath = new Breath(ESM_BREATH);
    expect(UNDERWATER_SUBMERSION).toBe(0.875);
    breath.step(5, 0.8);
    expect(breath.remaining).toBe(20);
    breath.step(5, 0.9);
    expect(breath.remaining).toBe(15);
    breath.step(0.1, 0.5);
    expect(breath.remaining).toBe(20);
  });

  it('keeps it whole with Water Breathing', () => {
    const breath = new Breath(ESM_BREATH);
    const step = breath.step(60, 1, true);
    expect(breath.remaining).toBe(20);
    expect(step.drowning).toBe(0);
  });

  it('drowns once it is gone: 8 % of base health a second with Skyrim.esm', () => {
    const breath = new Breath(ESM_BREATH);
    const steps = Array.from({ length: 25 }, () => breath.step(1, 1));
    expect(steps.slice(0, 20).every((step) => step.drowning === 0)).toBe(true);
    expect(steps.slice(20).every((step) => step.drowning === 1)).toBe(true);
    // A base health of 100: 8 a second (before the difficulty).
    expect(drowningDamage(100, 1, ESM_BREATH)).toBeCloseTo(8, 6);
    expect(drowningDamage(250, 0.5, ESM_BREATH)).toBeCloseTo(10, 6);
  });

  it('gasps on coming up after more than fActorLeaveWaterBreathTimer (4 s) under water', () => {
    const short = new Breath(ESM_BREATH);
    short.step(1, 1);
    short.step(2, 1);
    expect(short.step(0.1, 0).gasped).toBe(false);
    const long = new Breath(ESM_BREATH);
    long.step(1, 1);
    long.step(3, 1);
    long.step(1.5, 1);
    expect(long.step(0.1, 0).gasped).toBe(true);
  });
});

const TAMRIEL = 0x3c;
/** Riverwood's cells and the river's next to it. */
const RIVER_CELLS: readonly (readonly [number, number])[] = [
  [4, -11],
  [5, -11],
  [3, -11],
  [4, -12],
];

describe.skipIf(!hasGamedata())('in Riverwood’s river (headless simulation)', () => {
  let sim: Sim;
  /** The riverbed under the deepest water found, and the surface over it. */
  let bed: [number, number, number] = [0, 0, 0];
  let surface = 0;
  let npc = 0;

  const water = (): NonNullable<NonNullable<Sim['world']['play']>['water']> => {
    const found = sim.world.play?.water;
    if (!found) throw new Error('no water');
    return found;
  };

  function deepest(): { floor: [number, number, number]; depth: number } | undefined {
    const play = sim.world.play;
    if (!play) return undefined;
    let found: { floor: [number, number, number]; depth: number } | undefined;
    for (const [cx, cy] of RIVER_CELLS) {
      for (let x = 64; x < 4096; x += 128) {
        for (let y = 64; y < 4096; y += 128) {
          const at: [number, number] = [cx * 4096 + x, cy * 4096 + y];
          const hit = play.physics.raycast([...at, 6000], [0, 0, -1], 12_000, Layer.charController);
          const over = hit && water().surface(at[0], at[1], hit.point[2]);
          if (over && hit && over.height - hit.point[2] > (found?.depth ?? 0)) {
            found = { floor: [at[0], at[1], hit.point[2]], depth: over.height - hit.point[2] };
          }
        }
      }
    }
    return found;
  }

  beforeAll(async () => {
    sim = await openSim({ exterior: { world: TAMRIEL, cell: [4, -11] }, hour: 10 });
    let deep = deepest();
    for (let i = 0; i < 30 && (deep?.depth ?? 0) < 130; i++) {
      await sim.step(0.2);
      deep = deepest();
    }
    if (!deep) throw new Error('no water');
    bed = deep.floor;
    surface = bed[2] + deep.depth;
    await sim.moveTo([bed[0], bed[1], surface + 300]);
    await sim.step(1);
    // Someone of the town with a controller, a person: the river's mudcrabs swim as well.
    for (const staged of sim.actors()) {
      if (staged.dead || !sim.world.stage.movers.motion(staged.reference)) continue;
      if (!/^(Embry|Sigrid|Alvor|Hod|Gerdur|Faendal|Sven)/.test(staged.placed.look.editorId)) {
        continue;
      }
      npc = staged.reference;
      break;
    }
    if (npc === 0) throw new Error('no one in the town');
    // It goes nowhere of its own (its package would walk it out of the cases' water).
    await sim.native(new ObjectHandle(npc, 'actor'), 'Actor', 'EnableAI', [false]);
  }, 300_000);
  afterAll(async () => {
    await sim.close();
  });

  const health = async (reference: number): Promise<number> =>
    (await sim.runtime.actors.value(reference, ActorValue.health)).current;

  /** Keeps an actor at the riverbed, under water, for `seconds`. */
  async function holdUnder(reference: number, seconds: number): Promise<void> {
    const feet: [number, number, number] = [bed[0], bed[1], bed[2] + 2];
    // The player out of its way: floating over it they would hold it under.
    if (reference !== PLAYER_REF) await sim.moveTo([bed[0] + 200, bed[1], surface]);
    for (let t = 0; seconds - t >= 1 / 120; t += 0.1) {
      if (reference === PLAYER_REF) await sim.moveTo(feet);
      else sim.runtime.move(reference, feet);
      await sim.step(0.1);
    }
  }

  it('the river is deep enough to go under', () => {
    expect(surface - bed[2]).toBeGreaterThan(130);
  });

  it('takes nothing from a fall into water deep enough to swim', async () => {
    const before = await health(PLAYER_REF);
    await sim.moveTo([bed[0], bed[1], surface + 1200]);
    const player = sim.world.player;
    let fastest = 0;
    const landed = vi.fn<(height: number) => void>();
    const was = player.onLanded;
    player.onLanded = (height) => {
      landed(height);
      was?.(height);
    };
    for (let i = 0; i < 300 && !player.swimming; i++) {
      await sim.step(1 / 60);
      fastest = Math.min(fastest, player.character.verticalSpeed);
    }
    await sim.step(1);
    player.onLanded = was;
    // It came down fast (from a dry fall of 1200 the player would take some 377).
    expect(fastest).toBeLessThan(-600);
    expect(player.swimming).toBe(true);
    expect(landed).not.toHaveBeenCalled();
    expect(await health(PLAYER_REF)).toBeGreaterThanOrEqual(before);
  }, 120_000);

  it('takes a leg’s condition from a hard landing as the roll says', async () => {
    const left = actorValueIndex('LeftMobilityCondition') ?? 0;
    const right = actorValueIndex('RightMobilityCondition') ?? 0;
    const legs = async (): Promise<number> =>
      (await sim.runtime.actors.value(npc, left)).current +
      (await sim.runtime.actors.value(npc, right)).current;
    const before = await legs();
    // The roll over the chance: no leg.
    await actorFell(sim.runtime, npc, 460, 1, () => 99);
    expect(await legs()).toBe(before);
    // Under it: half the health taken (450 is the NPCs' minimum: (10 × 0.1)^1.65 = 1).
    const taken = await actorFell(sim.runtime, npc, 460, 1, () => 10);
    expect(taken).toBeGreaterThan(0);
    expect(await legs()).toBeCloseTo(before - taken * 0.5, 3);
  }, 60_000);

  it('swims every actor whose submersion reaches 0.7, an NPC led into the river too', async () => {
    const motion = (): ReturnType<Sim['world']['stage']['movers']['motion']> =>
      sim.world.stage.movers.motion(npc);
    expect(motion()?.swimming).toBe(false);
    sim.runtime.move(npc, [bed[0], bed[1], bed[2] + 2]);
    expect(await sim.until(() => motion()?.swimming === true, 3)).toBe(true);
    // Up to the surface, its shoulders at the water (0.69 of a person's 131 units).
    await sim.step(1.5);
    const below = surface - (sim.actor(npc)?.position[2] ?? 0);
    expect(below).toBeGreaterThan(80);
    expect(below).toBeLessThan(105);
  }, 60_000);

  it('sends an NPC out of breath to the surface, and never drowns it', async () => {
    const stage = sim.world.stage;
    const pushed = vi.spyOn(stage.ai, 'pushEngine');
    const before = await health(npc);
    await holdUnder(npc, 25);
    expect(pushed.mock.calls.some(([actor, name]) => actor === npc && name === 'surface')).toBe(
      true,
    );
    expect(await health(npc)).toBeGreaterThanOrEqual(before);
    pushed.mockRestore();
    await sim.step(2);
  }, 300_000);

  it('says the Leave Water Breath line (LWBS) on coming up after 4 s under water, not sooner', async () => {
    const stage = sim.world.stage;
    const bark = vi.spyOn(stage.talk, 'bark');
    const said = (actor: number): boolean =>
      bark.mock.calls.some(([who, subtype]) => who === actor && subtype === 'LWBS');
    // Under for 2 s: no gasp; for 5 s: one as it comes up.
    await holdUnder(npc, 2);
    await sim.step(2);
    expect(said(npc)).toBe(false);
    await holdUnder(npc, 5);
    await sim.step(1);
    expect(said(npc)).toBe(true);
    // Out of the player's way (floating over them it would hold them under).
    sim.runtime.move(npc, [bed[0] + 600, bed[1], surface + 100]);
    await holdUnder(PLAYER_REF, 2);
    await sim.step(2);
    expect(said(PLAYER_REF)).toBe(false);
    await holdUnder(PLAYER_REF, 5);
    await sim.step(2);
    expect(said(PLAYER_REF)).toBe(true);
    bark.mockRestore();
  }, 300_000);

  it('plays NPCHumanDrowning on the player while they drown, and takes their health', async () => {
    const drowning = await sim.formId('SNDR', 'NPCHumanDrowning');
    const heard = (): number =>
      sim.sounds().filter((sound) => sound.descriptor === drowning).length;
    const before = await health(PLAYER_REF);
    expect(heard()).toBe(0);
    // The breath is 20 s with Skyrim.esm: not before it is gone.
    await holdUnder(PLAYER_REF, 15);
    expect(heard()).toBe(0);
    await holdUnder(PLAYER_REF, 8);
    // The descriptors are looked up by name as the first is asked for.
    await vi.waitFor(() => {
      expect(heard()).toBeGreaterThanOrEqual(2);
    });
    expect(await health(PLAYER_REF)).toBeLessThan(before);
    await sim.step(2);
  }, 300_000);

  it('reads fWaterKnockdownVelocity (5) and fWaterKnockdownSize* from Skyrim.esm', () => {
    expect(sim.world.session.time.breath?.remaining).toBeDefined();
    const knockdown = water().rules.knockdown;
    expect(knockdown?.velocity).toBe(5);
    [0.6, 0.75, 1.25, 1.5].forEach((size, i) => {
      expect(knockdown?.sizes[i]).toBeCloseTo(size, 5);
    });
  });

  it('carries an actor off in fast water only, past fWaterKnockdownVelocity × its size', async () => {
    const rules = water().rules;
    const moved = async (speed: number): Promise<number> => {
      // The river's own current as fast as asked (no flow map) along +x.
      const at = water().surface(bed[0], bed[1], bed[2]);
      if (!at) throw new Error('no surface');
      water().rules = {
        ...rules,
        flowmapTypes: new Set(),
        currents: new Map([[at.type, { linear: [speed, 0, 0], angular: [0, 0, 0] }]]),
      };
      await sim.moveTo([bed[0] - 400, bed[1], surface]);
      sim.runtime.move(npc, [bed[0], bed[1], bed[2] + 2]);
      await sim.step(0.3);
      const start = sim.actor(npc)?.position[0] ?? 0;
      await sim.step(0.5);
      return (sim.actor(npc)?.position[0] ?? 0) - start;
    };
    try {
      // A person's a normal size: 5 × 0.75 = 3.75 Havok units a second is the limit.
      const weak = await moved(3);
      const strong = await moved(4);
      expect(Math.abs(weak)).toBeLessThan(40);
      expect(strong).toBeGreaterThan(80);
    } finally {
      water().rules = rules;
    }
  }, 120_000);
});

describe.skipIf(!hasGamedata())('the breath meter (data)', () => {
  it('is not in the HUD’s movie: the vanilla game shows none', async () => {
    const { Vfs } = await import('../../../src/vfs/vfs.ts');
    const { openGameFolder } = await import('../../../tools/gamedata-path.ts');
    const vfs = await Vfs.mount(openGameFolder());
    const movie = readSwf(await vfs.read('interface\\hudmenu.swf'));
    await vfs.close();
    let scripts = 0;
    let breath = 0;
    let meter = 0;
    for (const tag of allTags(movie.tags)) {
      if (tag.code !== SwfTagCode.doAction && tag.code !== SwfTagCode.doInitAction) continue;
      scripts++;
      const text = Buffer.from(tagBody(movie, tag)).toString('latin1');
      if (/breath/i.test(text)) breath++;
      if (text.includes('SetStaminaMeterPercent')) meter++;
    }
    // What the check reads does hold the other meters.
    expect(scripts).toBeGreaterThan(0);
    expect(meter).toBeGreaterThan(0);
    expect(breath).toBe(0);
  }, 120_000);
});

/** WhiterunWorld [0001A26F]: its busiest cell, outdoors (nothing over the actors' heads). */
const WHITERUN_WORLD = 0x1a26f;

describe.skipIf(!hasGamedata())('an NPC falls 1000 units (headless simulation)', () => {
  let sim: Sim;
  let actor = 0;
  let before = 0;
  let after = 0;

  beforeAll(async () => {
    sim = await openSim({ hour: 12, gridRadius: 1 });
    const cell = (await sim.world.session.worldspace(WHITERUN_WORLD)).busiestCell() ?? [0, 0];
    await sim.openExterior(WHITERUN_WORLD, cell);
    await sim.step(2);
    for (const staged of sim.actors()) {
      if (staged.reference === 0x14 || staged.dead || !staged.grounded) continue;
      if (!staged.enabled(staged.reference)) continue;
      if (((await sim.distance(staged.reference, 0x14)) ?? Infinity) > 3000) continue;
      if (await sim.runtime.actors.isEssential(staged.reference)) continue;
      actor = staged.reference;
      break;
    }
    const at = await sim.position(actor);
    before = (await sim.runtime.actors.value(actor, ActorValue.health)).current;
    if (at) sim.runtime.move(actor, [at[0], at[1], at[2] + 1000]);
    await sim.step(4);
    after = (await sim.runtime.actors.value(actor, ActorValue.health)).current;
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('finds an NPC that is not essential', () => {
    expect(actor).not.toBe(0);
  });

  it('takes the NPCs’ falling damage as it lands (about 744: all its health)', () => {
    expect(before - after).toBeGreaterThanOrEqual(Math.min(before, 700));
  });
});
