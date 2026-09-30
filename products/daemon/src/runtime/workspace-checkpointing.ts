import { WorkspaceCheckpointManager } from '@goodvibes-jev/engine/sdk/platform/workspace';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { RuntimeEventBus, SessionSurface } from './index.js';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { readCheckpointGuardSettings, readCheckpointRegistrationSetting } from '../config/checkpoint-settings.js';
import { createWorkspaceRegistrationLiveChecker, type StoreShellPaths } from './trust/checkpoint-eligibility.js';

/**
 * The workspace checkpoint manager, gated on live registration.
 *
 * This daemon's checkpoint manager scopes the checkpoint git store to the
 * surface's own directory AND gates every automatic snapshot on the owner's
 * registered-workspaces-only ruling.
 *
 * The gate is a LIVE re-check rather than a construction-time decision. The
 * manager only subscribes to turn/agent-lifecycle events when it is built with a
 * runtime bus, so building it without one for an unregistered workspace would
 * mean registering that workspace mid-run had no effect until a restart. It is
 * always built WITH the bus and each individual automatic snapshot attempt is
 * refused instead, by overriding this one instance's own `create`, since the
 * manager has no predicate hook and `create` is the single seam both the
 * automatic subscription and every explicit caller pass through.
 */

export interface WorkspaceCheckpointing {
  /** The manager itself, automatic snapshots gated, explicit creates unrestricted. */
  readonly manager: WorkspaceCheckpointManager;
  /**
   * The narrower surface handed to the `checkpoints.*` gateway verbs: identical
   * except that an explicit create refuses, with an actionable message, when the
   * workspace is not checkpoint-eligible. Reads (list/diff/sessionChanges) and
   * restore stay unrestricted, they operate over checkpoints that may already
   * exist, including from a since-unregistered workspace.
   */
  readonly gatewayManager: Pick<WorkspaceCheckpointManager, 'list' | 'create' | 'diff' | 'restore' | 'sessionChanges' | 'workspaceRoot'>;
  /** Whether checkpoints are currently permitted for this workspace. Re-reads the store on every call. */
  readonly currentlyAllowed: () => boolean;
}

export function createWorkspaceCheckpointing(opts: {
  readonly workspaceRoot: string;
  /**
   * The declare-once storage handle. Passing it resolves the checkpoint git
   * store to `surface.checkpointsDir` instead of the unscoped
   * `<workspaceRoot>/.goodvibes/checkpoints` every product using this SDK would
   * otherwise share. The SDK migrates an existing legacy store into the scoped
   * location on first use.
   */
  readonly surface: SessionSurface;
  readonly runtimeBus: RuntimeEventBus;
  readonly configManager: ConfigManager;
  readonly shellPaths: StoreShellPaths;
  /** Stamps automatic snapshots with the live session id, so a checkpoint made this launch is found by the session-scoped restore lookup. */
  readonly resolveSessionId?: (ctx: { readonly turnId?: string | undefined; readonly agentId?: string | undefined }) => string | undefined;
}): WorkspaceCheckpointing {
  const registrationStatus = createWorkspaceRegistrationLiveChecker(opts.shellPaths, opts.workspaceRoot);
  const currentlyAllowed = (): boolean =>
    registrationStatus() === 'covered' || readCheckpointRegistrationSetting(opts.configManager) === 'guarded';

  const manager = new WorkspaceCheckpointManager({
    workspaceRoot: opts.workspaceRoot,
    // Root and retention guards from the owner's `checkpoints.*` settings. These
    // are defense in depth UNDER the registration rule, not a replacement for
    // it: even a registered root can still be refused as too broad or too large.
    ...readCheckpointGuardSettings(opts.configManager),
    surface: opts.surface,
    runtimeBus: opts.runtimeBus,
    ...(opts.resolveSessionId ? { resolveSessionId: opts.resolveSessionId } : {}),
  });

  // Automatic snapshots ('turn' | 'agent-run', fired by the manager's own bus
  // subscription) resolve to null quietly when the workspace is not eligible,
  // there is no caller to throw to, and the manager already documents a null
  // return as the cheap no-op for an unchanged tree. Explicit ('manual') creates
  // are NOT re-gated here: they go through the gateway surface below, which
  // throws something actionable before ever reaching this method.
  const originalCreate = manager.create.bind(manager);
  manager.create = ((createOpts) => {
    if (createOpts.kind !== 'manual' && !currentlyAllowed()) return Promise.resolve(null);
    return originalCreate(createOpts);
  }) as typeof manager.create;

  // Eagerly initialize so the automatic-snapshot subscription is live before the
  // first turn completes. If init() rejects, the manager caches that rejection
  // forever and every later call re-throws it, the catch here only prevents an
  // unhandled rejection at startup; the checkpoint verbs report the failure to
  // whoever calls them.
  void manager.init().catch((error: unknown) => {
    logger.warn('WorkspaceCheckpointManager.init failed', { error: error instanceof Error ? error.message : String(error) });
  });

  const gatewayManager: WorkspaceCheckpointing['gatewayManager'] = {
    workspaceRoot: manager.workspaceRoot,
    list: manager.list.bind(manager),
    diff: manager.diff.bind(manager),
    restore: manager.restore.bind(manager),
    sessionChanges: manager.sessionChanges.bind(manager),
    create: (createOpts) => {
      if (!currentlyAllowed()) {
        throw new Error(
          `Checkpoints are off for this workspace: ${opts.workspaceRoot} is not registered. `
          + 'Register it first, then retry (or set checkpoints.unregisteredWorkspaces to "guarded" '
          + 'to opt this workspace out of the registration gate).',
        );
      }
      // Default the session stamp from the live resolver when the caller omits
      // it, the resolveSessionId hook only auto-stamps automatic snapshots, so
      // without this an explicit checkpoint made this launch would be written
      // unstamped and excluded by the session-scoped restore lookup.
      const sessionId = createOpts.sessionId ?? opts.resolveSessionId?.({});
      return manager.create(sessionId ? { ...createOpts, sessionId } : createOpts);
    },
  };

  return { manager, gatewayManager, currentlyAllowed };
}
