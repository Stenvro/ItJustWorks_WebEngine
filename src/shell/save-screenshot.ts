// A save's screenshot, as the original keeps one with each save: the frame as drawn when the
// save is made, at [Display] iSaveGameScreenShotWidth × iSaveGameScreenShotHeight (256 × 192),
// unless [SaveGame] bOutputSaveGameScreenshot is off. The save list shows it
// (img://BGSSaveLoadHeader_Screenshot, src/shell/save-list.ts), the movie fitting it to its
// frame. An imported original save brings its own (its header's RGBA or RGB pixels).

import type { EssFile } from '../formats/ess/ess.ts';
import type { IniSettings } from '../world/ini-settings.ts';

/** The renderer's next frame at a size (Renderer.captureFrame). */
export type FrameSource = (width: number, height: number) => Promise<ImageBitmap | undefined>;

/** The screenshot's size, or undefined when saves keep none. */
export function screenshotSize(ini: IniSettings): readonly [number, number] | undefined {
  if ((ini.lookup('SaveGame', 'bOutputSaveGameScreenshot') ?? 1) === 0) return undefined;
  const width = ini.lookup('Display', 'iSaveGameScreenShotWidth') ?? 256;
  const height = ini.lookup('Display', 'iSaveGameScreenShotHeight') ?? 192;
  return width > 0 && height > 0 ? [Math.round(width), Math.round(height)] : undefined;
}

/** The frame drawn now as a save's screenshot (PNG), or an empty one without a frame. */
export async function takeScreenshot(
  frames: FrameSource | undefined,
  ini: IniSettings,
): Promise<Uint8Array> {
  const size = screenshotSize(ini);
  if (!frames || !size) return new Uint8Array();
  const frame = await frames(size[0], size[1]).catch(() => undefined);
  if (!frame) return new Uint8Array();
  const canvas = new OffscreenCanvas(frame.width, frame.height);
  canvas.getContext('2d')?.drawImage(frame, 0, 0);
  frame.close();
  return png(canvas);
}

/** An original save's screenshot (PNG), or an empty one when it has none. */
export async function essScreenshot(ess: EssFile): Promise<Uint8Array> {
  const { screenshotWidth: width, screenshotHeight: height } = ess.header;
  const pixels = ess.screenshot;
  const channels = ess.screenshotChannels;
  if (width <= 0 || height <= 0 || pixels.length < width * height * channels) {
    return new Uint8Array();
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = pixels[i * channels] ?? 0;
    rgba[i * 4 + 1] = pixels[i * channels + 1] ?? 0;
    rgba[i * 4 + 2] = pixels[i * channels + 2] ?? 0;
    // The Special Edition's fourth byte is not a coverage: the picture is opaque.
    rgba[i * 4 + 3] = 255;
  }
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')?.putImageData(new ImageData(rgba, width, height), 0, 0);
  return png(canvas);
}

async function png(canvas: OffscreenCanvas): Promise<Uint8Array> {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}
