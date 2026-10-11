import { lstatSync, realpathSync } from 'node:fs';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ShellPathService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { resolveAndValidatePath } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { CommandContext } from '../input/command-registry.ts';
import { harnessCatalogInvocationAuthority } from './agent-harness-catalog-ingress.ts';

/** Retain a concrete user-store target through model-owned synchronous writes. */
export function captureHarnessLocalEffect(context: Pick<CommandContext, 'workspace'>, args: Record<string, unknown>,
  options: Parameters<Tool['execute']>[1], targets: (paths: ShellPathService) => readonly string[],
): () => void {
  if (!harnessCatalogInvocationAuthority(args, options, 'write')) throw new ToolInputProjectionError('held');
  const workspace = context.workspace, paths = workspace.shellPaths;
  if (!paths) throw new ToolInputProjectionError('held');
  const home = paths.homeDirectory, directory = paths.workingDirectory;
  const resolveUser = paths.resolveUserPath, resolveProject = paths.resolveProjectPath;
  const root = realpathSync(home), captured = targets(paths);
  const assertCurrent = () => {
    options?.signal?.throwIfAborted();
    if (!harnessCatalogInvocationAuthority(args, options, 'write')) throw new ToolInputProjectionError('held');
    if (context.workspace !== workspace || workspace.shellPaths !== paths || paths.homeDirectory !== home
      || paths.workingDirectory !== directory || paths.resolveUserPath !== resolveUser || paths.resolveProjectPath !== resolveProject
      || realpathSync(home) !== root || JSON.stringify(targets(paths)) !== JSON.stringify(captured)) throw new ToolInputProjectionError('held');
    for (const path of captured) {
      resolveAndValidatePath(path, home);
      if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) realpathSync(path);
    }
  };
  assertCurrent(); return assertCurrent;
}
