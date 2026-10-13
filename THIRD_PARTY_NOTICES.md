# Third-party notices

ItJustWorks-Webengine is licensed under the GNU General Public License v3.0 or later
([`LICENSE`](LICENSE)). It contains code adapted from the projects below, and uses the packages
listed under "Dependencies" at run time. Their copyright notices and licence terms follow.
Game content is never part of this repository: the engine reads the user's own installation.

## Code adapted into this repository

### Community Shaders

<https://github.com/doodlum/skyrim-community-shaders> — GNU General Public License v3.0.

Community Shaders reproduces the vanilla Skyrim Special Edition shaders in HLSL. The following
WGSL shaders follow those reproductions (structure, formulas and constants), translated to
WGSL: `src/render/shaders/lighting.wgsl` (Lighting.hlsl), `terrain.wgsl` (Lighting.hlsl,
LANDSCAPE), `snow.wgsl` (ISSAOComposite.hlsl, Lighting.hlsl), `snow-sss.wgsl`
(ISSnowSSS.hlsl), `refraction-composite.wgsl` (ISRefraction.hlsl), `dof.wgsl`
(ISDepthOfField.hlsl), `sao.wgsl` (ISSAOCameraZ, ISSAOMinify, ISSAOBlur, ISSAOComposite),
`post.wgsl` and `luminance.wgsl` (ISHDR.hlsl), `effect.wgsl` and `precipitation.wgsl` (Effect
and Particle shaders), and the sky and sun path in `src/world/sky-state.ts`.

### webgl-noise (simplex noise)

<https://github.com/ashima/webgl-noise> — used in `src/render/shaders/snow.wgsl`.

```
Copyright (C) 2011 by Ashima Arts (Simplex noise)
Copyright (C) 2011-2016 by Stefan Gustavson (Classic noise and others)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### Separable Subsurface Scattering

<https://github.com/iryoku/separable-sss> — the sample kernel in
`src/render/shaders/snow-sss.wgsl`.

Uses Separable SSS. Copyright (C) 2012 by Jorge Jimenez and Diego Gutierrez.

```
Copyright (C) 2012 Jorge Jimenez (jorge@iryoku.com)
Copyright (C) 2012 Diego Gutierrez (diegog@unizar.es)
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

   1. Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.

   2. Redistributions in binary form must reproduce the following disclaimer
      in the documentation and/or other materials provided with the
      distribution:

      "Uses Separable SSS. Copyright (C) 2012 by Jorge Jimenez and Diego
       Gutierrez."

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS ``AS
IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL COPYRIGHT HOLDERS OR CONTRIBUTORS
BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.

The views and conclusions contained in the software and documentation are
those of the authors and should not be interpreted as representing official
policies, either expressed or implied, of the copyright holders.
```

### Scalable Ambient Obscurance (reference implementation)

Morgan McGuire, Michael Mara and David Luebke, "Scalable Ambient Obscurance", HPG 2012 — the
depth packing, minification, spiral sampling and blur in `src/render/shaders/sao.wgsl`.

```
Open Source under the "BSD" license: http://www.opensource.org/licenses/bsd-license.php

Copyright (c) 2011-2012, NVIDIA
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are
permitted provided that the following conditions are met:

Redistributions of source code must retain the above copyright notice, this list of
conditions and the following disclaimer.
Redistributions in binary form must reproduce the above copyright notice, this list of
conditions and the following disclaimer in the documentation and/or other materials
provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS
OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Dependencies

Installed from npm, not part of this repository; a built copy of the engine includes them.

| Package                                                                                                                              | Licence                   | Use                 |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- | ------------------- |
| [@ffmpeg/core](https://github.com/ffmpegwasm/ffmpeg.wasm) 0.12 (FFmpeg compiled to WebAssembly)                                      | GPL-2.0-or-later          | decoding xWMA audio |
| [@dimforge/rapier3d-compat](https://rapier.rs)                                                                                       | Apache-2.0                | physics             |
| [@fontsource/cinzel](https://fontsource.org/fonts/cinzel), [@fontsource/jetbrains-mono](https://fontsource.org/fonts/jetbrains-mono) | SIL Open Font License 1.1 | the shell's fonts   |

Development tools (TypeScript, Vite, Vitest, ESLint, Prettier and their dependencies) are
under MIT, Apache-2.0, BSD, ISC and MPL-2.0 licences and are not part of a build.

## Documentation the engine was written from

File formats and engine behaviour were worked out from public documentation and tools, not
from their code: [UESP](https://en.uesp.net/wiki/Skyrim_Mod:Mod_File_Format) (CC BY-SA 2.5),
[nif.xml](https://github.com/niftools/nifxml) and NifSkope,
[xEdit](https://github.com/TES5Edit/TES5Edit) record definitions,
[CommonLibSSE-NG](https://github.com/CharmedBaryon/CommonLibSSE-NG), Champollion (Papyrus
bytecode), hkxcmd / HKX2 / serde-hkx (Havok packfiles), BSArch, the Creation Kit wiki, and
the [Step](https://stepmodifications.org) INI guides and default value lists. LZ4, xxHash32
and zlib (inflate) are implemented here from their specifications.

## Trademarks

The Elder Scrolls, Skyrim and Bethesda are trademarks of ZeniMax Media Inc. Havok is a
trademark of Microsoft. This project is not affiliated with or endorsed by them; it needs a
legitimately owned copy of The Elder Scrolls V: Skyrim Special Edition to run.
