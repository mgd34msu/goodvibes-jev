import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractPublicationConflictError } from './publication-conflict.js';

async function git(args: readonly string[], env: NodeJS.ProcessEnv, signal: AbortSignal, outputLimit = 256 * 1024 * 1024) {
  signal.throwIfAborted();
  const child = spawn('git', [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  let retained = 0, bytes = 0, failure: Error | undefined;
  const abort = () => { child.kill('SIGKILL'); };
  const status = await new Promise<number | null>(resolve => {
    child.once('error', error => { failure = error; });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      const part = chunk.subarray(0, Math.max(0, outputLimit - retained));
      if (part.length) { chunks.push(Buffer.from(part)); retained += part.length; }
    });
    child.stderr.resume(); // Diagnostics can contain source; retain no body.
    child.once('close', code => { signal.removeEventListener('abort', abort); resolve(code); });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  signal.throwIfAborted();
  if (failure) throw new Error('Publication merge Git process could not complete.', { cause: failure });
  return { status, stdout: Buffer.concat(chunks).toString('utf8'), bytes };
}

/** Compute objects only. A separate Git directory excludes repository merge
 * drivers, hooks and attribute configuration; owner files and index are untouched. */
export async function mergePublicationTree(root: string, base: string, owner: string, result: string, paths: readonly string[], signal: AbortSignal): Promise<string> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const env = { ...inherited, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  const metadata = async (args: readonly string[]) => {
    const read = await git(['-C', root, ...args], env, signal);
    if (read.status !== 0) throw new Error('Publication merge repository metadata is unavailable.');
    return read.stdout.trim();
  };
  const objects = await metadata(['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
  const format = await metadata(['rev-parse', '--show-object-format']);
  if (format !== 'sha1' && format !== 'sha256') throw new Error('Publication merge object format is unsupported.');
  const directory = mkdtempSync(join(tmpdir(), 'goodvibes-publication-merge-'));
  try {
    const init = await git(['init', '--bare', '--quiet', '--template=', `--object-format=${format}`, directory], env, signal);
    if (init.status !== 0) throw new Error('Publication merge object workspace is unavailable.');
    const merged = await git([`--git-dir=${directory}`, '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null',
      'merge-tree', '--write-tree', '--no-messages', `--merge-base=${base}`, owner, result], { ...env, GIT_OBJECT_DIRECTORY: objects }, signal, 512);
    if (merged.status === 1) throw new ContractPublicationConflictError(paths);
    if (merged.status !== 0 || merged.bytes > 512) throw new Error('Publication merge could not establish a complete candidate.');
    const tree = merged.stdout.trim();
    if (!(format === 'sha1' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/).test(tree))
      throw new Error('Publication merge returned an invalid tree identity.');
    return tree;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
