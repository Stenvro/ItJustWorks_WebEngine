// The volumetric lighting's froxel volume (volumetric-volume.ts), the original's passes:
// - generate: each froxel's light (how much of the sun reaches it through the first two shadow
//   cascades, times the phase function) and density (the drifting noise), blended with the last
//   frame's froxel at the same place in the world;
// - raymarch: slice by slice from the camera, each column gathers the light scattered towards
//   the eye up to each slice;
// - blur: horizontal, then vertical, within each slice (one pass through workgroup memory);
// - composite: each pixel reads the volume at its place and depth, times the weather's
//   intensity and colour, added to the scene.
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
  // The volume's width, height, slices; this frame's slice jitter (0..1).
  size: vec4f,
  // The noise's offset in world units (xyz), 1 / the density size (w).
  noise: vec4f,
  // Density contribution, phase contribution, range factor, the last frame's share (0: none).
  params: vec4f,
  // The cascades' far distances (x, y), how many cascades are lit (z), the depth bias (w).
  shadow: vec4f,
  // The light's colour (rgb) times the strength (w).
  color: vec4f,
  // 1 / the depth texture's size (xy).
  screen: vec4f,
};

/** The original camera's near plane ([Display] fNearDistance). */
const VOLUME_NEAR: f32 = 15.0;
/** The farthest a slice reaches (clip depth 1 is at infinity). */
const MAX_DISTANCE: f32 = 400000.0;
/**
 * The depth of air of density 1 that scatters 1 - 1/e of the light (TODO(M13): the original's
 * scattering coefficient is unread; the shadow distance keeps a near wall faint and far air
 * fully lit).
 */
const AIR_DISTANCE: f32 = 8000.0;
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
@group(0) @binding(5) var history: texture_3d<u32>;
@group(0) @binding(6) var froxels: texture_storage_3d<r32uint, write>;

/** How much of the sun reaches a place by the first two cascades (beyond them: lit). */
fn sunVisibility(p: vec3f) -> f32 {
  let distance = length(p - volume.camera.xyz);
  let count = u32(volume.shadow.z + 0.5);
  var cascade = 2u;
  if (count > 0u && distance < volume.shadow.x) {
    cascade = 0u;
  } else if (count > 1u && distance < volume.shadow.y) {
    cascade = 1u;
  }
  if (cascade >= 2u) {
    return 1.0;
  }
  var clip = volume.cascade1 * vec4f(p, 1.0);
  if (cascade == 0u) {
    clip = volume.cascade0 * vec4f(p, 1.0);
  }
  let uv = vec2f(clip.x * 0.5 + 0.5, 0.5 - clip.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || clip.z > 1.0) {
    return 1.0;
  }
  return textureSampleCompareLevel(shadowMap, shadowSampler, uv, cascade, clip.z - volume.shadow.w);
}

/** The phase function mixed with even scattering by the phase contribution. */
fn phase(p: vec3f) -> f32 {
  let g = volume.light.w;
  let cosAngle = clamp(dot(normalize(p - volume.camera.xyz), volume.light.xyz), -1.0, 1.0);
  let hg = (1.0 - g * g) / max(4.0 * PI * (1.0 - g * cosAngle), 1e-6);
  return mix(1.0, hg, volume.params.y);
}

/** The last frame's froxel at a world place, or (-1, 0) where it was off its volume. */
fn previousFroxel(p: vec3f) -> vec2f {
  let clip = volume.previousViewProj * vec4f(p, 1.0);
  if (clip.w <= VOLUME_NEAR) {
    return vec2f(-1.0, 0.0);
  }
  let uv = vec2f(clip.x / clip.w * 0.5 + 0.5, 0.5 - clip.y / clip.w * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) {
    return vec2f(-1.0, 0.0);
  }
  let s = distanceSlice(clip.w);
  let texel = vec3i(vec3f(uv, s) * volume.size.xyz);
  let size = vec3i(volume.size.xyz);
  let packed = textureLoad(history, clamp(texel, vec3i(0), size - 1), 0).r;
  return unpack2x16float(packed);
}

@compute @workgroup_size(8, 8, 1)
fn generate(@builtin(global_invocation_id) id: vec3u) {
  let size = vec3u(volume.size.xyz);
  if (any(id >= size)) {
    return;
  }
  let uv = (vec2f(id.xy) + 0.5) / volume.size.xy;
  let s = (f32(id.z) + volume.size.w) / volume.size.z;
  let p = worldAt(uv, sliceDistance(s));
  let n = textureSampleLevel(noiseTexture, noiseSampler, (p + volume.noise.xyz) * volume.noise.w, 0.0).r;
  let density = mix(1.0, n * 2.0, volume.params.x);
  var froxel = vec2f(sunVisibility(p) * phase(p), density);
  if (volume.params.w > 0.0) {
    let last = previousFroxel(p);
    if (last.x >= 0.0) {
      froxel = mix(froxel, last, volume.params.w);
    }
  }
  textureStore(froxels, id, vec4u(pack2x16float(froxel), 0u, 0u, 0u));
}

// --- Raymarch ---

@group(0) @binding(7) var generated: texture_3d<u32>;
@group(0) @binding(8) var gathered: texture_storage_3d<r32float, write>;

@compute @workgroup_size(8, 8, 1)
fn raymarch(@builtin(global_invocation_id) id: vec3u) {
  let size = vec3u(volume.size.xyz);
  if (any(id.xy >= size.xy)) {
    return;
  }
  var transmittance = 1.0;
  var light = 0.0;
  var near = VOLUME_NEAR;
  for (var k = 0u; k < size.z; k++) {
    let far = sliceDistance(f32(k + 1u) / volume.size.z);
    let froxel = unpack2x16float(textureLoad(generated, vec3u(id.xy, k), 0).r);
    let extinction = exp(-froxel.y * (far - near) / AIR_DISTANCE);
    light += transmittance * froxel.x * (1.0 - extinction);
    transmittance *= extinction;
    near = far;
    // Each texel holds the light gathered up to its slice's far side.
    textureStore(gathered, vec3u(id.xy, k), vec4f(light, 0.0, 0.0, 1.0));
  }
}

// --- Blur ---

@group(0) @binding(9) var blurSource: texture_3d<f32>;
@group(0) @binding(10) var blurTarget: texture_storage_3d<r32float, write>;

/** A group's 8 x 8 texels with the kernel's reach of 2 around them, as read (edges clamped). */
var<workgroup> blurTile: array<f32, 144>;
/** The tile's 12 rows blurred horizontally over the group's 8 columns. */
var<workgroup> blurRows: array<f32, 96>;

// A five-tap binomial kernel, horizontal then vertical within each slice (TODO(M13): the
// original's blur kernel is unread). One pass: each group reads its tile once into workgroup
// memory and blurs it both ways there (the same sums as two passes through a texture).
@compute @workgroup_size(8, 8, 1)
fn blur(
  @builtin(workgroup_id) group: vec3u,
  @builtin(local_invocation_id) local: vec3u,
  @builtin(local_invocation_index) index: u32,
) {
  var weights = array<f32, 5>(1.0, 4.0, 6.0, 4.0, 1.0);
  let size = vec3i(volume.size.xyz);
  let slice = i32(group.z);
  let origin = vec2i(group.xy) * 8 - 2;
  for (var i = index; i < 144u; i += 64u) {
    let at = clamp(origin + vec2i(i32(i % 12u), i32(i / 12u)), vec2i(0), size.xy - 1);
    blurTile[i] = textureLoad(blurSource, vec3i(at, slice), 0).r;
  }
  workgroupBarrier();
  for (var i = index; i < 96u; i += 64u) {
    let row = (i / 8u) * 12u + i % 8u;
    var sum = 0.0;
    for (var k = 0u; k < 5u; k++) {
      sum += blurTile[row + k] * weights[k];
    }
    blurRows[i] = sum / 16.0;
  }
  workgroupBarrier();
  let id = vec2i(group.xy) * 8 + vec2i(local.xy);
  if (any(id >= size.xy)) {
    return;
  }
  var sum = 0.0;
  for (var k = 0u; k < 5u; k++) {
    sum += blurRows[(local.y + k) * 8u + local.x] * weights[k];
  }
  textureStore(blurTarget, vec3i(id, slice), vec4f(sum / 16.0, 0.0, 0.0, 1.0));
}

// --- Composite ---

@group(0) @binding(11) var scattered: texture_3d<f32>;
@group(0) @binding(12) var sceneDepth: texture_2d<f32>;
@group(0) @binding(13) var scatteredSampler: sampler;

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

/** The gathered light at a texel, 0 before the first slice. */
fn gatheredAt(xy: vec2i, slice: i32) -> f32 {
  if (slice < 0) {
    return 0.0;
  }
  let size = vec3i(volume.size.xyz);
  return textureLoad(scattered, vec3i(clamp(xy, vec2i(0), size.xy - 1), min(slice, size.z - 1)), 0).r;
}

/** A pixel's slice texel coordinate in the volume (-1 at the camera). */
fn compositeSlice(uv: vec2f) -> f32 {
  let depthSize = vec2i(textureDimensions(sceneDepth));
  let pixel = clamp(vec2i(uv * vec2f(depthSize)), vec2i(0), depthSize - 1);
  let d = textureLoad(sceneDepth, pixel, 0).r;
  // Our reversed depth is near / distance (0: the sky).
  let distance = select(MAX_DISTANCE, volume.camera.w / max(d, 1e-9), d > 0.0);
  // Texel k holds the light up to slice k's far side: slice coordinate (k + 1) / slices.
  return distanceSlice(distance) * volume.size.z - 1.0;
}

// The same read as one trilinear sample where the GPU filters 32-bit floats: clamped at the
// volume's edges as gatheredAt is, and before the first slice faded to 0 at the camera.
@fragment
fn fs_compositeFiltered(in: FullscreenOut) -> @location(0) vec4f {
  let z = compositeSlice(in.uv);
  let at = vec3f(in.uv, (max(z, 0.0) + 0.5) / volume.size.z);
  let light = textureSampleLevel(scattered, scatteredSampler, at, 0.0).r * clamp(z + 1.0, 0.0, 1.0);
  return vec4f(light * volume.color.rgb * volume.color.w, 1.0);
}

@fragment
fn fs_composite(in: FullscreenOut) -> @location(0) vec4f {
  let z = compositeSlice(in.uv);
  let xy = in.uv * volume.size.xy - 0.5;
  let x0 = vec2i(floor(xy));
  let z0 = i32(floor(z));
  let t = vec3f(fract(xy), z - floor(z));
  var corners: array<f32, 4>;
  for (var i = 0; i < 4; i++) {
    let at = x0 + vec2i(i & 1, i >> 1);
    corners[i] = mix(gatheredAt(at, z0), gatheredAt(at, z0 + 1), t.z);
  }
  let light = mix(mix(corners[0], corners[1], t.x), mix(corners[2], corners[3], t.x), t.y);
  return vec4f(light * volume.color.rgb * volume.color.w, 1.0);
}
