import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { IGNORE_RULES, verifyAnalysis, type CheckChunk } from './types-resolution-plan.ts';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve('@arethetypeswrong/cli/package.json')), 'dist/index.js');

/** Direct Node child (no bunx/npm/shell descendants), killed on deadline. */
export async function runProcess(command: string, args: string[], timeout = 240_000): Promise<string> {
  const { stdout } = await exec(command, args, { timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export async function checkChunk(chunk: CheckChunk): Promise<void> {
  const started = Date.now();
  console.log(`attw start ${chunk.name}: ${chunk.entrypoints.join(', ')}`);
  const output = await runProcess('node', [cli, chunk.tarball, '--format', 'json',
    '--ignore-rules', ...IGNORE_RULES, '--entrypoints', ...chunk.entrypoints]);
  verifyAnalysis(output, chunk);
  console.log(`attw passed ${chunk.name}: ${chunk.entrypoints.length} exports, ${Date.now() - started}ms`);
}
