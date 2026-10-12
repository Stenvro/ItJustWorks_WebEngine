export interface GpuContext {
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
  readonly context: GPUCanvasContext;
  readonly format: GPUTextureFormat;
}

/** WebGPU ontbreekt of de GPU voldoet niet; de gebruiker kan hier zelf iets aan doen. */
export class GpuUnavailableError extends Error {
  override readonly name = 'GpuUnavailableError';
}

/**
 * Skyrim-textures zijn BC1/BC3/BC5/BC7 en gaan zonder decodering naar de GPU.
 * Elke desktop-GPU ondersteunt dit.
 */
const REQUIRED_FEATURES: readonly GPUFeatureName[] = ['texture-compression-bc'];

export async function initGpu(canvas: HTMLCanvasElement): Promise<GpuContext> {
  if (!('gpu' in navigator)) {
    throw new GpuUnavailableError(
      'Deze browser ondersteunt geen WebGPU.\nGebruik een recente versie van Chrome of Edge.',
    );
  }

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    throw new GpuUnavailableError(
      'Geen WebGPU-adapter gevonden.\nControleer of hardwareversnelling aan staat in de browser.',
    );
  }

  const missing = REQUIRED_FEATURES.filter((feature) => !adapter.features.has(feature));
  if (missing.length > 0) {
    throw new GpuUnavailableError(`De GPU mist vereiste features: ${missing.join(', ')}.`);
  }

  const device = await adapter.requestDevice({
    label: 'skyrim-web',
    requiredFeatures: [...REQUIRED_FEATURES],
  });
  device.addEventListener('uncapturederror', (event) => {
    console.error('[WebGPU]', event.error.message);
  });

  const context = canvas.getContext('webgpu');
  if (!context) throw new GpuUnavailableError('Kon geen WebGPU-canvascontext maken.');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  return { adapter, device, context, format };
}

/**
 * Houdt de canvasresolutie gelijk aan het aantal fysieke pixels.
 * Geeft een functie terug die het observeren stopt.
 */
export function trackCanvasSize(canvas: HTMLCanvasElement, device: GPUDevice): () => void {
  const max = device.limits.maxTextureDimension2D;
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const box = entry.devicePixelContentBoxSize[0];
      const width = box ? box.inlineSize : Math.round(entry.contentRect.width * devicePixelRatio);
      const height = box ? box.blockSize : Math.round(entry.contentRect.height * devicePixelRatio);
      canvas.width = Math.max(1, Math.min(width, max));
      canvas.height = Math.max(1, Math.min(height, max));
    }
  });
  observer.observe(canvas, { box: 'device-pixel-content-box' });
  return () => {
    observer.disconnect();
  };
}
