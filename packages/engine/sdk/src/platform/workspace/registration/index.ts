/**
 * workspace/registration/index.ts
 *
 * Public barrel for the shared registered-workspace registry: the user-scoped
 * store (injectable I/O), the pure path→coverage resolver, and the
 * worktree→main-repo link probe.
 */

export {
  WorkspaceRegistrationStore,
  withWorkspaceRegistrationWriteLockSync,
  type WorkspaceRegistrationStoreOptions,
  type RegisterWorkspaceResult,
} from './store.js';
export {
  resolveWorkspaceRegistration,
  normalizeWorkspaceRoot,
  pathCovers,
} from './resolution.js';
export { probeWorktreeLink, type GitRunner } from './worktree-link.js';
export {
  WorkspaceRegistrationError,
  NativeWorkspaceScopeError,
  type NativeWorkspaceScope,
  type RegisteredWorkspaceRecord,
  type DeclinedWorkspaceRecord,
  type WorkspaceRegistrySnapshot,
  type WorkspaceCoverageStatus,
  type WorkspaceGitMetadata,
  type ResolveWorkspaceInput,
  type WorkspaceResolution,
} from './types.js';
