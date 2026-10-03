import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDaemonEnabled } from '@goodvibes-jev/engine/sdk/platform/config';
import { openLegacyImportOperator, registerLegacyImportCommands, resolveLegacyImportJournalLocation, type LegacyImportOperatorSession } from '@goodvibes-jev/engine/terminal-shell/legacy-work-ledger-import';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { resolveControlPlaneBaseUrl, resolveDaemonStateDirectory } from '../../runtime/client/operator-endpoint.ts';
import { requireShellPaths } from './runtime-services.ts';
export type OpenTuiLegacyImportSession = (context: CommandContext, projectId: string) => Promise<LegacyImportOperatorSession>;
export function registerTuiLegacyImportCommands(registry: CommandRegistry, daemonHomeDirectory?: string, open: OpenTuiLegacyImportSession = async (context, projectId) => {
  const paths = requireShellPaths(context);
  const { journalPath } = resolveLegacyImportJournalLocation({ workspace: paths.workingDirectory, projectId, stateDirectory: paths.resolveUserPath() });
  return openLegacyImportOperator({ projectId, journalPath, resolve: () => {
    const current = requireShellPaths(context); const baseUrl = resolveControlPlaneBaseUrl(context.platform.configManager);
    if (!baseUrl || !resolveDaemonEnabled(context.platform.configManager)) return { reason: 'Selected daemon is unavailable' };
    try {
      // Never use a token-minting resolver for this workflow.
      const record: unknown = JSON.parse(readFileSync(join(daemonHomeDirectory ?? resolveDaemonStateDirectory(current.homeDirectory), 'operator-tokens.json'), 'utf8'));
      if (record && typeof record === 'object' && 'token' in record && typeof record.token === 'string' && record.token.trim()) return { baseUrl, token: record.token, workspace: realpathSync(current.workingDirectory) };
    } catch { /* Missing existing auth remains unavailable. */ }
    return { reason: 'Selected daemon has no existing authentication' };
  } });
}): void { registerLegacyImportCommands(registry, open); }
