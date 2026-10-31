// The Web Audio graph the game's sounds play into: one gain per sound category (SNCT), wired
// as the categories' tree up to the master, a reverb bus (the current acoustic space's REVB)
// that the sounds send into by their output model's reverb send, and the listener at the
// camera. Browsers start audio only after a user gesture: `resume` is called on the first
// click or key. Notes: docs/audio.md.

import type { Vec3 } from '../render/math.ts';
import type { Reverb, SoundCategory } from '../world/sound-records.ts';
import {
  heldInMenu,
  NO_CATEGORY_ROLES,
  ownMenuRule,
  timeSensitive,
  type CategoryRoles,
  type MenuAudio,
} from './category-rules.ts';
import { reverbImpulse } from './reverb.ts';
import { RumbleBuses } from './rumble-buses.ts';
import { speakerLayout, type SpeakerLayout } from './speakers.ts';

/** A reverb: its convolver and its level (crossfading with the other). */
interface ReverbSlot {
  readonly convolver: ConvolverNode;
  readonly level: GainNode;
}

export class AudioEngine {
  readonly context: AudioContext;
  /** Where sounds without a category play (the master category's node once known). */
  readonly master: GainNode;
  /** Sounds send into this by their reverb send; it feeds the reverb. */
  readonly reverbSend: GainNode;
  /** The output's speakers: stereo, 5.1 or 7.1, as many as the device takes (speakers.ts). */
  readonly layout: SpeakerLayout;
  /** The gamepad's two rumble buses (rumble.ts): the player's sounds send into them. */
  readonly rumble: RumbleBuses;
  /** The master volume ([Audio] fDefaultMasterVolume, then [AudioMenu] fAudioMasterVolume). */
  readonly #volume: GainNode;
  readonly #output: GainNode;
  #enabled = true;
  /** Two reverbs, the current one and the one it crossfades from (fReverbTransitionTime). */
  readonly #reverbs: readonly [ReverbSlot, ReverbSlot];
  #activeReverb = 0;
  readonly #categories = new Map<number, GainNode>();
  readonly #categoryData = new Map<number, SoundCategory>();
  /** The user's volume per category (settings sliders), 0–1. */
  readonly #userVolumes = new Map<number, number>();
  #reverb: Reverb | undefined;
  /** The listener is under water: categories flagged so (SNCT FNAM 0x1) are muted. */
  #submerged = false;
  /** The categories the default objects give a role (menus, Slow Time). */
  #roles: CategoryRoles = NO_CATEGORY_ROLES;
  /** A menu that pauses the game, the skills menu, the loading screen: what holds sounds. */
  #inMenu = false;
  #stats = false;
  #loading = false;
  #menuFade: { readonly out: number; readonly in: number } = { out: 0.5, in: 0.5 };
  /** Told when the held categories change (the sound system holds or frees its sounds). */
  onHoldChange: (() => void) | undefined;

  /**
   * `masterVolume`: the audio's starting master volume ([Audio] fDefaultMasterVolume; the game
   * then sets [AudioMenu] fAudioMasterVolume: setMasterVolume).
   */
  constructor(masterVolume = 1) {
    this.context = new AudioContext({ latencyHint: 'interactive' });
    // As many speakers as the device has (5.1, 7.1): the defined speaker models' rear and side
    // levels play on their own speakers; the channels go to the device as they are.
    const destination = this.context.destination;
    this.layout = speakerLayout(destination.maxChannelCount);
    if (this.layout > 2) {
      try {
        destination.channelCount = this.layout;
        destination.channelInterpretation = 'discrete';
      } catch {
        this.layout = 2;
      }
    }
    this.#output = this.context.createGain();
    this.#output.connect(destination);
    this.#volume = this.context.createGain();
    this.#volume.gain.value = masterVolume;
    this.#volume.connect(this.#output);
    this.master = this.context.createGain();
    this.master.connect(this.#volume);
    this.rumble = new RumbleBuses(this.context);
    this.reverbSend = this.context.createGain();
    // Until an acoustic space sets one, the reverbs are silent.
    const slot = (): ReverbSlot => {
      const convolver = this.context.createConvolver();
      convolver.normalize = false;
      const level = this.context.createGain();
      level.gain.value = 0;
      this.reverbSend.connect(convolver);
      convolver.connect(level);
      level.connect(this.master);
      return { convolver, level };
    };
    this.#reverbs = [slot(), slot()];
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

  /** The categories with a settings slider (the master first), in their records' order. */
  get menuCategories(): SoundCategory[] {
    return [...this.#categoryData.values()]
      .filter((category) => category.onMenu)
      .sort((a, b) => Number(a.parent !== undefined) - Number(b.parent !== undefined));
  }

  /** The user's volume for a category with a settings slider (its default until set). */
  userVolume(category: number): number {
    const data = this.#categoryData.get(category);
    return this.#userVolumes.get(category) ?? data?.menuVolume ?? 1;
  }

  /** The user's volume for a category with a settings slider (0–1). */
  setUserVolume(category: number, volume: number): void {
    this.#userVolumes.set(category, volume);
    const node = this.#categories.get(category);
    if (node) node.gain.value = this.#gainOf(category);
  }

  /** The listener goes under water or comes up (muting the categories that mute). */
  setSubmerged(submerged: boolean): void {
    if (submerged === this.#submerged) return;
    this.#submerged = submerged;
    for (const [formId, node] of this.#categories) {
      if (!this.#categoryData.get(formId)?.muteWhenSubmerged) continue;
      node.gain.setTargetAtTime(this.#gainOf(formId), this.context.currentTime, 0.05);
    }
  }

  /** The categories the default objects name for menus and Slow Time (category-rules.ts). */
  setRoles(roles: CategoryRoles): void {
    this.#roles = roles;
    for (const [formId, node] of this.#categories) node.gain.value = this.#gainOf(formId);
  }

  /** What holds sounds now. */
  get menuAudio(): MenuAudio {
    if (this.#loading) return 'loading';
    if (!this.#inMenu) return 'none';
    return this.#stats ? 'stats' : 'menu';
  }

  /**
   * The game goes into a menu that pauses it or comes out: the categories the default objects
   * pause during menus go silent and their sounds hold their place, the others (music, the
   * interface) play on. Observed in the original: the fading one (DOBJ PDMC) fades out
   * over [Audio] fMenuModeFadeOutTime seconds and back in over fMenuModeFadeInTime (`fade`),
   * the immediate one (PIMC) at once.
   */
  setInMenu(
    inMenu: boolean,
    fade: { readonly out: number; readonly in: number } = { out: 0.5, in: 0.5 },
  ): void {
    if (inMenu === this.#inMenu) return;
    this.#menuFade = fade;
    this.#changeMenu(() => (this.#inMenu = inMenu));
  }

  /** The skills menu opens or closes (it pauses as a menu does and mutes DOBJ SMSC). */
  setStatsMenu(open: boolean): void {
    if (open === this.#stats) return;
    this.#changeMenu(() => (this.#stats = open));
  }

  /** The loading screen comes up or goes (it also holds DOBJ PDLC: effects, the interface). */
  setLoading(loading: boolean): void {
    if (loading === this.#loading) return;
    this.#changeMenu(() => (this.#loading = loading));
  }

  /**
   * Whether a sound of a category is held now: undefined if not, else the seconds it plays on
   * before it holds (its category's fade out).
   */
  held(category: number | undefined): number | undefined {
    const rule = heldInMenu(category, this.#parentOf, this.#roles, this.menuAudio);
    if (rule === undefined) return undefined;
    return rule === 'fade' ? this.#menuFade.out : 0;
  }

  /** Whether the world's clock (Slow Time) slows a sound of a category (DOBJ TSSC). */
  timeSensitive(category: number | undefined): boolean {
    return timeSensitive(category, this.#parentOf, this.#roles);
  }

  readonly #parentOf = (category: number): number | undefined =>
    this.#categoryData.get(category)?.parent;

  #changeMenu(change: () => void): void {
    const before = this.menuAudio;
    change();
    const after = this.menuAudio;
    if (before === after) return;
    for (const [formId, node] of this.#categories) {
      const was = ownMenuRule(formId, this.#roles, before);
      const is = ownMenuRule(formId, this.#roles, after);
      if (was === is) continue;
      const fades = (is ?? was) === 'fade';
      this.#rampTo(
        node,
        this.#gainOf(formId),
        fades ? (is ? this.#menuFade.out : this.#menuFade.in) : 0,
      );
    }
    this.onHoldChange?.();
  }

  /** The categories turned down (decibels) and by how much: dialogue's ducking. */
  readonly #ducked = new Map<number, number>();

  /**
   * Turns categories down by `decibels` over `seconds` (a conversation ducks the non-dialogue
   * voices, DOBJ NDSC, and the effects that fade during dialogue, SFDC), or back up (0 dB).
   */
  duck(categories: readonly number[], decibels: number, seconds: number): void {
    for (const category of categories) {
      if (decibels > 0) this.#ducked.set(category, decibels);
      else this.#ducked.delete(category);
      if (this.#categoryData.has(category)) {
        this.#rampTo(this.#node(category), this.#gainOf(category), seconds);
      }
    }
  }

  /** A gain to `value` in a straight line over `seconds` (0: at once). */
  #rampTo(node: GainNode, value: number, seconds: number): void {
    const time = this.context.currentTime;
    const gain = node.gain;
    gain.cancelScheduledValues(time);
    gain.setValueAtTime(gain.value, time);
    if (seconds > 0) gain.linearRampToValueAtTime(value, time + seconds);
    else gain.setValueAtTime(value, time);
  }

  /** A category's own gain: its volume × the user's, muted under water if it mutes. */
  #gainOf(formId: number): number {
    const data = this.#categoryData.get(formId);
    if (data?.muteWhenSubmerged && this.#submerged) return 0;
    if (ownMenuRule(formId, this.#roles, this.menuAudio)) return 0;
    const user = this.#userVolumes.get(formId) ?? (data?.onMenu ? data.menuVolume : 1);
    const ducked = this.#ducked.get(formId);
    return (data?.volume ?? 1) * user * (ducked === undefined ? 1 : 10 ** (-ducked / 20));
  }

  /**
   * The current acoustic space's reverb (undefined or silent: none). Observed in the original:
   * a change of acoustic space moves to its reverb over [Audio] fReverbTransitionTime
   * (`seconds`): here the old reverb fades out as the new one fades in.
   */
  setReverb(reverb: Reverb | undefined, seconds = 0.5): void {
    if (reverb?.formId === this.#reverb?.formId) return;
    this.#reverb = reverb;
    const buffer = reverb && this.#reverbBuffer(reverb);
    const time = this.context.currentTime;
    const ramp = (level: GainNode, to: number): void => {
      level.gain.cancelScheduledValues(time);
      level.gain.setValueAtTime(level.gain.value, time);
      level.gain.linearRampToValueAtTime(to, time + Math.max(seconds, 0.01));
    };
    const old = this.#reverbs[this.#activeReverb];
    if (old) ramp(old.level, 0);
    if (!buffer) return;
    this.#activeReverb = 1 - this.#activeReverb;
    const next = this.#reverbs[this.#activeReverb];
    if (!next) return;
    next.convolver.buffer = buffer;
    ramp(next.level, 1);
  }

  /** Built reverb responses by REVB form id (null: silent), kept as spaces change back. */
  readonly #reverbBuffers = new Map<number, AudioBuffer | null>();

  #reverbBuffer(reverb: Reverb): AudioBuffer | undefined {
    let buffer = this.#reverbBuffers.get(reverb.formId);
    if (buffer === undefined) {
      let seed = reverb.formId >>> 0 || 1;
      const random = (): number => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      const impulse = reverbImpulse(reverb, this.context.sampleRate, random);
      buffer = null;
      if (impulse) {
        buffer = this.context.createBuffer(2, impulse[0].length, this.context.sampleRate);
        buffer.copyToChannel(impulse[0], 0);
        buffer.copyToChannel(impulse[1], 1);
      }
      this.#reverbBuffers.set(reverb.formId, buffer);
    }
    return buffer ?? undefined;
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
    this.#muted = muted;
    this.#output.gain.setTargetAtTime(
      muted || !this.#enabled ? 0 : 1,
      this.context.currentTime,
      0.05,
    );
  }

  #muted = false;

  /** The master volume (0–1) over every category: [AudioMenu] fAudioMasterVolume. */
  setMasterVolume(volume: number): void {
    this.#volume.gain.value = Math.max(0, volume);
  }

  /**
   * The audio on or off ([Audio] bEnableAudio: the original makes no sound at all without it).
   * Off, nothing is heard and the sound system starts no sound.
   */
  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    this.setMuted(this.#muted);
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  #node(formId: number): GainNode {
    const existing = this.#categories.get(formId);
    if (existing) return existing;
    const node = this.context.createGain();
    this.#categories.set(formId, node);
    const data = this.#categoryData.get(formId);
    node.gain.value = this.#gainOf(formId);
    const parent = data?.parent;
    node.connect(
      parent !== undefined && this.#categoryData.has(parent) ? this.#node(parent) : this.master,
    );
    return node;
  }
}
