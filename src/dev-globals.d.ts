import type { Renderer } from './render/renderer.ts';
import type { GameSession } from './shell/game-session.ts';
import type { PlayMode } from './shell/play-mode.ts';
import type { ModelViewer } from './shell/model-viewer.ts';
import type { WorldViewer } from './shell/world-viewer.ts';
import type { QaHarness } from './shell/qa/qa-harness.ts';

declare global {
  interface Window {
    /** Development builds only: handles for automated checks from the browser console. */
    engineDev?: {
      readonly viewer: ModelViewer;
      readonly world: WorldViewer;
      readonly renderer: Renderer;
      readonly device: GPUDevice;
      /** The mounted game folder's session, if any. */
      readonly session: () => GameSession | undefined;
      /** Play while it runs. */
      readonly play: () => PlayMode | undefined;
      /** The automated QA monitors (docs/qa.md), once their module has loaded. */
      qa?: QaHarness;
    };
  }
}
