// Compiled scripts by name, with their inheritance chain and lookup tables.

import {
  parsePex,
  type PexNamedFunction,
  type PexObject,
  type PexProperty,
  type PexScript,
} from '../formats/pex/pex.ts';

export interface LoadedScript {
  /** Lowercase name. */
  readonly name: string;
  /** Name as written in the script. */
  readonly displayName: string;
  readonly parent: LoadedScript | undefined;
  readonly object: PexObject;
  /** Functions per state (lowercase; "" is the empty state), by lowercase name. */
  readonly states: ReadonlyMap<string, ReadonlyMap<string, PexNamedFunction>>;
  readonly properties: ReadonlyMap<string, PexProperty>;
  /** Declared type of each object variable. */
  readonly variables: ReadonlyMap<string, string>;
}

/**
 * Reads a script by lowercase name: the compiled file (scripts\<name>.pex) or, for tests,
 * an already parsed script; undefined if there is none.
 */
export type ScriptLoader = (name: string) => Promise<Uint8Array | PexScript | undefined>;

export class ScriptLibrary {
  readonly #load: ScriptLoader;
  readonly #scripts = new Map<string, Promise<LoadedScript | undefined>>();
  /** Scripts that are missing or failed to parse, with the reason. */
  readonly problems = new Map<string, string>();

  constructor(load: ScriptLoader) {
    this.#load = load;
  }

  get(name: string): Promise<LoadedScript | undefined> {
    const key = name.toLowerCase();
    let pending = this.#scripts.get(key);
    if (!pending) {
      pending = this.#read(key);
      this.#scripts.set(key, pending);
    }
    return pending;
  }

  async #read(name: string): Promise<LoadedScript | undefined> {
    if (name === '') return undefined;
    try {
      const bytes = await this.#load(name);
      if (!bytes) {
        this.problems.set(name, 'missing');
        return undefined;
      }
      const object = (bytes instanceof Uint8Array ? parsePex(bytes) : bytes).objects[0];
      if (!object) {
        this.problems.set(name, 'no object');
        return undefined;
      }
      const parent = object.parent === '' ? undefined : await this.get(object.parent);
      const states = new Map<string, Map<string, PexNamedFunction>>();
      for (const state of object.states) {
        states.set(
          state.name.toLowerCase(),
          new Map(state.functions.map((fn) => [fn.name.toLowerCase(), fn])),
        );
      }
      return {
        name,
        displayName: object.name,
        parent,
        object,
        states,
        properties: new Map(object.properties.map((p) => [p.name.toLowerCase(), p])),
        variables: new Map(object.variables.map((v) => [v.name.toLowerCase(), v.type])),
      };
    } catch (error) {
      this.problems.set(name, error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }
}

/** The script and its ancestors, most derived first. */
export function chainOf(script: LoadedScript): LoadedScript[] {
  const chain: LoadedScript[] = [];
  for (let s: LoadedScript | undefined = script; s; s = s.parent) chain.push(s);
  return chain;
}

export function extendsScript(script: LoadedScript, ancestor: string): boolean {
  const name = ancestor.toLowerCase();
  return chainOf(script).some((s) => s.name === name);
}
