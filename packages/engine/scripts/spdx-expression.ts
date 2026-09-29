// spdx-expression.ts: parses an SPDX license expression (SPDX specification,
// annex D) into its license and exception ids.
//
//   compound := and-expr ( OR and-expr )*
//   and-expr := with-expr ( AND with-expr )*
//   with-expr := simple ( WITH exception-id )?
//   simple   := license-id [ '+' ] | LicenseRef-... | DocumentRef-...:LicenseRef-... | '(' compound ')'
//
// The operators are matched in either all-upper or all-lower case, as the
// specification allows. A malformed expression is an error: a policy cannot
// check the ids of an expression it cannot read.

/** A parsed expression: every license id it names, and every exception id after a WITH, in order. */
export interface SpdxIds {
  readonly licenses: readonly string[];
  readonly exceptions: readonly string[];
}

const OPERATORS = new Set(['AND', 'OR', 'WITH', 'and', 'or', 'with']);
const IDENTIFIER = /^(?:DocumentRef-[A-Za-z0-9.-]+:)?[A-Za-z0-9.-]+\+?$/;

function tokenize(expression: string): string[] {
  return expression.replace(/([()])/g, ' $1 ').trim().split(/\s+/).filter((token) => token.length > 0);
}

/**
 * The ids matching `isBlocked` that every way of satisfying `expression`
 * uses, by the expression's own grammar: AND needs both sides, so it carries
 * both sides' ids; OR lets the licensee take either side, so it carries the
 * side with fewer (none, when one side has none). `MIT AND GPL-3.0-only`
 * gives ["GPL-3.0-only"]; `MIT OR GPL-3.0-or-later` gives [], since MIT alone
 * satisfies it. Throws like parseSpdxExpression on a malformed expression.
 */
export function unavoidableIds(expression: string, isBlocked: (id: string) => boolean): string[] {
  parseSpdxExpression(expression);
  const tokens = tokenize(expression);
  let index = 0;
  const peek = (name: string): boolean => tokens[index]?.toUpperCase() === name && OPERATORS.has(tokens[index]!);
  const simple = (): string[] => {
    if (tokens[index] === '(') {
      index += 1;
      const inner = compound();
      index += 1;
      return inner;
    }
    const id = tokens[index]!.replace(/\+$/, '');
    index += 1;
    return isBlocked(id) ? [id] : [];
  };
  const withExpression = (): string[] => {
    const ids = simple();
    if (peek('WITH')) index += 2;
    return ids;
  };
  const andExpression = (): string[] => {
    const ids = [...withExpression()];
    while (peek('AND')) {
      index += 1;
      ids.push(...withExpression());
    }
    return ids;
  };
  const compound = (): string[] => {
    let cleanest = andExpression();
    while (peek('OR')) {
      index += 1;
      const option = andExpression();
      if (option.length < cleanest.length) cleanest = option;
    }
    return cleanest;
  };
  return [...new Set(compound())];
}

/** Parses `expression`; throws a SyntaxError naming the problem when it is not a well-formed SPDX expression. */
export function parseSpdxExpression(expression: string): SpdxIds {
  const tokens = tokenize(expression);
  const licenses: string[] = [];
  const exceptions: string[] = [];
  let index = 0;

  const fail = (problem: string): never => {
    throw new SyntaxError(`SPDX expression "${expression}": ${problem}`);
  };
  const peekOperator = (name: string): boolean => tokens[index]?.toUpperCase() === name && OPERATORS.has(tokens[index]!);
  const identifier = (role: string): string => {
    const token = tokens[index];
    if (token === undefined) return fail(`expected a ${role} id at the end`);
    if (token === '(' || token === ')' || OPERATORS.has(token) || !IDENTIFIER.test(token)) return fail(`expected a ${role} id, found "${token}"`);
    index += 1;
    return token;
  };

  const simple = (): void => {
    if (tokens[index] === '(') {
      index += 1;
      compound();
      if (tokens[index] !== ')') fail('an opening parenthesis is not closed');
      index += 1;
      return;
    }
    licenses.push(identifier('license').replace(/\+$/, ''));
  };
  const withExpression = (): void => {
    simple();
    if (peekOperator('WITH')) {
      index += 1;
      exceptions.push(identifier('exception'));
    }
  };
  const andExpression = (): void => {
    withExpression();
    while (peekOperator('AND')) {
      index += 1;
      withExpression();
    }
  };
  const compound = (): void => {
    andExpression();
    while (peekOperator('OR')) {
      index += 1;
      andExpression();
    }
  };

  if (tokens.length === 0) fail('it is empty');
  compound();
  if (index < tokens.length) fail(`unexpected "${tokens[index]}"`);
  return { licenses, exceptions };
}
