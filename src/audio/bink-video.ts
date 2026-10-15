// Bink videos (Data\Video\*.bik: the intro's logo, Game.PlayBink) for the browser's media
// player: ffmpeg.wasm decodes Bink (binkvideo, binkaudio_dct) and makes an MP4 (H.264 and AAC)
// that a <video> element plays. Only the first audio track is kept (BGS_Logo.bik has two
// stereo ones; TODO(M13): what the second is for). The logo (6.9 s, 1920 × 1080) takes about
// 3 s. Platform-independent: the core is given. Notes: docs/ui.md ("Videos").

import type { FfmpegCore } from './xwma-decoder.ts';

let sequence = 0;

export function transcodeBink(core: FfmpegCore, bytes: Uint8Array): Uint8Array {
  const id = String(sequence++);
  const input = `video${id}.bik`;
  const output = `video${id}.mp4`;
  const errors: string[] = [];
  core.setLogger((event) => {
    if (event.type === 'stderr' && /error|invalid/i.test(event.message)) errors.push(event.message);
  });
  core.FS.writeFile(input, bytes);
  try {
    core.exec(
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      input,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      output,
    );
    const result = core.ret;
    core.reset();
    if (result !== 0) {
      throw new Error(
        `ffmpeg could not convert the video (${String(result)}): ${errors.join('; ')}`,
      );
    }
    const file = core.FS.readFile(output);
    core.FS.unlink(output);
    return file;
  } finally {
    core.FS.unlink(input);
  }
}
