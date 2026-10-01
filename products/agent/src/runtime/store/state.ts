import { createRuntimeStore, type RuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
export type { RuntimeState, UiPerfDomainState } from '@goodvibes-jev/engine/sdk/platform/runtime/state';

/** Preserve the local factory interface using the public engine state factory. */
export function createInitialRuntimeState(): RuntimeState {
  return createRuntimeStore().getState();
}
