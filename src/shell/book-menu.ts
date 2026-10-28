// Reading a book or a note (the book menu): the book's high-poly model (BOOK INAM: a static of
// meshes\clutter\books\...\character assets) is drawn over the world in the menus' 3D
// (Renderer.overlay), its own behavior graph opening it (Book01Project: Open, PageForward,
// PageBack, Close; a note's Note01: Open, Close), the graph's SoundPlay events sounding. The
// pages are interface\book.swf, played off the page: SetBookText(text, isNote) lays the text
// out in pages (its [pagebreak] tags too), TurnPage(delta) turns them, ShowPageAtOffset(n)
// shows one page of the set it keeps; each page shown is copied from the player's canvas into
// a texture on a page of the 3D book, left and right (a note: one). The texts are hidden while
// a page turns. interface\bookmenu.swf is the bar under it: Take (or Steal, for an owned book;
// none when the book cannot be taken or is read from the inventory) and Exit. The control map's
// Book context turns the pages (PrevPage: A, Left, the left mouse button, the wheel down;
// NextPage: D, Right, the right mouse button, the wheel up); Accept (E) takes the book, Cancel
// (Tab, Esc) closes it. Reading a skill book the first time raises its skill (UESP, "Skill
// Books"; the HUD's sSkillIncreased); the book's scripts hear OnRead. The text goes to the
// movie as src/ui/book-text.ts readies it for the Flash player (its images: TODO(M13)).
//
// Where the texts lie on the open book was measured from the models: the open pose of
// Book01Project (BookOpen's last frame) puts the right page flat at z 1.21 from the spine
// (x −9.7) to x 8.2, the left page (Base Page1 on the turned cover) sloping 12.5° down from
// the spine to x −25 (after a page is turned, its top lies 0.06 higher); y −12.4 .. 12.0
// (book02's: −11.1 .. 10.8). An open note lies flat at z ≈ 0.25, x −8 .. 8, y −11 .. 11. The
// texts are the PageText shape's size and aspect (15 × 20; here 13.5 × 18 on a book so the
// left page holds one), the page drawn at that aspect around book.swf's 300 × 475 stage (a
// note's text is wider: NOTE_WIDTH 400 from the visible rect's left plus NOTE_X_OFFSET 20).
// Notes: docs/ui.md ("Books").

import { EntryPoint } from '../gameplay/perk-entry-points.ts';
import { animateSkeletons, type AnimatedSkeleton } from '../animation/animated-skeleton.ts';
import { multiply, type Mat4, type Vec3 } from '../render/math.ts';
import type { OverlayView } from '../render/menu-overlay.ts';
import { pageQuad } from '../render/page-quad.ts';
import {
  type GpuModel,
  type GpuScene,
  type InstanceVisibility,
  type ModelInstance,
} from '../render/scene-renderer.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { Menu, MenuHost } from '../ui/menu-host.ts';
import { referenceMatrix } from '../world/cell-loader.ts';
import { baseModelPath } from '../world/cell-records.ts';
import { BookFlag, parseItem } from '../world/item-records.ts';
import type { GameSession } from './game-session.ts';
import { startObjectGraph, startPlacedSkeleton } from './object-graphs.ts';
import { MenuCamera, menuLighting, menuPlacement, type MenuLight } from './menu-3d.ts';
import type { Terminal } from './terminal.ts';
import { ActorValue } from '../world/actor-values.ts';
import { bookText } from '../ui/book-text.ts';
import type { IniSettings, INI_DEFAULTS } from '../world/ini-settings.ts';

/** What is read: the book (BOOK), and where it lies when read in the world. */
export interface BookToRead {
  readonly book: number;
  /** The reference read in the world (it can be taken); none: read from the inventory. */
  readonly reference?: number;
  /** Takes the book read in the world (the activation's Take). */
  readonly take?: () => void;
}

/** BOOK DATA's type: a note or a scroll (one page at a time, no pages to turn). */
const NOTE_TYPE = 255;
/** book.swf's stage. */
const STAGE_WIDTH = 300;
const STAGE_HEIGHT = 475;
/** BookMenu.NOTE_WIDTH and NOTE_X_OFFSET: a note's text and its margin. */
const NOTE_WIDTH = 400;
const NOTE_X_OFFSET = 20;
/** The page drawn at this many pixels per stage pixel. */
const PAGE_SCALE = 2;
/** The pages' aspect: the PageText shape's (15 × 20). */
const PAGE_ASPECT = 15 / 20;

/** A book's texts on the open book (see above). */
const BOOK_PAGE = { width: 13.5, height: 18 };
const NOTE_PAGE = { width: 15, height: 20 };
const RIGHT_PAGE: Vec3 = [-0.75, -0.2, 1.25];
/**
 * The left page's plane: through this point at the spine side, sloping down outward; 0.2 above
 * the measured top (the paper bends between its bones, and the text must stay over it).
 */
const LEFT_SPINE: Vec3 = [-11, -0.2, 2.67];
const LEFT_SLOPE = (12.5 * Math.PI) / 180;
/** From the spine along the slope to the text's middle. */
const LEFT_OFFSET = 7.35;
const NOTE_TEXT: Vec3 = [0.27, -0.77, 0.35];
/** The middles of the open book and note (what the menu centres). */
const BOOK_MIDDLE: Vec3 = [-8.4, -0.2, 1];
const NOTE_MIDDLE: Vec3 = [0, -0.2, 0.3];

/** The models when a book names no inventory art (two vanilla books). */
const DEFAULT_BOOK = 'meshes\\clutter\\books\\book01\\character assets\\journalbasic.nif';
const DEFAULT_NOTE = 'meshes\\clutter\\books\\note01\\note01.nif';

/** The graph's events: when the texts may show, and when it has closed. */
const SHOWN_AFTER = new Set(['openstop', 'pageforwardstop', 'pagebackstop']);
const CLOSED_AFTER = new Set(['closeout', 'closestop']);
/** The close waits for the graph at most this long (ms). */
const CLOSE_TIMEOUT_MS = 2500;
/** The menus' depth among the game's menus. */
const BOOK_DEPTH = 7;

/** The 18 skills. */
const SKILLS = 18;

const SOUND_PLAY = 'soundplay.';
/** book.swf's BookMenu instance. */
const BOOK_ROOT = '_global.BookMenu.BookMenuInstance';

/** The book menu's [Interface] settings (src/shell/menu-3d.ts: the menus' space). */
interface BookSettings {
  readonly distance: number;
  readonly xRotation: number;
  readonly widthPercentage: number;
  readonly heightPercentage: number;
  readonly lights: readonly MenuLight[];
}

function bookSettings(ini: IniSettings): BookSettings {
  const n = (key: keyof (typeof INI_DEFAULTS)['Interface']): number => ini.number('Interface', key);
  return {
    distance: n('fBookDistance'),
    xRotation: n('fBookXRotation'),
    widthPercentage: n('fBookPosWidthPercentage'),
    heightPercentage: n('fBookPosHeightPercentage'),
    lights: [
      {
        at: [n('fBookLightX'), n('fBookLightY'), n('fBookLightZ')],
        color: [
          n('fBookLightDiffuseColorR'),
          n('fBookLightDiffuseColorG'),
          n('fBookLightDiffuseColorB'),
        ],
        dimmer: n('fBookLightDimmerValue'),
        radius: n('fBookLightRadius'),
      },
      {
        at: [n('fBookLight2X'), n('fBookLight2Y'), n('fBookLight2Z')],
        color: [
          n('fBookLight2DiffuseColorR'),
          n('fBookLight2DiffuseColorG'),
          n('fBookLight2DiffuseColorB'),
        ],
        dimmer: n('fBookLight2DimmerValue'),
        radius: n('fBookLight2Radius'),
      },
    ],
  };
}

/** A page's text texture: what book.swf draws, copied into it whenever the page changes. */
interface PageTexture {
  readonly path: string;
  readonly texture: GPUTexture;
  readonly model: GpuModel;
  readonly visibility: InstanceVisibility;
  readonly world: Mat4;
}

export class BookMenu {
  readonly #host: MenuHost;
  readonly #session: GameSession;
  readonly #terminal: Terminal;
  #next = 1;

  constructor(host: MenuHost, session: GameSession, terminal: Terminal) {
    this.#host = host;
    this.#session = session;
    this.#terminal = terminal;
  }

  /**
   * Opens a book; `closed` once it has closed (after its closing animation). Undefined if it
   * cannot be shown (its record or model is missing).
   */
  async open(read: BookToRead, closed: () => void): Promise<{ close(): void } | undefined> {
    const session = this.#session;
    const runtime = session.scriptsReady;
    const db = await session.db;
    const record = await db.get(read.book);
    const item = record && parseItem(record);
    if (!runtime || !record || !item?.book) return undefined;
    const note = item.book.bookType === NOTE_TYPE;
    const art = record.formIdField('INAM');
    const stat = art === undefined ? undefined : await db.get(art);
    const artPath = stat && baseModelPath(stat);
    const path = artPath ?? (note ? DEFAULT_NOTE : DEFAULT_BOOK);
    const model = await session.model(path);
    if (!model) {
      this.#terminal.log('ui', `${item.name}: its book model ${path} does not load`, 'warn');
      return undefined;
    }
    const text = record.text('DESC') ?? '';
    // A book without a text does not open (Creation Kit wiki, "Book").
    if (text === '') return undefined;
    const reading = new Reading(this.#host, session, this.#terminal, {
      id: this.#next++,
      read,
      note,
      text,
      model,
      runtime,
      canTake: read.reference !== undefined && (item.book.flags & BookFlag.cantBeTaken) === 0,
      closed,
    });
    await reading.start();
    await this.#firstRead(runtime, read, item.book);
    return reading;
  }

  /** A skill book raises its skill the first time it is read; the book's scripts hear OnRead. */
  async #firstRead(
    runtime: ScriptRuntime,
    read: BookToRead,
    book: { readonly flags: number; readonly teaches: number },
  ): Promise<void> {
    const first = !runtime.state.booksRead.has(read.book);
    runtime.state.booksRead.add(read.book);
    // The hub tells it (TESBookReadEvent: the reference's OnRead).
    await runtime.events.emitted('bookRead', {
      book: read.book,
      reader: PLAYER_REF,
      reference: read.reference,
    });
    if (!first || (book.flags & BookFlag.teachesSkill) === 0 || book.teaches < 0) return;
    // The experience the skill lacks to its next level (UESP "Skill Books"); the HUD announces
    // it (sSkillIncreased); the reader's perks may add levels (Adjust Book Skill Points:
    // Scholar's Insight's second).
    const skill = book.teaches;
    if (skill < ActorValue.firstSkill || skill >= ActorValue.firstSkill + SKILLS) return;
    const levels = await runtime.perks.apply(EntryPoint.adjustBookSkillPoints, PLAYER_REF, 1);
    await runtime.progression.incrementSkill(skill, Math.max(0, Math.round(levels)));
  }
}

interface ReadingSetup {
  readonly id: number;
  readonly read: BookToRead;
  readonly note: boolean;
  readonly text: string;
  readonly model: GpuModel;
  readonly runtime: ScriptRuntime;
  readonly canTake: boolean;
  readonly closed: () => void;
}

/** One book open: its 3D, its pages, its bar. */
class Reading {
  readonly #host: MenuHost;
  readonly #session: GameSession;
  readonly #terminal: Terminal;
  readonly #setup: ReadingSetup;
  readonly #skeletons: AnimatedSkeleton[] = [];
  #pages: Menu | undefined;
  #bar: Menu | undefined;
  #book: GpuScene | undefined;
  #texts: GpuScene | undefined;
  #textures: PageTexture[] = [];
  #overlay: OverlayView | undefined;
  #previous: OverlayView | undefined;
  #behavior: { sendEvent(name: string): void } | undefined;
  /** The graph was told to open the book. */
  #opened = false;
  /** The texts show (the book lies open, no page turning). */
  #open = false;
  #closing = false;
  #finished = false;
  /** Pages drawn in order: a newer request wins. */
  #drawing = 0;

  constructor(host: MenuHost, session: GameSession, terminal: Terminal, setup: ReadingSetup) {
    this.#host = host;
    this.#session = session;
    this.#terminal = terminal;
    this.#setup = setup;
  }

  async start(): Promise<void> {
    const { note } = this.#setup;
    const renderer = this.#session.renderer;
    // The pages' movie, off the page, at the texts' aspect around its stage.
    const stageWidth = note
      ? Math.max(NOTE_WIDTH + 2 * NOTE_X_OFFSET, STAGE_HEIGHT * PAGE_ASPECT)
      : Math.max(STAGE_WIDTH, STAGE_HEIGHT * PAGE_ASPECT);
    const stageHeight = stageWidth / PAGE_ASPECT;
    this.#pages = await this.#host.open('book.swf', {
      depth: 0,
      interactive: false,
      offscreen: {
        width: Math.round(stageWidth * PAGE_SCALE),
        height: Math.round(stageHeight * PAGE_SCALE),
      },
      setup: async (menu) => {
        await menu.waitFor('_global.BookMenu.BookMenuInstance.SetBookText');
        menu.call('SetBookText', bookText(this.#setup.text), note);
      },
    });
    const canvas = this.#pages.canvas;
    const width = canvas?.width ?? Math.round(stageWidth * PAGE_SCALE);
    const height = canvas?.height ?? Math.round(stageHeight * PAGE_SCALE);

    // The book fBookDistance in front of the camera, its pages towards it, tilted by
    // fBookXRotation (negative: its top away), its middle where the settings put it on the
    // screen; its texts on it.
    const settings = bookSettings(this.#session.ini);
    const placed = menuPlacement({
      pivot: note ? NOTE_MIDDLE : BOOK_MIDDLE,
      at: [0, -settings.distance, 0],
      faceCamera: true,
      tiltDegrees: -settings.xRotation,
    });
    const book = this.#placeBook(placed);
    const page = note ? NOTE_PAGE : BOOK_PAGE;
    const worlds = (note ? [noteTextWorld()] : [leftTextWorld(), rightTextWorld()]).map((local) =>
      multiply(placed, local),
    );
    const scene = renderer.scene;
    for (const [i, world] of worlds.entries()) {
      const path = `menu:book-${String(this.#setup.id)}-${String(i)}`;
      const texture = scene.createCanvasTexture(width, height, path);
      this.#session.textures.provide(path, texture);
      const model = await scene.createModel(
        pageQuad(page.width, page.height, path),
        this.#session.textures,
      );
      this.#textures.push({ path, texture, model, visibility: { hidden: true }, world });
    }
    this.#book = scene.createScene(book);
    this.#texts = scene.createScene(
      this.#textures.map(({ model, world, visibility }) => ({ model, world, visibility })),
    );
    const camera = new MenuCamera();
    camera.screenX = settings.widthPercentage;
    camera.screenY = settings.heightPercentage;
    const lighting = menuLighting(settings.lights);
    const skeletons = this.#skeletons;
    const shownScenes = [this.#book, this.#texts];
    this.#overlay = {
      scenes: () => shownScenes,
      camera,
      lighting: () => lighting,
      update: (seconds) => {
        animateSkeletons(skeletons, seconds);
        // The graph takes events once it has run.
        if (!this.#opened) {
          this.#opened = true;
          this.#behavior?.sendEvent('Open');
        }
      },
    };
    this.#previous = renderer.overlay;
    renderer.overlay = this.#overlay;

    // The bar under it.
    this.#bar = await this.#host.open('bookmenu.swf', {
      depth: BOOK_DEPTH,
      interactive: true,
      onKey: (_menu, event) => this.#key(event),
      setup: async (menu) => {
        if (!(await menu.waitFor('_root.InitExtensions'))) return;
        menu.invoke('_root.InitExtensions');
        menu.tellPlatform('_root.SetPlatform');
        await this.#showTake(menu);
      },
    });
    this.#bar.element?.addEventListener('pointerdown', this.#pointer);
    this.#bar.element?.addEventListener('wheel', this.#wheel, { passive: true });
    this.#bar.element?.addEventListener('contextmenu', this.#noMenu);

    void this.#drawPages();
  }

  /** Take or Steal (an owned book), when the book lies in the world and can be taken. */
  async #showTake(menu: Menu): Promise<void> {
    const { read, canTake, runtime } = this.#setup;
    let steal = false;
    if (canTake && read.reference !== undefined) {
      // Its owner's, else its cell's (taking it is then a theft: the take goes through the
      // crime engine's steal).
      steal = !(await runtime.crime.mayTake(PLAYER_REF, read.reference));
    }
    menu.call('ShowTakeButton', canTake, steal);
  }

  #placeBook(world: Mat4): ModelInstance[] {
    const { model, read } = this.#setup;
    const seed = read.reference ?? read.book;
    const graph = startObjectGraph(model, seed);
    const skeletal = startPlacedSkeleton(model, seed);
    if (skeletal) {
      const skeleton = skeletal.skeleton;
      skeleton.onEvents = (events) => {
        this.#events(events.map((event) => event.text));
      };
      this.#skeletons.push(skeleton);
      const behavior = skeleton.behavior;
      if (behavior) this.#behavior = behavior;
    }
    return [
      {
        model,
        world,
        ...(graph && { graph }),
        ...(skeletal && { pose: skeletal.skeleton.pose, poseNodes: skeletal.poseNodes }),
      },
    ];
  }

  /** The graph's events: sounds, the texts shown again, the book closed. */
  #events(events: readonly string[]): void {
    for (const event of events) {
      const lower = event.toLowerCase();
      if (lower.startsWith(SOUND_PLAY)) {
        const name = event.slice(SOUND_PLAY.length);
        void this.#session.sounds().then((sounds) => sounds.playNamed(name, undefined));
      } else if (SHOWN_AFTER.has(lower) && !this.#closing) {
        this.#showTexts(true);
      } else if (CLOSED_AFTER.has(lower) && this.#closing) {
        this.#finish();
      }
    }
  }

  #showTexts(shown: boolean): void {
    this.#open = shown;
    for (const page of this.#textures) page.visibility.hidden = !shown;
  }

  /** The control map's Book and menu contexts. */
  #key(event: KeyboardEvent): boolean {
    if (event.repeat && event.code !== 'ArrowLeft' && event.code !== 'ArrowRight') return true;
    switch (event.code) {
      case 'KeyA':
      case 'ArrowLeft':
        this.#turn(-1);
        return true;
      case 'KeyD':
      case 'ArrowRight':
        this.#turn(1);
        return true;
      case 'KeyE':
      case 'Enter':
        this.#take();
        return true;
      case 'Tab':
      case 'Escape':
        this.close();
        return true;
      default:
        return false;
    }
  }

  readonly #pointer = (event: PointerEvent): void => {
    if (event.button === 0) this.#turn(-1);
    else if (event.button === 2) this.#turn(1);
  };

  readonly #wheel = (event: WheelEvent): void => {
    if (event.deltaY > 0) this.#turn(-1);
    else if (event.deltaY < 0) this.#turn(1);
  };

  readonly #noMenu = (event: Event): void => {
    event.preventDefault();
  };

  /** Turns a page (a note's) or a spread (a book's) forward (1) or back (−1). */
  #turn(direction: 1 | -1): void {
    const pages = this.#pages;
    if (!pages || this.#closing || !this.#open) return;
    const { note } = this.#setup;
    // Its result (whether a page turned) comes back from the method itself.
    const turned = pages.invoke(`${BOOK_ROOT}.TurnPage`, note ? direction : 2 * direction);
    if (turned !== true) return;
    if (!note) {
      this.#showTexts(false);
      this.#behavior?.sendEvent(direction > 0 ? 'PageForward' : 'PageBack');
    }
    void this.#drawPages();
  }

  #take(): void {
    const { canTake, read } = this.#setup;
    if (!canTake || !read.take || this.#closing) return;
    read.take();
    this.close();
  }

  /**
   * Draws the pages shown now (the left page and the one after it; a note's one) into their
   * textures, once book.swf has laid them out.
   */
  async #drawPages(): Promise<void> {
    const pages = this.#pages;
    if (!pages) return;
    const ticket = ++this.#drawing;
    const root = BOOK_ROOT;
    for (const [i, page] of this.#textures.entries()) {
      if (this.#stale(ticket)) return;
      const left = Number(pages.get(`${root}.iLeftPageNumber`) ?? 0);
      const set = Number(pages.get(`${root}.iPageSetIndex`) ?? 0);
      const wanted = left + i;
      // Its layout may still be running (a page every 30 ms).
      const until = performance.now() + 5000;
      while (
        !this.#stale(ticket) &&
        pages.get(`${root}.iPaginationIndex`) !== -1 &&
        Number(pages.get(`${root}.PageInfoA.length`) ?? 0) <= wanted + 1 &&
        performance.now() < until
      ) {
        await delay(30);
      }
      pages.invoke(`${root}.ShowPageAtOffset`, wanted - set);
      await nextDraw();
      if (this.#stale(ticket)) return;
      this.#copy(pages, page);
    }
  }

  /** A newer drawing has begun, or the book has closed. */
  #stale(ticket: number): boolean {
    return ticket !== this.#drawing || this.#finished;
  }

  /** Copies the movie's canvas into a page's texture. */
  #copy(pages: Menu, page: PageTexture): void {
    const canvas = pages.canvas;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return;
    const { texture } = page;
    const width = Math.min(canvas.width, texture.width);
    const height = Math.min(canvas.height, texture.height);
    try {
      this.#session.renderer.scene.copyCanvas(canvas, texture, width, height);
    } catch (error) {
      this.#terminal.log(
        'ui',
        `a book's page is not drawn: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
    }
  }

  /** Closes the book: its closing animation, then it is gone. */
  close(): void {
    if (this.#closing || this.#finished) return;
    this.#closing = true;
    this.#showTexts(false);
    if (this.#bar) this.#host.close(this.#bar);
    this.#bar = undefined;
    if (this.#behavior) {
      this.#behavior.sendEvent('Close');
      setTimeout(() => {
        this.#finish();
      }, CLOSE_TIMEOUT_MS);
    } else {
      this.#finish();
    }
  }

  #finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    const renderer = this.#session.renderer;
    // The inventory's item comes back when the book was read from there.
    if (renderer.overlay === this.#overlay) renderer.overlay = this.#previous;
    this.#book?.destroy();
    this.#texts?.destroy();
    for (const page of this.#textures) {
      page.model.destroy();
      this.#session.textures.withdraw(page.path);
      page.texture.destroy();
    }
    this.#textures = [];
    if (this.#pages) this.#host.close(this.#pages);
    if (this.#bar) this.#host.close(this.#bar);
    this.#pages = undefined;
    this.#bar = undefined;
    this.#setup.closed();
  }
}

/** The right page's text on the open book. */
function rightTextWorld(): Mat4 {
  return referenceMatrix({ position: RIGHT_PAGE, rotation: [0, 0, 0], scale: 1 });
}

/** The left page's text: on the sloping left page, its middle LEFT_OFFSET from the spine. */
function leftTextWorld(): Mat4 {
  const position: Vec3 = [
    LEFT_SPINE[0] - Math.cos(LEFT_SLOPE) * LEFT_OFFSET,
    LEFT_SPINE[1],
    LEFT_SPINE[2] - Math.sin(LEFT_SLOPE) * LEFT_OFFSET,
  ];
  // Its +X runs up the slope towards the spine, its +Z (the side read) up from the page.
  const c = Math.cos(LEFT_SLOPE);
  const sin = Math.sin(LEFT_SLOPE);
  return Float32Array.from([c, 0, sin, 0, 0, 1, 0, 0, -sin, 0, c, 0, ...position, 1]);
}

function noteTextWorld(): Mat4 {
  return referenceMatrix({ position: NOTE_TEXT, rotation: [0, 0, 0], scale: 1 });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** After the player has drawn what was just shown (its next frames). */
async function nextDraw(): Promise<void> {
  await delay(70);
  await new Promise((resolve) => requestAnimationFrame(resolve));
}
