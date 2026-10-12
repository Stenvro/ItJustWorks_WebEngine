import type { Renderer } from './render/renderer.ts';
import type { ModelViewer } from './shell/model-viewer.ts';
import type { WorldViewer } from './shell/world-viewer.ts';

declare global {
  interface Window {
    /** Development builds only: handles for automated checks from the browser console. */
    skyrimDev?: {
      readonly viewer: ModelViewer;
      readonly world: WorldViewer;
      readonly renderer: Renderer;
      readonly device: GPUDevice;
    };
  }
}
