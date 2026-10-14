// What skeletal animation loads, shared by actors and animated objects: behavior projects
// (their character and every behavior file), Havok skeletons, clips (each read once), and the
// hosts through which running graphs get their clips.

import {
  BehaviorRuntime,
  type BehaviorHost,
  type SkeletalGraph,
} from '../animation/behavior-runtime.ts';
import {
  readAnimationContainer,
  type AnimationBinding,
  type HkxSkeleton,
} from '../formats/hkx/animation.ts';
import {
  loadBehaviorFiles,
  loadCharacterInfo,
  readHavokFile,
  projectRelative,
  type BehaviorGenerator,
  type BehaviorGraph,
  type CharacterInfo,
} from '../formats/hkx/behavior.ts';
import { Packfile } from '../formats/hkx/packfile.ts';
import { normalizePath } from '../formats/paths.ts';
import type { Vfs } from '../vfs/vfs.ts';
import type { Terminal } from './terminal.ts';

/** A behavior project, read once: its character and every behavior file. */
export interface Behaviors {
  readonly project: string;
  readonly character: CharacterInfo;
  readonly root: BehaviorGraph;
  readonly files: ReadonlyMap<string, BehaviorGraph>;
}

/**
 * The clips of a project for one sex, shared by its graphs: loaded when a graph first asks
 * for one (the female clip where a female one exists).
 */
export class ClipHost implements BehaviorHost {
  readonly #behaviors: Behaviors;
  readonly #female: boolean;
  readonly #load: (path: string) => Promise<AnimationBinding | undefined>;
  readonly #has: (path: string) => boolean;
  readonly #clips = new Map<string, AnimationBinding | undefined>();
  readonly #pending = new Set<Promise<unknown>>();

  constructor(
    behaviors: Behaviors,
    female: boolean,
    has: (path: string) => boolean,
    load: (path: string) => Promise<AnimationBinding | undefined>,
  ) {
    this.#behaviors = behaviors;
    this.#female = female;
    this.#has = has;
    this.#load = load;
  }

  clip(animation: string): AnimationBinding | undefined {
    const key = animation.toLowerCase();
    if (this.#clips.has(key)) return this.#clips.get(key);
    this.#clips.set(key, undefined);
    const path = projectRelative(this.#behaviors.project, animation);
    const own = this.#female ? path.replace(/\\male\\/, '\\female\\') : path;
    const loading = this.#load(this.#has(own) ? own : path).then((binding) => {
      this.#clips.set(key, binding);
    });
    this.#pending.add(loading);
    void loading.finally(() => this.#pending.delete(loading));
    return undefined;
  }

  behavior(name: string): BehaviorGraph | undefined {
    return this.#behaviors.files.get(projectRelative(this.#behaviors.project, name));
  }

  /** Waits for the clips asked for so far. */
  async loaded(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all([...this.#pending]);
  }
}

/** Whether a graph (or a file it references) plays skeletal clips. */
function playsClips(behaviors: Behaviors): boolean {
  const seen = new Set<object>();
  const visit = (node: BehaviorGenerator | undefined): boolean => {
    if (!node || seen.has(node)) return false;
    seen.add(node);
    switch (node.kind) {
      case 'clip':
        return true;
      case 'state-machine':
        return node.states.some((state) => visit(state.generator));
      case 'blender':
        return node.children.some((child) => visit(child.generator));
      case 'manual-selector':
        return node.generators.some((child) => visit(child));
      case 'bone-switch':
        return visit(node.generator) || node.children.some((child) => visit(child.generator));
      case 'offset-animation':
        return visit(node.generator) || visit(node.offsetGenerator);
      case 'modifier-generator':
      case 'state-tagging':
      case 'cyclic-blend':
      case 'synchronized-clip':
        return visit(node.generator);
      default:
        return false;
    }
  };
  return [behaviors.root, ...behaviors.files.values()].some((graph) => visit(graph.root));
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Loads and keeps what skeletal animation needs. */
export class AnimationAssets {
  readonly #vfs: Vfs;
  readonly #terminal: Terminal;
  readonly #skeletons = new Map<string, Promise<HkxSkeleton | undefined>>();
  readonly #clips = new Map<string, Promise<AnimationBinding | undefined>>();
  readonly #behaviors = new Map<string, Promise<Behaviors | undefined>>();
  readonly #skeletal = new Map<string, Promise<SkeletalGraph | undefined>>();
  readonly #hosts = new Map<string, ClipHost>();

  constructor(vfs: Vfs, terminal: Terminal) {
    this.#vfs = vfs;
    this.#terminal = terminal;
  }

  #cached<K, V>(
    map: Map<K, Promise<V | undefined>>,
    key: K,
    load: () => Promise<V | undefined>,
  ): Promise<V | undefined> {
    let entry = map.get(key);
    if (!entry) {
      entry = load().catch((error: unknown) => {
        this.#terminal.log('hkx', `${String(key)}: ${describe(error)}`, 'warn');
        return undefined;
      });
      map.set(key, entry);
    }
    return entry;
  }

  /** A Havok skeleton (a character's rig). */
  havokSkeleton(path: string): Promise<HkxSkeleton | undefined> {
    return this.#cached(this.#skeletons, path, async () => {
      const container = readAnimationContainer(
        Packfile.parse(await readHavokFile(path, (file) => this.#vfs.read(file))),
      );
      const skeleton = container.skeletons[0];
      if (!skeleton) throw new Error('no skeleton');
      return skeleton;
    });
  }

  /** A clip, read once. */
  clip(path: string): Promise<AnimationBinding | undefined> {
    return this.#cached(this.#clips, path, async () => {
      const container = readAnimationContainer(
        Packfile.parse(await readHavokFile(path, (file) => this.#vfs.read(file))),
      );
      const binding = container.bindings[0];
      if (!binding) throw new Error('no animation');
      return binding;
    });
  }

  /** A behavior project: its character and every behavior file it plays. */
  behaviors(project: string): Promise<Behaviors | undefined> {
    return this.#cached(this.#behaviors, normalizePath(project), async () => {
      const read = (path: string): Promise<Uint8Array> => this.#vfs.read(path);
      const character = await loadCharacterInfo(project, read);
      if (!character.behavior) throw new Error('character without a behavior file');
      const { root, files } = await loadBehaviorFiles(project, character.behavior, read);
      return { project: normalizePath(project), character, root, files };
    });
  }

  /** The clips of a project for one sex. */
  host(behaviors: Behaviors, female: boolean): ClipHost {
    const key = `${behaviors.project}|${female ? 'f' : 'm'}`;
    let host = this.#hosts.get(key);
    if (!host) {
      host = new ClipHost(
        behaviors,
        female,
        (path) => this.#vfs.has(path),
        (path) => this.clip(path),
      );
      this.#hosts.set(key, host);
    }
    return host;
  }

  /**
   * An object's behavior project where its graph plays skeletal clips (traps, bows,
   * mechanisms), with the clips of its start states loaded; undefined for the others.
   */
  skeletalGraph(project: string): Promise<SkeletalGraph | undefined> {
    return this.#cached(this.#skeletal, normalizePath(project), async () => {
      const behaviors = await this.behaviors(project);
      const rig = behaviors?.character.rig;
      if (!behaviors || !rig || !playsClips(behaviors)) return undefined;
      const havok = await this.havokSkeleton(rig);
      if (!havok) return undefined;
      const host = this.host(behaviors, false);
      // A run to its start pose asks for the clips every instance starts with.
      const warmUp = new BehaviorRuntime({ root: behaviors.root, host, skeleton: havok });
      warmUp.update(0);
      await host.loaded();
      warmUp.update(0);
      await host.loaded();
      return { root: behaviors.root, havok, host };
    });
  }
}
