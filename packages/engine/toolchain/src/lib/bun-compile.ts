import { resolve } from 'node:path';

type CompileTarget = 'bun-linux-x64' | 'bun-linux-arm64' | 'bun-darwin-x64' | 'bun-darwin-arm64' | 'bun-windows-x64';
import { bunCompileCompatibilityFiles } from './bun-compile-compat.js';

/** The shared toolchain supplies each argument separately; never evaluate shell text. */
export function parseBunCompileArgs(args: readonly string[]): { entrypoint: string; outfile: string; target: CompileTarget; external: string[] } {
  const entrypoint = args[0];
  let outfile: string | undefined;
  let target: CompileTarget | undefined;
  let compile = false;
  const external: string[] = [];
  const targets: Readonly<Record<string, CompileTarget>> = {
    'bun-linux-x64': 'bun-linux-x64',
    'bun-linux-arm64': 'bun-linux-arm64',
    'bun-darwin-x64': 'bun-darwin-x64',
    'bun-darwin-arm64': 'bun-darwin-arm64',
    'bun-windows-x64': 'bun-windows-x64',
  };
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--compile') compile = true;
    else if (arg.startsWith('--target=')) target = targets[arg.slice('--target='.length)];
    else if (arg === '--outfile' || arg === '--external') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--outfile') outfile = value;
      else external.push(value);
    } else throw new Error(`Unsupported Bun compile argument: ${arg}`);
  }
  if (!entrypoint || entrypoint.startsWith('--') || !compile || !outfile || !target) {
    throw new Error('Bun compilation requires an entrypoint, --compile, --target=<supported target> and --outfile');
  }
  return { entrypoint, outfile, target, external };
}

export async function compileBunBinary(root: string, args: readonly string[]): Promise<void> {
  const options = parseBunCompileArgs(args);
  // The library remains importable by Node; Bun is needed only when compiling.
  const { build } = await import('bun');
  const result = await build({
    entrypoints: [resolve(root, options.entrypoint)],
    target: 'bun',
    compile: { target: options.target, outfile: resolve(root, options.outfile) },
    external: options.external,
    files: bunCompileCompatibilityFiles(root),
  });
  if (!result.success) throw new AggregateError(result.logs, 'Bun compilation failed');
}

