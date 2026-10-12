// Vite dev-server plugin: serves the local game data read-only on /@gamedata/ so the app
// (and automated browser checks) can mount it without the folder picker.
// Dev server only, bound to localhost (hard rule 4); never part of a build.
//
//   GET /@gamedata/list           JSON: files under Data with sizes
//   GET /@gamedata/data/<path>    a file under Data (supports Range requests)
//   GET /@gamedata/root/<name>    a file in the install folder (Skyrim.ccc, ...)

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin } from 'vite';
import { GAME_ROOT_DIR, GAMEDATA_DIR, hasGamedata } from './gamedata-path.ts';

const PREFIX = '/@gamedata/';
const IGNORED = /^shadercache([\\/]|$)/i;

/** Resolves `relative` inside `base`; undefined if it would escape it. */
function inside(base: string, relative: string): string | undefined {
  const resolved = path.resolve(base, relative);
  return resolved.startsWith(path.resolve(base) + path.sep) ? resolved : undefined;
}

async function listing(): Promise<{ path: string; size: number }[]> {
  const entries = await readdir(GAMEDATA_DIR, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  return Promise.all(
    files
      .map((entry) => path.relative(GAMEDATA_DIR, path.join(entry.parentPath, entry.name)))
      .filter((relative) => !IGNORED.test(relative))
      .map(async (relative) => ({
        path: relative.replaceAll('\\', '/'),
        size: (await stat(path.join(GAMEDATA_DIR, relative))).size,
      })),
  );
}

async function sendFile(
  file: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const { size } = await stat(file);
  const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Content-Type', 'application/octet-stream');
  response.setHeader('Cache-Control', 'no-store');
  if (range) {
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), size - 1);
    if (start > end) {
      response.statusCode = 416;
      response.end();
      return;
    }
    response.statusCode = 206;
    response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    response.setHeader('Content-Length', end - start + 1);
    createReadStream(file, { start, end }).pipe(response);
    return;
  }
  response.setHeader('Content-Length', size);
  createReadStream(file).pipe(response);
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = decodeURIComponent((request.url ?? '').split('?')[0] ?? '');
  const rest = url.slice(PREFIX.length);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.statusCode = 405;
    response.end();
    return;
  }
  if (rest === 'list') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(await listing()));
    return;
  }
  const [area, ...parts] = rest.split('/');
  const base = area === 'data' ? GAMEDATA_DIR : area === 'root' ? GAME_ROOT_DIR : undefined;
  const file = base === undefined ? undefined : inside(base, parts.join('/'));
  if (!file) {
    response.statusCode = 404;
    response.end();
    return;
  }
  await sendFile(file, request, response);
}

export function devGamedata(): Plugin {
  return {
    name: 'skyrim-web:dev-gamedata',
    apply: 'serve',
    configureServer(server) {
      if (!hasGamedata()) return;
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith(PREFIX)) {
          next();
          return;
        }
        handle(request, response).catch((error: unknown) => {
          response.statusCode = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
          response.end(error instanceof Error ? error.message : String(error));
        });
      });
    },
  };
}
