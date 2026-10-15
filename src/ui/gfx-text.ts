// Scaleform's TextField extensions the menus use that a Flash player's AS2 lacks (GFx gives
// AS2 text fields some of AS3's members), as AVM1 code the bridge puts first into every menu
// (src/ui/menu-bridge.ts): numLines, getLineMetrics, getLineOffset, getCharBoundaries,
// getLineIndexAtPoint, appendText, appendHtml, and `new TextField()`: a text object of its own,
// off the stage (the HUD puts a quest's status before its name through one). And GFx's
// translation of texts set at run time: a text that begins with "$" is a key of the
// interface's translations (the journal's stats are "$" + their name). The menus set their
// texts through Shared.GlobalFunc's SetText, which the bridge wraps as the movie defines it
// (Object.watch): a key goes to the engine (__itjwTranslate) for its text first.
//
// numLines is exact (maxscroll + bottomScroll - scroll: the lines past the first one in view,
// plus those in view). The line layout comes from a hidden measuring field on _root with the
// field's width, wrapping, fonts and format: a line's first character is where a prefix of the
// text first needs that many lines (a binary search), a character's box spans the width of the
// line's text before it. A line's metrics give the field's widest line (textWidth: exact for the
// single-line fields that ask, the HUD's letters, the item cards' names), the lines' average
// height and the format's leading; the vanilla menus read width and leading only. The fields are
// measured as plain text in their first format, from the left (a description, a book's page).
// TODO(M9): textAutoSize and verticalAlign.
// Notes: docs/ui.md ("Scaleform's text fields").

import { Avm1Writer, Function2Flag, Op, type PushValue } from '../formats/swf/avm1-writer.ts';

/** The bridge's globals for `new TextField()`. */
const STANDALONE_TEXT = '__itjwText';
const STANDALONE_VALUE = '__itjwValue';
const TEXT_FIELD_CLASS = '__itjwTextField';
/** The measuring field (on _root) and the functions that use it. */
const MEASURE_FIELD = '__itjwMeasure';
const MEASURE = '__itjwMeasureLike';
const LINES = '__itjwLinesOf';
/** The measuring field's depth: the deepest a movie may use. */
const MEASURE_DEPTH = 1048000;
/** Where a wrapped SetText keeps the movie's own. */
const ORIGINAL_SET_TEXT = '__itjwOriginal';
/** A text field's gutter: its text starts 2 pixels in. */
const GUTTER = 2;
/** getLineIndexAtPoint's allowance for rounding (of a line): a line's own top is in it. */
const LINE_EPSILON = 0.001;

const reg = (register: number): PushValue => ({ register });
const FLAGS = Function2Flag.suppressArguments;

/** `object.member` of a register onto the stack. */
function member(body: Avm1Writer, register: number, name: string): Avm1Writer {
  return body.push(reg(register), name).op(Op.getMember);
}

/** `this.member` onto the stack. */
function own(body: Avm1Writer, name: string): Avm1Writer {
  return body.push('this').op(Op.getVariable).push(name).op(Op.getMember);
}

/**
 * Readies `_global.<name>(...args)` for CallMethod (`args` pushes them last first, `count`
 * of them).
 */
function callGlobal(body: Avm1Writer, name: string, count: number, args: () => void): Avm1Writer {
  args();
  return body.push(count, '_global').op(Op.getVariable).push(name);
}

/** Math.floor of the value on the stack. */
function floor(body: Avm1Writer): Avm1Writer {
  return body.push(1).getPath('Math').push('floor').op(Op.callMethod);
}

/**
 * Adds the extensions to TextField (and the class's constructor) in a menu's first frame;
 * `translate(body)` emits a call of the engine's translation with the key on the stack (one
 * argument pushed, the call readied for CallMethod).
 */
export function textFieldExtensions(w: Avm1Writer, translate: (body: Avm1Writer) => void): void {
  defineTranslatedSetText(w, translate);
  defineNumLines(w);
  defineMeasuring(w);
  defineLineMetrics(w);
  defineLineOffset(w);
  defineCharBoundaries(w);
  defineLineIndexAtPoint(w);
  defineStandalone(w);
  defineAppend(w);
}

/** TextField.prototype.addProperty("numLines", function () {...}, null) */
function defineNumLines(w: Avm1Writer): void {
  w.push(null);
  w.function2('', [], 1, FLAGS, (body) => {
    own(own(body, 'maxscroll'), 'bottomScroll').op(Op.add2);
    own(body, 'scroll').op(Op.subtract).op(Op.return);
  });
  w.push('numLines', 3).getPath('TextField.prototype').push('addProperty');
  w.op(Op.callMethod).op(Op.pop);
}

/**
 * _global.__itjwMeasureLike(field, singleLine): the hidden measuring field set up like `field`
 * (its width, wrapping unless single-line, fonts, first format);
 * _global.__itjwLinesOf(measure, text): the lines `text` takes in it.
 */
function defineMeasuring(w: Avm1Writer): void {
  w.push('_global').op(Op.getVariable).push(MEASURE);
  w.function2('', ['field', 'single'], 4, FLAGS, (body) => {
    body.push('_root').op(Op.getVariable).push(MEASURE_FIELD).op(Op.getMember);
    body.storeRegister(3).op(Op.pop);
    body.push(reg(3)).op(Op.typeOf).push('object').op(Op.equals2).ifTo('ready');
    body.push(100, 100, 0, 0, MEASURE_DEPTH, MEASURE_FIELD, 6, '_root').op(Op.getVariable);
    body.push('createTextField').op(Op.callMethod).op(Op.pop);
    body.push('_root').op(Op.getVariable).push(MEASURE_FIELD).op(Op.getMember);
    body.storeRegister(3).op(Op.pop);
    body.push(reg(3), '_visible', false).op(Op.setMember);
    body.label('ready');
    body.push(reg(3), 'multiline');
    member(body, 1, 'multiline').op(Op.setMember);
    // wordWrap = !single && field.wordWrap
    body.push(reg(3), 'wordWrap', reg(2)).op(Op.not);
    member(body, 1, 'wordWrap').op(Op.and).op(Op.setMember);
    body.push(reg(3), 'embedFonts');
    member(body, 1, 'embedFonts').op(Op.setMember);
    body.push(reg(3), '_width');
    member(body, 1, '_width').op(Op.setMember);
    body.push(reg(3), 'html', false).op(Op.setMember);
    body.push(0, reg(1), 'getTextFormat').op(Op.callMethod);
    body.push(1, reg(3), 'setNewTextFormat').op(Op.callMethod).op(Op.pop);
    body.push(reg(3)).op(Op.return);
  });
  w.op(Op.setMember);
  w.push('_global').op(Op.getVariable).push(LINES);
  w.function2('', ['measure', 'text'], 3, FLAGS, (body) => {
    body.push(reg(1), 'text', reg(2)).op(Op.setMember);
    member(member(body, 1, 'maxscroll'), 1, 'bottomScroll').op(Op.add2);
    member(body, 1, 'scroll').op(Op.subtract).op(Op.return);
  });
  w.op(Op.setMember);
}

/** getLineMetrics(lineIndex): { x, width, height, leading } */
function defineLineMetrics(w: Avm1Writer): void {
  w.getPath('TextField.prototype').push('getLineMetrics');
  w.function2('', ['lineIndex'], 2, FLAGS, (body) => {
    body.push('x', 0, 'width');
    own(body, 'textWidth').push('height');
    own(body, 'textHeight');
    own(body, 'numLines').op(Op.divide).push('leading');
    body.push(0).push('this').op(Op.getVariable).push('getTextFormat').op(Op.callMethod);
    body.push('leading').op(Op.getMember);
    body.push(4).op(Op.initObject).op(Op.return);
  });
  w.op(Op.setMember);
}

/**
 * getLineOffset(lineIndex): the index of the line's first character (-1 past the last line):
 * the shortest prefix of the text that takes lineIndex + 1 lines ends with it.
 * Registers: 1 line, 2 measure, 3 low, 4 high, 5 middle, 6 text, 7 found.
 */
function defineLineOffset(w: Avm1Writer): void {
  w.getPath('TextField.prototype').push('getLineOffset');
  w.function2('', ['lineIndex'], 8, FLAGS, (body) => {
    body.push(reg(1), 1).op(Op.less2).ifTo('first');
    own(body, 'text').storeRegister(6).op(Op.pop);
    callGlobal(body, MEASURE, 2, () => body.push(false).push('this').op(Op.getVariable));
    body.op(Op.callMethod).storeRegister(2).op(Op.pop);
    body.push(1).storeRegister(3).op(Op.pop);
    member(body, 6, 'length').storeRegister(4).op(Op.pop);
    body.push(-1).storeRegister(7).op(Op.pop);
    body.label('search');
    // while (low <= high)
    body.push(reg(4), reg(3)).op(Op.less2).ifTo('done');
    body.push(reg(3), reg(4)).op(Op.add2).push(2).op(Op.divide);
    floor(body).storeRegister(5).op(Op.pop);
    // lines(text.substr(0, middle)) > lineIndex ?
    callGlobal(body, LINES, 2, () => {
      body.push(reg(5), 0, 2, reg(6), 'substr').op(Op.callMethod).push(reg(2));
    });
    body.op(Op.callMethod).push(reg(1)).op(Op.greater).ifTo('more');
    body.push(reg(5)).op(Op.increment).storeRegister(3).op(Op.pop).jumpTo('search');
    body.label('more');
    body.push(reg(5)).storeRegister(7).op(Op.pop);
    body.push(reg(5)).op(Op.decrement).storeRegister(4).op(Op.pop).jumpTo('search');
    body.label('done');
    body.push(reg(7), -1).op(Op.equals2).ifTo('none');
    body.push(reg(7)).op(Op.decrement).op(Op.return);
    body.label('none');
    body.push(-1).op(Op.return);
    body.label('first');
    body.push(0).op(Op.return);
  });
  w.op(Op.setMember);
}

/**
 * getCharBoundaries(charIndex): the character's box (flash.geom.Rectangle) in the field: its
 * line's top and height, from the width of the line's text before it. A line's step is its
 * height and the format's leading (which may be negative: the books' font), so the box ends
 * `leading` before the next line's top, as a Flash player's does (a book's next page begins at
 * a box's bottom plus the leading: the next line).
 * Registers: 1 index, 2 measure, 3 line, 4 line start, 5 line height, 6 x, 7 width, 8 text.
 */
function defineCharBoundaries(w: Avm1Writer): void {
  w.getPath('TextField.prototype').push('getCharBoundaries');
  w.function2('', ['charIndex'], 9, FLAGS, (body) => {
    own(body, 'text').storeRegister(8).op(Op.pop);
    callGlobal(body, MEASURE, 2, () => body.push(false).push('this').op(Op.getVariable));
    body.op(Op.callMethod).storeRegister(2).op(Op.pop);
    // line = lines(text.substr(0, index + 1)) - 1
    callGlobal(body, LINES, 2, () => {
      body.push(reg(1)).op(Op.increment).push(0, 2, reg(8), 'substr').op(Op.callMethod);
      body.push(reg(2));
    });
    body.op(Op.callMethod).op(Op.decrement).storeRegister(3).op(Op.pop);
    own(body, 'textHeight');
    own(body, 'numLines').op(Op.divide).storeRegister(5).op(Op.pop);
    body.push(reg(3), 1, 'this').op(Op.getVariable).push('getLineOffset').op(Op.callMethod);
    body.storeRegister(4).op(Op.pop);
    // On one line: x = gutter + width(text.substr(start, index - start)); width = of the char.
    callGlobal(body, MEASURE, 2, () => body.push(true).push('this').op(Op.getVariable));
    body.op(Op.callMethod).storeRegister(2).op(Op.pop);
    body.push(reg(2), 'text', reg(1), reg(4)).op(Op.subtract).push(reg(4), 2, reg(8), 'substr');
    body.op(Op.callMethod).op(Op.setMember);
    member(body, 2, 'textWidth').push(GUTTER).op(Op.add2).storeRegister(6).op(Op.pop);
    body.push(reg(2), 'text', 1, reg(1), 2, reg(8), 'substr').op(Op.callMethod).op(Op.setMember);
    member(body, 2, 'textWidth').storeRegister(7).op(Op.pop);
    // new flash.geom.Rectangle(x, gutter + line * step, width, step - leading)
    body.push(reg(5), 0, 'this').op(Op.getVariable).push('getTextFormat').op(Op.callMethod);
    body.push('leading').op(Op.getMember).op(Op.subtract);
    body.push(reg(7), reg(3), reg(5)).op(Op.multiply).push(GUTTER).op(Op.add2);
    body.push(reg(6), 4).getPath('flash.geom').push('Rectangle').op(Op.newMethod);
    body.op(Op.return);
  });
  w.op(Op.setMember);
}

/** getLineIndexAtPoint(x, y): the line at a height in the field (-1 outside its lines). */
function defineLineIndexAtPoint(w: Avm1Writer): void {
  w.getPath('TextField.prototype').push('getLineIndexAtPoint');
  w.function2('', ['x', 'y'], 4, FLAGS, (body) => {
    // line = floor((y - gutter) / (textHeight / numLines) + a little): a line's top is in it
    body.push(reg(2), GUTTER).op(Op.subtract);
    own(body, 'textHeight');
    own(body, 'numLines').op(Op.divide).op(Op.divide).push(LINE_EPSILON).op(Op.add2);
    floor(body).storeRegister(3).op(Op.pop);
    body.push(reg(3), 0).op(Op.less2).ifTo('outside');
    own(body, 'numLines').push(reg(3)).op(Op.greater).op(Op.not).ifTo('outside');
    body.push(reg(3)).op(Op.return);
    body.label('outside');
    body.push(-1).op(Op.return);
  });
  w.op(Op.setMember);
}

/**
 * `new TextField()`: a text object off the stage whose text and htmlText keep what is set.
 * The player constructs the fields it places with `_global.TextField` too: those (with a
 * _width) go to the original class.
 */
function defineStandalone(w: Avm1Writer): void {
  // var standalone = new Object(); standalone.__proto__ = TextField.prototype;
  // standalone.addProperty("text" | "htmlText", get this.__itjwValue, set this.__itjwValue)
  w.push('_global').op(Op.getVariable).push(STANDALONE_TEXT, 0, 'Object').op(Op.newObject);
  w.op(Op.setMember);
  w.getPath(`_global.${STANDALONE_TEXT}`).push('__proto__').getPath('TextField.prototype');
  w.op(Op.setMember);
  for (const name of ['text', 'htmlText']) {
    w.function2('', ['value'], 2, FLAGS, (body) => {
      body.push('this').op(Op.getVariable).push(STANDALONE_VALUE, reg(1));
      body.op(Op.setMember);
    });
    w.function2('', [], 1, FLAGS, (body) => {
      own(body, STANDALONE_VALUE).op(Op.return);
    });
    w.push(name, 3).getPath(`_global.${STANDALONE_TEXT}`).push('addProperty');
    w.op(Op.callMethod).op(Op.pop);
  }
  // _global.__itjwTextField = TextField; ASSetPropFlags(_global, "TextField", 0, 7);
  w.push('_global').op(Op.getVariable).push(TEXT_FIELD_CLASS).getPath('TextField');
  w.op(Op.setMember);
  w.push(7, 0, 'TextField', '_global').op(Op.getVariable).push(4, 'ASSetPropFlags');
  w.op(Op.callFunction).op(Op.pop);
  // _global.TextField = function () {
  //   if (typeof this._width == "number") __itjwTextField.call(this); // a field on the stage
  //   else { this.__proto__ = standalone; this.__itjwValue = ""; }    // new TextField()
  // };
  w.push('_global').op(Op.getVariable).push('TextField');
  w.function2('', [], 1, FLAGS, (body) => {
    own(body, '_width').op(Op.typeOf).push('number').op(Op.equals2).op(Op.not).ifTo('off');
    body.push('this').op(Op.getVariable).push(1).getPath(`_global.${TEXT_FIELD_CLASS}`);
    body.push('call').op(Op.callMethod).op(Op.pop).jumpTo('end');
    body.label('off');
    body.push('this').op(Op.getVariable).push('__proto__').getPath(`_global.${STANDALONE_TEXT}`);
    body.op(Op.setMember);
    body.push('this').op(Op.getVariable).push(STANDALONE_VALUE, '').op(Op.setMember);
    body.label('end');
  });
  w.op(Op.setMember);
  // TextField.prototype = __itjwTextField.prototype; TextField.StyleSheet, getFontList as well
  for (const name of ['prototype', 'StyleSheet', 'getFontList']) {
    w.getPath('_global.TextField').push(name).getPath(`_global.${TEXT_FIELD_CLASS}.${name}`);
    w.op(Op.setMember);
  }
}

/** appendText(text): this.text += text; appendHtml(html): this.htmlText += html */
function defineAppend(w: Avm1Writer): void {
  for (const [method, name] of [
    ['appendText', 'text'],
    ['appendHtml', 'htmlText'],
  ] as const) {
    w.getPath('TextField.prototype').push(method);
    w.function2('', ['added'], 2, FLAGS, (body) => {
      body.push('this').op(Op.getVariable).push(name);
      own(body, name).push(reg(1)).op(Op.add2).op(Op.setMember);
    });
    w.op(Op.setMember);
  }
}

/**
 * TextField.prototype.watch("SetText", function (name, old, set) {
 *   if (typeof set != "function") return set;
 *   var wrapped = function (aText, abHTML) {
 *     if (typeof aText == "string" && aText.substr(0, 1) == "$") {
 *       var text = <the engine's translation of aText>;
 *       if (typeof text == "string") aText = text;
 *     }
 *     return arguments.callee.__itjwOriginal.call(this, aText, abHTML);
 *   };
 *   wrapped.__itjwOriginal = set;
 *   return wrapped;
 * }); TextField.prototype.SetText = TextField.prototype.SetText;  // one defined already
 */
function defineTranslatedSetText(w: Avm1Writer, translate: (body: Avm1Writer) => void): void {
  w.push(null);
  w.function2('', ['name', 'old', 'set'], 5, Function2Flag.suppressThis, (watcher) => {
    watcher.push(reg(3)).op(Op.typeOf).push('function').op(Op.equals2).ifTo('wrap');
    watcher.push(reg(3)).op(Op.return);
    watcher.label('wrap');
    // arguments in register 1, aText in 2, abHTML in 3
    watcher.function2(
      '',
      ['aText', 'abHTML'],
      4,
      Function2Flag.preloadArguments,
      (body) => {
        body.push(reg(2)).op(Op.typeOf).push('string').op(Op.equals2).op(Op.not).ifTo('call');
        body.push(1, 0, 2, reg(2), 'substr').op(Op.callMethod).push('$').op(Op.equals2);
        body.op(Op.not).ifTo('call');
        body.push(reg(2));
        translate(body);
        body.op(Op.callMethod).op(Op.pushDuplicate).op(Op.typeOf).push('string');
        body.op(Op.equals2).ifTo('translated');
        body.op(Op.pop).jumpTo('call');
        body.label('translated');
        body.storeRegister(2).op(Op.pop);
        body.label('call');
        body.push(reg(3), reg(2), 'this').op(Op.getVariable).push(3);
        body.push(reg(1), 'callee').op(Op.getMember).push(ORIGINAL_SET_TEXT).op(Op.getMember);
        body.push('call').op(Op.callMethod).op(Op.return);
      },
      2,
    );
    watcher.storeRegister(4).op(Op.pop);
    watcher.push(reg(4), ORIGINAL_SET_TEXT, reg(3)).op(Op.setMember);
    watcher.push(reg(4)).op(Op.return);
  });
  w.push('SetText', 2).getPath('TextField.prototype').push('watch').op(Op.callMethod).op(Op.pop);
  w.getPath('TextField.prototype').push('SetText').getPath('TextField.prototype.SetText');
  w.op(Op.setMember);
}
