import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

export const PRODUCT_NAMES = ['daemon', 'tui', 'agent', 'webui'] as const;
export type ProductName = typeof PRODUCT_NAMES[number];
export type Disposition = 'PORT' | 'JEV' | 'HOIST' | 'DROP';
export interface ProductSource {
  readonly name: ProductName;
  readonly path: string;
  readonly packageName: string;
  readonly repository: string;
  readonly revision: string;
  readonly inventory: string;
  readonly inventoryPrefix: string;
  readonly files: readonly string[];
}
export interface ProductWorkspace {
  readonly source: ProductSource;
  readonly scripts: Readonly<Record<string, string>>;
  readonly tsconfigs: readonly string[];
}
export interface ProductInspection {
  readonly products: readonly ProductWorkspace[];
  readonly missing: readonly string[];
  readonly findings: readonly string[];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined;
}
function json(path: string): Record<string, unknown> {
  const parsed = object(JSON.parse(readFileSync(path, 'utf8')));
  if (parsed === undefined) throw new Error(`${path}: expected an object`);
  return parsed;
}

/** The checked-in path snapshots were read from each pinned upstream git tree. */
export function readProductSources(root: string): readonly ProductSource[] {
  const manifest = json(resolve(root, 'docs/inventory/product-sources.json'));
  if (manifest.version !== 1 || !Array.isArray(manifest.products)) throw new Error('Invalid product source manifest');
  const result = manifest.products.map((value): ProductSource => {
    const item = object(value);
    if (item === undefined || !PRODUCT_NAMES.includes(item.name as ProductName)
      || item.path !== `products/${item.name}` || item.packageName !== `@goodvibes-jev/${item.name}`
      || item.repository !== `mgd34msu/goodvibes-${item.name}` || typeof item.revision !== 'string'
      || !/^[a-f0-9]{40}$/.test(item.revision) || typeof item.inventory !== 'string'
      || typeof item.inventoryPrefix !== 'string' || strings(item.files) === undefined) throw new Error('Malformed pinned product source');
    const files = strings(item.files)!;
    if (files.length === 0 || new Set(files).size !== files.length) throw new Error(`${item.name}: empty or duplicate source snapshot`);
    return item as unknown as ProductSource;
  });
  if (result.length !== PRODUCT_NAMES.length || new Set(result.map((source) => source.name)).size !== PRODUCT_NAMES.length) throw new Error('Source manifest must name all four products exactly once');
  return result;
}

/** Inventory syntax is a machine-readable three-column prefix; prose stays prose. */
export function inventoryDispositions(text: string, prefix: string): ReadonlyMap<string, Disposition> {
  const rows = new Map<string, Disposition>();
  for (const line of text.split('\n')) {
    const match = /^\| `([^`]+)` \| (PORT|JEV|HOIST|DROP) \|/.exec(line);
    if (match === null) continue;
    const original = match[1]!;
    if (!original.startsWith(prefix)) throw new Error(`Inventory path ${original} lacks prefix ${prefix}`);
    const path = original.slice(prefix.length);
    if (rows.has(path)) throw new Error(`Duplicate inventory path ${path}`);
    rows.set(path, match[2] as Disposition);
  }
  return rows;
}

function containedFile(root: string, path: unknown): string | undefined {
  if (typeof path !== 'string' || path.length === 0 || path.startsWith('/') || path.split(/[\\/]/).includes('..')) return undefined;
  const target = resolve(root, path);
  try {
    const actual = realpathSync(target);
    if (relative(realpathSync(root), actual).startsWith('..') || !statSync(actual).isFile()) return undefined;
    return target;
  } catch { return undefined; }
}

export function productFiles(directory: string): readonly string[] {
  const found: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'dist', 'coverage', '.test-tmp'].includes(entry.name)) walk(resolve(path, entry.name));
      } else if (entry.isFile()) found.push(resolve(path, entry.name));
    }
  };
  walk(directory);
  return found.sort();
}

/** Only actual module specifiers are inspected, not historical names in prose. */
export function moduleSpecifiers(path: string, text: string): readonly string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = source.typeReferenceDirectives.map((reference) => reference.fileName);
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')
      && node.arguments[0] !== undefined && ts.isStringLiteral(node.arguments[0])) found.push(node.arguments[0].text);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression !== undefined && ts.isStringLiteral(node.moduleReference.expression)) found.push(node.moduleReference.expression.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function importFindings(root: string, product: ProductSource, files: readonly string[]): string[] {
  const findings: string[] = [];
  const exports = object(json(resolve(root, 'packages/engine/package.json')).exports) ?? {};
  for (const file of files.filter((path) => /\.[cm]?[jt]sx?$/.test(path))) {
    for (const specifier of moduleSpecifiers(file, readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('@pellux/goodvibes-')) findings.push(`${relative(root, file)}: legacy import ${specifier}`);
      if (specifier === '@goodvibes-jev/engine' || specifier.startsWith('@goodvibes-jev/engine/')) {
        const subpath = `.${specifier.slice('@goodvibes-jev/engine'.length)}`;
        if (!Object.hasOwn(exports, subpath)) findings.push(`${relative(root, file)}: undeclared engine subpath ${specifier}`);
      }
      if (specifier.startsWith('.') && relative(resolve(root, product.path), resolve(dirname(file), specifier)).startsWith('..')) {
        findings.push(`${relative(root, file)}: cross-workspace relative import ${specifier}; use a public engine subpath`);
      }
    }
  }
  return findings;
}

function typeCoverage(directory: string, files: readonly string[]): { tsconfigs: string[]; findings: string[] } {
  const candidates = files.filter((file) => /^tsconfig(?:\.[\w-]+)?\.json$/.test(basename(file)));
  const configs = new Map(candidates.map((file) => [file, ts.readConfigFile(file, ts.sys.readFile)]));
  const inherited = new Set<string>();
  for (const [file, config] of configs) {
    const value = object(config.config)?.extends;
    const bases = typeof value === 'string' ? [value] : strings(value) ?? [];
    for (const base of bases) {
      if (!base.startsWith('.')) continue;
      const path = resolve(dirname(file), base);
      if (configs.has(path)) inherited.add(path);
      else if (configs.has(`${path}.json`)) inherited.add(`${path}.json`);
    }
  }
  // An options-only file inherited by a real project is not another compiler
  // program. Counting its implicit default include would also hide files the
  // actual projects exclude. Keep conventional and explicitly scoped projects.
  const tsconfigs = candidates.filter((file) => {
    const config = configs.get(file)!;
    const raw = object(config.config);
    return config.error !== undefined || basename(file) === 'tsconfig.json' || !inherited.has(file)
      || raw !== undefined && ['files', 'include', 'exclude', 'references'].some((key) => Object.hasOwn(raw, key));
  });
  const covered = new Set<string>();
  const findings: string[] = [];
  for (const file of tsconfigs) {
    const config = configs.get(file)!;
    if (config.error !== undefined) { findings.push(`${file}: invalid TypeScript configuration`); continue; }
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(file), undefined, file);
    for (const diagnostic of parsed.errors) findings.push(`${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
    for (const input of parsed.fileNames) covered.add(resolve(input));
  }
  for (const file of files) {
    const local = relative(directory, file);
    // Fixtures are source-shaped data, not files this product executes.
    if (/\.[cm]?tsx?$/.test(file) && !local.split(/[\\/]/).includes('fixtures') && !covered.has(file)) findings.push(`${file}: source/test/tooling file is outside every TypeScript project`);
  }
  return { tsconfigs, findings };
}

function migrationFindings(root: string, source: ProductSource, migration: Record<string, unknown>, rows: ReadonlyMap<string, Disposition>, complete: boolean): string[] {
  const findings: string[] = [];
  const label = source.path;
  if (migration.sourceRevision !== source.revision) findings.push(`${label}: migration sourceRevision must match its pinned source`);
  const entrypoints = strings(migration.entrypoints);
  if (entrypoints === undefined || entrypoints.length === 0) findings.push(`${label}: declare real source entrypoints in migration.json`);
  for (const entry of entrypoints ?? []) {
    const path = containedFile(root, `${source.path}/${entry}`);
    if (path === undefined || !/\.[cm]?[jt]sx?$/.test(path)
      || ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest).statements.length === 0) findings.push(`${label}: missing or empty source entrypoint ${entry}`);
  }
  const mapped = new Set<string>();
  const mappings = Array.isArray(migration.mappings) ? migration.mappings : [];
  for (const value of mappings) {
    const mapping = object(value);
    if (mapping === undefined || typeof mapping.source !== 'string') { findings.push(`${label}: malformed module mapping`); continue; }
    if (mapped.has(mapping.source)) findings.push(`${label}: duplicate mapping ${mapping.source}`);
    mapped.add(mapping.source);
    const disposition = rows.get(mapping.source);
    if (disposition === undefined || mapping.disposition !== disposition) findings.push(`${label}: mapping disagrees with inventory for ${mapping.source}`);
    const targets = strings(mapping.targets);
    if (disposition === 'DROP') {
      if (targets?.length !== 0 || typeof mapping.reason !== 'string' || mapping.reason.trim().length === 0) findings.push(`${label}: DROP must name its reason and no targets for ${mapping.source}`);
    } else {
      if (targets === undefined || targets.length === 0) findings.push(`${label}: missing target for ${mapping.source}`);
      for (const target of targets ?? []) {
        if (containedFile(root, target) === undefined) findings.push(`${label}: missing or outside-workspace target ${target}`);
        if (disposition === 'HOIST' && !target.startsWith('packages/engine/')) findings.push(`${label}: HOIST target must live in the engine: ${target}`);
        if (disposition === 'PORT' && !target.startsWith(`${source.path}/`)) findings.push(`${label}: PORT target must live in its product: ${target}`);
      }
    }
  }
  if (complete) {
    for (const path of rows.keys()) if (!mapped.has(path)) findings.push(`${label}: source module not accounted for: ${path}`);
    const verification = object(migration.verification);
    for (const evidence of ['parity', 'proof', 'patternAudit']) {
      const path = containedFile(root, verification?.[evidence]);
      if (path === undefined || readFileSync(path, 'utf8').trim().length === 0) findings.push(`${label}: missing ${evidence} evidence file`);
    }
  }
  return findings;
}

/** Structural readiness, not an assertion that the parity evidence is correct. */
export function inspectProductWorkspaces(root: string, sources: readonly ProductSource[], complete = false): ProductInspection {
  const findings: string[] = [];
  const missing: string[] = [];
  const products: ProductWorkspace[] = [];
  for (const source of sources) {
    const rows = inventoryDispositions(readFileSync(resolve(root, source.inventory), 'utf8'), source.inventoryPrefix);
    for (const file of source.files) if (!rows.has(file)) findings.push(`${source.inventory}: pinned source file omitted: ${file}`);
    for (const file of rows.keys()) if (!source.files.includes(file)) findings.push(`${source.inventory}: file absent from pinned source: ${file}`);
    const directory = resolve(root, source.path);
    if (!existsSync(directory)) { missing.push(source.name); if (complete) findings.push(`${source.path}: product is missing`); continue; }
    try {
      const manifest = json(resolve(directory, 'package.json'));
      if (manifest.name !== source.packageName) findings.push(`${source.path}: package name must be ${source.packageName}`);
      const deps = { ...object(manifest.dependencies), ...object(manifest.devDependencies), ...object(manifest.peerDependencies), ...object(manifest.optionalDependencies) };
      if (deps['@goodvibes-jev/engine'] !== 'workspace:*') findings.push(`${source.path}: engine must be a workspace:* dependency`);
      for (const dependency of Object.keys(deps)) if (dependency.startsWith('@pellux/goodvibes-')) findings.push(`${source.path}: legacy dependency ${dependency}`);
      const scripts = Object.fromEntries(Object.entries(object(manifest.scripts) ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      for (const name of ['build', 'typecheck', 'test']) {
        const script = scripts[name]?.trim();
        if (!script || /^(?:echo\b|printf\b|true$|:$|exit\s+0$)/.test(script) || /--pass(?:WithNoTests|-with-no-tests)/.test(script)) findings.push(`${source.path}: ${name} must be a real failing check, not an empty-success command`);
        for (const match of script?.matchAll(/(?:^|[\s"'])((?:\.\/)?(?:scripts|src)\/[\w./-]+\.(?:[cm]?[jt]sx?|sh))(?=$|[\s"'])/g) ?? []) {
          if (containedFile(directory, match[1]) === undefined) findings.push(`${source.path}: ${name} references missing script/source ${match[1]}`);
        }
      }
      if (containedFile(directory, 'tsconfig.json') === undefined) findings.push(`${source.path}: missing tsconfig.json`);
      const files = productFiles(directory);
      const coverage = typeCoverage(directory, files);
      findings.push(...coverage.findings);
      if (!files.some((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) && readFileSync(file, 'utf8').trim().length > 0)) findings.push(`${source.path}: no actual test source`);
      findings.push(...migrationFindings(root, source, json(resolve(directory, 'migration.json')), rows, complete));
      findings.push(...importFindings(root, source, files));
      products.push({ source, scripts, tsconfigs: coverage.tsconfigs });
    } catch (error) { findings.push(`${source.path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const directory = resolve(root, 'products');
  if (existsSync(directory)) for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !sources.some((source) => source.name === entry.name)) findings.push(`products/${entry.name}: undeclared product workspace`);
  }
  return { products, missing, findings };
}

export type ProductCheckCommand =
  | { readonly kind: 'script'; readonly label: string; readonly cwd: string; readonly script: string }
  | { readonly kind: 'tsconfig'; readonly label: string; readonly cwd: string; readonly file: string };
export function productCheckCommands(root: string, products: readonly ProductWorkspace[], mode: 'build' | 'test' | 'typecheck'): readonly ProductCheckCommand[] {
  return products.flatMap((product): ProductCheckCommand[] => {
    const cwd = resolve(root, product.source.path);
    // Inspection already verifies that every authored source/test/tooling file
    // belongs to a real compiler project. Run each of those projects once.
    // Product typecheck scripts are convenient local aggregates of the same
    // programs; invoking the aggregate and its children here repeats the work.
    if (mode === 'typecheck') return product.tsconfigs.map((file): ProductCheckCommand => ({ kind: 'tsconfig', label: `${product.source.name}:${relative(cwd, file)}`, cwd, file }));
    return [{ kind: 'script', label: `${product.source.name}:${mode}`, cwd, script: mode }];
  });
}

/** Explicit CI lanes never silently accept a typo, duplicate, or absent product. */
export function selectProductWorkspaces(products: readonly ProductWorkspace[], names: readonly string[]): readonly ProductWorkspace[] {
  if (names.length === 0) return products;
  if (new Set(names).size !== names.length) throw new Error('Duplicate product selector');
  for (const name of names) {
    if (!PRODUCT_NAMES.includes(name as ProductName)) throw new Error(`Unknown product selector ${name}`);
    if (!products.some((product) => product.source.name === name)) throw new Error(`Selected product ${name} is not present`);
  }
  // Keep the aggregate's canonical order, independently of selector order.
  return products.filter((product) => names.includes(product.source.name));
}

/** CI must cover every inspected workspace exactly once, never an empty matrix. */
export function productTestMatrix(inspection: ProductInspection): readonly ProductName[] {
  if (inspection.findings.length > 0) throw new Error(`Product inspection failed: ${inspection.findings.join('; ')}`);
  const names = inspection.products.map((product) => product.source.name);
  if (names.length === 0) throw new Error('No present product workspaces for the CI matrix');
  selectProductWorkspaces(inspection.products, names);
  return names;
}
