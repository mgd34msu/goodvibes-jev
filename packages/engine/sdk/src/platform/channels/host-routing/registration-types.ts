import type { GatewayMethodCatalog } from '../../control-plane/method-catalog.js';

/** The host-owned catalog, path and diagnostics needed by routing registration. */
export interface RoutingHostContext {
  readonly catalog: GatewayMethodCatalog;
  readonly workingDirectory: string;
  readonly logger: {
    info(message: string, meta?: unknown): void;
    warn(message: string, meta?: unknown): void;
    error(message: string, meta?: unknown): void;
  };
}
