import { createShellPathService } from '@/runtime/index.ts';
import { bootstrapRuntime } from '../runtime/bootstrap.ts';
import { executeNativeHeadless, writeNativeHeadlessResult, type NativeHeadlessHost } from './native-headless.ts';
import { executeAdmittedHeadlessTurn } from './native-headless-turn.ts';
import type { NativeHeadlessMode } from './native-headless-options.ts';
import type { ConfigManager } from '../config/index.ts';
import { resolveConnectedHostConnection } from '../runtime/client/daemon-verbs.ts';
import { buildPersistedSessionContext, type SessionSnapshot } from '@/runtime/index.ts';
import { conversationMessagesAsSessionRecords } from '../core/conversation-message-snapshot.ts';

export async function runNativeHeadlessCommand(runtime: {
  readonly cli: { readonly flags: { readonly prompt?: string; readonly outputFormat: string }; readonly commandArgs: readonly string[]; readonly positionals: readonly string[] };
  readonly configManager: ConfigManager; readonly homeDirectory: string; readonly workingDirectory: string;
}, mode: NativeHeadlessMode = 'submit'): Promise<number> {
  const { cli, configManager, homeDirectory, workingDirectory } = runtime;
  const prompt = cli.flags.prompt ?? (cli.positionals.length ? cli.positionals.join(' ') : undefined);
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
  const journalPath = `${shellPaths.resolveUserPath('agent', 'native-work-submission.json')}.intake`;
  const resolveHost = (): NativeHeadlessHost => {
    const host = resolveConnectedHostConnection({ configManager, homeDirectory });
    return 'reason' in host ? host : { ...host, workspace: workingDirectory, journalPath };
  };
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const result = await executeNativeHeadless({ mode, prompt, resolveHost, signal: controller.signal,
      async runTurn(state, signal) {
        if (signal.aborted) return { exitCode: 130, response: '', stopReason: 'cancelled' };
        const ctx = await bootstrapRuntime(process.stderr, { configManager, workingDir: workingDirectory, homeDirectory });
        try { return await executeAdmittedHeadlessTurn(ctx, state, signal, cli.flags.outputFormat); }
        finally { const messages = ctx.conversation.getMessageSnapshot();
          const snapshot: SessionSnapshot = { messages: conversationMessagesAsSessionRecords(messages), timestamp: Date.now(), title: ctx.conversation.title, ...buildPersistedSessionContext(messages, ctx.conversation.getTitleSource()) };
          await ctx.shutdown(snapshot); }
      },
    });
    const lines: string[] = [];
    writeNativeHeadlessResult(result, cli.flags.outputFormat, line => lines.push(line));
    // The entrypoint exits immediately after this promise: wait for every pipe byte,
    // including queued stream deltas, rather than truncating a large final JSON result.
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${lines.join('\n')}\n`, error => error ? reject(error) : resolve());
    });
    return controller.signal.aborted ? 130 : result.exitCode;
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
