import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { devGamedata } from './tools/dev-gamedata-plugin.ts';
import { ruffle } from './tools/ruffle-plugin.ts';

// Cross-origin isolation is required for SharedArrayBuffer (workers, WASM threads).
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// As a watcher glob: forward slashes, absolute.
const localToolFolder = fileURLToPath(new URL('./.tools', import.meta.url)).replaceAll('\\', '/');

// Hard rule 4: localhost only.
export default defineConfig({
  plugins: [devGamedata(), ruffle()],
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    headers: isolationHeaders,
    // This root's own local tool folder (nested working copies among them) is no part of the
    // app. Only this root's: a working copy that itself lives under such a folder still
    // watches its own files.
    watch: { ignored: [`${localToolFolder}/**`] },
  },
  // The app's one page: nested working copies' pages are not scanned for dependencies.
  optimizeDeps: { entries: ['index.html'] },
  preview: { host: 'localhost', port: 4173, strictPort: true, headers: isolationHeaders },
  build: { sourcemap: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tools/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
