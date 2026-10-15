// Videos (Data\Video\*.bik): the intro before the main menu ([General] sIntroSequence, by
// default BGS_LOGO.BIK; a comma-separated list plays in turn, an empty one plays none) and
// Game.PlayBink. Each is converted for the browser's media player in the audio worker
// (src/audio/bink-video.ts) and plays over everything, its sound into the game's master
// volume; a key or a click skips it when it may be skipped (the intro may). Notes: docs/ui.md
// ("Videos").

import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

/** The engine's intro when the INI names none. */
const DEFAULT_INTRO = 'BGS_LOGO.BIK';

/** Keys that skip a video (the menus' Accept and Cancel, and Space). */
const SKIP_KEYS = new Set(['Escape', 'Enter', 'Space', 'Tab', 'KeyE']);

/** The videos of the intro sequence, as the INI lists them. */
export function introSequence(session: GameSession): string[] {
  return session.ini
    .text('General', 'sIntroSequence', DEFAULT_INTRO)
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

/**
 * Plays a video (its file name under Data\Video); resolves once it has ended, been skipped or
 * could not play.
 */
export async function playVideo(
  session: GameSession,
  terminal: Terminal,
  file: string,
  interruptible: boolean,
): Promise<void> {
  // Black at once: the video is converted first (a few seconds).
  const video = document.createElement('video');
  video.className = 'game-video';
  video.playsInline = true;
  document.body.append(video);
  try {
    await play(session, terminal, file, interruptible, video);
  } finally {
    video.remove();
  }
}

async function play(
  session: GameSession,
  terminal: Terminal,
  file: string,
  interruptible: boolean,
  video: HTMLVideoElement,
): Promise<void> {
  const sounds = await session.sounds();
  const path = `video\\${file.replaceAll('/', '\\').toLowerCase()}`;
  let bytes: Uint8Array | undefined;
  try {
    bytes = await sounds.loadVideo(path);
  } catch (error: unknown) {
    terminal.log(
      'ui',
      `the video ${file} does not play: ${error instanceof Error ? error.message : String(error)}`,
      'warn',
    );
    return;
  }
  if (!bytes) {
    terminal.log('ui', `the video ${file} is not in the game data`, 'warn');
    return;
  }
  const url = URL.createObjectURL(
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'video/mp4' }),
  );
  video.src = url;
  const context = sounds.engine.context;
  const source = context.createMediaElementSource(video);
  source.connect(sounds.engine.master);
  await new Promise<void>((resolve) => {
    const done = (): void => {
      window.removeEventListener('keydown', key, true);
      video.removeEventListener('pointerdown', done);
      resolve();
    };
    const key = (event: KeyboardEvent): void => {
      if (!SKIP_KEYS.has(event.code)) return;
      event.preventDefault();
      event.stopPropagation();
      done();
    };
    video.addEventListener('ended', done, { once: true });
    video.addEventListener('error', done, { once: true });
    if (interruptible) {
      window.addEventListener('keydown', key, true);
      video.addEventListener('pointerdown', done);
    }
    video.play().catch((error: unknown) => {
      terminal.log(
        'ui',
        `the video ${file} does not play: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
      done();
    });
  });
  video.pause();
  source.disconnect();
  URL.revokeObjectURL(url);
}
