// A console line as the game's console reads it (src/shell/console-commands.ts runs it): words
// separated by spaces or commas ("player.setav luck, 75"), double quotes keeping spaces and
// commas in one word ("coc "Riverwood""), the first word the command with an optional
// reference before a dot ("player.additem", "0001a694.moveto", "BalgruufRef.disable").
// Numbers are decimal; form ids are hexadecimal with their load order prefix (00012eb7, the
// Dawnguard 0200c0d9, a light plugin's fe00180a; leading zeros may go: "f" is gold).
// Platform-independent.

export interface ConsoleLine {
  /** The reference named before the dot, as typed. */
  readonly reference: string | undefined;
  /** The command, in lower case. */
  readonly command: string;
  /** The command as typed (the game's messages name it so). */
  readonly typed: string;
  readonly args: string[];
  /** A syntax error the game reports instead of running the line. */
  readonly error?: string;
}

/** A console line split into its reference, command and arguments. */
export function parseConsoleLine(line: string): ConsoleLine {
  const words: string[] = [];
  let word = '';
  let quoted = false;
  let started = false;
  for (const char of line.trim()) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && (char === ' ' || char === '\t' || char === ',')) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (started) words.push(word);
  const head = words.shift() ?? '';
  const dot = head.indexOf('.');
  const [reference, typed] =
    dot > 0 && dot < head.length - 1
      ? [head.slice(0, dot), head.slice(dot + 1)]
      : [undefined, head];
  return {
    reference,
    command: typed.toLowerCase(),
    typed,
    args: words,
    ...(quoted && { error: 'Syntax Error.  Mismatched quotes.' }),
  };
}

/** A form id typed in hex (its load order prefix included), or undefined if it is not one. */
export function parseFormId(text: string): number | undefined {
  const digits = text.startsWith('0x') || text.startsWith('0X') ? text.slice(2) : text;
  return /^[0-9a-f]{1,8}$/i.test(digits) ? Number.parseInt(digits, 16) >>> 0 : undefined;
}

/** A number typed (decimal, a sign and a fraction allowed), or undefined. */
export function parseConsoleNumber(text: string | undefined): number | undefined {
  if (text === undefined || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return undefined;
  return Number(text);
}

/** An axis typed (X, Y or Z), as its index. */
export function parseAxis(text: string | undefined): 0 | 1 | 2 | undefined {
  switch (text?.toLowerCase()) {
    case 'x':
      return 0;
    case 'y':
      return 1;
    case 'z':
      return 2;
    default:
      return undefined;
  }
}
