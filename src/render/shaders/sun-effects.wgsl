// The sun's screen effects over the HDR scene (sun-effects.ts):
// - god rays (the weather's volumetric lighting): at a low resolution each pixel gathers how
//   much open sky lies between it and the light's place on the screen (the opaque scene's
//   depth tells sky from ground), fading along the way: the light's way through the air, cut
//   into shafts by what stands in front of the sky. That share, times the air in front of the
//   pixel and the phase function, lights the air in the light's colour; then added to the
//   scene. It does not depend on how bright the sky is (the original's scattering is lit by
//   the light, not by the sky);
// - the lens flare's sprites, added along the sun's screen line, faded by how much of the sun
//   the scene covers (the depth around it, read in the vertex shader).

struct Rays {
  // The light's place (uv, may be off the screen), samples' reach, strength.
  light: vec4f,
  // Colour (rgb) and the decay per sample.
  color: vec4f,
  // 1 / the depth texture's size, the screen's aspect, a visibility fade (0..1), the phase
  // function's share against even scattering (VOLI phase contribution).
  params: vec4f,
  // Towards the light (xyz), the phase function's asymmetry g (w).
  phase: vec4f,
  // Clip space back to world space (the view ray of a pixel).
  inverseViewProj: mat4x4f,
};

const RAY_SAMPLES: i32 = 32;
/**
 * The depth of air that lights fully: nearer surfaces have less air in front of them. The
 * shadow distance ([Display] fShadowDistance), as far as the original's volume is lit by the
 * shadow map. TODO(M13): the original's depth distribution of its volume (range factor).
 */
const AIR_DISTANCE: f32 = 8000.0;

@group(0) @binding(0) var<uniform> rays: Rays;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var scene: texture_2d<f32>;
@group(0) @binding(3) var depth: texture_2d<f32>;

struct FullscreenOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_fullscreen(@builtin(vertex_index) index: u32) -> FullscreenOut {
  let x = f32((index << 1u) & 2u);
  let y = f32(index & 2u);
  var out: FullscreenOut;
  out.position = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
  out.uv = vec2f(x, y);
  return out;
}

/** The opaque scene's depth at a uv (reversed Z: 0 is the sky). */
fn depthAt(uv: vec2f) -> f32 {
  let size = vec2f(textureDimensions(depth));
  let texel = vec2i(clamp(uv, vec2f(0.0), vec2f(0.999999)) * size);
  return textureLoad(depth, texel, 0).r;
}

/** 1 where the sky is seen at a uv (nothing opaque in front), else 0. */
fn skyOpen(uv: vec2f) -> f32 {
  return select(0.0, 1.0, depthAt(uv) <= 0.0);
}

fn worldAt(ndc: vec2f, d: f32) -> vec3f {
  let p = rays.inverseViewProj * vec4f(ndc, d, 1.0);
  return p.xyz / p.w;
}

// The view ray through a uv (two points of it: at the near plane and at twice its distance,
// reversed Z).
fn viewRay(uv: vec2f) -> vec3f {
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  return normalize(worldAt(ndc, 0.5) - worldAt(ndc, 1.0));
}

/** The share of a full depth of air in front of a uv's surface (1 for the sky). */
fn airShare(uv: vec2f) -> f32 {
  let d = depthAt(uv);
  if (d <= 0.0) {
    return 1.0;
  }
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  return clamp(distance(worldAt(ndc, d), worldAt(ndc, 1.0)) / AIR_DISTANCE, 0.0, 1.0);
}

// The original's phase function mixed with even scattering by the phase contribution
// (volumetric-lighting.ts godRayPhase).
fn rayPhase(uv: vec2f) -> f32 {
  let g = rays.phase.w;
  let cosAngle = clamp(dot(viewRay(uv), rays.phase.xyz), -1.0, 1.0);
  let phase = (1.0 - g * g) / max(4.0 * 3.14159265 * (1.0 - g * cosAngle), 1e-6);
  return mix(1.0, phase, rays.params.w);
}

@fragment
fn fs_rays(in: FullscreenOut) -> @location(0) vec4f {
  let toLight = rays.light.xy - in.uv;
  let step = toLight * (rays.light.z / f32(RAY_SAMPLES));
  // Interleaved start offsets hide the banding of the few samples.
  let jitter = fract(52.9829189 * fract(dot(in.position.xy, vec2f(0.06711056, 0.00583715))));
  var uv = in.uv + step * jitter;
  var weight = 1.0;
  var sum = 0.0;
  var total = 0.0;
  for (var i = 0; i < RAY_SAMPLES; i++) {
    sum += skyOpen(uv) * weight;
    total += weight;
    weight *= rays.color.w;
    uv += step;
  }
  // How much light reaches the air in front of the pixel, scattered towards the eye by the
  // weather's phase function (VOLI phase scattering and contribution).
  let shafts = sum / max(total, 1e-4);
  let light = shafts * airShare(in.uv) * rayPhase(in.uv) * rays.light.w * rays.params.z;
  return vec4f(light * rays.color.rgb, 1.0);
}

@fragment
fn fs_add(in: FullscreenOut) -> @location(0) vec4f {
  return vec4f(textureSampleLevel(scene, linearSampler, in.uv, 0.0).rgb, 1.0);
}

// --- Lens flare sprites ---

struct Sprite {
  // Centre (uv), half size (uv).
  place: vec4f,
  // Colour (rgb) and opacity.
  color: vec4f,
  // Rotation (radians), shrinks when covered (0/1), the sun's uv.
  params: vec4f,
};

@group(0) @binding(5) var<uniform> sprite: Sprite;
@group(0) @binding(4) var spriteTexture: texture_2d<f32>;

struct SpriteOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
};

/** How much of the sun is seen: the share of sky in a small grid of depth texels around it. */
fn sunVisibility(sun: vec2f) -> f32 {
  let size = vec2f(textureDimensions(depth));
  var seen = 0.0;
  for (var y = -2; y <= 2; y++) {
    for (var x = -2; x <= 2; x++) {
      let uv = sun + vec2f(f32(x), f32(y)) * vec2f(0.004 / (size.x / size.y), 0.004);
      if (all(uv >= vec2f(0.0)) && all(uv < vec2f(1.0))) {
        let d = textureLoad(depth, vec2i(uv * size), 0).r;
        seen += select(0.0, 1.0, d <= 0.0);
      }
    }
  }
  return seen / 25.0;
}

@vertex
fn vs_sprite(@builtin(vertex_index) index: u32) -> SpriteOut {
  let corner = vec2f(f32(index & 1u), f32((index >> 1u) & 1u)) * 2.0 - 1.0;
  let visible = sunVisibility(sprite.params.zw);
  let scale = select(1.0, visible, sprite.params.y > 0.5);
  let c = cos(sprite.params.x);
  let s = sin(sprite.params.x);
  let local = corner * sprite.place.zw * scale;
  let turned = vec2f(local.x * c - local.y * s, local.x * s + local.y * c);
  let uv = sprite.place.xy + turned;
  var out: SpriteOut;
  out.position = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  out.uv = corner * 0.5 + 0.5;
  out.color = vec4f(sprite.color.rgb, sprite.color.a * visible);
  return out;
}

@fragment
fn fs_sprite(in: SpriteOut) -> @location(0) vec4f {
  let texel = textureSampleLevel(spriteTexture, linearSampler, in.uv, 0.0);
  return vec4f(texel.rgb * texel.a * in.color.rgb * in.color.a, 1.0);
}
