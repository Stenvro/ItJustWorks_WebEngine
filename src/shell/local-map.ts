// The map's local map (L, or the bottom bar's button): the player's surroundings from straight
// above, in the movie's local map frame (map.swf: WorldMap.LocalMapMenu, a Map.LocalMap in
// LocalMapFader). The movie fades it in (Show(true)), loads the engine's picture into its holder
// (InitMap: img://Local_Map, 800 × 450) and tells the engine where the picture is on the stage
// (SetLocalMapExtents: its corners); its title is the location's name and whether it is cleared
// (SetTitle(name, "Cleared")). In the game the picture is a render target Scaleform draws; here
// the engine draws it under the movie in that place (src/render/menu-overlay.ts: the drawn
// image as ISLocalMap makes it, on the frame's black field) and the movie gets an empty
// picture. What is drawn: the landscape and objects loaded around the player (inside: the
// cell), seen by the local map's camera (src/world/local-map-camera.ts), lit from above. The
// local map's icons are the movie's too (LocalMapMenu.IconDisplay, a Map.MapMenu of its own,
// over the picture's 800 × 450): the load doors (DoorMarker, their destination's name), the map
// markers, the quests' targets, the player's own marker and the player. Notes: docs/ui.md
// ("The local map").

import type { Vec3 } from '../render/math.ts';
import type { LocalMapFog, LocalMapFrame, OverlayView } from '../render/menu-overlay.ts';
import { seenRaster, type SeenBlocks, type SeenRaster } from '../world/seen-data.ts';
import type { GpuScene, SceneLighting } from '../render/scene-renderer.ts';
import type { GpuTerrainCell } from '../render/terrain.ts';
import { flatAmbient } from '../render/scene-renderer.ts';
import type { Menu } from '../ui/menu-host.ts';
import { LocalMapCamera, type LocalMapArea } from '../world/local-map-camera.ts';
import type { Teleport } from '../world/cell-records.ts';

/** What the local map shows: the loaded surroundings (from the viewer on screen). */
export interface LocalMapContent {
  readonly scenes: () => Iterable<GpuScene>;
  readonly terrain: () => Iterable<GpuTerrainCell>;
  /** The area loaded (world units). */
  readonly area: LocalMapArea;
  readonly interior: boolean;
  /** The interior cell (its fog of war). */
  readonly cell?: number;
  /**
   * Inside, where up is on the local map: the cell's NorthMarker's heading (radians, clockwise
   * from +Y); outside north is up.
   */
  readonly north?: number;
  /** The load doors there (enabled): where they stand and where they lead. */
  readonly doors: () => readonly {
    readonly reference: number;
    readonly teleport: Teleport;
    readonly position: Vec3;
  }[];
}

/** A marker on the local map (its place in the world). */
export interface LocalMapMarker {
  readonly name: string;
  readonly icon: number;
  readonly undiscovered: boolean;
  readonly position: Vec3;
  /** Its heading in degrees, clockwise from north (the player's arrow turns with it). */
  readonly heading?: number;
  /** Description lines (several quests at one place). */
  readonly lines: readonly string[];
}

/** LocalMapMenu: the local map's clip in the movie. */
export const LOCAL_MAP = '_root.WorldMap.LocalMapMenu';
const ICONS = `${LOCAL_MAP}.IconDisplay`;
/** The movie's picture size (Map.LocalMap's TextureWidth × TextureHeight). */
const PICTURE_WIDTH = 800;
/**
 * The frame's black field about the picture, in stage pixels (map.swf: LocalMap's frame clip
 * at −23.65, −23.25 scaled 0.88 × 0.9; its black fill from 4.25, 3.75 to 961.5, 548.7).
 */
const FIELD_MARGIN = { left: 19.9, top: 19.9, right: 22.5, bottom: 20.6 } as const;

/** Nothing of the local map shows. */
const HIDDEN: LocalMapFrame = { picture: [0, 0, 0, 0], field: [0, 0, 0, 0], step: 1, alpha: 0 };

/** The light the local map is drawn in: from above, white, and an even ambient. */
const LIGHT: SceneLighting = {
  sunDirection: [-0.3, 0.3, 0.9],
  sunColor: [0.8, 0.8, 0.8],
  ambient: flatAmbient([0.45, 0.45, 0.45]),
  fog: undefined,
  lights: [],
};

export interface LocalMapSettings {
  readonly height: number;
  readonly minWidth: number;
  readonly zoomSpeed: number;
  readonly cursorPanSpeed: number;
  readonly mousePanSpeed: number;
  readonly cursorMoveArea: number;
  readonly selectionDistance: number;
}

/** The local map while it is shown. */
export class LocalMap {
  readonly camera: LocalMapCamera;
  readonly #menu: Menu;
  readonly #content: LocalMapContent;
  readonly #settings: LocalMapSettings;
  /** The picture on the stage (SetLocalMapExtents), once the movie has said. */
  #extents: readonly [number, number, number, number] | undefined;
  #markers: readonly LocalMapMarker[] = [];
  #created = false;
  #selected = -1;
  #closing = false;
  /** Inside: what the player has seen (the rest is under the fog). */
  readonly #seen: SeenRaster | undefined;

  constructor(
    menu: Menu,
    content: LocalMapContent,
    settings: LocalMapSettings,
    at: Vec3,
    seen: SeenBlocks | undefined,
    /** The fog of war (the console's tfow turns it off: everything is seen). */
    fogOfWar = true,
  ) {
    this.#menu = menu;
    this.#content = content;
    this.#settings = settings;
    this.camera = new LocalMapCamera(
      content.area,
      settings,
      at,
      content.interior,
      content.north ?? 0,
    );
    this.#seen = content.interior && fogOfWar
      ? seenRaster(seen ?? new Map<string, Uint8Array>(), content.area.min, content.area.max)
      : undefined;
  }

  /** Shows it: the movie fades it in and asks for its picture; its title and markers. */
  show(title: string, cleared: string | undefined, markers: readonly LocalMapMarker[]): void {
    const menu = this.#menu;
    menu.invoke(`${LOCAL_MAP}.SetTitle`, title, cleared);
    menu.invoke(`${LOCAL_MAP}.Show`, true);
    menu.invoke(`${LOCAL_MAP}.InitMap`);
    this.setMarkers(markers);
  }

  /** It fades out (Show(false)); the overlay stays until it has. */
  hide(): void {
    this.#closing = true;
    this.#menu.invoke(`${LOCAL_MAP}.Show`, false);
  }

  /** Whether it has faded out after hide(). */
  get gone(): boolean {
    return this.#closing && this.#fade() <= 0;
  }

  /** SetLocalMapExtents: the picture's corners on the stage (x0, y0, x1, y1). */
  extents(args: readonly unknown[]): void {
    const values = args.slice(-4).map(Number);
    if (values.length === 4 && values.every(Number.isFinite)) {
      this.#extents = [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 0];
    }
  }

  setMarkers(markers: readonly LocalMapMarker[]): void {
    const menu = this.#menu;
    this.#markers = markers;
    const data: unknown[] = [];
    for (const marker of markers) data.push(marker.name, marker.icon, marker.undiscovered);
    menu.set(`${ICONS}.MarkerData`, data);
    menu.invoke(`${ICONS}.SetNumMarkers`, markers.length);
    for (let guard = 0; guard < 1000; guard++) {
      if (menu.invoke(`${ICONS}.GetCreatingMarkers`) !== true) break;
      menu.invoke(`${ICONS}.CreateMarkers`);
    }
    this.#created = true;
    this.#selected = -1;
  }

  /** What the renderer draws as the local map (Renderer.overlay). */
  overlay(canvas: () => readonly [number, number]): OverlayView {
    return {
      scenes: () => this.#content.scenes(),
      terrain: () => this.#content.terrain(),
      camera: this.camera,
      lighting: () => LIGHT,
      update: () => {
        this.camera.canvas = canvas();
        const frame = this.#frame();
        if (frame) this.camera.picture = frame.picture;
      },
      // Until the movie has said where the picture is, nothing shows.
      localMap: () => this.#frame() ?? HIDDEN,
    };
  }

  /**
   * Every frame: the icons' places over the picture, and the one the cursor (0..1 of the
   * screen) is on.
   */
  refresh(cursor: readonly [number, number] | undefined): void {
    const menu = this.#menu;
    if (!this.#created) return;
    const data: unknown[] = [];
    let nearest = -1;
    let nearestDistance = this.#settings.selectionDistance;
    const inPicture = cursor && this.#cursorInPicture(cursor);
    this.#markers.forEach((marker, index) => {
      const [u, v] = this.camera.inPicture(marker.position);
      const shown = u >= 0 && u <= 1 && v >= 0 && v <= 1;
      const yaw = (this.camera.yaw * 180) / Math.PI;
      data.push(shown, u, v, marker.heading === undefined ? 0 : marker.heading - yaw);
      if (!shown || !inPicture || marker.name === '') return;
      const distance = Math.hypot(u - inPicture[0], v - inPicture[1]);
      if (distance <= nearestDistance) {
        nearestDistance = distance;
        nearest = index;
      }
    });
    menu.set(`${ICONS}.MarkerData`, data);
    menu.invoke(`${ICONS}.RefreshMarkers`);
    if (nearest !== this.#selected) {
      this.#selected = nearest;
      const marker = this.#markers[nearest];
      if (marker) {
        menu.invoke(
          `${ICONS}.MarkerDescriptionObj.SetDescription`,
          marker.name,
          marker.lines.map((line) => ({ Item: '', Value: line })),
        );
      }
      menu.invoke(`${ICONS}.SetSelectedMarker`, nearest);
    }
  }

  /**
   * Whether a point of the screen (0..1) is under the local map's frame: the world map's icons
   * there are hidden (in the game its black field covers them).
   */
  covers(at: readonly [number, number]): boolean {
    const frame = this.#frame();
    if (!frame || frame.alpha <= 0) return false;
    const [width, height] = this.camera.canvas;
    const x = at[0] * width;
    const y = at[1] * height;
    const [x0, y0, x1, y1] = frame.field;
    return x >= x0 && x <= x1 && y >= y0 && y <= y1;
  }

  /** The cursor at the picture's sides moves the map (as the world map's does at the screen's). */
  edgePan(cursor: readonly [number, number] | undefined, deltaSeconds: number): void {
    const at = cursor && this.#cursorInPicture(cursor);
    if (!at) return;
    const edge = (value: number): number => {
      const off = (value - 0.5) * 2;
      const inner = this.#settings.cursorMoveArea;
      if (Math.abs(off) <= inner || Math.abs(off) > 1) return 0;
      return Math.sign(off) * ((Math.abs(off) - inner) / Math.max(1 - inner, 1e-3));
    };
    const east = edge(at[0]);
    const north = -edge(at[1]);
    if (east !== 0 || north !== 0) this.camera.pan(east, north, deltaSeconds);
  }

  /** The cursor (0..1 of the screen) in the picture (0..1), if the picture is known. */
  #cursorInPicture(cursor: readonly [number, number]): [number, number] | undefined {
    const frame = this.#frame();
    if (!frame) return undefined;
    const [width, height] = this.camera.canvas;
    const [x0, y0, x1, y1] = frame.picture;
    return [
      (cursor[0] * width - x0) / Math.max(x1 - x0, 1),
      (cursor[1] * height - y0) / Math.max(y1 - y0, 1),
    ];
  }

  /** The frame's fade (the LocalMapFader's timeline, as the clip's alpha). */
  #fade(): number {
    const alpha = this.#menu.get(`${LOCAL_MAP}._alpha`);
    return typeof alpha === 'number' ? Math.min(1, Math.max(0, alpha / 100)) : 0;
  }

  /** The seen raster, and canvas pixels to its 0..1 (through the camera's world). */
  #fog(seen: SeenRaster, picture: readonly [number, number, number, number]): LocalMapFog {
    const camera = this.camera;
    const width = Math.max(picture[2] - picture[0], 1);
    const height = Math.max(picture[3] - picture[1], 1);
    const toFog = (px: number, py: number): [number, number] => {
      const [wx, wy] = camera.atPicture((px - picture[0]) / width, (py - picture[1]) / height);
      return [
        (wx - seen.origin[0]) / (seen.width * seen.square),
        (wy - seen.origin[1]) / (seen.height * seen.square),
      ];
    };
    // Affine: from the image of three points.
    const [u0, v0] = toFog(0, 0);
    const [u1, v1] = toFog(1, 0);
    const [u2, v2] = toFog(0, 1);
    return {
      data: seen.data,
      width: seen.width,
      height: seen.height,
      transform: [u1 - u0, u2 - u0, u0, v1 - v0, v2 - v0, v0],
    };
  }

  /** The picture and its field on the canvas (pixels), from the stage's extents. */
  #frame(): LocalMapFrame | undefined {
    const extents = this.#extents;
    const box = this.#menu.element?.getBoundingClientRect();
    const visible = this.#menu.get('Stage.visibleRect') as
      { x?: number; y?: number; width?: number; height?: number } | undefined;
    if (!extents || !box || !visible?.width || !visible.height) return undefined;
    const [canvasWidth, canvasHeight] = this.camera.canvas;
    // Stage → canvas pixels: the visible rect spans the menu's element, which spans the canvas.
    const sx = canvasWidth / visible.width;
    const sy = canvasHeight / visible.height;
    const x = (stageX: number): number => (stageX - (visible.x ?? 0)) * sx;
    const y = (stageY: number): number => (stageY - (visible.y ?? 0)) * sy;
    const picture = [x(extents[0]), y(extents[1]), x(extents[2]), y(extents[3])] as const;
    const seen = this.#seen;
    return {
      ...(seen && { fog: this.#fog(seen, picture) }),
      picture,
      field: [
        x(extents[0] - FIELD_MARGIN.left),
        y(extents[1] - FIELD_MARGIN.top),
        x(extents[2] + FIELD_MARGIN.right),
        y(extents[3] + FIELD_MARGIN.bottom),
      ],
      step: Math.max(1, Math.round((picture[2] - picture[0]) / PICTURE_WIDTH)),
      alpha: this.#fade(),
    };
  }
}
