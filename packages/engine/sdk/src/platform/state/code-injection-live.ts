/** Per-invocation live-source adapter. Captured sources never enter this filesystem path. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs';
import { join, relative, isAbsolute, dirname } from 'node:path';
import { executePolicyCheck } from '../gate/execute-policy-check.js';
import { sha256 } from './code-index-chunking.js';
import { rankCodeInjectionSnapshots, type CodeInjectionAuthorityOptions } from './code-injection-ranking.js';
import type { CodeContextResult } from './code-index-types.js';

export async function rankLiveCodeInjection(root: string, query: string, hits: readonly CodeContextResult[], options: CodeInjectionAuthorityOptions, assertSource: () => void) {
  const policy = options.readAccessFilter;
  if (!policy) throw new Error('Code injection requires current read authority');
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const sourceRoot = realpathSync(root);
  const identity = (stat: Stats) => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const directories = new Map<string, string>([[sourceRoot, identity(lstatSync(sourceRoot))]]);
  const files = new Map<string, string>();
  const check = (): void => { signal.throwIfAborted(); assertSource(); if (realpathSync(root) !== sourceRoot) throw new Error('Code injection root is stale');
    for (const [path, expected] of directories) if (identity(lstatSync(path)) !== expected) throw new Error('Code injection directory is stale'); };
  const authorize = async (path: string): Promise<void> => {
    check();
    if (!(await executePolicyCheck(() => policy(path), signal))) throw new Error('Code injection source is access-restricted');
    check();
  };
  const sourcePath = (hit: CodeContextResult): string => {
    const path = join(sourceRoot, hit.chunk.path), rel = relative(sourceRoot, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || realpathSync(path) !== path) throw new Error('Code injection path is stale');
    return path;
  };
  const read = (hit: CodeContextResult): string => {
    check();
    const path = sourcePath(hit), before = lstatSync(path, { bigint: true });
    const currentIdentity = identity(lstatSync(path));
    if (files.has(path) && files.get(path) !== currentIdentity) throw new Error('Code injection file identity is stale');
    files.set(path, currentIdentity);
    if (!before.isFile() || before.nlink !== 1n || before.size > 128n * 1024n) throw new Error('Code injection source is unsupported');
    const byteIdentity = (stat: typeof before) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (byteIdentity(fstatSync(fd, { bigint: true })) !== byteIdentity(before)) throw new Error('Code injection source is stale');
      const buffer = Buffer.alloc(Number(before.size) + 1); let offset = 0;
      while (offset < buffer.length) { check(); const count = readSync(fd, buffer, offset, buffer.length - offset, offset); if (!count) break; offset += count; }
      if (offset !== Number(before.size) || byteIdentity(fstatSync(fd, { bigint: true })) !== byteIdentity(before)
        || byteIdentity(lstatSync(path, { bigint: true })) !== byteIdentity(before)) throw new Error('Code injection source is stale');
      const code = buffer.subarray(0, offset).toString('utf8');
      if (sha256(code) !== hit.chunk.fileHash) throw new Error('Code injection source is stale');
      return code;
    } finally { closeSync(fd); }
  };
  const timer = setTimeout(() => controller.abort(new Error('Code injection read budget exceeded')), 15_000);
  try {
    await authorize(root); await authorize(sourceRoot);
    const snapshots: { hit: CodeContextResult; code: string }[] = [];
    for (const hit of hits) {
      const path = sourcePath(hit);
      for (let directory = dirname(path); directory !== sourceRoot; directory = dirname(directory)) {
        await authorize(directory);
        directories.set(directory, identity(lstatSync(directory)));
      }
      await authorize(path); snapshots.push({ hit, code: read(hit) });
    }
    const assertCurrent = async () => {
      const assertionTimer = setTimeout(() => controller.abort(new Error('Code injection authority budget exceeded')), 15_000);
      try {
      await authorize(root); await authorize(sourceRoot);
      for (const path of directories.keys()) if (path !== sourceRoot) await authorize(path);
      for (const snapshot of snapshots) { await authorize(sourcePath(snapshot.hit)); if (read(snapshot.hit) !== snapshot.code) throw new Error('Code injection source is stale'); }
      check();
      for (const [path, expected] of files) if (identity(lstatSync(path)) !== expected) throw new Error('Code injection file identity is stale');
      } finally { clearTimeout(assertionTimer); }
    };
    const reading = await rankCodeInjectionSnapshots(query, snapshots, { signal, assertCurrent });
    return reading;
  } catch (error) { controller.abort(); throw error; }
  finally { clearTimeout(timer); }
}
