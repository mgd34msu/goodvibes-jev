import type { ConfigManager, DaemonCredentialStore } from '@goodvibes-jev/engine/sdk/platform/config';
import type { GatewayMethodCatalog } from './contracts.js';
import type { NativeMutationHost } from '@goodvibes-jev/engine/sdk/platform/control-plane';

export interface HandlerLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

/** Host-owned paths and ports, preserving the pinned daemon handler context. */
export interface HandlerContext {
  readonly catalog: GatewayMethodCatalog;
  readonly credentials: DaemonCredentialStore;
  readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'>
    & Partial<Pick<ConfigManager, 'getIngestionQuarantine'>>;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly logger: HandlerLogger;
  readonly nativeMutationHost?: NativeMutationHost | undefined;
}

/** A real surface registration with an explicit completion boundary. */
export interface OwnedHandlerSurface {
  readonly ready?: Promise<void>;
  close(): Promise<void>;
}

export type SurfaceRegister = (ctx: HandlerContext) => OwnedHandlerSurface | Promise<OwnedHandlerSurface>;
