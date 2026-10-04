import { realpathSync } from 'node:fs';
import { openLegacyImportOperator, registerLegacyImportCommands, resolveLegacyImportJournalLocation, type LegacyImportOperatorSession } from '@goodvibes-jev/engine/terminal-shell/legacy-work-ledger-import';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { resolveConnectedHostConnection } from '../../runtime/client/daemon-verbs.ts';
import { requireShellPaths } from './runtime-services.ts';
export type OpenLegacyImportCommandSession = (context: CommandContext, projectId: string) => Promise<LegacyImportOperatorSession>;
export function registerLegacyWorkLedgerImportCommands(registry: CommandRegistry, open: OpenLegacyImportCommandSession = async (context, projectId) => {
  const paths = requireShellPaths(context);
  const { journalPath } = resolveLegacyImportJournalLocation({ workspace: paths.workingDirectory, projectId, stateDirectory: paths.resolveUserPath() });
  return openLegacyImportOperator({ projectId, journalPath, resolve: () => {
    const current = requireShellPaths(context);
    const host = resolveConnectedHostConnection({ configManager: context.platform.configManager, homeDirectory: current.homeDirectory });
    return 'reason' in host ? host : { ...host, workspace: realpathSync(current.workingDirectory) };
  } });
}): void { registerLegacyImportCommands(registry, open); }
