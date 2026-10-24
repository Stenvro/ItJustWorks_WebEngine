// The map (interface\map.swf: M, or the tween menu's Map). The movie is the map's frame and
// icons over the engine's 3D world map (src/shell/world-map-view.ts): the engine gives it the
// markers to make (WorldMap.MarkerData: name, icon, undiscovered; SetNumMarkers, then
// CreateMarkers until GetCreatingMarkers is done) and every frame where they stand (MarkerData:
// shown, x and y as shares of the screen, rotation; RefreshMarkers). The marker the cursor is
// on (fMaxMarkerSelectionDist) is the engine's choice: MarkerDescriptionObj.SetDescription (its
// name, the quests there), then SetSelectedMarker. A click on the map (ClickCallback) on that
// marker asks the movie for it (ClickSelectedMarker → MarkerClick): a discovered place fast
// travels (sFastTravelConfirm), an undiscovered one offers the player's own marker
// (sPlaceMarkerUndiscovered), the player's own marker is moved or removed (sMoveMarkerQuestion);
// P places it under the cursor. E (PlayerPosition, or the bottom bar's button) goes back to the
// player, J (or its button) opens the journal, L the local map (LocalMapFader.MapClip); Tab and
// Esc close the map. The markers: the map markers seen (and those the plugin shows), their
// discovered or undiscovered icon; the targets of the active quests' shown objectives (several
// at one place: one marker for all); the player's own; the player, an arrow turned with them.
// What is inside (a dungeon, a house) shows at the door that leads in. The map's acoustic
// space (UIWorldMap: the wind) plays while it is open. Notes: docs/ui.md ("The map").

import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { Menu, MenuHost } from '../ui/menu-host.ts';
import { exteriorOfCell } from '../world/exterior-doors.ts';
import { formatGameDate } from '../world/game-time.ts';
import type { GameSettings } from '../world/game-settings.ts';
import { CELL_SIZE, landHeightAt } from '../world/land.ts';
import {
  MapIcon,
  MapMarkerFlag,
  onMapPosition,
  readMapMarkers,
  type MapMarker,
} from '../world/map-markers.ts';
import { ParentUse, parseWorldspace, type WorldspaceRecord } from '../world/worldspace.ts';
import type { Vec3 } from '../render/math.ts';
import type { SceneView } from '../render/renderer.ts';
import { questTargets } from './compass.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';
import { WorldMapView } from './world-map-view.ts';
import { LocalMap, type LocalMapContent, type LocalMapMarker } from './local-map.ts';
import type { OverlayView } from '../render/menu-overlay.ts';
import { doorDestination } from '../world/cell-loader.ts';

const ROOT = '_root.WorldMap';
/** UIWorldMap (Skyrim.esm): the acoustic space the map plays (its wind loop). */
const MAP_ACOUSTIC_SPACE = 0xc276b;
/** The default map world ([MapMenu] sMapWorldDefaultWorldSpace). */
const DEFAULT_MAP_WORLD = 'Tamriel';
/** Places of quest targets within this distance of each other share one marker. */
const SAME_PLACE = 512;

/** What the map asks of the game being played. */
export interface MapWorld {
  /** The player's heading (radians, clockwise from north). */
  heading(): number | undefined;
  /** What the local map shows where the player is, if anything. */
  localMap(): LocalMapContent | undefined;
  /** A message box with buttons; resolves with the button chosen. */
  confirm(text: string, buttons: readonly string[]): Promise<number>;
  /** Why the player may not fast travel now (a setting's name), if they may not. */
  noFastTravelReason(): Promise<string | undefined>;
  /** Fast travel to a map marker (the map has closed), `distance` away on the map. */
  fastTravel(marker: number, distance: number | undefined): Promise<void>;
  /** The journal (the map has closed). */
  openJournal(): void;
}

type ShownKind = 'location' | 'quest' | 'custom' | 'player';

/** A marker on the map: its icon, name and place (on the map's world). */
interface ShownMarker {
  readonly kind: ShownKind;
  readonly name: string;
  readonly icon: number;
  readonly undiscovered: boolean;
  readonly position: Vec3;
  /** A map marker's reference (fast travel goes there). */
  readonly reference?: number;
  /** The quests whose targets are here. */
  readonly quests: readonly string[];
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Pixels of the cursor's movement, and keys held, while the map is open. */
interface MapInput {
  cursor: [number, number] | undefined;
  look: [number, number];
  looking: boolean;
  keys: Set<string>;
}

export class MapMenu {
  readonly #host: MenuHost;
  readonly #session: GameSession;
  readonly #terminal: Terminal;
  readonly #world: MapWorld;
  readonly #worldRecords = new Map<number, Promise<WorldspaceRecord | undefined>>();
  #markers: Promise<MapMarker[]> | undefined;
  #markersOf: ScriptRuntime | undefined;

  constructor(host: MenuHost, session: GameSession, terminal: Terminal, world: MapWorld) {
    this.#host = host;
    this.#session = session;
    this.#terminal = terminal;
    this.#world = world;
  }

  /**
   * Opens the map (on a reference: the journal's Show on Map; else on the player); `closed`
   * once it has closed. Undefined if there is no map here.
   */
  async open(
    depth: number,
    closed: () => void,
    focus?: number,
  ): Promise<{ readonly menu: Menu; close(): void } | undefined> {
    const session = this.#session;
    const runtime = session.scriptsReady;
    if (!runtime) return undefined;
    const db = runtime.forms.db;
    const settings = await session.settings();
    const at = session.scriptWorld.livePlacement(PLAYER_REF);
    // The world shown and the player's place on its map.
    let worldId = at?.world;
    let playerAt: Vec3 | undefined;
    if (at && worldId !== undefined) {
      const record = await this.#worldRecord(worldId);
      playerAt = record && onMapPosition(record.mapOffset, at.position);
    } else if (at?.cell !== undefined) {
      const outside = await exteriorOfCell(db, at.cell);
      if (outside) {
        worldId = outside.world;
        const record = await this.#worldRecord(outside.world);
        playerAt = record && onMapPosition(record.mapOffset, outside.position);
      }
    }
    worldId ??= (await db.worldspaces()).find(
      (info) => info.editorId.toLowerCase() === DEFAULT_MAP_WORLD.toLowerCase(),
    )?.formId;
    if (worldId === undefined) return undefined;
    // Show on Map: the map of the target's world, over the target.
    let focusAt: Vec3 | undefined;
    if (focus !== undefined) {
      const target = await runtime.placement(focus);
      const place =
        target?.world !== undefined
          ? { world: target.world, position: target.position }
          : target?.cell !== undefined
            ? await exteriorOfCell(db, target.cell)
            : undefined;
      const record = place && (await this.#worldRecord(place.world));
      focusAt = record ? onMapPosition(record.mapOffset, place.position) : undefined;
      if (record && focusAt) {
        const shownRecord = await this.#worldRecord(worldId);
        if (!shownRecord || mapWorldOf(shownRecord) !== mapWorldOf(record)) {
          // The target is on another map: that map, without the player.
          worldId = place.world;
          playerAt = undefined;
        }
      }
    }
    const shown = await session.worldspace(worldId);
    const view = await WorldMapView.create(
      session,
      this.#terminal,
      shown,
      focusAt ?? playerAt ?? [0, 0, 0],
    );
    if (!view) {
      this.#terminal.log('map', `${shown.record.editorId} has no world map`, 'warn');
      return undefined;
    }
    if (!playerAt && !focusAt) {
      // Nowhere on this map: the map's middle.
      const [west, north] = view.map.northWest;
      const [east, south] = view.map.southEast;
      view.camera.glideTo(
        ((west + east + 1) / 2) * CELL_SIZE,
        ((north + south + 1) / 2) * CELL_SIZE,
      );
    }
    return new OpenMap(this, view, settings, runtime, playerAt, depth, closed).start();
  }

  get host(): MenuHost {
    return this.#host;
  }

  get session(): GameSession {
    return this.#session;
  }

  get terminal(): Terminal {
    return this.#terminal;
  }

  get world(): MapWorld {
    return this.#world;
  }

  /** A worldspace's record (its map world and map offset), read once. */
  worldRecord(formId: number): Promise<WorldspaceRecord | undefined> {
    return this.#worldRecord(formId);
  }

  #worldRecord(formId: number): Promise<WorldspaceRecord | undefined> {
    let record = this.#worldRecords.get(formId);
    if (!record) {
      record = this.#session.db.then(async (db) => {
        const found = await db.get(formId);
        return found?.type === 'WRLD' ? parseWorldspace(found) : undefined;
      });
      this.#worldRecords.set(formId, record);
    }
    return record;
  }

  /** Every map marker of the load order (read once per game). */
  mapMarkers(runtime: ScriptRuntime): Promise<MapMarker[]> {
    if (this.#markersOf !== runtime || !this.#markers) {
      this.#markersOf = runtime;
      this.#markers = readMapMarkers(runtime.forms.db);
    }
    return this.#markers;
  }
}

/** The map while it is open. */
class OpenMap {
  readonly #owner: MapMenu;
  readonly #view: WorldMapView;
  readonly #settings: GameSettings;
  readonly #runtime: ScriptRuntime;
  readonly #playerAt: Vec3 | undefined;
  readonly #depth: number;
  readonly #closed: () => void;
  readonly #input: MapInput = { cursor: undefined, look: [0, 0], looking: false, keys: new Set() };
  #menu: Menu | undefined;
  #markers: ShownMarker[] = [];
  #created = false;
  #selected = -1;
  #previousView: SceneView | undefined;
  #done = false;
  /** Move It chosen: the next click places the player's marker. */
  #moving = false;
  /** A message box or a fast travel in progress: the map takes no clicks. */
  #busy = false;
  /** The local map, while it is shown (or fading out). */
  #local: LocalMap | undefined;
  #previousOverlay: OverlayView | undefined;
  /** Dragging the local map (LocalMapMoveMode: the left button held on it). */
  #dragging = false;
  #lastFrame: number | undefined;

  constructor(
    owner: MapMenu,
    view: WorldMapView,
    settings: GameSettings,
    runtime: ScriptRuntime,
    playerAt: Vec3 | undefined,
    depth: number,
    closed: () => void,
  ) {
    this.#owner = owner;
    this.#view = view;
    this.#settings = settings;
    this.#runtime = runtime;
    this.#playerAt = playerAt;
    this.#depth = depth;
    this.#closed = closed;
  }

  async start(): Promise<{ readonly menu: Menu; close(): void }> {
    const owner = this.#owner;
    const session = owner.session;
    const renderer = session.renderer;
    this.#markers = await this.#collectMarkers();
    // The renderer draws the map in place of the world until it closes.
    this.#previousView = renderer.view;
    const view = this.#view.view();
    renderer.setView({
      ...view,
      update: () => {
        this.#view.update();
        this.#refresh();
        this.#refreshLocal();
      },
    });
    this.#view.camera.input = () => this.#cameraInput();
    void session.sounds().then((sounds) => {
      if (!this.#done) {
        sounds.setMenuSpace(
          MAP_ACOUSTIC_SPACE,
          session.ini.number('MapMenu', 'fMapLoopFadeTimeSeconds'),
        );
      }
    });
    const date = formatGameDate(
      this.#runtime.date,
      this.#runtime.dayOfWeek,
      this.#runtime.gameHour,
      (name) => this.#settings.string(name),
    );
    // The local map's picture is the engine's (drawn under the movie): the movie gets none.
    owner.host.files.emptyImage('Local_Map');
    const menu = await owner.host.open('map.swf', {
      depth: this.#depth,
      interactive: true,
      onKey: (_menu, event) => this.#key(event),
      handlers: {
        ClickCallback: () => {
          this.#click();
        },
        MarkerClick: (_menu, args) => {
          // (its request id, then the marker's index)
          const index = Number(args[1]);
          void this.#markerClicked(index);
        },
        CurrentLocationCallback: () => {
          this.#toPlayer();
        },
        OpenJournalCallback: () => {
          this.#journal();
        },
        ToggleMapCallback: () => {
          void this.#toggleLocal();
        },
        SetLocalMapExtents: (_menu, args) => {
          this.#local?.extents(args);
        },
      },
      setup: async (opened) => {
        if (!(await opened.waitFor(`${ROOT}.SetNumMarkers`))) return;
        opened.invoke('_root.InitExtensions');
        opened.invoke('_root.SetPlatform', 0, false);
        // Its size from the stage's rects as they are now (it read them as it started).
        opened.invoke(`${ROOT}.onResize`);
        opened.set(`${ROOT}.PlayerLocationMarkerType`, MapIcon.youAreHere);
        opened.call('SetDateString', date);
        this.#created = false;
        this.#selected = -1;
        this.#createMarkers(opened);
      },
    });
    this.#menu = menu;
    const element = menu.element;
    element?.addEventListener('pointermove', this.#moved);
    element?.addEventListener('pointerdown', this.#pressed);
    element?.addEventListener('pointerup', this.#released);
    element?.addEventListener('pointerleave', this.#left);
    element?.addEventListener('wheel', this.#wheel, { passive: true });
    element?.addEventListener('contextmenu', this.#noMenu);
    // Before the menu host takes the keys it gave the map (capture, on the window).
    window.addEventListener('keyup', this.#keyUp, { capture: true });
    window.addEventListener('blur', this.#blurred);
    return {
      menu,
      close: () => {
        this.#close();
      },
    };
  }

  // --- Markers -------------------------------------------------------------------------------

  async #collectMarkers(): Promise<ShownMarker[]> {
    const owner = this.#owner;
    const runtime = this.#runtime;
    const settings = this.#settings;
    const mapWorld = this.#view.world.record.formId;
    const onThisMap = async (
      world: number | undefined,
      position: Vec3,
    ): Promise<Vec3 | undefined> => {
      if (world === undefined) return undefined;
      const record = await owner.worldRecord(world);
      if (!record) return undefined;
      return mapWorldOf(record) === mapWorld
        ? onMapPosition(record.mapOffset, position)
        : undefined;
    };
    const shown: ShownMarker[] = [];
    // The map markers seen or shown.
    for (const marker of await owner.mapMarkers(runtime)) {
      const visible =
        runtime.mapMarkerVisible(marker.reference) || (marker.flags & MapMarkerFlag.visible) !== 0;
      if (!visible) continue;
      const position = await onThisMap(marker.world, marker.position);
      if (!position) continue;
      const discovered =
        runtime.mapMarkerFastTravel(marker.reference) ||
        (marker.flags & MapMarkerFlag.canTravel) !== 0;
      shown.push({
        kind: 'location',
        name: marker.name,
        icon: marker.type,
        undiscovered: !discovered,
        position,
        reference: marker.reference,
        quests: [],
      });
    }
    // The active quests' targets, those inside at the door that leads in.
    const places: { position: Vec3; quests: string[] }[] = [];
    for (const target of await questTargets(runtime)) {
      const { placement } = target;
      let position: Vec3 | undefined;
      if (placement.world !== undefined) {
        position = await onThisMap(placement.world, placement.position);
      } else if (placement.cell !== undefined) {
        const outside = await exteriorOfCell(runtime.forms.db, placement.cell);
        if (outside) position = await onThisMap(outside.world, outside.position);
      }
      if (!position) continue;
      const near = places.find(
        (place) =>
          Math.hypot(place.position[0] - position[0], place.position[1] - position[1]) < SAME_PLACE,
      );
      if (near) {
        if (!near.quests.includes(target.questName)) near.quests.push(target.questName);
      } else places.push({ position, quests: [target.questName] });
    }
    for (const place of places) {
      shown.push({
        kind: 'quest',
        name: place.quests.length === 1 ? (place.quests[0] ?? '') : '',
        icon: place.quests.length > 1 ? MapIcon.multipleQuestTargets : MapIcon.questTarget,
        undiscovered: false,
        position: place.position,
        quests: place.quests,
      });
    }
    // The player's own marker, and the player.
    const own = runtime.state.playerMarker;
    if (own?.world === mapWorld) {
      shown.push({
        kind: 'custom',
        name: settings.string('sPlayerSetMarkerName') ?? '',
        icon: MapIcon.playerSet,
        undiscovered: false,
        position: [...own.position],
        quests: [],
      });
    }
    if (this.#playerAt) {
      shown.push({
        kind: 'player',
        name: '',
        icon: MapIcon.youAreHere,
        undiscovered: false,
        position: this.#playerAt,
        quests: [],
      });
    }
    return shown;
  }

  /** Makes the markers' clips (all at once: the movie makes up to ten a call). */
  #createMarkers(menu: Menu): void {
    const data: unknown[] = [];
    for (const marker of this.#markers) data.push(marker.name, marker.icon, marker.undiscovered);
    menu.set(`${ROOT}.MarkerData`, data);
    menu.invoke(`${ROOT}.SetNumMarkers`, this.#markers.length);
    for (let guard = 0; guard < 1000; guard++) {
      if (menu.invoke(`${ROOT}.GetCreatingMarkers`) !== true) break;
      menu.invoke(`${ROOT}.CreateMarkers`);
    }
    this.#created = true;
  }

  /** Every frame: where the markers stand on the screen, and which one the cursor is on. */
  #refresh(): void {
    const menu = this.#menu;
    if (!menu || !this.#created || this.#done) return;
    const aspect = this.#aspect();
    const camera = this.#view.camera;
    const heading = this.#owner.world.heading();
    const data: unknown[] = [];
    let nearest = -1;
    let nearestDistance = this.#owner.session.ini.number('MapMenu', 'fMaxMarkerSelectionDist');
    const cursor = this.#input.cursor;
    this.#markers.forEach((marker, index) => {
      const at = camera.project(marker.position, aspect);
      const shown =
        at !== undefined &&
        at[0] >= 0 &&
        at[0] <= 1 &&
        at[1] >= 0 &&
        at[1] <= 1 &&
        this.#local?.covers(at) !== true;
      const rotation =
        marker.kind === 'player' && heading !== undefined
          ? (heading * 180) / Math.PI - camera.yaw
          : 0;
      data.push(shown, at?.[0] ?? 0, at?.[1] ?? 0, rotation);
      if (!shown || !cursor || marker.kind === 'player' || this.#local) return;
      // In the screen's height: the selection distance is squared.
      const dx = (at[0] - cursor[0]) * aspect;
      const dy = at[1] - cursor[1];
      const distance = dx * dx + dy * dy;
      if (distance <= nearestDistance) {
        nearestDistance = distance;
        nearest = index;
      }
    });
    menu.set(`${ROOT}.MarkerData`, data);
    menu.invoke(`${ROOT}.RefreshMarkers`);
    if (nearest !== this.#selected && !this.#input.looking) this.#select(menu, nearest);
  }

  #select(menu: Menu, index: number): void {
    this.#selected = index;
    const marker = this.#markers[index];
    if (marker) {
      const lines =
        marker.kind === 'quest' && marker.quests.length > 1
          ? marker.quests.map((quest) => ({ Item: '', Value: quest }))
          : [];
      menu.invoke(`${ROOT}.MarkerDescriptionObj.SetDescription`, marker.name, lines);
    }
    menu.invoke(`${ROOT}.SetSelectedMarker`, index);
  }

  // --- Clicks --------------------------------------------------------------------------------

  /** A click on the map (not on its bottom bar). */
  #click(): void {
    const menu = this.#menu;
    if (!menu || this.#busy || this.#input.looking || this.#local) return;
    if (this.#moving) {
      this.#moving = false;
      void this.#placeMarker();
      return;
    }
    // The marker under the cursor now (the click may come before the frame that chose it).
    this.#refresh();
    if (this.#selected >= 0) menu.invoke(`${ROOT}.ClickSelectedMarker`);
  }

  async #markerClicked(index: number): Promise<void> {
    const marker = this.#markers[index];
    if (!marker || this.#busy) return;
    const string = (name: string): string => this.#settings.string(name) ?? '';
    const world = this.#owner.world;
    this.#busy = true;
    try {
      if (marker.kind === 'location' && !marker.undiscovered && marker.reference !== undefined) {
        const reason = await world.noFastTravelReason();
        if (reason) {
          await world.confirm(string(reason), [string('sOk')]);
          return;
        }
        const travel = string('sFastTravelConfirm').replace('%s', marker.name);
        const choice = await world.confirm(travel, [string('sYes'), string('sNo')]);
        if (choice !== 0 || this.#done) return;
        const reference = marker.reference;
        const from = this.#playerAt;
        const distance =
          from && Math.hypot(marker.position[0] - from[0], marker.position[1] - from[1]);
        this.#close();
        await world.fastTravel(reference, distance);
      } else if (marker.kind === 'location') {
        const choice = await world.confirm(string('sPlaceMarkerUndiscovered'), [
          string('sYes'),
          string('sNo'),
        ]);
        if (choice === 0) this.#setPlayerMarker(marker.position);
      } else if (marker.kind === 'custom') {
        const choice = await world.confirm(string('sMoveMarkerQuestion'), [
          string('sMoveMarker'),
          string('sRemoveMarker'),
          string('sLeaveMarker'),
        ]);
        if (choice === 0) this.#moving = true;
        else if (choice === 1) this.#setPlayerMarker(undefined);
      }
    } catch (error) {
      this.#owner.terminal.log('map', describe(error), 'error');
    } finally {
      this.#busy = false;
      this.#menu?.focus();
    }
  }

  /** The player's own marker at the ground under the cursor (P, or Move It's click). */
  async #placeMarker(): Promise<void> {
    const cursor = this.#input.cursor;
    if (!cursor) return;
    const ground = await this.#groundAt(cursor);
    if (ground) this.#setPlayerMarker(ground);
  }

  #setPlayerMarker(position: Vec3 | undefined): void {
    const state = this.#runtime.state;
    state.playerMarker = position && {
      world: this.#view.world.record.formId,
      position: [...position],
    };
    // The markers again with the player's marker where it now is.
    void this.#collectMarkers().then((markers) => {
      const menu = this.#menu;
      if (!menu || this.#done) return;
      this.#markers = markers;
      this.#selected = -1;
      this.#createMarkers(menu);
    });
  }

  /**
   * The ground under a screen point: the ray from the camera down to the landscape (stepped
   * onto the land's height a few times from sea level).
   */
  async #groundAt(screen: readonly [number, number]): Promise<Vec3 | undefined> {
    const camera = this.#view.camera;
    const aspect = this.#aspect();
    let height = 0;
    let point: [number, number] | undefined;
    for (let step = 0; step < 5; step++) {
      point = camera.ground(screen, aspect, height);
      if (!point) return undefined;
      const cellX = Math.floor(point[0] / CELL_SIZE);
      const cellY = Math.floor(point[1] / CELL_SIZE);
      const land = await this.#view.world.land(cellX, cellY);
      const found = land && landHeightAt(land, cellX, cellY, point[0], point[1]);
      if (found === undefined) break;
      height = found;
    }
    return point && [point[0], point[1], height];
  }

  // --- The local map -------------------------------------------------------------------------

  /** L, or the bottom bar's button: the local map shown, or faded out. */
  async #toggleLocal(): Promise<void> {
    const menu = this.#menu;
    if (!menu || this.#busy) return;
    const shown = this.#local;
    if (shown) {
      shown.hide();
      return;
    }
    const owner = this.#owner;
    const content = owner.world.localMap();
    const at = owner.session.scriptWorld.livePlacement(PLAYER_REF);
    if (!content || !at) return;
    const ini = owner.session.ini;
    const map = (key: Parameters<typeof ini.number<'MapMenu'>>[1]): number =>
      ini.number('MapMenu', key);
    const local = new LocalMap(
      menu,
      content,
      {
        height: map('fMapLocalHeight'),
        minWidth: map('fMapLocalMinFrustumWidth'),
        zoomSpeed: map('fMapLocalMouseZoomSpeed'),
        cursorPanSpeed: map('fMapLocalCursorPanSpeed'),
        mousePanSpeed: map('fMapLocalMousePanSpeed'),
        cursorMoveArea: map('fMapWorldCursorMoveArea'),
        selectionDistance: map('fMapLocalMarkerSelectionDist'),
      },
      at.position,
      content.cell === undefined ? undefined : this.#runtime.state.seen.get(content.cell),
    );
    this.#local = local;
    const renderer = owner.session.renderer;
    this.#previousOverlay = renderer.overlay;
    renderer.overlay = local.overlay(() => renderer.size);
    const [title, cleared] = await this.#localTitle();
    const markers = await this.#localMarkers(content, at.position);
    if (this.#local !== local) return;
    local.show(title, cleared, markers);
  }

  /** The location's name, and sCleared if the maps show it cleared (location-clearing.ts). */
  async #localTitle(): Promise<[string, string | undefined]> {
    const runtime = this.#runtime;
    const location = await runtime.locationOf(PLAYER_REF);
    if (location === undefined) return ['', undefined];
    const name = (await runtime.forms.record(location))?.text('FULL') ?? '';
    const cleared = await runtime.locationClearing.shownCleared(location);
    return [name, cleared ? this.#settings.string('sCleared') : undefined];
  }

  /**
   * The local map's markers in the loaded area: the load doors (their destination's name), the
   * map markers, the quests' targets there, the player's own marker and the player.
   */
  async #localMarkers(content: LocalMapContent, at: Vec3): Promise<LocalMapMarker[]> {
    const runtime = this.#runtime;
    const db = runtime.forms.db;
    const { min, max } = content.area;
    const inside = (position: readonly number[]): boolean =>
      (position[0] ?? 0) >= min[0] &&
      (position[0] ?? 0) <= max[0] &&
      (position[1] ?? 0) >= min[1] &&
      (position[1] ?? 0) <= max[1];
    const here = this.#owner.session.scriptWorld.livePlacement(PLAYER_REF);
    const sameSpace = (placement: { world?: number; cell?: number }): boolean =>
      here?.world !== undefined
        ? placement.world === here.world
        : placement.cell !== undefined && placement.cell === here?.cell;
    const markers: LocalMapMarker[] = [];
    for (const door of content.doors()) {
      const destination = await doorDestination(db, door.teleport);
      markers.push({
        name: destination?.name ?? '',
        icon: MapIcon.door,
        undiscovered: false,
        position: door.position,
        lines: [],
      });
    }
    if (here?.world !== undefined) {
      for (const marker of await this.#owner.mapMarkers(runtime)) {
        if (marker.world !== here.world || !inside(marker.position)) continue;
        const visible =
          runtime.mapMarkerVisible(marker.reference) ||
          (marker.flags & MapMarkerFlag.visible) !== 0;
        if (!visible) continue;
        const discovered =
          runtime.mapMarkerFastTravel(marker.reference) ||
          (marker.flags & MapMarkerFlag.canTravel) !== 0;
        markers.push({
          name: marker.name,
          icon: marker.type,
          undiscovered: !discovered,
          position: marker.position,
          lines: [],
        });
      }
    }
    const quests = new Map<string, { position: Vec3; names: string[] }>();
    for (const target of await questTargets(runtime)) {
      const { placement } = target;
      if (!sameSpace(placement) || !inside(placement.position)) continue;
      const key = placement.position.map((v) => Math.round(v / SAME_PLACE)).join(',');
      const place = quests.get(key) ?? { position: placement.position, names: [] };
      if (!place.names.includes(target.questName)) place.names.push(target.questName);
      quests.set(key, place);
    }
    for (const place of quests.values()) {
      markers.push({
        name: place.names.length === 1 ? (place.names[0] ?? '') : '',
        icon: place.names.length > 1 ? MapIcon.multipleQuestTargets : MapIcon.questTarget,
        undiscovered: false,
        position: place.position,
        lines: place.names.length > 1 ? place.names : [],
      });
    }
    const own = runtime.state.playerMarker;
    if (own && here?.world !== undefined && inside(own.position)) {
      const record = await this.#owner.worldRecord(here.world);
      if (record && mapWorldOf(record) === own.world) {
        markers.push({
          name: this.#settings.string('sPlayerSetMarkerName') ?? '',
          icon: MapIcon.playerSet,
          undiscovered: false,
          position: [...own.position],
          lines: [],
        });
      }
    }
    const heading = this.#owner.world.heading();
    markers.push({
      name: '',
      icon: MapIcon.youAreHere,
      undiscovered: false,
      position: at,
      ...(heading !== undefined && { heading: (heading * 180) / Math.PI }),
      lines: [],
    });
    return markers;
  }

  /** Every frame while the local map is shown: its icons, the cursor at its sides. */
  #refreshLocal(): void {
    const local = this.#local;
    const now = performance.now();
    const delta = this.#lastFrame === undefined ? 0 : Math.min(0.1, (now - this.#lastFrame) / 1000);
    this.#lastFrame = now;
    if (!local || this.#done) return;
    if (local.gone) {
      this.#local = undefined;
      this.#dragging = false;
      this.#owner.session.renderer.overlay = this.#previousOverlay;
      return;
    }
    if (!this.#dragging && !this.#busy) local.edgePan(this.#input.cursor, delta);
    local.refresh(this.#input.cursor);
  }

  // --- Moving about --------------------------------------------------------------------------

  #toPlayer(): void {
    const at = this.#playerAt;
    if (at) this.#view.camera.glideTo(at[0], at[1]);
  }

  #journal(): void {
    this.#close();
    this.#owner.world.openJournal();
  }

  #cameraInput(): {
    pan: readonly [number, number];
    cursor: readonly [number, number] | undefined;
    look: readonly [number, number];
  } {
    const input = this.#input;
    const keys = input.keys;
    const pan: [number, number] = [
      (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0),
      (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0),
    ];
    const look: [number, number] = [input.look[0], input.look[1]];
    input.look = [0, 0];
    // While the local map is shown the keys and the cursor move it, not the world map.
    const still = this.#busy || this.#local !== undefined;
    return {
      pan: still ? [0, 0] : pan,
      cursor: still || input.looking ? undefined : input.cursor,
      look: this.#local ? [0, 0] : look,
    };
  }

  /** Keys the engine handles itself (the control map's map context). */
  #key(event: KeyboardEvent): boolean {
    if (this.#busy) return false;
    switch (event.code) {
      case 'KeyW':
      case 'KeyA':
      case 'KeyS':
      case 'KeyD':
        if (event.type === 'keydown') this.#input.keys.add(event.code);
        else this.#input.keys.delete(event.code);
        return true;
      case 'KeyE':
        if (event.type === 'keydown' && !event.repeat) this.#toPlayer();
        return true;
      case 'KeyJ':
        if (event.type === 'keydown' && !event.repeat) this.#journal();
        return true;
      case 'KeyP':
        if (event.type === 'keydown' && !event.repeat) void this.#placeMarker();
        return true;
      case 'KeyL':
        if (event.type === 'keydown' && !event.repeat) void this.#toggleLocal();
        return true;
      case 'Tab':
      case 'Escape':
        if (event.type === 'keydown' && !event.repeat) this.#close();
        return true;
      default:
        return false;
    }
  }

  readonly #keyUp = (event: KeyboardEvent): void => {
    this.#input.keys.delete(event.code);
  };

  readonly #blurred = (): void => {
    this.#input.keys.clear();
    this.#input.looking = false;
  };

  readonly #moved = (event: PointerEvent): void => {
    const box = this.#menu?.element?.getBoundingClientRect();
    if (!box || box.width <= 0 || box.height <= 0) return;
    this.#input.cursor = [
      (event.clientX - box.left) / box.width,
      (event.clientY - box.top) / box.height,
    ];
    if (this.#input.looking) {
      this.#input.look[0] += event.movementX;
      this.#input.look[1] += event.movementY;
    }
    if (this.#dragging && this.#local) {
      // CSS pixels to the canvas's.
      const [width] = this.#owner.session.renderer.size;
      const scale = width / Math.max(box.width, 1);
      this.#local.camera.drag(event.movementX * scale, event.movementY * scale);
    }
  };

  readonly #pressed = (event: PointerEvent): void => {
    // MapLookMode: the right mouse button held turns the camera; LocalMapMoveMode: the left
    // one drags the local map.
    if (event.button === 2) this.#input.looking = true;
    if (event.button === 0 && this.#local) this.#dragging = true;
  };

  readonly #released = (event: PointerEvent): void => {
    if (event.button === 2) this.#input.looking = false;
    if (event.button === 0) this.#dragging = false;
  };

  readonly #left = (): void => {
    this.#input.cursor = undefined;
    this.#input.looking = false;
    this.#dragging = false;
  };

  readonly #wheel = (event: WheelEvent): void => {
    if (this.#busy || event.deltaY === 0) return;
    const notches = event.deltaY < 0 ? 1 : -1;
    if (this.#local) this.#local.camera.zoom(notches);
    else this.#view.camera.zoom(notches);
  };

  readonly #noMenu = (event: Event): void => {
    event.preventDefault();
  };

  #aspect(): number {
    const box = this.#menu?.element?.getBoundingClientRect();
    return box && box.height > 0 ? box.width / box.height : 16 / 9;
  }

  #close(): void {
    if (this.#done) return;
    this.#done = true;
    const session = this.#owner.session;
    const element = this.#menu?.element;
    element?.removeEventListener('pointermove', this.#moved);
    element?.removeEventListener('pointerdown', this.#pressed);
    element?.removeEventListener('pointerup', this.#released);
    element?.removeEventListener('pointerleave', this.#left);
    element?.removeEventListener('wheel', this.#wheel);
    element?.removeEventListener('contextmenu', this.#noMenu);
    window.removeEventListener('keyup', this.#keyUp, { capture: true });
    window.removeEventListener('blur', this.#blurred);
    this.#view.camera.input = undefined;
    const renderer = session.renderer;
    if (this.#local) {
      this.#local = undefined;
      renderer.overlay = this.#previousOverlay;
    }
    renderer.setView(this.#previousView);
    this.#view.dispose();
    void session.sounds().then((sounds) => {
      sounds.setMenuSpace(undefined, session.ini.number('MapMenu', 'fMapLoopFadeTimeSeconds'));
    });
    if (this.#menu) this.#owner.host.close(this.#menu);
    this.#closed();
  }
}

/** The world whose map a world shows: its parent's when it uses the parent's map data. */
function mapWorldOf(record: WorldspaceRecord): number {
  return (record.parentUse & ParentUse.map) !== 0 && record.parent !== undefined
    ? record.parent
    : record.formId;
}
