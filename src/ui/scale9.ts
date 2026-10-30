// Scaling grids (DefineScalingGrid, a clip's scale9Grid), which Ruffle 0.7.1 does not draw: a
// sprite that carries one is cut into nine parts along the grid as it is scaled, its corners
// kept at their size, its edges stretched along one axis, its middle along both. About 100 of the
// game's sprites carry one (the item menus' and the start menu's scroll bar thumbs, the journal's
// border and scroll bars, the message box's frame, the map's markers, the text entry's frame).
// Scaleform cuts every shape under such a sprite, those of nested clips too (CLIK relies on it:
// its lists give their item container a 1 × 1 grid at the origin so that a scaled list keeps its
// items unscaled); a Flash player cuts only the sprite's own shapes.
//
// Done in two parts:
// - As the movie loads (`patchScalingGrids`): every shape placed in a grid sprite or in any
//   sprite under one is wrapped in a clip of its own (the wrapper: the shape in a clip named "o"),
//   and the movie gets, per such shape, a piece symbol exported to attach (a unit-square mask
//   clip "m" over the shape). The grid sprite's first frame registers it with its grid; the
//   wrapper's registers it with the grid sprite above it. The DefineScalingGrid tags go (the
//   grid is drawn here, never twice).
// - Each frame (`scale9Actions`, run by the bridge's frame clock): a grid sprite whose scale on
//   the stage changed (or that got new wrappers) maps its content's bounds (taken unsliced, the
//   first time it is scaled) along each axis in three parts: the parts before and after the grid
//   by 1 / scale (they keep their size), the grid's part stretched over the rest. Each wrapper
//   under it shows nine pieces, each the shape masked to one cell and placed by that cell's map;
//   unscaled, the shape shows as it is and no piece is made.
// Text fields are not cut (as in Flash). Scaled below the size of its corners, the corners
// shrink together to fit and the middle is nothing (Flash's rule, scale9Axis). A turned or
// mirrored grid sprite is measured along its own axes on the stage. With its scale as it was, a
// cut sprite's wrappers that moved in it (a list's items scrolling, a clip playing) are placed
// again. TODO(M13): a shape turned within its grid sprite (its pieces are cut along the shape's
// own axes, not the sprite's), and grids set at run time on clips with no shapes of their own (the
// journal lists' item containers: they are not scaled, so nothing shows). Platform-independent.
// Notes: docs/ui.md ("Ruffle's limits").

import { Avm1Writer, Function2Flag, Op, type PushValue } from '../formats/swf/avm1-writer.ts';
import { characterOffset } from '../formats/swf/place-object.ts';
import { readSwf, SwfTagCode, type SwfMovie, type SwfTag } from '../formats/swf/swf.ts';
import { concatBytes, encodeSwfString, encodeTag } from '../formats/swf/swf-writer.ts';

const DEFINE_SCALING_GRID = 78;
const SHAPES: ReadonlySet<number> = new Set([2, 22, 32, 83]);
/** Tags whose body starts with the id of the character they define (or name). */
const DEFINITIONS: ReadonlySet<number> = new Set([
  2, 6, 7, 10, 11, 13, 14, 20, 21, 22, 32, 33, 34, 35, 36, 37, 39, 46, 48, 60, 62, 75, 83, 84, 87,
  88, 90, 91, 1001, 1003, 1005, 1008, 1009,
]);
const PLACE_OBJECT2 = 26;
const PLACE_OBJECT3 = 70;
/** PlaceObject2/3's first flags byte: HasClipDepth. */
const HAS_CLIP_DEPTH = 0x40;

/** _global's functions and the list of grid sprites on stage. */
const GRID = '__itjwScale9Grid';
const WRAP = '__itjwScale9Wrap';
const TICK = '__itjwScale9Tick';
const WALK = '__itjwScale9Walk';
const APPLY = '__itjwScale9Apply';
const AXIS = '__itjwScale9Axis';
const CLIPS = '__itjwScale9Clips';
/** A grid sprite's members: its grid, scale, bounds, whether it changed, whether it was cut. */
const LEFT = '__itjwS9l';
const TOP = '__itjwS9t';
const RIGHT = '__itjwS9r';
const BOTTOM = '__itjwS9b';
const SCALE_X = '__itjwS9x';
const SCALE_Y = '__itjwS9y';
const BOUNDS = '__itjwS9n';
const DIRTY = '__itjwS9d';
const CUT = '__itjwS9c';
/** A grid sprite's member: only its content may have moved (its scale is as it was). */
const MOVED = '__itjwS9m';
/** A wrapper's member: where it stood and its scale in its sprite as it was last placed. */
const PLACED = '__itjwS9w';
/** A wrapper's member: the linkage name of its piece symbol (what marks a clip as a wrapper). */
const PIECE = '__itjwS9p';
export const SCALE9_WRAPPER = PIECE;
/** The linkage names of the piece symbols, by the shape's id. */
const PIECE_PREFIX = '__itjwScale9Piece';
/** The pieces' depths in a wrapper: PIECE_DEPTH + cell (row × 3 + column). */
const PIECE_DEPTH = 10;

/** The frame clock's call, each frame: `_global.__itjwScale9Tick()`. */
export function scale9Tick(w: Avm1Writer): void {
  w.push(0).getPath('_global').push(TICK).op(Op.callMethod).op(Op.pop);
}

/**
 * The movie with its scaling grids drawn by its own clips (see above); undefined when it has
 * none.
 */
export function patchScalingGrids(bytes: Uint8Array): Uint8Array | undefined {
  const movie = readSwf(bytes);
  const grids = new Map<number, readonly number[]>();
  const sprites = new Map<number, SwfTag>();
  let lastId = 0;
  for (const tag of movie.tags) {
    const body = tagBodyOf(movie, tag);
    if (DEFINITIONS.has(tag.code) || tag.code === DEFINE_SCALING_GRID) {
      lastId = Math.max(lastId, u16(body, 0));
    }
    if (tag.code === SwfTagCode.importAssets || tag.code === SwfTagCode.importAssets2) {
      lastId = Math.max(lastId, ...importedIds(body, tag.code));
    }
    if (tag.code === SwfTagCode.defineSprite) sprites.set(u16(body, 0), tag);
    if (tag.code === DEFINE_SCALING_GRID) grids.set(u16(body, 0), readRectPixels(body, 2));
  }
  const gridSprites = [...grids.keys()].filter((id) => sprites.has(id));
  if (gridSprites.length === 0) return undefined;

  // The sprites under a grid sprite (shared ones too: their wrappers find no grid elsewhere).
  const under = new Set<number>();
  const queue = [...gridSprites];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    if (under.has(id)) continue;
    under.add(id);
    for (const child of sprites.get(id)?.children ?? []) {
      const character = placedCharacter(movie, child);
      if (character !== undefined && sprites.has(character)) queue.push(character);
    }
  }
  // The shapes placed in them (not as masks): each gets a wrapper, a clip and a piece.
  const shapeIds = new Set<number>();
  for (const tag of movie.tags)
    if (SHAPES.has(tag.code)) shapeIds.add(u16(tagBodyOf(movie, tag), 0));
  const wrapped = new Map<number, { wrapper: number; clip: number; piece: number }>();
  for (const id of under) {
    for (const child of sprites.get(id)?.children ?? []) {
      const character = placedCharacter(movie, child);
      if (character === undefined || !shapeIds.has(character) || wrapped.has(character)) continue;
      if ((tagBodyOf(movie, child)[0] ?? 0) & HAS_CLIP_DEPTH) continue;
      wrapped.set(character, { wrapper: 0, clip: 0, piece: 0 });
    }
  }
  const nextId = (): number => {
    lastId++;
    if (lastId > 0xffff) throw new Error('no character ids left for the scaling grids');
    return lastId;
  };
  for (const ids of wrapped.values()) {
    ids.wrapper = nextId();
    ids.clip = nextId();
    ids.piece = nextId();
  }
  const maskShape = nextId();
  const mask = nextId();

  const parts: Uint8Array[] = [movie.bytes.subarray(0, headerLength(movie))];
  let maskDefined = false;
  for (const tag of movie.tags) {
    if (tag.code === DEFINE_SCALING_GRID) continue;
    const body = tagBodyOf(movie, tag);
    const id = u16(body, 0);
    if (tag.code === SwfTagCode.defineSprite && under.has(id)) {
      parts.push(encodeTag(tag.code, spriteBody(movie, tag, wrapped, grids.get(id))));
    } else {
      parts.push(encodeTag(tag.code, body));
    }
    const ids = SHAPES.has(tag.code) ? wrapped.get(id) : undefined;
    if (!ids) continue;
    if (!maskDefined) {
      parts.push(encodeTag(SwfTagCode.defineShape, squareShape(maskShape)));
      parts.push(encodeTag(SwfTagCode.defineSprite, sprite(mask, [place(1, maskShape)])));
      maskDefined = true;
    }
    const linkage = `${PIECE_PREFIX}${String(id)}`;
    parts.push(encodeTag(SwfTagCode.defineSprite, sprite(ids.clip, [place(1, id)])));
    parts.push(
      encodeTag(
        SwfTagCode.defineSprite,
        sprite(ids.piece, [place(1, mask, { name: 'm', clipDepth: 2 }), place(2, id)]),
      ),
    );
    parts.push(
      encodeTag(
        SwfTagCode.exportAssets,
        concatBytes([
          Uint8Array.of(1, 0, ids.piece & 0xff, ids.piece >> 8),
          encodeSwfString(linkage),
        ]),
      ),
    );
    const register = new Avm1Writer();
    register.push(linkage).push('this').op(Op.getVariable).push(2).getPath('_global');
    register.push(WRAP).op(Op.callMethod).op(Op.pop);
    parts.push(
      encodeTag(
        SwfTagCode.defineSprite,
        sprite(ids.wrapper, [
          encodeTag(SwfTagCode.doAction, concatBytes([register.bytes(), Uint8Array.of(0)])),
          place(1, ids.clip, { name: 'o' }),
        ]),
      ),
    );
  }
  const out = concatBytes(parts);
  out.set([0x46, 0x57, 0x53], 0);
  new DataView(out.buffer).setUint32(4, out.length, true);
  return out;
}

/** A sprite under a grid sprite: its shapes placed as their wrappers, a grid sprite registered. */
function spriteBody(
  movie: SwfMovie,
  tag: SwfTag,
  wrapped: ReadonlyMap<number, { readonly wrapper: number }>,
  grid: readonly number[] | undefined,
): Uint8Array {
  const body = tagBodyOf(movie, tag);
  const parts: Uint8Array[] = [body.subarray(0, 4)];
  if (grid) {
    // _global.__itjwScale9Grid(this, left, top, right, bottom), first in its first frame.
    const register = new Avm1Writer();
    register
      .push(...[...grid].reverse())
      .push('this')
      .op(Op.getVariable)
      .push(5);
    register.getPath('_global').push(GRID).op(Op.callMethod).op(Op.pop);
    parts.push(encodeTag(SwfTagCode.doAction, concatBytes([register.bytes(), Uint8Array.of(0)])));
  }
  for (const child of tag.children ?? []) {
    const childBody = tagBodyOf(movie, child).slice();
    const character = placedCharacter(movie, child);
    const ids = character === undefined ? undefined : wrapped.get(character);
    const at = characterOffset(childBody, child.code);
    if (ids && at !== undefined && !((childBody[0] ?? 0) & HAS_CLIP_DEPTH)) {
      childBody[at] = ids.wrapper & 0xff;
      childBody[at + 1] = ids.wrapper >> 8;
    }
    parts.push(encodeTag(child.code, childBody));
  }
  return concatBytes(parts);
}

/** The character a PlaceObject2/3 places, if it places one. */
function placedCharacter(movie: SwfMovie, tag: SwfTag): number | undefined {
  if (tag.code !== PLACE_OBJECT2 && tag.code !== PLACE_OBJECT3) return undefined;
  const body = tagBodyOf(movie, tag);
  const at = characterOffset(body, tag.code);
  return at === undefined ? undefined : u16(body, at);
}

/** A one-frame sprite of the given (encoded) tags. */
function sprite(id: number, tags: readonly Uint8Array[]): Uint8Array {
  return concatBytes([
    Uint8Array.of(id & 0xff, id >> 8, 1, 0),
    ...tags,
    encodeTag(SwfTagCode.showFrame, new Uint8Array(0)),
    encodeTag(SwfTagCode.end, new Uint8Array(0)),
  ]);
}

/** PlaceObject2 of a character at a depth, unmoved, optionally named or masking up to a depth. */
function place(
  depth: number,
  character: number,
  options: { readonly name?: string; readonly clipDepth?: number } = {},
): Uint8Array {
  const flags = 0x02 | (options.name ? 0x20 : 0) | (options.clipDepth ? HAS_CLIP_DEPTH : 0);
  const parts: Uint8Array[] = [
    Uint8Array.of(flags, depth & 0xff, depth >> 8, character & 0xff, character >> 8),
  ];
  if (options.name) parts.push(encodeSwfString(options.name));
  if (options.clipDepth)
    parts.push(Uint8Array.of(options.clipDepth & 0xff, options.clipDepth >> 8));
  return encodeTag(PLACE_OBJECT2, concatBytes(parts));
}

/**
 * A DefineShape of a filled 100 × 100 pixel square from the origin (the pieces' mask: scaled to
 * a cell by its clip).
 */
function squareShape(id: number): Uint8Array {
  const bits = new BitWriter();
  // Bounds: 0..2000 twips both ways, 13-bit fields.
  bits.unsigned(13, 5);
  for (const value of [0, 2000, 0, 2000]) bits.signed(value, 13);
  bits.align();
  // One solid fill (white), no lines; 1 fill bit, 0 line bits.
  bits.unsigned(1, 8).unsigned(0, 8).unsigned(0xffffff, 24).unsigned(0, 8);
  bits.unsigned(1, 4).unsigned(0, 4);
  // Move to the origin with fill style 0 = 1.
  bits.unsigned(0b000011, 6).unsigned(1, 5).signed(0, 1).signed(0, 1).unsigned(1, 1);
  // Four straight edges (general lines, 13-bit deltas), then the end.
  for (const [dx, dy] of [
    [2000, 0],
    [0, 2000],
    [-2000, 0],
    [0, -2000],
  ] as const) {
    bits
      .unsigned(0b11, 2)
      .unsigned(13 - 2, 4)
      .unsigned(1, 1)
      .signed(dx, 13)
      .signed(dy, 13);
  }
  bits.unsigned(0, 6).align();
  return concatBytes([Uint8Array.of(id & 0xff, id >> 8), bits.bytes()]);
}

class BitWriter {
  readonly #bits: number[] = [];

  unsigned(value: number, count: number): this {
    for (let i = count - 1; i >= 0; i--) this.#bits.push(Math.floor(value / 2 ** i) % 2);
    return this;
  }

  signed(value: number, count: number): this {
    return this.unsigned(value < 0 ? 2 ** count + value : value, count);
  }

  align(): this {
    while (this.#bits.length % 8 !== 0) this.#bits.push(0);
    return this;
  }

  bytes(): Uint8Array {
    this.align();
    const out = new Uint8Array(this.#bits.length / 8);
    for (let i = 0; i < out.length; i++) {
      out[i] = this.#bits.slice(i * 8, i * 8 + 8).reduce((byte, bit) => byte * 2 + bit, 0);
    }
    return out;
  }
}

/** A RECT's left, top, right and bottom in pixels. */
function readRectPixels(body: Uint8Array, at: number): number[] {
  let bit = at * 8;
  const read = (count: number): number => {
    let value = 0;
    for (let i = 0; i < count; i++) {
      value = value * 2 + (((body[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1);
      bit++;
    }
    return value;
  };
  const size = read(5);
  const signed = (): number => {
    const value = read(size);
    return size > 0 && value >= 2 ** (size - 1) ? value - 2 ** size : value;
  };
  const [xMin, xMax, yMin, yMax] = [signed(), signed(), signed(), signed()];
  return [xMin / 20, yMin / 20, xMax / 20, yMax / 20];
}

/** The ids ImportAssets/ImportAssets2 give the symbols it imports. */
function importedIds(body: Uint8Array, code: number): number[] {
  let at = body.indexOf(0) + 1;
  if (code === SwfTagCode.importAssets2) at += 2;
  const count = u16(body, at);
  at += 2;
  const ids: number[] = [];
  for (let i = 0; i < count && at < body.length; i++) {
    ids.push(u16(body, at));
    at = body.indexOf(0, at + 2) + 1;
    if (at === 0) break;
  }
  return ids;
}

function headerLength(movie: SwfMovie): number {
  const rectBits = 5 + 4 * ((movie.bytes[8] ?? 0) >> 3);
  return 8 + Math.ceil(rectBits / 8) + 4;
}

function tagBodyOf(movie: SwfMovie, tag: SwfTag): Uint8Array {
  return movie.bytes.subarray(tag.offset, tag.offset + tag.length);
}

function u16(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

// --- Run time -------------------------------------------------------------------------------

const reg = (register: number): PushValue => ({ register });
const FLAGS = Function2Flag.suppressThis | Function2Flag.suppressArguments;

function member(body: Avm1Writer, register: number, name: string): Avm1Writer {
  return body.push(reg(register), name).op(Op.getMember);
}

function store(body: Avm1Writer, register: number): Avm1Writer {
  return body.storeRegister(register).op(Op.pop);
}

/** `_global[name](args...)`, its result dropped; the arguments as registers, first first. */
function callGlobal(body: Avm1Writer, name: string, args: readonly number[]): Avm1Writer {
  body
    .push(...[...args].reverse().map(reg), args.length)
    .getPath('_global')
    .push(name);
  return body.op(Op.callMethod).op(Op.pop);
}

/** _global's functions the grid sprites and the frame clock call (put into every menu). */
export function scale9Actions(w: Avm1Writer): void {
  // _global.__itjwScale9Clips = _global.__itjwScale9Clips || [] (a movie loaded into another
  // shares the player's _global).
  w.getPath(`_global.${CLIPS}`).push(null).op(Op.equals2).op(Op.not).ifTo('scale9Listed');
  w.getPath('_global').push(CLIPS, 0).op(Op.initArray).op(Op.setMember);
  w.label('scale9Listed');
  defineGrid(w);
  defineWrap(w);
  defineTick(w);
  defineWalk(w);
  defineApply(w);
  defineAxis(w);
}

/** __itjwScale9Grid(clip, left, top, right, bottom): a grid sprite registered (once). */
function defineGrid(w: Avm1Writer): void {
  w.getPath('_global').push(GRID);
  w.function2('', ['clip', 'left', 'top', 'right', 'bottom'], 6, FLAGS, (body) => {
    member(body, 1, LEFT).push(null).op(Op.equals2).op(Op.not).ifTo('done');
    for (const [name, register] of [
      [LEFT, 2],
      [TOP, 3],
      [RIGHT, 4],
      [BOTTOM, 5],
    ] as const) {
      body.push(reg(1), name, reg(register)).op(Op.setMember);
    }
    body.push(reg(1), DIRTY, true).op(Op.setMember);
    body.push(reg(1), 1).getPath(`_global.${CLIPS}`).push('push').op(Op.callMethod).op(Op.pop);
    body.label('done');
  });
  w.op(Op.setMember);
}

/**
 * __itjwScale9Wrap(wrapper, piece): a wrapper given its piece symbol; the grid sprite above it
 * (if any) marked changed, to place it.
 */
function defineWrap(w: Avm1Writer): void {
  w.getPath('_global').push(WRAP);
  w.function2('', ['wrapper', 'piece'], 4, FLAGS, (body) => {
    body.push(reg(1), PIECE, reg(2)).op(Op.setMember);
    store(member(body, 1, '_parent'), 3);
    body.label('up');
    body.push(reg(3), null).op(Op.equals2).ifTo('done');
    member(body, 3, LEFT).push(null).op(Op.equals2).ifTo('next');
    body.push(reg(3), DIRTY, true).op(Op.setMember).jumpTo('done');
    body.label('next');
    store(member(body, 3, '_parent'), 3).jumpTo('up');
    body.label('done');
  });
  w.op(Op.setMember);
}

/**
 * The length of the line from one point (an object in register `from`) to another, / 100, into
 * register `out` (registers 9 and 10 used on the way): a clip's scale along one of its axes
 * from its points (0, 0) and (100, 0) or (0, 100) on the stage, whether it is turned or not.
 */
function scaleAlong(body: Avm1Writer, from: number, to: number, out: number): void {
  member(body, to, 'x');
  member(body, from, 'x').op(Op.subtract);
  store(body, 9);
  member(body, to, 'y');
  member(body, from, 'y').op(Op.subtract);
  store(body, 10);
  body.push(reg(9), reg(9)).op(Op.multiply).push(reg(10), reg(10)).op(Op.multiply).op(Op.add2);
  body.push(1).getPath('Math').push('sqrt').op(Op.callMethod).push(100).op(Op.divide);
  store(body, out);
}

/**
 * __itjwScale9Tick(): each grid sprite on stage whose scale on the stage changed (or that got
 * new wrappers) placed again; a cut one whose scale stayed has its wrappers that moved in it
 * placed again (MOVED); those gone dropped. Its scale on the stage is measured along each of
 * its own axes (as long as its axes are on the stage), so a turned or mirrored sprite keeps its
 * corners. Registers: 1 list, 2 index, 3 sprite, 4, 5 and 8 its points (0, 0), (100, 0) and
 * (0, 100) on the stage, 6 and 7 its scale, 9 and 10 for the lengths.
 */
function defineTick(w: Avm1Writer): void {
  w.getPath('_global').push(TICK);
  w.function2('', [], 11, FLAGS, (body) => {
    store(body.getPath(`_global.${CLIPS}`), 1);
    body.push(reg(1), null).op(Op.equals2).ifTo('end');
    store(member(body, 1, 'length'), 2);
    body.label('next');
    store(body.push(reg(2)).op(Op.decrement), 2);
    body.push(reg(2), 0).op(Op.less2).ifTo('end');
    store(body.push(reg(1), reg(2)).op(Op.getMember), 3);
    member(body, 3, '_xscale').push(null).op(Op.equals2).op(Op.not).ifTo('alive');
    body.push(1, reg(2), 2, reg(1), 'splice').op(Op.callMethod).op(Op.pop).jumpTo('next');
    body.label('alive');
    for (const [register, x, y] of [
      [4, 0, 0],
      [5, 100, 0],
      [8, 0, 100],
    ] as const) {
      store(body.push('x', x, 'y', y, 2).op(Op.initObject), register);
      body.push(reg(register), 1, reg(3), 'localToGlobal').op(Op.callMethod).op(Op.pop);
    }
    scaleAlong(body, 4, 5, 6);
    scaleAlong(body, 4, 8, 7);
    member(body, 3, DIRTY).ifTo('changed');
    member(body, 3, SCALE_X).push(reg(6)).op(Op.equals2).op(Op.not).ifTo('changed');
    member(body, 3, SCALE_Y).push(reg(7)).op(Op.equals2).op(Op.not).ifTo('changed');
    // Its scale as it was: once cut and scaled, the wrappers that moved in it are placed again.
    member(body, 3, CUT).op(Op.not).ifTo('next');
    body.push(reg(6), 1).op(Op.equals2).op(Op.not).ifTo('moved');
    body.push(reg(7), 1).op(Op.equals2).ifTo('next');
    body.label('moved');
    body.push(reg(3), MOVED, true).op(Op.setMember);
    callGlobal(body, WALK, [3, 3, 6, 7]).jumpTo('next');
    body.label('changed');
    body.push(reg(3), MOVED, false).op(Op.setMember);
    body.push(reg(3), SCALE_X, reg(6)).op(Op.setMember);
    body.push(reg(3), SCALE_Y, reg(7)).op(Op.setMember);
    body.push(reg(3), DIRTY, false).op(Op.setMember);
    // Never cut and unscaled: nothing to do.
    member(body, 3, CUT).ifTo('walk');
    body.push(reg(6), 1).op(Op.equals2).op(Op.not).ifTo('first');
    body.push(reg(7), 1).op(Op.equals2).op(Op.not).ifTo('first');
    body.jumpTo('next');
    // Cut the first time: its content's bounds, all of it still unsliced.
    body.label('first');
    body.push(reg(3), BOUNDS, reg(3), 1, reg(3), 'getBounds').op(Op.callMethod).op(Op.setMember);
    body.push(reg(3), CUT, true).op(Op.setMember);
    body.label('walk');
    callGlobal(body, WALK, [3, 3, 6, 7]).jumpTo('next');
    body.label('end');
  });
  w.op(Op.setMember);
}

/**
 * __itjwScale9Walk(clip, sprite, scaleX, scaleY): every wrapper under the clip placed, down to
 * (not into) grid sprites of their own. Registers: 5 a member's name, 6 the member.
 */
function defineWalk(w: Avm1Writer): void {
  w.getPath('_global').push(WALK);
  w.function2('', ['clip', 'sprite', 'scaleX', 'scaleY'], 7, FLAGS, (body) => {
    body.push(reg(1)).op(Op.enumerate2);
    body.label('next');
    body.storeRegister(5).push(null).op(Op.equals2).ifTo('done');
    store(body.push(reg(1), reg(5)).op(Op.getMember), 6);
    body.push(reg(6)).op(Op.typeOf).push('movieclip').op(Op.equals2).op(Op.not).ifTo('next');
    member(body, 6, '_parent').push(reg(1)).op(Op.equals2).op(Op.not).ifTo('next');
    member(body, 6, PIECE).push(null).op(Op.equals2).ifTo('inner');
    callGlobal(body, APPLY, [6, 2, 3, 4]).jumpTo('next');
    body.label('inner');
    member(body, 6, LEFT).push(null).op(Op.equals2).op(Op.not).ifTo('next');
    callGlobal(body, WALK, [6, 2, 3, 4]).jumpTo('next');
    body.label('done');
  });
  w.op(Op.setMember);
}

/**
 * __itjwScale9Apply(wrapper, sprite, scaleX, scaleY): the wrapper's shape shown whole (unscaled)
 * or as nine pieces. Registers: 5 and 6 two of its points in the sprite's space, 7 and 8 its scale
 * there, 9 and 10 its origin there, 11 and 12 the maps of the two axes, 13 row, 14 column,
 * 15 piece, 16 its name then its mask, 17 the sprite's bounds, 18 index, 19-22 a cell's map
 * (scale, offset, from, to).
 */
function defineApply(w: Avm1Writer): void {
  w.getPath('_global').push(APPLY);
  w.function2('', ['wrapper', 'sprite', 'scaleX', 'scaleY'], 23, FLAGS, (body) => {
    body.push(reg(3), 1).op(Op.equals2).op(Op.not).ifTo('cut');
    body.push(reg(4), 1).op(Op.equals2).op(Op.not).ifTo('cut');
    // Unscaled: the shape itself, the pieces (any made) hidden.
    member(body, 1, 'o').push('_visible', true).op(Op.setMember);
    store(body.push(0), 18);
    body.label('hide');
    body.push(reg(1), 'p', reg(18)).op(Op.add2).op(Op.getMember);
    body.push('_visible', false).op(Op.setMember);
    store(body.push(reg(18)).op(Op.increment), 18);
    body.push(reg(18), 9).op(Op.less2).ifTo('hide');
    body.jumpTo('end');

    body.label('cut');
    // The wrapper's place in the sprite's space (its scale and origin there).
    for (const [register, at] of [
      [5, 0],
      [6, 100],
    ] as const) {
      store(body.push('x', at, 'y', at, 2).op(Op.initObject), register);
      body.push(reg(register), 1, reg(1), 'localToGlobal').op(Op.callMethod).op(Op.pop);
      body.push(reg(register), 1, reg(2), 'globalToLocal').op(Op.callMethod).op(Op.pop);
    }
    for (const [register, axis] of [
      [7, 'x'],
      [8, 'y'],
    ] as const) {
      member(body, 6, axis);
      member(body, 5, axis).op(Op.subtract).push(100).op(Op.divide);
      store(body, register);
    }
    store(member(body, 5, 'x'), 9);
    store(member(body, 5, 'y'), 10);
    body.push(reg(7), 0).op(Op.equals2).ifTo('end');
    body.push(reg(8), 0).op(Op.equals2).ifTo('end');
    // Where it stands and its scale in the sprite, as text; with the sprite's scale as it was
    // (MOVED), a wrapper that has not moved is left as it is.
    body.push(reg(9), ',').op(Op.add2).push(reg(10)).op(Op.add2).push(',').op(Op.add2);
    body.push(reg(7)).op(Op.add2).push(',').op(Op.add2).push(reg(8)).op(Op.add2);
    store(body, 16);
    member(body, 2, MOVED).op(Op.not).ifTo('place');
    member(body, 1, PLACED).push(reg(16)).op(Op.equals2).ifTo('end');
    body.label('place');
    body.push(reg(1), PLACED, reg(16)).op(Op.setMember);
    store(member(body, 2, BOUNDS), 17);
    // The axes' maps: __itjwScale9Axis(boundsMin, boundsMax, gridMin, gridMax, scale).
    for (const [register, scale, min, max, from, to] of [
      [11, 3, 'xMin', 'xMax', LEFT, RIGHT],
      [12, 4, 'yMin', 'yMax', TOP, BOTTOM],
    ] as const) {
      body.push(reg(scale));
      member(body, 2, to);
      member(body, 2, from);
      member(body, 17, max);
      member(body, 17, min);
      body.push(5).getPath('_global').push(AXIS).op(Op.callMethod);
      store(body, register);
    }
    member(body, 1, 'o').push('_visible', false).op(Op.setMember);
    store(body.push(0), 13);
    body.label('row');
    store(body.push(0), 14);
    body.label('column');
    // The piece "p" + (row × 3 + column), attached the first time.
    body.push('p', reg(13), 3).op(Op.multiply).push(reg(14)).op(Op.add2).op(Op.add2);
    store(body, 16);
    store(body.push(reg(1), reg(16)).op(Op.getMember), 15);
    body.push(reg(15), null).op(Op.equals2).op(Op.not).ifTo('have');
    body.push(reg(13), 3).op(Op.multiply).push(reg(14)).op(Op.add2).push(PIECE_DEPTH).op(Op.add2);
    body.push(reg(16));
    member(body, 1, PIECE);
    body.push(3, reg(1), 'attachMovie').op(Op.callMethod);
    store(body, 15);
    body.label('have');
    body.push(reg(15), '_visible', true).op(Op.setMember);
    store(member(body, 15, 'm'), 16);
    for (const [map, cell, origin, scale, position, size] of [
      [11, 14, 9, 7, '_x', '_xscale'],
      [12, 13, 10, 8, '_y', '_yscale'],
    ] as const) {
      // The cell's map: scale, offset, from, to (map[cell × 4 + 0..3]).
      for (let i = 0; i < 4; i++) {
        body.push(reg(map), reg(cell), 4).op(Op.multiply).push(i).op(Op.add2).op(Op.getMember);
        store(body, 19 + i);
      }
      // The piece: scale × 100 %, at (scale × origin + offset − origin) / wrapper's scale.
      body.push(reg(15), size, reg(19), 100).op(Op.multiply).op(Op.setMember);
      body.push(reg(15), position, reg(19), reg(origin)).op(Op.multiply);
      body.push(reg(20)).op(Op.add2).push(reg(origin)).op(Op.subtract);
      body.push(reg(scale)).op(Op.divide).op(Op.setMember);
      // Its mask: the cell in the shape's space (the 100-pixel square scaled to it).
      body.push(reg(16), position, reg(21), reg(origin)).op(Op.subtract);
      body.push(reg(scale)).op(Op.divide).op(Op.setMember);
      body.push(reg(16), size, reg(22), reg(21)).op(Op.subtract);
      body.push(reg(scale)).op(Op.divide).op(Op.setMember);
    }
    store(body.push(reg(14)).op(Op.increment), 14);
    body.push(reg(14), 3).op(Op.less2).ifTo('column');
    store(body.push(reg(13)).op(Op.increment), 13);
    body.push(reg(13), 3).op(Op.less2).ifTo('row');
    body.label('end');
  });
  w.op(Op.setMember);
}

/** One cell of an axis's map: a point x in [from, to] goes to scale × x + offset. */
export interface Scale9Cell {
  readonly scale: number;
  readonly offset: number;
  readonly from: number;
  readonly to: number;
}

/**
 * One axis of a grid sprite scaled by `scale` on the stage, in its own space (what
 * __itjwScale9Axis computes in the movies): the parts before and after the grid keep their size
 * on the stage (1 / scale here), the grid's part takes the rest. Scaled below the size of those
 * two parts, they shrink together to fit and the grid's part is nothing (Flash's rule for a
 * scale9Grid, which Scaleform follows).
 */
export function scale9Axis(
  min: number,
  max: number,
  gridMin: number,
  gridMax: number,
  scale: number,
): [Scale9Cell, Scale9Cell, Scale9Cell] {
  const fixed = gridMin - min + (max - gridMax);
  const keep = fixed > 0 && scale * (max - min) < fixed ? (max - min) / fixed : 1 / scale;
  const start = min + (gridMin - min) * keep;
  const end = max - (max - gridMax) * keep;
  const middle = gridMin < gridMax ? Math.max(0, (end - start) / (gridMax - gridMin)) : 0;
  return [
    { scale: keep, offset: min - min * keep, from: min, to: gridMin },
    { scale: middle, offset: start - gridMin * middle, from: gridMin, to: gridMax },
    { scale: keep, offset: max - max * keep, from: gridMax, to: max },
  ];
}

/**
 * __itjwScale9Axis(min, max, gridMin, gridMax, scale): one axis's map, as an array of three
 * cells (before, on and after the grid), each [scale, offset, from, to]: a point x of the cell
 * goes to scale × x + offset (scale9Axis says the same in TypeScript). Registers: 6 where the
 * grid's part starts (first the fixed parts' size), 7 where it ends, 8 its scale, 9 the fixed
 * parts' scale.
 */
function defineAxis(w: Avm1Writer): void {
  w.getPath('_global').push(AXIS);
  w.function2('', ['min', 'max', 'gridMin', 'gridMax', 'scale'], 10, FLAGS, (body) => {
    // keep = 1 / scale; below the fixed parts' size (gridMin − min + max − gridMax) on the
    // stage, keep = (max − min) / that size.
    store(body.push(1, reg(5)).op(Op.divide), 9);
    body.push(reg(3), reg(1)).op(Op.subtract).push(reg(2), reg(4)).op(Op.subtract).op(Op.add2);
    store(body, 6);
    body.push(reg(6), 0).op(Op.greater).op(Op.not).ifTo('fits');
    body.push(reg(5), reg(2), reg(1)).op(Op.subtract).op(Op.multiply).push(reg(6)).op(Op.less2);
    body.op(Op.not).ifTo('fits');
    store(body.push(reg(2), reg(1)).op(Op.subtract).push(reg(6)).op(Op.divide), 9);
    body.label('fits');
    // start = min + (gridMin − min) × keep; end = max − (max − gridMax) × keep
    body.push(reg(1), reg(3), reg(1)).op(Op.subtract).push(reg(9)).op(Op.multiply).op(Op.add2);
    store(body, 6);
    body.push(reg(2), reg(2), reg(4)).op(Op.subtract).push(reg(9)).op(Op.multiply);
    store(body.op(Op.subtract), 7);
    // The grid's part: (end − start) / (gridMax − gridMin), never below 0.
    store(body.push(0), 8);
    body.push(reg(3), reg(4)).op(Op.less2).op(Op.not).ifTo('flat');
    body.push(reg(7), reg(6)).op(Op.subtract).push(reg(4), reg(3)).op(Op.subtract);
    store(body.op(Op.divide), 8);
    body.push(reg(8), 0).op(Op.less2).op(Op.not).ifTo('flat');
    store(body.push(0), 8);
    body.label('flat');
    // [keep, min − min·keep, min, gridMin,  k, start − gridMin·k, gridMin, gridMax,
    //  keep, max − max·keep, gridMax, max], pushed last first (the cells end at the bounds:
    // masks reaching past them would widen the sprite).
    body.push(reg(2), reg(4), reg(2), reg(2), reg(9)).op(Op.multiply).op(Op.subtract);
    body.push(reg(9));
    body.push(reg(4), reg(3), reg(6), reg(3), reg(8)).op(Op.multiply).op(Op.subtract);
    body.push(reg(8));
    body.push(reg(3), reg(1), reg(1), reg(1), reg(9)).op(Op.multiply).op(Op.subtract);
    body.push(reg(9));
    body.push(12).op(Op.initArray).op(Op.return);
  });
  w.op(Op.setMember);
}
