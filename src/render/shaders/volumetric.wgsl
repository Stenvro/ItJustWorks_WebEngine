// The volumetric lighting's froxel volume (volumetric-volume.ts), the original's passes (their
// terms observed in the original's shader cache):
// - generate: each froxel's light: how much of the sun reaches it through the first two shadow
//   cascades × the phase function × the density (the drifting noise, thinning with height);
// - raymarch: slice by slice from the camera, each column sums the froxels up to each slice;
// - composite: each pixel reads the sums at its place and depth, over the slice count × the
//   weather's intensity, dithered, then blended with the last frame's composite where that
//   pixel was (the temporal accumulation, in screen space);
// - blur: horizontal, then vertical, across the screen, held at depth edges;
// - apply: the blurred amount times the light's colour added to the scene.
// The slices are spread over the original camera's clip depth (near plane 15, far at infinity):
// slice coordinate s is at clip depth s^(1 / range factor) (volumetric-data.ts).

struct Volume {
  // Clip space back to world space (this frame's camera, without the TAA's jitter).
  inverseViewProj: mat4x4f,
  // The last frame's camera (the temporal blend's reprojection).
  previousViewProj: mat4x4f,
  // The first two shadow cascades' matrices.
  cascade0: mat4x4f,
  cascade1: mat4x4f,
  // The camera's place (xyz), our projection's near plane (w: our depth is near / distance).
  camera: vec4f,
  // Towards the light (xyz), the phase function's asymmetry g (w).
  light: vec4f,
  // The volume's width, height, slices; this frame's jitter corner (the frame index & 7).
  size: vec4f,
  // The noise's offset in world units (xyz), 0.0125 / the density size (w).
  noise: vec4f,
  // Density contribution, phase contribution, range factor, the last frame's share (0: none).
  params: vec4f,
  // The cascades' far view depths (x, y), how many cascades are lit (z), the first's bias (w).
  shadow: vec4f,
  // The light's colour (rgb); the composite's scale: the intensity over the slice count (w).
  color: vec4f,
  // 1 / the depth texture's size (xy).
  screen: vec4f,
};

/** The original camera's near plane ([Display] fNearDistance). */
const VOLUME_NEAR: f32 = 15.0;
/** The farthest a slice reaches (clip depth 1 is at infinity). */
const MAX_DISTANCE: f32 = 400000.0;
const PI: f32 = 3.14159265;

@group(0) @binding(0) var<uniform> volume: Volume;

// --- Depth slices ---

fn sliceDistance(s: f32) -> f32 {
  let d = pow(clamp(s, 0.0, 1.0), 1.0 / volume.params.z);
  if (d >= 1.0) {
    return MAX_DISTANCE;
  }
  return min(VOLUME_NEAR / (1.0 - d), MAX_DISTANCE);
}

fn distanceSlice(distance: f32) -> f32 {
  if (distance <= VOLUME_NEAR) {
    return 0.0;
  }
  return pow(1.0 - VOLUME_NEAR / distance, volume.params.z);
}

/** The world place at a uv (y down) and view distance. */
fn worldAt(uv: vec2f, distance: f32) -> vec3f {
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let p = volume.inverseViewProj * vec4f(ndc, volume.camera.w / distance, 1.0);
  return p.xyz / p.w;
}

// --- Generate ---

@group(0) @binding(1) var noiseTexture: texture_3d<f32>;
@group(0) @binding(2) var noiseSampler: sampler;
@group(0) @binding(3) var shadowMap: texture_depth_2d_array;
@group(0) @binding(4) var shadowSampler: sampler_comparison;
@group(0) @binding(6) var froxels: texture_storage_3d<r32float, write>;

/**
 * How much of the sun reaches a place: the cascade its view depth falls in (the first two;
 * beyond the last lit one: lit), one lookup, the first cascade's biased.
 */
fn sunVisibility(p: vec3f) -> f32 {
  let forward = normalize(worldAt(vec2f(0.5), 1000.0) - volume.camera.xyz);
  let depth = dot(p - volume.camera.xyz, forward);
  let count = u32(volume.shadow.z + 0.5);
  var cascade = 2u;
  if (count > 0u && depth <= volume.shadow.x) {
    cascade = 0u;
  } else if (count > 1u && depth <= volume.shadow.y) {
    cascade = 1u;
  }
  if (cascade >= 2u) {
    return 1.0;
  }
  var clip = volume.cascade1 * vec4f(p, 1.0);
  var bias = 0.0;
  if (cascade == 0u) {
    clip = volume.cascade0 * vec4f(p, 1.0);
    bias = volume.shadow.w;
  }
  let uv = vec2f(clip.x * 0.5 + 0.5, 0.5 - clip.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || clip.z > 1.0) {
    return 1.0;
  }
  return textureSampleCompareLevel(shadowMap, shadowSampler, uv, cascade, clip.z - bias);
}

/** The phase function mixed with even scattering by the phase contribution. */
fn phase(p: vec3f) -> f32 {
  let g = volume.light.w;
  let cosAngle = clamp(dot(normalize(p - volume.camera.xyz), volume.light.xyz), -1.0, 1.0);
  let hg = (1.0 - g * g) / max(4.0 * PI * (1.0 - g * cosAngle), 1e-6);
  return mix(1.0, hg, volume.params.y);
}

@compute @workgroup_size(8, 8, 1)
fn generate(@builtin(global_invocation_id) id: vec3u) {
  let size = vec3u(volume.size.xyz);
  if (any(id >= size)) {
    return;
  }
  // The froxel's corner, moved by a thousandth of the volume towards this frame's corner of a
  // unit cube (x by bit 2 of the frame index, y by bit 1, z by bit 0).
  let jitter = u32(volume.size.w + 0.5);
  let corner = vec3f(f32((jitter >> 2u) & 1u), f32((jitter >> 1u) & 1u), f32(jitter & 1u));
  let at = vec3f(id) / volume.size.xyz + corner * 0.001;
  let p = worldAt(at.xy, sliceDistance(at.z));
  // The noise thins to a quarter over the 150 units above the camera.
  let rise = saturate((p.z - volume.camera.z) / 150.0);
  let thinning = 1.0 - 0.75 * rise * rise * (3.0 - 2.0 * rise);
  let n = textureSampleLevel(noiseTexture, noiseSampler, (p + volume.noise.xyz) * volume.noise.w, 0.0).r;
  let density = mix(1.0, n * thinning, volume.params.x);
  textureStore(froxels, id, vec4f(sunVisibility(p) * phase(p) * density, 0.0, 0.0, 1.0));
}

// --- Raymarch ---

@group(0) @binding(7) var generated: texture_3d<f32>;
@group(0) @binding(8) var gathered: texture_storage_3d<r32float, write>;

@compute @workgroup_size(8, 8, 1)
fn raymarch(@builtin(global_invocation_id) id: vec3u) {
  let size = vec3u(volume.size.xyz);
  if (any(id.xy >= size.xy)) {
    return;
  }
  var sum = 0.0;
  for (var k = 0u; k < size.z; k++) {
    sum += textureLoad(generated, vec3u(id.xy, k), 0).r;
    textureStore(gathered, vec3u(id.xy, k), vec4f(sum, 0.0, 0.0, 1.0));
  }
}

// --- Composite ---

@group(0) @binding(11) var scattered: texture_3d<f32>;
@group(0) @binding(12) var sceneDepth: texture_2d<f32>;
@group(0) @binding(13) var scatteredSampler: sampler;
// The last frame's composite (r: the amount, g: its depth as VOLUME_NEAR / distance).
@group(0) @binding(14) var history: texture_2d<f32>;
@group(0) @binding(15) var historySampler: sampler;
// The dither: a 2D noise read at a pixel's place over 8 (repeating).
@group(0) @binding(16) var dither: texture_2d<f32>;

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

/** A pixel's view distance (the sky at the volume's far end). */
fn pixelDistance(uv: vec2f) -> f32 {
  let depthSize = vec2i(textureDimensions(sceneDepth));
  let pixel = clamp(vec2i(uv * vec2f(depthSize)), vec2i(0), depthSize - 1);
  let d = textureLoad(sceneDepth, pixel, 0).r;
  // Our reversed depth is near / distance (0: the sky).
  return select(MAX_DISTANCE, volume.camera.w / max(d, 1e-9), d > 0.0);
}

/** The summed light at a texel (clamped to the volume). */
fn gatheredAt(xy: vec2i, slice: i32) -> f32 {
  let size = vec3i(volume.size.xyz);
  let at = vec3i(clamp(xy, vec2i(0), size.xy - 1), clamp(slice, 0, size.z - 1));
  return textureLoad(scattered, at, 0).r;
}

/** The volume read as one filtered sample at (uv, slice coordinate), by hand. */
fn gatheredLinear(uv: vec2f, s: f32) -> f32 {
  let p = vec3f(uv, s) * volume.size.xyz - 0.5;
  let x0 = vec2i(floor(p.xy));
  let z0 = i32(floor(p.z));
  let t = fract(p);
  var corners: array<f32, 4>;
  for (var i = 0; i < 4; i++) {
    let at = x0 + vec2i(i & 1, i >> 1);
    corners[i] = mix(gatheredAt(at, z0), gatheredAt(at, z0 + 1), t.z);
  }
  return mix(mix(corners[0], corners[1], t.x), mix(corners[2], corners[3], t.x), t.y);
}

/**
 * The amount at a pixel: the sums at its slice coordinate (below 0.9999) × the scale, plus the
 * dither ((noise / 32) - 1 / 128), blended with the last frame's composite where the pixel's
 * point was by the temporal factor, held back where the depth there differs (× 100, smoothed)
 * or the point was off the screen.
 */
fn composite(position: vec4f, uv: vec2f, light: f32) -> vec4f {
  let distance = pixelDistance(uv);
  let ditherSize = vec2u(textureDimensions(dither));
  let noise = textureLoad(dither, (vec2u(position.xy) / 8u) % ditherSize, 0).r;
  let current = light * volume.color.w + noise * 0.03125 - 0.0078125;
  let depth = VOLUME_NEAR / distance;
  var amount = current;
  if (volume.params.w > 0.001) {
    let clip = volume.previousViewProj * vec4f(worldAt(uv, distance), 1.0);
    let previous = vec2f(clip.x / clip.w * 0.5 + 0.5, 0.5 - clip.y / clip.w * 0.5);
    let last = textureSampleLevel(history, historySampler, previous, 0.0);
    let change = saturate(abs(depth - last.g) * 100.0);
    let inside = clip.w > 0.0 && all(previous >= vec2f(0.0)) && all(previous < vec2f(1.0));
    let keep = (1.0 - change * change * (3.0 - 2.0 * change)) * volume.params.w * select(0.0, 1.0, inside);
    amount = mix(current, last.r, keep);
  }
  return vec4f(amount, depth, 0.0, 1.0);
}

fn sliceAt(uv: vec2f) -> f32 {
  return min(distanceSlice(pixelDistance(uv)), 0.9999);
}

// Where the GPU filters 32-bit floats: the hardware's trilinear sample.
@fragment
fn fs_compositeFiltered(in: FullscreenOut) -> @location(0) vec4f {
  let light = textureSampleLevel(scattered, scatteredSampler, vec3f(in.uv, sliceAt(in.uv)), 0.0).r;
  return composite(in.position, in.uv, light);
}

@fragment
fn fs_composite(in: FullscreenOut) -> @location(0) vec4f {
  return composite(in.position, in.uv, gatheredLinear(in.uv, sliceAt(in.uv)));
}

// --- Blur and apply ---

@group(0) @binding(17) var blurSource: texture_2d<f32>;

/**
 * Five taps along an axis at 0, ±6 and ±12 pixels (weights 0.222338, 0.210431, 0.1784), the
 * pixel kept as it is where the depths there are not even: |4 × its depth - the four others'|
 * above 0.002 (TODO(M13): the original's blur reads a depth whose unit is unread; ours is
 * VOLUME_NEAR / distance, the original's clip depth's complement).
 */
fn blurAlong(position: vec4f, axis: vec2i) -> vec2f {
  let size = vec2i(textureDimensions(blurSource));
  let at = vec2i(position.xy);
  var taps: array<vec2f, 5>;
  for (var i = 0; i < 5; i++) {
    let p = clamp(at + axis * (i - 2) * 6, vec2i(0), size - 1);
    taps[i] = textureLoad(blurSource, p, 0).rg;
  }
  let centre = taps[2];
  let edge = 4.0 * centre.y - taps[0].y - taps[1].y - taps[3].y - taps[4].y;
  if (abs(edge) > 0.002) {
    return centre;
  }
  let sum =
    (taps[0].x + taps[4].x) * 0.1784 + (taps[1].x + taps[3].x) * 0.210431 + centre.x * 0.222338;
  return vec2f(sum, centre.y);
}

@fragment
fn fs_blur(in: FullscreenOut) -> @location(0) vec4f {
  return vec4f(blurAlong(in.position, vec2i(1, 0)), 0.0, 1.0);
}

/** The vertical blur's amount times the light's colour, added to the scene. */
@fragment
fn fs_apply(in: FullscreenOut) -> @location(0) vec4f {
  let amount = max(blurAlong(in.position, vec2i(0, 1)).x, 0.0);
  return vec4f(amount * volume.color.rgb, 1.0);
}
