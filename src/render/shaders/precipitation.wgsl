// Precipitation (rain and snow, SPGD): instanced particles that fill a box around the camera.
// Every particle has a fixed place in an endless lattice that falls with the velocity (and
// drifts with the wind); the copy inside the box around the camera is drawn, fading near the
// box's faces where particles wrap. Rain is a streak along the velocity, snow a turning quad
// that circles its fall line. A depth map rendered from above (shadow map layer 4) hides the
// particles under roofs. Appended to frame.wgsl. ASCII only.

struct Precipitation {
  // Box edge, particle count, particle width and height (world units).
  box: vec4f,
  // Velocity (world units per second) and turning speed (radians per second).
  velocity: vec4f,
  // Circle radius min and max, random start rotation range (radians), 1 for snow.
  motion: vec4f,
  // Atlas columns and rows, alpha, time (seconds).
  atlas: vec4f,
  // World to the occlusion map (orthographic, from above).
  occlusion: mat4x4f,
};

@group(1) @binding(0) var<uniform> precipitation: Precipitation;
@group(1) @binding(1) var precipitationSampler: sampler;
@group(1) @binding(2) var precipitationTexture: texture_2d<f32>;

const PRECIPITATION_OCCLUSION_LAYER = 4;
// Rain streaks: the distance fallen in this long (the engine draws a frame's fall).
const RAIN_STREAK_SECONDS = 1.0 / 30.0;

struct PrecipitationOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) worldPos: vec3f,
  @location(2) occlusion: vec4f,
  @location(3) alpha: f32,
};

fn precipitationHash(value: u32) -> u32 {
  var h = value * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return (h >> 22u) ^ h;
}

// A random number 0..1 for a particle and a purpose.
fn precipitationRandom(particle: u32, salt: u32) -> f32 {
  return f32(precipitationHash(particle * 8u + salt) & 0xffffffu) / 16777216.0;
}

const PRECIPITATION_CORNERS = array<vec2f, 6>(
  vec2f(-1.0, -1.0),
  vec2f(1.0, -1.0),
  vec2f(1.0, 1.0),
  vec2f(-1.0, -1.0),
  vec2f(1.0, 1.0),
  vec2f(-1.0, 1.0),
);

@vertex
fn vs_precipitation(
  @builtin(vertex_index) vertex: u32,
  @builtin(instance_index) particle: u32,
) -> PrecipitationOut {
  let box = precipitation.box.x;
  let time = precipitation.atlas.w;
  let snow = precipitation.motion.w > 0.5;
  let seed = vec3f(
    precipitationRandom(particle, 0u),
    precipitationRandom(particle, 1u),
    precipitationRandom(particle, 2u),
  ) * box;
  var lattice = seed + precipitation.velocity.xyz * time;
  let spin = precipitationRandom(particle, 3u) * precipitation.motion.z +
    precipitation.velocity.w * time;
  if (snow) {
    // Flakes circle their fall line.
    let radius = mix(precipitation.motion.x, precipitation.motion.y, precipitationRandom(particle, 4u));
    let phase = precipitationRandom(particle, 5u) * 6.2831853 + precipitation.velocity.w * time;
    lattice += vec3f(cos(phase), sin(phase), 0.0) * radius;
  }
  // The copy of the particle in the box around the camera.
  let low = frame.cameraPos.xyz - vec3f(box * 0.5);
  let center = low + (lattice - low) - floor((lattice - low) / box) * box;
  let fromCamera = abs(center - frame.cameraPos.xyz) / (box * 0.5);
  let edgeFade = 1.0 - smoothstep(0.75, 1.0, max(fromCamera.x, max(fromCamera.y, fromCamera.z)));

  let corner = PRECIPITATION_CORNERS[vertex];
  let toCamera = normalize(frame.cameraPos.xyz - center);
  var world: vec3f;
  if (snow) {
    let c = cos(spin);
    let s = sin(spin);
    let right = frame.cameraRight.xyz * c + frame.cameraUp.xyz * s;
    let up = frame.cameraUp.xyz * c - frame.cameraRight.xyz * s;
    world = center + right * (corner.x * precipitation.box.z * 0.5) +
      up * (corner.y * precipitation.box.w * 0.5);
  } else {
    // A streak along the fall, as wide as the drop, facing the camera.
    let fall = precipitation.velocity.xyz;
    let speed = length(fall);
    let along = select(vec3f(0.0, 0.0, -1.0), fall / speed, speed > 1e-3);
    var side = cross(along, toCamera);
    if (length(side) < 1e-4) {
      side = frame.cameraRight.xyz;
    }
    let streak = precipitation.box.w + speed * RAIN_STREAK_SECONDS;
    world = center + normalize(side) * (corner.x * precipitation.box.z * 0.5) -
      along * (corner.y * streak * 0.5);
  }

  // One frame of the atlas per particle.
  let columns = max(precipitation.atlas.x, 1.0);
  let rows = max(precipitation.atlas.y, 1.0);
  let frameIndex = floor(precipitationRandom(particle, 6u) * columns * rows);
  let cell = vec2f(frameIndex - floor(frameIndex / columns) * columns, floor(frameIndex / columns));
  var out: PrecipitationOut;
  out.position = frame.viewProj * vec4f(world, 1.0);
  out.uv = (cell + vec2f(corner.x * 0.5 + 0.5, 0.5 - corner.y * 0.5)) / vec2f(columns, rows);
  out.worldPos = world;
  out.occlusion = precipitation.occlusion * vec4f(center, 1.0);
  out.alpha = precipitation.atlas.z * edgeFade;
  return out;
}

@fragment
fn fs_precipitation(in: PrecipitationOut) -> @location(0) vec4f {
  let texel = textureSample(precipitationTexture, precipitationSampler, in.uv);
  // Under a roof (something above in the occlusion map): hidden.
  let o = in.occlusion.xyz / in.occlusion.w;
  let mapUv = vec2f(o.x * 0.5 + 0.5, 0.5 - o.y * 0.5);
  var open = 1.0;
  if (all(mapUv >= vec2f(0.0)) && all(mapUv <= vec2f(1.0)) && o.z >= 0.0 && o.z <= 1.0) {
    open = textureSampleCompareLevel(
      shadowMap,
      shadowSampler,
      mapUv,
      PRECIPITATION_OCCLUSION_LAYER,
      o.z - 0.002,
    );
  }
  // Lit like the outdoors: ambient from above and the sun.
  let up = vec3f(0.0, 0.0, 1.0);
  let light = directionalAmbient(up) + frame.sunColor.rgb * 0.5;
  let soft = clamp(depthToScene(in.position) / 16.0, 0.0, 1.0);
  let alpha = texel.a * in.alpha * open * soft;
  if (alpha <= 0.002) {
    discard;
  }
  return vec4f(applyFog(texel.rgb * light, in.worldPos), alpha);
}
