import ts from 'typescript';
import type { SourceAnchor } from './static-source-readings.ts';

export interface LexicalSourceAnchor extends SourceAnchor {
  readonly lexicalKind: 'source-text' | 'comment' | 'prose';
  readonly literalValues?: readonly (string | {
    readonly encoding: 'utf-16-code-units';
    readonly codeUnits: readonly number[];
  })[];
}

/** Deferred-work policy can survive an identifier-only revision in the shared definition file. */
export function deferredBatteryPolicyStatements(source: string): readonly string[] | null {
  const file = ts.createSourceFile('static-source.ts', source, ts.ScriptTarget.Latest, true);
  const retained: string[] = [];
  const pureInternalDefinition = (node: ts.Node): boolean => {
    if (ts.isCallExpression(node) && (!ts.isIdentifier(node.expression)
      || !['defineBattery', 'internalState', 'yesNo'].includes(node.expression.text))) return false;
    if (ts.isNewExpression(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)
      || ts.isClassExpression(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
      || ts.isMethodDeclaration(node) || ts.isDeleteExpression(node) || ts.isTaggedTemplateExpression(node)
      || ts.isComputedPropertyName(node) || ts.isSpreadAssignment(node) || ts.isSpreadElement(node)
      || ts.isPostfixUnaryExpression(node)
      || (ts.isPrefixUnaryExpression(node) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken))
      || (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment)) return false;
    if (ts.isIdentifier(node)) {
      const propertyName = (ts.isPropertyAssignment(node.parent) && node.parent.name === node)
        || (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node);
      if (!propertyName && !['defineBattery', 'internalState', 'yesNo', 'PINNED_MODEL', 'INTERNAL_IDENTIFIER_INSTRUCTIONS', 'STAKES_BANDS'].includes(node.text)) return false;
    }
    return node.getChildren(file).every(pureInternalDefinition);
  };
  for (const statement of file.statements) {
    const declaration = ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
      ? statement.declarationList.declarations[0] : undefined;
    const name = declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
    if (name === 'INTERNAL_IDENTIFIER_INSTRUCTIONS') {
      if (!declaration?.initializer || !ts.isStringLiteral(declaration.initializer)) return null;
      continue;
    }
    if (name === 'internalIdentifier') {
      const initializer = declaration?.initializer;
      if (!initializer || !ts.isCallExpression(initializer) || !ts.isIdentifier(initializer.expression)
        || initializer.expression.text !== 'defineBattery' || !pureInternalDefinition(initializer)) return null;
      continue;
    }
    retained.push(statement.getText(file));
  }
  return retained;
}

/** Complete lexical text units; source punctuation alone has no identifier payload. */
export function internalSourceAnchors(path: string, text: string): LexicalSourceAnchor[] {
  if (!/\.[cm]?[jt]sx?$|\.json$/i.test(path)) return proseAnchors(text, path.endsWith('.md'));
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true,
    path.endsWith('.json') ? ts.ScriptKind.JSON : path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const anchors = new Map<string, LexicalSourceAnchor>();
  const comments = new Map<number, ts.CommentRange>();
  const lines = text.split('\n');
  const starts = [0];
  for (const line of lines) starts.push(starts.at(-1)! + line.length + 1);
  const sourceLines = new Map<number, { endLine: number; values: Set<string> }>();
  const add = (start: number, end: number, lexicalKind: LexicalSourceAnchor['lexicalKind']): void => {
    const { line, character } = file.getLineAndCharacterOfPosition(start);
    const id = `text_${start}_${end}`;
    anchors.set(id, { id, line: line + 1, col: character + 1, text: text.slice(start, end), lexicalKind });
  };
  const offer = (node: ts.Node, value?: string): void => {
    const first = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
    const last = file.getLineAndCharacterOfPosition(node.end).line;
    const range = sourceLines.get(first) ?? { endLine: last, values: new Set<string>() };
    range.endLine = Math.max(range.endLine, last);
    if (value !== undefined) range.values.add(value);
    sourceLines.set(first, range);
  };
  const capture = (node: ts.Node): void => {
    for (const range of [...ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [], ...ts.getTrailingCommentRanges(text, node.end) ?? []]) comments.set(range.pos, range);
    if (ts.isIdentifier(node)) offer(node);
    else if (ts.isLiteralExpression(node)) offer(node, node.text);
    else if (ts.isTemplateExpression(node) || ts.isJsxText(node)
      || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) {
      if (node.getText(file).trim()) offer(node);
    }
    // A whole interpolated string retains every literal part and its expressions.
    // Nested identifiers/comments remain separate lexical candidates.
    for (const child of node.getChildren(file)) capture(child);
  };
  capture(file);
  for (const [line, range] of sourceLines) {
    const start = starts[line]!;
    const end = Math.min(text.length, starts[range.endLine + 1]! - 1);
    const id = `line_${line + 1}`;
    anchors.set(id, { id, line: line + 1, col: 1, text: text.slice(start, end), lexicalKind: 'source-text',
      ...(range.values.size ? { literalValues: [...range.values].map(value => value.isWellFormed() ? value : {
        encoding: 'utf-16-code-units' as const,
        codeUnits: Array.from({ length: value.length }, (_, index) => value.charCodeAt(index)),
      }) } : {}) });
  }
  const ranges = [...comments.values()].sort((a, b) => a.pos - b.pos);
  for (let index = 0; index < ranges.length; index++) {
    const first = ranges[index]!;
    let last = first;
    while (first.kind === ts.SyntaxKind.SingleLineCommentTrivia) {
      const next = ranges[index + 1];
      if (!next || next.kind !== ts.SyntaxKind.SingleLineCommentTrivia
        || !/^[\t ]*\r?\n[\t ]*$/.test(text.slice(last.end, next.pos))) break;
      last = next; index++;
    }
    add(first.pos, last.end, 'comment');
  }
  return [...anchors.values()].sort((a, b) => a.line - b.line || a.col - b.col || a.id.localeCompare(b.id));
}

function proseAnchors(text: string, markdown: boolean): LexicalSourceAnchor[] {
  const lines = text.split('\n');
  const anchors: LexicalSourceAnchor[] = [];
  let first = 0;
  let current: string[] = [];
  const finish = (): void => {
    if (!current.length) return;
    anchors.push({ id: `prose_${first + 1}`, line: first + 1, col: 1, text: current.join('\n'), lexicalKind: 'prose' });
    current = [];
  };
  let fence = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim()) { finish(); continue; }
    const fenceLine = markdown && /^\s{0,3}(?:`{3,}|~{3,})/.test(line);
    const boundary = markdown && /^\s*(?:[-+*]\s|\d+[.)]\s|#{1,6}\s|\|)/.test(line);
    if (fenceLine || boundary || fence) finish();
    if (fenceLine) fence = !fence;
    // Bare Markdown delimiters have no textual label. A language/tag suffix
    // remains offered as source text rather than being classified locally.
    if (fenceLine && /^\s*(?:`{3,}|~{3,})\s*$/.test(line)) continue;
    if (!current.length) first = index;
    current.push(line);
    // Shell and other extensionless text keeps exact lines. Markdown paragraphs
    // retain the whole statement, including line-wrapped coordination prose.
    if (!markdown || fence || /^\s*\|/.test(line)) finish();
  }
  finish();
  return anchors;
}
