import type { Renderer } from './render/renderer.ts';
import type { ModelViewer } from './shell/model-viewer.ts';

declare global {
  interface Window {
    /** Development builds only: handles for automated checks from the browser console. */
    skyrimDev?: { readonly viewer: ModelViewer; readonly renderer: Renderer };
  }
}
