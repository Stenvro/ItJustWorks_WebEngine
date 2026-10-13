# Sound files

Skyrim - Sounds.bsa and Skyrim - Voices_en0.bsa hold 81 655 sound files
(`src/formats/audio/`; listing and decoding: `node tools/audio-info.ts <file> [--decode]`,
`--audit [folder]` for all of them; every vanilla file parses):

| Kind                                              | Files           | Format                                                |
| ------------------------------------------------- | --------------- | ----------------------------------------------------- |
| Voice (`sound\voice\<plugin>\<voice type>\*.fuz`) | 75 408 (78.8 h) | FUZ: lip-sync + xWMA, 44100 Hz, mono (539 stereo)     |
| Sound effects (`sound\fx\...\*.wav`)              | 5 978 (4.5 h)   | WAV, 16-bit PCM, mono or stereo, 11025–44100 Hz       |
| Music (`music\...\*.xwm`)                         | 269 (5.8 h)     | xWMA stereo, 32000/44100 Hz (the main theme 48000 Hz) |

A file's kind follows from its content (RIFF form type), not its extension.

## RIFF

`"RIFF"`, u32 size of the rest, the form type (`"WAVE"`, `"XWMA"`), then chunks: four-character
id, u32 size, data, a pad byte after odd sizes. Some files state a RIFF size past their end; the
chunks are read up to the end of the file.

**`fmt `** (WAVEFORMATEX): u16 format tag (1 PCM, 3 IEEE float, 0x161 WMA v2, 0x162 WMA Pro,
0xFFFE extensible: its sub-format GUID starts with the real tag), u16 channels, u32 sample rate,
u32 bytes per second, u16 block align, u16 bits per sample.

## WAV

The samples in `data`, interleaved, `blockAlign` bytes per frame. Vanilla uses only 16-bit PCM;
8-, 24- and 32-bit PCM and 32-bit float are read too (mods), compressed WAV formats (ADPCM) are
rejected. Other chunks:

- **`smpl`** (sampler, 36 bytes + 24 per loop): u32 loop count at 28; per loop cue id, type,
  start and end frame (end inclusive). 329 vanilla effects have one, usually the whole file
  (`_lp` ambience loops); see the descriptor's looping type for how a loop plays
  ([esm.md](esm.md#sounds)).
- `LIST` (INFO tags from the editing tools) and `CDif` (unknown, from Bethesda's tools) are not
  needed.

## xWMA

Windows Media Audio packets as XAudio2 plays them: `fmt ` with tag 0x161 (all of vanilla), then
**`dpds`**: per packet of `blockAlign` bytes a u32, the decoded byte count (16-bit samples) up to
its end, so the last one gives the length (the main theme: 1842 packets, 11 311 104 frames,
235.65 s); `data`: the packets.

Decoding: WMA v2 is decoded by ffmpeg compiled to WebAssembly (`@ffmpeg/core` 0.12.10, the
single-threaded build, GPL-2.0-or-later; `src/audio/xwma-decoder.ts`): the file goes into
ffmpeg's memory file system and comes out as 32-bit float PCM at the file's rate. The core is
served from `node_modules` (no CDN); in Node `tools/ffmpeg-node.ts` loads it for tools and tests.
Decoding the 3:55 main theme takes about 0.9 s, a voice line 0.1 s. ffmpeg's decoder can
overshoot ±1 slightly (peaks of 1.16 in the main theme), as the original's does.

## FUZ

`"FUZE"`, u32 version (1), u32 size of the lip data, the lip data (a `.lip` file: the face
animation of the line; 0 bytes for lines without it, such as shouts), then the audio (RIFF
`XWMA`). Reading the lip data for faces: TODO(M7).
