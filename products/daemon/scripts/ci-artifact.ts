#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const payloads = ['goodvibes-daemon-linux-x64', 'goodvibes-daemon-linux-x64.bun', 'goodvibes-daemon-linux-x64.bun.LICENSE.md', 'goodvibes-daemon-linux-x64.bun.json', 'lib/sqlite-vec-linux-x64/vec0.so'] as const;
export interface DaemonArtifactSource {
  sourceCommit: string;
  sourceTree: string;
  headCommit: string;
}

async function inspect(root: string, source: DaemonArtifactSource) {
  for (const value of [source.sourceCommit, source.sourceTree, source.headCommit]) {
    if (!/^[0-9a-f]{40}$/.test(value)) throw new Error('Daemon CI artifact requires exact Git commit/tree SHAs');
  }
  const files = [];
  for (const path of payloads) {
    const full = resolve(root, 'native', path);
    const stat = lstatSync(full);
    if (!stat.isFile()) throw new Error(`Daemon CI artifact is not a regular file: ${path}`);
    if ((path === payloads[0] || path.endsWith('.bun')) && (stat.mode & 0o111) === 0) throw new Error('Daemon CI binary is not executable');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(full)) hash.update(chunk);
    files.push({ path, sha256: hash.digest('hex'), mode: stat.mode & 0o777, size: stat.size });
  }
  return { schema: 1, sourceCommit: source.sourceCommit, sourceTree: source.sourceTree, headCommit: source.headCommit, target: 'linux-x64', files };
}

/** Preserve the existing build's executable, Bun sidecar with notices, and native library, without rebuilding. */
export async function recordDaemonCiArtifact(root: string, source: DaemonArtifactSource): Promise<void> {
  writeFileSync(resolve(root, 'native/ci-artifact.json'), `${JSON.stringify(await inspect(root, source), null, 2)}\n`);
}

/** Verify restored payload bytes, modes, and exact checkout/PR provenance before execution. */
export async function verifyDaemonCiArtifact(root: string, source: DaemonArtifactSource): Promise<void> {
  const stored: unknown = JSON.parse(readFileSync(resolve(root, 'native/ci-artifact.json'), 'utf8'));
  if (JSON.stringify(stored) !== JSON.stringify(await inspect(root, source))) {
    throw new Error('Restored Daemon CI artifact differs from its source, payload or mode manifest');
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  const [action, sourceCommit, headCommit] = process.argv.slice(2);
  if (!sourceCommit || !headCommit || (action !== 'record' && action !== 'verify')) {
    throw new Error('Usage: ci-artifact.ts <record|verify> <checkout SHA> <PR head SHA>');
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  if (git('rev-parse', 'HEAD') !== sourceCommit) throw new Error('Daemon CI artifact checkout SHA mismatch');
  // Generated source changes must not be mislabeled as the checked-out commit.
  git('diff', '--exit-code', 'HEAD');
  const source = { sourceCommit, sourceTree: git('rev-parse', 'HEAD^{tree}'), headCommit };
  if (action === 'record') await recordDaemonCiArtifact(root, source);
  else await verifyDaemonCiArtifact(root, source);
}
