// The water's displacement field (water-displacement.ts): two layers of heights, wading and
// rain, each with its height now and a step ago: r, g = wading now, before; b, a = rain now,
// before. `prepare` moves the field with the grid and stamps the frame's ripples, `advance` runs
// one step of the damped wave equation, `slopes` writes the surface's slopes for the water
// shader (rg: slope east, north; b: height). ASCII only.

struct Displacement {
  // x, y: texels the grid moved (its content moves the other way); z: 1 to start still;
  // w: the number of stamps.
  shift: vec4f,
  // The layers' values: force, velocity, falloff, size.
  wading: vec4f,
  rain: vec4f,
  // Per stamp: its way (x0, y0, x1, y1) in texels, then radius, force, layer, unused.
  stamps: array<vec4f, 128>,
};

// Heights stay within this either way (water-displacement.ts HEIGHT_LIMIT).
const HEIGHT_LIMIT = 0.5;

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var field: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: Displacement;

fn load(p: vec2i) -> vec4f {
  let size = vec2i(textureDimensions(source));
  if (any(p < vec2i(0)) || any(p >= size)) {
    return vec4f(0.0);
  }
  return textureLoad(source, p, 0);
}

// A stamp's push at a texel: a soft round brush along its way (water-displacement.ts stampAt).
fn stampAt(index: u32, p: vec2f) -> f32 {
  let way = params.stamps[index * 2u];
  let brush = params.stamps[index * 2u + 1u];
  let d = way.zw - way.xy;
  let length2 = dot(d, d);
  var t = 0.0;
  if (length2 > 0.0) {
    t = clamp(dot(p - way.xy, d) / length2, 0.0, 1.0);
  }
  let distance = length(p - (way.xy + d * t));
  if (distance >= brush.x) {
    return 0.0;
  }
  return -brush.y * 0.5 * (1.0 + cos(3.14159265 * distance / brush.x));
}

@compute @workgroup_size(8, 8)
fn prepare(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(field);
  if (any(id.xy >= size)) {
    return;
  }
  let p = vec2i(id.xy);
  var value = vec4f(0.0);
  if (params.shift.z < 0.5) {
    value = load(p + vec2i(params.shift.xy));
  }
  let center = vec2f(id.xy) + 0.5;
  let count = u32(params.shift.w);
  for (var i = 0u; i < count; i++) {
    let push = stampAt(i, center);
    if (params.stamps[i * 2u + 1u].z < 0.5) {
      value.x += push;
    } else {
      value.z += push;
    }
  }
  textureStore(field, p, clamp(value, vec4f(-HEIGHT_LIMIT), vec4f(HEIGHT_LIMIT)));
}

// next = ((2 - v) h + (v / 4) sum of the four neighbours - previous) falloff, per layer.
@compute @workgroup_size(8, 8)
fn advance(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(field);
  if (any(id.xy >= size)) {
    return;
  }
  let p = vec2i(id.xy);
  let here = load(p);
  let around = load(p + vec2i(1, 0)) + load(p - vec2i(1, 0)) + load(p + vec2i(0, 1)) +
    load(p - vec2i(0, 1));
  let w = params.wading;
  let r = params.rain;
  let wading = ((2.0 - w.y) * here.x + w.y * 0.25 * around.x - here.y) * w.z;
  let rain = ((2.0 - r.y) * here.z + r.y * 0.25 * around.z - here.w) * r.z;
  let next = clamp(vec2f(wading, rain), vec2f(-HEIGHT_LIMIT), vec2f(HEIGHT_LIMIT));
  textureStore(field, p, vec4f(next.x, here.x, next.y, here.z));
}

@compute @workgroup_size(8, 8)
fn slopes(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(field);
  if (any(id.xy >= size)) {
    return;
  }
  let p = vec2i(id.xy);
  let east = load(p + vec2i(1, 0));
  let west = load(p - vec2i(1, 0));
  let north = load(p + vec2i(0, 1));
  let south = load(p - vec2i(0, 1));
  let slope = vec2f(east.x + east.z - west.x - west.z, north.x + north.z - south.x - south.z) * 0.5;
  let here = load(p);
  textureStore(field, p, vec4f(slope, here.x + here.z, 0.0));
}
