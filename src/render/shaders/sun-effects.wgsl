// The sun's screen effects over the HDR scene (sun-effects.ts):
// - god rays (the weather's volumetric lighting): at a low resolution each pixel gathers the
//   sky's light seen between it and the light's place on the screen (the opaque scene's depth
//   tells sky from ground), fading along the way; then added to the scene;
// - the lens flare's sprites, added along the sun's screen line, faded by how much of the sun
//   the scene covers (the depth around it, read in the vertex shader).

struct Rays {
  // The light's place (uv, may be off the screen), samples' reach, strength.
  light: vec4f,
  // Colour (rgb) and the decay per sample.
  color: vec4f,
  // 1 / the depth texture's size, the screen's aspect, a visibility fade (0..1).
  params: vec4f,
};

const RAY_SAMPLES: i32 = 32;
/** The brightest the sky counts with (keeps the sun's disc from swamping the rays). */
const SKY_CLAMP: f32 = 4.0;

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

/** The sky's light at a uv: the scene's colour where nothing opaque is in front (depth 0). */
fn skyLight(uv: vec2f) -> vec3f {
  let size = vec2f(textureDimensions(depth));
  let texel = vec2i(clamp(uv, vec2f(0.0), vec2f(0.999999)) * size);
  let d = textureLoad(depth, texel, 0).r;
  if (d > 0.0) {
    return vec3f(0.0);
  }
  return min(textureSampleLevel(scene, linearSampler, uv, 0.0).rgb, vec3f(SKY_CLAMP));
}

@fragment
fn fs_rays(in: FullscreenOut) -> @location(0) vec4f {
  let toLight = rays.light.xy - in.uv;
  let step = toLight * (rays.light.z / f32(RAY_SAMPLES));
  // Interleaved start offsets hide the banding of the few samples.
  let jitter = fract(52.9829189 * fract(dot(in.position.xy, vec2f(0.06711056, 0.00583715))));
  var uv = in.uv + step * jitter;
  var weight = 1.0;
  var sum = vec3f(0.0);
  var total = 0.0;
  for (var i = 0; i < RAY_SAMPLES; i++) {
    sum += skyLight(uv) * weight;
    total += weight;
    weight *= rays.color.w;
    uv += step;
  }
  // Brighter towards the light (the phase function's forward scattering).
  let offset = toLight * vec2f(rays.params.y, 1.0);
  let near = 1.0 / (1.0 + dot(offset, offset) * 8.0);
  let light = sum / max(total, 1e-4) * near * rays.light.w * rays.params.z;
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
