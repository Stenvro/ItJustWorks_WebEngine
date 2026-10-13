// Havok Behavior expressions (hkbExpressionCondition, hkbEvaluateExpressionModifier): a
// condition ("(staggerDirection > .25) && (staggerDirection < .75)"), an assignment to a
// variable ("iMovementSpeed = cond((Speed < 100), 0, 1)") or an event raised while something
// holds ("weaponDraw if (iCombatStance == 1)"). Names are graph variables; numbers, the
// arithmetic, comparison and logic operators of C, and the functions the vanilla behaviors
// use: cond, fabs, clamp, min, max, sin / cos / tan (radians), sind / cosd (degrees), sqrt,
// floor, ceil. Booleans are 1 and 0. Platform-independent.

/** A parsed expression, evaluated against the graph's variables. */
export type Expression =
  | { readonly kind: 'condition'; readonly value: ExpressionNode }
  | { readonly kind: 'assign'; readonly variable: string; readonly value: ExpressionNode }
  | { readonly kind: 'event'; readonly event: string; readonly value: ExpressionNode };

export type ExpressionNode =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'name'; readonly name: string }
  | { readonly kind: 'unary'; readonly op: string; readonly operand: ExpressionNode }
  | {
      readonly kind: 'binary';
      readonly op: string;
      readonly left: ExpressionNode;
      readonly right: ExpressionNode;
    }
  | { readonly kind: 'call'; readonly name: string; readonly args: readonly ExpressionNode[] };

type Token =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'op'; readonly value: string };

const OPERATORS = [
  '&&',
  '||',
  '==',
  '!=',
  '<=',
  '>=',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '!',
  '(',
  ')',
  ',',
  '=',
];

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const char = text[at] ?? '';
    if (/\s/.test(char)) {
      at++;
      continue;
    }
    // A name may start with a digit ("1stPRot") and hold dots ("SoundPlay.WPNBowZoomIn").
    const word = /^[A-Za-z0-9_.]+/.exec(text.slice(at))?.[0];
    if (word) {
      if (/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(word)) {
        tokens.push({ kind: 'number', value: Number(word) });
      } else {
        tokens.push({ kind: 'name', value: word });
      }
      at += word.length;
      continue;
    }
    const op = OPERATORS.find((candidate) => text.startsWith(candidate, at));
    if (!op) throw new Error(`Unexpected "${char}" in behavior expression "${text}"`);
    tokens.push({ kind: 'op', value: op });
    at += op.length;
  }
  return tokens;
}

/** Binary operators by precedence, loosest first. */
const LEVELS: readonly (readonly string[])[] = [
  ['||'],
  ['&&'],
  ['==', '!='],
  ['<', '<=', '>', '>='],
  ['+', '-'],
  ['*', '/', '%'],
];

export function parseExpression(text: string): Expression {
  const tokens = tokenize(text);
  let at = 0;
  const peek = (): Token | undefined => tokens[at];
  const isOp = (value: string): boolean => {
    const token = peek();
    return token?.kind === 'op' && token.value === value;
  };
  const expect = (value: string): void => {
    if (!isOp(value)) throw new Error(`Expected "${value}" in behavior expression "${text}"`);
    at++;
  };
  const primary = (): ExpressionNode => {
    const token = peek();
    if (!token) throw new Error(`Behavior expression "${text}" ends early`);
    at++;
    if (token.kind === 'number') return { kind: 'number', value: token.value };
    if (token.kind === 'name') {
      if (isOp('(')) {
        at++;
        const args: ExpressionNode[] = [];
        if (!isOp(')')) {
          args.push(level(0));
          while (isOp(',')) {
            at++;
            args.push(level(0));
          }
        }
        expect(')');
        return { kind: 'call', name: token.value.toLowerCase(), args };
      }
      return { kind: 'name', name: token.value };
    }
    if (token.value === '(') {
      const inner = level(0);
      expect(')');
      return inner;
    }
    if (token.value === '!' || token.value === '-' || token.value === '+') {
      return { kind: 'unary', op: token.value, operand: primary() };
    }
    throw new Error(`Unexpected "${token.value}" in behavior expression "${text}"`);
  };
  const level = (depth: number): ExpressionNode => {
    const ops = LEVELS[depth];
    if (!ops) return primary();
    let left = level(depth + 1);
    for (;;) {
      const token = peek();
      if (token?.kind !== 'op' || !ops.includes(token.value)) return left;
      at++;
      left = { kind: 'binary', op: token.value, left, right: level(depth + 1) };
    }
  };

  // "name = value" assigns; "event if (value)" raises; anything else is a condition.
  const first = tokens[0];
  const second = tokens[1];
  let result: Expression;
  if (first?.kind === 'name' && second?.kind === 'op' && second.value === '=') {
    at = 2;
    result = { kind: 'assign', variable: first.value, value: level(0) };
  } else if (
    first?.kind === 'name' &&
    second?.kind === 'name' &&
    second.value.toLowerCase() === 'if'
  ) {
    at = 2;
    result = { kind: 'event', event: first.value, value: level(0) };
  } else {
    result = { kind: 'condition', value: level(0) };
  }
  if (at < tokens.length) throw new Error(`Unexpected end of behavior expression "${text}"`);
  return result;
}

const DEGREES = Math.PI / 180;
const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  cond: (test = 0, a = 0, b = 0) => (test !== 0 ? a : b),
  fabs: (x = 0) => Math.abs(x),
  abs: (x = 0) => Math.abs(x),
  clamp: (x = 0, low = 0, high = 0) => Math.min(Math.max(x, low), high),
  min: (a = 0, b = 0) => Math.min(a, b),
  max: (a = 0, b = 0) => Math.max(a, b),
  sin: (x = 0) => Math.sin(x),
  cos: (x = 0) => Math.cos(x),
  tan: (x = 0) => Math.tan(x),
  sind: (x = 0) => Math.sin(x * DEGREES),
  cosd: (x = 0) => Math.cos(x * DEGREES),
  sqrt: (x = 0) => Math.sqrt(Math.max(0, x)),
  floor: (x = 0) => Math.floor(x),
  ceil: (x = 0) => Math.ceil(x),
};

const truth = (value: boolean): number => (value ? 1 : 0);

/** Evaluates an expression node; unknown names read 0. */
export function evaluateNode(
  node: ExpressionNode,
  variable: (name: string) => number | undefined,
): number {
  switch (node.kind) {
    case 'number':
      return node.value;
    case 'name':
      return variable(node.name) ?? 0;
    case 'unary': {
      const value = evaluateNode(node.operand, variable);
      return node.op === '!' ? truth(value === 0) : node.op === '-' ? -value : value;
    }
    case 'call': {
      const fn = FUNCTIONS[node.name];
      const args = node.args.map((arg) => evaluateNode(arg, variable));
      return fn ? fn(...args) : 0;
    }
    case 'binary': {
      const a = evaluateNode(node.left, variable);
      // Logic short-circuits, as in C.
      if (node.op === '&&') return truth(a !== 0 && evaluateNode(node.right, variable) !== 0);
      if (node.op === '||') return truth(a !== 0 || evaluateNode(node.right, variable) !== 0);
      const b = evaluateNode(node.right, variable);
      switch (node.op) {
        case '==':
          return truth(a === b);
        case '!=':
          return truth(a !== b);
        case '<':
          return truth(a < b);
        case '<=':
          return truth(a <= b);
        case '>':
          return truth(a > b);
        case '>=':
          return truth(a >= b);
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return b === 0 ? 0 : a / b;
        case '%':
          return b === 0 ? 0 : a % b;
        default:
          return 0;
      }
    }
  }
}
