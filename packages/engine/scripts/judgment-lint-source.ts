// Static registration checks. Names must be provable, including every call
// to a private decision factory. Unknown names or escaping factories fail
// closed; a function's spelling alone never proves its instances registered.
import ts from 'typescript';
import type { LintFinding } from './judgment-lint-rules.ts';

const DEFINER = /^define[A-Z]\w*$/;

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
    || ts.isParenthesizedExpression(expression) || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)) expression = expression.expression;
  return expression;
}

function insideDefiner(node: ts.Node): boolean {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name !== undefined && DEFINER.test(current.name.text)) return true;
  }
  return false;
}

function named(property: ts.ObjectLiteralElementLike): string | undefined {
  return property.name !== undefined && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    ? property.name.text : undefined;
}

function valueOf(property: ts.ObjectLiteralElementLike): ts.Expression | undefined {
  return ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
}

function constInitializer(declaration: ts.Declaration): ts.Expression | undefined {
  return ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
    && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 ? declaration.initializer : undefined;
}

/** A single-file checker supplies lexical bindings, without imports or disk IO. */
function sourceContext(text: string): { file: ts.SourceFile; checker: ts.TypeChecker } {
  const filename = '/judgment-lint-input.ts';
  const file = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const host: ts.CompilerHost = {
    getSourceFile: (name) => name === filename ? file : undefined,
    getDefaultLibFileName: () => '', writeFile: () => {}, getCurrentDirectory: () => '/',
    getDirectories: () => [], fileExists: (name) => name === filename,
    readFile: (name) => name === filename ? text : undefined,
    getCanonicalFileName: (name) => name, useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  const checker = ts.createProgram([filename], { noLib: true, noResolve: true }, host).getTypeChecker();
  return { file, checker };
}

/** Registered-use findings for one source file. */
export function sourceFindings(path: string, text: string, registered: ReadonlySet<string>): LintFinding[] {
  const { file, checker } = sourceContext(text);
  const findings: LintFinding[] = [];
  const at = (node: ts.Node): string => `${path}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
  const report = (node: ts.Node, message: string): void => { findings.push({ rule: 'registered-use', where: at(node), message }); };
  const symbolOf = (identifier: ts.Identifier): ts.Symbol | undefined =>
    ts.isShorthandPropertyAssignment(identifier.parent)
      ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
      : ts.isExportSpecifier(identifier.parent)
        ? checker.getExportSpecifierLocalTargetSymbol(identifier.parent)
      : checker.getSymbolAtLocation(identifier);
  const references = new Map<ts.Symbol, ts.Identifier[]>();
  const collect = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const symbol = symbolOf(node);
      if (symbol !== undefined) {
        const list = references.get(symbol) ?? [];
        list.push(node);
        references.set(symbol, list);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(file);

  const declarationOf = (identifier: ts.Identifier): ts.Declaration | undefined => {
    const symbol = symbolOf(identifier);
    return symbol?.valueDeclaration;
  };

  // Only private, directly called functions have a closed set of invocations.
  // Exporting, aliasing, passing or returning one makes its parameter unknown.
  function parameterValues(parameter: ts.ParameterDeclaration): ts.Expression[] | undefined {
    const fn = parameter.parent;
    if (!ts.isFunctionDeclaration(fn) || fn.name === undefined || parameter.dotDotDotToken !== undefined
      || fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword)) return undefined;
    const symbol = checker.getSymbolAtLocation(fn.name);
    if (symbol === undefined) return undefined;
    if (!ts.isIdentifier(parameter.name)) return undefined;
    const parameterSymbol = symbolOf(parameter.name);
    for (const reference of parameterSymbol === undefined ? [] : references.get(parameterSymbol) ?? []) {
      for (let current: ts.Node = reference; current.parent !== undefined && current !== fn; current = current.parent) {
        const parent = current.parent;
        if (ts.isBinaryExpression(parent) && parent.left === current
          && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
          && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return undefined;
        if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
          && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) return undefined;
      }
    }
    const values: ts.Expression[] = [];
    const index = fn.parameters.indexOf(parameter);
    for (const reference of references.get(symbol) ?? []) {
      if (reference === fn.name) continue;
      const call = reference.parent;
      if (!ts.isCallExpression(call) || call.expression !== reference || call.arguments.slice(0, index + 1).some(ts.isSpreadElement)) return undefined;
      const argument = call.arguments[index] ?? parameter.initializer;
      if (argument === undefined) return undefined;
      values.push(argument);
    }
    return values.length === 0 ? undefined : values;
  }

  function namesOf(expression: ts.Expression, seen: ReadonlySet<ts.Node> = new Set()): string[] | undefined {
    expression = unwrap(expression);
    if (seen.has(expression)) return undefined;
    const next = new Set(seen).add(expression);
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text];
    if (!ts.isIdentifier(expression)) return undefined;
    const declaration = declarationOf(expression);
    if (declaration === undefined || seen.has(declaration)) return undefined;
    next.add(declaration);
    const initializer = constInitializer(declaration);
    if (initializer !== undefined) return namesOf(initializer, next);
    if (!ts.isParameter(declaration)) return undefined;
    const values = parameterValues(declaration);
    if (values === undefined) return undefined;
    const names: string[] = [];
    for (const value of values) {
      const resolved = namesOf(value, next);
      if (resolved === undefined) return undefined;
      names.push(...resolved);
    }
    return [...new Set(names)];
  }

  // Resolve local const headers and their spreads in object order. An unknown
  // spread is not allowed to hide an overriding name or fixture declaration.
  function propertiesOf(expression: ts.Expression, seen: ReadonlySet<ts.Node> = new Set()): Map<string, ts.ObjectLiteralElementLike> | undefined {
    expression = unwrap(expression);
    if (seen.has(expression)) return undefined;
    const next = new Set(seen).add(expression);
    if (ts.isIdentifier(expression)) {
      const declaration = declarationOf(expression);
      const initializer = declaration === undefined ? undefined : constInitializer(declaration);
      return initializer === undefined ? undefined : propertiesOf(initializer, next);
    }
    if (!ts.isObjectLiteralExpression(expression)) return undefined;
    const properties = new Map<string, ts.ObjectLiteralElementLike>();
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = propertiesOf(property.expression, next);
        if (spread === undefined) return undefined;
        for (const [key, value] of spread) properties.set(key, value);
      } else {
        const name = named(property);
        if (name === undefined) return undefined;
        properties.set(name, property);
      }
    }
    return properties;
  }

  function decisionNames(expression: ts.Expression): string[] | undefined {
    const property = propertiesOf(expression)?.get('name');
    const value = property === undefined ? undefined : valueOf(property);
    return value === undefined ? undefined : namesOf(value);
  }

  // A custom decision must supply fixtures through decisionHeader, implement
  // checkFixtures, and ask using that very header's name expression. Merely
  // knowing a registered name is not an exemption for an unrelated loose call.
  function insideCustomDecision(call: ts.CallExpression): boolean {
    const header = call.arguments[1];
    if (header === undefined) return false;
    const askedProperties = propertiesOf(header);
    const askedName = askedProperties?.get('name');
    if (askedName === undefined) return false;
    for (let parent = call.parent; parent !== undefined; parent = parent.parent) {
      if (!ts.isObjectLiteralExpression(parent)) continue;
      if (!parent.properties.some((property) => named(property) === 'checkFixtures')) return false;
      for (const property of parent.properties) {
        if (!ts.isSpreadAssignment(property)) continue;
        const expression = unwrap(property.expression);
        if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)
          || expression.expression.text !== 'decisionHeader' || expression.arguments[0] === undefined) continue;
        const spec = propertiesOf(expression.arguments[0]);
        const names = decisionNames(expression.arguments[0]);
        if (spec?.has('fixtures') && spec.get('name') === askedName && names !== undefined
          && names.every((name) => registered.has(name))) return true;
      }
      return false;
    }
    return false;
  }

  function checkDecision(call: ts.CallExpression, expression: ts.Expression, callee: string): void {
    const properties = propertiesOf(expression);
    const direct = unwrap(expression);
    if (properties === undefined && ts.isObjectLiteralExpression(direct)
      && direct.properties.some((property) => named(property) === 'name')
      && direct.properties.some((property) => named(property) === 'fixtures')) {
      report(call, `${callee} defines a decision whose name is not a string this lint can read, so its registration cannot be checked`);
      return;
    }
    if (properties?.has('name') !== true || !properties.has('fixtures')) return;
    const names = decisionNames(expression);
    if (names === undefined) {
      report(call, `${callee} defines a decision whose name is not a string this lint can read, so its registration cannot be checked`);
    } else {
      for (const name of names) if (!registered.has(name)) report(call, `${callee} defines "${name}", which no judgment registry registers`);
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const [first] = node.arguments;
      const callee = node.expression;
      if (ts.isIdentifier(callee) && (DEFINER.test(callee.text) || callee.text === 'decisionHeader') && first !== undefined) {
        checkDecision(node, first, callee.text);
      }
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'ask' && first !== undefined
        && ts.isObjectLiteralExpression(first) && first.properties.some((property) => named(property) === 'questions')) {
        report(node, 'asks Jev with a request built inline, outside a registered decision');
      }
      if (ts.isIdentifier(callee) && callee.text === 'askAs' && !insideDefiner(node) && !insideCustomDecision(node)) {
        report(node, 'calls askAs outside a decision definer (a `function define*`), so the call is attributed to no registered decision');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}
