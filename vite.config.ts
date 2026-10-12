import { defineConfig } from 'vitest/config';
import { devGamedata } from './tools/dev-gamedata-plugin.ts';

// Cross-origin isolation is required for SharedArrayBuffer (workers, WASM threads).
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// Hard rule 4: localhost only.
export default defineConfig({
  plugins: [devGamedata()],
  server: { host: 'localhost', port: 5173, strictPort: true, headers: isolationHeaders },
  preview: { host: 'localhost', port: 4173, strictPort: true, headers: isolationHeaders },
  build: { sourcemap: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tools/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
