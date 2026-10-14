// Integration test: collision, the character controller and the player's data on the local
// game data. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseControlMap, SCAN_CODES } from '../src/formats/controlmap/controlmap.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { decodeWindows1252 } from '../src/formats/text.ts';
import { CharacterBody } from '../src/physics/character.ts';
import { buildCollision } from '../src/physics/collision-data.ts';
import { GRAB_DEFAULTS, GrabSpring } from '../src/physics/grab.ts';
import {
  CollisionMatrix,
  Layer,
  parseCollisionLayer,
  type CollisionLayer,
} from '../src/physics/collision-layers.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from '../src/physics/physics-world.ts';
import { cellArrival, doorDestination, loadCellData } from '../src/world/cell-loader.ts';
import { MaterialFlag, materialId, parseMaterialType } from '../src/world/material-type.ts';
import { parseMovementType } from '../src/world/movement.ts';
import { readPlayerBody } from '../src/world/player-body.ts';
import { IniSettings } from '../src/world/ini-settings.ts';
import { Player } from '../src/shell/player.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Worldspace } from '../src/world/worldspace.ts';
import { WorldBorder } from '../src/world/border.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const BREEZEHOME = 0x000165a8;
const WHITERUN_WORLD = 0x0001a26f;

describe.skipIf(!hasGamedata())('physics on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let layers: CollisionLayer[];
  let matrix: CollisionMatrix;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    layers = [];
    for (const formId of db.formIdsOfType('COLL')) {
      const record = await db.get(formId);
      if (record) layers.push(parseCollisionLayer(record));
    }
    matrix = new CollisionMatrix(layers);
    await initPhysics();
  }, 60_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('reads the collision layers: 55, symmetric, the character controller among them', () => {
    expect(layers).toHaveLength(55);
    const byForm = new Map(layers.map((layer) => [layer.formId, layer.index]));
    for (const layer of layers) {
      for (const other of layer.collidesWith) {
        const index = byForm.get(other) ?? -1;
        const back = layers.find((candidate) => candidate.index === index);
        expect(back?.collidesWith.includes(layer.formId), `${layer.name} ↔ ${String(index)}`).toBe(
          true,
        );
      }
    }
    expect(matrix.collides(Layer.charController, Layer.static)).toBe(true);
    expect(matrix.collides(Layer.charController, Layer.stairHelper)).toBe(true);
    expect(matrix.collides(Layer.static, Layer.stairHelper)).toBe(false);
    expect(matrix.collides(Layer.charController, Layer.nonCollidable)).toBe(false);
  });

  it('reads a clutter item as a simulated convex body and a wall as a fixed mesh', async () => {
    const bucket = buildCollision(parseNif(await vfs.read('meshes\\clutter\\bucket01.nif')));
    expect(bucket.bodies).toHaveLength(1);
    expect(bucket.bodies[0]?.motion).toBe('dynamic');
    expect(bucket.bodies[0]?.layer).toBe(Layer.clutter);
    expect(bucket.bodies[0]?.mass).toBeCloseTo(22, 3);
    const wall = buildCollision(
      parseNif(
        await vfs.read('meshes\\architecture\\whiterun\\wrinteriors\\wrintfloorstmid01.nif'),
      ),
    );
    expect(wall.bodies[0]?.motion).toBe('fixed');
    expect(wall.bodies[0]?.shapes.some((shape) => shape.type === 'mesh')).toBe(true);
  });

  it('reads the control map and the movement types the player moves with', async () => {
    const map = parseControlMap(
      decodeWindows1252(await vfs.read('interface\\controls\\pc\\controlmap.txt')),
    );
    const event = (name: string) => map.contexts[0]?.find((candidate) => candidate.name === name);
    expect(SCAN_CODES.get(event('Forward')?.keys[0]?.[0] ?? 0)).toBe('KeyW');
    expect(SCAN_CODES.get(event('Activate')?.keys[0]?.[0] ?? 0)).toBe('KeyE');
    expect(SCAN_CODES.get(event('Jump')?.keys[0]?.[0] ?? 0)).toBe('Space');
    const types = new Map<string, ReturnType<typeof parseMovementType>>();
    for (const formId of db.formIdsOfType('MOVT')) {
      const record = await db.get(formId);
      if (record) types.set(parseMovementType(record).name, parseMovementType(record));
    }
    expect(types.get('NPCDefault')?.run.forward).toBeCloseTo(370, 3);
    expect(types.get('NPCDefault')?.walk.forward).toBeCloseTo(80.1, 1);
    expect(types.get('NPCSprinting')?.run.forward).toBeCloseTo(500, 3);
  });

  it('finds the stair materials by the hash of their names', async () => {
    const stairs: number[] = [];
    for (const formId of db.formIdsOfType('MATT')) {
      const record = await db.get(formId);
      const material = record && parseMaterialType(record);
      if (material && (material.flags & MaterialFlag.stairs) !== 0) stairs.push(material.id);
    }
    // SKY_HAV_MAT_STAIRS_STONE and SKY_HAV_MAT_STAIRS_WOOD in nif.xml.
    expect(stairs).toContain(899511101);
    expect(stairs).toContain(1461712277);
    expect(materialId('StairsStone')).toBe(899511101);
  });

  it("sizes the player from the race and the skeletons' bound and camera nodes", async () => {
    const body = await readPlayerBody(db, async (path) => parseNif(await vfs.read(path)));
    expect(body.raceEditorId).toBe('NordRace');
    expect(body.height).toBeCloseTo(1.03, 3);
    expect(body.bound.halfExtents[2] * 2).toBeCloseTo(128 * 1.03, 1);
    expect(body.eyeHeight).toBeCloseTo(120.5 * 1.03, 0);
  });

  it('arrives in front of the doors, inside and out', async () => {
    const data = await loadCellData(db, BREEZEHOME);
    const inside = await cellArrival(db, data);
    expect(inside?.position[0]).toBeCloseTo(-385, -1);
    const door = data.objects.find((object) => object.teleport);
    const out = door?.teleport && (await doorDestination(db, door.teleport));
    expect(out?.world).toBe(WHITERUN_WORLD);
    expect(out?.name).toBe('Whiterun');
    const world = await Worldspace.open(db, WHITERUN_WORLD);
    const arrival = await world.arrivalNear(22528, -6144);
    expect(arrival).toBeDefined();
  });

  it('stands, walks and stops at walls in Breezehome', async () => {
    const data = await loadCellData(db, BREEZEHOME);
    const physics = new PhysicsWorld(matrix, GRAVITY);
    for (const object of data.objects) {
      const collision = buildCollision(parseNif(await vfs.read(object.model)));
      physics.addObject(collision, object.world, { reference: object.reference, kind: 'object' });
    }
    physics.step(1 / 60);
    const arrival = await cellArrival(db, data);
    const [x, y, z] = arrival?.position ?? [0, 0, 0];
    const character = new CharacterBody(
      physics,
      { radius: 14.42, height: 131.84 },
      {
        maxSlope: 60,
        fallingGravity: 1.35,
        unsupportedGravity: 4,
        stairMaterials: new Set(),
        stairHeight: 24,
      },
      [x, y, z + 40],
      { reference: 0x14, kind: 'actor' },
    );
    const run = (seconds: number): void => {
      for (let i = 0; i < seconds * 60; i++) {
        physics.step(1 / 60, (dt) => {
          character.step(dt);
        });
      }
    };
    run(1);
    expect(character.grounded).toBe(true);
    // The floor of the entrance (64 units up in this cell).
    expect(character.feet[2]).toBeGreaterThan(55);
    expect(character.feet[2]).toBeLessThan(75);
    // Backwards (south) is the door: two seconds of running stop well short of the 4 m.
    character.velocity = [0, -370];
    run(2);
    expect(character.feet[1]).toBeGreaterThan(y - 120);
    physics.free();
  }, 60_000);

  it('runs over a floor of many triangles without stopping at their edges', () => {
    // A flat floor of 32 × 32 quads, 64 units each.
    const quads = 32;
    const vertices: number[] = [];
    const indices: number[] = [];
    for (let y = 0; y <= quads; y++) {
      for (let x = 0; x <= quads; x++) vertices.push(x * 64 - 1024, y * 64 - 1024, 0);
    }
    for (let y = 0; y < quads; y++) {
      for (let x = 0; x < quads; x++) {
        const a = y * (quads + 1) + x;
        indices.push(a, a + 1, a + quads + 2, a, a + quads + 2, a + quads + 1);
      }
    }
    const physics = new PhysicsWorld(matrix, GRAVITY);
    physics.addMesh(Float32Array.from(vertices), Uint32Array.from(indices), Layer.ground, {
      reference: 0,
      kind: 'landscape',
    });
    const character = new CharacterBody(
      physics,
      { radius: 14.42, height: 131.84 },
      {
        maxSlope: 60,
        fallingGravity: 1.35,
        unsupportedGravity: 4,
        stairMaterials: new Set(),
        stairHeight: 24,
      },
      [-600, -500, 1],
      { reference: 0x14, kind: 'actor' },
    );
    const step = (): void => {
      physics.step(1 / 60, (dt) => {
        character.step(dt);
      });
    };
    for (let i = 0; i < 30; i++) step();
    expect(character.grounded).toBe(true);
    // Running diagonally across the triangles' edges: every step covers its distance.
    let slowest = Infinity;
    for (let i = 0; i < 180; i++) {
      const before = character.feet;
      character.velocity = [370 * Math.cos(0.6), 370 * Math.sin(0.6)];
      step();
      const after = character.feet;
      slowest = Math.min(slowest, Math.hypot(after[0] - before[0], after[1] - before[1]));
    }
    expect(slowest).toBeGreaterThan(0.9 * (370 / 60));
    expect(character.grounded).toBe(true);
    physics.free();
  });

  it("stops the player at Tamriel's border regions", async () => {
    const border = await WorldBorder.of(db, 0x3c);
    expect(border.regions.map((region) => region.editorId).sort()).toEqual([
      'BorderRegionSkyrim',
      'DLC1BorderRegionSkyrim',
    ]);
    // Whiterun's plain and Castle Volkihar's island (Dawnguard's region) are inside.
    expect(border.contains(10 * 4096, -2 * 4096)).toBe(true);
    expect(border.contains(-41 * 4096, 32 * 4096)).toBe(true);
    // Far beyond the mountains around Skyrim is not.
    expect(border.contains(60 * 4096, -40 * 4096)).toBe(false);

    // A player running east on flat ground towards an edge at x = 400.
    const physics = new PhysicsWorld(matrix, GRAVITY);
    physics.addMesh(
      Float32Array.of(-2000, -2000, 0, 2000, -2000, 0, 2000, 2000, 0, -2000, 2000, 0),
      Uint32Array.of(0, 1, 2, 0, 2, 3),
      Layer.ground,
      { reference: 0, kind: 'landscape' },
    );
    const types = new Map<string, ReturnType<typeof parseMovementType>>();
    for (const formId of db.formIdsOfType('MOVT')) {
      const record = await db.get(formId);
      if (record) types.set(parseMovementType(record).name, parseMovementType(record));
    }
    const type = (name: string): ReturnType<typeof parseMovementType> => {
      const found = types.get(name);
      if (!found) throw new Error(name);
      return found;
    };
    const player = new Player(
      {
        body: await readPlayerBody(db, async (path) => parseNif(await vfs.read(path))),
        ini: new IniSettings(vfs.defaultIni),
        controls: parseControlMap(
          decodeWindows1252(await vfs.read('interface\\controls\\pc\\controlmap.txt')),
        ),
        movement: {
          normal: type('NPCDefault'),
          sprint: type('NPCSprinting'),
          sneak: type('NPCSneaking'),
          swim: type('NPCSwimming'),
        },
        jumpHeight: 76,
        grab: GRAB_DEFAULTS,
        stairMaterials: new Set(),
        physics,
        waterHeight: () => undefined,
      },
      [0, 0, 10],
      Math.PI / 2,
    );
    let warned = 0;
    player.border = (x) => x < 400;
    player.onBorder = () => {
      warned++;
    };
    player.press('Forward', true);
    for (let i = 0; i < 4 * 60; i++) player.update(1 / 60);
    expect(player.feet[0]).toBeGreaterThan(330);
    expect(player.feet[0]).toBeLessThan(400);
    expect(warned).toBeGreaterThan(0);
    physics.free();
  }, 60_000);

  it("holds the weapons on Warmaiden's racks and plaques as their scripts do", async () => {
    const cell = (await db.interiorCells()).find((c) => c.editorId === 'WhiterunWarmaidens');
    if (!cell) throw new Error('no Warmaidens');
    const data = await loadCellData(db, cell.formId);
    const held = data.objects.filter((object) => object.keyframed === true);
    // RackType 1 (its script's default) racks hold anything but a shield.
    expect(held.map((object) => object.baseType)).toEqual(held.map(() => 'WEAP'));
    expect(held.length).toBeGreaterThanOrEqual(5);
    expect(held.map((object) => object.editorId)).toContain('IronWarhammer');
  });

  it('lifts a grabbed bucket to the point held, and drops it when let go', async () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    physics.addMesh(
      Float32Array.of(-1000, -1000, 0, 1000, -1000, 0, 1000, 1000, 0, -1000, 1000, 0),
      Uint32Array.of(0, 1, 2, 0, 2, 3),
      Layer.ground,
      { reference: 0, kind: 'landscape' },
    );
    const bucket = buildCollision(parseNif(await vfs.read('meshes\\clutter\\bucket01.nif')));
    const world = new Float32Array(16);
    world.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 20, 1]);
    const placed = physics.addObject(bucket, world, { reference: 0x1234, kind: 'object' }, false);
    const body = placed.bodies[0]?.body;
    if (!body) throw new Error('no bucket body');
    // Placed to wait, it is held where it is until let go (as taking hold of it does).
    physics.release(body);
    for (let i = 0; i < 120; i++) physics.step(1 / 60);
    const resting = body.translation().z;
    // The collider is grabbable (a placed object's simulated body).
    const collider = placed.colliders[0];
    if (!collider) throw new Error('no bucket collider');
    expect(physics.grabbable(collider)).toBe(body);
    const t = body.translation();
    const start: [number, number, number] = [t.x * 69.99125, t.y * 69.99125, t.z * 69.99125];
    const spring = new GrabSpring(body, start, GRAB_DEFAULTS);
    spring.target = [start[0] + 30, start[1], start[2] + 80];
    for (let i = 0; i < 120; i++) {
      physics.step(1 / 60, (dt) => {
        spring.apply(dt);
      });
    }
    // Held where the spring pulls (gravity leaves it a little below).
    const held = spring.point;
    expect(Math.hypot(held[0] - spring.target[0], held[2] - spring.target[2])).toBeLessThan(12);
    for (let i = 0; i < 120; i++) physics.step(1 / 60);
    // Let go, it falls back to the floor (it may land on its side).
    expect(body.translation().z * 69.99125).toBeLessThan(resting * 69.99125 + 20);
    expect(Math.hypot(body.linvel().x, body.linvel().y, body.linvel().z)).toBeLessThan(0.05);
    physics.free();
  }, 60_000);

  it("lays a dead actor's ragdoll on the floor: its skeleton's bodies fall and lie still", async () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    physics.addMesh(
      Float32Array.of(-1000, -1000, 0, 1000, -1000, 0, 1000, 1000, 0, -1000, 1000, 0),
      Uint32Array.of(0, 1, 2, 0, 2, 3),
      Layer.ground,
      { reference: 0, kind: 'landscape' },
    );
    const skeleton = buildCollision(
      parseNif(await vfs.read('meshes\\actors\\character\\character assets\\skeleton.nif')),
    );
    const world = new Float32Array(16);
    world.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const placed = physics.addObject(skeleton, world, { reference: 0x1234, kind: 'actor' }, false);
    const bones = placed.bodies.filter(({ data }) => data.motion === 'dynamic' && !data.phantom);
    expect(bones.length).toBeGreaterThanOrEqual(18);
    expect(placed.joints.length).toBeGreaterThanOrEqual(17);
    const height = (name: string): number =>
      (bones.find(({ data }) => data.node === name)?.body.translation().z ?? NaN) * 69.99125;
    // Standing in the skeleton's rest pose, the head is up high.
    expect(height('NPC Head [Head]')).toBeGreaterThan(100);
    physics.settle(placed);
    for (let i = 0; i < 300; i++) physics.step(1 / 60);
    // Collapsed: the head near the floor, nothing through it, the joints held together.
    expect(height('NPC Head [Head]')).toBeLessThan(40);
    for (const { body } of bones) {
      expect(body.translation().z * 69.99125).toBeGreaterThan(-4);
      expect(Math.hypot(body.linvel().x, body.linvel().y, body.linvel().z)).toBeLessThan(0.1);
    }
    const pelvis = bones.find(({ data }) => data.node === 'NPC COM [COM ]')?.body.translation();
    const head = bones.find(({ data }) => data.node === 'NPC Head [Head]')?.body.translation();
    if (!pelvis || !head) throw new Error('no pelvis or head');
    expect(
      Math.hypot(head.x - pelvis.x, head.y - pelvis.y, head.z - pelvis.z) * 69.99125,
    ).toBeLessThan(80);
    physics.free();
  }, 60_000);

  it('floats, swims, dives and wades out of deep water', async () => {
    const physics = new PhysicsWorld(matrix, GRAVITY);
    // A lake floor at -500, a shore up to 20 at y 1000..1500, land beyond; water at 0 south of it.
    physics.addMesh(
      Float32Array.of(
        -3000,
        -3000,
        -500,
        3000,
        -3000,
        -500,
        3000,
        1000,
        -500,
        -3000,
        1000,
        -500,
        3000,
        1500,
        20,
        -3000,
        1500,
        20,
        3000,
        4000,
        20,
        -3000,
        4000,
        20,
      ),
      Uint32Array.of(0, 1, 2, 0, 2, 3, 3, 2, 4, 3, 4, 5, 5, 4, 6, 5, 6, 7),
      Layer.ground,
      { reference: 0, kind: 'landscape' },
    );
    const types = new Map<string, ReturnType<typeof parseMovementType>>();
    for (const formId of db.formIdsOfType('MOVT')) {
      const record = await db.get(formId);
      if (record) types.set(parseMovementType(record).name, parseMovementType(record));
    }
    const type = (name: string): ReturnType<typeof parseMovementType> => {
      const found = types.get(name);
      if (!found) throw new Error(name);
      return found;
    };
    const player = new Player(
      {
        body: await readPlayerBody(db, async (path) => parseNif(await vfs.read(path))),
        ini: new IniSettings(vfs.defaultIni),
        controls: parseControlMap(
          decodeWindows1252(await vfs.read('interface\\controls\\pc\\controlmap.txt')),
        ),
        movement: {
          normal: type('NPCDefault'),
          sprint: type('NPCSprinting'),
          sneak: type('NPCSneaking'),
          swim: type('NPCSwimming'),
        },
        jumpHeight: 76,
        grab: GRAB_DEFAULTS,
        stairMaterials: new Set(),
        physics,
        waterHeight: (_x, y) => (y < 1500 ? 0 : undefined),
      },
      [0, 0, 200],
      0,
    );
    const run = (seconds: number): void => {
      for (let i = 0; i < seconds * 60; i++) player.update(1 / 60);
    };
    run(3);
    expect(player.swimming).toBe(true);
    // Shoulders at the surface: 0.69 of the body's height under water.
    expect(player.feet[2]).toBeCloseTo(-0.69 * player.character.shape.height, -1);
    player.press('Forward', true);
    player.pitch = -0.8;
    run(1);
    expect(player.feet[2]).toBeLessThan(-200);
    player.pitch = 0.3;
    run(1.5);
    player.pitch = 0;
    run(5);
    expect(player.swimming).toBe(false);
    expect(player.character.grounded).toBe(true);
    expect(player.feet[2]).toBeGreaterThan(15);
    physics.free();
  }, 60_000);
});
