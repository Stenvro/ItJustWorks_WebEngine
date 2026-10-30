// The sun's effects over the HDR scene before post-processing: the weather's volumetric
// lighting as the original's froxel volume (volumetric-volume.ts), and the weather's lens flare
// (LENS, shaders/sun-effects.wgsl) as sprites along the sun's screen line, faded by how much of
// the sun is covered.

import sunShader from './shaders/sun-effects.wgsl?raw';
import { HDR_FORMAT } from './post.ts';
import type { Mat4 } from './math.ts';
import { placeLensFlare, LensFlareSpriteFlag, type LensFlare } from '../world/lens-flare.ts';
import type { Rgb } from '../world/weather.ts';
import { phaseAsymmetry } from '../world/volumetric-lighting.ts';
import { VolumetricVolume, type VolumeShadows } from './volumetric-volume.ts';

type Vec3 = readonly [number, number, number];

/** At most this many flare sprites are drawn. */
const MAX_SPRITES = 16;
/**
 * The scattered light per unit of the weather's strength (VOLI intensity ×
 * fVolumetricLightingIntensity) and phase: a dawn's 4 × 2 adds about a tenth of the light's
 * colour to open air towards the sun, a day's less (the original's scattering is a faint haze
 * with shafts, never a glare). TODO(M13): the original's scale of its scattered light (its
 * composite shader's terms are unread).
 */
const RAY_SCALE = 0.05;

export interface SunEffectsFrame {
  /** Towards the directional light (the sun by day, the night light by night). */
  readonly lightDirection: Vec3;
  /** The weather's volumetric lighting this frame (volumetric-lighting.ts godRays). */
  readonly rays?: {
    readonly strength: number;
    readonly color: Rgb;
    /** The phase function's asymmetry g (VOLI phase scattering). */
    readonly scattering?: number;
    /** The phase function's share against even scattering (VOLI phase contribution). */
    readonly phaseContribution?: number;
    /** VOLI's density noise: its share, size (world units), wind and falling speed. */
    readonly densityContribution?: number;
    readonly densitySize?: number;
    readonly windSpeed?: number;
    readonly fallingSpeed?: number;
    /** VOLI's range factor: how the volume's slices spread along the view (40 in vanilla). */
    readonly rangeFactor?: number;
    /** The weather's wind on the ground: its direction (unit) times its speed (0..1). */
    readonly wind?: readonly [number, number];
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

export class SunEffects {
  /** bVolumetricLightingEnable / bLensFlare (main.ts sets them from the INI settings). */
  rays = true;
  flare = true;
  /** The volumetric lighting's froxel volume ([Display] quality and temporal settings on it). */
  readonly volume: VolumetricVolume;
  readonly #device: GPUDevice;
  readonly #spritePipeline: GPURenderPipeline;
  readonly #sampler: GPUSampler;
  readonly #spriteUniforms: GPUBuffer[];
  #target: SunTarget | undefined;
  readonly #textureIds = new WeakMap<GPUTexture, number>();
  #nextTextureId = 0;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.volume = new VolumetricVolume(device);
    const module = device.createShaderModule({ label: 'sun-effects', code: sunShader });
    this.#spritePipeline = device.createRenderPipeline({
      label: 'lens-flare',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_sprite' },
      fragment: {
        module,
        entryPoint: 'fs_sprite',
        targets: [
          {
            format: HDR_FORMAT,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-strip' },
    });
    this.#sampler = device.createSampler({
      label: 'sun-effects',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.#spriteUniforms = Array.from({ length: MAX_SPRITES }, (_, i) =>
      device.createBuffer({
        label: `lens-flare-${String(i)}`,
        size: 48,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
    );
  }

  /**
   * Adds the frame's volumetric lighting and flare to `hdr`. `depth`: the opaque scene's depth
   * (r32float, reversed Z: 0 is the sky); `viewProj`: the camera's, without the TAA's jitter;
   * `shadows`: the sun's shadow map and cascades (exteriors).
   */
  run(
    encoder: GPUCommandEncoder,
    hdr: GPUTexture,
    depth: GPUTexture,
    viewProj: Mat4,
    frame: SunEffectsFrame,
    shadows?: VolumeShadows,
  ): void {
    const rays = this.rays ? frame.rays : undefined;
    if (rays && rays.strength > 0) {
      this.volume.run(
        encoder,
        hdr,
        depth,
        viewProj,
        {
          lightDirection: frame.lightDirection,
          color: rays.color,
          strength: rays.strength * RAY_SCALE,
          scattering: phaseAsymmetry(rays.scattering ?? 0),
          phaseContribution: rays.phaseContribution ?? 0,
          densityContribution: rays.densityContribution ?? 0,
          densitySize: rays.densitySize ?? 0,
          windSpeed: rays.windSpeed ?? 0,
          fallingSpeed: rays.fallingSpeed ?? 0,
          rangeFactor: rays.rangeFactor ?? 0,
          wind: rays.wind ?? [0, 0],
        },
        shadows,
      );
    } else {
      this.volume.reset();
    }
    const flare = this.flare ? frame.flare : undefined;
    if (flare) this.#flare(encoder, hdr, depth, viewProj, flare);
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
    const target = this.#ensureTarget(depth);
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
      const key = `sprite:${String(i)}:${String(this.#textureId(texture))}`;
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

  /**
   * The flare's bind groups for a frame's depth texture. The groups hold views of it: when the
   * renderer makes its targets anew (a resize) they are made again (bound to a destroyed
   * texture, a group fails the frame's submit).
   */
  #ensureTarget(depth: GPUTexture): SunTarget {
    if (this.#target?.depth !== depth) this.#target = { depth, groups: new Map() };
    return this.#target;
  }

  /** A texture's number for bind group keys (a texture made anew gets a new one). */
  #textureId(texture: GPUTexture): number {
    let id = this.#textureIds.get(texture);
    if (id === undefined) {
      id = this.#nextTextureId++;
      this.#textureIds.set(texture, id);
    }
    return id;
  }
}

interface SunTarget {
  /** The depth texture the groups were made with. */
  readonly depth: GPUTexture;
  readonly groups: Map<string, GPUBindGroup>;
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
