const allowedFunctions = [
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'sinh',
  'cosh',
  'tanh',
  'sqrt',
  'log',
  'abs',
  'exp',
  'ceil',
  'floor',
  'round',
  'min',
  'max'
] as const;

const fnMap: Record<string, string> = Object.fromEntries(
  allowedFunctions.map((name) => [name, `Math.${name}`])
);

const sanitizationRegex = /^[0-9xX+\-*/^().,\s_a-zA-Z]+$/;

function normalizeExpression(expression: string): string {
  if (!expression.trim()) {
    throw new Error('Equation is empty.');
  }

  if (!sanitizationRegex.test(expression)) {
    throw new Error('Equation includes unsupported characters.');
  }

  let normalized = expression
    .replace(/\^/g, '**')
    .replace(/\bpi\b/gi, 'Math.PI')
    .replace(/\be\b/g, 'Math.E')
    .replace(/\bX\b/g, 'x');

  Object.entries(fnMap).forEach(([fn, mapped]) => {
    normalized = normalized.replace(new RegExp(`\\b${fn}\\b`, 'g'), mapped);
  });

  return normalized;
}

export function compileEquation(expression: string): (x: number) => number {
  const normalized = normalizeExpression(expression);

  const evaluator = new Function('x', `return ${normalized};`) as (x: number) => number;

  return (x: number): number => {
    const value = evaluator(x);
    if (!Number.isFinite(value)) {
      return NaN;
    }
    return value;
  };
}
