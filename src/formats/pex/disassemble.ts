// Readable listing of a compiled Papyrus script, for tools and for working out what a
// script does. Not a decompiler: one line per instruction, jump targets as line numbers.

import type { PexFunction, PexScript, PexValue } from './pex.ts';

export function formatValue(value: PexValue): string {
  switch (value.kind) {
    case 'none':
      return 'None';
    case 'identifier':
      return value.name;
    case 'string':
      return JSON.stringify(value.value);
    case 'int':
    case 'float':
      return String(value.value);
    case 'bool':
      return value.value ? 'True' : 'False';
  }
}

const JUMPS = new Set(['jmp', 'jmpt', 'jmpf']);

function functionLines(name: string, fn: PexFunction, indent: string): string[] {
  const params = fn.params.map((p) => `${p.type} ${p.name}`).join(', ');
  const flags = [fn.global ? 'global' : '', fn.native ? 'native' : ''].filter(Boolean).join(' ');
  const lines = [`${indent}${fn.returnType} Function ${name}(${params}) ${flags}`.trimEnd()];
  if (fn.locals.length > 0) {
    lines.push(`${indent}  ; locals: ${fn.locals.map((l) => `${l.type} ${l.name}`).join(', ')}`);
  }
  fn.code.forEach((instruction, index) => {
    const args = instruction.args.map((arg, i) => {
      // The last argument of a jump is a relative offset.
      const isTarget = JUMPS.has(instruction.op) && i === instruction.args.length - 1;
      return isTarget && arg.kind === 'int' ? `@${index + arg.value}` : formatValue(arg);
    });
    lines.push(`${indent}  ${String(index).padStart(4)}  ${instruction.op} ${args.join(' ')}`);
  });
  return lines;
}

export function disassemble(script: PexScript): string {
  const lines = [`; ${script.sourceFile} (PEX ${script.majorVersion}.${script.minorVersion})`];
  for (const object of script.objects) {
    lines.push(`ScriptName ${object.name} extends ${object.parent}`);
    for (const variable of object.variables) {
      lines.push(`  ${variable.type} ${variable.name} = ${formatValue(variable.initial)}`);
    }
    for (const property of object.properties) {
      const backing = property.autoVariable === undefined ? '' : ` auto (${property.autoVariable})`;
      lines.push(`  ${property.type} Property ${property.name}${backing}`);
      if (property.getter) lines.push(...functionLines('Get', property.getter, '    '));
      if (property.setter) lines.push(...functionLines('Set', property.setter, '    '));
    }
    for (const state of object.states) {
      const indent = state.name === '' ? '  ' : '    ';
      if (state.name !== '') lines.push(`  State ${state.name}`);
      for (const fn of state.functions) lines.push(...functionLines(fn.name, fn, indent));
    }
  }
  return lines.join('\n');
}
