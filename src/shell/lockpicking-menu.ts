// Picking a lock (interface\lockpickingmenu.swf over the menus' 3D): the lock with its cylinder
// and the shiv in it (meshes\interface\lockpicking\lockpickshiv01.nif: its Intro slides the lock
// in, its Rotate turns the cylinder and the shiv a quarter turn over its length) and the pick
// (lockpick01.nif, the Skeleton Key's own model when the player has it: Intro, PickDamage while
// it is strained, PickBreak). The mouse sweeps the pick over the top of the keyhole (0..180°;
// fPickMouseRotationSpeed); holding a movement key (the control map's Lockpicking context:
// RotateLock is Forward, Back, Strafe Left, Strafe Right) turns the lock at fLockRotationSpeed as
// far as the pick allows (src/gameplay/lockpicking.ts), the pick turning with the cylinder; let go,
// it turns back. Held against a pick that cannot turn it further, the pick strains and breaks
// after the lock level's time (one lockpick fewer; Unbreakable and the Skeleton Key never
// break); turned all the way, the lock opens. The perks widen the sweet spot (Novice .. Master
// Locks), make picks unbreakable (Unbreakable), start the pick near the sweet spot (Locksmith),
// give a picked lock's key (Wax Key) and keep the picking unnoticed (Quick Hands): the perk
// system's entry points (perk-engine.ts). The sweet spot is placed anew each time the menu
// opens (observed in the original: as the menu shows); a broken pick's successor starts in the
// middle. The engine reports the pick's sweep, the sweet spot, the pick's and the lock's angles
// and the pick's health to the movie's debug display (SetPickMinMax, UpdateSweetSpot,
// UpdatePickAngle, UpdateLockAngle, UpdatePickHealth), which shows only once toggled
// (ToggleDebugMode, which the engine never calls). The bar shows the skill, its progress to the
// next level, the lock's level and the lockpicks left (SetLockInfo). A lock opened is
// fSkillUsageLockPick<level> uses of Lockpicking, a broken pick fSkillUsageLockPickBroken (the
// progression engine). Cancel (Tab, Esc) leaves. An owned lock picked where someone sees it is
// trespassing (crime-engine.ts lockPicked). What the lock and the pick do apart from showing them
// is the menu's engine side (lock-picking.ts), which the headless simulation runs without it.
// Notes: docs/ui.md ("Lockpicking").

import { LOCK_OPEN_ANGLE, LOCKPICK, PICK_RANGE } from '../gameplay/lockpicking.ts';
import { clock } from './object-graphs.ts';
import type { Playback } from '../render/animation.ts';
import { multiply, type Mat4, type Vec3 } from '../render/math.ts';
import type { OverlayView } from '../render/menu-overlay.ts';
import type { GpuModel, GpuScene, InstanceMotion } from '../render/scene-renderer.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { SoundInstance } from '../audio/sound-instance.ts';
import type { Menu, MenuHost } from '../ui/menu-host.ts';
import type { INI_DEFAULTS } from '../world/ini-settings.ts';
import type { GameSession } from './game-session.ts';
import {
  LockPick,
  LOCKPICKING,
  lockOpened,
  pickBroke,
  pickSetup,
  type PickSetup,
} from './lock-picking.ts';
import { MenuCamera, menuLighting, menuPlacement } from './menu-3d.ts';
import type { Terminal } from './terminal.ts';

const LOCK_MODEL = 'meshes\\interface\\lockpicking\\lockpickshiv01.nif';
const PICK_MODEL = 'meshes\\interface\\lockpicking\\lockpick01.nif';
const SKELETON_KEY_MODEL = 'meshes\\interface\\lockpicking\\lockpickskeletonkey01.nif';

/**
 * Where the models' parts turn (model space): the cylinder about its node (LockPickLockTumble
 * after the lock's Intro), the pick about its tip in the keyhole (LockPick01 after the pick's
 * Intro); both about the lock's axis, +Y (into the lock).
 */
const CYLINDER_PIVOT: Vec3 = [14.52, -16, 1.48];
const PICK_PIVOT: Vec3 = [14.52, -16, 7.36];
/**
 * The lock's distance in the menus' space: 150 behind its light (fLockpickLightY −1000), as the
 * inventory's item stands 150 behind its own (fInventoryMenuLightY −350, the item at −500).
 */
const LOCK_DISTANCE = 1150;
/** The Rotate sequence's length (the cylinder's quarter turn). */
const ROTATE_SECONDS = 2.96;
/** The pick's Intro and PickDamage sequences' lengths (s). */
const PICK_INTRO_SECONDS = 1;
const DAMAGE_SECONDS = 0.97;
/** Pick sounds come at most this often (s). */
const PICK_SOUND_SECONDS = 0.15;
/** GetPlayerAction's lock outcomes (xEdit wbPlayerActionEnum). */
/** The opened lock shows a moment before the menu closes (s). */
const OPENED_SECONDS = 0.8;
/** The broken pick's sequence plays before the next comes in (s). */
const BREAK_SECONDS = 1.2;
/** The menus' depth among the game's menus. */
const LOCK_DEPTH = 6;

type InterfaceKey = keyof (typeof INI_DEFAULTS)['Interface'];

/** Keys of the RotateLock event: the movement keys. */
const ROTATE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown']);

export class LockpickingMenu {
  readonly #host: MenuHost;
  readonly #session: GameSession;
  readonly #terminal: Terminal;

  constructor(host: MenuHost, session: GameSession, terminal: Terminal) {
    this.#host = host;
    this.#session = session;
    this.#terminal = terminal;
  }

  /**
   * Opens the menu for a locked reference; `closed(unlocked)` once it has closed. Undefined
   * when it cannot open (the game is not running, the models are missing).
   */
  async open(
    reference: number,
    closed: (unlocked: boolean) => void,
  ): Promise<{ readonly menu: Menu; close(): void } | undefined> {
    const session = this.#session;
    const runtime = session.scriptsReady;
    if (!runtime) return undefined;
    const settings = await session.settings();
    const setup = await pickSetup(runtime, settings, reference);
    if (!setup) return undefined;
    const [lockModel, pickModel] = await Promise.all([
      session.model(LOCK_MODEL),
      session.model(setup.skeletonKey ? SKELETON_KEY_MODEL : PICK_MODEL),
    ]);
    if (!lockModel || !pickModel) {
      this.#terminal.log('ui', 'the lockpicking models do not load', 'warn');
      return undefined;
    }
    const picking = new Picking(this.#host, session, runtime, {
      lock: setup,
      lockModel,
      pickModel,
      closed,
    });
    const menu = await picking.start();
    return {
      menu,
      close: () => {
        picking.close(false);
      },
    };
  }
}

interface PickingSetup {
  /** The lock as picked (its shape, the perks' part, the level's name for SetLockInfo). */
  readonly lock: PickSetup;
  readonly lockModel: GpuModel;
  readonly pickModel: GpuModel;
  readonly closed: (unlocked: boolean) => void;
}

/** One lock being picked. */
class Picking {
  readonly #host: MenuHost;
  readonly #session: GameSession;
  readonly #runtime: ScriptRuntime;
  readonly #setup: PickingSetup;
  #menu: Menu | undefined;
  #scene: GpuScene | undefined;
  #overlay: OverlayView | undefined;
  #previous: OverlayView | undefined;
  readonly #lockPlayback: Playback = { sequence: 'intro', start: clock() };
  readonly #pickPlayback: Playback = { sequence: 'intro', start: clock() };
  readonly #pickMotion: InstanceMotion = { version: 0 };
  readonly #pickWorld = new Float32Array(16);
  #base: Mat4 = new Float32Array(16);
  /** The pick's angle in its sweep, the lock's turn (degrees), the strain on the pick (0..1). */
  readonly #lock: LockPick;
  #turning = false;
  /** Waiting: the pick broke (until a new one is in), or the lock opened. */
  #busyUntil = 0;
  #opened = false;
  #done = false;
  #last: number | undefined;
  #lastPickSound = 0;
  #tension: Promise<SoundInstance | undefined> | undefined;
  #atLimit = false;
  readonly #keys = new Set<string>();
  /** The pick's angle, the lock's and the pick's health as last reported to the movie. */
  #reported: { pick: number; turn: number; health: number } | undefined;

  constructor(host: MenuHost, session: GameSession, runtime: ScriptRuntime, setup: PickingSetup) {
    this.#host = host;
    this.#session = session;
    this.#runtime = runtime;
    this.#setup = setup;
    this.#lock = new LockPick(setup.lock);
  }

  async start(): Promise<Menu> {
    const { lockModel, pickModel } = this.#setup;
    const renderer = this.#session.renderer;
    this.#base = menuPlacement({
      pivot: CYLINDER_PIVOT,
      at: [0, -LOCK_DISTANCE, 0],
      faceCamera: false,
      turnDegrees: 180,
    });
    this.#placePick();
    this.#scene = renderer.scene.createScene([
      { model: lockModel, world: this.#base, playback: this.#lockPlayback },
      {
        model: pickModel,
        world: this.#pickWorld,
        motion: this.#pickMotion,
        playback: this.#pickPlayback,
      },
    ]);
    const n = (key: InterfaceKey): number => this.#session.ini.number('Interface', key);
    const lighting = menuLighting([
      {
        at: [n('fLockpickLightX'), n('fLockpickLightY'), n('fLockpickLightZ')],
        color: [
          n('fLockpickLightDiffuseColorR'),
          n('fLockpickLightDiffuseColorG'),
          n('fLockpickLightDiffuseColorB'),
        ],
        dimmer: n('fLockpickLightDimmerValue'),
        radius: n('fLockpickLightRadius'),
      },
    ]);
    const scene = this.#scene;
    this.#overlay = {
      scenes: () => [scene],
      camera: new MenuCamera(),
      lighting: () => lighting,
      update: (seconds) => {
        this.#update(seconds);
      },
    };
    this.#previous = renderer.overlay;
    renderer.overlay = this.#overlay;
    this.#sound('UILockpickingEnter');

    this.#menu = await this.#host.open('lockpickingmenu.swf', {
      depth: LOCK_DEPTH,
      interactive: true,
      cursor: false,
      onKey: (_menu, event) => this.#key(event),
      setup: async (menu) => {
        if (!(await menu.waitFor('_root.InitExtensions'))) return;
        menu.invoke('_root.InitExtensions');
        menu.tellPlatform('_root.SetPlatform');
        await this.#showInfo(menu);
        // The debug display's values (in the original's terms: the pick's sweep −90..90°, the
        // sweet spot's middle there, its width and its partial zones' width).
        const { center, sweetSpot, partial } = this.#setup.lock.shape;
        menu.call('SetPickMinMax', -PICK_RANGE / 2, PICK_RANGE / 2);
        menu.call('UpdateSweetSpot', center - PICK_RANGE / 2, sweetSpot, partial);
        this.#reported = undefined;
        this.#report(menu);
      },
    });
    window.addEventListener('pointermove', this.#moved);
    window.addEventListener('keyup', this.#released, { capture: true });
    return this.#menu;
  }

  /** The bar: the skill now and next, its progress (0..100), the lock's level, the picks left. */
  async #showInfo(menu: Menu): Promise<void> {
    const runtime = this.#runtime;
    const skill = Math.floor((await runtime.actors.value(PLAYER_REF, LOCKPICKING)).current);
    const progress = await runtime.progression.skillProgress(LOCKPICKING);
    const picks = await runtime.itemCount(PLAYER_REF, LOCKPICK);
    menu.call(
      'SetLockInfo',
      String(skill),
      String(skill + 1),
      progress * 100,
      this.#setup.lock.levelName,
      picks,
    );
  }

  /** The control map's Lockpicking context: RotateLock (the movement keys), Cancel. */
  #key(event: KeyboardEvent): boolean {
    if (event.code === 'Tab' || event.code === 'Escape') {
      if (!event.repeat) this.close(false);
      return true;
    }
    if (ROTATE_KEYS.has(event.code)) {
      this.#keys.add(event.code);
      return true;
    }
    return false;
  }

  readonly #released = (event: KeyboardEvent): void => {
    this.#keys.delete(event.code);
  };

  readonly #moved = (event: PointerEvent): void => {
    if (this.#done || this.#turning || this.#busy() || event.movementX === 0) return;
    const speed = this.#session.ini.number('Interface', 'fPickMouseRotationSpeed') / 50;
    if (!this.#lock.sweep(this.#lock.pick + event.movementX * speed)) return;
    this.#placePick();
    const now = clock();
    if (now - this.#lastPickSound > PICK_SOUND_SECONDS) {
      this.#lastPickSound = now;
      this.#sound('UILockpickingPickMovement');
    }
  };

  #busy(): boolean {
    return clock() < this.#busyUntil;
  }

  #update(seconds: number): void {
    const dt = this.#last === undefined ? 0 : Math.min(0.1, seconds - this.#last);
    this.#last = seconds;
    if (this.#done) return;
    // Its menu closed from outside (Play ended).
    if (this.#menu?.closed) {
      this.close(false);
      return;
    }
    const speed = this.#session.ini.number('Interface', 'fLockRotationSpeed');
    const holding = this.#keys.size > 0 && !this.#busy() && !this.#opened;
    if (holding && !this.#turning) this.#sound('UILockpickingCylinderTurn');
    this.#turning = holding;
    const step = this.#lock.step(dt, holding, speed);
    // The cylinder (and the shiv) where the lock has turned: the Rotate sequence's moment.
    if (clock() - this.#lockPlayback.start >= 1.3 || this.#lockPlayback.sequence === 'rotate') {
      this.#lockPlayback.sequence = 'rotate';
      this.#lockPlayback.start =
        clock() -
        (Math.min(this.#lock.turn, LOCK_OPEN_ANGLE - 0.01) / LOCK_OPEN_ANGLE) * ROTATE_SECONDS;
    }
    this.#placePick();
    if (step === 'opened') {
      this.#unlocked();
      return;
    }
    const straining = this.#lock.straining;
    if (straining && !this.#atLimit) this.#sound('UILockpickingCylinderStop');
    this.#atLimit = straining;
    this.#strainPick(straining);
    if (step === 'broken') void this.#broken();
  }

  /** The pick under strain: it shakes, its tension sounds, and it breaks in time. */
  #strainPick(straining: boolean): void {
    if (!straining) {
      // Back at the end of its Intro: in the keyhole.
      if (this.#pickPlayback.sequence === 'pickdamage') this.#restPick();
      void this.#tension?.then((sound) => sound?.stop());
      this.#tension = undefined;
      return;
    }
    // It shakes as long as it is strained (the sequence plays once: again and again).
    if (
      this.#pickPlayback.sequence !== 'pickdamage' ||
      clock() - this.#pickPlayback.start > DAMAGE_SECONDS
    ) {
      this.#pickPlayback.sequence = 'pickdamage';
      this.#pickPlayback.start = clock();
    }
    this.#tension ??= this.#playing('UILockpickingPickTensionLPM');
  }

  /** The pick broke: one lockpick fewer; the next comes in, or the menu closes without any. */
  async #broken(): Promise<void> {
    this.#keys.clear();
    this.#busyUntil = clock() + BREAK_SECONDS;
    void this.#tension?.then((sound) => sound?.stop());
    this.#tension = undefined;
    this.#pickPlayback.sequence = 'pickbreak';
    this.#pickPlayback.start = clock();
    this.#sound('UILockpickingPickBreak');
    const left = await pickBroke(this.#runtime, this.#setup.lock);
    if (this.#menu) await this.#showInfo(this.#menu);
    if (left <= 0) {
      const settings = await this.#session.settings();
      this.#session.hud.notification(settings.string('sOutOfLockpicks') ?? '');
      setTimeout(() => {
        this.close(false);
      }, BREAK_SECONDS * 1000);
      return;
    }
    setTimeout(() => {
      if (this.#done) return;
      this.#pickPlayback.sequence = 'intro';
      this.#pickPlayback.start = clock();
    }, BREAK_SECONDS * 1000);
  }

  /** Turned all the way: the lock opens (OnLockStateChanged), the menu closes. */
  #unlocked(): void {
    if (this.#opened) return;
    this.#opened = true;
    this.#keys.clear();
    this.#sound('UILockpickingUnlock');
    void this.#tension?.then((sound) => sound?.stop());
    this.#runtime.detach(lockOpened(this.#runtime, this.#setup.lock));
    setTimeout(() => {
      this.close(true);
    }, OPENED_SECONDS * 1000);
  }

  /** The pick at the end of its Intro, in the keyhole. */
  #restPick(): void {
    this.#pickPlayback.sequence = 'intro';
    this.#pickPlayback.start = clock() - PICK_INTRO_SECONDS;
  }

  /** The pick where it points, turned with the cylinder. */
  #placePick(): void {
    const cylinder = aboutY(CYLINDER_PIVOT, this.#lock.turn);
    const pick = aboutY(PICK_PIVOT, this.#lock.pick - PICK_RANGE / 2);
    this.#pickWorld.set(multiply(this.#base, multiply(cylinder, pick)));
    this.#pickMotion.version++;
    if (this.#menu) this.#report(this.#menu);
  }

  /** The pick's and the lock's angles and the pick's health (0..100) to the debug display. */
  #report(menu: Menu): void {
    const lock = this.#lock;
    const now = { pick: lock.pick, turn: lock.turn, health: 100 * (1 - lock.strain) };
    const last = this.#reported;
    if (now.pick !== last?.pick) menu.call('UpdatePickAngle', now.pick - PICK_RANGE / 2);
    if (now.turn !== last?.turn) menu.call('UpdateLockAngle', now.turn);
    if (now.health !== last?.health) menu.call('UpdatePickHealth', now.health);
    this.#reported = now;
  }

  /** A UI sound (a sound descriptor by editor id), at no place. */
  #sound(name: string): void {
    void this.#playing(name);
  }

  #playing(name: string): Promise<SoundInstance | undefined> {
    return this.#session.sounds().then((sounds) => sounds.playNamed(name, undefined));
  }

  close(unlocked: boolean): void {
    if (this.#done) return;
    this.#done = true;
    window.removeEventListener('pointermove', this.#moved);
    window.removeEventListener('keyup', this.#released, { capture: true });
    void this.#tension?.then((sound) => sound?.stop());
    const renderer = this.#session.renderer;
    if (renderer.overlay === this.#overlay) renderer.overlay = this.#previous;
    this.#scene?.destroy();
    if (this.#menu) this.#host.close(this.#menu);
    this.#menu = undefined;
    this.#setup.closed(unlocked);
  }
}

/** A turn about the lock's axis (+Y) through a point, in degrees (clockwise as seen). */
function aboutY(pivot: Vec3, degrees: number): Mat4 {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const [px, py, pz] = pivot;
  // T(pivot) · R_y(a) · T(−pivot), column-major.
  return Float32Array.from([
    c,
    0,
    -s,
    0,
    0,
    1,
    0,
    0,
    s,
    0,
    c,
    0,
    px - (c * px + s * pz),
    py - py,
    pz - (-s * px + c * pz),
    1,
  ]);
}
