import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

type SourcePatch = { file: string; from: string; to: string };
interface PackageManifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** Resolve from the importing dependency owner, including Bun's linked store. */
function ownedPackage(owner: string, name: string): string | undefined {
  const require = createRequire(owner);
  for (const search of require.resolve.paths(name) ?? []) {
    const candidate = join(search, name, 'package.json');
    if (!existsSync(candidate)) continue;
    const manifest = realpathSync(candidate);
    const info: PackageManifest = JSON.parse(readFileSync(manifest, 'utf8'));
    if (info.name !== name || !info.version) throw new Error(`Invalid installed dependency identity: ${candidate}`);
    return manifest;
  }
  return undefined;
}

/**
 * Build-local replacements only. Never edit node_modules: multiple products and
 * worktrees can share the same readonly Bun store. Bun resolves imports relative
 * to these original filenames while compiling their in-memory replacement text.
 */
export function bunCompileCompatibilityFiles(root: string): Record<string, string> {
  const product = resolve(root, 'package.json');
  const engine = ownedPackage(product, '@goodvibes-jev/engine');
  const owners = engine ? [product, engine] : [product];
  const packages = new Map<string, PackageManifest>();
  const visit = (manifest: string): void => {
    if (packages.has(manifest)) return;
    const info: PackageManifest = JSON.parse(readFileSync(manifest, 'utf8'));
    packages.set(manifest, info);
    for (const name of Object.keys({ ...info.dependencies, ...info.optionalDependencies })) {
      const dependency = ownedPackage(manifest, name);
      if (dependency) visit(dependency);
    }
  };
  for (const owner of owners) {
    const info: PackageManifest = JSON.parse(readFileSync(owner, 'utf8'));
    for (const name of ['jsdom', 'sql.js']) {
      if (!Object.hasOwn({ ...info.dependencies, ...info.optionalDependencies }, name)) continue;
      const dependency = ownedPackage(owner, name);
      if (dependency) visit(dependency);
    }
  }

  const patches: SourcePatch[] = [];
  for (const [manifest, info] of packages) {
    const directory = dirname(manifest);
    if (info.name === 'css-tree') {
      const cssTreeRoot = directory;
      patches.push(
        {
          file: join(cssTreeRoot, 'lib', 'data-patch.js'),
          from: `import { createRequire } from 'module';\n\nconst require = createRequire(import.meta.url);\nconst patch = require('../data/patch.json');\n\nexport default patch;\n`,
          to: `import patch from '../data/patch.json';\n\nexport default patch;\n`,
        },
        {
          file: join(cssTreeRoot, 'lib', 'data.js'),
          from: `import { createRequire } from 'module';\nimport patch from './data-patch.js';\n\nconst require = createRequire(import.meta.url);\nconst mdnAtrules = require('mdn-data/css/at-rules.json');\nconst mdnProperties = require('mdn-data/css/properties.json');\nconst mdnSyntaxes = require('mdn-data/css/syntaxes.json');\n`,
          to: `import mdnAtrules from 'mdn-data/css/at-rules.json';\nimport mdnProperties from 'mdn-data/css/properties.json';\nimport mdnSyntaxes from 'mdn-data/css/syntaxes.json';\nimport patch from './data-patch.js';\n`,
        },
        {
          file: join(cssTreeRoot, 'lib', 'version.js'),
          from: `import { createRequire } from 'module';\n\nconst require = createRequire(import.meta.url);\n\nexport const { version } = require('../package.json');\n`,
          to: `import packageInfo from '../package.json';\n\nexport const { version } = packageInfo;\n`,
        },
      );
    } else if (info.name === 'jsdom') {
      const jsdomRoot = directory;
      const jsdomDefaultStyleSheet = join(jsdomRoot, 'lib', 'jsdom', 'browser', 'default-stylesheet.css');
      patches.push(
        {
          file: join(jsdomRoot, 'lib', 'jsdom', 'living', 'xhr', 'XMLHttpRequest-impl.js'),
          from: `const syncWorkerFile = require.resolve("./xhr-sync-worker.js");\n`,
          to: `const syncWorkerFile = null;\n`,
        },
        {
          file: join(jsdomRoot, 'lib', 'jsdom', 'living', 'xhr', 'XMLHttpRequest-impl.js'),
          from: `  if (!syncWorker) {\n    syncWorker = new Worker(syncWorkerFile);\n`,
          to: `  if (!syncWorker) {\n    if (!syncWorkerFile) {\n      throw new Error("Synchronous XMLHttpRequest is not supported in Bun-compiled GoodVibes binaries.");\n    }\n    syncWorker = new Worker(syncWorkerFile);\n`,
        },
      );
      if (existsSync(jsdomDefaultStyleSheet)) {
        const defaultStyleSheet = JSON.stringify(readFileSync(jsdomDefaultStyleSheet, 'utf8'));
        patches.push({
          file: join(jsdomRoot, 'lib', 'jsdom', 'living', 'css', 'helpers', 'computed-style.js'),
          from: `const defaultStyleSheet = fs.readFileSync(\n  path.resolve(__dirname, "../../../browser/default-stylesheet.css"),\n  { encoding: "utf-8" }\n);\n`,
          to: `const defaultStyleSheet = ${defaultStyleSheet};\n`,
        });
      }

    } else if (info.name === 'sql.js') {
      const sqlWasmJs = join(directory, 'dist', 'sql-wasm.js');
      const sqlWasmBinary = join(directory, 'dist', 'sql-wasm.wasm');
      if (existsSync(sqlWasmBinary)) {
        const sqlWasmBase64 = readFileSync(sqlWasmBinary).toString('base64');
        // sql.js 1.14.2's released loader and WASM must be embedded together.
        patches.push({
          file: sqlWasmJs,
          from: `k.noExitRuntime&&(Ya=k.noExitRuntime);k.print&&(Ea=k.print);k.printErr&&(B=k.printErr);k.wasmBinary&&(Fa=k.wasmBinary);k.thisProgram&&(xa=k.thisProgram);\n`,
          to: `k.noExitRuntime&&(Ya=k.noExitRuntime);k.print&&(Ea=k.print);k.printErr&&(B=k.printErr);k.wasmBinary&&(Fa=k.wasmBinary);if(!Fa&&typeof Buffer!=="undefined"){Fa=new Uint8Array(Buffer.from("${sqlWasmBase64}","base64"));}k.thisProgram&&(xa=k.thisProgram);\n`,
        });
      }

    }
  }
  const files: Record<string, string> = {};
  for (const patch of patches) {
    const file = realpathSync(patch.file);
    const source = files[file] ?? readFileSync(file, 'utf8');
    if (source.includes(patch.to)) continue;
    if (!source.includes(patch.from)) {
      throw new Error(`Unsupported Bun compile compatibility source in ${patch.file}`);
    }
    files[file] = source.replace(patch.from, patch.to);
  }
  return files;
}
