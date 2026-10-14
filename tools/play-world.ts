// The game's collision as the viewers place it, for the Node tools that walk the player around:
// the load order, the collision layers, the player's data, every model's collision (read once),
// which references are enabled, and cells placed into a physics world.

import { parseNif } from '../src/formats/nif/nif.ts';
import {
  buildCollision,
  placedCollision,
  type CollisionData,
} from '../src/physics/collision-data.ts';
import {
  Layer,
  readCollisionMatrix,
  type CollisionMatrix,
} from '../src/physics/collision-layers.ts';
import { landscapeMesh } from '../src/physics/landscape.ts';
import {
  GRAVITY,
  initPhysics,
  PhysicsWorld,
  type PlacedCollision,
} from '../src/physics/physics-world.ts';
import { Player, readPlayerData, type PlayerData } from '../src/shell/player.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import type { CellData } from '../src/world/cell-loader.ts';
import { enabledReferences, findToggles, gameStartSelection } from '../src/world/cell-upgrades.ts';
import { GameSettings } from '../src/world/game-settings.ts';
import type { LandData } from '../src/world/land.ts';
import {
  findHomeActions,
  fullyUpgraded,
  NEW_GAME,
  playHomeActions,
  ScriptEnvironment,
} from '../src/world/player-home.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { waterVolumes, type WaterVolume } from '../src/world/water-volumes.ts';
import { openGameFolder } from './gamedata-path.ts';

/** A cell's collision placed in a physics world, with names for what was placed. */
export interface PlacedCell {
  readonly placed: PlacedCollision[];
  /** Editor id (else model path) by reference. */
  readonly names: Map<number, string>;
}

export class PlayWorld {
  readonly vfs: Vfs;
  readonly db: RecordDatabase;
  readonly matrix: CollisionMatrix;
  readonly playerData: PlayerData;
  readonly #scripts: ScriptEnvironment;
  readonly #collisions = new Map<string, Promise<CollisionData | undefined>>();

  private constructor(
    vfs: Vfs,
    db: RecordDatabase,
    matrix: CollisionMatrix,
    playerData: PlayerData,
    scripts: ScriptEnvironment,
  ) {
    this.vfs = vfs;
    this.db = db;
    this.matrix = matrix;
    this.playerData = playerData;
    this.#scripts = scripts;
  }

  /** Opens the local game data (`.gamedata` or SKYRIM_DATA) and Rapier. */
  static async open(): Promise<PlayWorld> {
    const vfs = await Vfs.mount(openGameFolder());
    const db = await RecordDatabase.open(vfs);
    await initPhysics();
    const [matrix, settings, scripts] = await Promise.all([
      readCollisionMatrix(db),
      GameSettings.read(db),
      ScriptEnvironment.create(db, vfs),
    ]);
    const playerData = await readPlayerData(db, vfs, settings, async (path) =>
      parseNif(await vfs.read(path)),
    );
    return new PlayWorld(vfs, db, matrix, playerData, scripts);
  }

  /** A model's collision (none for models without, or that do not load). */
  collisionOf(path: string): Promise<CollisionData | undefined> {
    let pending = this.#collisions.get(path);
    if (!pending) {
      pending = (async () => {
        if (path === '' || !this.vfs.has(path)) return undefined;
        try {
          const collision = buildCollision(parseNif(await this.vfs.read(path)));
          return collision.bodies.length > 0 ? collision : undefined;
        } catch {
          return undefined;
        }
      })();
      this.#collisions.set(path, pending);
    }
    return pending;
  }

  /**
   * Which references are enabled: as at the start of a new game; with `homes`, player homes
   * bought and built (the interior viewer's default; their markers follow the scripts).
   */
  async enabledIn(data: CellData, homes: boolean): Promise<(reference: number) => boolean> {
    if (!homes) {
      const toggles = findToggles(data);
      return enabledReferences(data, toggles, gameStartSelection(toggles));
    }
    const actions = await findHomeActions(this.#scripts, data);
    const scripted =
      actions.purchases.length > 0 || actions.house
        ? (await playHomeActions(this.#scripts, actions, fullyUpgraded(actions, NEW_GAME))).enabled
        : new Map<number, boolean>();
    const toggles = findToggles(data, actions.controlled);
    return enabledReferences(data, toggles, gameStartSelection(toggles), scripted);
  }

  newPhysics(): PhysicsWorld {
    return new PhysicsWorld(this.matrix, GRAVITY);
  }

  /** The player in a physics world, with the surface of the water a point is in or over. */
  newPlayer(
    physics: PhysicsWorld,
    water: (x: number, y: number, z: number) => number | undefined,
  ): Player {
    return new Player({ ...this.playerData, physics, waterHeight: water }, [0, 0, 0], 0);
  }

  /** The water volumes of a cell's enabled water activators. */
  async waterVolumesIn(
    data: CellData,
    isEnabled: (reference: number) => boolean,
  ): Promise<WaterVolume[]> {
    const water = data.objects.filter(
      (object) => object.water !== undefined && isEnabled(object.reference),
    );
    const volumes = await Promise.all(
      water.map(async (object) =>
        waterVolumes(await this.collisionOf(object.model), object.world, object.water ?? 0),
      ),
    );
    return volumes.flat();
  }

  /** Places a cell's enabled objects and primitives (and its landscape) as PlaySession does. */
  async placeCell(
    physics: PhysicsWorld,
    data: CellData,
    isEnabled: (reference: number) => boolean,
    land?: { readonly data: LandData; readonly x: number; readonly y: number },
  ): Promise<PlacedCell> {
    const placed: PlacedCollision[] = [];
    const names = new Map<number, string>();
    if (land) {
      const { vertices, indices } = landscapeMesh(land.data, land.x, land.y);
      placed.push(
        physics.addMesh(vertices, indices, Layer.ground, { reference: 0, kind: 'landscape' }),
      );
    }
    const objects = data.objects.filter((object) => isEnabled(object.reference));
    const loaded = await Promise.all(
      objects.map(async (object) =>
        placedCollision(object.baseType, await this.collisionOf(object.model)),
      ),
    );
    objects.forEach((object, i) => {
      const collision = loaded[i];
      if (!collision) return;
      const one = physics.addObject(
        collision,
        object.world,
        { reference: object.reference, kind: 'object' },
        false,
      );
      placed.push(one);
      names.set(object.reference, object.editorId !== '' ? object.editorId : object.model);
      if (object.dontHavokSettle !== true && one.dynamic) physics.settle(one);
    });
    for (const primitive of data.primitives) {
      if (!isEnabled(primitive.reference)) continue;
      placed.push(
        physics.addPrimitive(primitive.shape, primitive.bounds, primitive.world, primitive.layer, {
          reference: primitive.reference,
          kind: 'object',
        }),
      );
      names.set(primitive.reference, `collision ${primitive.shape}`);
    }
    return { placed, names };
  }
}
