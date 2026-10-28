// The sun's effects over the HDR scene before post-processing (shaders/sun-effects.wgsl): the
// weather's volumetric lighting as god rays from the light's place on the screen, gathered at a
// quarter of the resolution and added to the scene, and the weather's lens flare (LENS) as
// sprites along the sun's screen line, faded by how much of the sun is covered.

import sunShader from './shaders/sun-effects.wgsl?raw';
import { HDR_FORMAT } from './post.ts';
import type { Mat4 } from './math.ts';
import { invert } from './frustum.ts';
import { placeLensFlare, LensFlareSpriteFlag, type LensFlare } from '../world/lens-flare.ts';
import type { Rgb } from '../world/weather.ts';
import { phaseAsymmetry } from '../world/volumetric-lighting.ts';

type Vec3 = readonly [number, number, number];

/** The god rays are gathered at a quarter of the resolution. */
const RAYS_DIVISOR = 4;
/** At most this many flare sprites are drawn. */
const MAX_SPRITES = 16;
/**
 * The rays' strength per unit of the weather's (VOLI intensity × fVolumetricLightingIntensity ×
 * phase). TODO(M13): calibrated by eye against the original's froxel scattering.
 */
const RAY_SCALE = 0.25;
/** The rays' uniforms: light, colour, params, phase (4 floats each), clip to world (16). */
const RAYS_UNIFORM_FLOATS = 32;

export interface SunEffectsFrame {
  /** Towards the directional light (the sun by day, the night light by night). */
  readonly lightDirection: Vec3;
  /** The weather's volumetric lighting this frame (volumetric-lighting.ts godRays). */
  readonly rays?: {
    readonly strength: number;
    readonly color: Rgb;
    readonly decay: number;
    /** Share of the way to the light the samples reach (0..1). */
    readonly reach: number;
    /** The phase function's asymmetry (VOLI phase scattering as Henyey-Greenstein g). */
    readonly scattering?: number;
  };
  /** The sun's lens flare, with its sprites' textures by path (missing ones are not drawn). */
  readonly flare?: {
    readonly lens: LensFlare;
    readonly textures: ReadonlyMap<string, GPUTexture>;
    readonly sunDirection: Vec3;
    readonly color: Rgb;
    /** [ImageSpace] fLensFlareGlobalIntensity. */
    readonly intensity: number;
  };
}

/** Where a direction is on the screen (uv, y down) and whether it is in front. */
function projectDirection(m: Mat4, d: Vec3): { uv: [number, number]; front: boolean } {
  const x = (m[0] ?? 0) * d[0] + (m[4] ?? 0) * d[1] + (m[8] ?? 0) * d[2];
  const y = (m[1] ?? 0) * d[0] + (m[5] ?? 0) * d[1] + (m[9] ?? 0) * d[2];
  const w = (m[3] ?? 0) * d[0] + (m[7] ?? 0) * d[1] + (m[11] ?? 0) * d[2];
  if (!(w > 1e-6)) return { uv: [0.5, 0.5], front: false };
  return { uv: [(x / w + 1) / 2, (1 - y / w) / 2], front: true };
}

/** 1 on the screen, fading to 0 half a screen beyond its edges. */
function edgeFade(uv: readonly [number, number]): number {
  const outside = Math.max(Math.abs(uv[0] - 0.5), Math.abs(uv[1] - 0.5)) - 0.5;
  return Math.max(0, Math.min(1, 1 - outside * 2));
}

export class SunEffects {
  /** bVolumetricLightingEnable / bLensFlare (main.ts sets them from the INI settings). */
  rays = true;
  flare = true;
  readonly #device: GPUDevice;
  readonly #raysPipeline: GPURenderPipeline;
  readonly #addPipeline: GPURenderPipeline;
  readonly #spritePipeline: GPURenderPipeline;
  readonly #sampler: GPUSampler;
  readonly #raysUniforms: GPUBuffer;
  readonly #spriteUniforms: GPUBuffer[];
  #target: { texture: GPUTexture; groups: Map<string, GPUBindGroup> } | undefined;

  constructor(device: GPUDevice) {
    this.#device = device;
    const module = device.createShaderModule({ label: 'sun-effects', code: sunShader });
    const additive: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
    };
    const pipeline = (
      label: string,
      vertex: string,
      fragment: string,
      blend: GPUBlendState | undefined,
      topology: GPUPrimitiveTopology,
    ): GPURenderPipeline =>
      device.createRenderPipeline({
        label,
        layout: 'auto',
        vertex: { module, entryPoint: vertex },
        fragment: {
          module,
          entryPoint: fragment,
          targets: [{ format: HDR_FORMAT, ...(blend && { blend }) }],
        },
        primitive: { topology },
      });
    this.#raysPipeline = pipeline(
      'god-rays',
      'vs_fullscreen',
      'fs_rays',
      undefined,
      'triangle-list',
    );
    this.#addPipeline = pipeline(
      'god-rays-add',
      'vs_fullscreen',
      'fs_add',
      additive,
      'triangle-list',
    );
    this.#spritePipeline = pipeline(
      'lens-flare',
      'vs_sprite',
      'fs_sprite',
      additive,
      'triangle-strip',
    );
    this.#sampler = device.createSampler({
      label: 'sun-effects',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const uniforms = (label: string): GPUBuffer =>
      device.createBuffer({
        label,
        size: 48,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    this.#raysUniforms = device.createBuffer({
      label: 'god-rays',
      size: RAYS_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#spriteUniforms = Array.from({ length: MAX_SPRITES }, (_, i) =>
      uniforms(`lens-flare-${String(i)}`),
    );
  }

  /**
   * Adds the frame's rays and flare to `hdr`. `depth`: the opaque scene's depth (r32float,
   * reversed Z: 0 is the sky); `viewProj`: the camera's, without the TAA's jitter.
   */
  run(
    encoder: GPUCommandEncoder,
    hdr: GPUTexture,
    depth: GPUTexture,
    viewProj: Mat4,
    frame: SunEffectsFrame,
  ): void {
    const rays = this.rays ? frame.rays : undefined;
    if (rays && rays.strength > 0) this.#rays(encoder, hdr, depth, viewProj, frame, rays);
    const flare = this.flare ? frame.flare : undefined;
    if (flare) this.#flare(encoder, hdr, depth, viewProj, flare);
  }

  #rays(
    encoder: GPUCommandEncoder,
    hdr: GPUTexture,
    depth: GPUTexture,
    viewProj: Mat4,
    frame: SunEffectsFrame,
    rays: NonNullable<SunEffectsFrame['rays']>,
  ): void {
    const { uv, front } = projectDirection(viewProj, frame.lightDirection);
    const fade = front ? edgeFade(uv) : 0;
    if (fade <= 0) return;
    const target = this.#ensureTarget(hdr);
    const aspect = hdr.width / Math.max(1, hdr.height);
    const [lx, ly, lz] = frame.lightDirection;
    const length = Math.hypot(lx, ly, lz) || 1;
    const data = new Float32Array(RAYS_UNIFORM_FLOATS);
    data.set([lx / length, ly / length, lz / length, phaseAsymmetry(rays.scattering ?? 0)], 12);
    data.set(invert(viewProj) ?? viewProj, 16);
    data.set(
      [
        uv[0],
        uv[1],
        Math.max(0.05, Math.min(1, rays.reach)),
        rays.strength * RAY_SCALE,
        ...rays.color,
        Math.max(0, Math.min(0.999, rays.decay)),
        1 / depth.width,
        aspect,
        fade,
        0,
      ],
      0,
    );
    this.#device.queue.writeBuffer(this.#raysUniforms, 0, data);
    const group = (
      key: string,
      pipeline: GPURenderPipeline,
      entries: GPUBindGroupEntry[],
    ): GPUBindGroup => {
      let found = target.groups.get(key);
      if (!found) {
        found = this.#device.createBindGroup({
          label: key,
          layout: pipeline.getBindGroupLayout(0),
          entries,
        });
        target.groups.set(key, found);
      }
      return found;
    };
    const gather = encoder.beginRenderPass({
      label: 'god-rays',
      colorAttachments: [{ view: target.texture.createView(), loadOp: 'clear', storeOp: 'store' }],
    });
    gather.setPipeline(this.#raysPipeline);
    gather.setBindGroup(
      0,
      group(`rays:${depth.label}`, this.#raysPipeline, [
        { binding: 0, resource: { buffer: this.#raysUniforms } },
        { binding: 1, resource: this.#sampler },
        { binding: 2, resource: hdr.createView() },
        { binding: 3, resource: depth.createView() },
      ]),
    );
    gather.draw(3);
    gather.end();
    const add = encoder.beginRenderPass({
      label: 'god-rays-add',
      colorAttachments: [{ view: hdr.createView(), loadOp: 'load', storeOp: 'store' }],
    });
    add.setPipeline(this.#addPipeline);
    add.setBindGroup(
      0,
      group('add', this.#addPipeline, [
        { binding: 1, resource: this.#sampler },
        { binding: 2, resource: target.texture.createView() },
      ]),
    );
    add.draw(3);
    add.end();
  }

  #flare(
    encoder: GPUCommandEncoder,
    hdr: GPUTexture,
    depth: GPUTexture,
    viewProj: Mat4,
    flare: NonNullable<SunEffectsFrame['flare']>,
  ): void {
    const { uv, front } = projectDirection(viewProj, flare.sunDirection);
    if (!front || flare.sunDirection[2] <= 0) return;
    const forward = projectForward(viewProj);
    const cos = forward ? dot(forward, flare.sunDirection) : 1;
    const placed = placeLensFlare(
      flare.lens,
      {
        screen: uv,
        angle: (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI,
        color: flare.color,
        // Covered or not is the shader's (the depth around the sun).
        visibility: 1,
        aspect: hdr.width / Math.max(1, hdr.height),
      },
      flare.intensity,
    ).slice(0, MAX_SPRITES);
    if (placed.length === 0) return;
    const target = this.#ensureTarget(hdr);
    const pass = encoder.beginRenderPass({
      label: 'lens-flare',
      colorAttachments: [{ view: hdr.createView(), loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.#spritePipeline);
    placed.forEach((sprite, i) => {
      const texture = flare.textures.get(sprite.sprite.texture);
      const buffer = this.#spriteUniforms[i];
      if (!texture || !buffer) return;
      const shrinks = sprite.sprite.flags & LensFlareSpriteFlag.shrinksWhenOccluded ? 1 : 0;
      this.#device.queue.writeBuffer(
        buffer,
        0,
        new Float32Array([
          ...sprite.center,
          ...sprite.halfSize,
          ...sprite.color,
          sprite.opacity,
          sprite.rotation,
          shrinks,
          ...uv,
        ]),
      );
      const key = `sprite:${String(i)}:${texture.label}:${depth.label}`;
      let group = target.groups.get(key);
      if (!group) {
        group = this.#device.createBindGroup({
          label: 'lens-flare',
          layout: this.#spritePipeline.getBindGroupLayout(0),
          entries: [
            { binding: 1, resource: this.#sampler },
            { binding: 3, resource: depth.createView() },
            { binding: 4, resource: texture.createView() },
            { binding: 5, resource: { buffer } },
          ],
        });
        target.groups.set(key, group);
      }
      pass.setBindGroup(0, group);
      pass.draw(4);
    });
    pass.end();
  }

  #ensureTarget(hdr: GPUTexture): { texture: GPUTexture; groups: Map<string, GPUBindGroup> } {
    const width = Math.max(1, Math.ceil(hdr.width / RAYS_DIVISOR));
    const height = Math.max(1, Math.ceil(hdr.height / RAYS_DIVISOR));
    const old = this.#target;
    if (old?.texture.width === width && old.texture.height === height) return old;
    old?.texture.destroy();
    this.#target = {
      texture: this.#device.createTexture({
        label: 'god-rays',
        size: [width, height],
        format: HDR_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      }),
      groups: new Map(),
    };
    return this.#target;
  }
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * The view's direction from its view-projection: the world direction whose clip x and y are 0
 * (the third row's cross product of the first two, pointing where w grows).
 */
function projectForward(m: Mat4): Vec3 | undefined {
  // Rows of the matrix's 3×3 part (column-major storage).
  const row = (r: number): Vec3 => [m[r] ?? 0, m[4 + r] ?? 0, m[8 + r] ?? 0];
  const [a, b, w] = [row(0), row(1), row(3)];
  const c: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const length = Math.hypot(...c);
  if (!(length > 0)) return undefined;
  const sign = dot(c, w) >= 0 ? 1 : -1;
  return [(c[0] / length) * sign, (c[1] / length) * sign, (c[2] / length) * sign];
}
