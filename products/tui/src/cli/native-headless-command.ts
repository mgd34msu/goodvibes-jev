import { join } from 'node:path';
import { createShellPathService } from '@/runtime/index.ts';
import { bootstrapRuntime } from '../runtime/bootstrap.ts';
import { executeNativeHeadless, writeNativeHeadlessResult, type NativeHeadlessHost } from './native-headless.ts';
import { executeAdmittedHeadlessTurn } from './native-headless-turn.ts';
import type { NativeHeadlessMode } from './native-headless-options.ts';
import { resolveDaemonEnabled, resolveGoodVibesDaemonHome, type ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { readFileSync } from 'node:fs';
import { resolveControlPlaneBaseUrl } from '../runtime/client/operator-endpoint.ts';

export async function runNativeHeadlessCommand(runtime: {
  readonly cli: { readonly flags: { readonly prompt?: string; readonly outputFormat: string }; readonly commandArgs: readonly string[]; readonly positionals: readonly string[] };
  readonly configManager: ConfigManager; readonly homeDirectory: string; readonly workingDirectory: string;
}, mode: NativeHeadlessMode = 'submit'): Promise<number> {
  const { cli, configManager, homeDirectory, workingDirectory } = runtime;
  const prompt = cli.flags.prompt ?? (cli.positionals.length ? cli.positionals.join(' ') : undefined);
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
  const journalPath = `${shellPaths.resolveUserPath('tui', 'native-work-submission.json')}.intake`;
  const resolveHost = (): NativeHeadlessHost => {
    const baseUrl = resolveControlPlaneBaseUrl(configManager);
    if (!baseUrl || !resolveDaemonEnabled(configManager)) return { reason: 'Selected daemon is disabled or has no endpoint.' };
    try {
      const stored: unknown = JSON.parse(readFileSync(join(resolveGoodVibesDaemonHome(homeDirectory), 'operator-tokens.json'), 'utf8'));
      if (stored && typeof stored === 'object' && 'token' in stored && typeof stored.token === 'string' && stored.token) return { baseUrl, token: stored.token, workspace: workingDirectory, journalPath };
    } catch {}
    return { reason: 'Native headless intake requires existing paired daemon authentication.' };
  };
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  // Retain ownership through cleanup and final output. One-shot runtime cleanup
  // handlers may re-raise a signal if our listener has already removed itself.
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    const result = await executeNativeHeadless({ mode, prompt, resolveHost, signal: controller.signal,
      async runTurn(state, signal) {
        if (signal.aborted) return { exitCode: 130, response: '', stopReason: 'cancelled' };
        const ctx = await bootstrapRuntime(process.stderr, { configManager, workingDir: workingDirectory, homeDirectory,
          daemonHomeDirectory: resolveGoodVibesDaemonHome(homeDirectory),
        });
        try { return await executeAdmittedHeadlessTurn(ctx, state, signal, cli.flags.outputFormat); }
        finally { await ctx.shutdown(ctx.conversation.toJSON() as Parameters<typeof ctx.shutdown>[0]); }
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
