# Rendering

How a frame is put together (`src/render/renderer.ts`). Everything is drawn in HDR
(`rgba16float`) with 4× MSAA and reversed-Z depth (near = 1, far = 0, infinite far plane).

1. **Sun shadow map** (exteriors): 4 cascades, 2048² each (`shadow-cascades.ts`). The view
   up to 8000 units (fShadowDistance, Ultra) is cut at 700/1800/4000/8000; each slice gets an
   orthographic view from the sun around its bounding sphere, snapped to whole texels (no
   shimmer), reaching 20000 units towards the sun for casters. The sun moves with the clock
   and its shadows with it (SSE's bDisableShadowJumps: no jumps, fSunUpdateThreshold and
   fSunShadowUpdateTime unused): the light's view turns about the camera's place rounded to
   4096 units, so its texel grid slides over the scene by only the turn times the distance
   from there (turning about the world's origin, it slid nearly a texel a frame in Whiterun
   at TimeScale 20 and every shadow edge flickered). Cascades 1–2 update every
   frame, 3 every second and 4 every fourth frame; the shader samples each with the matrix it
   was rendered with. Casters: terrain and parts with `Cast_Shadows` (SLSF1 `0x200`), alpha
   tested where their NiAlphaProperty tests; not LOD; objects smaller than 3 texels of a
   cascade are left out. Receivers (`Receive_Shadows`, SLSF1 `0x100`, and terrain) take 3×3
   PCF with a normal offset of 1.5 texels; the last cascade fades out over its last tenth.

   **Focus shadows** (`focus-shadows.ts`): sharp sun shadow maps round the bodies near the
   player ([Display] iNumFocusShadow 4, fMaxFocusShadowMapDistance 450). Observed in the
   original: each frame it keys the actors whose 3D is loaded and shown by their squared
   distance to the player less the square of their bound's larger horizontal half extent (at
   least 1), keeps those below the distance squared, sorts them nearest first and hands out
   the focus maps in that order after the player's own body (key 0, when shown). Also observed
   in the original: each focus map has a render list of its own that holds its actor's 3D
   alone (no land, no object, no other actor), drawn through an orthographic camera along the
   sun round the actor's world bound: its radius to each side, the camera 1.1 radii towards
   the sun, its near plane 0.1 and its far plane 2.2 radii out. Its size in texels is
   50 × 2^max(0, (4X − d) / X), X being [Display] fFocusShadowMapDoubleEveryXUnit (450) and d
   the actor's distance to the camera, at most iShadowMapResolution: 800 at the camera,
   halving every 450 units to 50 from 1800 on. Before the shadow mask the focus actors are
   drawn again into the scene's stencil with their map's number, so a focus map shades its
   own actor's pixels and nothing else: the actor's shadow on the world and on other actors
   is the cascades' (which keep it). The mask takes per map a fade by its key, 1 below
   fFadingFracStart (0.25) of fMaxFocusShadowMapDistance², falling linearly to 0 at it. Here
   the four maps are the quarters (1024² each) of one more layer of the sun's shadow map,
   rendered every frame (actors move), each from its body's own casting parts into a corner
   of its quarter as large as its size, fitted round the bound of those parts (the size
   measured from the bound's centre, the original from the actor's root). In place of the
   stencil the draws of a focus body's scene name its map (the entry past their light lists,
   `sceneFocus` in `common.wgsl`), and only they sample it. Its depth bias is three times the
   cascades' (observed in the original's shadow mask: a focus map compares against its own
   depth less three times the bias of the cascade at the pixel; ours has one cascade bias).
   How the mask mixes them, observed in the original's shadow mask shaders: on a pixel
   the stencil gives a map, the map's comparison (0 or 1) is faded towards lit by that map's
   fade, 1 + fade × (shadow − 1), and the darker of it and the cascades' result is kept (the
   cascades still darken the focus actor; a faded map only adds its own shadow); the shadow
   distance's fade then applies to the result. Ours: `sunShadow` in `frame.wgsl`
   (`focusMix`). Where they belong, observed in the original: the sun casts shadows (its
   cascades and its focus maps) only in an open world that has a sky and no fixed dimensions
   (WRLD DATA flags 0x20 and 0x40 clear; ours: `WorldViewer`'s `shadows`). Anywhere else
   (interiors, worlds without a sky or with fixed dimensions) the focus maps go to a shadow
   light, observed in the original: its shadow lights are walked in the scene's order (the first
   four active ones render), and a light takes the focus maps when it held them the frame
   before, or when none has yet and it is a spot (frustum: a LIGH whose angle is below 180°)
   or directional light. Which light held them is marked by a first walk whose running flag is
   set on that light and cleared by every light after it, so a spot light that became active
   before the holder in the order takes them as well unless the holder ends the list (two
   lights at most; `chooseFocusLights`). The last light given them keeps them for the next
   frame; with none, no focus maps are made. A light's focus maps are fitted exactly as the
   sun's, the light's own view direction in place of the sun's (a spot light's axis, wherever
   the light stands): orthographic round the actor's bound, the camera 1.1 radii back along
   the axis, near 0.1 and far 2.2 radii, the same sizes and fades. Its shadow mask mixes them as
   the sun's does (the spot light's mask shaders with the stencil): on a focus actor's pixel
   the map's comparison, against its depth less three times the light's own bias, faded towards
   lit by the map's fade, and the darker of it and the light's own term kept. Ours: the light's
   sets go into the sun's shadow map, which the sun leaves unused then (the first light's into
   the focus layer, a second's into the first cascade's), and `pointShadow` in `frame.wgsl`
   mixes them into the light's shadow term on the focus actor's draws. The original's spot
   mask also holds the light's cone falloff, and the darker of the map and that product is
   kept; ours keeps the cone out of the shadow term (lightCone), so a partly faded map darkens
   a pixel at the cone's soft edge by the cone's share more.

   **Shadow lights** (`light-shadows.ts`), interiors and exteriors: lights whose LIGH carries
   Shadow Spotlight, Shadow Hemisphere or Shadow Omnidirectional (`cell-lighting.ts`
   lightShadow) cast shadows, four at once (no INI setting names a shadow-light count). Lights
   whose sphere misses the view frustum, or that stand in a room not seen, take no slot; of
   the rest the nearest to the camera hold the slots (the brighter at equal distance), each
   fading in and out over half a second as it enters or leaves the set. An omnidirectional
   light renders a cube (six 512² layers of the light-shadow map), a spot light one frustum
   round its cone, a hemisphere light one 150° frustum round its axis. A layer is rendered
   again only when its light moved a unit or one of its casters (parts within its radius)
   moved, appeared or went.

2. **Opaque pass:** the shell backdrop or the sky, terrain, tree LOD billboards, grass and the
   opaque parts of all scenes (LOD and cells), into the colour (unfogged) and a G-buffer
   (`gbuffer.ts`: normal, snow mask, snow specular). Every opaque pipeline writes the G-buffer,
   so a pixel holds its front surface's values (grass and distant trees write no snow). Parts
   and terrain quadrants outside the view frustum are skipped (bounding spheres).
3. **Screen-space passes and copies of the opaque scene:** the multisampled depth resolved
   (sample 0) into an `r32float` texture, the snow's subsurface scattering on the lit,
   unfogged image, the ambient occlusion, then the composite (below), then the resolved
   colour copied. The copies are bound in the frame group (`sceneColor`, `sceneDepth`).
4. **Water and blended pass:** water surfaces, then blended parts and particle systems of all
   scenes back to front (by bounding sphere centre).
5. **Refraction** (only with refraction shapes in view): the shapes into the refraction
   buffer, then the image-space refraction of the scene so far (below).
6. **Post-processing** (`post.ts`): the imagespace's eye adaptation, bloom, tone curve and
   grading into the canvas (see [formats/esm.md](formats/esm.md#imagespaces)), then its depth
   of field and the image-space modifiers' screen effects (below).

**Temporal anti-aliasing** ([Display] bUseTAA, `taa.ts`): the projection moves by a Halton
(2, 3) sub-pixel offset each frame and the HDR scene is blended with its history (90 %),
clamped to this frame's 3×3 neighbourhood, before the sun's effects and post-processing. The
history is found again per pixel by a **motion vector** where a moving draw shows (moving
instances and animated parts: `SceneRenderer.drawVelocity`, `shaders/velocity.wgsl`), else by
the pixel's depth and the camera's move, between the unjittered view-projections of both
frames (the history holds the steady image: through this frame's jittered matrix every still
pixel fetched its history a jitter step away, a sub-pixel resample each frame that blurred
the whole image). The history is read through a Catmull-Rom filter (five bilinear taps), so a
moving view does not soften it frame by frame. The velocity pass draws the moving opaque draws into
an `rgba16float` target (the uv offset to the last frame, and a written mark) under this
frame's and the last frame's world matrix (each scene keeps its moving draws' last matrices by
draw slot; a draw unseen in the last pass has not moved), with no depth attachment: a fragment
writes only where its depth matches the opaque pass's resolved depth (1 % relative tolerance:
that depth is one MSAA sample of four), so only the surface kept there. First-person draws use
first person's own view-projections, this frame's and the last. Skinned draws take this frame's
pose under both world matrices: the instance's move is followed, a limb's swing within it is
not (TODO(M13): the last frame's bone palettes). Opaque draws only; blended parts and particles
are reprojected by the depth behind them.

**Volumetric lighting** (`volumetric-volume.ts`, `shaders/volumetric.wgsl`,
bVolumetricLightingEnable): the weather's volumetric lighting (VOLI by time of day: its
intensity, which replaces [Display] fVolumetricLightingIntensity while
bVolumetricLightingUpdateWeather is on; the sun's colour mixed with its custom colour,
`world/volumetric-lighting.ts`) scattered through the original's froxel volume over the view
("Volumetric lighting" below). The phase function is the original's,
`(1 − g²) / (4π (1 − g cos))` with g = the phase scattering, mixed with 1 by the phase
contribution (`godRayPhase`; the phase contribution weighs the function, it is no strength).
With the vanilla values that weight stays between about 0.15 and 0.3: an even haze, a little
stronger towards the sun, cut into shafts by the shadows of the first two cascades (also
through openings in front of the camera, not only towards the sky). The light does not depend
on the sky's brightness.

**Image-based lens flare** (`image-lens-flare.ts`, `image-lens-flare-data.ts`,
`shaders/image-lens-flare.wgsl`; [Display] bIBLFEnable, on by default; vanilla SSE has no LENS
records, so this is its only flare of lights other than the sun). Observed in the original
(the passes from the engine's image-space code, each shader's terms from its shader cache):

- No list of lights feeds it. It reads the HDR scene (after the ambient occlusion, before the
  volumetric light is added) and every pixel with a channel above fIBLFLightsRangeDownshift (1)
  is a light: lamps, candles, fires, the sun, glowing surfaces. Indoors and outdoors alike.
- Downsample to a quarter (4 × 4): of four taps at (±1, ±1) source texels the one with the
  highest luminance (0.3, 0.59, 0.11; black never wins), then averaged half and half with the
  last frame's result where the pixel's motion vector leads (two targets swap each frame).
- The lights filter (ISIBLensFlares): saturate(colour) where a channel is above the downshift,
  else black, × fIBLFGlobalIntensity (0.7).
- Downsample across to 16 × 4 (four taps at −1.5, −0.5, 0.5, 1.5 texels, the brightest, the same
  temporal average); the filter again with the downshift 0 and uIBLFLateralRepeat (0) taps
  either side summed, × the intensity again; downsample across to 32 × 4 (two taps at ±0.5).
- The blurs: 2r + 1 taps of a normalised Gaussian with σ = r / 2 for r = 1..7, a 15-tap box for
  8, radius 7 above. Each pass's weights are scaled by the square root of its strength, so a
  blur across and down scales by the strength.
- Near streaks: three times the 16 × 4 image blurred across by uIBLFBlurRadiusX (7) and down by
  uIBLFBlurRadiusY (2) at fIBLFAnamorphicsIntensity (0.1: about a thousandth after three
  rounds). Far streaks: three times the 32 × 4 image blurred down then across at
  fIBLFAnamorphicsIntensityFar (1). A radius of 0 skips its pass. The count of three is fixed.
- Bloom: the lights filter blurred across then down by uIBLFBloomRadius (held to 1..7) at
  fIBLFBloomIntensity (0 in vanilla: black); the downward pass steps by its source's width.
  The engine's second bloom (of the sum, downsampled to 16 × 16) is black with its compute
  downsample (bEnableDownsampleComputeShader, the default: that path hands it no taps), so ours
  leaves it out.
- The far streaks are added to the near ones, those to the bloom (bilinear), and the sum is
  added to the scene by ISCompositeLensFlare; with the volumetric light on, the engine draws
  ISCompositeLensFlareVolumetricLighting instead, one additive pass of the volume's amount ×
  its colour plus the flare (ours adds the flare in its own pass: the same sum).
- The engine reads uIBLFLensesCount, fIBLFFlaresDispersal, fIBLFLightsBurn, the three channel
  distortions, fIBLFHaloFetch and fIBLFHaloWidthPow (the console's ConfigureIBLF sets them) and
  loads Effects\LensFlares\Ramps.dds and Masks.dds, but no pass it draws reads any of them: SE
  draws no ghosts or halo.

TODO(M13): the targets' sizes are named by their downsampling (a quarter, 16 × 4, 32 × 4); the
rounding and the bloom targets' sizes are inferred. The passes' sampler uses an address mode
the engine numbers 4 (ours: black outside, a border). Ours finds a still pixel's history by the
depth and the camera's move (the TAA's), a moving draw's by its motion vector; without TAA the
history is read in place.

**Encoding cost:** each draw is a handful of calls into the browser's WebGPU, and Helgen's
opening has some 4,400 draws a frame (its shadow cascades and opaque pass). The opaque and
shadow passes set a part's pipeline, material group and buffers only where they differ from
the draw before (consecutive draws are mostly one model's parts), and the per-draw uniforms
of animated draws go up in runs (an actor's parts lie side by side in its scene's buffer)
instead of one writeBuffer each.

**Frame uniforms** (`shaders/frame.wgsl`, group 0 of every world shader): camera, sun
direction and colour (times the imagespace's sunlight scale), directional ambient, fog,
point lights (storage buffer), time, the LOD mask of loaded cells (7×7 bits, see
[formats/lod.md](formats/lod.md)), the shadow cascades, the screen size and near plane, the
camera's right and up axes, the shadow map and its comparison sampler, the scene copies and a
clamping sampler. The terrain shader samples 21 textures (8 diffuse, 8 normal maps, the LOD
block texture and noise, the shadow map and the scene copies), more than WebGPU's default of
16, so the device asks for the adapter's limit (up to 32).

## Skinning

Skinned parts (`ModelPart.skin`, `skinning.ts`) keep their vertices as stored, with four
half-float weights and four bone indices each, and are drawn by the `vs_skinned` vertex
stage (`shaders/skinning.wgsl`; shadows: `shadow.wgsl`). Each placed skinned part has a bone
palette in its scene's storage buffer (`bone-palette.ts`): per bone the three rows of
`bone world × bind`, 256-byte aligned, bound as group 3 at a dynamic offset (the binding
covers 256 bones, as many as a byte can name). A vertex blends the rows by its weights
(normalised; a vertex without weights follows bone 0) and then goes on like any other
vertex, placed by its instance. Palettes start in the rest pose (the file's own bones) and
follow the bones' animated matrices every frame for models whose controllers move them; an
actor's skeleton poses them (below). Rays (decal placement) skin the vertices on the CPU
in the rest pose. 3056 vanilla meshes outside actors have skinned parts (books, banners,
flags, clothes, sacks, some plants).

**Actors** (`ModelInstance.pose`, `tints`, `partitionVisible`): an actor's palettes follow its
skeleton's pose (animation.md, Actors); its skin tone (NPC QNAM) replaces the tint of skin
shapes (skin tint, type 5) and its hair colour (CLFM) times 2 that of hair shapes (hair tint,
type 6: `hairTint`; the vanilla hair colours are all below 100 of 255, Albino White is 130, so
128 is the texture's own colour);
partitions its equipment hides are left out of the draw (only the visible index ranges are
drawn, also into the shadow map). Model-space normal maps of skinned shapes (FaceGen heads)
turn with the vertex's bones: the vertex stage passes the blended rotation as the vertex's
frame (`DRAW_SKINNED`). **FaceGen heads** (type 4) put the actor's face tint (slot 6) over the
head: `tint = 2·t·b − 2·t·b²`, `(b² + tint) · detail` with `detail = 3.984375 · (d + (1/255, 0,
1/255))` from the detail map (slot 3, a 64 grey default leaves the face as it is), the
engine's FACEGEN formula (Community Shaders' reconstruction of the SSE shader).

**Face morphs** (`face-morphs.ts`, `ModelInstance.face`): a head part's expression TRI
(phonemes, blinks, looks, moods; 44 morphs of ~1000 vertices for a head) is packed once per
TRI file into a storage buffer of half-float offsets (two u32 per morph and vertex: x|y, z),
shared by every head that uses it (the FaceGen shapes keep the TRI's vertex order). A head
part's draw gets a 256-byte region in its scene's bone buffer: count and vertex count, then
up to 30 (morph index, weight) pairs, rewritten when the face's weights change. Group 3 binds
the palette (binding 0), the region (binding 1, a second dynamic offset; other draws bind an
empty one) and the TRI's offsets (binding 2); `vs_skinned` adds the weighted offsets to the
position (by `vertex_index`) before skinning, in the shadow pass too. The game morphs each
actor's BSDynamicTriShape positions on the CPU instead; on the GPU the head stays one shared
model.

## Landscape

`shaders/terrain.wgsl`, as the vanilla landscape shader (Community Shaders' Lighting.hlsl,
LANDSCAPE and LOD_LAND_BLEND) does it:

1. Up to 8 textures blended by the vertex weights, × the vertex colour; their normal maps
   blended the same way. Gloss: the normal maps' alpha (mean 0.12 over the vanilla landscape
   maps), exponent: the blend of the land textures' SNAM.
2. Snow: a quadrant with a snow texture (LTEX INAM `0x1`) adds to every layer whose diffuse
   alpha is above zero its normal map sampled 4 times larger (1 / iLandscapeMultiNormalTilingFactor),
   combined by reoriented normal mapping. Snow mask = Σ snow flag × weight × diffuse alpha
   (bEnableSnowMask). Where the mask is above zero the specular gives way to the snow rim
   light and sparkles (below).
3. LOD blend: `1 − saturate(0.000375601 × (9625.6 − distance))` from the centre of the camera's
   cell (no blend within 6963 units, full at 9626: the outer ring of the 5 × 5 loaded cells)
   turns the land into the level-4 LOD terrain block's texture (`textures\terrain\<world>\
<world>.4.x.y.dds`, mapped by world position) × `0.8333 (p (0.37 − noise) + noise) + 0.37`
   (`textures\terrain\noise.dds` at 3 × the block UV, p from the LOD colour's brightness),
   flattens the normal and drops the gloss, so the loaded land meets the distant LOD without a
   seam. (The engine's UV factor 1/96 for the blend texture is applied to land UVs whose range
   is not documented; the level-4 block by world position is used here.)
4. The vanilla landscape shader has no parallax.

## Snow

The engine's "improved snow" (bEnableImprovedSnow, `shaders/snow.wgsl`): snow surfaces write
a rim highlight and a mask into a snow buffer that its ambient-occlusion composite adds. Here
the opaque pass writes them into the G-buffer and the [composite](#composite) adds them;
blended snow parts add them in their own shader. The game's default settings:

- Rim: `0.3 · (1 − saturate(geometry normal · v))³ · (1 − saturate(n · v))²`
  (fSnowRimLightIntensity, fSnowGeometrySpecPower, fSnowNormalSpecPower) × the mask, added to
  the lit colour before fog (after the subsurface scattering).
- Sparkles: fixed bright points in world space, `step(0.85, noise²)` of 3D simplex noise at
  `0.07 × 6 × position` (fSparklesDensity, fSparklesSize, fSparklesSpecularPower 2), × lerp(sun
  shadow, 1, 0.25) (fShadowSparkleIntensity), fading out over 1000 units (fSparklesMaxDistance),
  × the mask, added after fog.
- Subsurface scattering (ISSnowSSS, `snow-sss.ts`, `shaders/snow-sss.wgsl`): after the opaque
  pass, on the lit, unfogged image before the composite (see [Composite](#composite)), where
  the G-buffer's snow mask is above zero, 11 taps along the screen at offsets ±0.08
  to ±2 × (0.078125, 0.13889) × fSnowSSSStrength (50) / distance, with per-channel weights
  (blue spreads farthest; each channel's weights sum to 1), each tap kept at the centre colour
  in proportion to its depth difference × 0.1 × fSnowSSSDepthDiff (0.5). With L the result's
  luminance (0.3, 0.59, 0.11): snow = lerp(lerp(fSnowSSSColor × fSnowSSSDarkColorIntensity,
  source, L), result, L), blended in by the mask: lit snow softens and dim snow darkens towards
  a cool tint. It is written into the multisampled colour target, which the composite then
  finishes. (iSnowSSSCurrentColor 2 picks an undocumented preset; the configured colour
  (0, 0, 0.08) and intensity 0.1 are used.)

## Depth of field

The imagespace's depth of field (IMGS DNAM), as the engine's ISDepthOfField shader does it for
weathers ("distant" blur, `shaders/dof.wgsl`), on the graded image: a copy at half the size is
blurred (Gaussian, 1 + blur radius pixels; TODO(M13): the engine's taps per radius), then each
pixel turns into it by `saturate((distance − focus distance) / range) × strength`, the
distance from the opaque scene's depth. Where the sky is not blurred ("no sky"), a sky pixel
is blurred only beside geometry: by the average depth 3 pixels around it and at half strength
for the share of sky there, so mountain silhouettes soften. The engine's dynamic depth of
field (bDynamicDOF, fDynamicDOF*: near and far blur around an automatic focus, the average
depth at the centre, changing after fDDOFFocusDelay over fDDOFFocusDuration; ISDepthOfField's
autofocus path) is not part of plain play: imagespace modifiers switch it on (IMAD DNAM
"DoF - Use Target" and the flags Mode Front/Back, the near and far sides), and the game plays
those for spells and other effects: a magic effect's IMAD while it lasts on the player, an
explosion's on the player within its radius, a hazard's while the player is near it,
scripts' (Image-space modifiers, below), a kill camera's shots' (cross-faded in over
fVATSImageSpaceTransitionTime: src/shell/killmove-camera.ts). Behind the tween and item menus
the game applies DOBJ IMID (ISMTween, a constant −0.15 brightness) while any of them is open, as
UIBlurManager counts them (src/shell/game-menus.ts).

A modifier's own depth of field (below) goes through the same pass with its mode: front
blurs what is nearer than the focus distance, back what is farther (ISDepthOfField without
DISTANT), each by `saturate(|distance − focus| / range) × strength`.

## Image-space modifiers

Image-space modifiers (IMAD, layout in [formats/esm.md](formats/esm.md#image-space-modifiers))
change the imagespace for a while: spells, explosions, scripts (Papyrus `ImageSpaceModifier`)
and the engine (ISMTween behind the menus, LowHealthImod). The pieces:

- `src/world/image-space-modifier.ts`: parsing and a modifier's values at a point of its
  timeline (`evaluateModifier`, `modifierKeyTime`).
- `src/world/image-space-modifiers.ts` (`ImageSpaceModifiers`): the active ones, as the
  engine's ImageSpaceManager keeps them, and the imagespace they make of a base one
  (`modify`).
- `src/shell/screen-modifiers.ts` (`ScreenModifiers`, `GameSession.imageSpaceModifiers`):
  applies them by form id (loading the records, requests in order), advances them in real
  time and lays them over the weather's imagespace (`WorldSky.frame`, so the directional
  light gets their sunlight scale too) and the cell's (`ModelViewer`). Scripts reach it
  through `ScriptWorld.imageSpace`; the shell calls `apply(formId, strength)`,
  `remove(formId)`, `crossFade(formId, seconds)`, `removeCrossFade(seconds)` and
  `popTo(from, to, strength)` itself.

Timelines: an animatable modifier plays its keys over its duration once and ends (the stack
can loop one, `ApplyOptions.loop`, but no caller asks it to: the effects that last use
modifiers that are not animatable; TODO(M13): whether the engine loops one for any caller);
one that is not animatable, or has no
duration, stays at its keys at time 0 until removed (Creation Kit: the duration is then
ignored). Papyrus: `Apply(strength)` shows a modifier (again from its start), `Remove()`
takes it off at once, `ApplyCrossFade(seconds)` puts it on the cross-fade chain and fades
from the chain's last modifier to it, the global `RemoveCrossFade(seconds)` fades the chain's
last modifier out and the one before back in (TODO(M13): check that it comes back), `PopTo
(other, strength)` takes it off and shows the other at once (on the chain in its place).

Combining, each modifier at weight w = strength × cross-fade (strength is not clamped):

- HDR and cinematic values: `value × Π (1 + (mult − 1) w) + Σ add × w` (Creation Kit:
  "multiply and add"; TODO(M13): the order of several modifiers).
- Tint and fade colour: the average of the colours weighted by alpha × w, the highest alpha
  × w as the amount (Creation Kit, for the tint; the fade likewise). The base imagespace's
  tint takes part with its amount (TODO(M13)).
- Blur radius, double vision and motion blur: the highest (Creation Kit, for blur and double
  vision). Radial blur: the strongest modifier's, its strength × w.
- Depth of field: the strongest modifier's replaces the imagespace's (TODO(M13): how the game
  mixes them). "Use target" (IMAD DNAM: radial blur centre and focus on the modifier's
  target) takes the target its caller gives: an explosion's point, a magic effect's actor
  (`ApplyOptions.target`); without one the record's centre and distance.

The screen effects (`post.ts`, `shaders/screen-effects.wgsl`) run after the depth of field,
each from the image so far into the next (two full-size half-float images, made the first
time a modifier needs them), the last into the canvas. Without modifiers the post-processing
is as before (the fade is 0 and no effect pass runs).

- Fade colour: in the HDR shader's grading, last (ISHDR `Fade`).
- Blur: a copy at half size blurred with 1 + radius pixels; the image turns into it by
  min(radius, 1) (TODO(M13): the game's ISBlur taps per radius).
- Double vision (ISDoubleVision): the average of two copies shifted apart by the strength
  (texture coordinates), turning into the blurred copy towards the edges when a blur runs.
  The shift sways with time (the Creation Kit: it "animates automatically"; TODO(M13): the
  game's sway).
- Radial blur (ISRadialBlur): 2 × 8 + 1 samples along the line to the centre, spaced by
  `0.5 × (c(d, start, ramp up) − c(d, down start, ramp down))` with
  `c(d, s, r) = strength (1 − 1 / (r max(d − s, 0) + 1))` at distance d from the centre
  (TODO(M13): the game's step count per quality).
- Motion blur: the previous frame's result kept by s / (1 + s) per 60th of a second
  (TODO(M13): calibrate).

## Composite

The engine finishes its opaque scene in this order (observed in the original): the
geometry pass writes the main colour, normals and, with bEnableImprovedSnow, two more targets
for the snow; then the ambient occlusion is computed (not yet applied); then ISSnowSSS runs on
the main colour (a plain copy when the improved snow or its scattering is off); then one
ISSAOComposite pass reads that result and writes the finished image. The composite's variant
follows bSAOEnable and whether there is fog (a sky with a fog, and bSAOApplyFog, on by
default): SAO, Fog or SAOFog; with neither, the image is only copied. Its constants carry the
fog, the sun's direction, the sparkle settings (fSparklesSize, fSparklesDensity,
fSparklesIntensity, fSparklesMaxDistance, fShadowSparkleIntensity, ...) and
bDeactivateAOOnSnow, so the fog and the sparkles are applied there, after the scattering.

What the shaders write is from Community Shaders 0.7.4 (behaviour only): the lighting,
landscape, grass and distant tree pixel shaders write the lit colour without fog and without
the snow's specular (the grass and DistantTree shaders have no distance fog; the lighting
shader leaves the snow's specular out of the colour and exports it as SnowParameters.x). The
snow's specular is kept out of the main colour so that ISSnowSSS scatters only the snow's
diffuse light. Here (`composite.ts`,
`shaders/composite.wgsl`), per sample of the multisampled colour (its own depth and G-buffer,
so silhouettes against the fog get no fringe): colour + snow specular × snow mask, × AO (1 on
snow, bDeactivateAOOnSnow; 1 without SAO), fog over it, + sparkles × snow mask. The sky and
surfaces their own shader finished (G-buffer a = 0: sky objects, effect shapes) are left
alone; blended parts, decals, water and particles fog themselves. Running the scattering on
the fogged image instead turned distant snow (snow patches on mountains, and grass and tree
LOD that took the snowy land's mask under them) near black in fog and dim weather: the
scattering darkens towards fSnowSSSColor by the luminance, and fogged pixels are dim. The menu
overlay has no composite: snow there lacks its rim light (menus have no fog). The composite
always runs here, also without SAO and fog, so the snow keeps its rim and sparkles (TODO(M13):
whether the engine's lighting shader adds them itself in that case, where its composite is a
plain copy, is not known; and bSAOApplyFog off is not followed).

## Ambient occlusion

The engine's SAO (bSAOEnable, `sao.ts`, `shaders/sao.wgsl`) is McGuire, Mara and Luebke's
Scalable Ambient Obscurance (HPG 2012): the passes Community Shaders keeps (ISSAOCameraZ,
ISSAOMinify, ISSAOBlur, ISSAOComposite) are the paper's reference code. After the opaque pass
and the depth resolve:

1. Camera-space Z from the resolved depth (near / depth; no geometry = 300000), and 5 more mips,
   each pixel taking one of the 2 × 2 below on a rotated grid.
2. Raw AO: 11 taps on a 7-turn spiral within fSAORadius 250 (in pixels: 250 × half the screen
   height × the projection's y scale / Z), a per-pixel random rotation, wider taps from coarser
   mips; each occludes by `(r² − |v|²)³ · max((v·n − fSAOBias 2.5) / (0.01 + |v|²), 0)`, the
   sum divided by r⁶ and AO = `max(0, 1 − sum · fSAOIntensity 15 · 5 / 11)`. The normal comes from
   the G-buffer (bSAONormalMap), else from the depth's derivatives. The depth key is packed
   into two channels for the blur. This pass is not in the sources; it is the paper's code
   with the game's values (TODO(M13): fSAOExpFactor 0.11 has no known role, compare with the
   original).
3. Blur along x, then y: 7 taps 2 pixels apart, the Gaussian weights + 0.3 (fSAOValueDiffFactor),
   cut where the depth keys differ (`1 − 2000 |Δkey|`).
4. Applied by the composite (above): colour × AO before the fog, none on snow
   (bDeactivateAOOnSnow) or the sky.

## Lighting shader

BSLightingShaderProperty (`shaders/lighting.wgsl`) follows the engine's lighting pixel shader
as Community Shaders' near-vanilla Lighting.hlsl (v0.7.4) reproduces it, with the material
constants of Nukem9's `BSLightingShader`:

1. Normal: tangent space, or model space stored **x, z, y** (MSN materials and LOD land).
   Specular mask: the normal map's alpha, or with model-space normals the specular map (texture
   set slot 7).
2. Lights (sun with its shadow, point lights fading as 1 − (d/r)²; a spot light only within
   its cone, below): diffuse `saturate(n·l)`;
   specular `pow(saturate(h·n), glossiness)` without an n·l test. Anisotropic (hair):
   `h·n` becomes 1 − |a·l − a·h| with a = normalize(0.5 n + vertex normal), times 0.7 l.z.
   With the unshadowed light colour: soft lighting (`SLSF2 0x2000000`, smoothstep of
   (rolloff + n·l) / (1 + rolloff) minus that of n·l; for point lights the engine passes the
   unnormalized light vector), rim lighting (`0x4000000`, (1 − n·v)^power · saturate(v·−l)),
   both times the rim / soft map (slot 2), and back lighting (`0x8000000`, saturate(−n·l)
   times the back light map, slot 7).
   A texture a model names that no file holds, or a slot it leaves empty, takes the engine's
   built-in texture for that slot (`material-slots.ts missingTextures`, observed in the
   original). The engine makes them at start-up: its default normal map (128, 128, 255, 255:
   flat, with full specular in its alpha), black (also its default height map), white, grey
   (128), the FaceGen detail default (64 in every channel), a black cube map, a texture-effect
   map and a dithering noise. Each lighting material fills only its own slots: every material's
   diffuse and normal map take the default normal map (a missing diffuse map shows its lavender);
   the rim / soft light map (with rim or soft lighting) and the back light map (with back
   lighting) take it too, and a model-space normals material's specular map black; glow maps
   white; the parallax height maps black; FaceGen's tint grey, its detail map the detail default
   and its skin map black; eyes' and multi-layer parallax's environment mask and the inner layer
   the default normal map; every environment cube map the default cube. An environment-mapped
   material's mask is left empty (it reads 0, Direct3D's rule for an unbound slot: no
   reflection). Vanilla meshes name a few
   textures the game never shipped (Windhelm's whicedecal01 and its normal map, Alduin's eyes'
   normal map): a missing texture named by a model of the game's own archives
   (`Vfs.isGameContent`, `TextureCache` failures' `gameLacks`) is logged as info; one a mod's or
   a loose model names, or a file that does not decode, as a warning; each once.
3. Colour: (directional ambient + emit + lights) × diffuse, then × vertex colours (hair: the
   tint by the vertex green, `(g · (tint − 1) + 1)`; skin tint: the facegen RGB tint formula).
   Emit is the emissive colour with Own_Emit, or the emissive colour × the glow map (type 2
   with SLSF2 Glow_Map): so glow is coloured by the diffuse texture.
4. Multi-layer parallax (type 11): the inner layer (slot 6) seen through the surface, offset by
   (thickness × layer alpha / 1024) along the view reflected about the scaled normal map, blended
   by saturate(n·v) × (1 − diffuse alpha); it has the environment map too.
5. Environment map: the cube map in the reflection, times the environment mask (else the
   specular mask) × the scale, **times the diffuse light** (dark where the surface is dark).
6. Specular: lights × specular mask × specular colour × strength.
7. Directional materials (snow, ash, ice on statics and object LOD) and their multi-index snow
   pass: see [formats/esm.md](formats/esm.md#directional-materials). Objects counted as snow
   (STAT flag or SLSF2 `0x10000000`) get the improved snow of `shaders/snow.wgsl` instead of
   their specular: the rim light before fog and the sparkles after it, times the snow mask
   (the engine's SnowParameters.y): the projected material's blend weight, 1 in the
   multi-index snow pass, else the diffuse alpha. The mask goes into the G-buffer for the
   snow's subsurface scattering (see [Snow](#snow)).
8. Ambient specular (Community Shaders' AMBIENT_SPECULAR): the directional ambient's specular
   colour × (1 − n·v)^fresnel power × the specular mask, on specular surfaces (not snow). The
   colour and power are DALC's (the weather's, blended by time of day; an interior's XCLL or
   lighting template), in the frame's ambient w components.
   Character light (CHARACTER_LIGHT; [Display] bCharacterLighting, fCharacterLightPrimary /
   SecondaryLightIntensity 0.75 / 0.3, ...LumScale 2, ...LumMax 0.75): on actors' skin (FaceGen
   and skin tint shapes) primary × saturate(n·v) + secondary × saturate((0.1644, −0.9864) ·
   n.yz in the actor's model space), times min(LumMax, LumScale × luminance). The luminance is
   the red of one sample of slot 11 at (1, 1). Observed in the original: the techniques with
   the character light bind slot 11 themselves, to the eye adaptation's 1×1 adapted luminance
   target (the one the HDR pass's adaptation writes and its bloom and tone map read), so the
   sample is the adapted luminance as the last frame left it (the scene draws before the HDR
   pass); other lighting draws bind ProjectedNoise.dds there (projected UVs) or nothing. Ours:
   the renderer copies the adaptation's adapted value (its x, the tone map's contrast pivot)
   into each frame's uniforms on the GPU before the scene's passes (`Frame.luminance`).
   Eyes (type 16, 3,320 vanilla shapes, `node tools/effect-audit.ts --shaders`) carry
   Eye_Environment_Mapping (SLSF1 `0x20000`), not Environment_Mapping, and reflect their cube
   map (slot 4, with the mask of slot 5: both bound by that flag, `material-slots.ts`) by their
   eye cube map scale. TODO(M13): the engine reflects about the shader's
   left / right eye reflection centres (by the vertex red); ours about the mesh normal.
9. LOD landscape noise (type 18): diffuse × 0.8333 (p (0.37 − noise) + noise) + 0.37 with
   `textures\terrain\noise.dds` at 3 × UV and p from the colour's brightness.
10. Leaf flutter (SLSF2 Tree_Anim, `leafShift` in common.wgsl, the engine's
    GetTreeShiftVector): a vertex moves along its normal by
    `(e(0.1 t) + 0.1 e(0.25 t)) · amplitude · vertex alpha`, e = a smoothed triangle wave of
    `t · frequency · wind` plus the sum of the vertex's coordinates, t = 6 × seconds. Leaf
    amplitude and frequency come from the TREE record (1 and 1 without one; without a leaf
    animation root the timer stands still); the amplitude fades out between 3600 and 4600 units
    from the camera (fLeafAnimDampenDistStart / End); wind = the weather's wind speed (0..1).
    The vertex alpha is the leaf weight, not transparency.

Parallax (type 3, 11 vanilla shapes in Markarth): the height map (slot 3) shifts the texture
coordinates by (height × 0.08 − 0.04) along the x and y of the **model-space** view direction,
as the vanilla pixel shader does (aers' Skyrim-SE-Shader-Tools; a correct version
would use the tangent-space direction; the bug is kept). Community Shaders 0.7.4 leaves this
out (it replaces parallax with its own), so that source is not used here.

## Effects and particles

BSEffectShaderProperty (`shaders/effect.wgsl`, also used for particles by
`shaders/particle.wgsl`) follows the engine's effect pixel shader (as documented by the
Community Shaders sources):

1. Colour = source texture × base colour × vertex colour (particles: the particle colour);
   alpha = texture alpha (1 with greyscale-to-palette alpha) × base and vertex alpha.
2. Falloff (SLSF1 `0x40`): opacity from start to stop opacity between the falloff angles
   (cosines) by how directly the surface faces the camera.
3. Soft effect (SLSF1 `0x40000000`, blended only): alpha fades over the soft falloff depth in
   front of the opaque scene (from `sceneDepth`), so smoke and glows do not cut into walls.
4. Material alpha (and its animated "alpha transparency").
5. Greyscale palette (SLSF1 `0x20` alpha, `0x10` colour): alpha = palette alpha at (texture
   alpha, alpha so far); colour = palette at (texture green, base × vertex red). Fire uses
   both: the particle colour fading from grey to black walks down the flame palette (white
   hot → orange → transparent red) while the alpha fade shrinks the flame. Palettes are
   lookup tables: sampled clamped (their rows must not wrap) and at their full size, as their
   smaller mips blend the opaque rows into the clear first ones (GradFlame01: rows 0–1 are
   clear), so an effect faded to alpha 0, like an unlit fire's flames, vanishes.
6. Colour × base colour scale; Effect_Lighting (SLSF2 `0x40000000`): blended towards colour
   × scene light (directional ambient, the sun at half strength even from behind — smoke
   scatters it — and point lights, not the spot lights) by the lighting influence. The
   engine's spot lights are its shadow spotlights, which reach surfaces through their shadow
   maps; Community Shaders' effect shader leaves shadow-casting lights out of an effect's
   lights (TODO(M13): the engine's own list is unread). With them, the cobwebs hung beside
   Bleak Falls Barrow's sunbeams (lit effects with greyscale palettes: 56 web shapes among the
   1,170 lit effect shapes, `node tools/effect-audit.ts --lit`) were a white sheet over
   Arvel's door, and the dust in the entrance's shafts a white blob.
7. Alpha test, then fog: additive effects (destination factor ONE) fade out, multiplicative
   ones (destination SRC_COLOR or source DEST_COLOR: the engine's MULTBLEND) fade to white by
   1.5 × the fog, others blend to the fog colour.

Draw uniforms of effects: base colour (emissive slot), base colour scale (params.w), lighting
influence and soft depth (specular slot). Texture clamp mode picks the sampler (bit 0 wraps U,
bit 1 wraps V).

**Particles** (`scene-renderer.ts`, `particle-sim.ts`): every placed particle system has its
own simulation; each frame the systems near the camera or in view update, and their particles
go into one instance buffer (16 floats each: position, half size, colour, atlas frame,
velocity or strip segment, rotation). One draw per system: six vertices per instance build a
quad facing the camera (the frame's camera axes, turned by the particle's rotation) or turned
along the velocity (aspect flag `0x1`, height scaled by the aspect ratio), or a ribbon segment
facing the camera for strip particles. Blended particles test but never write depth (their
quads overlap unsorted within a system).

### Effect shaders on references

Effect shaders (EFSH) and art objects (ARTO) cover any reference, not only actors
(`src/shell/actor-effects.ts`): a script's EffectShader.Play or VisualEffect.Play (RFCT: its art
and shader) on an object covers its model's shapes, its particles come off its rigid shapes as its
model places them, its art stands at its origin. An enchanted item glows
(`src/gameplay/magic/enchantment-glow.ts`): its enchantment's costliest effect's Enchant Shader
and Enchant Art (MGEF DATA), on a weapon in the hand (third and first person; the particles off
the blade where its hand node holds it) and on weapons and armour lying in a loaded cell, exterior
or interior (hidden with them when taken), the ones the game made too: dropped, placed by a
script, an enchanted copy made at the enchanting table (a created form with its EITM; the shell's
world and interior viewers glow them as `CreatedObjects` shows them). 2,903 of 3,018 enchanted
vanilla weapons and 2,819 of 2,847 enchanted armours have a shader (`node tools/effect-audit.ts
--glow`).

Worn armour shows no glow. The armour enchantments' effects carry shaders of their own
(EnchArmorMagickaFXS on 1,142 armours, ...StaminaFXS 758, ...HealthFXS 329, ...FireFXS 324,
...FrostFXS 134, ...ShockFXS 128): a membrane that fades from full to a 5% persistent share in
a second, no particles. But CommonLibSSE names one reference effect controller for enchanted
items, the weapon's (`WeaponEnchantmentController`, with a visitor that refreshes the enchanted
weapons), and none for armour; the worn enchantments' visitors cast, dispel, preload and unload
their abilities (the effects' own hit visuals, which the magic system shows). So the worn armour
stays as it is, as is remembered of the game. TODO(M13): confirm in the original (what the
armour shaders were made for; whether armour lying in the world glows, which we show as a
weapon's).

The art an enchanted weapon shows (its Enchant Art: Chillrend's frost, the bound weapons'
flames, the Draugr weapons' streaks) hangs where the weapon's root is: on its hand node while
drawn, its sheath node while sheathed, first person too (`heldAnchor` in
`src/gameplay/magic/effect-placement.ts`); an actor's art follows its bones by name, an
object's stands at its origin.

A visual effect's (RFCT) flags (CommonLibSSE `BGSReferenceEffect::Flag`) place its art: with
Face Target (the absorb streams, soul trap's, the dragon soul's: 29 effects) its +Y turns from
its target's origin towards the origin of the reference VisualEffect.Play names to face (Play's
third argument), each frame; with Attach To Camera (the camera-attached dust, fog, snow, embers
and the Elder Scroll readings: 41 effects, all with Inherit Rotation) it hangs at the camera,
turned with the camera's forward with Inherit Rotation, shown whether its target is or not
(`facingWorld`, `cameraWorld`). TODO(M13): inferred: the axis that faces (+Y, the game's
forward), that it pitches as well as turns, and that it faces its facing reference's origin.

### Per-object light lists

Observed in the original (behaviour only; `src/render/light-lists.ts`). A geometry is not
lit by every light near it: it keeps its own list of the lights that reach it, and when its
lighting pass is built the engine names, after the directional light, first the shadow lights
that touch it (those of the frame's shadow lights its active-light mask allows, skipping
effect-only geometry for lights not flagged to light it), then the other lights of its list
(culled and hidden lights left out), into an array of sixteen. The lighting technique's light
count then holds at most seven point lights (three bits: the count minus the directional
light, clamped to 7) and at most four shadow lights (three bits, clamped to 4): the shader
loops over that many and drops the rest. So an object among many candles is lit by seven of
them, the shadowed ones first.

How a geometry's own list is kept, observed in the original:

- **Who joins it.** When a geometry's lights are refreshed, the scene walks its active lights
  (or, in a room, the room's lights) in their order and adds each light that is not a shadow
  light, has no restricted node and whose sphere touches the geometry's bound (distance between
  the centres less the bound's radius under the light's radius). Shadow lights never join a
  geometry's list: they reach lighting geometry only through the frame's shadow lights.
- **The order.** A refresh moves each light it finds to the front part of the list, in the
  order found, and afterwards drops the lights it did not find again unless they are dynamic
  (those stay behind the found ones). So the list names lights in the order they joined the
  scene, never by strength: the eighth candle is left out however bright it is.
- **Land.** A light created from a reference flagged Doesn't Light Landscape (REFR `0x20000`;
  Doesn't Light Water is `0x100`) is not added to land geometry (the shader flags Landscape or
  No_LOD_Land_Blend), and the same test leaves it out of the frame's shadow lights a land pass
  names. Each quadrant of a cell's land is a geometry of its own (with its own texture set and
  bound), so it keeps its own list as any geometry does: at most seven lights a quadrant, the
  shadow lights first.
- **Effects.** An effect shader's pass takes lights only with Effect_Lighting, into an array of
  five: the directional light (the sun, not its shadow light) and at most four of its list's
  lights; it never names shadow lights. Particle systems are effect geometry: they keep lists by
  their bound as any geometry does.

Here every lit draw has a slot in its scene's light-list buffer (`flags.w` bits 8–23 name it;
the shader type keeps bits 0–7, the distance fade bits 24–31): a count and seven indices into
the frame's lights, 16 bits each. A draw's list is chosen the first time it is drawn in a
frame (`SceneRenderer.#chooseLights`, by its bounding sphere and room), a particle system's as
it is drawn (by its particles' bound), and uploaded in one range per scene; the lighting and
effect shaders loop over it (`drawLightList`, `lightListIndex` in `common.wgsl`). A light is
in a list when its sphere touches the bound and it is not a portal-strict light of another room;
a lighting draw names the frame's shadow lights first (at most four, in the frame's order), then
the others in the order they joined the scene (`PointLight.order`: the world viewer numbers the
loaded cells' lights as the cells loaded, then magic's lights), seven in all; an effect draw
names no shadow light and four at most. Each land quadrant chooses its list as it is drawn in
the frame's main view (`SceneRenderer.chooseLandLights`, light-lists.ts 'land': the lights that
light landscape, by the quadrant's bound) into its material's uniforms (`TerrainMaterial.lights`,
`landLightAt` in `frame.wgsl`); the water's reflection keeps the lists the frame chose. Tree LOD
and decals take every light of the frame. Grass takes no point lights: [Grass]
bGrassPointLighting is off by default.

### Rooms' lighting

A room marker's LNAM lighting template (XRMR flag `0x80`) takes the cell template's place, under
the cell's own XCLL values and inheritance flags, and its INAM image space (flag `0x40`) the
cell's, while the camera stands in that room (`lightingInRoom`, `src/shell/model-viewer.ts`).

### Spot lights

LIGH Shadow Spotlight (`0x400`): 39 vanilla lights, 153 references, nearly all sunbeams through
ceilings and windows. The cone is the base light's FOV (DATA, 90° in every vanilla light) plus
the reference's XLIG FOV offset (xEdit `FOV 90+/-`), along the reference's local X axis (the
Gamebryo spot light's axis: for 123 of the 153 references X is the axis pointing down the most);
an angle outside 0–180° (two references) leaves the light shining every way. A light's fade is
its FNAM plus the reference's XLIG fade offset (`Fade 1.35+/-`; 138 spot references have one,
from −3.7 to +74), its radius DATA's plus XRDS. The lighting shader and the frame's `lightAt`
light a point only within the cone, its edge softened over a tenth of the rest of the cosine
range (`lightCone` in `frame.wgsl`; TODO(M13): the engine's edge is its shadow map's frustum,
and what stands in the beam shadows it). `node tools/effect-audit.ts --spots`.

### Procedural lightning

Observed in the original (behaviour only; `src/render/lightning.ts`). The bolts of the
shock spells, their impacts and explosions and the shock runes and walls (37 controllers in 13
vanilla meshes, among them `Magic\LightningBolt01`–`04.nif`) are not in the files: a
**BSProceduralLightningController** on a node builds them at run time into that node's first
child, a BSTriShape with no vertices (culled in the file). Its settings (docs/formats/nif.md,
"Animation"): subdivisions, branches and their variation, length and its variation, width, a
branch's width multiplier, arc offset, whether the main bolt and the branches fade, whether the
arc offset is animated; and nine interpolators (generation, mutation, subdivision, branches,
branch variation, length, length variation, width, arc offset), in the vanilla meshes driven
by the model's sequences (the beams' graph plays `mIdle`, the impacts' and explosions' their
own); without an interpolator a setting keeps the controller's value, and without a
generation interpolator nothing is built.

- **Generation** (bool): when it turns on, the engine grows a tree of bolts (on a task, shown
  from the next frame): a main bolt of 2^subdivisions segments (it builds nothing for fewer
  than 1 or more than 12 subdivisions), with between branches − variation (at least 0) and
  branches + variation branches (uniformly), each of one subdivision less and with half the
  branches and half the variation for its own branches, and so on down. When it turns off the
  geometry goes; the next generation grows a new tree.
- **Laying out** (at a generation and whenever the **mutation** bool flips, either way): every
  bolt runs along the shape's +Y axis, `0.5^depth × length + 0.25^depth × r × length
variation` long (r uniform in [−1, 1), depth 0 for the main bolt, 1 for its branches…),
  `childWidthMultiplier^depth × width` wide. It strays from its line by a midpoint
  displacement in the X–Z plane: along a random direction, a tent over the whole bolt (most
  in the middle, nothing at the ends) of `0.5^depth × arc offset`, then the same on each half
  with half the amplitude, down to single segments; so both ends stay on the line. A branch
  starts at a random point of the first half of its parent's centre line and runs parallel to
  it (along +Y).
- **Arc offset between mutations** (with Animate Arc Offset): when its value changes, every
  point's X and Z are scaled by new / old (the bolts breathe out until the next mutation
  re-forms them; the vanilla arc tracks are sawtooths that drop at each mutation key).
- **Geometry:** per point of a bolt four vertices: its centre ± half the width along X and
  along Z; two crossed ribbons per segment (one across X, one across Z), not turned to the
  camera. U is 0 → 1 across a ribbon, V = point / segments along the bolt (the material's UV
  scale tiles it, its V offset controller scrolls it). Vertex colour white; alpha: a main
  bolt's first point 0, a branch's 1, every bolt's last point 0, the points between 1, or
  `1 − (k / segments)²` with the bolt's fade flag. The material is the empty shape's
  (BSEffectShaderProperty and NiAlphaProperty: in the bolts additive, greyscale-to-palette).

Here each controller becomes a particle system of its model (`ParticleSystemData.lightning`;
`buildModel` takes the empty shape out of the parts) run by a `LightningSimulation` instead of
a particle simulation: it samples the tracks like a particle system's (free ones on the
model's clock, managed ones on their sequence's), keeps its bolts in the shape's space and
writes two ribbon instances per segment into the particle buffer; `vs_ribbon`
(`shaders/particle.wgsl`) builds each quad from the segment, its fixed side vector (the shape's
X or Z axis in the world × half the width) and the alphas at both ends, shaded by
`fs_particle` (the effect shader). Random numbers are seeded per placement. Beams stretch the
shape (below and docs/gameplay.md, "A hand's cast"): the simulation scales its Y axis by
`LightningOptions.stretch` and its alpha by `opacity`.

**Beams** (BeamProjectile, observed in the original; `src/shell/magic-beams.ts`): the
beam's model hangs at the caster's magic node, along the aim, every frame while it lives.
When the beam meets something, its length is the distance from its origin to the hit; then
(and again whenever a lightning controller lays out new geometry, which tells the beam) every
geometry of the model gets its own local Y axis scaled to length / the `BeamEnd` node's Y
(512 in the vanilla bolts), keeping its X and Z: the bolts reach the hit with their zigzag
across unchanged, a long beam looks straighter than a short one. TODO(M13): only the procedural
lightning is stretched here; the meshed beams (Staff of Magnus, Auriel's Bow, the Labyrinthian
and Dawnguard beams) keep their own length.

**Refraction** (SLSF1 `0x8000` on the lighting shader: heat haze over fires and torches,
magic barriers, mist; about 360 vanilla shapes, strength 0.05–1): the engine draws these shapes only
into a refraction buffer and an image-space pass shifts the finished scene by it
(`ISRefraction` in the Community Shaders sources), so what is blended behind a barrier (its
own glow, fire, particles) bends along with the opaque scene. Here (`refraction.ts`): after the
blended pass the shapes write the buffer (`shaders/refraction.wgsl`, rgba16float, cleared to
0.5, 0.5, 0, 0): the normal map's xy, the strength (animated by controllers), the mask (diffuse
alpha × material alpha, × vertex alpha with Vertex_Alpha or Vertex_Colors); depth-tested, no
depth writes, back to front, where the mask is 0 they leave the buffer as it is. Then the
composite (`shaders/refraction-composite.wgsl`) reads a copy of the scene: offset 0.1 ×
strength × (normal − 0.5), x mirrored; past 0.15 and 0.85 of the screen the shifted
coordinate moves at 0.78 of the rate (blended in by the strength); the mask is read where the
shifted coordinate lands, so nothing in front of a shape is pulled into it; the result is
the scene lerped to the shifted scene by that mask. Their UV controllers scroll the noise.
The pass that writes the refraction buffer, as the original's shader cache has it (its utility
shader's normal techniques): the shift it stores is the normal map's xy about 0.5 times 1.8 plus
the geometry normal's view-space xy, divided by `max(depth × 0.001333 + 0.8, 1)` (the shift
shrinks with distance past 150 units), halved about 0.5; the strength goes into the third
channel. Fire_Refraction (`0x10000`): observed in the original, it is read only when a
refraction shape's pass is built, where it picks the falloff variant of that pass: the vertex
shader multiplies the strength by the geometry normal · the normalized direction from the vertex
to the eye (`refraction.wgsl`; TODO(M13): the refraction target's format is unread, a negative
product is stored as 0 here). Fire_Refraction without Refraction (about 50 shapes) builds no
refraction pass and is drawn as a regular surface.

## Weapon blood

A blade that struck flesh shows blood, as the engine's BSTempEffectWeaponBlood does. The
blood is in the weapon models themselves (`node tools/held-weapon-info.ts`; 2698 of 3309 WEAP
world models, 2800 first-person ones): hidden shapes (NiAVObject flag 0x1) over the blade
whose shader has SLSF1 Decal and Dynamic_Decal (`0x0C000000`; no other hidden shape has
Dynamic_Decal), in pairs under names that vary (BloodLighting / BloodEffects, EdgeBlood01 /
EdgeBlood, WarAxeBloodLighting / WarAxeBloodFX, ...):

- an **effect** shape with SLSF2 Weapon_Blood (`0x20000`) over `textures\blood\BloodEdge01.dds`
  (blades) or `BloodHitDecals01.dds` (maces and hammers), multiplied over the blade (alpha
  flags `0x5243`: source ZERO, destination SRC_COLOR, alpha test greater than 0). The texture
  is not a colour: its green is the blood's mask and its blue how thick it is. The engine's
  BLOOD technique (Community Shaders' `Effect.hlsl`): alpha = green; above = saturate(green −
  AlphaTestRef.x); mul = blue × vertex alpha, × above / AlphaTestRef.y where above is less
  than AlphaTestRef.y; colour = saturate((2, 1, 1) − mul) × (1 − mul × AlphaTestRef.z). So
  the blade keeps its colour where there is no blood and turns dark red where it is thick.
  Here the draw's `layer` slot (unused by effects) carries AlphaTestRef: x the cutoff, y the
  soft edge (fWeaponBloodFalloffThreshold, 0.07), z 0 (TODO(M13): what the engine puts
  there).
- a **lighting** shape over the same texture's `Add` version (black, its alpha the wet parts)
  with `BloodEdge01_n.dds`, the eye cube map at 0.25 and glossiness 500, drawn additively
  (alpha flags `0x520d`: SRC_ALPHA, ONE): the wet sheen.

`buildModel` keeps these shapes (`ModelPart.weaponBlood`); the scene draws them only on an
instance that carries a weapon's blood (`ModelInstance.weaponBlood`: the weapons combat hangs
on actors and on the first-person arms, src/shell/actor-weapons.ts), and leaves them out of
overlays and of the parts decals land on. A melee hit whose impact leaves a blood decal (the
weapon's impact data set against the target's flesh: DecalBloodBladeHit, DecalBloodDraugrHit;
not bone, metal or a punch) bloodies the weapon of the hand that struck
(src/gameplay/combat/weapon-blood.ts): fresh for fWeaponBloodLifetime (10 s), the cutoff then
rising from 0 to 1 over fWeaponBloodFadeDuration (60 s), so the thin blood goes first and the
thick drops last, the sheen's alpha falling with it; another hit makes it fresh again. The
third- and first-person models of the same weapons share it; other weapons come clean.
TODO(M13): how the engine drives AlphaTestRef and the sheen's alpha from its blend amount over
time is not documented; this is the plain reading of the three settings.

## Decals

Placed decals (`decals.ts`, `shaders/decal.wgsl`; records in
[formats/esm.md](formats/esm.md#decals)) are drawn first in the blended pass as screen-space
projections: the back faces of each decal's box (unit cube times its placement: X width, Y
projection, Z height) cover its area even with the camera inside; for every pixel the opaque
surface behind it comes from the scene depth copy (`inverseViewProj` of the frame), and where
that point lies inside the box the decal's texture is drawn on it, lit like the surface: its
normal from the depth's screen derivatives, turned by the decal's normal map in the decal's
frame, with ambient, sun, shadows and point lights, then fog. Surfaces running along the
projection fade out (no smearing down walls). Alpha testing discards below 0.5; blending uses
the texture's alpha. One instanced draw per texture set; decals out of view are skipped.

Dynamic decals (a hit's blood: `src/shell/combat-impacts.ts`) last `[Display]` fDecalLifetime
(30 s); at most `[Decals]` uMaxDecals (1000; the Medium preset 100) are kept, the oldest going
first (observed in the original: each is made with the lifetime, the count capped by the
setting; `expireDecals`). At the end of its lifetime a decal fades out (observed in the
original, the plain and the skinned decals alike): its shapes' alpha runs down from 1 to 0 over
one more second, then it goes (`DECAL_FADE_SECONDS`, `decalAlpha`; the decal shapes through
`fadeScene`, a projected decal through its instance's `params.z` in `decal.wgsl`).

**Skinned decals** (`skinned-decal.ts`; blood on an actor, `combat-impacts.ts bodyDecal`). The
original walks the shapes in the decal's box: a hidden shape or one flagged no-decals is skipped
with what lies under it, a shape whose shader is itself a Decal takes none, an alpha-blended or
alpha-tested one only with `[Decals]` bAllowDecalsOnAlpha. A skinned shape gets a skinned decal,
made only while fewer than `[Decals]` uMaxSkinDecals (100) live, fewer than `[Display]`
iMaxSkinDecalsPerFrame (25) were made this frame and the actor carries fewer than `[Decals]`
uMaxSkinDecalPerActor (25; Skyrim_Default.ini sets 60): otherwise the new one is not made and
the older stay. Each shape's decal counts against these. A rigid shape in the box (a helmet, a
shield, a worn weapon: no skin) gets a plain decal of its own, hung under that shape's parent
node so it moves with it, made while fewer than `[Display]` iMaxDecalsPerFrame (100) were made
this frame; one too near a decal already on that node is skipped: within
√((max(width, height) + the other's width)² / spacing) of where the other was made, the spacing
16 for the impacts' decals (`decalTooNear` in `src/world/decal.ts`). No dynamic decal is made
farther than `[Display]` fDecalLOD0 (800) from the camera (observed in the original).

Dynamic decals on the world, observed in the original: a decal goes onto the node that holds
the collision the hit struck (for the landscape, the land of the cell), one plain decal per
shape under that node built from its triangles in the box, each spaced against the decals
already beside it. A hit on the world (a shot or a blow into a wall) is spaced by 16; an actor
hit leaves environment blood at fCombatEnvironmentBloodChance (0.75): a ray from the hit along
the blow, its direction lowered by half before it is made a unit, 512 units long, and the
first surface it meets that is not an actor or a projectile takes the decal, spaced by the
impact's Placement Radius (IPCT DATA; none when 0). Both count against iMaxDecalsPerFrame and
fDecalLOD0. ObjectReference.PlayImpactEffect's decal is forced: made past the spacing, the
per-frame count and the distance. Ours (`#splatter`, `struckNodeKey`, `environmentBloodWay`)
keys the struck node by the reference and the collision's node name (the land by its cell).

The environment blood's impact, observed in the original, is not the hit's: it is the impact
for the target race's material (RACE NAM4) in the sever impact data set (BPND) of the struck
limb's part in the race's body part data (RACE GNAM); where that part names none, no blood is
left behind the target. Its decal is square (one size drawn between the decal's min and max
width serves as its width and its height: `squareDecal`) and 48 deep either side of the
surface (`ENVIRONMENT_BLOOD.depth`) whatever its DODT depth. TODO(M13): which limb an ordinary
blow records is unread (ours, `actor-combat.ts #environmentBlood`: the head where the hit lands
nearer the head's node than the torso's, else the torso).

**How a world decal is built** (`world-decal.ts`, `combat-impacts.ts #onSurfaces`; observed in
the original). Each shape under the struck node (`ModelPart.ancestors` holds the names above a
shape; the whole model where the collision names no node) is visited as on actors: hidden
shapes, decal shapes and, without bAllowDecalsOnAlpha, alpha-blended or alpha-tested ones are
left out; each shape that takes the decal counts against iMaxDecalsPerFrame. The box is the
decal's width across, its height up and its DODT depth either side of the struck point along
the projection (`worldDecalBox`; 48 for the environment blood). A triangle of the shape takes
part when its face (its winding's normal) turns from the struck surface's normal by less than
the impact's angle threshold (IPCT DATA: cos of it, at least 0.01; the vanilla impacts use 15°,
35°, 80° and 85°: `node tools/decal-info.ts --impacts`); it is clipped against the box's six
planes and the polygon left is cut into a fan (`clipToUnitCube`). The copied vertices keep the
shape's other data, their normals carried along the cut edges, their texture coordinates
projected across the box into the decal's atlas quarter (as on actors) and their tangent frames
made again; the decal shape is drawn with the lighting shader as a Decal and Dynamic_Decal
(depth bias) where the shape is: the instance's placement, motion, visibility and pose shared,
on the shape's node. The land of the cell takes one built the same way from its 33×33 grid of
heights and normals, each 128-unit square cut south-west to north-east as the land's own
triangles (`landDecalPart`). Where nothing in the box takes it there is no decal. A viewer
without its shapes given (the headless simulation) falls back to the projected box.

Ours, on actors: the actor's skinned shapes are skinned on the CPU in
the pose of the hit, their triangles that overlap the box (a separating-axis test against the
unit cube) are copied with their bone weights and partitions (equipment that hides a body part
hides its blood), their texture coordinates projected across the box (u along its X, v down its
Z, in the decal's atlas quarter) and their tangent frames made again for those coordinates in the
files' convention (the stored tangent along +v, the bitangent along +u, measured on the vanilla
bodies); the shape is drawn with the lighting shader as a Decal and Dynamic_Decal (depth bias),
the texture set's textures, the decal's shininess and colour (on the vertex colours) and its
alpha mode, with the actor's pose. A rigid shape's triangles in the box are copied the same way
but as the shape has them (its own space, no skin) into a decal shape that hangs on the same
skeleton node under the same transform (`rigidDecalPart`), so the blood stays on the helmet or
the shield as it moves; these count against iMaxDecalsPerFrame and, with the projected decals,
uMaxDecals. A hit's decal shapes are one model drawn with the actor. It lasts fDecalLifetime as
the other dynamic decals. Where no shape lies in the box there is none (a body known only by
its pose, without its drawn models, takes the decal projected onto what of it lies in the box,
following its nearest node).

## Weather

Which weather the sky shows, and how scripts, the console and conditions control it
(`src/world/sky-weather.ts`, `SkyWeather`; observed in the original). The game has one
sky state for its whole run, kept in the session (`GameSession.sky`): it outlives the
viewers, so a weather set indoors or by a quest is the one shown at the door. The viewers
run it once a frame (`WorldSky.frame` outside, `ModelViewer` indoors) and draw what it holds;
the scripts' bridge (`ScriptWorld`) and the console drive and read it.

**What it holds.** The _current_ weather and the _outgoing_ one it is changing from, the
_transition_ (0..1) between them, the _default_ weather (the regions' choice, or one a script
set without override), the _override_ (a weather held over the regions), the region the
current choice was made in, the player's weather region, the time the current weather
began (game hours), and the sky's _mode_.

**The player's weather region** is chosen as the player enters an exterior cell: of the
cell's regions (XCLR, in order) that belong to its worldspace (REGN WNAM) and have an area
(RPLD polygon) around the player, those with a weather tab (RDAT type 3) compete: one whose
tab is marked Override beats one that is not; otherwise the higher priority wins; on equal
terms the first stays. Indoors the region stays the one outside; an interior with a sky
region (XCCM) uses that one instead for as long as the player is in it.

**Each frame** (not in an interior without a sky, see the modes):

- _How long a weather lasts_ comes from the climate's volatility: `(255 − volatility) × 22 /
255 + 1` game hours (SkyrimClimate's 50: 18.69 h; 0: 23 h). The time since a weather came
  wraps at midnight (a weather that began at 23:00 is one hour old at midnight).
- An override that has lasted that long is let go, as if released.
- With an override, the override is the weather wanted. Otherwise the regions choose:
  - In the same region as last time (and nothing released): while the weather still has
    time, nothing changes in a region; without a region the default stands (or one picked
    from the climate's list becomes the default). Once its time is up a new one is picked
    from the region (else the climate) — again each frame until one differs from the
    current, so the weather changes as soon as its time is up.
  - In another region, or just after a release: the region's pick is wanted, but a weather
    the region also has may stay, the more likely the younger it is (a random number above
    the share of its life that has passed keeps it). Without a region, a current weather
    the climate also has may stay the same way (it becomes the default); else the default
    (or a climate pick) is wanted.
  - A pick is by chance: a random whole number below the sum of the chances (an entry's
    chance is its global's value if it names one) falls into one entry's share; entries of
    chance 0 never come. With nothing at all, DefaultWeather (`0x15E`).
- A wanted weather that differs from the current one begins only once no change is under
  way. It begins with a change from the current one — at once (no outgoing weather) after
  fast travel or when there is no sky.
- The transition is the game hours since the weather began over its change time:
  `transDelta × (fWeatherTransMax − fWeatherTransMin) + fWeatherTransMin` hours (0.01..0.25
  h; Trans Delta is WTHR DATA byte 3 / 255, 125 for most weathers: 0.128 h, about 23 real
  seconds at TimeScale 20). It runs on game time: it stands still in menus, and waiting or
  sleeping finishes it. Above 1 the change is over (the outgoing weather goes).
- Under the full sky the wind is the current weather's, blended with the outgoing one's
  through a change (GetWindSpeed); elsewhere it keeps its last value.

**Scripts and the console:**

- `Weather.SetActive(override, accelerate)` and the console's `sw <weather> [1]`: with
  override the weather becomes the override; without, it becomes the default and the region
  is forgotten (until the player enters the next cell, when the regions choose again). The
  weather comes through a change on the next frame (after one under way). _Accelerate_
  hurries a change under way: from the moment of the call its remaining part runs
  fWeatherTransAccel + 1 times faster (Skyrim.esm sets fWeatherTransAccel to 16). The console
  never hurries. With no weather at all yet, SetActive forces.
- `Weather.ForceActive(override)` and the console's `fw <weather> [1]`: the engine queues them
  for its next frame, then the weather is there at once (no change), as the override or the
  default, and the region is forgotten as with SetActive.
- `Weather.ReleaseOverride` and `rwo`: the override goes and the regions choose again at once
  (a young current weather the region has may stay).
- `GetCurrentWeather`, `GetOutgoingWeather`, `GetCurrentWeatherTransition` read the state.
- `Weather.FindWeather(class)` (0 pleasant, 1 cloudy, 2 rainy, 3 snow): of the region's list
  (the interior's sky region first), else the climate's, the weather of that class with the
  _lowest_ chance (the first of equals); a region without weathers finds none.
- `ts` (ToggleSky) turns the sky off (mode none: no dome, clouds, sky objects or rain) and
  back to the place's mode.

**Modes** (`Weather.GetSkyMode`): outside the full sky (3); a worldspace with its own
lighting template (WRLD LTMP) only the dome (2), or none of it as an interior (1) if it also
has No Sky. An interior has no sky (1) unless it has Show Sky (CELL DATA `0x80`: the dome, 2;
with Use Sky Lighting `0x100` the full sky, 3). Without a sky the weather stands still: no
change begins and one under way waits, while game time passes; out again, the hours count and
the change is over at once. Most town interiors have Show Sky (Breezehome, the Sleeping
Giant Inn, Dragonsreach), so their weather runs on with their sky region's list.

**The record's colours and cloud layers** (`src/world/weather.ts parseWeather`, observed in
the original's WTHR loading). Every colour starts black and NAM0 fills what it holds (17
colours × 4 times of day in 98 vanilla weathers; 14 in the ten old FX weathers, form version
35). A NAM0 of at most twelve colours gives the far fog the near fog's colours; a record older
than form version 36 has a white water multiplier; NAM3 then gives the sun glare's four colours
and NAM2 the moon glare's (only the ten FX weathers carry them, all white). An effect lighting
colour whose four bytes are all zero takes the sunlight's colour of that time (six weathers).
LNAM is the weather's cloud layer count (29 in every weather with clouds, 4 in the FX weathers,
which have none); no vanilla weather names a cloud texture past it, and ours leaves such layers
out.

**Conditions:** `GetIsCurrentWeather` (a weather, or any of a form list's),
`GetCurrentWeatherPercent` (the transition), `GetWindSpeed`; `IsRaining` / `IsSnowing` hold
once the current weather of that class is past its precipitation fade-in (DATA byte 6) or
while the outgoing one of that class is short of its fade-out (byte 7), both × 0.999 as the
engine scales them; `IsPleasant` / `IsCloudy` are the share of the class: the transition if
the current weather has it plus the rest if the outgoing one has it.

Not read yet: a game-wide state flag the update consults (it lets the weather run in an
interior and keeps a change's start time; most likely the load or reset state); and where the
engine sets its fast-travel state (we set it for the map's fast travel). TODO(M13). Drawing
the dome in interiors with Show Sky (mode 2) and the sky objects in mode 2 worldspaces is
TODO(M13) in the renderer; the state and its weather are as the engine's there.

## Water

The water shader (`shaders/water.wgsl`; the WATR values it reads:
[formats/esm.md](formats/esm.md#water)) and the water's displacement field.

**Under water** (`src/world/underwater.ts`, observed in the original). Each frame the four
corners of the camera's near plane are measured against the water at the camera
(`nearPlaneWater`, from the inverse view-projection): all above, the view is above water; all
below, the underwater view covers the image; across, the engine draws the part of the screen
under the surface into its underwater mask (the ISUnderwaterMask pass: cleared, then a quad from
the line where the water's plane meets the near plane, turned by the camera's roll, down to the
screen's lower edge) and the underwater view applies there alone. The engine only tries this
with the camera under the water or within 15 units of a water's surface. A point's height on the
near plane is linear in its screen position, so ours passes the mask as a half-plane of the
screen (x · a + y · b + c below 0) and tests it per pixel instead of drawing a quad.

The underwater fog is an image pass, not the scene's fog (that stays the weather's or the
cell's): the depth of field effect turns on its fogged shader wholly under and its masked
fogged shader across. Their shaders (read from the shader cache) take the view depth from the
depth buffer and mix the image toward the fog colour by saturate((depth − near) / (far − near))
with the water type's underwater fog near and far planes (WATR DNAM); the masked one multiplies
that by the mask. Where the sky is not blurred, open sky (all nine depth taps at the far end)
reads the raw depth (1) as its distance and is barely fogged. The fog colour is the water's
shallow colour times the weather's water multiplier (sky colour 14; its alpha, 1, scales the
fog); indoors, with no weather, the shallow colour. The water type's underwater fog amount
reaches the shader's constants but is not read. Ours does the same in the depth of field pass
(`shaders/dof.wgsl`, on the tone-mapped image), running it for the underwater view even
without a depth of field.

The water type's own imagespace (WATR INAM: UnderwaterImageSpace, Dawnguard's
DLC1_UnderwaterImageSpace, the Soul Cairn's DLC01UnderLava01): wholly under, the depth of field
takes its values; across, the masked shader takes the scene's depth of field outside the mask
and the water imagespace's inside it (one blurred copy, at the scene's radius). Five water types
name no imagespace (DefaultWaterCold among them): no depth of field inside the mask there.
`node tools/water-info.ts --underwater` lists each type's fog, planes and imagespace. Ours
takes the water imagespace's depth of field (its strength, distance, range, sides and blur
radius) in place of the scene's once the near plane is wholly under (`underwaterImageSpace`).
Observed in the original: the image-space manager keeps the water's imagespace as a base data of
its own, set when the camera's water changes; the scene's base data is the weather's (or the
cell's) and is what the HDR, cinematic and tint passes read, with the modifiers; the water's is
read only by the depth of field and its switch. So its HDR, saturation, brightness, contrast and
tint (UnderwaterImageSpace: saturation 0.8, tint 0.1) never apply.

**Which water.** A cell's water is its XCWT type, else its world's water (NAM2, from the
parent world when the world takes its water from it), at its XCLW height, else the world's
default; LOD water takes the world's NAM3; water meshes take their activator's WNAM, else
DefaultWater. The weather's water multiplier (its colour 14, by time of day and through
transitions) tints the water's body and reflection colour; interiors have none (white). On
the data: Riverwood's river is RiverWaterFlow at −250 (cells 2..6, −13..−10, with flow maps),
Lake Ilinalta RiverWaterFlow at 600 (cells −12..−1, −14..−12; a few cells DefaultWater), the
sea at Solitude the world's DefaultWater at Tamriel's −14000 (DefaultWaterFlowBlend where the
Karth meets it). All three share DefaultWater's colours: shallow 38,39,24, deep 5,14,18,
reflection 119,140,157, fog −10..150 at 0.7, fresnel 0.1, reflectivity 0.8.

**The shader's terms** (`water-color.ts` is its colour model, for tests). The original's
shader cache (`shadersfx\shaders011.fxp` in Skyrim - Shaders.bsa: DirectX 11 bytecode, its
techniques' names stripped) holds 400 water pixel shaders; their terms, observed in the
original:

- **Depth.** From the scene's depth behind the water: the distance the view ray goes through
  the water, and how far that point lies under the surface's plane. Each as a share of the fog's
  far distance (saturated) drives the depth properties: the ray's for the reflections and the
  refraction, the vertical one for the normals and the specular (`property × (share − 1) + 1`).
- **Normal.** The first noise layer around the up axis by its amplitude (`a₁(n₁ − up) + up`),
  the other two added by theirs, normalized, then flattened towards up by the normals' depth
  share. Rivers (the flow-map techniques, which draw the first layer alone) take their flow
  normal (below) near the camera, and only they fade with distance: far away the normal
  gives way to the first layer's own normal by
  `saturate((d − 8192) / (F − 8192) × (1 − floor) + floor)`, F the water's noise
  falloff (clamped to 1..8191), the floor a frame constant that is 1 only in passes the engine
  flags for it and 0 in every pass that draws the world. The ripple field's normal
  (`normalize(slope × dampener, 0.04)`) takes the waves over by its own z.
- **Refraction.** The surface point moved along the normal's xy by the refraction magnitude
  (world units) times the refraction's depth share, projected; if what lies there is above the
  water, the unmoved point. The body colour is shallow towards deep by the ray's depth share;
  the fog over the scene below is `1 − ((far − depth) / (far − near))^p`, p = max(4 × Fog
  Amount, 1).
- **Reflection.** The cube (below) along the view reflected about the normal flattened towards
  up by the Reflection Magnitude (DefaultWater 0.42), the screen-space reflection over it by
  its own alpha (and the detail), then the reflection colour taken over by that by the
  Reflectivity Amount (DefaultWater 0.8: 20 % reflection colour). The reflection lays over the
  refraction by Schlick's fresnel from the Fresnel Amount, times the reflections' depth share
  (far away it goes to 1).
- **Sun.** `pow(saturate(reflected view · sun), specular power) × specular magnitude` plus the
  sparkle `pow(saturate(normal · (−0.099, −0.099, 0.99)), sparkle power) × sparkle magnitude`
  (a fixed slant of the up axis, not the sun), times the sun's colour and the specular's depth
  share; then the air's fog.

**The material setup** (observed in the original): which WATR value the engine's water material
hands each of the shader's constants. DNAM by xEdit's names:

| Shader constant           | From                                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shallow, deep, reflection | Shallow, Deep, Reflection Color (/255), times a colour the frame sets (ours: the weather's water multiplier); w: Sun Sparkle Power, Sun Specular Magnitude |
| fresnel                   | Fresnel Amount; Specular Power, max(0.1 × DNAM 41, 1) for the lights' specular                                                                             |
| blend radius              | the flow map scale (Noise Flowmap Scale), Specular Radius                                                                                                  |
| amounts                   | Sun Specular Power, Reflectivity Amount, ANAM / 100 (opacity), Refraction Magnitude                                                                        |
| amplitudes                | the three Amplitude Scales, the Displacement Dampener                                                                                                      |
| water parameters          | Noise Falloff (clamped 1..8191), Reflection Magnitude, Sun Sparkle Magnitude, the scene colour scale                                                       |
| fog                       | Fog Far (at least 1) and far − near (1e-5 if 0); the exponent max(4 × Fog Amount, 1); the air's fog colours                                                |
| depth control             | the four Depth Properties                                                                                                                                  |
| (vertex) noise layers     | the three UV Scales; the wind scrolls them                                                                                                                 |

Specular Brightness (DNAM 42) is copied into the material and handed to no constant. The opacity
takes part only in the techniques without the scene's depth (there it stands for the water's
deepness). The scene colours the shader samples (refraction, cube, screen-space reflection) are
scaled by one constant and the result by another (the original's frame buffer range; ours keeps
linear colour throughout).

**Rivers' flow normals** (WATR NAM5, observed in the original's flow-map techniques; ours
`water.wgsl flowNormal`, `flow-map.ts flowTaps`). Where the flow map lies: the engine joins the
flow maps of the loaded grid (uGridsToLoad cells a side, 64 texels a cell: all 641 maps of the
data are 64 × 64, `node tools/flow-maps.ts`) into one texture, a cell's slot by its column from
the west and its row from the south; the cell water's own coordinate runs 0..1 over the cell with
north at the top, and reads the composite at ((u + column) / cells, (v + cells − 1 − row) / cells)
(`flowCompositeAt`). The flow normals' coordinate is the cell's coordinate plus its grid position
(x, −y): it runs on across cells. What is drawn: the flow map is read four times, at the point
and half a texel east, south and south-east, each tap weighted by the tents
`1 − |2 frac(64·u) − 1|` across and down (a tap counts most at its texel's centre); each tap's
direction (red, green around 128) turns the flow normals' coordinate, 64 a cell times
√(1.01 − the tap's blue), into the flow's frame, where it moves by the time (seconds) × the tap's
alpha × its own rate (8, 8.48, 10.64, 9.92 at offsets 0, 0.62, 0.27, 0); the four NAM5 normals' xy
(− 0.5) are blended by the tents, divided by `√(w² + (1 − w)²)` per axis, times max(normals'
depth share, 0.4), z completing the unit normal. Those techniques draw one noise layer: near the
camera the water's normal is the flow normal, giving way to the first noise layer's own normal
by the noise falloff (the distance fade above). Ours binds each cell's own map clamped to its
texels: the same texels, except along a cell's north and east edges, where the original's taps
half a texel over read the neighbouring cell's.

**Reflections** (`water-reflection.ts`). Every water technique in the cache samples a cube;
none samples a planar reflection texture. The rendered cube holds what [Water] in the INI
reflects, all on by default: the sky (bReflectSky), land and its LOD (bReflectLODLand), tree LOD
(bReflectLODTrees), object LOD (bReflectLODObjects); the references flagged Reflected By Auto
Water (REFR flag bit 28: 17 in the load order, 16 of them in exteriors; XPWR entries name only
refracting waters) are drawn only by the plane reflections (below). The original's cube, observed
in the original: 512 texels a side in half floats with one sample, six faces, two of them redrawn
each frame (fCubeMapRefreshRate 0: no pause between rounds), so the whole cube every three
frames; after each round its faces are reordered by the time each took, so a frame pairs a
costly face with a cheap one; at most six cubes are redrawn in a frame. Ours: five faces (none
looks down) as layers of a 2D array with their matrices for the lookup, 256 texels a side with
four samples (as many samples a face as the original's); one face a frame in all, two while a
reflection has faces due (a new plane's, never all five in one frame), the frame's faces shared
out among the reflections in view in turn; the water shows a reflection once every face holds a
drawing. A plane's reflection is drawn from the camera mirrored under its plane (seen from there,
the straight line through a water point continues as the reflected view ray), what lies under the
plane clipped (`frame.wgsl reflectionClipped`). Each face draws only what lies in its own view:
the land's quadrants, the tree LOD blocks (each block with a sphere round its trees, grown by its
largest billboard), the sky and the reflected draws, listed once per scene (`GpuScene.reflected`,
as the water draws are, `GpuScene.water`). `Renderer.reflectionStats` counts each frame's faces,
land quadrants, tree blocks, draws and recording time.

**Cube maps in place of the reflection** (observed in the original, with [Water]
bUseCubeMapReflections, on by default): water reflects a cube map file instead of a rendered
cube where its world (WRLD XWEM: the Forebears' Holdout, the Ancestors' Glade, Apocrypha) or
its interior cell (CELL XWEM: 81 cells, 78 of whose files exist; `node tools/water-info.ts
--environment`) names one that exists. Interior water without one gets no reflection cube at
all (ours: the cube reads black, so the reflection colour shows by 1 − reflectivity); outdoors
without one, the rendered cube (below).

**Which water gets which reflection** (observed in the original, as water is added;
`planReflections`). With [Water] bUseCubeMapReflections (on by default) all water shares one
reflection: the cube map file its world or cell names (above), else one cube rendered around the
player's eyes (their head, not mirrored), drawing the sky and the LOD by the switches above; the
water's height plays no part. Indoors that cube has no world to draw (the water shows its clear
colour; ours: black). With the setting off the reflections are of planes: outdoors, water at its
world's LOD water height (WRLD NAM4, within 0.01) shares one reflection of that plane that draws
the sky, the LOD scene and the references flagged to be reflected; all water at any other height
shares a single second reflection that draws the sky alone (the first such water's plane); so two
at most, which is uMaxExteriorWaterReflections (2). Indoors each plane (its normal and height,
within 0.01) has its own reflection of the flagged references alone (no sky, no LOD), at most
uMaxInteriorWaterReflections (4); the cell's cube file is not used then.
fExteriorWaterReflectionThreshold and fInteriorWaterReflectionThreshold are read from the INI and
used by nothing. [Water] bForceHighDetailReflections draws the full scene in all of them. Ours
builds both: each reflection has its own faces and the water frame a binding per reflection, each
water binding its plane's. TODO(M13): what a plane past the interior's four takes, whether a
world using its parent's data takes the parent's LOD water height, whether the reflection is
fogged (ours leaves deferred lit objects unfogged) and bForceHighDetailReflections are open.

**Displacement** (`water-displacement.ts`, `water-displacement-gpu.ts`,
`shaders/water-displacement.wgsl`): the surface's interactive ripples, as observed in the
original.

- A height field on a grid fWadingWaterQuadSize (2048) units across and
  fWadingWaterTextureRes (512) texels a side ([Water] in the INI; Skyrim_Default.ini sets
  neither), centred on the camera. The centre moves in whole 4-unit steps once the camera is
  more than 4 units from it, and the field moves with it, so ripples stay where they are.
- Every frame, each actor in the water (wading or swimming at the surface) stamps a ripple
  along its way since the last frame. A splash (an actor or a body entering or leaving the
  water) and a projectile (arrow or spell) passing through the surface stamp a small one
  (scale 0.01) at its point, with bUseBulletWaterDisplacements, within fWadingWaterQuadSize of
  the centre. bUseWaterDisplacements turns it all off.
- The field steps at a fixed 0.025 seconds, as many steps as the frame's time holds (ours: at
  most 8 a frame).
- Two layers, wading and rain, run side by side with four values each: force, velocity,
  falloff and starting size. The wading values are set every frame to 0.2, 1.7, 0.99 and 0.01;
  the rain values are 0.1, 0.6, 0.985 and 0.01 — the vanilla water types' rain simulator
  values. The water types' Displacement Simulator values do not drive the simulation.
- After 10 seconds without a ripple the simulation stops; the next ripple starts it from a
  still surface.

Our reading of the values (TODO(M13): the simulation's shaders are not readable): a ripple
pushes the surface down by its force along its way, with a soft round brush starting size ×
half the grid wide (10 units); a step is the damped wave equation `next = ((2 − v)·h +
(v / 4)·Σ neighbours − previous) · falloff` (stable for velocity v up to 2), heights kept
within ±0.5 (an actor standing still stamps every frame). Rain drops fall
at random over the grid, 4 a step at full rain (TODO(M13): the original's rain pattern). The
field's slopes bend the water's normals, times 2 per texel (TODO(M13): the original's scale)
and times the water type's Displacement Dampener (WATR 22: 0.98 for most water, 0 in the
horse troughs: no ripples there; TODO(M13): how the original's material uses it), fading out
at the grid's edge, and by the depth properties' share of the normals as the waves are.
Interiors run the same field (no sky there: the water frame carries the field alone).

## Precipitation

Rain and snow (`precipitation.ts`, `shaders/precipitation.wgsl`), as the engine's particle
shader does it: a box of the SPGD's size around the camera holds density × 1024 particles
(at most 65536). Each particle has a fixed place in an endless lattice that falls with the
gravity velocity and drifts with the weather's wind (rain 15%, snow 50% of it); the copy
inside the box around the camera is drawn, fading near the box's faces where particles wrap.
Rain is a streak along the fall (as long as its size plus a frame's fall at 30 fps), snow a
camera-facing quad that turns and circles its fall line (centre offset min..max). Each
particle shows one random frame of the texture's atlas, lit by the ambient light from above
and half the sunlight, faded where it nears the opaque scene, fogged.

**Occlusion** (no rain under roofs): the scene's shadow casters and the terrain rendered from
straight above around the camera (orthographic, ±8192 units in height) into layer 4 of the
shadow map — redrawn when the camera moves a quarter of the map or every 120 frames. A
particle below anything in that map is hidden. Snow quads reach the SPGD size in world units
from their centre (the engine offsets the corners in clip space by size × the projection
scale, CS Particle.hlsl ENVCUBE); rain drops are scaled × 50 to match the texture's thin line:
TODO(M13) calibrate rain against the original.

## First person

The engine draws the first-person geometry (the arms, the weapon, a torch, an animation object
in the hands) through a camera of its own over the world: first person's field of view
(`[Display] fDefault1stPersonFOV`, the console's second `fov` value) and a near plane of its
own (`[Display] fNear1stPersonDistance`, 5 units), drawn into the nearest
`[Display] f1stPersonFarDepthRange` (0.01) of the depth range (observed in the original). Here
those instances carry `ModelInstance.firstPerson`; their draws get the
`DRAW_FIRST_PERSON` flag (a bit the NiAlphaProperty flags leave unused) and are never culled.
`objectVertex` (common.wgsl) projects them with `frame.firstPersonViewProj` (the player's view
with first person's projection, src/render/first-person-view.ts: its field of view and near
plane read from the INI, `fNear1stPersonDistance` among the INI defaults; checked in the
headless simulation, tests/conformance/animation/actor-build.test.ts) and moves their reversed-Z
depth linearly into the band `[0.99, 1]`. The player's controller keeps the eye farther than the
world's near plane (`fNearDistance` 15) from any wall, and a wall at 15.15 units already has
depth 0.99: the arms never sink into a wall, and still hide their own far sides (the band is
linear in clip space, so it interpolates as depth does). The first-person instance's particle
systems (a spell in the hand, a torch's flame, an enchanted weapon's) are drawn the same way
(particle.wgsl). A bow's zoom, the dialogue zoom and the tween menu narrow the world's view
only. TODO(M13): the composite reads the arms' depth as about 15 units away (fog, ambient
occlusion).

## Cameras

The player camera has the engine's states (CommonLibSSE `PlayerCamera::CameraStates`;
src/shell/camera-states.ts), worked out each frame by precedence: a kill camera (VATS: the
killmove and ranged kill cameras, src/shell/killmove-camera.ts), the free camera, the tween
menu's, an animated camera (StartAnimatedCamera), bleedout, furniture, auto vanity, a dragon's
back, then first person, or third person, or a mount's. Riding a horse the third-person camera
takes `fOverShoulderHorse{PosX,AddY,PosZ}` (the engine's 0, -300, 0), and while the horse moves
its turns take the view along once it is more than `[Camera] fHorseMaxAngleBeforeTurn` (the
engine's 90°) from the horse's heading (`horseViewYaw`; TODO(M13): inferred, the dragon camera's
rule for a horse-like mount below with the horse's setting); on a dragon it is
always third person, zoomed between `fVanityModeMinDistFly` and `fVanityModeMaxDist` ×
`fVanityModeMaxDistFlyMult`.

The dragon's camera (DragonCameraState, observed in the original): its shoulder offsets are
`[Camera] fOverShoulderDragon{PosX,AddY,PosZ}` (0, -600, 0), with a weapon or spell drawn the
GMSTs `fOverShoulderRangedDragon{PosX,AddY,PosZ}` (0, -150, 90). Its heading is kept as the
player's turn about the dragon's heading, so the view turns with the dragon. Only a moving mount
that is horse-like (the ActorTypeHorse keyword, or a race that tilts front to back) holds the
view's heading in the world as it turns, at most `fDragonMaxAngleBeforeTurn` (90°) from its
heading; no vanilla dragon is. When the player has locked the dragon on a target, the view
looks from the player at that target instead; every change between the free view and a locked
one (a lock, a new target, the lock let go) eases over `fDragonCameraDollyTime` (0.75 s), the
heading and pitch each a straight blend from where the view was going. A locked target that
dies, is disabled or unloaded gives way to the next, none left lets the lock go.
`bDragonCameraTargetPlayer` (1) keeps the camera on the player; at 0 it hangs on the dragon while
nothing is locked. The lock itself (src/shell/dragon-target-lock.ts, observed in the original):
Jump locks, gathering the actors within `[Gameplay] fTargetLockXYRange` (7500) of the rider across
the ground (living, loaded and enabled, not the rider or their mount) nearest first by their
distance in space, and takes the first; with `bTargetLockIsToggle` (1) the next press lets go,
at 0 the lock holds while Jump does. Hotkey1 and Hotkey2 step back and on through that list
round its ends (in place of their favorites) while the lock holds. The engine's gathering also
leaves out children (their race's flag), the unconscious and the essential who are down, and
takes only actors in an attached cell with a high-level AI process (ours: those on the stage).

The kill cameras' shots play their camera models (meshes\cameras\*.nif, src/render/camera-model.ts):
an NiCamera under its root, the root's place in the shot's frame moved by its own
NiTransformController (keys, or an NiPathInterpolator path: base.nif, baseleft.nif) from the
shot's start, the field of view by the NiCamera's BSFrustumFOVController (its value the frustum's
right edge, the tangent of half the horizontal angle; the top edge keeps its ratio). The models'
root turns hold small turns about looking at the shot's target (their Max camera's -Z); the
camera looks at the target. TODO(M13): how the engine adds those turns, and the bone a shot's
location is measured from. The auto vanity camera starts after `fAutoVanityModeDelay` seconds
without a key, the mouse or movement (not in combat, a menu, a conversation or on a mount; never
with `bDisableAutoVanityMode`, at once with `bForceAutoVanityMode`) and circles the player
`fDefaultAutoVanityZoom` units away, `fAutoVanityIncrement` radians a 60th of a second; any
input ends it, back to the point of view it came from. The camera's shake
(src/shell/camera-shake.ts) comes from the graphs' CameraShake event and Game.ShakeCamera.

## Memory

The session keeps the models and textures it loads (`game-session.ts`, `texture-cache.ts`)
and counts their GPU bytes (vertex and index buffers; all mips of every texture); the status
bar shows the total against the budget (`MEMORY_BUDGET`, 2 GiB). Scenes and grass fields hold
the models they draw, models hold the textures they bind. While cells stream in and out the
world viewer trims the session four times a second: over budget, the least recently used
models that nothing draws are freed (they let go of their textures), then the textures no
model holds, down to 85% of the budget. Anything used in the last 10 seconds stays (a cell
may be about to place it), as do models attached to others as add-ons and textures never
held by a model (terrain, sky, water, decals, precipitation: few and shared). Freed models and
textures load again when a cell needs them.

## Frame time

Most of the engine's game logic is `async` code over cached records: once its reads are cached,
a whole search (a quest's alias over the loaded area, the actors away asked where their
packages have them) runs in microtasks within one task, and the browser draws no frame until it
ends. Lines and quest updates were where that showed: as a scene's line set a stage, the quests
it started searched the loaded area's ~2,000 references, and the page stood still for up to 8 s
in the opening's cart. Measured in the browser (headless Chrome, a CPU profile and the
long-animation-frame entries over the cart ride from Ralof's first line, 90 s):

|        | worst frame | frames > 50 ms | > 100 ms | 95th / 99th percentile | non-frame work ≥ 30 ms |
| ------ | ----------- | -------------- | -------- | ---------------------- | ---------------------- |
| before | 8,013 ms    | 184            | 35       | 61 / 111 ms            | 38 stretches           |
| after  | 639 ms      | 78             | 5        | 39 / 56 ms             | 3 (at most 43 ms)      |

What changed, and why:

- **Lookups by reference** (`world-viewer.ts`): a reference's live placement, node, graph and
  whether it is loaded were found by searching every loaded cell's objects (Is3DLoaded built
  every cell's list of references for each call). Conditions ask them of every candidate
  (GetInCurrentLocation through the reference's placement): each cell's objects are now
  indexed by reference once per list.
- **Conditions** stop at the first failed AND, and who an alias holds and its factions are kept
  per reference (docs/scripting.md, "Conditions", "Quests").
- **Searches give way** after 4 ms of work (`PapyrusScheduler.giveWay`, the browser's next task
  through a message channel): a quest's alias search and the actors away's runs spread over a
  few frames instead of holding one.
- **Routes** (docs/ai.md, "Routes"): a door is queued again only by a cheaper way (17 → 3.5 ms
  a search); the compass's quest door and the actors away route on the main thread.
- **Actors away**: a worldspace's actors are found in its persistent cell once (200 ms each
  run before).

After `setstage MQ102 10` in Riverwood (a quest completed, an objective and its compass marker
shown, the player moved, the actors away asked again) the longest stretches outside the frame
went from 204 ms (actors away), 159, 149, 119 and 94 ms (routes) to 66 ms (the player's move)
and 36 ms; what is left above 50 ms is Ruffle starting the titles and fader menus' players
(AudioContext, WebGL shaders: ~100 ms each).

Voice lines are decoded in the audio worker (docs/audio.md) and subtitles and quest
notifications cost the HUD's Ruffle player a few ms (it runs ~100 ms a second for its three
players whatever they show); neither showed as a long task. Twice the first line of the opening
was followed by a frame of 600–870 ms with the main thread idle (no script, no long task): the
headless browser's GPU process presenting late, as it did every 3 s for a while in another run
(`DXGISwapChainImageBacking::Present` blocking 450 ms in a trace). It did not come back under a
trace: TODO(M13): check on the maintainer's GPU whether the first line's frame stalls there.

### Draw submission

The frame is bound by the main thread, not the GPU: in the QA scenes (headless Chrome, a CPU
profile over 20 s) the page is idle about 1 % of the time, and of the rest about a third is the
renderer handing draws to WebGPU. Each draw costs a few calls (pipeline, material, mesh, the
draw's uniforms by dynamic offset, bones), and the per-object light lists, the TAA's velocity
pass and the focus shadows each added a walk over the draws or more calls per draw. In
Riverwood at 13:00 (`tools/qa-run.ts riverwood`, 60 s) that took the page from about 100 fps to
about 90. What keeps it down (`scene-renderer.ts`):

- Dynamic offsets go to `setBindGroup` as a `Uint32Array` with a start and a length. Handed a
  new JS array per draw, the browser converts a sequence each time: `setBindGroup` was 10 % of
  the main thread, 6 % after.
- A scene keeps a bound round its draws (`GpuScene.bound`, worked out again only after one of
  them moved): every pass leaves a scene outside its view without testing its draws. The focus
  maps and the near cascades see few of the loaded cells.
- Shadow passes walk only a scene's casters (`GpuScene.shadowCasters`), ordered by pipeline,
  material and mesh so that instances of one model follow each other (a depth-only pass ends the
  same in any order), and rebind the material only for alpha-tested casters: the others never
  read it, and every caster's material group has the same layout.
- The focus maps sort their casters out in one walk over the draws, not one per map.
- The velocity pass draws only the moving draws that moved since the last frame: the motion of
  one that did not is the camera's, which the TAA finds again through the depth. First person's
  geometry has its own view and is always drawn. A skinned draw whose palette was rewritten is
  drawn too: each palette keeps its last frame's copy (written once per frame, before the new
  pose), and the velocity shader skins the vertex under both, so moving limbs show their motion.
- An animated draw's uniforms go up only when its matrix, its hidden state or its animated
  material changed (an actor standing still keeps its parts' matrices; its pose goes to the
  bone palette).
- The world map's relief overlay (six samples of two normal maps) is compiled into LOD land's
  pipelines only (`LOD_LAND`, an override constant of `lighting.wgsl`): a branch skipped at run
  time still sizes the registers of the whole shader, and every other lit pipeline (all the
  objects of the Whiterun exterior) now compiles without it. The water's reflection costs
  one 256² face a frame (sky, land, LOD, a few references) once all five are drawn.

### Frame budget

Measured with the QA runner (docs/qa.md: `whiterun-day`, `riverwood` and the `streaming`
flight, 60 s each, `--cpu-profile` for the breakdown; headless Chrome on a shared machine, so
only runs on the same setup compare). The page is bound by the main thread: it idles 0.1 % of
the time. Where a Whiterun market frame went (CPU profile, share of the main thread):

| part                                                                 | share |
| -------------------------------------------------------------------- | ----: |
| physics step (actors' character controllers 11 %, Rapier's step 5 %) |  18 % |
| actors (behavior graphs and skeletons 8 %, movers 5 %, the rest)     |  19 % |
| `SceneRenderer.animate` (placed controllers, bone palettes, fades)   |  16 % |
| sun shadow cascades (draw submission)                                |   8 % |
| opaque pass (culling, light lists, draw submission)                  |   6 % |
| Ruffle (the HUD's players)                                           |   6 % |
| particles, water reflection, velocity, blended pass, lens flare      |   6 % |

A Riverwood frame records about 3,700 draws in 51 passes: 6,500 `setBindGroup`, 3,300
`setVertexBuffer`, 2,900 `setIndexBuffer` and 1,100 `setPipeline` calls; 7,244 draws are
loaded (5,102 shadow casters, 1,528 animated: 600 actor parts, 641 placed controllers).

What changed:

- **Shadow casters by cluster in render bundles** (`#sceneCasters`, `#clusterBundle`): a
  scene's casters that do not move are grouped by 1024-unit squares; each group is recorded
  for a shadow layer once, as a `GPURenderBundle`, and replayed while the same casters are drawn
  (the hash of which are shown, not faded out and big enough for the layer changes when a
  reference is enabled or fades). A group in the layer's box is drawn whole: a depth-only pass
  ends the same in any order and a caster outside the box is clipped there, so the map is the
  same. Moving casters (actors, simulated clutter) are drawn one by one as before, and so is a
  group whose casters have not stayed the same for 30 passes of the layer (`BUNDLE_SETTLE`):
  in the streaming flight, recording a bundle for every passing set (cells just loaded, objects
  fading at the loaded area's edge) cost more than it saved.
- **One shape for every draw**: `Draw` and `AnimatedDraw` were built with optional fields
  spread in, up to 2⁷ object shapes, and every pass's walk over thousands of them read their
  fields through megamorphic lookups. All fields are now always set (undefined where absent).
  An animated draw keeps its uniform view instead of making one each frame.
- **Bone palette uploads in runs**: an actor's parts' palettes lie side by side; the rewritten
  ones and their last frame's copies go up in one `writeBuffer` each per scene (two per skinned
  part before).
- **Occluders by scene**: every opaque draw was tested against every occlusion volume turned to
  the camera; a scene's bound first picks the volumes that can hide anything in it
  (`RoomCuller.focus`), most cells keeping none.
- `multiply` is unrolled and writes into either operand without a scratch matrix; an object
  fade's range is worked out again only when the fade settings change; the controllers'
  evaluation asks each node once whether it or one above it moved (it walked to the root for
  every node).

Before, and two runs after (the second with BUNDLE_SETTLE; the machine was shared with other
browsers, and the second run's streaming flight came first, its shaders not yet compiled):

| scenario     | run    | fps  | p50 (ms) | p95 (ms) | p99 (ms) | > 33 ms | > 50 ms |
| ------------ | ------ | ---- | -------- | -------- | -------- | ------- | ------- |
| whiterun-day | before | 51.2 | 16.7     | 27.8     | 33.4     | 31      | 6       |
|              | after  | 72.4 | 11.2     | 22.2     | 33.3     | 20      | 3       |
|              | after² | 56.1 | 16.7     | 27.8     | 38.9     | 39      | 5       |
| riverwood    | before | 79.1 | 11.1     | 16.8     | 22.3     | 5       | 3       |
|              | after  | 91.5 | 11.1     | 16.8     | 22.3     | 7       | 3       |
|              | after² | 89.1 | 11.1     | 16.8     | 22.3     | 7       | 3       |
| streaming    | before | 92.2 | 11.1     | 22.2     | 33.4     | 51      | 16      |
|              | after  | 82.4 | 11.1     | 22.2     | 38.9     | 62      | 18      |
|              | after² | 65.9 | 11.2     | 27.8     | 44.5     | 93      | 36      |

What is left (TODO(M13)): the opaque pass still binds and draws each draw (the same bundles
would need the light lists chosen per draw and the room and occluder culling per cluster); the
physics step and the actors' graphs (others' areas) are the largest parts now.

#### Streaming

A `streaming --cpu-profile` run (Chrome warmed by `riverwood` first) split into frames (from
one start of the render loop's callback to the next) showed what held the 46 frames of 33 ms
and more as cells came in: placing a cell's grass (`placeGrass` with `textureWeightsAt`: 20–50 ms
a cell, 600 ms of them), the first fit of each distance low-pass coefficient as sounds came in
range (`lowPassFor`: 20 ms a coefficient, 350 ms), removing a left cell's bodies from Rapier (up
to 30 ms a cell), then texture uploads, the cells' scenes, terrain, navmeshes and actors'
placement. Recording the shadow casters' render bundles was not among them: about 20 ms in the
whole minute (`BUNDLE_SETTLE` holds); hashing which casters a cluster draws costs more (0.4 %).

What changed:

- **Grass in the asset workers**: a cell's grass is placed and packed for the GPU (one
  `Float32Array` per type, `packGrass`) in a worker (`AssetLoader.placeGrass`, request kind
  `grass`); the main thread only makes the instance buffer.
- **Streaming work by turns** (`src/render/frame-work.ts`): a cell's load awaits
  `frameTurn()` before each step that holds the main thread (its terrain, its objects' instances,
  its scene, its decals, its navmesh, each grass field; every model's buffers and pipelines in
  `createModel`; every texture's upload, its mip levels written in slices of about 2 MB). Turns
  are given between frames, one step at a time, until the frame's 4 ms are spent
  (`FRAME_WORK_BUDGET_MS`, measured from a turn to the next turn: whatever ran meanwhile counts
  too); the rest waits for the next frame, as the original streams cells over several frames.
  Behind a loading screen (`setFrameWorkRush`), without a render loop (the headless simulation)
  or with no frame for 250 ms (a hidden tab) turns are given at once.
- **Bodies of left cells removed over frames**: `PlaySession.remove(group, later)` queues them;
  each frame removes at least one and goes on for 1 ms of the collision budget. They lie two cells
  and more from the player meanwhile; nothing draws or follows them. A load door's change of place
  and leaving the world remove at once.
- **The low-pass fit** (`distance-filter.ts`) takes each frequency's sines and cosines once and
  the biquad's coefficients once per trial: 1.7 ms a coefficient instead of 14 (Node), the same
  filters.
- **A scene's bound** (`GpuScene.bound`): its draws that never move are bounded once, and after a
  draw moved only the moving ones are, merged with that (`mergeBounds`); a cell with one moving
  draw walked all its draws every frame (`drawShadows`: 1.9 s → 1.6 s of the minute).

Before (main 1e15dcd0) and after, two runs each, `riverwood`, `streaming`, `whiterun-day` in
that order, 60 s each, no profiler, headless Chrome on the shared machine (its load varied:
`riverwood` alone went 106 → 111 fps in a back-to-back pair, `whiterun-day` 74 → 68):

| scenario     | run     | fps   | p50 (ms) | p95 (ms) | p99 (ms) | > 33 ms | > 50 ms |
| ------------ | ------- | ----- | -------- | -------- | -------- | ------- | ------- |
| streaming    | before  | 120.2 | 5.6      | 16.7     | 27.8     | 48      | 16      |
|              | before² | 108.0 | 5.6      | 16.7     | 33.3     | 47      | 17      |
|              | after   | 100.3 | 11.1     | 16.7     | 22.3     | 5       | 2       |
|              | after²  | 96.3  | 11.1     | 16.7     | 22.3     | 9       | 3       |
| riverwood    | before  | 116.1 | 11.0     | 11.2     | 16.8     | 8       | 1       |
|              | before² | 110.5 | 11.0     | 16.7     | 22.2     | 6       | 1       |
|              | after   | 98.3  | 11.1     | 16.7     | 16.8     | 5       | 1       |
|              | after²  | 98.7  | 11.1     | 16.7     | 16.8     | 3       | 0       |
| whiterun-day | before  | 86.0  | 11.1     | 16.7     | 22.3     | 7       | 1       |
|              | before² | 73.5  | 11.1     | 22.2     | 27.8     | 25      | 8       |
|              | after   | 62.8  | 16.7     | 22.3     | 27.8     | 7       | 3       |
|              | after²  | 68.1  | 11.2     | 22.3     | 33.3     | 23      | 3       |

The flight's long frames went from 47–48 to 5–9 (over 33 ms) and from 16–17 to 2–3 (over
50 ms), its p99 from 28–33 ms to 22 ms. The mean fps moved with the machine's load: the
profiles of the flight before and after spend the same 42 s of the minute in the render loop's
callback, over 6,116 frames before and 6,547 after. Profiled again, 6 frames of the flight are
over 33 ms; what holds them is no longer the streaming's own work (TODO(M13), others' areas:
`ActorsAway.#plan` routing actors away from the player through doors, an actor's placement
(`actors.ts` `place`, a new behavior graph), the HUD's Ruffle player, a music track's stream;
the records of a cell (`loadCellData`, zlib on the main thread) are read in 1–3 ms steps).

#### The main thread's CPU

Profiled warm (`riverwood`, `whiterun-day`, `streaming`, 55 s of each scenario's minute, twice),
the costs split as the table above has them; under them, the largest single waste was Rapier's
query shapes: every shape cast, intersection and contact test makes the query's shape anew in
Rapier's own form and frees it after (`Shape.intoRaw`), and for a convex hull that is the hull
computed again from its points. The actors' controllers (a round convex hull), their biped
bodies and most clutter are hulls, and their queries (`#insideControllers`, `#findCarrier`,
the trigger volumes and traps each actor reaches every frame) spent 3.6 % of a Whiterun market
frame on it, more than on the queries themselves.

What changed:

- **Query shapes made once** (`src/physics/query-shape.ts` `queryShape`): those queries hand
  Rapier a copy of the shape whose Rapier form is made at its first query and lent to every
  later one (its `free` does nothing; the form goes with the copy, by wasm-bindgen's
  finalizer). The same hull, the same answers; the character controller's step went from 1.9 to
  1.0 ms a Whiterun frame, the physics step from 3.3 to 1.9 ms.
- **The away actors' routes** (`ActorsAway.#plan`): the nearest navmesh and road marker are
  found by squared distances and the route's door search measures with a square root (both
  were `Math.hypot`, most of a 15 ms `findRoute`); the plan takes frame turns
  (`frameTurn`, src/render/frame-work.ts) before its ends, its route and its legs.
- **An actor's placement** (`actors.ts` `place`): its behavior graph is built, and run on by
  its own moment, in frame turns (20–25 ms in one frame before).
- **Animated draws** are uploaded only when their matrix or one of their animated material
  values changed (`writeAnimatedMaterial` says which, compared as the 32-bit uniforms hold
  them); every draw with an animation frame went up each frame.
- **`MagicEngine.aiState`** gathers an actor's effects' archetypes in one walk; it walked all
  active effects once per archetype for every loaded actor each frame (the invisibility veil
  asks it): 2 % of a Whiterun frame.

Per frame in the profiles (the render loop's callback; the machine shared, so its load moves
these too): Whiterun 14.8 → 10.7 ms (actors 3.7 → 2.9, `SceneRenderer.animate` 2.9 → 2.1),
Riverwood 9.5 → 7.2 ms. Before (main daebeb52) and after, two runs each, warm, 60 s, no
profiler, in the order `riverwood`, `whiterun-day`, `streaming`:

| scenario     | run     | fps   | p50 (ms) | p95 (ms) | p99 (ms) | > 33 ms | > 50 ms |
| ------------ | ------- | ----- | -------- | -------- | -------- | ------- | ------- |
| riverwood    | before  | 95.7  | 11.1     | 16.7     | 16.8     | 5       | 0       |
|              | before² | 94.4  | 11.1     | 16.7     | 22.2     | 5       | 0       |
|              | after   | 108.8 | 11.1     | 11.2     | 16.8     | 4       | 0       |
|              | after²  | 111.1 | 11.1     | 11.2     | 16.8     | 5       | 0       |
| whiterun-day | before  | 66.3  | 16.7     | 22.3     | 33.4     | 33      | 6       |
|              | before² | 59.5  | 16.7     | 22.3     | 27.9     | 15      | 2       |
|              | after   | 68.8  | 11.2     | 22.2     | 27.8     | 8       | 1       |
|              | after²  | 73.7  | 11.2     | 22.2     | 27.8     | 7       | 1       |
| streaming    | before  | 96.9  | 11.1     | 16.7     | 22.3     | 8       | 0       |
|              | before² | 94.6  | 11.1     | 16.7     | 22.3     | 7       | 2       |
|              | after   | 114.7 | 5.6      | 16.7     | 22.2     | 3       | 0       |
|              | after²  | 115.3 | 5.6      | 16.7     | 22.2     | 6       | 0       |

The profiled flight's frames over 33 ms went from 8–10 to 4–5; `#plan` and `place` are no
longer among them. What holds those left: the first reads of records (an idle tree, the
persistent actors, `#scheduleActor`'s package starts), conditions, and frames with no single
cause.

What is left (TODO(M13)):

- The actors' bodies following their poses (`ActorBodies.#follow`: the hierarchy controller for
  every biped body of every actor each frame, its math allocating) is 4.7 % of a Whiterun frame;
  behavior graphs and skeletons 9 %.
- The trigger and trap queries still ask Rapier's broadphase per actor each frame and per
  biped body every fourth (2.7 %); collision groups as a prefilter (the layers are ours, the
  predicate is a call back into JavaScript for every candidate) would drop most of the calls.
- The models' own controllers (`render/animation.ts` `evaluate`: maps and matrices made per
  model per frame) are 3–7 % (Riverwood's mill and water the most).
- The character controller's sweep runs for actors standing still; skipping it would change
  what they touch and their grounding, so it stays.
- The HUD's Ruffle player (6 %) is its own ActionScript running each frame, not its redraw.
- The music stream did not hold a frame in these runs (its decode stays where it is).

#### The main thread's CPU, round 4

Profiled warm the same way (`riverwood`, `whiterun-day`, `streaming`, 55 s each, twice). Per
rendered frame in the profiles, before → after (ms, the two passes averaged):

| part                                              | riverwood   | whiterun-day | streaming   |
| ------------------------------------------------- | ----------- | ------------ | ----------- |
| the HUD's Ruffle player (its own animation frame) | 0.75 → 0.34 | 1.03 → 0.51  | 0.79 → 0.29 |
| `ActorBodies.frame` (the bodies follow the poses) | 0.11 → 0.10 | 0.69 → 0.55  | 0.14 → 0.12 |
| trigger and trap queries                          | 0.12 → 0.07 | 0.53 → 0.31  | 0.12 → 0.08 |
| `#insideControllers`                              | 0.03 → 0.01 | 0.19 → 0.07  | 0.03 → 0.01 |
| `render/animation.ts` `evaluate`                  | 0.68 → 0.59 | 0.57 → 0.48  | 0.46 → 0.35 |

What changed (every result the same as before, as the tests and checks below say):

- **The HUD's player picked for the pointer every frame**: half of its time was not its
  ActionScript (0.7 % of a frame) but Ruffle's hover search: while a player believes the pointer
  is over its stage, each tick walks every clip of the movie asking each whether it has a button
  handler (`onPress`, `onRollOver`, ...), up its prototype chain. A player starts believing so,
  and a menu that takes no input (the HUD, the fader, the cursor: `pointer-events: none`) never
  gets the `pointerleave` that would tell it otherwise. `MenuHost` sends that event to such a
  player's canvas once its movie runs (`pointerLeft`); the search no longer runs (3.6 % → 0 of a
  Riverwood frame). The HUD's own scripts already run as the original's do: the engine sets its
  values when they change (hud-controller.ts compares before it calls), and what runs each frame
  is the movies' own `onEnterFrame` clips and the bridge's frame clock, too little to thin out.
- **Kinds of collider as Rapier collision groups** (`QueryGroups`, physics-world.ts): each
  collider's memberships say whether it is a trigger volume, a trap (L_TRAP, L_CLOUDTRAP), a
  character controller or other, set with its layer (`#setLayer`); every collider's filter takes
  all of them, so contacts and every other query are as without groups. The trigger, trap and
  controller-overlap queries pass their kind as `filterGroups`: Rapier passes the other colliders
  over before it calls the query's predicate back in JavaScript (most of their cost was those
  calls, one per candidate the broadphase found). The predicates stay, for colliders made
  without a layer.
- **The bodies following their poses** (`ActorBodies.#steer`): an actor's placement is made
  rigid once a frame, not once per body (`PhysicsWorld.bodyTargets`), and the node matrices,
  the rigid parts and the products go into matrices kept for it; a keyframed body's velocities
  (which it was driven at) are no longer read back from Rapier only to be replaced
  (`bodyFrame`). The hierarchy controller (`driveHierarchy`) works out a body's next place only
  when a child asks for it (most bodies are leaves), and its turn error only where a limit lets
  some of it through (never for a blend collision object's control); a random test of 20,000
  hierarchies (cycles of parents and every kind of gain among them) gave the same velocities to
  the bit.
- **The models' controllers** (`render/animation.ts`): a key search made a list of every key's
  time for each sample (most of a sample's cost); it searches the keys themselves. Only the
  subtrees of the moved objects are placed (each object of the model was asked whether one above
  it moved, every frame), from each model's children, found once. The weighted layers keep
  their sums by target instead of in string keys parsed back each frame, and the layers are
  evaluated as given (no list of every track made first). Checked against the old code on all
  1,796 animated models of the effects, architecture, clutter, dungeons, landscape and furniture
  meshes, 40 moments each with their own controllers, three sequences blended and a sequence
  played: the same frames; 22 → 15 µs an evaluation in Node.

Before (main 1d9c7db7) and after, two runs each, warm, 60 s, no profiler, in the order
`riverwood`, `whiterun-day`, `streaming` (headless Chrome on the shared machine):

| scenario     | run     | fps   | p50 (ms) | p95 (ms) | p99 (ms) | > 33 ms | > 50 ms |
| ------------ | ------- | ----- | -------- | -------- | -------- | ------- | ------- |
| riverwood    | before  | 95.5  | 11.1     | 16.7     | 16.8     | 5       | 1       |
|              | before² | 105.7 | 11.1     | 16.7     | 16.8     | 4       | 0       |
|              | after   | 114.8 | 11.0     | 11.2     | 16.8     | 7       | 1       |
|              | after²  | 99.5  | 11.1     | 16.7     | 16.8     | 8       | 1       |
| whiterun-day | before  | 63.6  | 16.7     | 22.3     | 33.3     | 19      | 4       |
|              | before² | 61.6  | 16.7     | 22.3     | 27.8     | 9       | 4       |
|              | after   | 68.8  | 16.5     | 22.2     | 27.8     | 7       | 2       |
|              | after²  | 68.6  | 16.6     | 22.2     | 27.8     | 8       | 3       |
| streaming    | before  | 100.0 | 11.1     | 16.7     | 22.3     | 7       | 0       |
|              | before² | 99.5  | 11.1     | 16.7     | 22.3     | 5       | 1       |
|              | after   | 116.8 | 5.6      | 16.7     | 16.9     | 5       | 2       |
|              | after²  | 112.6 | 5.6      | 16.7     | 22.2     | 4       | 1       |

Whiterun's market went from 62–64 to 69 fps and its frames over 33 ms from 9–19 to 7–8; the
flight from 100 to 113–117 fps. Riverwood moved with the machine's load (its runs 95–115 fps
before and after alike); its long frames are single ones with no common cause.

What is left (TODO(M13)):

- The opaque pass still binds and draws each draw; render bundles there need the light lists
  chosen per draw and the room and occluder culling (`RoomCuller.visible`: 2–3 % of a frame, the
  most of it the occluders' planes per draw) per cluster.
- The models' controllers are still 0.5–0.6 ms a frame: the behavior graphs' sequences of
  Riverwood's objects (`graphFrame`) sample each of their tracks every frame.
- The hierarchy controller's quaternion math (`rotationVector`, `integrate`) and the reads of
  each body's place from Rapier are most of what is left of `ActorBodies.frame`.
- The character controller's own sweep calls its predicate back in JavaScript for every
  candidate (`touching`: 0.6 % of a Whiterun frame); its filter is the layer matrix, which the
  16 bits of a collision group cannot hold.

#### The opaque pass in render bundles, round 5

The opaque pass bound and drew each draw every frame: in a Riverwood frame 1.7 ms of the main
thread (15 % of it), most of it the calls into WebGPU (`setBindGroup` alone 0.6 ms) and the
occluders' planes per draw (`RoomCuller.visible`, 0.4 ms). The draws' light lists were already
replayable: each draw's list lies in the scene's `draw-lights` storage buffer at the draw's slot
(flags.w bits 8-23), written when it is chosen, so a recorded draw reads whatever list was chosen
for it this frame.

What changed (the image the same: the same draws, lights, fades and depth state):

- **Opaque draws by cluster in render bundles** (`#sceneOpaque`, `#opaqueBundle`,
  `src/render/draw-clusters.ts`): a scene's opaque draws that never move are grouped by
  1024-unit squares as the shadow casters are (one `groupBySquare` and one `BundleSlot` for
  both). Per view (its frame bind group) a cluster in the frustum is recorded once as a
  `GPURenderBundle` of the draws it draws now (shown, not faded out, not fading by blending, not
  hidden by a room or an occluder) and replayed while that set holds; a set that has not stayed
  for `BUNDLE_SETTLE` passes is drawn one by one, as before. Draws of the cluster outside the
  frustum are recorded too (the GPU clips them; the set then does not change as the camera
  turns); those in it take their lights and mark their fades seen as before. The bundles of a
  scene go after its unsettled clusters' draws and before its loose draws: moving ones, the sky's
  and first person's, object LOD (its segments follow the loaded cells), actors' parts and shapes
  without Zbuffer_Test, whose result depends on the order of the draws (every bundled draw is
  depth tested and writes depth, so only exact ties of depth could come out otherwise). Only the
  opaque pass is bundled; the blended pass keeps its order.
- **Rooms and occluders per cluster**: `RoomCuller.narrow` picks, within the scene's focus, the
  occlusion volumes that can hide something of a cluster. None: its draws are not tested; its
  sphere wholly inside a volume: all hidden; otherwise, or when the camera stands in a room and a
  room holds one of its draws (`inRoom`), each draw is tested as before and the result is part of
  the set.
- **Light lists held per cluster** (`#clusterLights`): a list is a function of the light keys
  reaching the draw's bound and of its room. The keys reaching a cluster's bound (which, their
  place among the keys, and every value) are compared each light frame; while they stay the same
  the lists its draws chose since hold and are not chosen again (most clusters are reached by
  no light; flickering torches change the frame's keys every frame).
- **Transform samples kept** (`sampleTransform` in `render/animation.ts`): a source sampled at
  the time it was last sampled at, or one whose key groups hold at most one key (most tracks of
  the objects' sequences), gives its last sample again.

Per rendered frame in the profiles (ms, the main thread; `--cpu-profile 55`, warm):

| part                    | riverwood   | whiterun-day | streaming   |
| ----------------------- | ----------- | ------------ | ----------- |
| `drawOpaque`            | 1.67 → 0.95 | 1.13 → 0.78  | 0.64 → 0.38 |
| `setBindGroup` (all)    | 0.61 → 0.31 | 0.41 → 0.28  | 0.32 → 0.19 |
| `RoomCuller.visible`    | 0.41 → 0.09 | 0.36 → 0.12  | 0.00 → 0.00 |
| `graphFrame`            | 0.48 → 0.41 | 0.34 → 0.33  | 0.18 → 0.16 |
| the whole frame (noisy) | 9.6 → 8.9   | 10.1 → 10.2  | 7.3 → 6.9   |

Before (main e168c97c) and after, two runs each, warm (a riverwood run first), 60 s, no
profiler, in the order `riverwood`, `whiterun-day`, `streaming` (headless Chrome on the shared
machine; whiterun-day alone gave 69–93 fps over the runs of this round):

| scenario     | run     | fps   | p50 (ms) | p95 (ms) | p99 (ms) | > 33 ms | > 50 ms |
| ------------ | ------- | ----- | -------- | -------- | -------- | ------- | ------- |
| riverwood    | before  | 112.1 | 11.0     | 11.2     | 16.8     | 7       | 2       |
|              | before² | 108.9 | 11.1     | 11.2     | 16.8     | 7       | 1       |
|              | after   | 117.1 | 5.7      | 11.2     | 16.8     | 2       | 0       |
|              | after²  | 118.1 | 5.7      | 11.2     | 16.8     | 4       | 0       |
| whiterun-day | before  | 73.9  | 11.2     | 22.2     | 27.8     | 6       | 1       |
|              | before² | 70.8  | 11.2     | 22.2     | 27.8     | 7       | 1       |
|              | after   | 79.7  | 11.1     | 22.1     | 27.8     | 13      | 3       |
|              | after²  | 77.9  | 11.1     | 22.2     | 27.8     | 33      | 6       |
| streaming    | before  | 125.4 | 5.6      | 16.7     | 16.8     | 3       | 1       |
|              | before² | 143.1 | 5.6      | 11.2     | 16.7     | 4       | 1       |
|              | after   | 120.8 | 5.6      | 16.7     | 22.2     | 5       | 3       |
|              | after²  | 114.6 | 5.6      | 16.7     | 22.2     | 8       | 1       |

The profiled runs (before → after: riverwood 114 → 119 fps, whiterun-day 75 → 73, streaming
105 → 111) split into frames show no long frame held by the opaque pass or a bundle's recording;
the flight's are the HUD's movies, `ActorsAway`, the records read for the first actors and
frames with no single cause, as before, and whiterun-day's long frames moved with the machine's
load (13 and 33 in two runs of the same code). Riverwood's frames halved their median (11 to
5.7 ms between the display's ticks).

What is left (TODO(M13)):

- A cluster's draws are still walked every frame for their set (shown, faded, rooms and
  occluders) and their lights: 0.4–0.5 ms in Riverwood and Whiterun. Change marks (a
  reference enabled, a fade's level crossing 255, the camera moved) would let a settled cluster
  skip the walk.
- In interiors the camera stands in a room, so the clusters whose draws rooms hold are tested
  draw by draw, and their sets change as the portals' rectangles do: those stay unbundled while
  the camera moves.
- The loose draws (actors' parts, moving clutter, object LOD) are still bound one by one
  (0.3–0.5 ms).
- The objects' behavior graphs (`graphFrame`, 0.3–0.4 ms) still evaluate every layer each frame
  (most of it the maps `evaluate` builds); sampling only the tracks whose targets are drawn needs
  which nodes a model's draws, particles and lag bones read.

### The opening's frame

Measured with `tools/qa-perf.ts` (docs/qa.md): a New Game in headless Chrome on the shared
machine (AMD RDNA 4), 1280×720, driven as the `opening` QA scenario drives it; every 30 s six
seconds of plain frames, then six profiled. Helgen loads some 80 actors, 3,000 bodies and 6,000
colliders. The frame was bound by the main thread from the cart ride on: the GPU takes 3–5 ms a
frame (6–9 ms at 2560×1440). And the physics multiplies it: Havok's rule is up to
uMaxNumPhysicsStepsPerUpdate (3) fixed steps a frame, so a 45 ms frame steps the world, every
actor's character controller with it, three times, which makes the next frame as long. Where a
profiled frame went (ms a frame; the same scenes before and after):

| scene                    | run    | frame | physics | Rapier step | its walk | controllers | actors | graphs | scene animate |
| ------------------------ | ------ | ----: | ------: | ----------: | -------: | ----------: | -----: | -----: | ------------: |
| Helgen's gate (stage 35) | before |  38.4 |    17.0 |         6.5 |      2.3 |         5.8 |    8.4 |    1.9 |           4.9 |
|                          | after  |  22.8 |     6.5 |         2.8 |        0 |         2.8 |    5.4 |    1.5 |           4.2 |
| roll call (stage 80)     | before |  33.0 |    10.6 |         1.1 |      2.2 |         5.5 |    8.5 |    3.6 |           5.2 |
|                          | after  |  15.7 |     2.3 |         0.4 |        0 |         1.5 |    4.8 |    2.4 |           3.3 |
| Alduin's attack (160)    | before |  45.6 |    19.7 |         3.6 |      2.5 |        11.3 |   14.0 |    3.4 |           4.5 |
|                          | after  |  35.0 |     9.4 |         2.9 |        0 |         4.6 |    9.7 |    4.1 |           5.6 |

What it was, and what changed:

- **World.step's walk** (`stepWorld`, physics-world.ts): Rapier 0.21's `World.step` wraps after
  every step what the engine made or removed on its own (the pieces soft bodies tear off): a walk
  over every rigid body and collider with a call back into JavaScript for each. The engine has
  no soft bodies; it steps the pipeline itself and leaves the walk out while there are none.
- **The contact filter's ignored pairs** were looked up by a string made for every pair of every
  step (`pairKey`: 1 ms of a frame); now by number (`HandlePairs`).
- **The controllers' sweeps** called back into JavaScript for every collider near every actor at
  every step (`touching`: the layers' test, its own bodies, what it moves through). Colliders a
  controller meets now carry a group bit of their own (`QueryGroups.controllerSolid`: a layer that
  collides with L_CHARCONTROLLER, not a ragdoll's one-sided copy), so Rapier makes the layers'
  test; the sweep calls back only while the actor moves through something, is inside another
  controller or owns a body a controller meets (`controllerSolidOf`). The same colliders are met.
- **Meshes made again per query** (`queryShape`): a mesh's triangles were copied and its tree of
  bounds built for every contact asked against it. A controller held in the gap at Helgen's tower
  wall asked one every step (`#outOfSkin`): 60 ms of a frame for as long as it stood there.
  Meshes, heightfields and compounds are lent as the hulls were.
- **Path searches over frames** (`PathSearch`, docs/ai.md, "Paths"): a search for a goal off the
  actor's island takes the whole island, 12,000 triangles round Helgen, 10–25 ms in one frame
  (the soldiers going for Alduin on the tower, five to ten such searches a minute). The searches
  of all actors' travels together now take at most 2,000 nodes of a frame, those waiting longest
  first with 512 kept for searches' first shares (docs/ai.md, "Searches over frames"); the search
  itself is cheaper too (its nodes by number, a triangle's corners read once for its edges, a cut
  triangle's corners only when it is first cut, `sqrt` for `hypot`).
- **Smaller ones:** a behavior reference's file worked out once a name (`ClipHost.behavior`: it
  normalized the path for every reference node a graph passed, every update); an actor's
  commander, which walks every active effect of the world, worked out only when asked
  (`MagicEngine.aiState`: the invisibility veil asks every loaded actor each frame); a cone's
  wave (Alduin's breath) leaves fixed bodies out of its push before Rapier tests its ball against
  them, and land and actors out of the objects it meets.

Before (integration tip f7b192a0) and after, plain frames, by scene (the before run's longest
frames include the profiler's own start, ~600 ms, which the runner now leaves out; the physics
steps a frame were not counted before):

| scene                                                | run    |  fps | slowest window | p95 (ms) | > 33 ms | steps a frame |
| ---------------------------------------------------- | ------ | ---: | -------------: | -------: | ------: | ------------: |
| cart ride (stage 12–15)                              | before | 43.6 |             28 |     33.3 |     5 % |               |
|                                                      | after  | 67.6 |             47 |     21.4 |     0 % |          0.95 |
| arrival in Helgen (20–54)                            | before | 29.9 |             22 |     44.5 |    27 % |               |
|                                                      | after  | 57.7 |             49 |     24.1 |     0 % |          1.05 |
| roll call, execution (70–97)                         | before | 27.4 |             22 |     50.7 |    28 % |               |
|                                                      | after  | 66.2 |             54 |     19.6 |     0 % |          0.85 |
| Alduin's attack (150–180)                            | before | 22.5 |             17 |     59.8 |    54 % |               |
|                                                      | after  | 38.4 |             30 |     36.7 |     7 % |          1.63 |
| the keep (stage 250, a run before the search shares) | after  |  178 |            177 |      5.7 |     0 % |               |

A second run once the searches waiting longest took the frame's nodes first (and a search begun
256 at least): Alduin's attack 46.4 fps over twelve windows (slowest 38.7, p95 22–28 ms in all
but two, 1.3 physics steps a frame, 400–940 search nodes a frame on a window's average; the most
in one frame was not measured, and the walkers' searches were not paced yet); the cart
ride, arrival and execution 59, 57 and 63 fps, with no searches in the cart ride's windows (the
machine is shared: windows without the changed work vary by ±10 fps between runs).

A third run with the frame's search nodes a true cap (walkers' searches paced too) and a goal off
the start's island gone to by the island's nearest point (docs/ai.md, "Paths"): the soldiers'
searches for Alduin on the tower (5,700–12,000 nodes each before) are gone; Alduin's attack 47.4
fps over fifteen windows (52.6 and 55.3 in the first two, 41.8–49.7 after; p95 28–33 ms; 1.1–1.4
physics steps a frame). The search nodes of single frames were measured this time: at most 1,749
in any frame of the run (in the window at stage 130, before the attack), at most 1,569 within
Alduin's attack (the first share of a search begun with the frame's nodes free is 1,488:
2,000 less the 512 reserve); in the later windows one actor (a soldier going round the tower's
foot, ~4,800 nodes a search, eight a window) takes them in about one frame in ten. Making an
island and finding its nearest point were not counted yet then (they ran whole in a search's
first share): a frame that made one took more than its count.

A fourth run with those counted too (an island made a share at a time, its nearest point found on
a grid and kept per goal: docs/ai.md, "Paths") and the follow bot's own searches left out of the
count (the bot stands in for the player; once a search at once made no island, the bot's way off
the tower's top took ~1,340 nodes in some frames on top of the soldiers' 1,488, 2,824 in a frame
in a run before it was left out): at most 1,744 search nodes in any
frame of the run (stage 25), at most 1,609 within Alduin's attack. Islands made as cells stream in
(the cart ride, the arrival) take the frame's 1,488 for a few frames each (p99 1,488 in those
windows). Alduin's attack 55.2 fps over nine windows (59.7, 62.3, 56.3, 52.2, 52.3, 54.0, 50.9,
53.1, 56.1; p95 22–28 ms; 1.0–1.2 physics steps a frame; awake bodies 71 to 148); the third run's
first nine windows of the attack were 47.7. The run reached the attack a minute later and its
windows end four and a half minutes into it, where the third run's went on to seven; with the
machine shared, how much of the 7.5 fps is the bot's and the islands' and how much the machine's is
not known.

A fifth run with a search going first and making its island only once it runs on (one island
made at a time for all searches, docs/ai.md, "Paths") and the follow bot's islands its own (it
made them over the game's navmeshes before, uncounted, and the soldiers' searches went by them):
in the cart ride and the arrival the frames at the 1,488 of a first share are gone but one window
(stage 35: p99 1,488; before, four windows of stages 15–35); within Alduin's attack (seven windows
this run, the attack three minutes long; the fourth run's was still going four and a half minutes in) the most search nodes in a
frame were 148, 7, 1,488, 424, 27, 1,603 and 18 (p99 20, 5, 1,488, 406, 27, 1,600, 11), where
the fourth run's attack windows were at 1,488 or more in seven of ten (p99 1,488–1,497). The two
windows at the cap are one actor's each: a prisoner's eight searches of ~1,500 nodes, and the
soldier ff000867's twenty-one of ~2,850 going after Alduin (he searches again each time Alduin
moved CHASE_SLACK, 192 units). The frame rate is not comparable: the machine was busier all
through this run (the execution's windows, with no searches in them, 39–51 fps against 69–96 in
the fourth run; the attack's 24–40 against 51–62; 1.2–2.5 physics steps a frame, as frames were
longer).

A sixth run with floods begun apart joining where they meet (a search on a stretch of navmesh of
its own floods only that, docs/ai.md, "Paths"): within Alduin's attack (eleven windows, the
follow bot stuck on the inn's upper floor the whole time, off any navmesh, as in the three runs
before the fifth: the attack never ended) the most search nodes in a frame were 22, 1,488, 22, 11,
162, 24, 1,488, 12, 31, 162 and 1,488 (p99 4, 1,488, 5, 8, 56, 5, 1,488, 10, 31, 14, 1,488). The
three windows at the cap are one actor's each time, e4919's two searches of 2,300–2,500 nodes
that reach their goal (no island in them); the soldier ff000867 searched once, 41 nodes, in the
first. The search code is under the profile's threshold in every window. The frame rate is again
not comparable: the machine was busier still (the execution's windows 32–45 fps against 39–52 in
the fifth run), and in the attack the physics took 2.3–3 steps a frame (its cap of 3 in five
windows; Rapier 14–26 ms a frame against 10–12) with 127–211 bodies awake, at 19–30 fps.

What is left (TODO(M13)): Alduin's attack is still below 60 fps (55 over the fourth run's
windows, 47 over the third's, the slowest 42). Its actors (behavior graphs 4 ms, the movers'
travels, combat 1.6 ms) and the physics at 1.0–1.4 steps a frame are the largest parts; Rapier's own step (2–3 ms) has no symbols
to break it down. In both the second and third runs the world's awake dynamic bodies grow all
through the attack (70–90 to 250–380 over seven minutes, about 25 more each window, with the
bodies from 2,850 to 3,370) and the frame rate falls from 52–60 in the attack's first minute to
42–49 after: what those bodies are (missed arrows lying on the ground, the tower's debris) and
why they do not sleep is the next thing to look at ("The opening's physics", below: those
counts took in bodies out of the world; the physics' cost was not theirs). The soldier's repeated
way round the tower's foot (its chase taken again as Alduin moves) is the AI's;
`SceneRenderer.animate` (3–6 ms: fades, palettes, particles) is spread over many small parts.

### The opening's physics

Measured 2026-11-12 with `tools/qa-perf.ts --from-stage 90` on the integration tip b683bfbe and
after the changes below: the same machine, headless Chrome at 1280×720, both runs with other
work on the machine (its sixteen threads about 80 % busy through the first run; not measured
through the second: only the same windows of the two runs compare, and those loosely). The
runner now counts the physics by frame (the steps of each `PhysicsWorld.step`, its milliseconds)
and lists the simulated bodies awake at each window's end.

**Which bodies are awake.** The counts above (127–211, growing to 250–380) were of bodies neither
asleep nor fixed, and took in those out of the world: some 90 of Helgen's (ragdolls of actors
disabled while they lay). The bodies really simulated were 0 to 66 at any window's end:

- the ragdolls of those just killed (18 bodies a human, 27 a horse), awake while they settle,
  some for a minute and more: a horse killed beside its cart lay awake for the whole attack (27
  bodies, at most 0.06 Havok units and 0.47 radians a second), one of its bodies on the cart,
  which is keyframed to its living horse and moves with its idle (Rapier wakes what a moving
  keyframed body touches, each step); another corpse's 18 bodies trembled 14 to 46 s;
- arrows that missed and did not stick (L_WEAPON, made references), up to twelve at a time, 5,000
  to 19,000 units from the player, each awake 10 to 90 s: they roll or rock at 0.05–0.2 Havok
  units a second with a spin of 2–6 radians a second, and neither the frequent deactivation check
  nor the solver's slowing of slow bodies takes a body that spins;
- clutter an actor walked into (L_CLUTTER), one to four, a second or two each.

None of them wake by the weld or the hold-awake passes. TODO(M13): the arrows' roll (their box is
as thin as its convex shell is thick: what Havok's shell does to it is not read) and the
trembling ragdolls; Havok's rarer deactivation check (within four times the reference distance;
its world's low frequency period, 10 s by Havok's default) is not modelled, and whether the
tremblers stay within it was not measured (one settling ragdoll watched for 10 s did not: 0.16 Havok
units, 0.2 radians).

**Where the physics went.** With 18 bodies awake (the execution, 81 actors standing) the physics
took 16 ms of a 50 ms frame; with 7 awake in the attack, 28 ms of 72. A profiled frame, ms (the
same windows of the two runs):

| scene                | run    | frame | physics | Rapier step | controllers | of them: ground and carrier casts | water | speeds before | top speeds |
| -------------------- | ------ | ----: | ------: | ----------: | ----------: | --------------------------------: | ----: | ------------: | ---------: |
| execution (stage 90) | before |  49.8 |    16.2 |         3.5 |         8.0 |                               1.8 |  0.95 |          0.62 |       0.43 |
|                      | after  |  25.4 |     3.0 |         0.9 |         1.2 |                              0.13 |  0.12 |          0.06 |       0.09 |
| Alduin's attack      | before |  72.3 |    27.7 |         7.0 |        14.6 |                               4.7 |  0.99 |          0.79 |       0.58 |
|                      | after  |  35.7 |     7.7 |         3.0 |         3.1 |                              0.24 |  0.33 |          0.09 |       0.12 |

What it was, and what changed:

- **Three steps a frame, each frame.** A frame of 47 ms hands the physics its three steps of
  1/60 s (the cap), the three steps make the next frame as long, and the time a longer frame
  could not hand was owed without end: frames that grew shorter still took three. The engine has
  a mode for this, on now while the scene is complex (as many living actors in the high process
  as iAINumberActorsComplexScene, 20, by the idles' and detection's count, which leaves out the
  disabled and those placed or reloaded dead: `ActorStage.complexScene`): one step of fMaxTimeComplex
  (1/30 s) a frame at most, every other frame at 60 frames a second (docs/physics.md, "The
  complex mode"; inferred, TODO(M13)). And the time owed is held to what one frame hands (ours,
  TODO(M13)): a slow stretch is not made up for minutes after, at up to three times the world's
  speed. The most steps in any frame of the opening's exterior went from 3 to 1.
- **The controllers' call backs.** Every humanoid skeleton has a phantom on the controllers'
  layer (its CharacterBumper), which counted as a body of the actor's own that a controller meets:
  so every sweep and cast of every actor called back into JavaScript for each collider near it,
  each step, to be told the layers (some 900 calls a step for 60 controllers), though the sweeps
  leave sensors out. A controller's casts for its ground and for what carries it called back for
  each of its own 18 keyframed bodies. Sensors are out of the controllers' group, and what no
  actor owns has a group of its own (`QueryGroups.controllerGround`): a standing actor's step
  calls back for nothing.
- **Walks over every body.** The speeds before a step, the top speeds, the water, and every
  quarter second the deactivation and the bounds each walked the world's 3,000 bodies for the
  awake ones, with two or three calls into Rapier for each. They walk the bodies made simulated
  (some 700: `PhysicsWorld.forEachAwake`).
- **The contact filter on welded meshes.** A body on a welded mesh makes two pairs, one with each
  half (the two-sided original, the ragdolls' one-sided copy), and the contact filter, a call back
  for every pair of a moving body each step, refused one. The halves' group filters take only the
  bodies they meet (`GROUP_RAGDOLL`): half the filter's calls for bodies on meshes.

Plain frames by window, before and after (frame times and the physics of single frames; the
keep's interior after Helgen: 45–70 fps before, 87–112 after, at 0.3–0.55 steps a frame, the
complex mode's: that run still counted the keep's disabled and placed dead toward a complex
scene, which they no longer make, so the keep now steps at 1/60 s; not measured again):

| stage              | run    |  fps | frame p50 / p95 / max (ms) | steps a frame: mean, most | physics a frame p50 / p95 / max (ms) | awake |
| ------------------ | ------ | ---: | -------------------------: | ------------------------: | -----------------------------------: | ----: |
| execution (90)     | before | 20.6 |          47.2 / 61.9 / 116 |                   2.87, 3 |                   14.7 / 18.0 / 24.0 |    18 |
|                    | after  | 44.7 |           21.6 / 33.3 / 71 |                   0.67, 1 |                      3.0 / 4.6 / 9.4 |    18 |
| execution (95, 90) | before | 26.5 |           37.2 / 47.7 / 63 |                   2.27, 3 |                    8.6 / 13.6 / 21.4 |     0 |
|                    | after  | 47.2 |           19.9 / 33.0 / 42 |                   0.64, 1 |                      2.4 / 3.6 / 4.0 |     0 |
| Alduin comes (150) | before | 24.0 |           40.0 / 56.8 / 77 |                   2.61, 3 |                   11.7 / 14.8 / 17.3 |    27 |
| (130)              | after  | 37.4 |           25.2 / 41.8 / 50 |                   0.80, 1 |                     4.4 / 9.2 / 13.1 |    30 |
| the attack (160)   | before | 19.6 |          48.4 / 69.9 / 100 |                   3.00, 3 |                   15.0 / 20.0 / 25.9 |    30 |
|                    | after  | 27.8 |           34.0 / 50.3 / 66 |                   1.00, 1 |                     4.3 / 8.9 / 12.6 |    29 |
|                    | before | 20.8 |          47.0 / 66.9 / 111 |                   2.75, 3 |                   14.0 / 16.3 / 17.8 |     1 |
|                    | after  | 39.1 |           24.9 / 35.9 / 50 |                   0.77, 1 |                      4.9 / 6.9 / 9.5 |    50 |
|                    | before | 15.7 |          62.1 / 84.2 / 140 |                   3.00, 3 |                   17.9 / 24.5 / 39.3 |     7 |
|                    | after  | 31.9 |           32.8 / 42.5 / 51 |                   1.00, 1 |                      5.2 / 7.4 / 8.6 |    36 |
|                    | before | 17.9 |           54.5 / 72.4 / 84 |                   3.00, 3 |                   18.8 / 23.2 / 27.1 |    22 |
|                    | after  | 32.9 |           31.0 / 42.8 / 50 |                   1.00, 1 |                      5.2 / 6.8 / 8.7 |    31 |
|                    | before | 15.6 |           63.7 / 78.7 / 83 |                   3.00, 3 |                   21.8 / 26.1 / 29.4 |    66 |
|                    | after  | 27.6 |           33.8 / 49.2 / 57 |                   1.00, 1 |                     5.9 / 9.4 / 14.0 |    35 |
| to the keep (180)  | before | 17.4 |           56.7 / 70.8 / 78 |                   3.00, 3 |                   21.4 / 25.5 / 31.7 |    49 |
|                    | after  | 29.0 |          33.3 / 49.7 / 142 |                   1.00, 1 |                     5.5 / 7.4 / 34.1 |    30 |

(The after run is of the changes but the bound on the time owed, made after it; a run before
that one, without the welded meshes' groups either, gave 40.8 and 43.4 fps in the execution and
22.9–35.1 in the attack. The before run's last window, at the keep's door as its cell loads, had
71 ms of physics in one frame; the after run's 34 ms is the same moment.)

(Both runs counted the disabled and the placed dead toward a complex scene. In the headless
simulation of the opening the right count stands at 21–31 living from the carts' arrival to the
line-up (stages 20–80), where the miscount had 48–61: the exterior stays complex there, by a
margin of one to eleven. The execution and the attack, as their actors die, may fall below 20
and step at 1/60 s again; those windows were not measured again.)

What is left (TODO(M13)): the attack is at 28–39 fps on the loaded machine, not 60. Below 30
frames a second a complex scene's world runs slow (one step of 1/30 s a frame), as the plain one
does below 20. Of a 36 ms frame the physics is 7.7 (Rapier's step 3.0 at the complex mode's twice
the iterations, the controllers 3.1: their sweeps and casts inside Rapier, for every actor
standing or not), the actors 9.4 (their behavior graphs 3.4, combat 1.2, their bodies' keyframes 1.1,
the movers 1.0), `SceneRenderer.animate` 6.5 and the draws about 10. A standing
controller still sweeps each step (a rest that leaves it out needs to know that nothing near it
moved); the living actors' 1,100 keyframed bodies are moved each frame.

## The lighting technique's flags and the fades (observed in the original)

The original picks a lighting shape's technique from its shader flags alone, the later ones
winning: Environment_Mapping (environment map), Glow_Map, Parallax, Facegen_Detail_Map,
FaceGen_RGB_Tint, Hair_Soft_Lighting (the hair technique: the actor's hair colour), Parallax
Occlusion, Landscape, the LOD flags, Multi_Layer_Parallax, Tree_Anim, Multi_Index_Snow with
Projected_UV, Eye_Environment_Mapping. Hair_Soft_Lighting is on all 11,070 hair tint shapes and on
nothing else. EnvMap_Light_Fade and Remappable_Textures are not read by it.

Shadows: Receive_Shadows, Assume_Shadowmask, Decal or Dynamic_Decal lets a shape take the screen
shadow mask (the sun's and the shadow lights' shadows). A shape drawn with alpha blending, or one
fading without the stipple, takes none of it unless it carries Assume_Shadowmask or a decal flag
(the actors' hair, eyes, skin and beards do). lighting.wgsl follows this; it looks the shadow maps
up at the blended surface where the original reads the opaque scene's mask (TODO(M13)).

Screendoor_Alpha_Fade: a shape fading out (its fade value under 1) is stippled when
bEnableStippleFade is on, unless it carries this flag; then it is drawn blended by its fade
alpha instead, without the shadow mask. The ten uses are the falling rocks of the rock hazard
(fxhavokrockhazard.nif). Here an opaque lighting shape with the flag keeps a blended copy
(`Draw.fadeBlend`: source alpha over, its alpha test kept); while its reference fades it is
left out of the opaque pass and the copy is drawn in the blended pass, its alpha times one minus
the fade, taking no shadows unless it carries Assume_Shadowmask or a decal flag
(`lighting.wgsl blendedFade`).

The sparkle technique (shader type 14, and the second pass of multi-index snow), as its pixel
shaders in the cache have it: the noise is the engine's projected normal detail map
(ProjectedNormalDetail.dds), its blue channel sampled at the UV times |x|^1.3, |x|^1.6 and |x|^1.9
of the Sparkle Parameters (x, y, z, w); `s = Σ min(|b|, 1)^y`; per light (the sun and each point
light) a sparkle is on where `s · z · saturate(r · L)^w ≥ 0.5` (r the view mirrored about the
normal), adding the light's `saturate(n · h)` to the specular. The technique's Snow variant has no
sparkle term, and every type 14 shape of the data (19, the ice of caves and Windhelm) carries the
Snow flag: they draw as snow.

Eyes (shader type 16): the vertex shader takes the eye's reflection centre from the material's
left and right centres by the vertex's eye data (0 left, 1 right: on all 578,856 eye vertices of
the data the nearer centre's), moves it as the vertex is moved (skinning included) and passes the
direction from it to the vertex; the pixel shader reflects the view about that direction for the
cube map and takes the directional ambient with it in place of the normal.

Object fade (object-fade.ts): a reference's fade distance is ten bound radii (fLODBoundRadiusMult),
capped at the loaded grid's edge less its radius and half a cell; its fade range runs from 0.6 of
that (fLODFadeOutPercent) to all of it, starting no nearer than 500 units (iFadeNodeMinNearDistance)
and ending no nearer than 1000. The camera's distance is divided by the reference kind's multiplier
(fLODFadeOutMult...) before it is compared, and a multiplier of 0 or less never fades. Over the
range the reference's fade value goes from 1 to 0 (not clamped). The value does not set the alpha
itself: a reference not shown fades in once the value is above fFadeInThreshold (0.7), by dt /
fFadeInTime (1.2 s) a frame, at most 0.1 a frame, and counts as shown once whole; a shown one fades
out once the value is below fFadeOutThreshold (0.3), by dt / fFadeOutTime (2 s), and is hidden at
0; a fade under way goes on in while the value stays above 0.3. A reference that was not in view
the frame before takes its end state at once. We dither by that alpha (stepFade). TODO(M13): the
original's own fades toward a target alpha (scripts', the camera's) and its per-camera distance
factor.

The shaders' own distance fades (shader-fades.ts): the geometry keeps that divided distance over
7200 as a value (a multiplier of 0 or less: a fifth of the distance); specular and the environment
map fade out as it goes from 0.09 to 0.1 (fSpecularLODFadeStart and End, fEnvmapLODFadeStart and
End), decals (Decal, Dynamic_Decal) from 0.05 to 0.06 (fDecalLODFade...; Skyrim_Default.ini sets
0.45 and 0.5), refraction from 0.025 to 0.03 (fRefractionLODFade...). No_Fade spares decals and
refraction these fades; it does not stop the object fade. The shaders take the value per draw from
the distance of its origin and its fade kind (flags.w bits 5-6) and the frame's scales; blended
decals fade their alpha, the others dissolve by the dither; refraction scales its mask.

LOD between levels: the original switches a terrain or object LOD block to its children (and back)
by showing and hiding the block nodes once the replacing blocks are loaded, without a fade; an
object LOD block is split while the camera's horizontal distance to its nearest point is within the
level's distance (fBlockLevel0Distance, fBlockLevel1Distance) times a camera factor (1 at the
default view, as far as read). Ours does the same (formats/lod.md). Tree LOD is taken to switch the
same way (not read).

## Volumetric lighting

The original scatters the sun's light through a froxel volume over the view, in compute passes
(observed in the original); ours does the same (`volumetric-volume.ts`, `volumetric-data.ts`,
`shaders/volumetric.wgsl`):

- The volume: [Display] iVolumetricLightingQuality picks Low 160 × 96 × 50, Medium (1, the
  default) 224 × 128 × 70, High 320 × 192 × 90 froxels (width, height, depth slices). A 32³ noise
  volume (iVolumetricLightingNoiseTexture*) holds the density noise; the original fills it on the
  GPU at load, observed in the original: three-dimensional simplex noise (the common mod-289
  permutation, the 7 × 7 gradient grid, the 0.6 falloff) at ((x + 0.2, y, z) / 32) × 80, stored
  as 21 × the corners' sum + 0.5. Ours fills it the same on the CPU (the integer steps in single
  precision, as the GPU takes them; `densityNoise`).
- The depth repartition: two 4096-entry tables, one of x to the range factor (VOLI NNAM; 40 in
  vanilla), one of x to 1 / the range factor (a second mode, (3^(x r) − 1) / (3^r − 1) and its
  inverse, exists for tests). The generate pass binds the second: a slice coordinate s (0..1)
  stands at clip depth s^(1/r) of the camera's projection (D3D's 0 at the near plane, 1 at the
  far one; the cascades' split distances are handed to the shader as clip depths of the same
  projection), and the composite finds a pixel's slice by its clip depth to the power r. With the
  near plane of 15 ([Display] fNearDistance) and r = 40 half the slices lie within some 900
  units and the last reach tens of thousands. Ours computes the same powers in the shader (the
  table's 4096 steps are finer than the slices) and keeps the original's near plane for the
  slices whatever our camera's is.
- Generate (32 × 32 groups over the width and height, a group per slice): each froxel's light,
  observed in the original. The froxel is read at its index over the volume's size (no half
  texel) moved by a thousandth of the volume towards a corner of a unit cube that the frame index
  & 7 picks (x by its bit 2, y by bit 1, z by bit 0); its slice coordinate goes through the table
  to a clip depth and with the inverse view-projection to a place. Its view depth picks the
  cascade: the first up to the first split, the second up to the last (only the first two
  cascades' matrices are filled), beyond: lit. One lookup in the cascade's map, the first
  cascade's biased (0.01 in the original's depth), the second's not; while
  iEnableShadowCastingFlag is not 1 a second shadow array is looked up at the same place and the
  smaller of the two taken (ours has one sun map). The noise is read at (the place + the drift
  and the camera's start) / the density size × 0.0125 (`NOISE_SCALE`) and thinned with height:
  × (1 − 0.75 × smoothstep of the height above the camera over 150 units); the density is 1
  mixed with that by the density contribution. The phase is `(1 − g²) / (4π (1 − g cos))` mixed
  with 1 by the phase contribution. The froxel holds lit × phase × density (one value, in two
  textures). The noise drifts each frame by the frame time × the density size × the wind's
  direction × the wind speed (against the wind's x, with its y), and falls by the falling speed ×
  the frame time × the density size, each times a random share of 0..1.
- Raymarch (observed in the original): a dispatch per slice adds each slice's froxel to the sum
  of those before it: each texel holds the plain sum of the froxels from the camera to its slice
  (no extinction, no slice thickness). Ours sums each column in one pass.
- Composite (observed in the original): a pixel's depth goes through the inverse table to its
  slice coordinate (at most 0.9999), the summed volume is read there (filtered) and scaled by the
  intensity over the slice count (so the average of the froxels in front of it, times the
  intensity: `compositeScale`), plus a dither: a 2D simplex noise (the same function at (x, y)
  × 8) read at the pixel's place over 8, / 32 − 1/128. Then the temporal accumulation
  (bVolumetricLightingEnableTemporalAccumulation): the pixel's motion leads to where it was, the
  last frame's composite is read there and blended in by fVolumetricLightingTemporalAccumulation
  Factor (0.75) × (1 − smoothstep(saturate(|depth − the last frame's depth there| × 100))), none
  where that place is off the screen; the first frame after a change has no history. Ours
  reprojects the pixel's point with the last frame's camera (the volume's own motion vectors)
  and keeps the depth (our near-plane-15 depth: VOLUME_NEAR / distance) beside the amount in the
  same target (TODO(M13): whether the history the original reads is the blurred result is
  unread; ours keeps the unblurred composite; the dither's size is unread, ours 32²).
- Blur (two compute passes, across then down; observed in the original): five taps at 0, ±6 and
  ±12 pixels weighted 0.222338, 0.210431 and 0.1784; where the depths there are uneven
  (|4 × the pixel's − the four others'| > 0.002) the pixel keeps its value. TODO(M13): the depth
  the blur reads is a linear depth whose scale is unread (ours: VOLUME_NEAR / distance).
- Apply: the amount times the colour (the sun's mixed with the custom colour by the custom colour
  contribution) added to the scene (ours with the vertical blur in one pass). Interiors have none
  (bVolumetricLightingDisableInterior).

Lag bones (lag-bone.ts): each update the bone covers linear velocity × dt of the way to where its
parent would put it (at its rest translation), the part beyond the maximum distance at once; it
keeps its last world rotation and turns back toward its rest rotation by linear rotation × dt.
Skeletons (ActorPose) trail in world space when placed (ActorPose.space: the actor's instance
world), so the actor's own walk and turns swing a tail. Other models with lag bones (the scan of
the meshes: spells' hand effects and projectiles, shouts, torches, a few creatures' effect
models) keep them in their animation (ModelAnimation.lagBones) and the scene renderer keeps a
`ModelLagBones` per placed instance (by its world matrix): each frame the lag nodes trail that
instance's motion in world space, and the parts and particle emitters under them follow, so a
swung torch's flame and a moving hand's spell trail. Rigid worn pieces hung on a skeleton node
(the knuckles, the Akaviri sword: 4 files) do not yet (TODO(M13)).

Measured cost before the screen-space blur (headless Chrome, 1280 × 720, Whiterun by day,
Medium: GPU timestamps): generate 0.07 ms, raymarch 0.03 ms, the composite 0.015 ms; the blur
and apply now run across the screen (to be measured). The passes keep their bind groups between
frames (made again only when the shadow map, depth texture or screen size changes), and where
the GPU filters 32-bit floats (float32-filterable) the composite reads the volume with one
trilinear sample instead of eight loads. `engineDev.renderer.sunEffects.volume.profile = true` fills its `timings` (ms per pass).
