import ts from 'typescript';

/** Compare literal alternatives as a multiset while preserving every other declaration byte. */
export function normalizeLiteralUnionOrder(text: string): string {
  if (!text.includes('|')) return text;
  let invalid = false;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text, () => { invalid = true; });
  const masks: Array<{ start: number; end: number }> = [];
  const nesting: ts.SyntaxKind[] = [];
  let previous = ts.SyntaxKind.Unknown;
  let previousEnd = -1;
  const opening = new Map([
    [ts.SyntaxKind.OpenBraceToken, ts.SyntaxKind.CloseBraceToken],
    [ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.CloseParenToken],
    [ts.SyntaxKind.OpenBracketToken, ts.SyntaxKind.CloseBracketToken],
  ]);
  const closing = new Set(opening.values());
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const start = scanner.getTokenPos();
    const end = scanner.getTextPos();
    // Template interpolation needs scanner rescans. Leave that uncommon shape exact.
    if (kind === ts.SyntaxKind.TemplateHead || kind === ts.SyntaxKind.TemplateMiddle || kind === ts.SyntaxKind.TemplateTail) return text;
    if (nesting.length === 0 && kind === ts.SyntaxKind.SemicolonToken
      && previous === ts.SyntaxKind.SemicolonToken && previousEnd === start) {
      // Reports append local definitions as " ;; via Name = export type ...".
      // Only token-level metadata is masked for parsing; quoted text stays opaque.
      const label = /^\s+(?:via )?[A-Za-z_$][A-Za-z0-9_$]* = (?=(?:export )?(?:declare )?(?:type|interface)\b)/.exec(text.slice(end));
      if (label) masks.push({ start: end, end: end + label[0].length });
    }
    const close = opening.get(kind);
    if (close !== undefined) nesting.push(close);
    else if (closing.has(kind) && nesting.pop() !== kind) return text;
    previous = kind;
    previousEnd = end;
  }
  if (invalid || nesting.length !== 0) return text;
  let parsed = text;
  for (const mask of masks.reverse()) parsed = parsed.slice(0, mask.start) + ' '.repeat(mask.end - mask.start) + parsed.slice(mask.end);
  // VariableDeclaration.getText() omits the surrounding const declaration.
  const prefix = /^\s*[A-Za-z_$][A-Za-z0-9_$]*\s*[:=]/.test(parsed) ? 'declare const ' : '';
  parsed = prefix + parsed;
  const diagnostics = ts.transpileModule(parsed, {
    fileName: 'surface.ts', reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).diagnostics ?? [];
  if (diagnostics.some(item => item.category === ts.DiagnosticCategory.Error)) return text;
  const source = ts.createSourceFile('surface.ts', parsed, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits: Array<{ start: number; end: number; value: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isUnionTypeNode(node) && node.types.every(ts.isLiteralTypeNode)) {
      const original = node.types.map(member => member.getText(source));
      const sorted = [...original].sort();
      if (original.some((member, index) => member !== sorted[index])) {
        edits.push({ start: node.getStart(source) - prefix.length, end: node.end - prefix.length, value: sorted.join(' | ') });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  let result = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    if (edit.start < 0 || edit.end > text.length) return text;
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  }
  return result;
}
