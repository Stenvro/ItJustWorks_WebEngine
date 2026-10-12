// Messages between the main thread and the plugin index workers.

import type { PluginIndex } from '../formats/esm/plugin-index.ts';

/** Where a worker reads a plugin from: a File (not copied) or the dev server's URL. */
export type IndexSource =
  | { readonly kind: 'blob'; readonly blob: Blob }
  | { readonly kind: 'http'; readonly url: string; readonly size: number };

export interface IndexRequest {
  readonly id: number;
  /** For error messages only. */
  readonly name: string;
  readonly source: IndexSource;
}

export type IndexResponse =
  | { readonly id: number; readonly ok: true; readonly index: PluginIndex }
  | { readonly id: number; readonly ok: false; readonly error: string };
