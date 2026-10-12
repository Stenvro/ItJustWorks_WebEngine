export interface GpuContext {
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
  readonly context: GPUCanvasContext;
  readonly format: GPUTextureFormat;
}

/** WebGPU is missing or the GPU is insufficient; the user can do something about this. */
export class GpuUnavailableError extends Error {
  override readonly name = 'GpuUnavailableError';
}

/**
 * Skyrim textures are BC1/BC3/BC5/BC7 and go to the GPU without decoding.
 * Every desktop GPU supports this.
 */
const REQUIRED_FEATURES: readonly GPUFeatureName[] = ['texture-compression-bc'];

export async function initGpu(canvas: HTMLCanvasElement): Promise<GpuContext> {
  if (!('gpu' in navigator)) {
    throw new GpuUnavailableError(
      'This browser does not support WebGPU.\nUse a recent version of Chrome or Edge.',
    );
  }

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    throw new GpuUnavailableError(
      'No WebGPU adapter found.\nCheck that hardware acceleration is enabled in the browser.',
    );
  }

  const missing = REQUIRED_FEATURES.filter((feature) => !adapter.features.has(feature));
  if (missing.length > 0) {
    throw new GpuUnavailableError(`The GPU lacks required features: ${missing.join(', ')}.`);
  }

  const device = await adapter.requestDevice({
    label: 'skyrim-web',
    requiredFeatures: [...REQUIRED_FEATURES],
  });
  device.addEventListener('uncapturederror', (event) => {
    console.error('[WebGPU]', event.error.message);
  });

  const context = canvas.getContext('webgpu');
  if (!context) throw new GpuUnavailableError('Could not create a WebGPU canvas context.');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  return { adapter, device, context, format };
}

/**
 * Keeps the canvas resolution equal to the number of physical pixels.
 * Returns a function that stops observing.
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
