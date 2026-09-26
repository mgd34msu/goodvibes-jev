import type { JsonRecord } from './route-helpers.js';

export type {
  ChannelAccountRegistryLike,
  DaemonIntegrationRouteContext,
  IntegrationHelperServiceLike,
  MemoryEmbeddingRegistryLike,
  MemoryRegistryLike,
  ProviderRuntimeSnapshotServiceLike,
  UserAuthManagerLike,
} from '@goodvibes-jev/engine/daemon-sdk';
export type { DaemonRuntimeEventDomain as RuntimeEventDomain } from '@goodvibes-jev/engine/daemon-sdk';

export interface IntegrationRuntimeStoreLike {
  getState(): {
    readonly deliveries: {
      readonly deliveryAttempts: Map<string, unknown>;
    };
  };
}
