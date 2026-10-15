// The skills menu (interface\statsmenu.swf over the menus' 3D): the sky dome
// (meshes\interface\intperkskydome.nif: its CameraIntro brings the camera, its CameraPosition
// node, up from below; its own Idle moves the nebula; CameraOutro takes the camera away as the
// menu closes), the skills' perk trees as stars on their constellations (intperkstars01.nif,
// lines intperkline01.nif; their graphs: Locked, Unlocked, Owned, Selected, Own as a perk is
// taken), the camera turning about the dome's middle with the ring of skill names
// (src/gameplay/skills-ring.ts). The movie shows the skill names around the ring
// (StatsMenu.SkillStatsA: level, name, progress, colour, legendary count per skill, then
// UpdateSkillList; SetDirection(degrees) as the camera turns), the player's name, level, race and
// attributes (SetPlayerInfo), the card of the skill or perk (SetDescriptionCard), the perk
// points (SetPerkCount), and the perks' names where their stars are on the screen
// (StatsMenu.PerkNamesA: name, x, y in 0..1; UpdatePerkText).
//
// The control map's Stats context: Left / Right (A, D, the mouse) turn to the next skill, Up (W)
// or Accept (E) looks up into its perk tree (the camera pitching to the tree), Cancel (Tab, Esc)
// back down, and out of the menu. In a tree the arrows move to the nearest star that way, the
// mouse to the one under it; Accept or a click takes the perk if it can be had (its conditions,
// a perk point; the movie asks sStatsPerkConfirm first). A skill at 100 can be made Legendary
// (Space; sLegendaryResetConfirm, sLegendaryResetSecondConfirm): back to 15, its perks' points
// returned. The camera's field of view is fStatsCameraFOV (50, of a 4:3 frame).
// TODO(M11): the skills' and the level's progress (experience), skill colours for fortified
// and damaged skills, the perks' effects.
// Notes: docs/ui.md ("The skills menu").

import type { ObjectGraph } from '../animation/object-graph.ts';
import {
  nearestRing,
  RING_SKILLS,
  ringAxes,
  SKILL_ANGLE,
  starPlace,
  STAR_DISTANCE,
  STAR_GRID_DEFAULTS,
  type StarGrid,
} from '../gameplay/skills-ring.ts';
import { playSequence, type Playback } from '../render/animation.ts';
import { lookAt, multiply, perspectiveReversedZ, type Mat4, type Vec3 } from '../render/math.ts';
import type { OverlayView } from '../render/menu-overlay.ts';
import type { Camera } from '../render/renderer.ts';
import {
  flatAmbient,
  type GpuModel,
  type GpuScene,
  type ModelInstance,
  type SceneLighting,
} from '../render/scene-renderer.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { Menu, MenuHost } from '../ui/menu-host.ts';
import { ActorValue } from '../world/actor-values.ts';
import type { GameSettings } from '../world/game-settings.ts';
import { parsePerk, type PerkRecord } from '../world/perk-records.ts';
import { parseSkill, type PerkTreeNode, type SkillRecord } from '../world/perk-trees.ts';
import type { GameSession } from './game-session.ts';
import { clock, startObjectGraph } from './object-graphs.ts';
import type { Terminal } from './terminal.ts';

const DOME_MODEL = 'meshes\\interface\\intperkskydome.nif';
const STAR_MODEL = 'meshes\\interface\\intperkstars01.nif';
const LINE_MODEL = 'meshes\\interface\\intperkline01.nif';
/** The line model's beam runs along +Y to its BeamEnd node. */
const LINE_LENGTH = 56.2;
/** Where the camera rests after the dome's CameraIntro (its CameraPosition node). */
const CAMERA_REST_Z = -16.44;
/** The intro's and outro's lengths (s). */
const INTRO_SECONDS = 0.63;
/**
 * How far up the camera looks at the ring (degrees): the constellations over the names.
 * Fitted (the dome's camera node looks level; the menu shows the constellations above).
 */
const RING_PITCH = 10;
/** Seconds the camera takes to look up into a tree or back down, and to turn a skill. */
const PITCH_SECONDS = 0.5;
const TURN_SPEED = 120;
/** Degrees the view turns per pixel the mouse moves. */
const MOUSE_DEGREES = 0.15;
/** A skill made Legendary goes back to this (UESP, "Legendary skills"). */
const LEGENDARY_LEVEL = 15;
/** The skill names' colour (TODO(M11): fortified green, damaged red). */
const WHITE = '#FFFFFF';
/** The menus' depth among the game's menus. */
const STATS_DEPTH = 6;
/** The names the movie has clips for (StatsMenu.MaxPerkNamesDisplayed). */
const PERK_NAMES = 64;
/** Its own little light (the dome's materials are effects: they light themselves). */
const LIGHT: SceneLighting = {
  sunDirection: [0, 0, 1],
  sunColor: [0, 0, 0],
  ambient: flatAmbient([1, 1, 1]),
  fog: undefined,
  lights: [],
};

/** One perk of a tree: its star, its ranks (the perk and those NNAM leads on to). */
interface PerkStar {
  readonly node: PerkTreeNode;
  readonly ranks: readonly PerkRecord[];
  readonly place: Vec3;
  readonly graph: ObjectGraph | undefined;
  /** Its state now: 'locked', 'unlocked' (it can be taken), 'owned'. */
  state: 'locked' | 'unlocked' | 'owned';
  /** Ranks owned. */
  owned: number;
}

interface Tree {
  readonly ring: number;
  readonly skill: number;
  readonly record: SkillRecord;
  readonly description: string;
  readonly stars: PerkStar[];
  readonly lines: {
    readonly from: PerkStar;
    readonly to: PerkStar;
    readonly graph: ObjectGraph | undefined;
  }[];
  /** The tree's middle, as the camera sees it (degrees up). */
  readonly pitch: number;
}

/** The camera at the dome's middle, turned to a heading and pitched up. */
class SkillsCamera implements Camera {
  position: Vec3 = [0, 0, CAMERA_REST_Z];
  forward: Vec3 = [0, 1, 0];
  readonly near = 1;
  yaw = 0;
  pitch = RING_PITCH;
  z = CAMERA_REST_Z;
  /** Vertical field of view (radians). */
  readonly #fovY: number;

  constructor(fovDegrees: number) {
    this.#fovY = 2 * Math.atan(Math.tan((fovDegrees * Math.PI) / 360) * 0.75);
  }

  update(): void {
    // The menu moves it.
  }

  viewProjection(aspect: number, out: Mat4 = new Float32Array(16)): Mat4 {
    const yaw = (this.yaw * Math.PI) / 180;
    const pitch = (this.pitch * Math.PI) / 180;
    this.position = [0, 0, this.z];
    this.forward = [
      Math.sin(yaw) * Math.cos(pitch),
      Math.cos(yaw) * Math.cos(pitch),
      Math.sin(pitch),
    ];
    const target: Vec3 = [this.forward[0], this.forward[1], this.z + this.forward[2]];
    const view = lookAt(this.position, target, [0, 0, 1]);
    return multiply(perspectiveReversedZ(this.#fovY, aspect, this.near), view, out);
  }
}

/** The music type the menu plays while open. */
const SKILLS_MUSIC = 'MUSSkillsMenu';

export class SkillsMenu {
  readonly #host: MenuHost;
  readonly #session: GameSession;
  readonly #terminal: Terminal;
  readonly #confirm: (text: string, buttons: readonly string[]) => Promise<number>;
  /** The skill the menu was left at (it opens there again). */
  #ring = 1;

  constructor(
    host: MenuHost,
    session: GameSession,
    terminal: Terminal,
    confirm: (text: string, buttons: readonly string[]) => Promise<number>,
  ) {
    this.#host = host;
    this.#session = session;
    this.#terminal = terminal;
    this.#confirm = confirm;
  }

  /**
   * Opens the menu (`levelUp`: after levelling up, the movie's LEVEL_UP state); `closed` once it
   * has closed (after the camera's outro). Undefined if it cannot open.
   */
  async open(
    levelUp: boolean,
    closed: () => void,
  ): Promise<{ readonly menu: Menu | undefined; close(): void } | undefined> {
    const session = this.#session;
    const runtime = session.scriptsReady;
    if (!runtime) return undefined;
    const [dome, star, line] = await Promise.all([
      session.model(DOME_MODEL),
      session.model(STAR_MODEL),
      session.model(LINE_MODEL),
    ]);
    if (!dome || !star || !line) {
      this.#terminal.log('ui', 'the skills menu models do not load', 'warn');
      return undefined;
    }
    const settings = await session.settings();
    // Its music while it is open (MUSSkillsMenu: silence that ducks what played).
    const sounds = session.soundSystem;
    const music = await sounds?.musicNamed(SKILLS_MUSIC);
    if (music !== undefined) sounds?.music.add(music);
    const viewing = new Viewing(this.#host, session, runtime, settings, {
      levelUp,
      dome,
      star,
      line,
      ring: this.#ring,
      confirm: this.#confirm,
      closed: (ring) => {
        this.#ring = ring;
        if (music !== undefined) sounds?.music.remove(music);
        closed();
      },
    });
    const menu = await viewing.start();
    return {
      menu,
      close: () => {
        viewing.leave();
      },
    };
  }
}

interface ViewingSetup {
  readonly levelUp: boolean;
  readonly dome: GpuModel;
  readonly star: GpuModel;
  readonly line: GpuModel;
  readonly ring: number;
  readonly confirm: (text: string, buttons: readonly string[]) => Promise<number>;
  readonly closed: (ring: number) => void;
}

/** The menu open: its 3D, its movie, where the player looks. */
class Viewing {
  readonly #host: MenuHost;
  readonly #session: GameSession;
  readonly #runtime: ScriptRuntime;
  readonly #settings: GameSettings;
  readonly #setup: ViewingSetup;
  readonly #camera: SkillsCamera;
  readonly #domePlayback: Playback = { sequence: 'cameraintro', start: clock() };
  readonly #trees: Tree[] = [];
  #menu: Menu | undefined;
  #scenes: GpuScene[] = [];
  #overlay: OverlayView | undefined;
  #previous: OverlayView | undefined;
  /** Where the camera turns to (degrees), and the tree looked into (undefined: the ring). */
  #targetYaw: number;
  #tree: Tree | undefined;
  #selected: PerkStar | undefined;
  /** 0 the ring, 1 up in a tree. */
  #up = 0;
  #shownYaw = Number.NaN;
  #closing = false;
  #done = false;
  #last: number | undefined;
  #asking = false;

  constructor(
    host: MenuHost,
    session: GameSession,
    runtime: ScriptRuntime,
    settings: GameSettings,
    setup: ViewingSetup,
  ) {
    this.#host = host;
    this.#session = session;
    this.#runtime = runtime;
    this.#settings = settings;
    this.#setup = setup;
    this.#camera = new SkillsCamera(settings.number('fStatsCameraFOV') ?? 50);
    this.#targetYaw = setup.ring * SKILL_ANGLE;
    this.#camera.yaw = this.#targetYaw;
    this.#camera.z = -3000;
  }

  async start(): Promise<Menu> {
    const renderer = this.#session.renderer;
    await this.#buildTrees();
    const { dome } = this.#setup;
    const identity = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const domeScene = renderer.scene.createScene([
      { model: dome, world: identity, playback: this.#domePlayback },
    ]);
    const instances: ModelInstance[] = [];
    for (const tree of this.#trees) {
      for (const star of tree.stars) {
        const world = identity.slice();
        world.set(star.place, 12);
        instances.push({
          model: this.#setup.star,
          world,
          ...(star.graph && { graph: star.graph }),
        });
      }
      for (const link of tree.lines) {
        instances.push({
          model: this.#setup.line,
          world: lineWorld(link.from.place, link.to.place),
          ...(link.graph && { graph: link.graph }),
        });
      }
    }
    this.#scenes = [domeScene, renderer.scene.createScene(instances)];
    this.#refreshStates();
    const scenes = this.#scenes;
    this.#overlay = {
      scenes: () => scenes,
      camera: this.#camera,
      lighting: () => LIGHT,
      update: (seconds) => {
        this.#update(seconds);
      },
      opaque: true,
    };
    this.#previous = renderer.overlay;
    renderer.overlay = this.#overlay;

    this.#menu = await this.#host.open('statsmenu.swf', {
      depth: STATS_DEPTH,
      interactive: true,
      cursor: false,
      onKey: (_menu, event) => this.#key(event),
      handlers: {
        // The movie's own camera animation reports its progress; the engine turns the camera.
        MoveCamera: () => undefined,
        // Faded in: its timeline has placed its clips again; they get their texts.
        SetFadedIn: (menu) => {
          void this.#showAll(menu);
        },
      },
      setup: async (menu) => {
        if (!(await menu.waitFor('_root.InitExtensions'))) return;
        menu.invoke('_root.InitExtensions');
        menu.invoke('_root.SetPlatform', 0, false);
        await this.#showAll(menu);
        // Its root timeline fades it in (and calls SetFadedIn at the end).
        menu.invoke('_root.gotoAndPlay', 'FadeIn');
      },
    });
    this.#menu.element?.addEventListener('pointermove', this.#moved);
    this.#menu.element?.addEventListener('wheel', this.#wheel, { passive: true });
    this.#menu.element?.addEventListener('pointerdown', this.#clicked);
    this.#sound('UISkillsTransitionUp');
    return this.#menu;
  }

  // --- The trees ----------------------------------------------------------------------------

  async #buildTrees(): Promise<void> {
    const runtime = this.#runtime;
    const grid: StarGrid = {
      column: this.#settings.number('fStatsStarXIncrement') ?? STAR_GRID_DEFAULTS.column,
      row:
        (this.#settings.number('fStatsStarYIncrement') ?? 15) +
        (this.#settings.number('fStatsStarZIncrement') ?? -9),
    };
    for (const [ring, skill] of RING_SKILLS.entries()) {
      const record = await runtime.forms.actorValueForm(skill);
      if (!record) continue;
      const tree = parseSkill(record);
      const stars: PerkStar[] = [];
      for (const node of tree.nodes) {
        if (node.perk === undefined) continue;
        const ranks: PerkRecord[] = [];
        for (let perk: number | undefined = node.perk; perk !== undefined && ranks.length < 10;) {
          const perkRecord = await runtime.forms.record(perk);
          if (perkRecord?.type !== 'PERK') break;
          const parsed = parsePerk(perkRecord);
          ranks.push(parsed);
          perk = parsed.next;
        }
        if (ranks.length === 0) continue;
        const graph = startObjectGraph(this.#setup.star, node.perk);
        stars.push({
          node,
          ranks,
          place: starPlace(tree, node, ring, grid),
          graph,
          state: 'locked',
          owned: 0,
        });
      }
      const byIndex = new Map(stars.map((star) => [star.node.index, star]));
      const lines: Tree['lines'][number][] = [];
      for (const from of stars) {
        for (const child of from.node.children) {
          const to = byIndex.get(child);
          if (to) lines.push({ from, to, graph: startObjectGraph(this.#setup.line, child + 1) });
        }
      }
      const heights = stars.map((star) => star.place[2]);
      const middle =
        heights.length > 0 ? (Math.min(...heights) + Math.max(...heights)) / 2 : CAMERA_REST_Z;
      this.#trees.push({
        ring,
        skill,
        record: tree,
        description: record.text('DESC') ?? '',
        stars,
        lines,
        pitch: (Math.atan2(middle - CAMERA_REST_Z, STAR_DISTANCE) * 180) / Math.PI,
      });
    }
    await this.#updateOwnership();
  }

  /** Which perks the player owns and can take now. */
  async #updateOwnership(): Promise<void> {
    const runtime = this.#runtime;
    const player = runtime.referenceHandle(PLAYER_REF);
    for (const tree of this.#trees) {
      for (const star of tree.stars) {
        let owned = 0;
        for (const rank of star.ranks) {
          if (await runtime.actors.hasPerk(PLAYER_REF, rank.formId)) owned++;
          else break;
        }
        star.owned = owned;
      }
      for (const star of tree.stars) {
        if (star.owned >= star.ranks.length) {
          star.state = 'owned';
          continue;
        }
        // A perk follows one it is linked from in the tree (or starts the tree).
        const parents = tree.stars.filter((other) => other.node.children.includes(star.node.index));
        const linked =
          parents.length === 0 ||
          parents.some((parent) => parent.owned > 0) ||
          tree.record.nodes.some(
            (node) => node.perk === undefined && node.children.includes(star.node.index),
          );
        const next = star.ranks[star.owned];
        const meets = next !== undefined && (await runtime.conditionsHold(next.conditions, player));
        star.state = star.owned > 0 ? 'owned' : linked && meets ? 'unlocked' : 'locked';
      }
    }
  }

  /** Each star's and line's graph to its state (the selected star Selected). */
  #refreshStates(): void {
    const now = clock();
    for (const tree of this.#trees) {
      for (const star of tree.stars) {
        const event =
          star === this.#selected
            ? 'SelectedWild'
            : star.state === 'owned'
              ? 'OwnedWild'
              : star.state === 'unlocked'
                ? 'UnlockedWild'
                : 'reset';
        star.graph?.send(event, now);
      }
      for (const link of tree.lines) {
        link.graph?.send(link.from.owned > 0 && link.to.owned > 0 ? 'Unlocked' : 'reset', now);
      }
    }
  }

  // --- The movie ----------------------------------------------------------------------------

  async #showAll(menu: Menu): Promise<void> {
    menu.call('SetStatsMode', !this.#setup.levelUp, this.#runtime.perkPoints);
    // The perks' names go without their drop shadow: the Flash player draws a filtered text so
    // that it hides what lies under it on the page (here the very star the name stands at).
    for (let i = 0; i < PERK_NAMES; i++) {
      menu.set(
        `_global.StatsMenu.StatsMenuInstance.PerkName${String(i)}.PerkNameClipInstance.NameText.filters`,
        [],
      );
    }
    this.#shownYaw = Number.NaN;
    menu.call('ShowLegendaryButtonHint');
    await this.#showPlayer(menu);
    await this.#showSkills(menu);
    this.#showCard();
  }

  async #showPlayer(menu: Menu): Promise<void> {
    const runtime = this.#runtime;
    const actors = runtime.actors;
    const name = (await runtime.forms.record(0x7))?.text('FULL') ?? '';
    const race = await actors.raceOf(PLAYER_REF);
    const raceName =
      race === undefined ? '' : ((await runtime.forms.record(race))?.text('FULL') ?? '');
    const level = await actors.level(PLAYER_REF);
    const meter = async (index: number): Promise<unknown[]> => {
      const value = await actors.value(PLAYER_REF, index);
      return [Math.round(value.current), Math.round(value.max), WHITE];
    };
    menu.call(
      'SetPlayerInfo',
      name,
      String(level),
      // TODO(M11): the progress to the next level.
      0,
      raceName,
      ...(await meter(ActorValue.magicka)),
      ...(await meter(ActorValue.health)),
      ...(await meter(ActorValue.stamina)),
    );
  }

  async #showSkills(menu: Menu): Promise<void> {
    const data: unknown[] = [];
    for (const tree of this.#trees) {
      const value = await this.#runtime.actors.value(PLAYER_REF, tree.skill);
      data.push(
        Math.floor(value.current),
        tree.record.name,
        // TODO(M11): the skill's progress to its next level.
        0,
        WHITE,
        this.#runtime.state.legendary.get(tree.skill) ?? 0,
      );
    }
    menu.set('_global.StatsMenu.SkillStatsA', data);
    menu.call('UpdateSkillList', true);
    menu.call('SetDirection', this.#camera.yaw);
    menu.call('SetStatsMode', !this.#setup.levelUp, this.#runtime.perkPoints);
  }

  /** The card of the skill faced, or of the perk selected. */
  #showCard(): void {
    const menu = this.#menu;
    const tree = this.#tree ?? this.#facedTree();
    if (!menu || !tree) return;
    void this.#runtime.actors.value(PLAYER_REF, tree.skill).then((value) => {
      const level = Math.floor(value.current);
      const legendary = this.#runtime.state.legendary.get(tree.skill) ?? 0;
      const star = this.#tree ? this.#selected : undefined;
      if (!star) {
        menu.call(
          'SetDescriptionCard',
          false,
          tree.record.name,
          0,
          tree.description,
          '',
          level,
          tree.record.name,
          legendary,
        );
        return;
      }
      const rank = star.ranks[Math.min(star.owned, star.ranks.length - 1)] ?? star.ranks[0];
      const ranks =
        star.ranks.length > 1 ? ` (${String(star.owned)}/${String(star.ranks.length)})` : '';
      menu.call(
        'SetDescriptionCard',
        true,
        rank?.name ?? '',
        0,
        rank?.description ?? '',
        this.#requirements(star),
        level,
        `${rank?.name ?? ''}${ranks}`,
        legendary,
      );
    });
  }

  /** What the next rank asks: its skill level (GetBaseActorValue ≥ n) and the perks before it. */
  #requirements(star: PerkStar): string {
    const next = star.ranks[star.owned];
    if (!next) return '';
    const parts: string[] = [];
    for (const condition of next.conditions) {
      // GetBaseActorValue (277) on a skill.
      if (condition.function === 277 && typeof condition.comparand === 'number') {
        const tree = this.#trees.find((entry) => entry.skill === condition.raw1);
        if (tree) parts.push(`${tree.record.name} ${String(Math.round(condition.comparand))}`);
      }
    }
    if (parts.length === 0) return '';
    const label =
      star.owned > 0
        ? this.#settings.string('sStatsNextRank')
        : this.#settings.string('sRequirements');
    return `${label ?? ''}: ${parts.join(', ')}`;
  }

  #facedTree(): Tree | undefined {
    const ring = nearestRing(this.#targetYaw);
    return this.#trees.find((tree) => tree.ring === ring);
  }

  // --- Moving about -------------------------------------------------------------------------

  #update(seconds: number): void {
    const dt = this.#last === undefined ? 0 : Math.min(0.1, seconds - this.#last);
    this.#last = seconds;
    if (this.#done) return;
    if (this.#menu?.closed) {
      this.#finish();
      return;
    }
    const camera = this.#camera;
    // The intro brings the camera up, the outro takes it away (the dome's CameraPosition).
    const sequences = this.#setup.dome.sequences;
    const node = sequences?.objects.get('CameraPosition');
    if (this.#domePlayback.sequence !== undefined && sequences && node !== undefined) {
      const frame = playSequence(sequences, this.#domePlayback, clock());
      const z = frame?.worlds.get(node)?.[14];
      if (z !== undefined) camera.z = z;
      if (clock() - this.#domePlayback.start >= INTRO_SECONDS) {
        if (this.#closing) {
          this.#finish();
          return;
        }
        // Then the dome plays its own Idle.
        this.#domePlayback.sequence = undefined;
        camera.z = CAMERA_REST_Z;
      }
    }
    // Turning.
    const delta = this.#targetYaw - camera.yaw;
    if (Math.abs(delta) > 0.01) {
      const step = Math.sign(delta) * Math.min(Math.abs(delta), TURN_SPEED * dt);
      camera.yaw += step;
    }
    // Up into a tree, or down to the ring.
    const target = this.#tree ? 1 : 0;
    if (this.#up !== target) {
      const step = dt / PITCH_SECONDS;
      this.#up = target > this.#up ? Math.min(1, this.#up + step) : Math.max(0, this.#up - step);
    }
    const eased = this.#up * this.#up * (3 - 2 * this.#up);
    const treePitch = (this.#tree ?? this.#facedTree())?.pitch ?? RING_PITCH;
    camera.pitch = RING_PITCH + (treePitch - RING_PITCH) * eased;
    const menu = this.#menu;
    if (!menu) return;
    const shown = ((camera.yaw % 360) + 360) % 360;
    // (NaN at first: the names go where the camera looks.)
    if (!(Math.abs(shown - this.#shownYaw) <= 0.01)) {
      this.#shownYaw = shown;
      if (!this.#tree) menu.call('SetDirection', shown);
    }
    if (this.#tree && this.#up > 0.95) this.#showPerkNames(menu);
  }

  /** The perks' names where their stars are (the tree looked into). */
  #showPerkNames(menu: Menu): void {
    const tree = this.#tree;
    const canvas = document.querySelector('canvas');
    if (!tree || !canvas) return;
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    const viewProjection = this.#camera.viewProjection(aspect);
    const names: unknown[] = [];
    for (const star of tree.stars) {
      const [x, y, w] = project(viewProjection, star.place);
      if (w <= 0) continue;
      const rank = star.ranks[0];
      names.push(rank?.name ?? '', (x + 1) / 2, (1 - y) / 2);
    }
    menu.set('_global.StatsMenu.PerkNamesA', names);
    menu.invoke('_global.StatsMenu.StatsMenuInstance.UpdatePerkText', true);
  }

  #key(event: KeyboardEvent): boolean {
    if (this.#asking || this.#closing) return true;
    const code = event.code;
    const left = code === 'KeyA' || code === 'ArrowLeft';
    const right = code === 'KeyD' || code === 'ArrowRight';
    const up = code === 'KeyW' || code === 'ArrowUp';
    const down = code === 'KeyS' || code === 'ArrowDown';
    const accept = code === 'KeyE' || code === 'Enter';
    const cancel = code === 'Tab' || code === 'Escape';
    if (this.#tree) {
      if (cancel) this.#leaveTree();
      else if (accept) void this.#take();
      else if (left || right || up || down) {
        this.#move(left ? [-1, 0] : right ? [1, 0] : up ? [0, 1] : [0, -1]);
      } else return false;
      return true;
    }
    if (left || right) {
      this.#turn(left ? -1 : 1);
      return true;
    }
    if (up || accept) {
      this.#enterTree();
      return true;
    }
    if (cancel) {
      if (!event.repeat) this.leave();
      return true;
    }
    if (code === 'Space') {
      void this.#legendary();
      return true;
    }
    return false;
  }

  #turn(direction: number): void {
    this.#targetYaw =
      Math.round(this.#targetYaw / SKILL_ANGLE) * SKILL_ANGLE + direction * SKILL_ANGLE;
    this.#sound(direction > 0 ? 'UISkillsForwardSD' : 'UISkillsBackwardSD');
    this.#showCard();
  }

  readonly #moved = (event: PointerEvent): void => {
    if (this.#closing || this.#asking) return;
    if (!this.#tree) {
      // The mouse turns the ring while a button is held; it settles on the nearest skill.
      if ((event.buttons & 1) === 0 || event.movementX === 0) return;
      this.#targetYaw += event.movementX * MOUSE_DEGREES;
      this.#camera.yaw = this.#targetYaw;
      return;
    }
    const star = this.#starAt(event.clientX, event.clientY);
    if (star && star !== this.#selected) this.#select(star);
  };

  readonly #wheel = (event: WheelEvent): void => {
    if (this.#closing || this.#asking) return;
    if (event.deltaY < 0 && !this.#tree) this.#enterTree();
    else if (event.deltaY > 0 && this.#tree) this.#leaveTree();
  };

  readonly #clicked = (event: PointerEvent): void => {
    if (event.button !== 0 || this.#closing || this.#asking) return;
    if (!this.#tree) return;
    const star = this.#starAt(event.clientX, event.clientY);
    if (star) {
      this.#select(star);
      void this.#take();
    }
  };

  /** The star nearest the pointer (within a few percent of the screen). */
  #starAt(clientX: number, clientY: number): PerkStar | undefined {
    const tree = this.#tree;
    const canvas = document.querySelector('canvas');
    if (!tree || !canvas) return undefined;
    const box = canvas.getBoundingClientRect();
    const viewProjection = this.#camera.viewProjection(box.width / Math.max(1, box.height));
    let best: PerkStar | undefined;
    let bestDistance = 0.06;
    for (const star of tree.stars) {
      const [x, y, w] = project(viewProjection, star.place);
      if (w <= 0) continue;
      const px = (x + 1) / 2;
      const py = (1 - y) / 2;
      const distance = Math.hypot(
        px - (clientX - box.left) / box.width,
        py - (clientY - box.top) / box.height,
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        best = star;
      }
    }
    return best;
  }

  #enterTree(): void {
    const tree = this.#facedTree();
    if (!tree || tree.stars.length === 0) return;
    this.#targetYaw =
      tree.ring * SKILL_ANGLE + Math.round((this.#targetYaw - tree.ring * SKILL_ANGLE) / 360) * 360;
    this.#tree = tree;
    // The lowest star first.
    const first = [...tree.stars].sort((a, b) => a.place[2] - b.place[2])[0];
    this.#menu?.call('HideRing');
    this.#sound('UISkillsTransitionUp');
    if (first) this.#select(first);
    else this.#showCard();
  }

  #leaveTree(): void {
    if (!this.#tree) return;
    this.#tree = undefined;
    this.#selected = undefined;
    this.#refreshStates();
    this.#menu?.invoke('_global.StatsMenu.StatsMenuInstance.UpdatePerkText', false);
    this.#shownYaw = Number.NaN;
    this.#sound('UISkillsStopSD');
    this.#showCard();
  }

  #select(star: PerkStar): void {
    this.#selected = star;
    this.#refreshStates();
    this.#sound('UISkillsFocusSD');
    this.#showCard();
  }

  /** Moves the selection to the nearest star that way (along the tree's grid). */
  #move(direction: readonly [number, number]): void {
    const tree = this.#tree;
    const from = this.#selected;
    if (!tree || !from) return;
    const { right } = ringAxes(tree.ring);
    const along = (star: PerkStar): [number, number] => [
      star.place[0] * right[0] + star.place[1] * right[1],
      star.place[2],
    ];
    const [fx, fy] = along(from);
    let best: PerkStar | undefined;
    let bestScore = Infinity;
    for (const star of tree.stars) {
      if (star === from) continue;
      const [x, y] = along(star);
      const dx = x - fx;
      const dy = y - fy;
      const forward = dx * direction[0] + dy * direction[1];
      if (forward <= 0) continue;
      const sideways = Math.abs(dx * direction[1] - dy * direction[0]);
      const score = forward + sideways * 2;
      if (score < bestScore) {
        bestScore = score;
        best = star;
      }
    }
    if (best) this.#select(best);
    else if (direction[1] < 0) this.#leaveTree();
  }

  /** Takes the selected perk (its next rank), if it can be had and a perk point is there. */
  async #take(): Promise<void> {
    const star = this.#selected;
    const runtime = this.#runtime;
    if (!star || star.owned >= star.ranks.length) return;
    const next = star.ranks[star.owned];
    if (!next || runtime.perkPoints <= 0) return;
    const available =
      star.state === 'unlocked' ||
      (star.state === 'owned' &&
        (await runtime.conditionsHold(next.conditions, runtime.referenceHandle(PLAYER_REF))));
    if (!available) return;
    this.#asking = true;
    const answer = await this.#setup
      .confirm(this.#settings.string('sStatsPerkConfirm') ?? '', [
        this.#settings.string('sYesText') ?? 'Yes',
        this.#settings.string('sNoText') ?? 'No',
      ])
      .finally(() => {
        this.#asking = false;
      });
    if (answer !== 0 || this.#done) return;
    runtime.actors.setPerk(PLAYER_REF, next.formId, true);
    runtime.perkPoints = Math.max(0, runtime.perkPoints - 1);
    star.graph?.send('Own', clock());
    this.#sound('UISkillsPerkSelect2D');
    await this.#updateOwnership();
    this.#refreshStates();
    // (SetStatsMode keeps the count the card shows again.)
    this.#menu?.call('SetStatsMode', !this.#setup.levelUp, runtime.perkPoints);
    this.#showCard();
  }

  /** Makes the faced skill Legendary (at 100 or more): back to 15, its perks' points returned. */
  async #legendary(): Promise<void> {
    const tree = this.#facedTree();
    const runtime = this.#runtime;
    if (!tree) return;
    const value = await runtime.actors.value(PLAYER_REF, tree.skill);
    if (value.base < 100) return;
    this.#asking = true;
    const yes = this.#settings.string('sYesText') ?? 'Yes';
    const no = this.#settings.string('sNoText') ?? 'No';
    try {
      if (
        (await this.#setup.confirm(this.#settings.string('sLegendaryResetConfirm') ?? '', [
          yes,
          no,
        ])) !== 0
      )
        return;
      if (
        (await this.#setup.confirm(this.#settings.string('sLegendaryResetSecondConfirm') ?? '', [
          yes,
          no,
        ])) !== 0
      )
        return;
    } finally {
      this.#asking = false;
    }
    let returned = 0;
    for (const star of tree.stars) {
      for (const rank of star.ranks.slice(0, star.owned)) {
        runtime.actors.setPerk(PLAYER_REF, rank.formId, false);
        returned++;
      }
    }
    runtime.perkPoints += returned;
    runtime.actors.setBase(PLAYER_REF, tree.skill, LEGENDARY_LEVEL);
    runtime.state.legendary.set(tree.skill, (runtime.state.legendary.get(tree.skill) ?? 0) + 1);
    await this.#updateOwnership();
    this.#refreshStates();
    if (this.#menu) await this.#showSkills(this.#menu);
    this.#showCard();
  }

  /** Leaves the menu: the camera's outro, then it closes. */
  leave(): void {
    if (this.#closing || this.#done) return;
    this.#closing = true;
    this.#domePlayback.sequence = 'cameraoutro';
    this.#domePlayback.start = clock();
    this.#menu?.invoke('_root.gotoAndPlay', 'FadeOut');
    this.#sound('UISkillsBackwardSD');
  }

  #finish(): void {
    if (this.#done) return;
    this.#done = true;
    const renderer = this.#session.renderer;
    if (renderer.overlay === this.#overlay) renderer.overlay = this.#previous;
    for (const scene of this.#scenes) scene.destroy();
    if (this.#menu) this.#host.close(this.#menu);
    this.#menu = undefined;
    this.#setup.closed(nearestRing(this.#targetYaw));
  }

  #sound(name: string): void {
    void this.#session.sounds().then((sounds) => sounds.playNamed(name, undefined));
  }
}

/** A line from one star to another: its beam (+Y, LINE_LENGTH long) turned and scaled there. */
function lineWorld(from: Vec3, to: Vec3): Mat4 {
  const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const length = Math.hypot(d[0], d[1], d[2]) || 1;
  const y: Vec3 = [d[0] / length, d[1] / length, d[2] / length];
  // Any axis across it, then the third.
  const helper: Vec3 = Math.abs(y[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const x = normalize(cross(y, helper));
  const z = cross(x, y);
  const s = length / LINE_LENGTH;
  return Float32Array.from([
    x[0] * s,
    x[1] * s,
    x[2] * s,
    0,
    y[0] * s,
    y[1] * s,
    y[2] * s,
    0,
    z[0] * s,
    z[1] * s,
    z[2] * s,
    0,
    ...from,
    1,
  ]);
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** A point through a view-projection: clip x / w, y / w, and w. */
function project(m: Mat4, p: Vec3): [number, number, number] {
  const x = (m[0] ?? 0) * p[0] + (m[4] ?? 0) * p[1] + (m[8] ?? 0) * p[2] + (m[12] ?? 0);
  const y = (m[1] ?? 0) * p[0] + (m[5] ?? 0) * p[1] + (m[9] ?? 0) * p[2] + (m[13] ?? 0);
  const w = (m[3] ?? 0) * p[0] + (m[7] ?? 0) * p[1] + (m[11] ?? 0) * p[2] + (m[15] ?? 0);
  return w === 0 ? [0, 0, 0] : [x / w, y / w, w];
}
