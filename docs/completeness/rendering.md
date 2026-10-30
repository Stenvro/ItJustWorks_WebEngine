# Rendering completeness

"100" for rendering: everything the original draws is drawn as the original draws it, for every
case in the data (Skyrim.esm, Update, the three DLCs and the Creation Club files of the install).
This checklist has two parts:

1. **Systems** (below, kept by hand): the passes and features a sweep of the files cannot see.
2. **The data sweep** (generated, after it): every shader type, shader flag, sampled texture slot,
   alpha mode, shader controller variable, NIF block type and rendering-record subrecord the load
   order uses, with how many shapes or records use it. Regenerate it with
   `node tools/render-inventory.ts --markdown` (`--open` lists only what is used and not done);
   the statuses are kept in that tool's tables against `src/render/shaders` and the record
   readers in `src/world`.

An item is **done** only when every use in the data is drawn as the original draws it; **open**
items say why; **n/a** items draw nothing (data for other systems, slots the type and flags do
not sample, flags xEdit and nif.xml call unused).

## Count (2026-10-30)

| Part       | Items | Done | Open | n/a |
| ---------- | ----- | ---- | ---- | --- |
| Systems    | 76    | 57   | 19   | 0   |
| Data sweep | 462   | 405  | 25   | 32  |
| **Total**  | 538   | 462  | 44   | 32  |

Done this round (5): skinned decals on actors (the hit shape's triangles in the decal's box
copied into a decal shape skinned to the same bones, under the original's limits: 100 living,
25 made a frame, 25 per actor, none beyond 800 units of the camera); lag bones on placed and
held models (effects, spells, torches: a lag state per instance, the parts and particle emitters
under a lag node trailing that instance's motion; BSLagBoneController stays open for armour hung
on a skeleton); the volumetric volume's cost (GPU timestamps per pass, bind groups kept between
frames, the blur in one pass through workgroup memory, the composite's one trilinear sample).

Round 4: volumetric lighting as the original's froxel volume (its size by quality,
the slices spread over clip depth by the range factor, the noise drifting with the wind and
falling, the first two cascades' shadows, the jitter, the temporal blend of 0.75, gathered slice
by slice, blurred and composited by each pixel's depth) in place of the screen-space god rays;
the world map's relief overlay on its LOD land. BSDecalPlacementVectorExtraData turned out to be
editor data (0-2 points per file, on bodies, armour, furniture and walls) the original loads and
never reads: n/a. Round 3 did the lighting shader's own distance fades, the fades over time by
the original's thresholds, LOD switching and lag bones on skeletons.

## Next biggest open items

1. **Shader terms only the shader cache holds**: the volumetric generate shader's scattering, its
   blur and noise; the map overlay's weights and snow mask (inferred now).
2. **The dragon-riding camera**, **first-person particles and near plane**.
3. **Light-list order** for land and particles; **IBLF lens flare**; **WATR NAM5**; **planar
   water reflection**; mesh particles; Fire_Refraction; fLODFadeOutMultSkyCell (one entry of
   the fade multipliers by fade-node type: which nodes get it is unread).
4. Lag bones on armour hung on a skeleton; geometry decals on rigid worn shapes (ours project).

## Systems

| #   | Item                                                               | Status | Where / why                                                                                         |
| --- | ------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------- |
| 1   | Per-object light lists (7 point lights, 4 shadow lights)           | done   | light-lists.ts                                                                                      |
| 2   | The order of a geometry's own light list                           | open   | strongest first is ours (TODO(M13))                                                                 |
| 3   | Land's own light lists (lights flagged to light land)              | open   | land takes every light of the frame                                                                 |
| 4   | Particle systems' own light lists                                  | open   | particles take every light of the frame                                                             |
| 5   | Effect shaders' light list (shadow lights left out)                | open   | the engine's list unread                                                                            |
| 6   | Spot lights' cones (LIGH FOV, XLIG offsets)                        | done   | cell-loader lightCone                                                                               |
| 7   | Light flicker and pulse                                            | done   | light-flicker.ts                                                                                    |
| 8   | Sun shadow cascades                                                | done   | shadow-cascades.ts                                                                                  |
| 9   | Focus shadows                                                      | done   | focus-shadows.ts                                                                                    |
| 10  | Whether focus maps draw only their actor                           | open   | ours draw every caster in their column                                                              |
| 11  | Shadow lights: omnidirectional, spot, hemisphere                   | done   | light-shadows.ts                                                                                    |
| 12  | Fog: weather, XCLL and LGTM (near, far, power, max)                | done   | frame.wgsl                                                                                          |
| 13  | Underwater fog                                                     | done   | underwater.ts                                                                                       |
| 14  | Underwater imagespace (WATR INAM)                                  | done   | underwater.ts, world-sky.ts                                                                         |
| 15  | Underwater colour (how the water's colours are lit, the tint)      | open   | the water's imagespace is the one path (no tint over it); how the fog colours are lit is inferred   |
| 16  | Terrain LOD                                                        | done   | terrain.ts                                                                                          |
| 17  | Object LOD (.bto, HD LOD)                                          | done   | scene-renderer LOD materials                                                                        |
| 18  | Tree LOD billboards                                                | done   | tree-lod.ts                                                                                         |
| 19  | LOD fade between levels                                            | done   | levels switch without a fade once the replacing blocks are loaded, as the original (trees inferred) |
| 20  | fLODFadeOutMultSkyCell                                             | open   | the 11th of the fade multipliers by fade-node type; which nodes get that type unread                |
| 21  | LOD culled by rooms and portals                                    | open   | LOD is not culled by them                                                                           |
| 22  | Object distance fade                                               | done   | object-fade.ts: the original's thresholds and fade times; shader-fades.ts                           |
| 23  | Rooms and portals culling                                          | done   | room-culler.ts                                                                                      |
| 24  | Rooms' lighting templates and imagespaces                          | done   | model-viewer lightingInRoom                                                                         |
| 25  | Occlusion planes and boxes                                         | done   | cell-rooms.ts                                                                                       |
| 26  | Eye adaptation                                                     | done   | post.ts                                                                                             |
| 27  | Bloom                                                              | done   | post.ts                                                                                             |
| 28  | Tone curve and cinematic grading (saturation, contrast, tint)      | done   | post.wgsl                                                                                           |
| 29  | Depth of field (IMGS and IMAD)                                     | done   | dof.wgsl                                                                                            |
| 30  | IMAD screen effects: blur, double vision, radial and motion blur   | done   | screen-effects.wgsl                                                                                 |
| 31  | IMAD fade and tint, HDR and cinematic channels                     | done   | image-space-modifier.ts                                                                             |
| 32  | Sun lens flare (LENS)                                              | done   | lens-flare.ts                                                                                       |
| 33  | Image-based lens flare of bright lights (bIBLFEnable)              | open   | the values the engine feeds it are unread                                                           |
| 34  | Temporal anti-aliasing                                             | done   | taa.ts                                                                                              |
| 35  | Ambient occlusion                                                  | done   | sao.ts                                                                                              |
| 36  | Refraction (heat haze, barriers)                                   | done   | refraction.ts                                                                                       |
| 37  | God rays (the VOLI phase function)                                 | done   | volumetric-volume.ts (the froxel volume in place of screen-space rays)                              |
| 38  | Volumetric lighting as a froxel volume (density noise, shadows)    | done   | volumetric-volume.ts, volumetric-data.ts, shaders/volumetric.wgsl                                   |
| 39  | Clouds (layers, speeds, colours, alphas)                           | done   | sky.ts                                                                                              |
| 40  | Sun, sun glare, sun damage                                         | done   | sky.ts, sun-effects.ts                                                                              |
| 41  | Moons and their phases, stars                                      | done   | sky.ts                                                                                              |
| 42  | Aurora                                                             | done   | sky.ts                                                                                              |
| 43  | Lightning: procedural bolts and the flash                          | done   | lightning.ts                                                                                        |
| 44  | Precipitation (SPGD rain and snow)                                 | done   | precipitation.ts                                                                                    |
| 45  | Weather transitions                                                | done   | sky-state.ts                                                                                        |
| 46  | Water: the planar reflection pass                                  | open   | not built                                                                                           |
| 47  | Water: displacement (wading, splashes, projectiles, rain)          | done   | water-displacement.ts                                                                               |
| 48  | Water: colours and depth properties                                | done   | water.wgsl                                                                                          |
| 49  | Water: river flow maps                                             | done   | flow-map.ts                                                                                         |
| 50  | Water: the original shader's exact terms                           | open   | ours by Community Shaders' reading                                                                  |
| 51  | Static decals (TXST placed in cells)                               | done   | decals.ts                                                                                           |
| 52  | Impact decals (IPCT)                                               | done   | decal-projection.ts                                                                                 |
| 53  | Skinned decals on actors                                           | done   | skinned-decal.ts, combat-impacts.ts (the original's limits per actor, frame and in all)             |
| 54  | Screen blood                                                       | done   | screen-blood.ts                                                                                     |
| 55  | Weapon blood                                                       | done   | effect.wgsl                                                                                         |
| 56  | Motion vectors of moving instances and animated parts              | done   | velocity.wgsl                                                                                       |
| 57  | Motion vectors of skinned limbs                                    | done   | velocity.wgsl: the last frame's bone palettes                                                       |
| 58  | First person: its own view and depth band                          | done   | first-person-view.ts                                                                                |
| 59  | First person: the engine's near plane                              | open   | unread                                                                                              |
| 60  | First person: particles                                            | open   | not drawn in the first-person band                                                                  |
| 61  | Eye reflection centres                                             | open   | ours reflect about the eye mesh's normal                                                            |
| 62  | Character light: its luminance source                              | open   | ours from the directional ambient                                                                   |
| 63  | Default texture per slot for a missing file                        | open   | ours: white, flat normal, black                                                                     |
| 64  | Grass                                                              | done   | grass.ts                                                                                            |
| 65  | Terrain texture blending                                           | done   | terrain.wgsl                                                                                        |
| 66  | Directional materials (snow, moss, ice on statics)                 | done   | material-object.ts                                                                                  |
| 67  | Snow subsurface scattering                                         | done   | snow-sss.ts                                                                                         |
| 68  | Alternate textures on placed objects (MODS)                        | done   | cell-loader objectModelKey, GameSession.model                                                       |
| 69  | The map's world view                                               | done   | world-map-view.ts                                                                                   |
| 70  | The race menu's 3D (lights, camera)                                | done   | race-menu.ts                                                                                        |
| 71  | Inventory 3D: placement, lights, turning, zoom                     | done   | item-3d.ts                                                                                          |
| 72  | Inventory 3D: the item's own orientation (BSInvMarker)             | done   | item-3d-view.ts (the marker's rotation and zoom)                                                    |
| 73  | The dragon-riding camera                                           | open   | not built                                                                                           |
| 74  | Enchantment glow and effect shaders on references                  | done   | actor-effects.ts                                                                                    |
| 75  | The map's relief overlay on its LOD land                           | done   | lighting.wgsl worldMapRelief, world-map-view.ts                                                     |
| 76  | Shader terms only the shader cache holds (volumetric, map overlay) | open   | volumetric generate/blur/noise, the overlay's weights and snow mask inferred (TODO(M13))            |

## Data sweep

Generated by `node tools/render-inventory.ts --markdown` (a lighting shader's slot counts as
sampled where its type and flags bind it, `src/render/material-slots.ts`). Alternate textures
whose shape name the model no longer has (stale swaps, for example RockShelf01:8 against a model
whose shapes are RockShelf01:0, :9 and :3) stay open: which shape the engine then picks, by the
entry's 3D index, is unread.

### Lighting shader types

| Item                   | Uses  | Status | Where / why                                                         |
| ---------------------- | ----- | ------ | ------------------------------------------------------------------- |
| 0 Default              | 46180 | done   | lighting.wgsl                                                       |
| 1 Environment Map      | 7227  | done   | lighting.wgsl: cube map × mask × scale × diffuse light              |
| 2 Glow Shader          | 1414  | done   | lighting.wgsl: emit × glow map (SLSF2 Glow_Map)                     |
| 3 Parallax             | 11    | done   | lighting.wgsl: height map offset (the vanilla model-space bug kept) |
| 4 Face Tint            | 3239  | done   | lighting.wgsl: FaceGen detail and tint maps, character light        |
| 5 Skin Tint            | 1684  | done   | lighting.wgsl: skin tint colour (FaceGen RGB tint)                  |
| 6 Hair Tint            | 11070 | done   | lighting.wgsl: tint by vertex green, anisotropic                    |
| 11 MultiLayer Parallax | 662   | done   | lighting.wgsl: inner layer, slot 6                                  |
| 14 Sparkle Snow        | 19    | open   | drawn as the default shader; its sparkle parameters unused          |
| 16 Eye Envmap          | 3339  | done   | lighting.wgsl: eye cube map scale (reflection centres open)         |

### Lighting shader flags

| Item                                          | Uses  | Status | Where / why                                                              |
| --------------------------------------------- | ----- | ------ | ------------------------------------------------------------------------ |
| SLSF1 Specular (0x1)                          | 65953 | done   | lighting.wgsl                                                            |
| SLSF1 Skinned (0x2)                           | 27529 | done   | skinning.ts (the skin instance decides)                                  |
| SLSF1 Vertex_Alpha (0x8)                      | 10783 | done   | lighting.wgsl                                                            |
| SLSF1 Environment_Mapping (0x80)              | 7243  | done   | lighting.wgsl                                                            |
| SLSF1 Receive_Shadows (0x100)                 | 74457 | done   | lighting.wgsl                                                            |
| SLSF1 Cast_Shadows (0x200)                    | 73235 | done   | scene-renderer shadow casters                                            |
| SLSF1 Facegen_Detail_Map (0x400)              | 3239  | done   | lighting.wgsl FaceGen detail map                                         |
| SLSF1 Parallax (0x800)                        | 11    | done   | with shader type 3                                                       |
| SLSF1 Model_Space_Normals (0x1000)            | 4188  | done   | lighting.wgsl                                                            |
| SLSF1 Refraction (0x8000)                     | 362   | done   | refraction.ts                                                            |
| SLSF1 Fire_Refraction (0x10000)               | 252   | open   | refraction falloff to the engine; its technique selection never reads it |
| SLSF1 Eye_Environment_Mapping (0x20000)       | 3320  | done   | lighting.wgsl                                                            |
| SLSF1 Hair_Soft_Lighting (0x40000)            | 11070 | done   | lighting.wgsl: picks the hair technique (the hair tint)                  |
| SLSF1 Screendoor_Alpha_Fade (0x80000)         | 10    | open   | unread (object-fade dithers every shape)                                 |
| SLSF1 FaceGen_RGB_Tint (0x200000)             | 1684  | done   | lighting.wgsl skin tint                                                  |
| SLSF1 Own_Emit (0x400000)                     | 74833 | done   | lighting.wgsl                                                            |
| SLSF1 Remappable_Textures (0x2000000)         | 73726 | n/a    | the lighting technique never reads it                                    |
| SLSF1 Decal (0x4000000)                       | 11394 | done   | depth bias, decal pipelines                                              |
| SLSF1 Dynamic_Decal (0x8000000)               | 11315 | done   | weapon blood, decal pipelines                                            |
| SLSF1 External_Emittance (0x20000000)         | 412   | done   | XEMI on references                                                       |
| SLSF1 ZBuffer_Test (0x80000000)               | 74845 | done   | pipeline depth test                                                      |
| SLSF2 ZBuffer_Write (0x1)                     | 66564 | done   | pipeline depth write                                                     |
| SLSF2 No_Fade (0x8)                           | 1242  | done   | lighting.wgsl, refraction.wgsl: no decal or refraction distance fade     |
| SLSF2 Double_Sided (0x10)                     | 2345  | done   | cull mode                                                                |
| SLSF2 Vertex_Colors (0x20)                    | 58096 | done   | lighting.wgsl                                                            |
| SLSF2 Glow_Map (0x40)                         | 1414  | done   | lighting.wgsl                                                            |
| SLSF2 Assume_Shadowmask (0x80)                | 12352 | done   | lighting.wgsl: shadows on blended shapes                                 |
| SLSF2 EnvMap_Light_Fade (0x8000)              | 72788 | n/a    | the lighting technique never reads it                                    |
| SLSF2 Anisotropic_Lighting (0x200000)         | 5729  | done   | lighting.wgsl                                                            |
| SLSF2 Multi_Layer_Parallax (0x1000000)        | 662   | done   | with shader type 11                                                      |
| SLSF2 Soft_Lighting (0x2000000)               | 8264  | done   | lighting.wgsl                                                            |
| SLSF2 Rim_Lighting (0x4000000)                | 264   | done   | lighting.wgsl                                                            |
| SLSF2 Back_Lighting (0x8000000)               | 2184  | done   | lighting.wgsl                                                            |
| SLSF2 Snow (Unused02 in nif.xml) (0x10000000) | 30    | done   | snow.wgsl                                                                |
| SLSF2 Tree_Anim (0x20000000)                  | 461   | done   | common.wgsl leafShift                                                    |

### Effect shader flags

| Item                                   | Uses | Status | Where / why                                                                   |
| -------------------------------------- | ---- | ------ | ----------------------------------------------------------------------------- |
| SLSF1 Skinned (0x2)                    | 242  | done   | skinning.ts                                                                   |
| SLSF1 Vertex_Alpha (0x8)               | 4168 | done   | effect.wgsl                                                                   |
| SLSF1 Greyscale_To_PaletteColor (0x10) | 3097 | done   | effect.wgsl                                                                   |
| SLSF1 Greyscale_To_PaletteAlpha (0x20) | 2626 | done   | effect.wgsl                                                                   |
| SLSF1 Use_Falloff (0x40)               | 2797 | done   | effect.wgsl                                                                   |
| SLSF1 Own_Emit (0x400000)              | 69   | open   | unread: the effect shader has no emit term                                    |
| SLSF1 Decal (0x4000000)                | 719  | done   | decal pipelines                                                               |
| SLSF1 Dynamic_Decal (0x8000000)        | 719  | done   | decal pipelines                                                               |
| SLSF1 External_Emittance (0x20000000)  | 1750 | done   | XEMI                                                                          |
| SLSF1 Soft_Effect (0x40000000)         | 3796 | done   | effect.wgsl                                                                   |
| SLSF1 ZBuffer_Test (0x80000000)        | 8349 | done   | pipeline depth test                                                           |
| SLSF2 ZBuffer_Write (0x1)              | 1621 | done   | pipeline depth write                                                          |
| SLSF2 No_Fade (0x8)                    | 181  | open   | the lighting shader fades are built; whether effect shapes have any is unread |
| SLSF2 Double_Sided (0x10)              | 2950 | done   | cull mode                                                                     |
| SLSF2 Vertex_Colors (0x20)             | 7374 | done   | effect.wgsl                                                                   |
| SLSF2 Weapon_Blood (0x20000)           | 310  | done   | effect.wgsl                                                                   |
| SLSF2 Effect_Lighting (0x40000000)     | 1748 | done   | effect.wgsl                                                                   |

### Texture slots

| Item                                              | Uses  | Status | Where / why                            |
| ------------------------------------------------- | ----- | ------ | -------------------------------------- |
| type 0 slot 0 diffuse (sampled)                   | 46180 | done   | material-slots.ts, lighting.wgsl       |
| type 0 slot 1 normal (sampled)                    | 46180 | done   | material-slots.ts, lighting.wgsl       |
| type 0 slot 2 glow / skin / rim-soft (sampled)    | 769   | done   | material-slots.ts, lighting.wgsl       |
| type 0 slot 2 glow / skin / rim-soft (unsampled)  | 1166  | n/a    | its type and flags sample no such slot |
| type 0 slot 4 environment (unsampled)             | 14    | n/a    | its type and flags sample no such slot |
| type 0 slot 5 environment mask (unsampled)        | 424   | n/a    | its type and flags sample no such slot |
| type 0 slot 6 inner layer / tint (unsampled)      | 1     | n/a    | its type and flags sample no such slot |
| type 0 slot 7 specular / back light (sampled)     | 1374  | done   | material-slots.ts, lighting.wgsl       |
| type 0 slot 7 specular / back light (unsampled)   | 65    | n/a    | its type and flags sample no such slot |
| type 11 slot 0 diffuse (sampled)                  | 662   | done   | material-slots.ts, lighting.wgsl       |
| type 11 slot 1 normal (sampled)                   | 662   | done   | material-slots.ts, lighting.wgsl       |
| type 11 slot 2 glow / skin / rim-soft (sampled)   | 149   | done   | material-slots.ts, lighting.wgsl       |
| type 11 slot 2 glow / skin / rim-soft (unsampled) | 72    | n/a    | its type and flags sample no such slot |
| type 11 slot 3 height / detail (unsampled)        | 23    | n/a    | its type and flags sample no such slot |
| type 11 slot 4 environment (sampled)              | 655   | done   | material-slots.ts, lighting.wgsl       |
| type 11 slot 5 environment mask (sampled)         | 98    | done   | material-slots.ts, lighting.wgsl       |
| type 11 slot 6 inner layer / tint (sampled)       | 662   | done   | material-slots.ts, lighting.wgsl       |
| type 11 slot 7 specular / back light (sampled)    | 373   | done   | material-slots.ts, lighting.wgsl       |
| type 11 slot 7 specular / back light (unsampled)  | 7     | n/a    | its type and flags sample no such slot |
| type 14 slot 0 diffuse (sampled)                  | 19    | done   | material-slots.ts, lighting.wgsl       |
| type 14 slot 1 normal (sampled)                   | 19    | done   | material-slots.ts, lighting.wgsl       |
| type 14 slot 7 specular / back light (sampled)    | 17    | done   | material-slots.ts, lighting.wgsl       |
| type 16 slot 0 diffuse (sampled)                  | 3339  | done   | material-slots.ts, lighting.wgsl       |
| type 16 slot 1 normal (sampled)                   | 3339  | done   | material-slots.ts, lighting.wgsl       |
| type 16 slot 2 glow / skin / rim-soft (sampled)   | 3175  | done   | material-slots.ts, lighting.wgsl       |
| type 16 slot 2 glow / skin / rim-soft (unsampled) | 2     | n/a    | its type and flags sample no such slot |
| type 16 slot 4 environment (sampled)              | 3334  | done   | material-slots.ts, lighting.wgsl       |
| type 16 slot 5 environment mask (sampled)         | 3225  | done   | material-slots.ts, lighting.wgsl       |
| type 16 slot 7 specular / back light (sampled)    | 3     | done   | material-slots.ts, lighting.wgsl       |
| type 1 slot 0 diffuse (sampled)                   | 7227  | done   | material-slots.ts, lighting.wgsl       |
| type 1 slot 1 normal (sampled)                    | 7227  | done   | material-slots.ts, lighting.wgsl       |
| type 1 slot 2 glow / skin / rim-soft (sampled)    | 108   | done   | material-slots.ts, lighting.wgsl       |
| type 1 slot 2 glow / skin / rim-soft (unsampled)  | 143   | n/a    | its type and flags sample no such slot |
| type 1 slot 4 environment (sampled)               | 7226  | done   | material-slots.ts, lighting.wgsl       |
| type 1 slot 5 environment mask (sampled)          | 2997  | done   | material-slots.ts, lighting.wgsl       |
| type 1 slot 7 specular / back light (sampled)     | 238   | done   | material-slots.ts, lighting.wgsl       |
| type 2 slot 0 diffuse (sampled)                   | 1414  | done   | material-slots.ts, lighting.wgsl       |
| type 2 slot 1 normal (sampled)                    | 1414  | done   | material-slots.ts, lighting.wgsl       |
| type 2 slot 2 glow / skin / rim-soft (sampled)    | 1387  | done   | material-slots.ts, lighting.wgsl       |
| type 2 slot 4 environment (unsampled)             | 48    | n/a    | its type and flags sample no such slot |
| type 2 slot 5 environment mask (unsampled)        | 139   | n/a    | its type and flags sample no such slot |
| type 2 slot 7 specular / back light (sampled)     | 214   | done   | material-slots.ts, lighting.wgsl       |
| type 3 slot 0 diffuse (sampled)                   | 11    | done   | material-slots.ts, lighting.wgsl       |
| type 3 slot 1 normal (sampled)                    | 11    | done   | material-slots.ts, lighting.wgsl       |
| type 3 slot 3 height / detail (sampled)           | 11    | done   | material-slots.ts, lighting.wgsl       |
| type 4 slot 0 diffuse (sampled)                   | 3239  | done   | material-slots.ts, lighting.wgsl       |
| type 4 slot 1 normal (sampled)                    | 3239  | done   | material-slots.ts, lighting.wgsl       |
| type 4 slot 2 glow / skin / rim-soft (sampled)    | 3194  | done   | material-slots.ts, lighting.wgsl       |
| type 4 slot 2 glow / skin / rim-soft (unsampled)  | 45    | n/a    | its type and flags sample no such slot |
| type 4 slot 3 height / detail (sampled)           | 3225  | done   | material-slots.ts, lighting.wgsl       |
| type 4 slot 6 inner layer / tint (sampled)        | 3231  | done   | material-slots.ts, lighting.wgsl       |
| type 4 slot 7 specular / back light (sampled)     | 3193  | done   | material-slots.ts, lighting.wgsl       |
| type 5 slot 0 diffuse (sampled)                   | 1684  | done   | material-slots.ts, lighting.wgsl       |
| type 5 slot 1 normal (sampled)                    | 1684  | done   | material-slots.ts, lighting.wgsl       |
| type 5 slot 2 glow / skin / rim-soft (sampled)    | 953   | done   | material-slots.ts, lighting.wgsl       |
| type 5 slot 2 glow / skin / rim-soft (unsampled)  | 1     | n/a    | its type and flags sample no such slot |
| type 5 slot 7 specular / back light (sampled)     | 391   | done   | material-slots.ts, lighting.wgsl       |
| type 5 slot 7 specular / back light (unsampled)   | 21    | n/a    | its type and flags sample no such slot |
| type 6 slot 0 diffuse (sampled)                   | 11070 | done   | material-slots.ts, lighting.wgsl       |
| type 6 slot 1 normal (sampled)                    | 11070 | done   | material-slots.ts, lighting.wgsl       |
| type 6 slot 2 glow / skin / rim-soft (sampled)    | 16    | done   | material-slots.ts, lighting.wgsl       |

### Effect shader textures

| Item              | Uses | Status | Where / why |
| ----------------- | ---- | ------ | ----------- |
| source texture    | 6490 | done   | effect.wgsl |
| greyscale palette | 4405 | done   | effect.wgsl |

### Alpha modes

| Item                            | Uses  | Status | Where / why               |
| ------------------------------- | ----- | ------ | ------------------------- |
| test GREATER                    | 18160 | done   | NiAlphaProperty pipelines |
| blend SRC_ALPHA / INV_SRC_ALPHA | 15311 | done   | NiAlphaProperty pipelines |
| blend SRC_ALPHA / ONE           | 4495  | done   | NiAlphaProperty pipelines |
| blend ZERO / SRC_COLOR          | 435   | done   | NiAlphaProperty pipelines |

### Shader controller variables

| Item                                       | Uses | Status | Where / why  |
| ------------------------------------------ | ---- | ------ | ------------ |
| BSEffectShaderPropertyColorController 0    | 988  | done   | animation.ts |
| BSEffectShaderPropertyFloatController 0    | 900  | done   | animation.ts |
| BSEffectShaderPropertyFloatController 1    | 17   | done   | animation.ts |
| BSEffectShaderPropertyFloatController 2    | 163  | done   | animation.ts |
| BSEffectShaderPropertyFloatController 3    | 196  | done   | animation.ts |
| BSEffectShaderPropertyFloatController 4    | 2    | done   | animation.ts |
| BSEffectShaderPropertyFloatController 5    | 2497 | done   | animation.ts |
| BSEffectShaderPropertyFloatController 6    | 1802 | done   | animation.ts |
| BSEffectShaderPropertyFloatController 7    | 384  | done   | animation.ts |
| BSEffectShaderPropertyFloatController 8    | 2512 | done   | animation.ts |
| BSEffectShaderPropertyFloatController 9    | 314  | done   | animation.ts |
| BSLightingShaderPropertyColorController 0  | 26   | done   | animation.ts |
| BSLightingShaderPropertyColorController 1  | 265  | done   | animation.ts |
| BSLightingShaderPropertyFloatController 0  | 225  | done   | animation.ts |
| BSLightingShaderPropertyFloatController 10 | 19   | done   | animation.ts |
| BSLightingShaderPropertyFloatController 11 | 645  | done   | animation.ts |
| BSLightingShaderPropertyFloatController 12 | 906  | done   | animation.ts |
| BSLightingShaderPropertyFloatController 20 | 208  | done   | animation.ts |
| BSLightingShaderPropertyFloatController 21 | 214  | done   | animation.ts |
| BSLightingShaderPropertyFloatController 22 | 912  | done   | animation.ts |
| BSLightingShaderPropertyFloatController 23 | 200  | done   | animation.ts |
| BSLightingShaderPropertyFloatController 8  | 13   | done   | animation.ts |
| BSLightingShaderPropertyFloatController 9  | 5    | done   | animation.ts |

### Sky shader objects

| Item   | Uses | Status | Where / why |
| ------ | ---- | ------ | ----------- |
| type 2 | 1    | done   | sky.ts      |
| type 3 | 29   | done   | sky.ts      |
| type 7 | 1    | done   | sky.ts      |
| type 5 | 4    | done   | sky.ts      |

### Water shader flags

| Item  | Uses | Status | Where / why |
| ----- | ---- | ------ | ----------- |
| bit 2 | 32   | done   | water.wgsl  |
| bit 6 | 30   | done   | water.wgsl  |
| bit 7 | 32   | done   | water.wgsl  |

### Block types

| Item                                                | Uses   | Status | Where / why                                                              |
| --------------------------------------------------- | ------ | ------ | ------------------------------------------------------------------------ |
| NiNode (10612 files)                                | 102385 | done   |                                                                          |
| BSLightingShaderProperty (20966 files)              | 74845  | done   | lighting.wgsl                                                            |
| BSShaderTextureSet (20966 files)                    | 64058  | done   |                                                                          |
| BSTriShape (18601 files)                            | 61597  | done   | build-model                                                              |
| NiFloatInterpolator (2192 files)                    | 38251  | done   |                                                                          |
| NiAlphaProperty (12313 files)                       | 36617  | done   | blend and test pipelines                                                 |
| NiFloatData (2030 files)                            | 35333  | done   |                                                                          |
| NiSkinData (7207 files)                             | 27794  | done   |                                                                          |
| NiSkinPartition (7207 files)                        | 27794  | done   |                                                                          |
| BSDynamicTriShape (3727 files)                      | 21581  | done   | face-morphs                                                              |
| NiTransformInterpolator (1816 files)                | 20479  | done   |                                                                          |
| NiTransformData (1767 files)                        | 19163  | done   |                                                                          |
| BSFadeNode (18797 files)                            | 18797  | done   |                                                                          |
| BSDismemberSkinInstance (6548 files)                | 16200  | done   | skinning.ts                                                              |
| BSXFlags (13511 files)                              | 13511  | done   | model-data.ts                                                            |
| NiSkinInstance (3890 files)                         | 11621  | done   | skinning.ts                                                              |
| BSEffectShaderPropertyFloatController (1381 files)  | 8787   | done   | animation.ts shader variables                                            |
| NiBoolTimelineInterpolator (615 files)              | 8492   | done   | animation.ts (as a bool interpolator)                                    |
| BSEffectShaderProperty (3022 files)                 | 8362   | done   | effect.wgsl (environment map open)                                       |
| NiBlendFloatInterpolator (856 files)                | 8164   | done   |                                                                          |
| NiBoolInterpolator (1074 files)                     | 7885   | done   |                                                                          |
| NiTextKeyExtraData (1455 files)                     | 5095   | done   |                                                                          |
| NiControllerSequence (1313 files)                   | 4947   | done   | animation.ts                                                             |
| NiTransformController (943 files)                   | 4906   | done   | animation.ts                                                             |
| NiBoolData (927 files)                              | 4724   | done   |                                                                          |
| NiBlendBoolInterpolator (624 files)                 | 3795   | done   |                                                                          |
| BSLightingShaderPropertyFloatController (629 files) | 3347   | done   | animation.ts shader variables                                            |
| NiPosData (540 files)                               | 3160   | done   |                                                                          |
| NiPoint3Interpolator (516 files)                    | 3115   | done   |                                                                          |
| NiStringExtraData (990 files)                       | 2798   | done   | model-data.ts                                                            |
| NiPSysModifierActiveCtlr (606 files)                | 2793   | done   |                                                                          |
| BSInvMarker (2299 files)                            | 2299   | done   | item-3d-view.ts                                                          |
| NiPSysDragModifier (470 files)                      | 2293   | done   |                                                                          |
| NiBillboardNode (805 files)                         | 2067   | done   | billboard.ts                                                             |
| NiFloatExtraData (102 files)                        | 1786   | open   | parsed; what reads it (FOV, scale) unchecked                             |
| NiPSysUpdateCtlr (912 files)                        | 1729   | done   | implicit: systems update each frame                                      |
| NiPSysAgeDeathModifier (912 files)                  | 1729   | done   |                                                                          |
| BSPSysLODModifier (912 files)                       | 1729   | done   |                                                                          |
| NiPSysSpawnModifier (912 files)                     | 1729   | done   |                                                                          |
| NiPSysPositionModifier (912 files)                  | 1726   | done   | implicit: particles move by velocity                                     |
| NiPSysBoundUpdateModifier (912 files)               | 1726   | done   | implicit: bounds per frame                                               |
| BSPSysSimpleColorModifier (903 files)               | 1691   | done   |                                                                          |
| NiPSysEmitterCtlr (819 files)                       | 1587   | done   |                                                                          |
| NiPSysData (802 files)                              | 1547   | done   |                                                                          |
| NiParticleSystem (802 files)                        | 1547   | done   | particle-sim.ts                                                          |
| BSPSysScaleModifier (847 files)                     | 1506   | done   |                                                                          |
| NiPSysGravityModifier (679 files)                   | 1379   | done   |                                                                          |
| NiControllerManager (1313 files)                    | 1313   | done   | animation.ts                                                             |
| NiMultiTargetTransformController (1313 files)       | 1313   | done   | animation.ts                                                             |
| NiDefaultAVObjectPalette (1313 files)               | 1313   | done   |                                                                          |
| BSBehaviorGraphExtraData (1251 files)               | 1251   | done   | behavior graphs on objects                                               |
| NiVisController (279 files)                         | 1054   | done   | animation.ts                                                             |
| BSEffectShaderPropertyColorController (421 files)   | 988    | done   | animation.ts shader variables                                            |
| NiPSysRotationModifier (573 files)                  | 905    | done   |                                                                          |
| BSValueNode (242 files)                             | 814    | done   |                                                                          |
| NiBlendPoint3Interpolator (296 files)               | 799    | done   |                                                                          |
| BSNiAlphaPropertyTestRefController (227 files)      | 767    | done   | animation.ts                                                             |
| NiPSysMeshEmitter (350 files)                       | 644    | done   |                                                                          |
| BSPSysSubTexModifier (338 files)                    | 574    | done   |                                                                          |
| NiBooleanExtraData (203 files)                      | 567    | n/a    | gameplay data                                                            |
| NiPSysBoxEmitter (330 files)                        | 564    | done   |                                                                          |
| NiPSysBombModifier (235 files)                      | 500    | done   |                                                                          |
| NiPSysCylinderEmitter (258 files)                   | 373    | done   |                                                                          |
| NiStringsExtraData (182 files)                      | 337    | n/a    | gameplay data                                                            |
| NiBinaryExtraData (30 files)                        | 321    | n/a    | gameplay data                                                            |
| BSLightingShaderPropertyColorController (123 files) | 291    | done   | animation.ts shader variables                                            |
| NiTriShapeData (158 files)                          | 289    | done   | build-model                                                              |
| BSLeafAnimNode (286 files)                          | 286    | done   | leaf flutter                                                             |
| BSOrderedNode (247 files)                           | 256    | done   | draw order of its children                                               |
| NiTriShape (134 files)                              | 246    | done   | build-model                                                              |
| BSMultiBoundNode (246 files)                        | 246    | done   | culling bounds                                                           |
| BSMultiBound (246 files)                            | 246    | done   | culling by bounding spheres draws the same image                         |
| BSFurnitureMarkerNode (243 files)                   | 243    | n/a    | furniture markers                                                        |
| BSMultiBoundOBB (240 files)                         | 240    | done   | culling by bounding spheres draws the same image                         |
| NiPSysEmitterSpeedCtlr (133 files)                  | 234    | done   | particle-data.ts                                                         |
| NiPSysGravityStrengthCtlr (125 files)               | 230    | done   | particle-data.ts                                                         |
| BSLagBoneController (108 files)                     | 221    | open   | skeletons and placed or held models trail; armour hung on a skeleton not |
| NiFloatExtraDataController (71 files)               | 188    | open   | parsed; not animated                                                     |
| BSPSysInheritVelocityModifier (104 files)           | 188    | done   |                                                                          |
| BSStripPSysData (151 files)                         | 179    | done   |                                                                          |
| BSStripParticleSystem (151 files)                   | 179    | done   | particle-sim.ts strips                                                   |
| BSPSysStripUpdateModifier (151 files)               | 179    | done   |                                                                          |
| NiSwitchNode (165 files)                            | 172    | done   |                                                                          |
| NiIntegerExtraData (143 files)                      | 169    | n/a    | gameplay data                                                            |
| NiPSysSphereEmitter (101 files)                     | 148    | done   |                                                                          |
| BSPSysMultiTargetEmitterCtlr (93 files)             | 142    | done   |                                                                          |
| NiCamera (129 files)                                | 138    | done   | cinematic cameras                                                        |
| NiPSysEmitterInitialRadiusCtlr (80 files)           | 113    | done   | particle-data.ts                                                         |
| NiPSysPlanarCollider (42 files)                     | 96     | done   |                                                                          |
| BSMasterParticleSystem (93 files)                   | 93     | done   |                                                                          |
| NiPSysColliderManager (51 files)                    | 77     | done   |                                                                          |
| NiPSysEmitterLifeSpanCtlr (60 files)                | 76     | done   | particle-data.ts                                                         |
| NiPathInterpolator (25 files)                       | 73     | open   | motion along a path not read                                             |
| BSTreeNode (71 files)                               | 71     | done   | leaf flutter                                                             |
| BSDecalPlacementVectorExtraData (61 files)          | 61     | n/a    | editor data (0-2 points each); the original loads it, nothing reads it   |
| BSBound (57 files)                                  | 57     | done   | bounds                                                                   |
| BSFrustumFOVController (54 files)                   | 54     | open   | parsed; the camera FOV animation unused                                  |
| BSBoneLODExtraData (52 files)                       | 52     | open   | bone LOD unread                                                          |
| BSPSysRecycleBoundModifier (36 files)               | 45     | done   |                                                                          |
| BSLODTriShape (34 files)                            | 43     | done   | build-model                                                              |
| BSProceduralLightningController (13 files)          | 37     | done   | lightning.ts                                                             |
| BSSkyShaderProperty (4 files)                       | 35     | done   | sky.ts                                                                   |
| BSWaterShaderProperty (33 files)                    | 33     | done   | water.wgsl                                                               |
| BSBlastNode (28 files)                              | 31     | done   | explosions                                                               |
| NiTriStripsData (17 files)                          | 31     | n/a    | collision geometry only (bhkNiTriStripsShape)                            |
| NiPSysSphericalCollider (15 files)                  | 28     | done   |                                                                          |
| BSDamageStage (7 files)                             | 13     | done   | destruction stages                                                       |
| BSWindModifier (7 files)                            | 10     | done   |                                                                          |
| BSMultiBoundAABB (6 files)                          | 6      | done   | culling by bounding spheres draws the same image                         |
| NiLookAtInterpolator (5 files)                      | 5      | open   | look-at rotation not read                                                |
| NiPSysEmitterPlanarAngleCtlr (2 files)              | 4      | done   | particle-data.ts                                                         |
| NiPSysEmitterDeclinationCtlr (2 files)              | 4      | done   | particle-data.ts                                                         |
| NiBSBoneLODController (3 files)                     | 3      | open   | bone LOD unread                                                          |
| NiMeshPSysData (1 files)                            | 3      | open   | mesh particles not drawn                                                 |
| NiMeshParticleSystem (1 files)                      | 3      | open   | mesh particles not drawn                                                 |
| NiPSysInitialRotSpeedCtlr (1 files)                 | 1      | done   | particle-data.ts                                                         |

### Records: CLMT (9)

| Item | Uses | Status | Where / why    |
| ---- | ---- | ------ | -------------- |
| FNAM | 8    | done   | read           |
| GNAM | 8    | done   | read           |
| MODL | 9    | done   | read           |
| MODT | 5    | n/a    | texture hashes |
| TNAM | 9    | done   | read           |
| WLST | 9    | done   | read           |

### Records: EFSH (280)

| Item | Uses | Status | Where / why |
| ---- | ---- | ------ | ----------- |
| DATA | 280  | done   | read        |
| ICO2 | 280  | done   | read        |
| ICON | 280  | done   | read        |
| NAM7 | 280  | done   | read        |
| NAM8 | 275  | done   | read        |
| NAM9 | 271  | done   | read        |

### Records: IMAD (256)

| Item    | Uses | Status | Where / why |
| ------- | ---- | ------ | ----------- |
| \x00IAD | 256  | done   | read        |
| \x01IAD | 256  | done   | read        |
| \x02IAD | 256  | done   | read        |
| \x03IAD | 256  | done   | read        |
| \x04IAD | 256  | done   | read        |
| \x05IAD | 256  | done   | read        |
| \x06IAD | 256  | done   | read        |
| \x07IAD | 256  | done   | read        |
| \x08IAD | 256  | done   | read        |
| \x09IAD | 256  | done   | read        |
| \x0aIAD | 256  | done   | read        |
| \x0bIAD | 256  | done   | read        |
| \x0cIAD | 256  | done   | read        |
| \x0dIAD | 256  | done   | read        |
| \x0eIAD | 256  | done   | read        |
| \x0fIAD | 256  | done   | read        |
| \x10IAD | 256  | done   | read        |
| \x11IAD | 256  | done   | read        |
| \x12IAD | 256  | done   | read        |
| \x13IAD | 256  | done   | read        |
| \x14IAD | 256  | done   | read        |
| @IAD    | 256  | done   | read        |
| AIAD    | 256  | done   | read        |
| BIAD    | 256  | done   | read        |
| BNAM    | 256  | done   | read        |
| CIAD    | 256  | done   | read        |
| DIAD    | 256  | done   | read        |
| DNAM    | 256  | done   | read        |
| EIAD    | 256  | done   | read        |
| FIAD    | 256  | done   | read        |
| GIAD    | 256  | done   | read        |
| HIAD    | 256  | done   | read        |
| IIAD    | 256  | done   | read        |
| JIAD    | 256  | done   | read        |
| KIAD    | 256  | done   | read        |
| LIAD    | 256  | done   | read        |
| MIAD    | 256  | done   | read        |
| NAM1    | 256  | done   | read        |
| NAM2    | 256  | done   | read        |
| NAM3    | 256  | done   | read        |
| NAM4    | 256  | done   | read        |
| NIAD    | 256  | done   | read        |
| OIAD    | 256  | done   | read        |
| PIAD    | 256  | done   | read        |
| QIAD    | 256  | done   | read        |
| RIAD    | 256  | done   | read        |
| RNAM    | 256  | done   | read        |
| SIAD    | 256  | done   | read        |
| SNAM    | 256  | done   | read        |
| TIAD    | 256  | done   | read        |
| TNAM    | 256  | done   | read        |
| UNAM    | 256  | done   | read        |
| VNAM    | 256  | done   | read        |
| WNAM    | 256  | done   | read        |
| XNAM    | 256  | done   | read        |
| YNAM    | 256  | done   | read        |

### Records: IMGS (294)

| Item | Uses | Status | Where / why |
| ---- | ---- | ------ | ----------- |
| CNAM | 292  | done   | read        |
| DNAM | 277  | done   | read        |
| ENAM | 2    | done   | read        |
| HNAM | 292  | done   | read        |
| TNAM | 292  | done   | read        |

### Records: LGTM (130)

| Item | Uses | Status | Where / why |
| ---- | ---- | ------ | ----------- |
| DALC | 130  | done   | read        |
| DATA | 130  | done   | read        |

### Records: LIGH (504)

| Item | Uses | Status | Where / why    |
| ---- | ---- | ------ | -------------- |
| DATA | 504  | done   | read           |
| FNAM | 504  | done   | read           |
| FULL | 4    | done   | read           |
| MODL | 16   | done   | read           |
| MODT | 16   | n/a    | texture hashes |
| SNAM | 4    | n/a    | its sound      |
| VMAD | 2    | n/a    | scripts        |

### Records: SPGD (18)

| Item | Uses | Status | Where / why |
| ---- | ---- | ------ | ----------- |
| DATA | 18   | done   | read        |
| ICON | 16   | done   | read        |

### Records: TXST (789)

| Item | Uses | Status | Where / why |
| ---- | ---- | ------ | ----------- |
| DNAM | 784  | done   | read        |
| DODT | 59   | done   | read        |
| TX00 | 789  | done   | read        |
| TX01 | 777  | done   | read        |
| TX02 | 48   | done   | read        |
| TX03 | 190  | done   | read        |
| TX04 | 115  | done   | read        |
| TX05 | 60   | done   | read        |
| TX07 | 199  | done   | read        |

### Records: VOLI (42)

| Item | Uses | Status | Where / why |
| ---- | ---- | ------ | ----------- |
| CNAM | 42   | done   | read        |
| DNAM | 42   | done   | read        |
| ENAM | 42   | done   | read        |
| FNAM | 42   | done   | read        |
| GNAM | 42   | done   | read        |
| HNAM | 42   | done   | read        |
| INAM | 42   | done   | read        |
| JNAM | 42   | done   | read        |
| KNAM | 42   | done   | read        |
| LNAM | 42   | done   | read        |
| MNAM | 42   | done   | read        |
| NNAM | 42   | done   | read        |

### Records: WATR (58)

| Item | Uses | Status | Where / why                                       |
| ---- | ---- | ------ | ------------------------------------------------- |
| ANAM | 58   | done   | read                                              |
| DATA | 58   | done   | read                                              |
| DNAM | 58   | done   | read                                              |
| FNAM | 58   | done   | read                                              |
| FULL | 3    | n/a    | name                                              |
| GNAM | 58   | n/a    | empty in every vanilla water                      |
| INAM | 53   | done   | read                                              |
| NAM0 | 58   | done   | read                                              |
| NAM1 | 58   | done   | read                                              |
| NAM2 | 58   | done   | read                                              |
| NAM3 | 58   | done   | read                                              |
| NAM4 | 58   | done   | read                                              |
| NAM5 | 10   | open   | flow normals noise texture (RiverFlow.dds) unread |
| SNAM | 26   | n/a    | its sound                                         |
| TNAM | 7    | done   | read                                              |

### Records: WTHR (108)

| Item | Uses | Status | Where / why                               |
| ---- | ---- | ------ | ----------------------------------------- |
| 00TX | 95   | done   | read                                      |
| 10TX | 95   | done   | read                                      |
| 20TX | 43   | done   | read                                      |
| 30TX | 95   | done   | read                                      |
| 40TX | 28   | done   | read                                      |
| 50TX | 28   | done   | read                                      |
| 60TX | 28   | done   | read                                      |
| 70TX | 28   | done   | read                                      |
| 80TX | 70   | done   | read                                      |
| 90TX | 70   | done   | read                                      |
| :0TX | 64   | done   | read                                      |
| ;0TX | 71   | done   | read                                      |
| <0TX | 15   | done   | read                                      |
| =0TX | 15   | done   | read                                      |
| >0TX | 21   | done   | read                                      |
| ?0TX | 30   | done   | read                                      |
| @0TX | 35   | done   | read                                      |
| A0TX | 15   | done   | read                                      |
| B0TX | 13   | done   | read                                      |
| C0TX | 29   | done   | read                                      |
| D0TX | 31   | done   | read                                      |
| DALC | 108  | done   | read                                      |
| DATA | 108  | done   | read                                      |
| E0TX | 35   | done   | read                                      |
| F0TX | 35   | done   | read                                      |
| FNAM | 108  | done   | read                                      |
| G0TX | 15   | done   | read                                      |
| H0TX | 9    | done   | read                                      |
| HNAM | 93   | done   | read                                      |
| I0TX | 7    | done   | read                                      |
| IMSP | 108  | done   | read                                      |
| J0TX | 7    | done   | read                                      |
| JNAM | 108  | done   | read                                      |
| K0TX | 40   | done   | read                                      |
| L0TX | 92   | done   | read                                      |
| LNAM | 108  | open   | unknown u32 in xEdit (cloud layer count?) |
| MNAM | 108  | done   | read                                      |
| MODL | 38   | done   | read                                      |
| MODT | 38   | n/a    | texture hashes                            |
| NAM0 | 108  | done   | read                                      |
| NAM1 | 108  | done   | read                                      |
| NAM2 | 10   | open   | unknown in xEdit                          |
| NAM3 | 10   | open   | unknown in xEdit                          |
| NNAM | 108  | done   | read                                      |
| PNAM | 108  | done   | read                                      |
| QNAM | 108  | done   | read                                      |
| RNAM | 108  | done   | read                                      |
| SNAM | 36   | done   | read                                      |
| TNAM | 87   | done   | read                                      |

### Alternate textures (MODS)

| Item               | Uses | Status | Where / why                       |
| ------------------ | ---- | ------ | --------------------------------- |
| ACTI shape found   | 570  | done   | objectModelKey, GameSession.model |
| ACTI shape missing | 7    | open   | no shape of that name             |
| ALCH shape found   | 45   | done   | objectModelKey, GameSession.model |
| ALCH shape missing | 12   | open   | no shape of that name             |
| ARMO shape found   | 148  | done   | objectModelKey, GameSession.model |
| BOOK shape found   | 6    | done   | objectModelKey, GameSession.model |
| CONT shape found   | 26   | done   | objectModelKey, GameSession.model |
| DOOR shape found   | 13   | done   | objectModelKey, GameSession.model |
| DOOR shape missing | 5    | open   | no shape of that name             |
| FLOR shape found   | 22   | done   | objectModelKey, GameSession.model |
| FURN shape found   | 63   | done   | objectModelKey, GameSession.model |
| INGR shape found   | 6    | done   | objectModelKey, GameSession.model |
| INGR shape missing | 1    | open   | no shape of that name             |
| MISC shape found   | 14   | done   | objectModelKey, GameSession.model |
| MSTT shape found   | 138  | done   | objectModelKey, GameSession.model |
| STAT shape found   | 2115 | done   | objectModelKey, GameSession.model |
| STAT shape missing | 8    | open   | no shape of that name             |
| WEAP shape found   | 4    | done   | objectModelKey, GameSession.model |
