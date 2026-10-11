import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

export const PRODUCT_NAMES = ['daemon', 'tui', 'agent', 'webui'] as const;
export type ProductName = typeof PRODUCT_NAMES[number];
export interface ProductDefinition {
  readonly name: ProductName;
  readonly path: string;
  readonly packageName: string;
}
/** Executable workspace identities; project progress is not a build input. */
export const PRODUCT_DEFINITIONS: readonly ProductDefinition[] = PRODUCT_NAMES.map((name) => ({
  name, path: `products/${name}`, packageName: `@goodvibes-jev/${name}`,
}));
export interface ProductWorkspace {
  readonly definition: ProductDefinition;
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

function importFindings(root: string, product: ProductDefinition, files: readonly string[]): string[] {
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

/** Use the package's runtime entries and the browser build's HTML input. */
function entrypointFindings(directory: string, manifest: Record<string, unknown>, scripts: Readonly<Record<string, string>>): string[] {
  const entries = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === 'string' && /\.[cm]?[jt]sx?$/.test(value) && !/\.d\.[cm]?ts$/.test(value)) entries.add(value);
  };
  add(manifest.main);
  add(manifest.module);
  if (typeof manifest.bin === 'string') add(manifest.bin);
  else for (const value of Object.values(object(manifest.bin) ?? {})) add(value);
  const exported = (value: unknown): void => {
    if (typeof value === 'string') add(value);
    else if (Array.isArray(value)) value.forEach(exported);
    else for (const [condition, target] of Object.entries(object(value) ?? {})) if (condition !== 'types') exported(target);
  };
  exported(manifest.exports);
  for (const match of scripts.start?.matchAll(/(?:^|[\s"'])((?:\.\/)?(?:src|dist)\/[\w./-]+\.[cm]?[jt]sx?)(?=$|[\s"'])/g) ?? []) add(match[1]);
  const html = containedFile(directory, 'index.html');
  if (html !== undefined) {
    const text = readFileSync(html, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    for (const tag of text.matchAll(/<script\b([^>]*)>/gi)) {
      if (!/\btype\s*=\s*(["'])module\1/i.test(tag[1]!)) continue;
      const src = /\bsrc\s*=\s*(["'])([^"']+)\1/i.exec(tag[1]!);
      if (src !== null) add(src[2]!.replace(/^\/(?!\/)/, ''));
    }
  }
  // A compiler-produced runtime entry must have a real authored counterpart.
  // Read the same rootDir/outDir options as the product's existing build.
  const build = containedFile(directory, 'tsconfig.build.json');
  const config = build === undefined ? undefined : ts.readConfigFile(build, ts.sys.readFile);
  const parsed = config === undefined || config.error !== undefined ? undefined
    : ts.parseJsonConfigFileContent(config.config, ts.sys, directory, undefined, build);
  const { rootDir, outDir } = parsed?.options ?? {};
  const findings: string[] = [];
  if (entries.size === 0) findings.push('no source entrypoints declared by package/build inputs');
  for (const entry of entries) {
    if (entry.startsWith('/') || entry.split(/[\\/]/).includes('..')) {
      findings.push(`missing, empty or outside-product source entrypoint ${entry}`);
      continue;
    }
    let source = entry;
    if (rootDir !== undefined && outDir !== undefined) {
      const output = relative(outDir, resolve(directory, entry));
      if (output !== '' && !output.startsWith('..') && /\.[cm]?js$/.test(output)) {
        const stem = relative(directory, resolve(rootDir, output));
        const candidates = [stem.replace(/\.([cm]?)js$/, '.$1ts'), stem.replace(/\.js$/, '.tsx')];
        source = candidates.find((candidate) => containedFile(directory, candidate) !== undefined) ?? candidates[0]!;
      }
    }
    const path = containedFile(directory, source);
    if (path === undefined || ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest).statements.length === 0) {
      findings.push(`missing, empty or outside-product source entrypoint ${source} (from ${entry})`);
    }
  }
  return findings;
}

/** Validate executable workspace structure without project-tracking artifacts. */
export function inspectProductWorkspaces(root: string, definitions: readonly ProductDefinition[] = PRODUCT_DEFINITIONS): ProductInspection {
  const findings: string[] = [];
  const missing: string[] = [];
  const products: ProductWorkspace[] = [];
  for (const definition of definitions) {
    const directory = resolve(root, definition.path);
    if (!existsSync(directory)) { missing.push(definition.name); continue; }
    try {
      const manifest = json(resolve(directory, 'package.json'));
      if (manifest.name !== definition.packageName) findings.push(`${definition.path}: package name must be ${definition.packageName}`);
      const deps = { ...object(manifest.dependencies), ...object(manifest.devDependencies), ...object(manifest.peerDependencies), ...object(manifest.optionalDependencies) };
      if (deps['@goodvibes-jev/engine'] !== 'workspace:*') findings.push(`${definition.path}: engine must be a workspace:* dependency`);
      for (const dependency of Object.keys(deps)) if (dependency.startsWith('@pellux/goodvibes-')) findings.push(`${definition.path}: legacy dependency ${dependency}`);
      const scripts = Object.fromEntries(Object.entries(object(manifest.scripts) ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      for (const name of ['build', 'typecheck', 'test']) {
        const script = scripts[name]?.trim();
        if (!script || /^(?:echo\b|printf\b|true$|:$|exit\s+0$)/.test(script) || /--pass(?:WithNoTests|-with-no-tests)/.test(script)) findings.push(`${definition.path}: ${name} must be a real failing check, not an empty-success command`);
        for (const match of script?.matchAll(/(?:^|[\s"'])((?:\.\/)?(?:scripts|src)\/[\w./-]+\.(?:[cm]?[jt]sx?|sh))(?=$|[\s"'])/g) ?? []) {
          if (containedFile(directory, match[1]) === undefined) findings.push(`${definition.path}: ${name} references missing script/source ${match[1]}`);
        }
      }
      if (containedFile(directory, 'tsconfig.json') === undefined) findings.push(`${definition.path}: missing tsconfig.json`);
      const files = productFiles(directory);
      const coverage = typeCoverage(directory, files);
      findings.push(...coverage.findings);
      if (!files.some((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) && readFileSync(file, 'utf8').trim().length > 0)) findings.push(`${definition.path}: no actual test source`);
      findings.push(...entrypointFindings(directory, manifest, scripts).map((finding) => `${definition.path}: ${finding}`));
      findings.push(...importFindings(root, definition, files));
      products.push({ definition, scripts, tsconfigs: coverage.tsconfigs });
    } catch (error) { findings.push(`${definition.path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const directory = resolve(root, 'products');
  if (existsSync(directory)) for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !definitions.some((definition) => definition.name === entry.name)) findings.push(`products/${entry.name}: undeclared product workspace`);
  }
  return { products, missing, findings };
}

export type ProductCheckCommand =
  | { readonly kind: 'script'; readonly label: string; readonly cwd: string; readonly script: string }
  | { readonly kind: 'tsconfig'; readonly label: string; readonly cwd: string; readonly file: string };
export function productCheckCommands(root: string, products: readonly ProductWorkspace[], mode: 'build' | 'test' | 'typecheck'): readonly ProductCheckCommand[] {
  return products.flatMap((product): ProductCheckCommand[] => {
    const cwd = resolve(root, product.definition.path);
    // Inspection already verifies that every authored source/test/tooling file
    // belongs to a real compiler project. Run each of those projects once.
    // Product typecheck scripts are convenient local aggregates of the same
    // programs; invoking the aggregate and its children here repeats the work.
    if (mode === 'typecheck') return product.tsconfigs.map((file): ProductCheckCommand => ({ kind: 'tsconfig', label: `${product.definition.name}:${relative(cwd, file)}`, cwd, file }));
    return [{ kind: 'script', label: `${product.definition.name}:${mode}`, cwd, script: mode }];
  });
}

/** Explicit CI lanes never silently accept a typo, duplicate, or absent product. */
export function selectProductWorkspaces(products: readonly ProductWorkspace[], names: readonly string[]): readonly ProductWorkspace[] {
  if (names.length === 0) return products;
  if (new Set(names).size !== names.length) throw new Error('Duplicate product selector');
  for (const name of names) {
    if (!PRODUCT_NAMES.includes(name as ProductName)) throw new Error(`Unknown product selector ${name}`);
    if (!products.some((product) => product.definition.name === name)) throw new Error(`Selected product ${name} is not present`);
  }
  // Keep the aggregate's canonical order, independently of selector order.
  return products.filter((product) => names.includes(product.definition.name));
}

/** CI must cover every inspected workspace exactly once, never an empty matrix. */
export function productTestMatrix(inspection: ProductInspection): readonly ProductName[] {
  if (inspection.findings.length > 0) throw new Error(`Product inspection failed: ${inspection.findings.join('; ')}`);
  const names = inspection.products.map((product) => product.definition.name);
  if (names.length === 0) throw new Error('No present product workspaces for the CI matrix');
  selectProductWorkspaces(inspection.products, names);
  return names;
}
