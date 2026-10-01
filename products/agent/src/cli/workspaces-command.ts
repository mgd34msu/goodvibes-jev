import { createShellPathService } from '@/runtime/index.ts';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { WorkspaceRegistrationError } from '@goodvibes-jev/engine/sdk/platform/workspace';
import {
  createWorkspaceRegistrationStore,
  migrateLegacyWorkspaceRegistryIfNeeded,
  normalizeWorkspaceRoot,
  registerWorkspaceForCheckpoints,
} from '../config/workspace-registration.ts';
import type { CliCommandOutput } from './types.ts';
import type { CliCommandRuntime } from './management.ts';

/**
 * `goodvibes-agent workspaces`, manage the shared registered-workspace store
 * (SDK 1.6.1 platform/workspace/registration) that gates automatic checkpoints
 * (owner ruling, 2026-07-10; see ../runtime/services.ts and
 * ../config/workspace-registration.ts). A workspace root not covered by this
 * store gets no automatic turn/agent-lifecycle checkpoints, and explicit
 * `checkpoints.create` gateway calls against it are refused with this
 * command's registration hint (see services.ts's checkpointsGatewayManager).
 *
 * Coverage flows down a registered root's subtree and is inherited through
 * the git worktree→main-repo link (an orchestration worktree of a registered
 * repo is covered without being registered itself), the CLI UX below (the
 * list/register/unregister subcommands, their flags, and their exit codes) is
 * unchanged from the local-registry predecessor this now reads/writes
 * through instead.
 */

function hasYes(args: readonly string[]): boolean {
  return args.includes('--yes');
}

function flagValue(args: readonly string[], names: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    for (const name of names) {
      if (token === name) {
        const next = args[index + 1];
        return next && !next.startsWith('--') ? next : null;
      }
      if (token.startsWith(`${name}=`)) return token.slice(name.length + 1);
    }
  }
  return null;
}

function commandValues(args: readonly string[]): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith('--')) values.push(token);
  }
  return values;
}

function jsonOrText(runtime: CliCommandRuntime, value: unknown, text: string): string {
  return runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(value, null, 2) : text;
}

function usage(runtime: CliCommandRuntime, error: string): CliCommandOutput {
  const message = `${error}\nUsage: goodvibes-agent workspaces [list|register [path] [--label <label>] --yes|unregister [path] --yes]`;
  return { output: jsonOrText(runtime, { ok: false, error: message }, message), exitCode: 2 };
}

export async function handleWorkspacesCommand(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  const shellPaths = createShellPathService({
    workingDirectory: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
  });

  // Idempotent, receipt-gated: a no-op after the first successful migration on
  // this machine, from any entry point. See workspace-registration.ts.
  const migration = migrateLegacyWorkspaceRegistryIfNeeded(shellPaths);
  if (migration) {
    logger.info('Migrated the local workspace registry into the shared registration store', { ...migration });
  }

  const store = createWorkspaceRegistrationStore(shellPaths);
  const [sub = 'list', ...rawRest] = runtime.cli.commandArgs;
  const values = commandValues(rawRest);

  if (sub === 'list' || sub === 'ls') {
    const snapshot = await store.snapshot();
    const current = normalizeWorkspaceRoot(runtime.workingDirectory);
    const currentResolution = await store.resolve(current);
    const currentWorkspaceRegistered = currentResolution.status === 'covered';
    if (runtime.cli.flags.outputFormat === 'json') {
      return {
        output: JSON.stringify({ ok: true, ...snapshot, currentWorkspaceRegistered }, null, 2),
        exitCode: 0,
      };
    }
    const lines = snapshot.workspaces.length === 0
      ? ['No registered workspaces', '  automatic checkpoints are off everywhere until a workspace is registered']
      : [
        `Registered workspaces (${snapshot.workspaces.length})`,
        ...snapshot.workspaces.map((entry) => `  ${entry.root}${entry.label ? ` (${entry.label})` : ''}, registered ${entry.registeredAt}`),
      ];
    lines.push('', `current workspace ${current}`, `  registered ${currentWorkspaceRegistered ? 'yes' : 'no'}`);
    return { output: lines.join('\n'), exitCode: 0 };
  }

  if (sub === 'register' || sub === 'add') {
    const target = values[0] ?? runtime.workingDirectory;
    if (!hasYes(rawRest)) {
      return usage(runtime, `Refusing to register workspace ${normalizeWorkspaceRoot(target)} for automatic checkpoints without --yes.`);
    }
    const label = flagValue(rawRest, ['--label']) ?? undefined;
    try {
      // Explicit registration: registers AND stamps checkpoint-eligibility, so
      // this workspace becomes an owner-opted checkpoint boundary (a plain
      // store.add would register without enabling automatic checkpoints).
      const result = await registerWorkspaceForCheckpoints(shellPaths, target, label ? { label } : undefined);
      const text = result.alreadyRegistered
        ? `Workspace already registered: ${result.record.root}`
        : `Workspace registered: ${result.record.root}\n  automatic checkpoints are now allowed for this workspace`;
      return { output: jsonOrText(runtime, { ok: true, ...result }, text), exitCode: 0 };
    } catch (error) {
      const message = error instanceof WorkspaceRegistrationError ? error.message : summarizeError(error);
      return { output: jsonOrText(runtime, { ok: false, error: message }, message), exitCode: 2 };
    }
  }

  if (sub === 'unregister' || sub === 'remove' || sub === 'rm') {
    const target = values[0] ?? runtime.workingDirectory;
    if (!hasYes(rawRest)) {
      return usage(runtime, `Refusing to unregister workspace ${normalizeWorkspaceRoot(target)} without --yes.`);
    }
    const result = await store.remove(target);
    const text = result.removed
      ? `Workspace unregistered: ${normalizeWorkspaceRoot(target)}\n  automatic checkpoints are now off for this workspace`
      : `Workspace was not registered: ${normalizeWorkspaceRoot(target)}`;
    return { output: jsonOrText(runtime, { ok: true, ...result }, text), exitCode: result.removed ? 0 : 1 };
  }

  return usage(runtime, `Unknown workspaces subcommand: ${sub}`);
}
