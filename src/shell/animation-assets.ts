// What skeletal animation loads, shared by actors and animated objects: behavior projects
// (their character and every behavior file), Havok skeletons, clips (each read once), and the
// hosts through which running graphs get their clips.

import {
  AnimationDataLibrary,
  type ProjectAnimationData,
} from '../animation/animation-data-library.ts';
import type { BehaviorHost, SkeletalGraph } from '../animation/behavior-runtime.ts';
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
  /** The project's animation data (its clips' root motion), once read. */
  data: ProjectAnimationData | undefined;

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

  rootMotion(
    generator: string,
    from: number,
    to: number,
  ): ReturnType<ProjectAnimationData['rootMotionDelta']> {
    return this.data?.rootMotionDelta(generator, from, to);
  }

  /** Waits for the clips asked for so far. */
  async loaded(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all([...this.#pending]);
  }
}

/** The skeletal clips a graph (and the files it references) plays: their animations. */
function clipAnimations(behaviors: Behaviors): Set<string> {
  const seen = new Set<object>();
  const clips = new Set<string>();
  const visit = (node: BehaviorGenerator | undefined): void => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    switch (node.kind) {
      case 'clip':
        clips.add(node.animation);
        return;
      case 'state-machine':
        for (const state of node.states) visit(state.generator);
        return;
      case 'blender':
        for (const child of node.children) visit(child.generator);
        return;
      case 'manual-selector':
        for (const child of node.generators) visit(child);
        return;
      case 'bone-switch':
        visit(node.generator);
        for (const child of node.children) visit(child.generator);
        return;
      case 'offset-animation':
        visit(node.generator);
        visit(node.offsetGenerator);
        return;
      case 'modifier-generator':
      case 'state-tagging':
      case 'cyclic-blend':
      case 'synchronized-clip':
        visit(node.generator);
        return;
      default:
        return;
    }
  };
  for (const graph of [behaviors.root, ...behaviors.files.values()]) visit(graph.root);
  return clips;
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
  #animationData: Promise<AnimationDataLibrary> | undefined;

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

  /** The behavior projects' animation data (root motion, attack sets, speeds), read once. */
  animationData(): Promise<AnimationDataLibrary> {
    this.#animationData ??= AnimationDataLibrary.load((path) => this.#vfs.read(path)).then(
      (library) => {
        for (const failure of library.failures) this.#terminal.log('hkx', failure, 'warn');
        return library;
      },
    );
    return this.#animationData;
  }

  /** The clips of a project for one sex (and its animation data, once read). */
  host(behaviors: Behaviors, female: boolean): ClipHost {
    const key = `${behaviors.project}|${female ? 'f' : 'm'}`;
    let host = this.#hosts.get(key);
    if (!host) {
      const made = new ClipHost(
        behaviors,
        female,
        (path) => this.#vfs.has(path),
        (path) => this.clip(path),
      );
      void this.animationData().then((library) => {
        made.data = library.project(behaviors.project);
      });
      host = made;
      this.#hosts.set(key, host);
    }
    return host;
  }

  /**
   * An object's behavior project where its graph plays skeletal clips (traps, bows,
   * mechanisms, the book menu's books), with all its clips loaded (an object's graph has a few:
   * a clip that first loads as its state begins would play no end and raise none of its
   * events); undefined for the others.
   */
  skeletalGraph(project: string): Promise<SkeletalGraph | undefined> {
    return this.#cached(this.#skeletal, normalizePath(project), async () => {
      const behaviors = await this.behaviors(project);
      const rig = behaviors?.character.rig;
      const clips = behaviors ? clipAnimations(behaviors) : new Set<string>();
      if (!behaviors || !rig || clips.size === 0) return undefined;
      const havok = await this.havokSkeleton(rig);
      if (!havok) return undefined;
      const host = this.host(behaviors, false);
      for (const clip of clips) host.clip(clip);
      await host.loaded();
      return { root: behaviors.root, havok, host };
    });
  }
}
