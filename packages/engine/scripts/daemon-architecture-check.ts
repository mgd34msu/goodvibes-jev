/** The daemon's original four runtime boundaries, adapted to current owners. */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeArchitectureProblems, type RuntimeArchitecture } from './runtime-import-architecture.ts';

function sources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'test' || entry.name === '__tests__') return [];
    const file = resolve(root, entry.name);
    return entry.isDirectory() ? sources(file) : /\.[cm]?ts$/.test(entry.name) && !/\.(?:test|d)\.ts$/.test(entry.name) ? [file] : [];
  });
}

export function daemonArchitecture(root: string): RuntimeArchitecture {
  const product = resolve(root, 'products/daemon/src');
  const terminal = resolve(root, 'packages/engine/terminal-shell/src');
  // These are the mapped owners of the original src/cluster transport readers.
  const cluster = new Set(['daemon-ws-call.ts', 'raw-reply-route.ts'].map((file) => resolve(terminal, file)));
  for (const file of cluster) if (!existsSync(file)) throw new Error(`Missing mapped cluster owner: ${file}`);
  const composition = new Set(['configuration.ts', 'entrypoint.ts', 'index.ts', 'production-runtime.ts', 'run.ts', 'serve.ts', 'startup-maintenance.ts', 'startup-pairing.ts']);
  return {
    files: [...sources(product), ...sources(terminal)],
    layer(file) {
      if (cluster.has(file)) return 'cluster';
      const local = relative(product, file).split(sep);
      if (local[0] === '..' || local.length < 2) return undefined;
      // CLI execution now lives beside the command catalog. Only the latter is
      // the original cli layer; run/serve/entrypoint are composition roots.
      if (local[0] === 'cli') return composition.has(local[1]!) ? 'daemon' : 'cli';
      return local[0];
    },
    rules: [
      { from: 'config', forbidden: ['cli', 'cluster', 'daemon', 'runtime'] },
      { from: 'core', forbidden: ['cli', 'cluster', 'config', 'daemon', 'runtime'] },
      { from: 'cluster', forbidden: ['cli', 'daemon', 'runtime'] },
      { from: 'cli', forbidden: ['daemon'] },
    ],
  };
}

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const input = daemonArchitecture(root);
  const problems = runtimeArchitectureProblems(input);
  if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
  else console.log(`Daemon architecture: ${input.files.length} runtime files, four non-vacuous boundaries, no relative runtime cycles.`);
}
