import type { LegacyImportOperatorSession } from './legacy-work-ledger-import-operator.js';
import { projectLegacyImportWorks } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
interface Context { print(text: string): void }
interface Registry<T extends Context> { register(command: { name: string; description: string; usage: string; argsHint: string; handler(args: string[], context: T): Promise<void> }): void }
const quote = (value: string): string => JSON.stringify(value).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
/** Both keyboard and model callers use the same authenticated read policy. */
export function registerLegacyImportCommands<T extends Context>(registry: Registry<T>, open: (context: T, projectId: string) => Promise<LegacyImportOperatorSession>): void {
  registry.register({ name: 'work-import', description: 'Inspect protected legacy import preparation and durable recovery', usage: 'preview|status <project-id>', argsHint: 'preview|status <project-id>',
    async handler(args, context) {
      if (args.length !== 2 || !['preview', 'status'].includes(args[0]!)) { context.print('Usage: /work-import preview|status <project-id>. Autonomous execution awaits the shared host gate; payload flags cannot authorize it.'); return; }
      let session: LegacyImportOperatorSession | undefined;
      try {
        session = await open(context, args[1]!);
        const binding = session.binding;
        const lines = [`Project: ${quote(binding.projectId)}`, `Endpoint: ${quote(binding.endpoint)}`,
          `Principal: ${quote(binding.principalKind)}:${quote(binding.principalId)}`, `Workspace: ${quote(binding.workspaceId)}`];
        if (args[0] === 'status') {
          const entry = await session.status();
          if (!entry) lines.unshift('No saved legacy import for selected project.');
          else {
            lines.unshift(`Legacy import status: ${entry.state}`, `Request: ${quote(entry.command.requestId)}`, `Dispatch attempts: ${entry.attempts}`);
            lines.push(`Manifest digest: ${entry.command.manifest.digest}`);
            for (const decision of entry.decisions) lines.push(`Recorded Jev outcome: ${decision.outcome}; decision ${quote(decision.decisionId)}`);
            if (entry.result?.kind === 'rejected') lines.push(`Host rejection: ${entry.result.code}: ${quote(entry.result.reason)}`);
          }
        } else {
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
        }
        lines.push('Historical claims only; no execution or verification authority. Legacy sources are retained.');
        context.print(lines.join('\n'));
      } catch (error) { context.print(`Legacy import read unavailable: ${JSON.stringify(error instanceof Error ? error.message : String(error))}`); }
      finally { session?.dispose(); }
    } });
}
