/** Runtime-relative dependency analysis shared by product architecture gates. */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

export interface RuntimeLayerRule { readonly from: string; readonly forbidden: readonly string[]; }
export interface RuntimeArchitecture { readonly files: readonly string[]; readonly layer: (file: string) => string | undefined; readonly rules: readonly RuntimeLayerRule[]; }

/** Parse syntax, so comments and type-only edges cannot fabricate/hide runtime imports. */
export function runtimeImportSpecifiers(text: string): string[] {
  const source = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const add = (node: ts.Node | undefined): void => { if (node && ts.isStringLiteralLike(node)) imports.push(node.text); };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const allNamedTypeOnly = !clause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((item) => item.isTypeOnly);
      if (!clause?.isTypeOnly && !allNamedTypeOnly) add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      const allNamedTypeOnly = node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every((item) => item.isTypeOnly);
      if (!node.isTypeOnly && !allNamedTypeOnly) add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

export function resolveRuntimeImport(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const target = resolve(dirname(from), specifier);
  const candidates = /\.[cm]?js$/.test(target) ? [target.replace(/\.js$/, '.ts').replace(/\.mjs$/, '.mts').replace(/\.cjs$/, '.cts'), target] : [target, `${target}.ts`, join(target, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

export function runtimeArchitectureProblems(input: RuntimeArchitecture): string[] {
  const problems: string[] = [];
  const files = new Set(input.files.map((file) => resolve(file)));
  const layers = new Set([...files].map(input.layer).filter((layer) => layer !== undefined));
  for (const rule of input.rules) for (const layer of [rule.from, ...rule.forbidden]) {
    if (!layers.has(layer)) problems.push(`empty layer: ${layer}`);
  }
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const edges = runtimeImportSpecifiers(readFileSync(file, 'utf8')).flatMap((specifier) => {
      const target = resolveRuntimeImport(file, specifier);
      return target ? [target] : [];
    });
    graph.set(file, edges.filter((target) => files.has(target)));
    for (const target of edges) for (const rule of input.rules) {
      if (input.layer(file) === rule.from && rule.forbidden.includes(input.layer(target) ?? '')) problems.push(`layer ${rule.from}: ${file} -> ${target}`);
    }
  }
  // Tarjan SCCs preserve the original whole-component cycle diagnostic.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const active = new Set<string>();
  const visit = (file: string): void => {
    index.set(file, index.size); low.set(file, index.get(file)!); stack.push(file); active.add(file);
    for (const target of graph.get(file) ?? []) {
      if (!index.has(target)) { visit(target); low.set(file, Math.min(low.get(file)!, low.get(target)!)); }
      else if (active.has(target)) low.set(file, Math.min(low.get(file)!, index.get(target)!));
    }
    if (low.get(file) !== index.get(file)) return;
    const component: string[] = [];
    let member: string;
    do { member = stack.pop()!; active.delete(member); component.push(member); } while (member !== file);
    if (component.length > 1 || graph.get(file)?.includes(file)) problems.push(`runtime import cycle: ${component.sort().join(', ')}`);
  };
  for (const file of files) if (!index.has(file)) visit(file);
  return [...new Set(problems)];
}
