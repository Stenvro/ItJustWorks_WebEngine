// The speakers a sound of a defined speaker output model (SOPM ONAM) plays on (docs/audio.md,
// "Surround output"). The model gives each input channel a level per speaker in the 7.1 order:
// front left, front right, centre, LFE, rear left, rear right, side left, side right. The
// original hands that matrix to XAudio2 for the device's speakers; here the browser's output
// has 2, 6 (5.1) or 8 (7.1) channels, and the matrix is laid on them.

/** The output's speaker layouts (the destination's channel count). */
export type SpeakerLayout = 2 | 6 | 8;

/** The layout for a destination that can take `maxChannels` channels. */
export function speakerLayout(maxChannels: number): SpeakerLayout {
  if (maxChannels >= 8) return 8;
  if (maxChannels >= 6) return 6;
  return 2;
}

/**
 * One input channel's gains (0–1) on each output channel of a layout, from its row of
 * speaker levels (0–100):
 * - 7.1 (Web Audio's discrete 8 channels, the Windows order): each level on its speaker;
 * - 5.1 (Web Audio's L R C LFE SL SR): the rear and side levels together on the surround pair;
 * - stereo: left and right, the centre at -3 dB on both, the rear and side ones on their side,
 *   the LFE dropped.
 * TODO(M13): how the original folds the rear and side levels on a device without those speakers
 * is not known (XAudio2 takes the matrix for the device's own channels).
 */
export function speakerGains(row: readonly number[] | undefined, layout: SpeakerLayout): number[] {
  const [l = 0, r = 0, c = 0, lfe = 0, rl = 0, rr = 0, sl = 0, sr = 0] = row ?? [];
  const gains =
    layout === 8
      ? [l, r, c, lfe, rl, rr, sl, sr]
      : layout === 6
        ? [l, r, c, lfe, rl + sl, rr + sr]
        : [l + c * Math.SQRT1_2 + rl + sl, r + c * Math.SQRT1_2 + rr + sr];
  return gains.map((level) => level / 100);
}
