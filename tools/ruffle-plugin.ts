// Vite plugin: serves Ruffle (the Flash player the game's Scaleform menus run in,
// @ruffle-rs/ruffle) on /ruffle/. Ruffle loads its core script and WebAssembly next to its
// own script, so its package folder is served as is: by the dev server, and copied into the
// build. Everything stays on localhost (hard rule 4).

import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

const PREFIX = '/ruffle/';
const PACKAGE = path.resolve('node_modules/@ruffle-rs/ruffle');

const TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

/** The package's files Ruffle loads (scripts and WebAssembly; no docs or licences). */
async function served(): Promise<string[]> {
  return (await readdir(PACKAGE)).filter((name) => /\.(js|wasm|map)$/.test(name));
}

export function ruffle(): Plugin {
  return {
    name: 'itjustworks-ruffle',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url ?? '';
        if (!url.startsWith(PREFIX)) {
          next();
          return;
        }
        const name = decodeURIComponent(url.slice(PREFIX.length).split('?')[0] ?? '');
        if (name.includes('/') || name.includes('\\') || name.startsWith('.')) {
          response.statusCode = 404;
          response.end();
          return;
        }
        const file = path.join(PACKAGE, name);
        stat(file).then(
          (info) => {
            if (!info.isFile()) {
              response.statusCode = 404;
              response.end();
              return;
            }
            response.setHeader(
              'Content-Type',
              TYPES[path.extname(name)] ?? 'application/octet-stream',
            );
            response.setHeader('Content-Length', info.size);
            createReadStream(file).pipe(response);
          },
          () => {
            response.statusCode = 404;
            response.end();
          },
        );
      });
    },
    async generateBundle() {
      for (const name of await served()) {
        this.emitFile({
          type: 'asset',
          fileName: `ruffle/${name}`,
          source: await readFile(path.join(PACKAGE, name)),
        });
      }
    },
  };
}
