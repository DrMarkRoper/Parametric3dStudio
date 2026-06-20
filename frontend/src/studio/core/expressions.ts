import type { Parameter } from '../types';

export type Params = Record<string, number>;

const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: (d) => Math.sin((d * Math.PI) / 180),
  cos: (d) => Math.cos((d * Math.PI) / 180),
  tan: (d) => Math.tan((d * Math.PI) / 180),
  asin: (v) => (Math.asin(v) * 180) / Math.PI,
  acos: (v) => (Math.acos(v) * 180) / Math.PI,
  atan: (v) => (Math.atan(v) * 180) / Math.PI,
  sqrt: Math.sqrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  min: Math.min,
  max: Math.max,
};

const CONSTS: Record<string, number> = { pi: Math.PI };

/**
 * Evaluate an arithmetic expression with named parameters.
 * Supports + - * / ^, parentheses, unary minus, functions (trig in degrees), pi.
 * Throws Error with a readable message on failure.
 */
export function evalExpression(expr: string, params: Params): number {
  if (!expr || !expr.trim()) throw new Error('Empty expression');
  const s = expr;
  let i = 0;

  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };

  function parseExpr(): number {
    let v = parseTerm();
    ws();
    while (i < s.length && (s[i] === '+' || s[i] === '-')) {
      const op = s[i++];
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
      ws();
    }
    return v;
  }

  function parseTerm(): number {
    let v = parsePow();
    ws();
    while (i < s.length && (s[i] === '*' || s[i] === '/')) {
      const op = s[i++];
      const r = parsePow();
      v = op === '*' ? v * r : v / r;
      ws();
    }
    return v;
  }

  function parsePow(): number {
    const base = parseUnary();
    ws();
    if (s[i] === '^') {
      i++;
      return Math.pow(base, parsePow());
    }
    return base;
  }

  function parseUnary(): number {
    ws();
    if (s[i] === '-') {
      i++;
      return -parseUnary();
    }
    if (s[i] === '+') {
      i++;
      return parseUnary();
    }
    return parseAtom();
  }

  function parseAtom(): number {
    ws();
    if (s[i] === '(') {
      i++;
      const v = parseExpr();
      ws();
      if (s[i] !== ')') throw new Error('Expected )');
      i++;
      return v;
    }
    if (/[0-9.]/.test(s[i] ?? '')) {
      const m = /^[0-9]*\.?[0-9]+(e[+-]?[0-9]+)?/i.exec(s.slice(i));
      if (!m) throw new Error('Invalid number');
      i += m[0].length;
      return parseFloat(m[0]);
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
    if (m) {
      i += m[0].length;
      const name = m[0];
      ws();
      if (s[i] === '(') {
        i++;
        const args: number[] = [];
        ws();
        if (s[i] !== ')') {
          args.push(parseExpr());
          ws();
          while (s[i] === ',') {
            i++;
            args.push(parseExpr());
            ws();
          }
        }
        if (s[i] !== ')') throw new Error('Expected )');
        i++;
        const f = FUNCS[name.toLowerCase()];
        if (!f) throw new Error(`Unknown function "${name}"`);
        return f(...args);
      }
      if (name in params) return params[name];
      if (name.toLowerCase() in CONSTS) return CONSTS[name.toLowerCase()];
      throw new Error(`Unknown parameter "${name}"`);
    }
    throw new Error(`Unexpected "${s[i] ?? 'end of expression'}"`);
  }

  const v = parseExpr();
  ws();
  if (i < s.length) throw new Error(`Unexpected "${s[i]}"`);
  if (!isFinite(v)) throw new Error('Result is not finite');
  return v;
}

export function tryEval(expr: string, params: Params): number | null {
  try {
    return evalExpression(expr, params);
  } catch {
    return null;
  }
}

/** Resolve the parameter table; parameters may reference earlier (or later) parameters. */
export function resolveParameters(parameters: Parameter[]): {
  values: Params;
  errors: Record<string, string>;
} {
  const values: Params = {};
  const errors: Record<string, string> = {};
  let pending = [...parameters];
  for (let pass = 0; pass <= parameters.length && pending.length; pass++) {
    const next: Parameter[] = [];
    for (const p of pending) {
      try {
        values[p.name] = evalExpression(p.expression, values);
      } catch {
        next.push(p);
      }
    }
    if (next.length === pending.length) {
      for (const p of next) errors[p.name] = 'Unresolved expression (syntax error or circular reference)';
      break;
    }
    pending = next;
  }
  return { values, errors };
}

/** Validate a parameter name. */
export function isValidParamName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !(name.toLowerCase() in FUNCS) && !(name.toLowerCase() in CONSTS);
}
