import type { LegacyImportOperatorSession } from './legacy-work-ledger-import-operator.js';
import type { LegacyImportEntry } from './legacy-work-ledger-import-journal.js';
import { projectLegacyImportWorks } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
interface Context { print(text: string): void }
interface Registry<T extends Context> { register(command: { name: string; description: string; usage: string; argsHint: string; handler(args: string[], context: T): Promise<void> }): void }
const quote = (value: string): string => JSON.stringify(value).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
const usage = 'preview|status|submit <project-id> | reconsider|recover|cancel|restart <project-id> <request-id>';
function entryLines(entry: LegacyImportEntry | null): string[] {
  if (!entry) return ['No saved legacy import for selected project.'];
  const lines = [`Legacy import status: ${entry.state}`, `Request: ${quote(entry.command.requestId)}`, `Dispatch attempts: ${entry.attempts}`, `Manifest digest: ${entry.command.manifest.digest}`];
  for (const decision of entry.decisions) lines.push(`Recorded Jev outcome: ${decision.outcome}; decision ${quote(decision.decisionId)}`);
  if (entry.result?.kind === 'rejected') lines.push(`Host rejection: ${entry.result.code}: ${quote(entry.result.reason)}`);
  if (entry.state === 'accepted') lines.push('Native import recorded. Reported completion is not verified evidence; no work execution was started.');
  if (entry.state === 'unknown') lines.push('Dispatch outcome is unknown. Cancellation does not prove rollback. Use recover with this exact request ID; do not prepare another import.');
  if (entry.state === 'pending') lines.push('No accepted import receipt. Use reconsider with this exact request ID for a fresh host Jev reading, or cancel before dispatch.');
  if (entry.state === 'cancelled' || entry.state === 'rejected') lines.push('A fresh preparation requires restart with this exact request ID. The prior command is retained in history.');
  return lines;
}
/** Keyboard and model callers share deterministic authorization and host-owned Jev admission. */
export function registerLegacyImportCommands<T extends Context>(registry: Registry<T>, open: (context: T, projectId: string) => Promise<LegacyImportOperatorSession>): void {
  registry.register({ name: 'work-import', description: 'Import legacy work through native Jev admission and exact-request recovery', usage, argsHint: usage,
    async handler(args, context) {
      const action = args[0];
      const initial = action === 'preview' || action === 'status' || action === 'submit';
      const retained = action === 'reconsider' || action === 'recover' || action === 'cancel' || action === 'restart';
      if ((!initial && !retained) || args.length !== (initial ? 2 : 3) || args.slice(1).some(arg => !arg.trim() || arg.startsWith('--'))) { context.print(`Usage: /work-import ${usage}. The host makes semantic decisions; payload flags cannot authorize an import.`); return; }
      let session: LegacyImportOperatorSession | undefined;
      try {
        session = await open(context, args[1]!);
        const binding = session.binding;
        const lines = [`Project: ${quote(binding.projectId)}`, `Endpoint: ${quote(binding.endpoint)}`,
          `Principal: ${quote(binding.principalKind)}:${quote(binding.principalId)}`, `Workspace: ${quote(binding.workspaceId)}`];
        if (action === 'preview') {
          const prepared = await session.prepare();
          if (prepared.kind === 'blocked') lines.unshift(`Preparation blocked: ${prepared.code}: ${quote(prepared.reason)}`);
          else {
            const manifest = prepared.manifest;
            lines.unshift('Legacy import preview', `Manifest digest: ${manifest.digest}`, `Expected ledger revision: ${manifest.expectedLedgerRevision}`);
            lines.push(`Complete sources: ${manifest.sources.length}`);
            for (const source of manifest.sources) lines.push(`Source: ${quote(String(source.source.id))}`, `  Generation: ${source.generation}`);
            for (const work of projectLegacyImportWorks(manifest, 0)) {
              lines.push(`Work: ${quote(work.id)} ${quote(work.title)}; reported=${work.reportedState}`, `  Goal: ${quote(work.goal)}`);
              for (const criterion of work.criteria) lines.push(`  Criterion: ${quote(criterion)}`);
            }
            for (const link of manifest.links) lines.push(`Link: ${quote(link.from)} ${quote(link.relation)} ${quote(link.to)}`);
          }
        } else {
          if (action !== 'status' && action !== 'cancel') context.print('Legacy import request pending. Waiting for the selected host; Jev retry and admission remain host-owned.');
          const entry = action === 'status' ? await session.status() : action === 'submit' ? await session.submit() : await session[action! as 'reconsider' | 'recover' | 'cancel' | 'restart'](args[2]!);
          lines.unshift(...entryLines(entry));
        }
        lines.push('Historical claims only; no execution or verification authority. Legacy sources are retained.');
        context.print(lines.join('\n'));
      } catch (error) {
        context.print(`Legacy import ${initial && action !== 'submit' ? 'read' : 'operation'} unavailable: ${quote(error instanceof Error ? error.message : String(error))}${action === 'preview' || action === 'status' ? '' : '\nInspect status. Any dispatched request remains saved with its exact identity; an interrupted response is not rollback.'}`);
      } finally { session?.dispose(); }
    } });
}
