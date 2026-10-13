// The Web Audio graph the game's sounds play into: one gain per sound category (SNCT), wired
// as the categories' tree up to the master, a reverb bus (the current acoustic space's REVB)
// that the sounds send into by their output model's reverb send, and the listener at the
// camera. Browsers start audio only after a user gesture: `resume` is called on the first
// click or key. Notes: docs/audio.md.

import type { Vec3 } from '../render/math.ts';
import type { Reverb, SoundCategory } from '../world/sound-records.ts';
import { reverbImpulse } from './reverb.ts';

export class AudioEngine {
  readonly context: AudioContext;
  /** Where sounds without a category play (the master category's node once known). */
  readonly master: GainNode;
  /** Sounds send into this by their reverb send; it feeds the reverb. */
  readonly reverbSend: GainNode;
  readonly #output: GainNode;
  readonly #convolver: ConvolverNode;
  readonly #categories = new Map<number, GainNode>();
  readonly #categoryData = new Map<number, SoundCategory>();
  /** The user's volume per category (settings sliders), 0–1. */
  readonly #userVolumes = new Map<number, number>();
  #reverb: Reverb | undefined;

  constructor() {
    this.context = new AudioContext({ latencyHint: 'interactive' });
    this.#output = this.context.createGain();
    this.#output.connect(this.context.destination);
    this.master = this.context.createGain();
    this.master.connect(this.#output);
    this.reverbSend = this.context.createGain();
    this.#convolver = this.context.createConvolver();
    this.#convolver.normalize = false;
    // Until an acoustic space sets one, sends go nowhere.
    this.reverbSend.connect(this.#convolver);
    this.#convolver.connect(this.master);
    this.reverbSend.gain.value = 0;
  }

  /** Starts (or continues) playback; browsers allow it after a user gesture. */
  async resume(): Promise<void> {
    if (this.context.state !== 'running') await this.context.resume();
  }

  get running(): boolean {
    return this.context.state === 'running';
  }

  /** Builds the category tree (SNCT): each category's volume, under its parent. */
  setCategories(categories: readonly SoundCategory[]): void {
    for (const category of categories) this.#categoryData.set(category.formId, category);
    for (const category of categories) this.#node(category.formId);
  }

  /** The node a sound of a category plays into (the master for unknown categories). */
  categoryNode(category: number | undefined): AudioNode {
    if (category === undefined) return this.master;
    return this.#categoryData.has(category) ? this.#node(category) : this.master;
  }

  /** A category's volume up to the master (its own × its parents' × the user's). */
  categoryVolume(category: number | undefined): number {
    let volume = 1;
    for (let at = category, guard = 0; at !== undefined && guard < 32; guard++) {
      const data = this.#categoryData.get(at);
      if (!data) break;
      const user = this.#userVolumes.get(at) ?? (data.onMenu ? data.menuVolume : 1);
      volume *= data.volume * user;
      at = data.parent;
    }
    return volume;
  }

  /** The user's volume for a category with a settings slider (0–1). */
  setUserVolume(category: number, volume: number): void {
    this.#userVolumes.set(category, volume);
    const node = this.#categories.get(category);
    const data = this.#categoryData.get(category);
    if (node && data) node.gain.value = data.volume * volume;
  }

  /** The categories with a settings slider. */
  get menuCategories(): readonly SoundCategory[] {
    return [...this.#categoryData.values()].filter((category) => category.onMenu);
  }

  /** The current acoustic space's reverb (undefined or silent: none). */
  setReverb(reverb: Reverb | undefined): void {
    if (reverb?.formId === this.#reverb?.formId) return;
    this.#reverb = reverb;
    let seed = (reverb?.formId ?? 1) >>> 0;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const impulse = reverb && reverbImpulse(reverb, this.context.sampleRate, random);
    if (!impulse) {
      this.reverbSend.gain.setTargetAtTime(0, this.context.currentTime, 0.1);
      return;
    }
    const buffer = this.context.createBuffer(2, impulse[0].length, this.context.sampleRate);
    buffer.copyToChannel(impulse[0], 0);
    buffer.copyToChannel(impulse[1], 1);
    this.#convolver.buffer = buffer;
    this.reverbSend.gain.setTargetAtTime(1, this.context.currentTime, 0.1);
  }

  /** Puts the listener at the camera (game units; Z up). */
  setListener(position: Vec3, forward: Vec3): void {
    const listener = this.context.listener;
    const time = this.context.currentTime;
    listener.positionX.setValueAtTime(position[0], time);
    listener.positionY.setValueAtTime(position[1], time);
    listener.positionZ.setValueAtTime(position[2], time);
    listener.forwardX.setValueAtTime(forward[0], time);
    listener.forwardY.setValueAtTime(forward[1], time);
    listener.forwardZ.setValueAtTime(forward[2], time);
    listener.upX.setValueAtTime(0, time);
    listener.upY.setValueAtTime(0, time);
    listener.upZ.setValueAtTime(1, time);
  }

  /** Mutes everything for a moment (loading) or brings it back. */
  setMuted(muted: boolean): void {
    this.#output.gain.setTargetAtTime(muted ? 0 : 1, this.context.currentTime, 0.05);
  }

  #node(formId: number): GainNode {
    const existing = this.#categories.get(formId);
    if (existing) return existing;
    const node = this.context.createGain();
    this.#categories.set(formId, node);
    const data = this.#categoryData.get(formId);
    const user = this.#userVolumes.get(formId) ?? (data?.onMenu ? data.menuVolume : 1);
    node.gain.value = (data?.volume ?? 1) * user;
    const parent = data?.parent;
    node.connect(
      parent !== undefined && this.#categoryData.has(parent) ? this.#node(parent) : this.master,
    );
    return node;
  }
}
