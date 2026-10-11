import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { DaemonInvokeOptions, DaemonOperatorInvoke } from './daemon-operator-client.ts';

export interface ChannelStoreEffectOptions extends DaemonInvokeOptions {
  readonly invoke?: DaemonOperatorInvoke;
  /** Validate exact planned bytes, then adopt only this writer's actual atomic publication. */
  readonly preparePublication?: ((path: string, contents: string) => () => void) | undefined;
}

/** Retain the complete read-modify-write source across the daemon await. */
export function retainChannelStoreSource(path: string, options: ChannelStoreEffectOptions): () => void {
  const current = options.assertCurrent, signal = options.signal, prepare = options.preparePublication;
  const revision = () => {
    const before = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!before) return null;
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw new ToolInputProjectionError('held');
    const fingerprint = (stat: typeof before) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const bytes = readFileSync(path), after = lstatSync(path, { bigint: true });
    if (fingerprint(before) !== fingerprint(after)) throw new ToolInputProjectionError('stale');
    return `${fingerprint(after)}:${createHash('sha256').update(bytes).digest('hex')}`;
  };
  signal?.throwIfAborted(); current?.();
  const source = current ? revision() : undefined;
  return () => {
    signal?.throwIfAborted(); current?.();
    if (options.assertCurrent !== current || options.signal !== signal || options.preparePublication !== prepare
      || current && revision() !== source) throw new ToolInputProjectionError('stale');
    signal?.throwIfAborted();
  };
}
