// Achtergrond van de shell: nachtelijke mist met een "regen" van runen.
// De runen zijn procedurele klauwkrassen op een 3x3-raster (geinspireerd op het
// drakenschrift, niet gekopieerd). Wordt in M2 aangevuld met een echte scene.

struct Frame {
  time: f32,
  // devicePixelRatio: houdt de runen even groot op elk scherm.
  scale: f32,
  // Hoogte van het canvas in CSS-pixels.
  height: f32,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> frame: Frame;

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let uv = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
}

fn hash11(n: f32) -> f32 {
  return fract(sin(n * 127.1) * 43758.5453);
}

fn hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), u.x),
    mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), u.x),
    u.y,
  );
}

fn fbm(p: vec2f) -> f32 {
  var value = 0.0;
  var amplitude = 0.5;
  var q = p;
  for (var i = 0; i < 5; i++) {
    value += amplitude * noise(q);
    q = q * 2.03 + vec2f(17.0, 9.0);
    amplitude *= 0.5;
  }
  return value;
}

fn segment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

/** Afstand tot een rune in een cel van 0..1; `seed` kiest 2-3 krassen. */
fn rune(p: vec2f, seed: f32) -> f32 {
  var d = 1e3;
  let strokes = 2 + i32(hash11(seed) * 2.0);
  for (var i = 0; i < strokes; i++) {
    let s = seed * 17.0 + f32(i) * 7.31;
    let a = floor(vec2f(hash11(s + 1.3), hash11(s + 2.9)) * 3.0) * 0.5;
    var b = floor(vec2f(hash11(s + 4.1), hash11(s + 5.7)) * 3.0) * 0.5;
    if (all(a == b)) {
      b = vec2f(1.0 - a.x, a.y + 0.5);
    }
    d = min(d, segment(p, a, b));
  }
  return d;
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let px = position.xy / frame.scale;
  let t = frame.time;

  // Lucht: diep nachtblauw, onder iets lichter (horizon), met trage mist.
  let height = clamp(px.y / 900.0, 0.0, 1.0);
  var color = mix(vec3f(0.020, 0.027, 0.039), vec3f(0.060, 0.071, 0.086), height);
  let fog = fbm(px * 0.0022 + vec2f(t * 0.012, t * 0.004));
  color += vec3f(0.050, 0.058, 0.068) * smoothstep(0.35, 0.85, fog) * (0.4 + height);

  // Runenregen
  let cell = vec2f(18.0, 26.0);
  let column = floor(px.x / cell.x);
  let row = floor(px.y / cell.y);
  let local = fract(px / cell);
  let columnSeed = hash11(column + 0.5);
  let columnOn = step(0.62, hash11(column * 3.7 + floor(t / 9.0 + columnSeed * 9.0)));
  let speed = mix(3.0, 9.0, hash11(column * 1.91));
  let trail = mix(8.0, 22.0, hash11(column * 2.33));
  let rows = ceil(frame.height / cell.y);
  let head = (t * speed + columnSeed * 200.0) % (rows + trail);
  let behind = head - row;
  let inTrail = step(0.0, behind) * step(behind, trail);
  let fade = (1.0 - behind / trail) * inTrail * columnOn;

  if (fade > 0.0) {
    let glyphSeed = hash21(vec2f(column, row)) + floor(t * mix(0.5, 3.0, columnSeed)) * 0.137;
    let p = (local - vec2f(0.5)) * vec2f(1.45, 1.25) + vec2f(0.5);
    let d = rune(p, fract(glyphSeed) * 97.0) * cell.x;
    let stroke = 1.0 - smoothstep(0.55, 1.35, d);
    let isHead = step(behind, 1.0);
    let ink = mix(vec3f(0.62, 0.50, 0.30), vec3f(0.95, 0.92, 0.84), isHead);
    color += ink * stroke * fade * fade * 0.42;
  }

  // Vignet en scanlines zitten in CSS (.crt), boven de UI-achtergrond.
  return vec4f(color, 1.0);
}
