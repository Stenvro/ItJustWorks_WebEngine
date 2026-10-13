// Loads the ffmpeg.wasm core (@ffmpeg/core, ESM build) in Node for tools and tests. The build
// is made for a web worker and reads self.location to find itself; Node gets both, and the
// WebAssembly binary is read from node_modules directly.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { FfmpegCore } from '../src/audio/xwma-decoder.ts';

let core: Promise<FfmpegCore> | undefined;

export function loadFfmpegCore(): Promise<FfmpegCore> {
  core ??= (async () => {
    const require = createRequire(import.meta.url);
    const umd = require.resolve('@ffmpeg/core');
    const esm = umd.replace(/umd([\\/])ffmpeg-core\.js$/, 'esm$1ffmpeg-core.js');
    const url = pathToFileURL(esm).href;
    const scope = globalThis as unknown as { self?: unknown; location?: unknown };
    scope.self ??= globalThis;
    scope.location ??= { href: url };
    const module = (await import(url)) as {
      default: (options: { wasmBinary: Uint8Array }) => Promise<FfmpegCore>;
    };
    return module.default({ wasmBinary: fs.readFileSync(esm.replace(/\.js$/, '.wasm')) });
  })();
  return core;
}
