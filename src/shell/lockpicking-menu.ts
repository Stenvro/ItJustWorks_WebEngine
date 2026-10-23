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
// system's entry points (perk-engine.ts). A
// lock's sweet spot stays where it is until the game is loaded again. The bar shows the skill,
// its progress to the next level, the lock's level and the lockpicks left (SetLockInfo). A lock
// opened is fSkillUsageLockPick<level> uses of Lockpicking, a broken pick
// fSkillUsageLockPickBroken (the progression engine). Cancel (Tab, Esc) leaves. An owned lock
// picked where someone sees it is trespassing (crime-engine.ts lockPicked).
// Notes: docs/ui.md ("Lockpicking").

import {
  BROKEN_PICK_SKILL_USE,
  lockDifficulty,
  lockLevelSetting,
  LOCKPICK_SKILL_USES,
  lockpickSkillUseSetting,
  lockpickSettings,
  lockShape,
  lockTurnLimit,
  LOCK_OPEN_ANGLE,
  LOCKPICK,
  SKELETON_KEY,
  PICK_RANGE,
  type LockShape,
} from '../gameplay/lockpicking.ts';
import { EntryPoint } from '../gameplay/perk-entry-points.ts';
import { clock } from './object-graphs.ts';
import type { Playback } from '../render/animation.ts';
import { multiply, type Mat4, type Vec3 } from '../render/math.ts';
import type { OverlayView } from '../render/menu-overlay.ts';
import type { GpuModel, GpuScene, InstanceMotion } from '../render/scene-renderer.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { SoundInstance } from '../audio/sound-instance.ts';
import type { Menu, MenuHost } from '../ui/menu-host.ts';
import { ActorValue } from '../world/actor-values.ts';
import type { INI_DEFAULTS } from '../world/ini-settings.ts';
import type { GameSession } from './game-session.ts';
import { MenuCamera, menuLighting, menuPlacement } from './menu-3d.ts';
import type { Terminal } from './terminal.ts';

const LOCK_MODEL = 'meshes\\interface\\lockpicking\\lockpickshiv01.nif';
const PICK_MODEL = 'meshes\\interface\\lockpicking\\lockpick01.nif';
const SKELETON_KEY_MODEL = 'meshes\\interface\\lockpicking\\lockpickskeletonkey01.nif';

/** Lockpicking's actor value. */
const LOCKPICKING = ActorValue.firstSkill + 8;

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
const PlayerAction = { lockpickSuccess: 3, lockpickBroken: 4 } as const;
/** The opened lock shows a moment before the menu closes (s). */
const OPENED_SECONDS = 0.8;
/** The broken pick's sequence plays before the next comes in (s). */
const BREAK_SECONDS = 1.2;
/** The menus' depth among the game's menus. */
const LOCK_DEPTH = 6;

/** Each lock's sweet spot, as placed this session (a lock keeps it until the game is loaded). */
const SWEET_SPOTS = new Map<number, number>();
/**
 * The picks broken on each lock this session (fLockpickBrokenPicksMult widens its sweet spot by
 * them as the menu opens). TODO(M12): kept with the lock in saves.
 */
const BROKEN_PICKS = new Map<number, number>();

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
    const lock = await runtime.lock(reference);
    const difficulty = lockDifficulty(lock.level);
    if (difficulty === undefined) return undefined;
    const skeletonKey = (await runtime.itemCount(PLAYER_REF, SKELETON_KEY)) > 0;
    const [lockModel, pickModel] = await Promise.all([
      session.model(LOCK_MODEL),
      session.model(skeletonKey ? SKELETON_KEY_MODEL : PICK_MODEL),
    ]);
    if (!lockModel || !pickModel) {
      this.#terminal.log('ui', 'the lockpicking models do not load', 'warn');
      return undefined;
    }
    const settings = await session.settings();
    const skill = (await runtime.actors.value(PLAYER_REF, LOCKPICKING)).current;
    // The perks (Mod Lockpick Sweet Spot: the lock levels' perks by GetLockLevel on the lock,
    // Fortify Lockpicking through the skill boost perks; Make Lockpicks Unbreakable; Set
    // Lockpick Starting Arc: Locksmith).
    const perks = runtime.perks;
    const perk = await perks.apply(EntryPoint.modLockpickSweetSpot, PLAYER_REF, 1, [reference]);
    const unbreakable =
      (await perks.apply(EntryPoint.makeLockpicksUnbreakable, PLAYER_REF, 0)) !== 0;
    const startArc = await perks.apply(EntryPoint.setLockpickStartingArc, PLAYER_REF, 0);
    let random = SWEET_SPOTS.get(reference);
    if (random === undefined) {
      random = Math.random();
      SWEET_SPOTS.set(reference, random);
    }
    const shape = lockShape(difficulty, skill, {
      perk,
      random,
      settings: lockpickSettings((name) => settings.number(name)),
      brokenPicks: BROKEN_PICKS.get(reference) ?? 0,
    });
    const picking = new Picking(this.#host, session, runtime, {
      reference,
      shape,
      lockModel,
      pickModel,
      unbreakable: skeletonKey || unbreakable,
      startArc,
      levelName: settings.string(lockLevelSetting(difficulty)) ?? '',
      skillUses: {
        opened:
          settings.number(lockpickSkillUseSetting(difficulty)) ??
          LOCKPICK_SKILL_USES[difficulty - 1] ??
          0,
        broken: settings.number('fSkillUsageLockPickBroken') ?? BROKEN_PICK_SKILL_USE,
      },
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
  readonly reference: number;
  readonly shape: LockShape;
  readonly lockModel: GpuModel;
  readonly pickModel: GpuModel;
  readonly unbreakable: boolean;
  /** The arc (degrees) about the opening the pick starts in (0: the middle of its sweep). */
  readonly startArc: number;
  /** The lock's level name (SetLockInfo's after the skill, the next level and the progress). */
  readonly levelName: string;
  /** Lockpicking skill uses of opening the lock and of a pick breaking. */
  readonly skillUses: { readonly opened: number; readonly broken: number };
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
  #pick = PICK_RANGE / 2;
  #turn = 0;
  #strain = 0;
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

  constructor(host: MenuHost, session: GameSession, runtime: ScriptRuntime, setup: PickingSetup) {
    this.#host = host;
    this.#session = session;
    this.#runtime = runtime;
    this.#setup = setup;
    if (setup.startArc > 0) {
      // Near the opening position: somewhere within the arc about it (Locksmith: 45°).
      // TODO(M13): where in the arc the engine puts it is not documented.
      const offset = (Math.random() - 0.5) * setup.startArc;
      this.#pick = clampPick(setup.shape.center + offset);
    }
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
        menu.invoke('_root.SetPlatform', 0, false);
        await this.#showInfo(menu);
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
      this.#setup.levelName,
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
    const before = this.#pick;
    this.#pick = clampPick(this.#pick + event.movementX * speed);
    if (this.#pick === before) return;
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
    const { shape } = this.#setup;
    const speed = this.#session.ini.number('Interface', 'fLockRotationSpeed');
    const holding = this.#keys.size > 0 && !this.#busy() && !this.#opened;
    const limit = lockTurnLimit(shape, this.#pick);
    if (holding) {
      if (!this.#turning) this.#sound('UILockpickingCylinderTurn');
      this.#turning = true;
      this.#turn = Math.min(limit, this.#turn + speed * dt);
    } else {
      this.#turning = false;
      this.#turn = Math.max(0, this.#turn - speed * 2 * dt);
    }
    // The cylinder (and the shiv) where the lock has turned: the Rotate sequence's moment.
    if (clock() - this.#lockPlayback.start >= 1.3 || this.#lockPlayback.sequence === 'rotate') {
      this.#lockPlayback.sequence = 'rotate';
      this.#lockPlayback.start =
        clock() - (Math.min(this.#turn, LOCK_OPEN_ANGLE - 0.01) / LOCK_OPEN_ANGLE) * ROTATE_SECONDS;
    }
    this.#placePick();
    if (this.#turn >= LOCK_OPEN_ANGLE - 0.01) {
      this.#unlocked();
      return;
    }
    const straining = holding && this.#turn >= limit - 0.01;
    if (straining && !this.#atLimit) this.#sound('UILockpickingCylinderStop');
    this.#atLimit = straining;
    this.#strainPick(straining, dt);
  }

  /** The pick under strain: it shakes, its tension sounds, and it breaks in time. */
  #strainPick(straining: boolean, dt: number): void {
    const { shape, unbreakable } = this.#setup;
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
    if (unbreakable) return;
    this.#strain += dt / Math.max(0.05, shape.breakSeconds);
    if (this.#strain >= 1) void this.#broken();
  }

  /** The pick broke: one lockpick fewer; the next comes in, or the menu closes without any. */
  async #broken(): Promise<void> {
    this.#strain = 0;
    this.#turn = 0;
    this.#keys.clear();
    this.#busyUntil = clock() + BREAK_SECONDS;
    void this.#tension?.then((sound) => sound?.stop());
    this.#tension = undefined;
    this.#pickPlayback.sequence = 'pickbreak';
    this.#pickPlayback.start = clock();
    this.#sound('UILockpickingPickBreak');
    const lock = this.#setup.reference;
    BROKEN_PICKS.set(lock, (BROKEN_PICKS.get(lock) ?? 0) + 1);
    const runtime = this.#runtime;
    // GetPlayerAction: a lockpick broken (those near may react).
    runtime.playerActed(PlayerAction.lockpickBroken);
    await runtime.removeItem(PLAYER_REF, runtime.formHandle(LOCKPICK), 1, true, undefined);
    await runtime.progression.useSkill(PLAYER_REF, LOCKPICKING, this.#setup.skillUses.broken);
    const left = await runtime.itemCount(PLAYER_REF, LOCKPICK);
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
    const { reference } = this.#setup;
    this.#runtime.playerActed(PlayerAction.lockpickSuccess);
    this.#runtime.state.reference(reference).locked = false;
    this.#runtime.events.emit('lockChanged', { reference });
    void this.#runtime.progression.useSkill(PLAYER_REF, LOCKPICKING, this.#setup.skillUses.opened);
    // An owned lock picked in sight is a crime (crime-engine.ts lockPicked); Locks Picked.
    this.#runtime.incrementStat('Locks Picked');
    void this.#runtime.crime.lockPicked(PLAYER_REF, reference);
    void this.#waxKey(reference);
    setTimeout(() => {
      this.close(true);
    }, OPENED_SECONDS * 1000);
  }

  /**
   * A lock picked open may give its key (Mod Lockpicking Key Reward Chance, percent: Wax Key,
   * always), if the player has none of it.
   */
  async #waxKey(reference: number): Promise<void> {
    const runtime = this.#runtime;
    const { key } = await runtime.lock(reference);
    if (key === undefined || (await runtime.itemCount(PLAYER_REF, key)) > 0) return;
    const chance = await runtime.perks.apply(
      EntryPoint.modLockpickingKeyRewardChance,
      PLAYER_REF,
      0,
      [reference],
    );
    if (Math.random() * 100 < chance)
      await runtime.addItem(PLAYER_REF, runtime.formHandle(key), 1, false);
  }

  /** The pick at the end of its Intro, in the keyhole. */
  #restPick(): void {
    this.#pickPlayback.sequence = 'intro';
    this.#pickPlayback.start = clock() - PICK_INTRO_SECONDS;
  }

  /** The pick where it points, turned with the cylinder. */
  #placePick(): void {
    const cylinder = aboutY(CYLINDER_PIVOT, this.#turn);
    const pick = aboutY(PICK_PIVOT, this.#pick - PICK_RANGE / 2);
    this.#pickWorld.set(multiply(this.#base, multiply(cylinder, pick)));
    this.#pickMotion.version++;
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

function clampPick(angle: number): number {
  return Math.max(0, Math.min(PICK_RANGE, angle));
}
