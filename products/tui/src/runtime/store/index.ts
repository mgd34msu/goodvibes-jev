/** The terminal uses the public Jev store and its typed gate/contract reducers. */
export {
  createRuntimeStore,
  createDomainDispatch,
} from '@goodvibes-jev/engine/sdk/platform/runtime/state';
export type {
  RuntimeStore,
  DomainDispatch,
  RuntimeState,
} from '@goodvibes-jev/engine/sdk/platform/runtime/state';
export * from './selectors/index.ts';
