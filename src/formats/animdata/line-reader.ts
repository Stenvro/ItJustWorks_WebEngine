// Line-by-line reading of the behavior projects' text data (CRLF or LF), with numbers checked
// strictly so that a misplaced block fails where it starts instead of reading garbage.

import { FormatError } from '../binary-reader.ts';

const INTEGER = /^[+-]?\d+$/;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

export interface LinePosition {
  readonly offset: number;
  readonly line: number;
}

export class LineReader {
  readonly #text: string;
  readonly #name: string;
  #offset = 0;
  #line = 0;

  /** `name` labels errors. */
  constructor(text: string, name: string) {
    this.#text = text;
    this.#name = name;
  }

  /** Number of lines read so far. */
  get lineNumber(): number {
    return this.#line;
  }

  atEnd(): boolean {
    return this.#offset >= this.#text.length;
  }

  /** Where the reader is, to come back to with `seek`. */
  get position(): LinePosition {
    return { offset: this.#offset, line: this.#line };
  }

  seek(position: LinePosition): void {
    this.#offset = position.offset;
    this.#line = position.line;
  }

  /** Skips `count` lines (fewer at the end of the text). */
  skip(count: number): void {
    for (let i = 0; i < count && !this.atEnd(); i++) this.next();
  }

  /** The next line without its line break; throws at the end of the text. */
  next(what = 'a line'): string {
    if (this.atEnd()) throw this.error(`expected ${what}, found the end`);
    const end = this.#text.indexOf('\n', this.#offset);
    const stop = end < 0 ? this.#text.length : end;
    const cut = stop > this.#offset && this.#text[stop - 1] === '\r' ? stop - 1 : stop;
    const line = this.#text.slice(this.#offset, cut);
    this.#offset = stop + 1;
    this.#line++;
    return line;
  }

  /** A non-negative integer line (a count or an id). */
  count(what: string): number {
    const line = this.next(what).trim();
    const value = Number(line);
    if (!INTEGER.test(line) || value < 0) throw this.error(`expected ${what}, found "${line}"`);
    return value;
  }

  /** A decimal number line. */
  number(what: string): number {
    const line = this.next(what).trim();
    if (!NUMBER.test(line)) throw this.error(`expected ${what}, found "${line}"`);
    return Number(line);
  }

  /** A line of `count` numbers separated by spaces. */
  numbers(what: string, count: number): number[] {
    const line = this.next(what).trim();
    const parts = line.split(/\s+/);
    if (parts.length !== count || !parts.every((part) => NUMBER.test(part))) {
      throw this.error(`expected ${what} (${String(count)} numbers), found "${line}"`);
    }
    return parts.map(Number);
  }

  /** An empty line (block separator). */
  blank(what: string): void {
    const line = this.next(what);
    if (line.trim() !== '') throw this.error(`expected ${what}, found "${line}"`);
  }

  error(message: string): FormatError {
    return new FormatError(`${this.#name} line ${String(this.#line)}: ${message}`, this.#offset);
  }
}
