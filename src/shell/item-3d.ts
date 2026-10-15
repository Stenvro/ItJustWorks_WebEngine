// The item menus' 3D: the item highlighted in the inventory, container, barter and gift menus,
// and the spell, power or shout in the magic menu, shown beside the list (the menus'
// UpdateItem3D(show) as the highlight changes; hidden while the list is). An item shows its world
// model (armor the player's sex's, a book its inventory art, BOOK INAM); a spell its costliest
// effect's menu display object (MGEF MDOB), a shout its own (SHOU MDOB). It stands at
// fInventory3DItemPos* (the magic menu's fMagic3DItemPos*; the *Wide values on a screen wider
// than 4:3) in the menus' space (src/shell/menu-3d.ts), scaled so its bound sphere is
// fInventory3DBoundRadiusScale times the place's scale, lit by fInventoryMenuLight* (and
// fInventoryMenuLight2* when it has a radius). Dragging it turns it
// (StartMouseRotation / StopMouseRotation; the menu hears ItemRotating), the wheel over it
// zooms it to fInventory3DItemZoom* at fInventory3DItemZoomScale (ZoomItemModel(±1)), easing at
// fInventory3DItemZoomSpeed. Notes: docs/ui.md ("The item menus' 3D").

import type { Mat4, Vec3 } from '../render/math.ts';
import type { OverlayView } from '../render/menu-overlay.ts';
import type { GpuModel, GpuScene, InstanceMotion } from '../render/scene-renderer.ts';
import type { Menu } from '../ui/menu-host.ts';
import { baseModelPath } from '../world/cell-records.ts';
import type { INI_DEFAULTS, IniSettings } from '../world/ini-settings.ts';
import { parseItem } from '../world/item-records.ts';
import { meshPath } from '../world/actors.ts';
import type { GameSession } from './game-session.ts';
import { MenuCamera, menuLighting, menuPlacement, type MenuLight } from './menu-3d.ts';
import { startObjectGraph } from './object-graphs.ts';
import { mainEffect } from './magic-menu.ts';
import { parseSpell } from '../world/spell-records.ts';
import { parseMagicEffect } from '../world/magic-effects.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';

/** Which menu's place: the item menus' or the magic menu's. */
export type Item3DSide = 'inventory' | 'magic';

/** Degrees the item turns per pixel the mouse moves (fInventory3DItemRotMouseSpeed / 100). */
const DEGREES_PER_PIXEL = 0.5;

type InterfaceKey = keyof (typeof INI_DEFAULTS)['Interface'];

interface Item3DSettings {
  readonly at: Vec3;
  readonly scale: number;
  readonly zoomAt: Vec3;
  readonly zoomScale: number;
  readonly zoomSpeed: number;
  readonly boundRadius: number;
  readonly rotateSpeed: number;
  readonly lights: readonly MenuLight[];
}

function item3DSettings(ini: IniSettings, side: Item3DSide, wide: boolean): Item3DSettings {
  const n = (key: InterfaceKey): number => ini.number('Interface', key);
  const prefix = side === 'magic' ? 'fMagic3DItemPos' : 'fInventory3DItemPos';
  const suffix = wide ? 'Wide' : '';
  const place = (axis: string): number => n(`${prefix}${axis}${suffix}` as InterfaceKey);
  const light = (name: 'fInventoryLight' | 'fInventoryLight2', at: Vec3): MenuLight => ({
    at,
    color: [
      n(`${name}DiffuseColorR` as InterfaceKey),
      n(`${name}DiffuseColorG` as InterfaceKey),
      n(`${name}DiffuseColorB` as InterfaceKey),
    ],
    dimmer: n(`${name}DimmerValue` as InterfaceKey),
    radius: n(`${name}Radius` as InterfaceKey),
  });
  return {
    at: [place('X'), place('Y'), place('Z')],
    scale: place('Scale'),
    zoomAt: [n('fInventory3DItemZoomX'), n('fInventory3DItemZoomY'), n('fInventory3DItemZoomZ')],
    zoomScale: n('fInventory3DItemZoomScale'),
    zoomSpeed: n('fInventory3DItemZoomSpeed'),
    boundRadius: n('fInventory3DBoundRadiusScale'),
    rotateSpeed: n('fInventory3DItemRotMouseSpeed') / 100 / DEGREES_PER_PIXEL,
    lights: [
      light('fInventoryLight', [
        n('fInventoryMenuLightX'),
        n('fInventoryMenuLightY'),
        n('fInventoryMenuLightZ'),
      ]),
      light('fInventoryLight2', [
        n('fInventoryMenuLight2X'),
        n('fInventoryMenuLight2Y'),
        n('fInventoryMenuLight2Z'),
      ]),
    ],
  };
}

/** One item shown: its model, its scene and how it is turned and zoomed now. */
interface Shown {
  readonly form: number;
  readonly model: GpuModel;
  readonly scene: GpuScene;
  readonly motion: InstanceMotion;
  readonly world: Mat4;
  /** Its bounding box's middle (what it turns about). */
  readonly middle: Vec3;
  /**
   * It lies flat in its model (its height the least of its sizes: weapons, armor's ground
   * models): it is stood up with its top towards the camera; else it stands as modelled.
   */
  readonly lying: boolean;
  turn: number;
  /** 0 at its place, 1 zoomed in. */
  zoom: number;
  zoomTarget: number;
}

export class Item3D {
  readonly #session: GameSession;
  readonly #side: Item3DSide;
  readonly #camera = new MenuCamera();
  #shown: Shown | undefined;
  #overlay: OverlayView | undefined;
  /** The overlay shown before this one (a book over the inventory gives it back). */
  #previous: OverlayView | undefined;
  #rotating = false;
  #request = 0;
  #menu: Menu | undefined;
  #lastTime: number | undefined;

  constructor(session: GameSession, side: Item3DSide) {
    this.#session = session;
    this.#side = side;
  }

  /** Shows a form's 3D (undefined: nothing), for a menu that hears ItemRotating. */
  async show(form: number | undefined, menu: Menu): Promise<void> {
    this.#menu = menu;
    const request = ++this.#request;
    if (form === undefined) {
      this.#clear();
      return;
    }
    if (this.#shown?.form === form) {
      this.#attach();
      return;
    }
    const path = await this.#modelPath(form);
    const model = path === undefined ? undefined : await this.#session.model(path);
    if (request !== this.#request) return;
    this.#clear();
    if (!model) return;
    const motion: InstanceMotion = { version: 0 };
    const world = new Float32Array(16);
    const graph = startObjectGraph(model, form);
    const scene = this.#session.renderer.scene.createScene([
      { model, world, motion, ...(graph && { graph }) },
    ]);
    const box = modelBox(model);
    const size = [0, 1, 2].map((k) => (box.max[k] ?? 0) - (box.min[k] ?? 0));
    this.#shown = {
      form,
      model,
      scene,
      motion,
      world,
      middle: [0, 1, 2].map((k) => ((box.min[k] ?? 0) + (box.max[k] ?? 0)) / 2) as unknown as Vec3,
      lying: (size[2] ?? 0) <= Math.min(size[0] ?? 0, size[1] ?? 0),
      turn: 0,
      zoom: 0,
      zoomTarget: 0,
    };
    this.#place();
    this.#attach();
  }

  /** Hides the 3D (the list hidden, the menu closed). */
  hide(): void {
    this.#request++;
    this.#clear();
  }

  /** The menu's StartMouseRotation: the mouse turns the item until StopMouseRotation. */
  startRotation(): void {
    if (this.#rotating) return;
    this.#rotating = true;
    window.addEventListener('pointermove', this.#moved);
  }

  stopRotation(): void {
    this.#rotating = false;
    window.removeEventListener('pointermove', this.#moved);
  }

  /** The menu's ZoomItemModel: in (positive) or back out (negative). */
  zoom(delta: number): void {
    const shown = this.#shown;
    if (!shown || delta === 0) return;
    shown.zoomTarget = delta > 0 ? 1 : 0;
  }

  readonly #moved = (event: PointerEvent): void => {
    const shown = this.#shown;
    if (!shown || event.movementX === 0) return;
    const settings = this.#settings();
    shown.turn += event.movementX * DEGREES_PER_PIXEL * settings.rotateSpeed;
    this.#place();
    this.#menu?.call('ItemRotating');
  };

  /** The model a form shows in the menus. */
  async #modelPath(form: number): Promise<string | undefined> {
    const runtime = this.#session.scriptsReady;
    const db = await this.#session.db;
    const record = await db.get(form);
    if (!record || !runtime) return undefined;
    const statModel = async (stat: number | undefined): Promise<string | undefined> => {
      const found = stat === undefined || stat === 0 ? undefined : await db.get(stat);
      return found && baseModelPath(found);
    };
    switch (record.type) {
      case 'SPEL':
      case 'SCRL': {
        if (record.type === 'SCRL') {
          const own = baseModelPath(record);
          if (own) return own;
        }
        // The costliest effect's menu display object.
        const main = await mainEffect(parseSpell(record), async (effect) => {
          const mgef = await db.get(effect);
          return mgef?.type === 'MGEF' ? parseMagicEffect(mgef) : undefined;
        });
        const mgef = main && (await db.get(main.formId));
        return statModel(mgef?.formIdField('MDOB'));
      }
      case 'SHOU':
        return statModel(record.formIdField('MDOB'));
      case 'BOOK': {
        const art = await statModel(record.formIdField('INAM'));
        return art ?? baseModelPath(record);
      }
      case 'ARMO': {
        const item = parseItem(record);
        const female = await runtime.actors.isFemale(PLAYER_REF);
        const model = (female ? item?.femaleModel : undefined) ?? item?.model;
        return model === undefined ? undefined : meshPath(model);
      }
      default:
        return baseModelPath(record);
    }
  }

  #settings(): Item3DSettings {
    const wide = window.innerWidth / Math.max(1, window.innerHeight) > 4 / 3 + 0.01;
    return item3DSettings(this.#session.ini, this.#side, wide);
  }

  /** Puts the item where it stands now: its place, or on its way to the zoomed one. */
  #place(): void {
    const shown = this.#shown;
    if (!shown) return;
    const settings = this.#settings();
    const t = shown.zoom * shown.zoom * (3 - 2 * shown.zoom);
    const at: Vec3 = [0, 1, 2].map(
      (k) => (settings.at[k] ?? 0) * (1 - t) + (settings.zoomAt[k] ?? 0) * t,
    ) as unknown as Vec3;
    const scale = settings.scale * (1 - t) + settings.zoomScale * t;
    const radius = Math.max(shown.model.radius, 0.001);
    shown.world.set(
      menuPlacement({
        pivot: shown.middle,
        at,
        faceCamera: shown.lying,
        turnDegrees: shown.turn,
        scale: (settings.boundRadius * scale) / radius,
      }),
    );
    shown.motion.version++;
  }

  #attach(): void {
    const shown = this.#shown;
    if (!shown) return;
    const renderer = this.#session.renderer;
    const settings = this.#settings();
    const lighting = menuLighting(settings.lights);
    if (!this.#overlay) {
      this.#overlay = {
        scenes: () => (this.#shown ? [this.#shown.scene] : []),
        camera: this.#camera,
        lighting: () => lighting,
        update: (seconds) => {
          this.#animate(seconds);
        },
      };
    }
    if (renderer.overlay !== this.#overlay) {
      this.#previous = renderer.overlay;
      renderer.overlay = this.#overlay;
    }
  }

  #animate(seconds: number): void {
    // Its menu closed without hiding it (Play ended, another menu took its place).
    if (this.#menu?.closed) {
      this.hide();
      return;
    }
    const shown = this.#shown;
    const dt = this.#lastTime === undefined ? 0 : Math.min(0.1, seconds - this.#lastTime);
    this.#lastTime = seconds;
    if (!shown || shown.zoom === shown.zoomTarget) return;
    const settings = this.#settings();
    const step = dt * Math.max(0.01, settings.zoomSpeed) * 2;
    shown.zoom =
      shown.zoomTarget > shown.zoom
        ? Math.min(shown.zoomTarget, shown.zoom + step)
        : Math.max(shown.zoomTarget, shown.zoom - step);
    this.#place();
  }

  #clear(): void {
    this.stopRotation();
    const shown = this.#shown;
    this.#shown = undefined;
    shown?.scene.destroy();
    const renderer = this.#session.renderer;
    if (this.#overlay && renderer.overlay === this.#overlay) renderer.overlay = this.#previous;
    this.#overlay = undefined;
    this.#previous = undefined;
  }
}

/** A model's bounding box in its own space (its parts' vertices where they are drawn). */
function modelBox(model: GpuModel): { min: Vec3; max: Vec3 } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const { part } of model.parts) {
    const view = new DataView(
      part.vertices.buffer,
      part.vertices.byteOffset,
      part.vertices.byteLength,
    );
    const w = part.world;
    for (let v = 0; v < part.vertexCount; v++) {
      const at = v * part.layout.stride;
      const x = view.getFloat32(at, true);
      const y = view.getFloat32(at + 4, true);
      const z = view.getFloat32(at + 8, true);
      for (let k = 0; k < 3; k++) {
        const c = (w[k] ?? 0) * x + (w[4 + k] ?? 0) * y + (w[8 + k] ?? 0) * z + (w[12 + k] ?? 0);
        if (c < (min[k] ?? 0)) min[k] = c;
        if (c > (max[k] ?? 0)) max[k] = c;
      }
    }
  }
  if (!Number.isFinite(min[0])) return { min: [...model.center], max: [...model.center] };
  return { min, max };
}
