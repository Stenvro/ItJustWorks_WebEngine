// Scaleform's Mouse.getTopMostEntity, which a Flash player's AS2 lacks, as AVM1 code the bridge
// puts first into every menu (src/ui/menu-bridge.ts). Under GFx it gives the topmost object under
// the mouse: the clip whose own shapes are hit, or a text field, the deepest one at the highest
// depth. The menus' lists and panels take a click on themselves (a clip with mouse handlers gets
// its children's clicks, as in Flash) and ask it which of their entries is under the mouse: the
// race menu's list compares it and its parents with the selected entry, its panels call
// onPress of its parent, the narrow panel compares it with its arrows (TopHalf, BottomHalf);
// CLIK's components test it as the mouse wheel turns. Without it nothing under them takes a
// click.
//
// getTopMostEntity([testAll[, mouseIndex]]) or getTopMostEntity(x, y[, testAll]) (x, y in the
// movie's root coordinates): testAll false gives only a clip with mouse handlers (onPress, ...),
// the outermost one, as the mouse's events go. Clips that are not visible are passed over, a
// text field is hit within its box. The search walks the display list from _level0 through
// for..in (Ruffle lists a clip's children in it), only into clips hitTest finds the point in.
// Platform-independent. Notes: docs/ui.md ("The mouse").

import { Avm1Writer, Function2Flag, Op, type PushValue } from '../formats/swf/avm1-writer.ts';

/** _global's search: the entity of a clip at a point in global coordinates (or null). */
const ENTITY_AT = '__itjwEntityAt';
/** What a clip with mouse handlers has (AS2's button events). */
const MOUSE_HANDLERS = [
  'onPress',
  'onRelease',
  'onReleaseOutside',
  'onRollOver',
  'onRollOut',
  'onDragOver',
  'onDragOut',
] as const;

const reg = (register: number): PushValue => ({ register });
const FLAGS = Function2Flag.suppressThis | Function2Flag.suppressArguments;

/** `object.member` of a register onto the stack. */
function member(body: Avm1Writer, register: number, name: string): Avm1Writer {
  return body.push(reg(register), name).op(Op.getMember);
}

/** Adds Mouse.getTopMostEntity in a menu's first frame. */
export function mouseExtensions(w: Avm1Writer): void {
  defineEntityAt(w);
  defineTopMostEntity(w);
}

/**
 * _global.__itjwEntityAt(clip, x, y): null if the clip is not visible or not at the point; else
 * the entity of its children at the highest depth that has one, else the clip itself.
 * Registers: 1 clip, 2 x, 3 y, 4 best, 5 its depth, 6 name, 7 child, 8 its entity, 9 the point
 * in the clip's coordinates, 10 the child's depth.
 */
function defineEntityAt(w: Avm1Writer): void {
  w.push('_global').op(Op.getVariable).push(ENTITY_AT);
  w.function2('', ['clip', 'x', 'y'], 11, FLAGS, (body) => {
    member(body, 1, '_visible').op(Op.not).ifTo('none');
    body.push(true, reg(3), reg(2), 3, reg(1), 'hitTest').op(Op.callMethod);
    body.op(Op.not).ifTo('none');
    body.push('x', reg(2), 'y', reg(3), 2).op(Op.initObject).storeRegister(9).op(Op.pop);
    body.push(reg(9), 1, reg(1), 'globalToLocal').op(Op.callMethod).op(Op.pop);
    body.push(null).storeRegister(4).op(Op.pop);
    // for (name in clip): its members and its children (a child's name names it).
    body.push(reg(1)).op(Op.enumerate2);
    body.label('next');
    body.storeRegister(6).push(null).op(Op.equals2).ifTo('listed');
    body.push(reg(1), reg(6)).op(Op.getMember).storeRegister(7).op(Op.pop);
    // A child of this clip (not a member that refers to another object).
    member(body, 7, '_parent').push(reg(1)).op(Op.equals2).op(Op.not).ifTo('next');
    body.push(reg(7)).op(Op.typeOf).push('movieclip').op(Op.equals2).ifTo('clip');
    body.push(reg(7)).getPath('TextField').op(Op.instanceOf).op(Op.not).ifTo('next');
    // A text field: visible, its box holding the point.
    member(body, 7, '_visible').op(Op.not).ifTo('next');
    member(body, 9, 'x');
    member(body, 7, '_x').op(Op.less2).ifTo('next');
    member(body, 7, '_x');
    member(body, 7, '_width').op(Op.add2);
    member(body, 9, 'x').op(Op.less2).ifTo('next');
    member(body, 9, 'y');
    member(body, 7, '_y').op(Op.less2).ifTo('next');
    member(body, 7, '_y');
    member(body, 7, '_height').op(Op.add2);
    member(body, 9, 'y').op(Op.less2).ifTo('next');
    body.push(reg(7)).storeRegister(8).op(Op.pop).jumpTo('candidate');
    body.label('clip');
    body.push(reg(3), reg(2), reg(7), 3, '_global').op(Op.getVariable).push(ENTITY_AT);
    body.op(Op.callMethod).storeRegister(8).push(null).op(Op.equals2).ifTo('next');
    // The child at the highest depth wins.
    body.label('candidate');
    body.push(0, reg(7), 'getDepth').op(Op.callMethod).storeRegister(10).op(Op.pop);
    body.push(reg(4), null).op(Op.equals2).ifTo('take');
    body.push(reg(10), reg(5)).op(Op.greater).op(Op.not).ifTo('next');
    body.label('take');
    body.push(reg(8)).storeRegister(4).op(Op.pop);
    body.push(reg(10)).storeRegister(5).op(Op.pop);
    body.jumpTo('next');
    body.label('listed');
    body.push(reg(4), null).op(Op.equals2).ifTo('self');
    body.push(reg(4)).op(Op.return);
    body.label('self');
    body.push(reg(1)).op(Op.return);
    body.label('none');
    body.push(null).op(Op.return);
  });
  w.op(Op.setMember);
}

/**
 * Mouse.getTopMostEntity(a, b, c) (see above). Registers: 1-3 the arguments, 4 the point,
 * 5 testAll, 6 the entity (then its parents), 7 the outermost clip with mouse handlers.
 */
function defineTopMostEntity(w: Avm1Writer): void {
  w.getPath('Mouse').push('getTopMostEntity');
  w.function2('', ['a', 'b', 'c'], 8, FLAGS, (body) => {
    // testAll: a (getTopMostEntity(testAll)), else c (getTopMostEntity(x, y, testAll)), else true.
    body.push(true).storeRegister(5).op(Op.pop);
    body.push(reg(1)).op(Op.typeOf).push('boolean').op(Op.equals2).op(Op.not).ifTo('noA');
    body.push(reg(1)).storeRegister(5).op(Op.pop);
    body.label('noA');
    body.push(reg(3)).op(Op.typeOf).push('boolean').op(Op.equals2).op(Op.not).ifTo('noC');
    body.push(reg(3)).storeRegister(5).op(Op.pop);
    body.label('noC');
    // The point: x, y as given, else the mouse's; in global coordinates.
    body.push(reg(1)).op(Op.typeOf).push('number').op(Op.equals2).op(Op.not).ifTo('mouse');
    body.push('x', reg(1), 'y', reg(2), 2).op(Op.initObject).storeRegister(4).op(Op.pop);
    body.jumpTo('global');
    body.label('mouse');
    body.push('x').getPath('_level0._xmouse').push('y').getPath('_level0._ymouse');
    body.push(2).op(Op.initObject).storeRegister(4).op(Op.pop);
    body.label('global');
    body.push(reg(4), 1).getPath('_level0').push('localToGlobal').op(Op.callMethod).op(Op.pop);
    member(body, 4, 'y');
    member(body, 4, 'x');
    body.getPath('_level0').push(3, '_global').op(Op.getVariable).push(ENTITY_AT);
    body.op(Op.callMethod).storeRegister(6).op(Op.pop);
    body.push(reg(5)).ifTo('entity');
    // Only clips with mouse handlers: the outermost one the entity is in.
    body.push(null).storeRegister(7).op(Op.pop);
    body.label('up');
    body.push(reg(6), null).op(Op.equals2).ifTo('handled');
    for (const handler of MOUSE_HANDLERS) member(body, 6, handler).ifTo('handles');
    body.jumpTo('parent');
    body.label('handles');
    body.push(reg(6)).storeRegister(7).op(Op.pop);
    body.label('parent');
    member(body, 6, '_parent').storeRegister(6).op(Op.pop).jumpTo('up');
    body.label('handled');
    body.push(reg(7)).op(Op.return);
    body.label('entity');
    body.push(reg(6)).op(Op.return);
  });
  w.op(Op.setMember);
}
