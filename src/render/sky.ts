// Draws the sky of a SkyState with the game's sky meshes and textures: atmosphere dome,
// stars, the moons (with the masks that hide stars behind them), the sun, the weather's cloud
// layers and the sun glare, in that order, behind everything else.
// The aurora and sky statics are model scenes (src/shell/sky-objects.ts); rain and snow are
// drawn by precipitation.ts.

import { ATMOSPHERE_SAMPLES, atmosphereProfile, SKY_STRIDE, type SkyShape } from './sky-data.ts';
import { DEPTH_FORMAT, SAMPLE_COUNT } from './scene-renderer.ts';
import frameShader from './shaders/frame.wgsl?raw';
import skyShader from './shaders/sky.wgsl?raw';
import type { TextureCache } from './texture-cache.ts';
import type { SkyState, Vec3 } from '../world/sky-state.ts';
import type { Rgb } from '../world/weather.ts';

/** The sky meshes of a worldspace (atmosphere.nif, clouds.nif, the climate's stars). */
export interface SkyMeshes {
  readonly atmosphere: readonly SkyShape[];
  readonly clouds: readonly SkyShape[];
  readonly stars: readonly SkyShape[];
}

/** What the renderer needs to draw the sky this frame. */
export interface SkyFrame {
  readonly sky: GpuSky;
  readonly state: SkyState;
  /** The climate's sun and glare textures. */
  readonly sunTexture: string;
  readonly sunGlareTexture: string;
}

/** Distance of the sun and moons in sky-mesh units (fSunXExtreme; the dome's radius is 500). */
const SUN_DISTANCE = 400;
const MOON_DISTANCE = 500;
/** Uniform slots per frame (each 256 bytes): dome + 4 star shapes + 4 moon parts + 2 sun + 29 clouds. */
const MAX_DRAWS = 64;
const DRAW_SIZE = 256;
const DRAW_FLOATS = 28; // color, params, billboard, rotation

interface GpuMesh {
  readonly vertices: GPUBuffer;
  readonly indices: GPUBuffer;
  readonly indexCount: number;
  readonly texture: string;
}

/** A worldspace's sky meshes on the GPU and the textures they need. */
export class GpuSky {
  readonly atmosphere: readonly GpuMesh[];
  readonly clouds: readonly GpuMesh[];
  readonly stars: readonly GpuMesh[];
  /** ATMOSPHERE_SAMPLES × [horizon, lower, upper, alpha] weights by elevation. */
  readonly profile: Float32Array;
  readonly #textures: TextureCache;
  readonly #loaded = new Map<string, GPUTexture | undefined>();

  constructor(device: GPUDevice, meshes: SkyMeshes, textures: TextureCache) {
    const upload = (shape: SkyShape): GpuMesh => {
      const vertices = device.createBuffer({
        label: `sky-${shape.name}`,
        size: Math.max(shape.vertices.byteLength, 4),
        usage: GPUBufferUsage.VERTEX,
        mappedAtCreation: true,
      });
      new Uint8Array(vertices.getMappedRange()).set(shape.vertices);
      vertices.unmap();
      const indices = device.createBuffer({
        label: `sky-${shape.name}-indices`,
        size: Math.max(Math.ceil(shape.indices.byteLength / 4) * 4, 4),
        usage: GPUBufferUsage.INDEX,
        mappedAtCreation: true,
      });
      new Uint16Array(indices.getMappedRange()).set(shape.indices);
      indices.unmap();
      return { vertices, indices, indexCount: shape.indices.length, texture: shape.texture };
    };
    this.atmosphere = meshes.atmosphere.map(upload);
    this.clouds = meshes.clouds.map(upload);
    this.stars = meshes.stars.map(upload);
    const dome = meshes.atmosphere[0];
    this.profile = dome ? atmosphereProfile(dome) : new Float32Array(ATMOSPHERE_SAMPLES * 4);
    this.#textures = textures;
  }

  /** A loaded texture, or undefined while it loads (or if it is missing). */
  texture(path: string): GPUTexture | undefined {
    if (path === '') return undefined;
    if (!this.#loaded.has(path)) {
      this.#loaded.set(path, undefined);
      void this.#textures.get(path).then((texture) => {
        this.#loaded.set(path, texture);
      });
    }
    return this.#loaded.get(path);
  }

  /** The sky's colour at an elevation (radians), as the dome shows it. */
  colorAt(elevation: number, state: SkyState): Rgb {
    const s = Math.max(0, Math.min(1, elevation / (Math.PI / 2))) * (ATMOSPHERE_SAMPLES - 1);
    const i = Math.min(ATMOSPHERE_SAMPLES - 2, Math.floor(s));
    const t = s - i;
    const weight = (k: number): number =>
      (this.profile[i * 4 + k] ?? 0) * (1 - t) + (this.profile[(i + 1) * 4 + k] ?? 0) * t;
    const [h, l, u] = [weight(0), weight(1), weight(2)];
    const { horizon, skyLower, skyUpper } = state;
    return [
      horizon[0] * h + skyLower[0] * l + skyUpper[0] * u,
      horizon[1] * h + skyLower[1] * l + skyUpper[1] * u,
      horizon[2] * h + skyLower[2] * l + skyUpper[2] * u,
    ];
  }

  destroy(): void {
    for (const mesh of [...this.atmosphere, ...this.clouds, ...this.stars]) {
      mesh.vertices.destroy();
      mesh.indices.destroy();
    }
  }
}

type PipelineKind = 'atmosphere' | 'textured' | 'mask' | 'billboard' | 'additive';

interface DrawCall {
  readonly pipeline: PipelineKind;
  readonly mesh?: GpuMesh;
  readonly textureA: GPUTexture | undefined;
  readonly textureB: GPUTexture | undefined;
  readonly repeat: boolean;
  readonly color: readonly [number, number, number, number];
  readonly blend: number;
  readonly offset: readonly [number, number];
  readonly billboard: readonly [number, number, number, number];
  readonly rotation: Float32Array | undefined;
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Rotation by `angle` radians about `axis` (column-major 4×4). */
function axisRotation(axis: Vec3, angle: number): Float32Array {
  const length = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const [x, y, z] = [axis[0] / length, axis[1] / length, axis[2] / length];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return new Float32Array([
    t * x * x + c,
    t * x * y + s * z,
    t * x * z - s * y,
    0,
    t * x * y - s * z,
    t * y * y + c,
    t * y * z + s * x,
    0,
    t * x * z + s * y,
    t * y * z - s * x,
    t * z * z + c,
    0,
    0,
    0,
    0,
    1,
  ]);
}

export class SkyRenderer {
  readonly #device: GPUDevice;
  readonly #pipelines: Record<PipelineKind, GPURenderPipeline>;
  readonly #drawLayout: GPUBindGroupLayout;
  readonly #textureLayout: GPUBindGroupLayout;
  readonly #colorsBuffer: GPUBuffer;
  readonly #drawBuffer: GPUBuffer;
  readonly #drawBindGroup: GPUBindGroup;
  readonly #drawData = new Float32Array((MAX_DRAWS * DRAW_SIZE) / 4);
  readonly #repeatSampler: GPUSampler;
  readonly #clampSampler: GPUSampler;
  readonly #transparent: GPUTexture;
  readonly #bindGroups = new WeakMap<GPUTexture, WeakMap<GPUTexture, GPUBindGroup[]>>();

  constructor(device: GPUDevice, colorFormat: GPUTextureFormat, frameLayout: GPUBindGroupLayout) {
    this.#device = device;
    this.#drawLayout = device.createBindGroupLayout({
      label: 'sky-draw',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { hasDynamicOffset: true },
        },
      ],
    });
    this.#textureLayout = device.createBindGroupLayout({
      label: 'sky-textures',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    const layout = device.createPipelineLayout({
      label: 'sky',
      bindGroupLayouts: [frameLayout, this.#drawLayout, this.#textureLayout],
    });
    const module = device.createShaderModule({ label: 'sky', code: frameShader + skyShader });
    const alphaBlend: GPUBlendState = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    };
    const additive: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one' },
      alpha: { srcFactor: 'zero', dstFactor: 'one' },
    };
    const meshBuffers: GPUVertexBufferLayout[] = [
      {
        arrayStride: SKY_STRIDE,
        attributes: [
          { shaderLocation: 0, format: 'float32x3', offset: 0 },
          { shaderLocation: 1, format: 'float32x2', offset: 12 },
          { shaderLocation: 2, format: 'unorm8x4', offset: 20 },
        ],
      },
    ];
    const pipeline = (
      label: string,
      vertex: 'vs_mesh' | 'vs_billboard',
      fragment: string,
      blend: GPUBlendState,
    ): GPURenderPipeline =>
      device.createRenderPipeline({
        label: `sky-${label}`,
        layout,
        vertex: {
          module,
          entryPoint: vertex,
          buffers: vertex === 'vs_mesh' ? meshBuffers : [],
        },
        fragment: { module, entryPoint: fragment, targets: [{ format: colorFormat, blend }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'always' },
        multisample: { count: SAMPLE_COUNT },
      });
    this.#pipelines = {
      atmosphere: pipeline('atmosphere', 'vs_mesh', 'fs_atmosphere', alphaBlend),
      textured: pipeline('textured', 'vs_mesh', 'fs_textured', alphaBlend),
      mask: pipeline('mask', 'vs_billboard', 'fs_mask', alphaBlend),
      billboard: pipeline('billboard', 'vs_billboard', 'fs_textured', alphaBlend),
      additive: pipeline('additive', 'vs_billboard', 'fs_additive', additive),
    };
    this.#colorsBuffer = device.createBuffer({
      label: 'sky-colors',
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#drawBuffer = device.createBuffer({
      label: 'sky-draws',
      size: MAX_DRAWS * DRAW_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#drawBindGroup = device.createBindGroup({
      label: 'sky-draw',
      layout: this.#drawLayout,
      entries: [
        { binding: 0, resource: { buffer: this.#colorsBuffer } },
        { binding: 1, resource: { buffer: this.#drawBuffer, size: DRAW_FLOATS * 4 } },
      ],
    });
    const sampler = (mode: GPUAddressMode): GPUSampler =>
      device.createSampler({
        label: `sky-${mode}`,
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: mode,
        addressModeV: mode,
      });
    this.#repeatSampler = sampler('repeat');
    this.#clampSampler = sampler('clamp-to-edge');
    this.#transparent = device.createTexture({
      label: 'sky-transparent',
      format: 'rgba8unorm',
      size: [1, 1],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.#transparent },
      new Uint8Array(4),
      { bytesPerRow: 4 },
      [1, 1],
    );
  }

  createSky(meshes: SkyMeshes, textures: TextureCache): GpuSky {
    return new GpuSky(this.#device, meshes, textures);
  }

  /** Clear colour below the dome's fading edge. */
  static clearColor(state: SkyState): GPUColor {
    return { r: state.horizon[0], g: state.horizon[1], b: state.horizon[2], a: 1 };
  }

  draw(pass: GPURenderPassEncoder, frameBindGroup: GPUBindGroup, frame: SkyFrame): void {
    const calls = this.#calls(frame);
    if (calls.length === 0) return;
    const { state } = frame;
    this.#device.queue.writeBuffer(
      this.#colorsBuffer,
      0,
      new Float32Array([...state.horizon, 1, ...state.skyLower, 1, ...state.skyUpper, 1]),
    );
    const data = this.#drawData;
    calls.forEach((call, i) => {
      const o = (i * DRAW_SIZE) / 4;
      data.set(call.color, o);
      data.set([call.blend, 0, call.offset[0], call.offset[1]], o + 4);
      data.set(call.billboard, o + 8);
      data.set(call.rotation ?? IDENTITY, o + 12);
    });
    this.#device.queue.writeBuffer(this.#drawBuffer, 0, data, 0, (calls.length * DRAW_SIZE) / 4);

    pass.setBindGroup(0, frameBindGroup);
    let current: PipelineKind | undefined;
    calls.forEach((call, i) => {
      if (call.pipeline !== current) {
        pass.setPipeline(this.#pipelines[call.pipeline]);
        current = call.pipeline;
      }
      pass.setBindGroup(1, this.#drawBindGroup, [i * DRAW_SIZE]);
      pass.setBindGroup(2, this.#textures(call.textureA, call.textureB, call.repeat));
      if (call.mesh) {
        pass.setVertexBuffer(0, call.mesh.vertices);
        pass.setIndexBuffer(call.mesh.indices, 'uint16');
        pass.drawIndexed(call.mesh.indexCount);
      } else {
        pass.draw(6);
      }
    });
  }

  #textures(a: GPUTexture | undefined, b: GPUTexture | undefined, repeat: boolean): GPUBindGroup {
    const textureA = a ?? this.#transparent;
    const textureB = b ?? this.#transparent;
    let byB = this.#bindGroups.get(textureA);
    if (!byB) {
      byB = new WeakMap();
      this.#bindGroups.set(textureA, byB);
    }
    let groups = byB.get(textureB);
    if (!groups) {
      groups = [];
      byB.set(textureB, groups);
    }
    const index = repeat ? 1 : 0;
    let group = groups[index];
    if (!group) {
      group = this.#device.createBindGroup({
        label: 'sky-textures',
        layout: this.#textureLayout,
        entries: [
          { binding: 0, resource: repeat ? this.#repeatSampler : this.#clampSampler },
          { binding: 1, resource: textureA.createView() },
          { binding: 2, resource: textureB.createView() },
        ],
      });
      groups[index] = group;
    }
    return group;
  }

  #calls(frame: SkyFrame): DrawCall[] {
    const { sky, state } = frame;
    const calls: DrawCall[] = [];
    const base = {
      textureA: undefined,
      textureB: undefined,
      repeat: true,
      blend: 1,
      offset: [0, 0] as const,
      billboard: [0, 0, 1, 0] as const,
      rotation: undefined,
    };
    for (const mesh of sky.atmosphere) {
      calls.push({ ...base, pipeline: 'atmosphere', mesh, color: [1, 1, 1, 1] });
    }

    const stars = state.starsAlpha;
    if (stars > 0) {
      const rotation = axisRotation(state.starsAxis, state.starsRotation);
      for (const mesh of sky.stars) {
        const texture = sky.texture(mesh.texture);
        if (!texture) continue;
        calls.push({
          ...base,
          pipeline: 'textured',
          mesh,
          textureA: texture,
          color: [...state.starsColor, stars],
          rotation,
        });
      }
    }

    for (const moon of [state.masser, state.secunda]) {
      if (!moon.visible) continue;
      const texture = sky.texture(moon.texture);
      if (!texture) continue;
      const billboard = [...moon.direction, moon.size / 2 / MOON_DISTANCE] as const;
      const shadow = sky.texture('textures\\sky\\moonshadow.dds');
      if (shadow) {
        const elevation = Math.asin(Math.max(-1, Math.min(1, moon.direction[2])));
        calls.push({
          ...base,
          pipeline: 'mask',
          textureA: shadow,
          repeat: false,
          color: [...sky.colorAt(elevation, state), moon.alpha],
          billboard,
        });
      }
      calls.push({
        ...base,
        pipeline: 'billboard',
        textureA: texture,
        repeat: false,
        color: [1, 1, 1, moon.alpha],
        billboard,
      });
    }

    // The sun sinks behind the horizon.
    const sunAbove = Math.max(0, Math.min(1, (state.sunDirection[2] + 0.04) / 0.06));
    const sun = sky.texture(frame.sunTexture);
    if (sun && sunAbove > 0) {
      calls.push({
        ...base,
        pipeline: 'additive',
        textureA: sun,
        repeat: false,
        color: [...state.sunColor, sunAbove],
        billboard: [...state.sunDirection, state.sunSize / 2 / SUN_DISTANCE],
      });
    }

    for (const cloud of state.clouds) {
      const mesh = sky.clouds[cloud.layer];
      if (!mesh) continue;
      const textureA = sky.texture(cloud.texture);
      const textureB = sky.texture(cloud.previousTexture);
      if (!textureA && !textureB) continue;
      calls.push({
        ...base,
        pipeline: 'textured',
        mesh,
        textureA,
        textureB,
        blend: cloud.blend,
        offset: cloud.offset,
        color: [...cloud.color, cloud.alpha],
      });
    }

    const glare = sky.texture(frame.sunGlareTexture);
    if (glare && sunAbove > 0 && state.sunGlare > 0) {
      calls.push({
        ...base,
        pipeline: 'additive',
        textureA: glare,
        repeat: false,
        color: [...state.sunGlareColor, state.sunGlare * sunAbove],
        billboard: [...state.sunDirection, state.sunGlareSize / 2 / SUN_DISTANCE],
      });
    }
    return calls.slice(0, MAX_DRAWS);
  }
}
