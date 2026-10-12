// Ambient occlusion as the engine does it (bSAOEnable): Scalable Ambient Obscurance (McGuire,
// Mara and Luebke, HPG 2012). The engine's passes around the raw AO match the paper's
// reference code (Community Shaders' ISSAOCameraZ, ISSAOMinify, ISSAOBlur, ISSAOComposite):
// camera-space Z, a mip chain picked on a rotated grid, the raw AO with its depth key packed
// into two channels, a bilateral 7-tap blur per axis, and a composite that multiplies the
// opaque scene before its fog and leaves snow alone (bDeactivateAOOnSnow). The raw AO itself
// is not in those sources; it follows the reference code with the game's INI values.
// Prepended with frame.wgsl. ASCII only. Notes: docs/rendering.md ("Ambient occlusion").

// fSAORadius, fSAOBias, fSAOIntensity (the game's defaults, BethINI database).
const SAO_RADIUS = 250.0;
const SAO_BIAS = 2.5;
const SAO_INTENSITY = 15.0;
// The reference code's sampling: taps on a spiral, mip levels for wide taps.
const SAO_SAMPLES = 11u;
const SAO_SPIRAL_TURNS = 7.0;
const SAO_LOG_MAX_OFFSET = 3;
const SAO_MAX_MIP = 5;
const SAO_EPSILON = 0.01;
// Camera-space Z beyond this is "no geometry" (the sky); the depth key spans 0..this.
const SAO_FAR = 300000.0;

// Pass input: the camera-space Z (one mip, or the chain), or the AO being blurred.
@group(1) @binding(0) var source: texture_2d<f32>;
@group(1) @binding(1) var gbuffer: texture_2d<f32>;
@group(1) @binding(2) var cameraZ: texture_2d<f32>;

struct FullscreenOut {
  @builtin(position) position: vec4f,
};

@vertex
fn vs_fullscreen(@builtin(vertex_index) index: u32) -> FullscreenOut {
  let x = f32((index << 1u) & 2u);
  let y = f32(index & 2u);
  var out: FullscreenOut;
  out.position = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
  return out;
}

// World position of a pixel at camera-space Z (reversed-Z depth = near / z).
fn saoPosition(pixel: vec2f, z: f32) -> vec3f {
  let uv = pixel * frame.screen.xy;
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, frame.screen.z / max(z, 1e-3), 1.0);
  let world = frame.inverseViewProj * ndc;
  return world.xyz / world.w;
}

fn packKey(key: f32) -> vec2f {
  let high = floor(key * 256.0);
  return vec2f(high / 256.0, key * 256.0 - high);
}

fn unpackKey(packed: vec2f) -> f32 {
  return dot(packed, vec2f(0.996108949, 0.00389105058));
}

fn octahedralDecode(e: vec2f) -> vec3f {
  var n = vec3f(e, 1.0 - abs(e.x) - abs(e.y));
  if (n.z < 0.0) {
    let signs = select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0));
    n = vec3f((1.0 - abs(n.yx)) * signs, n.z);
  }
  return normalize(n);
}

// ISSAOCameraZ: camera-space Z from the resolved depth.
@fragment
fn fs_camera_z(in: FullscreenOut) -> @location(0) vec4f {
  let depth = textureLoad(sceneDepth, vec2i(in.position.xy), 0).r;
  let z = select(SAO_FAR, frame.screen.z / max(depth, 1e-9), depth > 0.0);
  return vec4f(min(z, SAO_FAR), 0.0, 0.0, 0.0);
}

// ISSAOMinify: the next mip of Z, one of each 2x2 picked on a rotated grid.
@fragment
fn fs_minify(in: FullscreenOut) -> @location(0) vec4f {
  let p = vec2i(in.position.xy);
  let size = vec2i(textureDimensions(source));
  let pick = p * 2 + vec2i((p.y & 1) ^ 1, (p.x & 1) ^ 1);
  return vec4f(textureLoad(source, clamp(pick, vec2i(0), size - 1), 0).r, 0.0, 0.0, 0.0);
}

// The raw AO: taps on a spiral around the pixel within fSAORadius, each occluding by how far
// it lies above the surface (minus fSAOBias), weighted by distance. r: AO (1 = open), gb: the
// depth key for the blur.
@fragment
fn fs_ao(in: FullscreenOut) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let z = textureLoad(cameraZ, pixel, 0).r;
  let c = saoPosition(in.position.xy, z);
  let faceNormal = normalize(cross(dpdy(c), dpdx(c)));
  if (z >= SAO_FAR) {
    return vec4f(1.0, packKey(1.0), 1.0);
  }
  // The G-buffer's normal (bSAONormalMap) where something opaque wrote one.
  let g = textureLoad(gbuffer, pixel, 0);
  let toCamera = frame.cameraPos.xyz - c;
  var n = select(faceNormal, octahedralDecode(g.xy), g.a > 0.5);
  n = select(n, -n, dot(n, toCamera) < 0.0);
  // Pixels per world unit at distance 1: half the screen height times the projection's y.
  let p11 = length(vec3f(frame.viewProj[0].y, frame.viewProj[1].y, frame.viewProj[2].y));
  let diskRadius = 0.5 / frame.screen.y * p11 * SAO_RADIUS / z;
  let spin = f32(((3 * pixel.x) ^ pixel.y) + pixel.x * pixel.y) * 10.0;
  let size = vec2i(textureDimensions(cameraZ));
  let maxMip = min(SAO_MAX_MIP, i32(textureNumLevels(cameraZ)) - 1);
  let radius2 = SAO_RADIUS * SAO_RADIUS;
  var sum = 0.0;
  for (var i = 0u; i < SAO_SAMPLES; i++) {
    let alpha = (f32(i) + 0.5) / f32(SAO_SAMPLES);
    let angle = alpha * (SAO_SPIRAL_TURNS * 6.28) + spin;
    let tapRadius = alpha * diskRadius;
    let tap = pixel + vec2i(tapRadius * vec2f(cos(angle), sin(angle)));
    let inside = clamp(tap, vec2i(0), size - 1);
    let mip = clamp(i32(floor(log2(max(tapRadius, 1.0)))) - SAO_LOG_MAX_OFFSET, 0, maxMip);
    let mipSize = vec2i(textureDimensions(cameraZ, mip));
    let tapZ = textureLoad(cameraZ, clamp(inside >> vec2u(u32(mip)), vec2i(0), mipSize - 1), mip).r;
    let q = saoPosition(vec2f(inside) + 0.5, tapZ);
    let v = q - c;
    let vv = dot(v, v);
    let vn = dot(v, n);
    let f = max(radius2 - vv, 0.0);
    sum += f * f * f * max((vn - SAO_BIAS) / (SAO_EPSILON + vv), 0.0);
  }
  let r3 = radius2 * SAO_RADIUS;
  sum /= r3 * r3;
  let ao = max(0.0, 1.0 - sum * SAO_INTENSITY * (5.0 / f32(SAO_SAMPLES)));
  return vec4f(ao, packKey(clamp(z / SAO_FAR, 0.0, 1.0)), 1.0);
}

// ISSAOBlur: 7 taps 2 pixels apart along an axis, Gaussian weights (+0.3) cut where the depth
// key differs (edge sharpness 2000).
fn saoBlur(position: vec2f, axis: vec2i) -> vec4f {
  let pixel = vec2i(position);
  let size = vec2i(textureDimensions(source));
  let center = textureLoad(source, pixel, 0);
  let key = unpackKey(center.yz);
  if (key >= 1.0) {
    return vec4f(1.0, center.yz, 0.0);
  }
  var weights = array<f32, 7>(0.153170004, 0.392902017, 0.422649026, 0.444893003, 0.444893003, 0.422649026, 0.392902017);
  var offsets = array<i32, 7>(0, -6, -4, -2, 2, 4, 6);
  var total = 0.0;
  var weighted = 0.0;
  for (var i = 0; i < 7; i++) {
    let tap = textureLoad(source, clamp(pixel + axis * offsets[i], vec2i(0), size - 1), 0);
    let w = weights[i] * max(0.0, 1.0 - 2000.0 * abs(unpackKey(tap.yz) - key));
    weighted += w * tap.x;
    total += w;
  }
  return vec4f(weighted / (1e-4 + total), center.yz, 0.0);
}

@fragment
fn fs_blur_h(in: FullscreenOut) -> @location(0) vec4f {
  return saoBlur(in.position.xy, vec2i(1, 0));
}

@fragment
fn fs_blur_v(in: FullscreenOut) -> @location(0) vec4f {
  return saoBlur(in.position.xy, vec2i(0, 1));
}

// ISSAOComposite: the scene times the AO before its fog (so the fog is not darkened), no AO on
// snow. Blended as src + dst * src.a: src = fog colour * fog * (1 - AO), src.a = AO.
@fragment
fn fs_composite(in: FullscreenOut) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let z = textureLoad(cameraZ, pixel, 0).r;
  if (z >= SAO_FAR) {
    return select(vec4f(0.0, 0.0, 0.0, 1.0), vec4f(1.0, 0.0, 1.0, 0.0), frame.counts.z == 6u);
  }
  var ao = textureLoad(source, pixel, 0).r;
  let g = textureLoad(gbuffer, pixel, 0);
  if (g.a > 0.5 && g.b > 1e-5) {
    ao = 1.0;
  }
  // Debug view 6 (DebugView.ambientOcclusion): the AO alone.
  if (frame.counts.z == 6u) {
    return vec4f(vec3f(ao), 0.0);
  }
  let fog = fogAt(saoPosition(in.position.xy, z));
  return vec4f(fog.rgb * fog.a * (1.0 - ao), ao);
}
