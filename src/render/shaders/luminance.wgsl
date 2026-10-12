// Eye adaptation: the scene's average luminance (64x64 samples) and two running averages
// of it, x following quickly and y slowly, as the game's HDR downsample keeps them. Each
// frame moves an average towards the measured value by its rate, at least 1/256 and never
// past it. The image is scaled by y / x: brightening for a moment after going into the dark,
// darkening after coming into the light. ASCII only.

struct AdaptParams {
  // x: rate of the fast average this frame, y: of the slow one, z: 1 = start over.
  rates: vec4f,
};

@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> adaptation: vec4f;
@group(0) @binding(2) var<uniform> params: AdaptParams;

var<workgroup> partial: array<f32, 256>;

@compute @workgroup_size(16, 16)
fn main(@builtin(local_invocation_index) index: u32, @builtin(local_invocation_id) id: vec3u) {
  let size = vec2f(textureDimensions(scene));
  var sum = 0.0;
  for (var y = 0u; y < 4u; y++) {
    for (var x = 0u; x < 4u; x++) {
      let grid = vec2f(f32(id.x * 4u + x), f32(id.y * 4u + y)) + 0.5;
      let pixel = vec2u(grid / 64.0 * size);
      let c = clamp(textureLoad(scene, pixel, 0).rgb, vec3f(0.0), vec3f(50.0));
      sum += dot(c, vec3f(0.2125, 0.7154, 0.0721));
    }
  }
  partial[index] = sum;
  workgroupBarrier();
  for (var stride = 128u; stride > 0u; stride = stride >> 1u) {
    if (index < stride) {
      partial[index] += partial[index + stride];
    }
    workgroupBarrier();
  }
  if (index == 0u) {
    let luminance = partial[0] / 4096.0;
    if (params.rates.z > 0.5) {
      adaptation = vec4f(luminance, luminance, luminance, 0.0);
      return;
    }
    let current = max(adaptation.xy, vec2f(0.001));
    let delta = vec2f(luminance) - current;
    let change = sign(delta) * clamp(abs(params.rates.xy * delta), vec2f(0.00390625), abs(delta));
    adaptation = vec4f(current + change, luminance, 0.0);
  }
}
