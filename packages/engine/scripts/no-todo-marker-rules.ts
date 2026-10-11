import ts from 'typescript';
import { captureStaticInputs, staticInputStanding, type SourceAnchor, type StaticSourceReadings } from './static-source-readings.ts';

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

/** Lexical anchors define candidates. Their meaning is decided only by recorded observations. */
export function sourceMarkerAnchors(path: string, text: string): SourceAnchor[] {
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
  const anchors = new Map<number, SourceAnchor>();
  const commentRanges = new Map<number, ts.CommentRange>();
  const add = (start: number, end: number): void => {
    const { line, character } = file.getLineAndCharacterOfPosition(start);
    anchors.set(start, { id: `anchor_${start}`, line: line + 1, col: character + 1, text: text.slice(start, end) });
  };
  const comments = (ranges: readonly ts.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) commentRanges.set(range.pos, range);
  };
  const implementationString = (node: ts.Node): boolean => {
    if (/\b(TODO|FIXME|XXX|HACK|STUB)\b/.test(text.slice(node.getStart(file), node.end))) return true;
    let expression = node;
    while (expression.parent && (ts.isAsExpression(expression.parent) || ts.isTypeAssertionExpression(expression.parent)
      || ts.isParenthesizedExpression(expression.parent) || ts.isSatisfiesExpression(expression.parent)
      || ts.isNonNullExpression(expression.parent))) expression = expression.parent;
    if (ts.isReturnStatement(expression.parent) || ts.isThrowStatement(expression.parent)) return true;
    const parent = expression.parent;
    return (ts.isNewExpression(parent) || ts.isCallExpression(parent)) && parent.arguments?.some(argument => argument === expression) === true
      && (ts.isIdentifier(parent.expression) && parent.expression.text.endsWith('Error'));
  };
  const capture = (node: ts.Node): void => {
    comments(ts.getLeadingCommentRanges(text, node.getFullStart()));
    comments(ts.getTrailingCommentRanges(text, node.end));
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      && implementationString(node)
      && !literalRanges.some(([start, end]) => node.getStart(file) >= start && node.end <= end)) {
      add(node.getStart(file), node.end);
    }
    // Token children retain comments between operators, inside empty bodies
    // and between declarations without treating string contents as comments.
    for (const child of node.getChildren(file)) capture(child);
  };
  capture(file);
  comments(ts.getLeadingCommentRanges(text, 0));
  // Contiguous line comments form one lexical statement. Keeping the complete
  // unit prevents a historical clause from losing the present-tense conclusion.
  const ranges = [...commentRanges.values()].sort((a, b) => a.pos - b.pos);
  for (let index = 0; index < ranges.length; index++) {
    const first = ranges[index]!;
    let last = first;
    while (first.kind === ts.SyntaxKind.SingleLineCommentTrivia) {
      const next = ranges[index + 1];
      if (!next || next.kind !== ts.SyntaxKind.SingleLineCommentTrivia
        || !/^[\t ]*\r?\n[\t ]*$/.test(text.slice(last.end, next.pos))) break;
      last = next; index++;
    }
    add(first.pos, last.end);
  }
  return [...anchors.values()].sort((a, b) => a.line - b.line || a.col - b.col);
}

export function sourceMarkerFindings(path: string, text: string, readings: StaticSourceReadings | null = null): SourceMarkerFinding[] {
  const inputs = captureStaticInputs('deferred-work', path, text, sourceMarkerAnchors(path, text));
  return inputs.flatMap(input => {
    const standing = staticInputStanding(input, readings);
    if (standing.kind === 'clear') return [];
    if (standing.kind === 'held') return [{ line: input.firstLine, col: 1, marker: 'evidence-held', text: `${standing.reason}; run static-source:read` }];
    return [{ line: standing.anchor.line, col: standing.anchor.col, marker: 'deferred-work', text: standing.anchor.text }];
  });
}
