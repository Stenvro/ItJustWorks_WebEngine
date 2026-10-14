// What the engine puts into each menu movie before it plays, standing in for the Scaleform
// player around it (GFx's Movie API and ExternalInterface as the game's code uses them):
//
// - Menu → engine: the menus call the engine through flash.external.ExternalInterface.call
//   (gfx.io.GameDelegate.call(name, params, scope, callback) calls it with the method name, a
//   request id and the params). Several menus play at once, so each call is tagged with the
//   menu it comes from: ExternalInterface.call becomes a call of BRIDGE_CALL(menu, name, ...).
// - Engine → menu: GFx lets the engine invoke any function and set or read any variable by its
//   path ("_root.HUDMovieBaseInstance.SetCompassAngle"); a Flash player only calls what a movie
//   registered with ExternalInterface.addCallback, so the bridge registers three such callbacks
//   that do it by path. GameDelegate's own callbacks ("call", "respond") stay as the menu
//   registers them.
// - _global.gfxExtensions is true, as under Scaleform (the menus test it).
//
// The bridge is a DoAction put first in the movie's first frame, so it runs before the menu's
// own frame scripts. Platform-independent. Notes: docs/ui.md.

import { Avm1Writer, Function2Flag, Op, type PushValue } from '../formats/swf/avm1-writer.ts';
import { textFieldExtensions } from './gfx-text.ts';
import { readSwf, SwfTagCode, tagBody } from '../formats/swf/swf.ts';
import { concatBytes, encodeTag, writeSwf } from '../formats/swf/swf-writer.ts';
import type { Rect } from './stage-rects.ts';

/** The page's function the menus' ExternalInterface calls reach (menu id, name, args...). */
export const BRIDGE_CALL = '__itjwMenuCall';
/** Callbacks the bridge registers: invoke(objectPath, method, args), set / get by path. */
export const BRIDGE_INVOKE = '__itjwInvoke';
export const BRIDGE_SET = '__itjwSetVariable';
export const BRIDGE_GET = '__itjwGetVariable';
/** A menu asks the engine to translate a key it sets at run time (GFx's translator). */
export const BRIDGE_TRANSLATE = '__itjwTranslate';
/**
 * A clip a menu passes to the engine reaches it as this prefix and a number: the clip is
 * `_global.__itjwRefs[number]` (GFx hands the engine the object itself; a Flash player's
 * ExternalInterface only copies).
 */
export const BRIDGE_REFERENCE = '__itjwRef:';
/** The clips passed so far, by number. */
export const BRIDGE_REFERENCES = '_global.__itjwRefs';

const EXTERNAL_INTERFACE = 'flash.external.ExternalInterface';
/** Where the bridge keeps the player's own ExternalInterface.call. */
const ORIGINAL_CALL = '__itjwOriginalCall';
/** A clip's number among the references (set on the clip). */
const REFERENCE_ID = '__itjwRefId';

/** Stage.visibleRect and Stage.safeRect as the menu starts (src/ui/stage-rects.ts). */
export interface StageRects {
  readonly visible: Rect;
  readonly safe: Rect;
}

/** The bridge's actions for a menu. */
export function bridgeActions(menu: string, stage?: StageRects): Uint8Array {
  const w = new Avm1Writer();
  // Stage.visibleRect and Stage.safeRect: the menus lay themselves out by them in their first
  // frame; the host keeps them up to date as the screen changes.
  if (stage) {
    for (const [name, rect] of [
      ['visibleRect', stage.visible],
      ['safeRect', stage.safe],
    ] as const) {
      w.push('Stage').op(Op.getVariable).push(name);
      w.push('x', rect.x, 'y', rect.y, 'width', rect.width, 'height', rect.height, 4);
      w.op(Op.initObject).op(Op.setMember);
    }
  }
  // _global.gfxExtensions = true
  w.push('_global').op(Op.getVariable).push('gfxExtensions', true).op(Op.setMember);

  // _global.__itjwOriginalCall = ExternalInterface.call (once: a movie loaded into it shares
  // the player's _global).
  w.push('_global').op(Op.getVariable).push(ORIGINAL_CALL).op(Op.getMember).op(Op.not).op(Op.not);
  const keep = new Avm1Writer()
    .push('_global')
    .op(Op.getVariable)
    .push(ORIGINAL_CALL)
    .getPath(EXTERNAL_INTERFACE)
    .push('call')
    .op(Op.getMember)
    .op(Op.setMember)
    .bytes();
  w.jumpIf(keep.length).append(keep);

  // The player's classes guard their members (ReadOnly, DontDelete): ASSetPropFlags(
  // ExternalInterface, "call", 0, 7) clears that, as an AS2 program may.
  w.push(7, 0, 'call').getPath(EXTERNAL_INTERFACE).push(4, 'ASSetPropFlags');
  w.op(Op.callFunction).op(Op.pop);

  // Scaleform's focus model, which CLIK's FocusHandler and the menus rely on: any clip may
  // take focus (Flash: only those with focusEnabled), with no yellow focus rectangle; and its
  // multi-controller extensions, for one controller in focus group 0 (System.capabilities.
  // numControllers, Selection.getControllerFocusGroup, getControllerMaskByFocusGroup, ...).
  w.getPath('MovieClip.prototype').push('focusEnabled', true).op(Op.setMember);
  w.getPath('MovieClip.prototype').push('_focusrect', false).op(Op.setMember);
  w.push('_focusrect', false).op(Op.setVariable);
  w.getPath('System.capabilities').push('numControllers', 1).op(Op.setMember);
  const constant = (object: string, name: string, value: PushValue): void => {
    w.getPath(object).push(name);
    w.function2('', [], 1, Function2Flag.suppressThis | Function2Flag.suppressArguments, (body) =>
      body.push(value).op(Op.return),
    );
    w.op(Op.setMember);
  };
  constant('Selection', 'getControllerFocusGroup', 0);
  constant('Selection', 'setControllerFocusGroup', true);
  constant('Selection', 'getControllerMaskByFocusGroup', 1);
  constant('Selection', 'getModalClip', null);
  constant('Selection', 'setModalClip', null);
  // A key set at run time: ExternalInterface.call(BRIDGE_TRANSLATE, key) (the wrapper below
  // tags it with the menu).
  textFieldExtensions(w, (body) => {
    body.push(BRIDGE_TRANSLATE, 2).getPath(EXTERNAL_INTERFACE).push('call');
  });

  // ExternalInterface.call = function () {
  //   for (var i = 0; i < arguments.length; i++)      // clips go as references
  //     if (typeof arguments[i] == "movieclip") {
  //       if (typeof arguments[i].__itjwRefId != "number") {
  //         arguments[i].__itjwRefId = __itjwRefs.length; __itjwRefs.push(arguments[i]);
  //       }
  //       arguments[i] = BRIDGE_REFERENCE + arguments[i].__itjwRefId;
  //     }
  //   arguments.unshift(BRIDGE_CALL, menu);
  //   return _global.__itjwOriginalCall.apply(ExternalInterface, arguments);
  // }
  w.push('_global').op(Op.getVariable).push('__itjwRefs', 0, 'Array').op(Op.newObject);
  w.op(Op.setMember);
  w.getPath(EXTERNAL_INTERFACE).push('call');
  w.function2('', [], 4, Function2Flag.preloadArguments | Function2Flag.suppressThis, (body) => {
    // arguments are in register 1; the index in 2, the argument in 3.
    body.push(0).storeRegister(2).op(Op.pop);
    body.label('next');
    body.push({ register: 2 }, { register: 1 }, 'length').op(Op.getMember).op(Op.less2);
    body.op(Op.not).ifTo('done');
    body.push({ register: 1 }, { register: 2 }).op(Op.getMember).storeRegister(3).op(Op.pop);
    body.push({ register: 3 }).op(Op.typeOf).push('movieclip').op(Op.equals2).op(Op.not);
    body.ifTo('skip');
    body.push({ register: 3 }, REFERENCE_ID).op(Op.getMember).op(Op.typeOf).push('number');
    body.op(Op.equals2).ifTo('known');
    body.push({ register: 3 }, REFERENCE_ID).getPath(BRIDGE_REFERENCES).push('length');
    body.op(Op.getMember).op(Op.setMember);
    body.push({ register: 3 }, 1).getPath(BRIDGE_REFERENCES).push('push').op(Op.callMethod);
    body.op(Op.pop);
    body.label('known');
    body.push({ register: 1 }, { register: 2 }, BRIDGE_REFERENCE, { register: 3 }, REFERENCE_ID);
    body.op(Op.getMember).op(Op.add2).op(Op.setMember);
    body.label('skip');
    body.push({ register: 2 }).op(Op.increment).storeRegister(2).op(Op.pop).jumpTo('next');
    body.label('done');
    body
      .push(menu, BRIDGE_CALL, 2, { register: 1 }, 'unshift')
      .op(Op.callMethod)
      .op(Op.pop)
      .push({ register: 1 })
      .getPath(EXTERNAL_INTERFACE)
      .push(2)
      .getPath(`_global.${ORIGINAL_CALL}`)
      .push('apply')
      .op(Op.callMethod)
      .op(Op.return);
  });
  w.op(Op.setMember);

  // invoke(objectPath, method, args): var o = eval(objectPath); return o[method].apply(o, args)
  addCallback(w, BRIDGE_INVOKE, ['objectPath', 'method', 'args'], 5, (body) => {
    body
      .push({ register: 1 })
      .op(Op.getVariable)
      .storeRegister(4)
      .op(Op.pop)
      .push({ register: 3 }, { register: 4 }, 2, { register: 4 }, { register: 2 })
      .op(Op.getMember)
      .push('apply')
      .op(Op.callMethod)
      .op(Op.return);
  });
  // setVariable(path, value): set(path, value)
  addCallback(w, BRIDGE_SET, ['path', 'value'], 3, (body) => {
    body.push({ register: 1 }, { register: 2 }).op(Op.setVariable).push(true).op(Op.return);
  });
  // getVariable(path): return eval(path)
  addCallback(w, BRIDGE_GET, ['path'], 2, (body) => {
    body.push({ register: 1 }).op(Op.getVariable).op(Op.return);
  });
  return w.bytes();
}

/** ExternalInterface.addCallback(name, null, function (params) { body }) */
function addCallback(
  w: Avm1Writer,
  name: string,
  params: readonly string[],
  registers: number,
  body: (writer: Avm1Writer) => void,
): void {
  w.function2(
    '',
    params,
    registers,
    Function2Flag.suppressThis | Function2Flag.suppressArguments,
    body,
  );
  w.push(null, name, 3)
    .getPath(EXTERNAL_INTERFACE)
    .push('addCallback')
    .op(Op.callMethod)
    .op(Op.pop);
}

/** Tags that stay before the bridge (the movie's header tags). */
const HEADER_TAGS: ReadonlySet<number> = new Set([
  SwfTagCode.fileAttributes,
  SwfTagCode.metadata,
  SwfTagCode.setBackgroundColor,
  SwfTagCode.scriptLimits,
]);

/**
 * The movie with the bridge first in its first frame (after its header tags), uncompressed.
 */
export function withBridge(movieBytes: Uint8Array, menu: string, stage?: StageRects): Uint8Array {
  const movie = readSwf(movieBytes);
  const bridge = encodeTag(
    SwfTagCode.doAction,
    concatBytes([bridgeActions(menu, stage), Uint8Array.of(0)]),
  );
  const parts: Uint8Array[] = [];
  let inserted = false;
  // Header: signature (uncompressed now), version, length (written below), the stage RECT,
  // frame rate and count.
  const rectBits = 5 + 4 * ((movie.bytes[8] ?? 0) >> 3);
  parts.push(movie.bytes.subarray(0, 8 + Math.ceil(rectBits / 8) + 4));
  for (const tag of movie.tags) {
    if (!inserted && !HEADER_TAGS.has(tag.code)) {
      parts.push(bridge);
      inserted = true;
    }
    parts.push(encodeTag(tag.code, tagBody(movie, tag)));
  }
  if (!inserted) parts.push(bridge);
  const out = concatBytes(parts);
  out.set([0x46, 0x57, 0x53], 0); // FWS (GFX movies' extension tags pass as they are)
  new DataView(out.buffer).setUint32(4, out.length, true);
  return out;
}

/** A movie of only the bridge (tests, and checks of the player without a menu). */
export function bridgeMovie(menu: string): Uint8Array {
  return writeSwf([
    { code: SwfTagCode.doAction, body: concatBytes([bridgeActions(menu), Uint8Array.of(0)]) },
    { code: SwfTagCode.showFrame, body: new Uint8Array(0) },
  ]);
}
