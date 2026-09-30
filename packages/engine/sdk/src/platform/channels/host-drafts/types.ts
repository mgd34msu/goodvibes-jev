import type { GatewayMethodCatalog } from '../../control-plane/method-catalog.js';
import type { DaemonCredentialStore } from '../../config/daemon-credential-store.js';

/** Host-owned paths and ports needed by the draft mirror, with no global home fallback. */
export interface DraftHostContext {
  readonly catalog: GatewayMethodCatalog;
  readonly credentials: DaemonCredentialStore;
  readonly workingDirectory: string;
  readonly logger: {
    info(message: string, meta?: unknown): void;
    warn(message: string, meta?: unknown): void;
    error(message: string, meta?: unknown): void;
  };
}
