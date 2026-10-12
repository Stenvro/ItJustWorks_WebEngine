import type { ModelViewer } from './shell/model-viewer.ts';

declare global {
  interface Window {
    /** Development builds only: handles for automated checks from the browser console. */
    skyrimDev?: { readonly viewer: ModelViewer };
  }
}
