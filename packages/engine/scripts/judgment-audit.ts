#!/usr/bin/env bun
/** Reproducible review queue, not an automatic verdict about semantic correctness. */
import ts from 'typescript';
import { resolve } from 'node:path';
import { judgmentSourceFiles, WORKSPACE_ROOT } from './judgment-sources.ts';
import { loadEngineRegistries } from './judgment-registries.ts';

interface Signal {
  readonly line: number;
  readonly kind: 'word-regex' | 'literal-text-match';
  readonly context: string;
  readonly expression: string;
}

const sources = judgmentSourceFiles();
const candidates: { file: string; signals: Signal[] }[] = [];
const workspaces: Record<string, number> = {};
for (const file of sources) {
  const workspace = file.split('/').slice(0, 2).join('/');
  workspaces[workspace] = (workspaces[workspace] ?? 0) + 1;
  const source = await Bun.file(resolve(WORKSPACE_ROOT, file)).text();
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, (/\.[jt]sx$/).test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const signals: Signal[] = [];
  const context = (node: ts.Node): string => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if ((ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isVariableDeclaration(parent)) && parent.name) return parent.name.getText(ast);
    }
    return '<module>';
  };
  const add = (node: ts.Node, kind: Signal['kind'], expression: string) => signals.push({
    line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, kind, context: context(node), expression,
  });
  const visit = (node: ts.Node): void => {
    if (ts.isRegularExpressionLiteral(node) && /[a-zA-Z]{4,}/.test(node.text)) add(node, 'word-regex', node.text);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ['includes', 'startsWith', 'endsWith'].includes(node.expression.name.text)) {
      const first = node.arguments[0];
      if (first && ts.isStringLiteral(first) && /[a-zA-Z]{4,}/.test(first.text)) add(node, 'literal-text-match', node.getText(ast));
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (signals.length) candidates.push({ file, signals });
}
const { decisions, files: registries } = await loadEngineRegistries();
const report = {
  schemaVersion: 1,
  scope: 'Engine and product TypeScript/JavaScript, including scripts; excludes tests, fixtures, generated dist and the judgment foundation.',
  interpretation: 'Candidates require human code review. Literal syntax, protocol checks and exact search can remain code. Absence of a candidate or presence of a registered battery does not prove semantic coverage. Dynamic keyword lists, numerical heuristics, indirect calls and non-TypeScript/JavaScript files are not classified by this scan.',
  scannedFiles: sources.length, workspaces, registeredDecisions: decisions.length, registryFiles: registries.length,
  candidateFiles: candidates.length, signalCount: candidates.reduce((total, file) => total + file.signals.length, 0),
  candidates,
};
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`[judgment-audit] ${report.scannedFiles} sources; ${report.registeredDecisions} registered decisions in ${report.registryFiles} registries`);
  console.log(`[judgment-audit] ${report.signalCount} review candidates in ${report.candidateFiles} files; not a pass/fail or coverage percentage`);
  for (const entry of [...candidates].sort((a, b) => b.signals.length - a.signals.length || a.file.localeCompare(b.file)).slice(0, 40)) {
    console.log(`  ${entry.signals.length}\t${entry.file}`);
  }
  console.log('[judgment-audit] Use --json for every candidate, source line and enclosing declaration.');
}
