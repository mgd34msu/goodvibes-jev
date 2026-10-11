import ts from 'typescript';
import type { SourceAnchor } from './static-source-readings.ts';

export interface LexicalSourceAnchor extends SourceAnchor {
  readonly lexicalKind: 'source-text' | 'comment' | 'prose';
  readonly literalValues?: readonly (string | {
    readonly encoding: 'utf-16-code-units';
    readonly codeUnits: readonly number[];
  })[];
}

export interface MarkdownSourceRange {
  readonly firstLine: number;
  readonly lastLine: number;
}

/** Complete authored data declarations and actual module imports, without interpreting their meaning. */
export function structuredSourceContext(path: string, text: string): {
  readonly declarations: readonly MarkdownSourceRange[];
  readonly module: readonly MarkdownSourceRange[];
} {
  if (!/\.[cm]?[jt]sx?$/i.test(path)) return { declarations: [], module: [] };
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const range = (node: ts.Node): MarkdownSourceRange => ({
    firstLine: file.getLineAndCharacterOfPosition(ts.getLeadingCommentRanges(text, node.getFullStart())?.[0]?.pos ?? node.getStart(file)).line + 1,
    lastLine: file.getLineAndCharacterOfPosition(node.end).line + 1,
  });
  const structured = (node: ts.Node): boolean => {
    if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) return true;
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return false;
    return node.getChildren(file).some(structured);
  };
  const declarations: MarkdownSourceRange[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isVariableStatement(node) || ts.isExportAssignment(node) || ts.isExpressionStatement(node)) && structured(node)) {
      declarations.push(range(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const module: MarkdownSourceRange[] = [];
  const first = file.statements[0];
  if (first) {
    const preambleEnd = file.getLineAndCharacterOfPosition(first.getStart(file)).line;
    if (preambleEnd > 0) module.push({ firstLine: 1, lastLine: preambleEnd });
  }
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) module.push(range(statement));
  }
  return { declarations, module };
}

/** Actual structural declarations remain source evidence, never local authority. */
export function markdownSourceContext(text: string, anchors: readonly SourceAnchor[]): readonly MarkdownSourceRange[] {
  const lines = text.split('\n');
  const offered = new Set(anchors.map(anchor => anchor.line));
  const wanted = new Set<{ firstLine: number; lastLine: number }>();
  const preamble = { firstLine: 1, lastLine: lines.length };
  wanted.add(preamble);
  let preambleOpen = true;
  let firstContent = true;
  const headings: { level: number; range: { firstLine: number; lastLine: number }; open: boolean }[] = [];
  let fence: { marker: string; length: number; opening: { firstLine: number; lastLine: number }; closing: { firstLine: number; lastLine: number } } | undefined;
  let table: { firstLine: number; lastLine: number } | undefined;
  const delimiter = (line: string): boolean => {
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    return cells.length > 0 && cells.every(cell => /^\s*:?-{3,}:?\s*$/.test(cell));
  };
  const stopIntro = (beforeLine: number): void => {
    if (preambleOpen) { preamble.lastLine = beforeLine; preambleOpen = false; }
    const current = headings.at(-1);
    if (current?.open) { current.range.lastLine = beforeLine; current.open = false; }
  };
  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    const fenceLine = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (offered.has(number)) { wanted.add(fence.opening); wanted.add(fence.closing); for (const heading of headings) wanted.add(heading.range); }
      const marker = fenceLine?.[1];
      if (marker && marker.startsWith(fence.marker) && marker.length >= fence.length && !fenceLine?.[2]?.trim()) {
        fence.closing.firstLine = number; fence.closing.lastLine = number; fence = undefined;
      }
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})[\t ]+/.exec(line);
    const title = firstContent && heading?.[1]?.length === 1;
    const row = /^\s*\|/.test(line);
    const list = /^\s*(?:[-+*]\s|\d+[.)]\s)/.test(line);
    if ((heading && !title) || row || list || fenceLine) stopIntro(number - 1);
    if (heading?.[1]) {
      const level = heading[1].length;
      while (headings.at(-1) && headings.at(-1)!.level >= level) headings.pop();
      headings.push({ level, range: { firstLine: number, lastLine: lines.length }, open: true });
      table = undefined;
    }
    if (row) {
      if (!table && lines[index + 1] !== undefined && delimiter(lines[index + 1]!)) table = { firstLine: number, lastLine: number + 1 };
    } else table = undefined;
    if (offered.has(number)) {
      for (const current of headings) wanted.add(current.range);
      if (table) wanted.add(table);
    }
    if (fenceLine?.[1]) {
      fence = { marker: fenceLine[1].startsWith('`') ? '`' : '~', length: fenceLine[1].length,
        opening: { firstLine: number, lastLine: number }, closing: { firstLine: 0, lastLine: 0 } };
      table = undefined;
    }
    if (line.trim()) firstContent = false;
  }
  return [...wanted].filter(range => range.firstLine > 0 && range.lastLine >= range.firstLine)
    .sort((a, b) => a.firstLine - b.firstLine || a.lastLine - b.lastLine);
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
