import ts from 'typescript';

export interface SourceMarkerFinding {
  readonly line: number;
  readonly col: number;
  readonly marker: string;
  readonly text: string;
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
    || ts.isParenthesizedExpression(expression) || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)) expression = expression.expression;
  return expression;
}

/** Literal fixture data may deliberately demonstrate unfinished code. */
export function sourceMarkerFindings(path: string, text: string): SourceMarkerFinding[] {
  const matches = [...text.matchAll(/\b(TODO|FIXME|XXX|HACK|STUB)\b/g)];
  if (matches.length === 0) return [];
  const filename = `/marker-input${/\.[cm]?[jt]sx?$/.exec(path)?.[0] ?? '.ts'}`;
  const file = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const host: ts.CompilerHost = {
    getSourceFile: (name) => name === filename ? file : undefined,
    getDefaultLibFileName: () => '', writeFile: () => {}, getCurrentDirectory: () => '/',
    getDirectories: () => [], fileExists: (name) => name === filename,
    readFile: (name) => name === filename ? text : undefined,
    getCanonicalFileName: (name) => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
  };
  const checker = ts.createProgram([filename], { noLib: true, noResolve: true, allowJs: true }, host).getTypeChecker();
  const factories = new Set<ts.Symbol>();
  const namespaces = new Set<ts.Symbol>();
  const factoryName = (name: string): boolean => /^define[A-Z]\w*$/.test(name) || name === 'decisionHeader';
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== '@goodvibes-jev/judgment' || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const specifier of bindings.elements) {
      const symbol = checker.getSymbolAtLocation(specifier.name);
      if (!specifier.isTypeOnly && factoryName((specifier.propertyName ?? specifier.name).text) && symbol) factories.add(symbol);
    }
    if (bindings && ts.isNamespaceImport(bindings)) {
      const symbol = checker.getSymbolAtLocation(bindings.name); if (symbol) namespaces.add(symbol);
    }
  }
  const fixtureArrays = new Set<ts.ArrayLiteralExpression>();
  const findArrays = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const trusted = ts.isIdentifier(callee) ? factories.has(checker.getSymbolAtLocation(callee)!)
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
          && namespaces.has(checker.getSymbolAtLocation(callee.expression)!) && factoryName(callee.name.text);
      const argument = node.arguments[0];
      const spec = argument && unwrap(argument);
      if (trusted && spec && ts.isObjectLiteralExpression(spec)) for (const property of spec.properties) {
        if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
          || property.name.text !== 'fixtures') continue;
        const array = unwrap(property.initializer);
        if (ts.isArrayLiteralExpression(array)) fixtureArrays.add(array);
      }
    }
    ts.forEachChild(node, findArrays);
  };
  findArrays(file);
  const literalRanges: Array<readonly [number, number]> = [];
  const joinedLiteralArray = (node: ts.CallExpression): boolean => {
    const callee = node.expression;
    return ts.isPropertyAccessExpression(callee) && callee.name.text === 'join'
      && ts.isArrayLiteralExpression(callee.expression)
      && callee.expression.elements.every((element) => ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element))
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!);
  };
  const findLiterals = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      for (let child: ts.Node = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
        if (ts.isArrayLiteralExpression(parent) && fixtureArrays.has(parent)) {
          literalRanges.push([node.getStart(file), node.end]); break;
        }
        // Stay within recorded data. Calls, callback bodies and other runtime
        // expressions still represent implementations, even inside fixtures.
        if (ts.isArrayLiteralExpression(parent) || ts.isObjectLiteralExpression(parent)) continue;
        if (ts.isPropertyAssignment(parent) && parent.initializer === child) continue;
        if ((ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)
          || ts.isParenthesizedExpression(parent) || ts.isSatisfiesExpression(parent)
          || ts.isNonNullExpression(parent)) && parent.expression === child) continue;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === child
          && ts.isCallExpression(parent.parent) && joinedLiteralArray(parent.parent)) continue;
        if (ts.isCallExpression(parent) && joinedLiteralArray(parent)) continue;
        break;
      }
    }
    ts.forEachChild(node, findLiterals);
  };
  findLiterals(file);
  const lines = text.split('\n');
  return matches.flatMap((match) => {
    const offset = match.index!;
    if (literalRanges.some(([start, end]) => offset >= start && offset + match[0].length <= end)) return [];
    const { line, character } = file.getLineAndCharacterOfPosition(offset);
    return [{ line: line + 1, col: character + 1, marker: match[0], text: lines[line]?.trimEnd() ?? '' }];
  });
}
