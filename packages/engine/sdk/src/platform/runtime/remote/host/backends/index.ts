import type { PeerRecord } from '../peer-registry.js';
import { type Backend, type BackendContext } from './types.js';
import { createLocalProcessBackend } from './local-process.js';
import { createDockerBackend } from './docker.js';
import { createSshBackend } from './ssh.js';
import { createCloudTerminalBackend } from './cloud-terminal.js';

export type {
  Backend,
  BackendContext,
  BackendDispatchResult,
  DispatchPayload,
} from './types.js';
export {
  BackendDispatchError,
  DEFAULT_SYNC_TIMEOUT_MS,
  MAX_SYNC_TIMEOUT_MS,
  resolveTimeout,
} from './types.js';

/**
 * Build the full backend map keyed by backendKind. Each backend resolves its
 * own credentials lazily from the daemon credential store on dispatch; no
 * provider or child-process execution happens at construction time; only owned-file metadata is scanned.
 */
export function createBackends(
  ctx: BackendContext,
): Map<PeerRecord['backendKind'], Backend> {
  const backends: Backend[] = [
    createLocalProcessBackend(ctx),
    createDockerBackend(ctx),
    createSshBackend(ctx),
    createCloudTerminalBackend(ctx),
  ];
  const map = new Map<PeerRecord['backendKind'], Backend>();
  for (const backend of backends) {
    map.set(backend.kind, backend);
  }
  return map;
}
