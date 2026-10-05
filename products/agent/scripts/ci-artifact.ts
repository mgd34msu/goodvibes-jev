#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const payloads = ['goodvibes-agent-linux-x64', 'goodvibes-agent-linux-x64.bun', 'goodvibes-agent-linux-x64.bun.LICENSE.md', 'goodvibes-agent-linux-x64.bun.json', 'lib/sqlite-vec-linux-x64/vec0.so'] as const;
interface ArtifactManifest {
  schema: 1;
  revision: string;
  target: 'linux-x64';
  files: { path: string; sha256: string; mode: number }[];
}

function inspect(root: string, revision: string): ArtifactManifest {
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('Agent CI artifact requires an exact Git commit SHA');
  return {
    schema: 1, revision, target: 'linux-x64',
    files: payloads.map((path) => {
      const full = resolve(root, 'dist', path);
      const stat = lstatSync(full);
      if (!stat.isFile()) throw new Error(`Agent CI artifact is not a regular file: ${path}`);
      if ((path === payloads[0] || path.endsWith('.bun')) && (stat.mode & 0o111) === 0) throw new Error('Agent CI binary is not executable');
      return { path, sha256: createHash('sha256').update(readFileSync(full)).digest('hex'), mode: stat.mode & 0o777 };
    }),
  };
}

/** Record only the exact host binary, ordinary Bun sidecar with notices, and native library produced by this build. */
export function recordAgentCiArtifact(root: string, revision: string): void {
  writeFileSync(resolve(root, 'dist/ci-artifact.json'), `${JSON.stringify(inspect(root, revision), null, 2)}\n`);
}

/** Restoring tar must preserve source provenance, payload bytes and executable permissions. */
export function verifyAgentCiArtifact(root: string, revision: string): void {
  const stored: unknown = JSON.parse(readFileSync(resolve(root, 'dist/ci-artifact.json'), 'utf8'));
  if (JSON.stringify(stored) !== JSON.stringify(inspect(root, revision))) {
    throw new Error('Restored Agent CI artifact differs from its commit, payload or mode manifest');
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  const [action, revision] = process.argv.slice(2);
  if (!revision || (action !== 'record' && action !== 'verify')) throw new Error('Usage: ci-artifact.ts <record|verify> <commit SHA>');
  if (action === 'record') recordAgentCiArtifact(root, revision);
  else verifyAgentCiArtifact(root, revision);
}
