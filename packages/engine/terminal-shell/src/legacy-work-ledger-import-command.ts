import type { LegacyImportOperatorSession } from './legacy-work-ledger-import-operator.js';
interface Context { print(text: string): void }
interface Registry<T extends Context> { register(command: { name: string; description: string; usage: string; argsHint: string; handler(args: string[], context: T): Promise<void> }): void }
/** Both keyboard and model callers use the same authenticated read policy. */
export function registerLegacyImportCommands<T extends Context>(registry: Registry<T>, open: (context: T, projectId: string) => Promise<LegacyImportOperatorSession>): void {
  registry.register({ name: 'work-import', description: 'Inspect protected legacy import preparation and durable recovery', usage: 'preview|status <project-id>', argsHint: 'preview|status <project-id>',
    async handler(args, context) {
      if (args.length !== 2 || !['preview', 'status'].includes(args[0]!)) { context.print('Usage: /work-import preview|status <project-id>. Autonomous execution awaits the shared host gate; payload flags cannot authorize it.'); return; }
      let session: LegacyImportOperatorSession | undefined;
      try {
        session = await open(context, args[1]!);
        const value = args[0] === 'preview' ? await session.prepare() : await session.status();
        context.print(JSON.stringify({ binding: session.binding, historicalOnly: true, executionAuthority: 'none', result: value }).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`));
      } catch (error) { context.print(`Legacy import read unavailable: ${JSON.stringify(error instanceof Error ? error.message : String(error))}`); }
      finally { session?.dispose(); }
    } });
}
