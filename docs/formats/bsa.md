# BSA v105 (Skyrim Special Edition)

Implementatie: `src/formats/bsa/bsa.ts`. Alles little-endian. Bronnen: UESP
"Skyrim Mod:Archive File Format", BSArch, lz4 frame/block-specificatie.

Geverifieerd op alle 23 vanilla-archieven (173.941 bestanden): hashes, offsets en
uitgepakte groottes kloppen (`node tools/bsa-list.ts <archief> --verify`).

## Header (36 bytes)

| Offset | Type    | Veld                                                        |
| ------ | ------- | ----------------------------------------------------------- |
| 0      | char[4] | `BSA\0`                                                     |
| 4      | u32     | versie: **105** (SSE). 104 = Oldrim (zlib), niet door SSE   |
| 8      | u32     | offset van de map-records (altijd 36)                       |
| 12     | u32     | archiefvlaggen (zie onder)                                  |
| 16     | u32     | aantal mappen                                               |
| 20     | u32     | aantal bestanden                                            |
| 24     | u32     | totale lengte mapnamen: **incl.** nul, **excl.** lengtebyte |
| 28     | u32     | totale lengte bestandsnamen (incl. nullen)                  |
| 32     | u16     | soorten inhoud (meshes 0x1, textures 0x2, ...): informatief |
| 34     | u16     | padding                                                     |

Archiefvlaggen: `0x1` mapnamen, `0x2` bestandsnamen, `0x4` standaard gecomprimeerd,
`0x8`/`0x10`/`0x20`/`0x80` retain-hints (geen invloed op lezen), `0x40` Xbox 360
(big-endian, niet ondersteund), `0x100` ingebedde bestandsnamen, `0x200` XMem.

## Indeling

1. **Map-records** (24 bytes in v105, 16 in v104): hash u64, aantal bestanden u32,
   padding u32, offset u64.
   - De offset wijst naar het bestandsrecord-block van de map **plus**
     `totalFileNameLength`. Echte positie = offset − totalFileNameLength.
2. **Bestandsrecord-blocks**, per map: bstring mapnaam (u8 lengte incl. nul, tekens, nul)
   als vlag `0x1`, dan per bestand 16 bytes: hash u64, grootte u32, offset u32 (absoluut).
   - Grootte: bit 30 (`0x40000000`) **draait** de standaardcompressie om voor dit bestand;
     de echte grootte is `size & 0x3FFFFFFF`.
3. **Namenblok** als vlag `0x2`: alle bestandsnamen als nul-afgesloten strings, in
   dezelfde volgorde als de bestandsrecords.
4. **Data**. Per bestand:
   - als vlag `0x100`: bstring met het volledige pad (u8 lengte, **zonder** nul);
   - als gecomprimeerd: u32 originele grootte, daarna **één LZ4-frame**;
   - anders: de ruwe bytes.

Namen zijn Windows-1252. Paden worden opgezocht in kleine letters (alleen A-Z, zoals
C `tolower`) met backslashes.

## Hash

64 bit; mappen hashen het hele pad, bestanden alleen de naam (extensie apart):

- laag (32 bit): `laatste + (voorlaatste << 8, alleen als lengte > 2) + (lengte << 16) +
(eerste << 24)` over de naam zonder extensie, OR vlag per extensie:
  `.kf` 0x80, `.nif` 0x8000, `.dds` 0x8080, `.wav` 0x80000000.
- hoog (32 bit): `h = h * 0x1003F + c` over de tekens 1..n−3 van de stam, plus dezelfde
  rolling hash over de extensie (inclusief de punt), modulo 2³².

Archieven zonder namen (vlaggen 0x1/0x2 uit) worden alleen op hash doorzocht; dat
ondersteunt `BsaArchive.get` ook.

## Vanilla-archieven

| Archief(en)               | Vlaggen | Compressie | Ingebedde namen |
| ------------------------- | ------- | ---------- | --------------- |
| Textures0-8               | 0x107   | alles      | ja              |
| Meshes0/1                 | 0x087   | alles      | nee             |
| Animations                | 0x007   | alles      | nee             |
| Sounds, Misc              | 0x013   | geen       | nee             |
| Voices_en0, Interface     | 0x003   | geen       | nee             |
| Creation Club, \_Resource | 0x083   | geen       | nee             |

## LZ4-frames in vanilla

- FLG `0x60` (onafhankelijke blocks) en soms `0x40` (**gekoppelde** blocks: matches
  verwijzen terug naar vorige blocks; de decoder moet het hele frame in één buffer
  decoderen).
- Maximale blockgrootte varieert: 64 KB t/m 4 MB (BD `0x40`-`0x70`).
- Geen block- of content-checksums, geen contentgrootte, geen dictionary. De
  header-checksum (`xxh32(descriptor) >> 8 & 0xFF`) staat er wel en wordt gecontroleerd.

De TypeScript-decoder (`src/formats/lz4/lz4.ts`) haalt ~400-650 MB/s inclusief
schijf-I/O in Node; snel genoeg om voorlopig geen WASM te gebruiken.
