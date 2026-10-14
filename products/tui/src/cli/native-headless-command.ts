import { createShellPathService } from '@/runtime/index.ts';
import { bootstrapRuntime } from '../runtime/bootstrap.ts';
import { executeNativeHeadless, writeNativeHeadlessResult, type NativeHeadlessHost, type NativeHeadlessResult } from './native-headless.ts';
import { executeHeadlessTurn } from './native-headless-turn.ts';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { NativeHeadlessMode } from './native-headless-options.ts';
import { resolveGoodVibesDaemonHome, type ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { resolveNativeHostCredential } from '../runtime/client/native-host-credential.ts';

export async function runNativeHeadlessCommand(runtime: {
  readonly cli: { readonly flags: { readonly prompt?: string; readonly outputFormat: string }; readonly commandArgs: readonly string[]; readonly positionals: readonly string[] };
  readonly configManager: ConfigManager; readonly homeDirectory: string; readonly workingDirectory: string;
}, mode: NativeHeadlessMode = 'submit'): Promise<number> {
  const { cli, configManager, homeDirectory, workingDirectory } = runtime;
  const prompt = cli.flags.prompt ?? (cli.positionals.length ? cli.positionals.join(' ') : undefined);
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
  const journalPath = `${shellPaths.resolveUserPath('tui', 'native-work-submission.json')}.intake`;
  const resolveHost = (): NativeHeadlessHost => {
    const credential = resolveNativeHostCredential({ configManager, homeDirectory });
    return credential.available
      ? { baseUrl: credential.baseUrl, token: credential.token, credentialIdentity: credential.identity, workspace: workingDirectory, journalPath }
      : { reason: credential.reason };
  };
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  // Retain ownership through cleanup and final output. One-shot runtime cleanup
  // handlers may re-raise a signal if our listener has already removed itself.
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    const runTurn = async (input: Parameters<typeof executeHeadlessTurn>[1], signal: AbortSignal) => {
      if (signal.aborted) return { exitCode: 130, response: '', stopReason: 'cancelled' };
      const ctx = await bootstrapRuntime(process.stderr, { configManager, workingDir: workingDirectory, homeDirectory,
        daemonHomeDirectory: resolveGoodVibesDaemonHome(homeDirectory),
      });
      try { return await executeHeadlessTurn(ctx, input, signal, cli.flags.outputFormat); }
      finally { await ctx.shutdown(ctx.conversation.toJSON() as Parameters<typeof ctx.shutdown>[0]); }
    };
    let result: NativeHeadlessResult;
    if (mode === 'submit') {
      if (prompt === undefined || !/\S/u.test(prompt)) {
        result = { exitCode: 2, response: '', error: 'A prompt is required.', stopReason: 'invalid-input' };
      } else {
        try { result = await runTurn(prompt, controller.signal); }
        catch (error) { result = { exitCode: controller.signal.aborted ? 130 : 1, response: '', error: summarizeError(error), stopReason: controller.signal.aborted ? 'cancelled' : 'unexpected_error' }; }
      }
    } else {
      result = await executeNativeHeadless({ mode, prompt, resolveHost, signal: controller.signal, runTurn });
    }
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
