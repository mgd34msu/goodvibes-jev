import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import type { ArtifactDescriptor, ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { assertCurrentToolEffect, ToolInputProjectionError, type ToolExecuteOptions } from '@goodvibes-jev/engine/sdk/platform/tools';
import { resolveAndValidatePath } from '@goodvibes-jev/engine/sdk/platform/utils';

export function agentArtifactEffectGuard(args: Record<string, unknown>, options: ToolExecuteOptions | undefined, effect: 'write' | 'send' = 'write'): () => void {
  return () => {
    options?.signal?.throwIfAborted();
    if (!assertCurrentToolEffect(args, options, effect)) throw new Error('This action requires current recorded effect admission.');
  };
}

/** Keep the physical workspace and destination current across asynchronous reads. */
export function captureAgentExportPath(projectRoot: string, destination: string): { readonly path: string; readonly assertCurrent: (target?: string) => void } {
  const root = realpathSync(projectRoot);
  const identity = statSync(root);
  const path = resolveAndValidatePath(destination, root);
  const ancestors: Array<{ readonly path: string; readonly dev: number; readonly ino: number }> = [];
  let captured = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    captured = resolve(captured, part);
    let stats;
    try { stats = lstatSync(captured); } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') break;
      throw error;
    }
    ancestors.push({ path: captured, dev: stats.dev, ino: stats.ino });
  }
  const assertCurrent = (target = path) => {
    const current = statSync(root);
    if (realpathSync(projectRoot) !== root || current.dev !== identity.dev || current.ino !== identity.ino) throw new ToolInputProjectionError('stale');
    for (const ancestor of ancestors) {
      const stats = lstatSync(ancestor.path);
      if (stats.dev !== ancestor.dev || stats.ino !== ancestor.ino) throw new ToolInputProjectionError('stale');
    }
    resolveAndValidatePath(target, root);
    const parts = relative(root, resolve(target)).split(sep).filter(Boolean);
    let ancestor = root;
    for (const part of parts) {
      ancestor = resolve(ancestor, part);
      let stats;
      try { stats = lstatSync(ancestor); } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') break;
        throw error;
      }
      // existsSync hides dangling symlinks. A destination must never follow one.
      if (stats.isSymbolicLink()) resolveAndValidatePath(realpathSync(ancestor), root);
    }
  };
  assertCurrent();
  return { path, assertCurrent };
}

export function assertAgentArtifactBytes(descriptor: ArtifactDescriptor, buffer: Buffer): void {
  if (createHash('sha256').update(buffer).digest('hex') !== descriptor.sha256 || buffer.byteLength !== descriptor.sizeBytes) throw new ToolInputProjectionError('stale');
}

export function captureAgentArtifactSource(store: Partial<Pick<ArtifactStore, 'get' | 'list' | 'readContent'>>, descriptor: ArtifactDescriptor): () => void {
  const fingerprintOf = (source: ArtifactDescriptor) => JSON.stringify({
    id: source.id, kind: source.kind, mimeType: source.mimeType, filename: source.filename,
    sizeBytes: source.sizeBytes, sha256: source.sha256, createdAt: source.createdAt,
    expiresAt: source.expiresAt, sourceUri: source.sourceUri, acquisitionMode: source.acquisitionMode,
    fetchMode: source.fetchMode, metadata: source.metadata,
  });
  const fingerprint = fingerprintOf(descriptor);
  const get = store.get, list = store.list, readContent = store.readContent;
  return () => {
    if (store.get !== get || store.list !== list || store.readContent !== readContent) throw new ToolInputProjectionError('stale');
    const current = get?.call(store, descriptor.id) ?? list?.call(store, 10_000).find(artifact => artifact.id === descriptor.id);
    // A readContent-only store still owns the returned record. Capture that
    // record's complete receipt; a mutable source cannot rewrite the payload.
    if (fingerprintOf(current ?? descriptor) !== fingerprint) throw new ToolInputProjectionError('stale');
    if ((get || list) && !current) throw new ToolInputProjectionError('stale');
  };
}
