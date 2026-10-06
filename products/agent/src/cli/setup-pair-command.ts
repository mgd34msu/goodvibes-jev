import { createInterface } from 'node:readline/promises';
import type { CliCommandRuntime } from './management.ts';
import { previewAgentHostPairing, type AgentHostPairingResult } from '../runtime/agent-host-pairing.ts';

export function formatSetupPairing(result: AgentHostPairingResult): string {
  return [
    `Agent host pairing: ${result.status}`,
    ...(result.host ? [`  Host: ${result.host}`] : []),
    ...(result.name ? [`  Device name: ${result.name}`] : []),
    ...(result.scopeDisclosure ? [`  Access: ${result.scopeDisclosure}`] : []),
    ...(result.environmentOverride ? ['  Environment token takes precedence over saved host-bound credentials and will remain unchanged.'] : []),
    `  ${result.message}`,
  ].join('\n');
}

export interface SetupPairingTerminal {
  readonly interactive: boolean;
  write(text: string): void;
  question(text: string, signal: AbortSignal): Promise<string>;
}

/** No --yes, scripted answer, or model-supplied confirmation bypass. */
export async function runSetupPairingCommand(runtime: CliCommandRuntime, terminal?: SetupPairingTerminal): Promise<number> {
  const args = runtime.cli.commandArgs.slice(1);
  let name = 'GoodVibes Agent'; let apply = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--apply' && !apply) { apply = true; continue; }
    if (arg === '--name' && args[index + 1] && name === 'GoodVibes Agent') { name = args[++index]!; continue; }
    console.error('Usage: goodvibes-agent setup pair [--name <device-name>] [--apply]. --apply requires fresh terminal confirmation; --yes is unsupported.');
    return 2;
  }
  if (apply && runtime.cli.flags.outputFormat !== 'text') { console.error('Pairing --apply requires a visible terminal confirmation; machine-readable output modes are preview-only.'); return 2; }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  let reader: ReturnType<typeof createInterface> | undefined;
  const io = terminal ?? {
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    write: (text: string) => { process.stdout.write(`${text}\n`); },
    question: (text: string, signal: AbortSignal) => {
      reader = createInterface({ input: process.stdin, output: process.stdout });
      return reader.question(text, { signal });
    },
  };
  try {
    const preview = await previewAgentHostPairing({ configManager: runtime.configManager, homeDirectory: runtime.homeDirectory }, name, controller.signal);
    io.write(runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(preview.result) : formatSetupPairing(preview.result));
    if (!apply || !preview.confirm || !preview.result.confirmation) return preview.result.status === 'preview' || preview.result.status === 'already-paired' ? 0 : 1;
    if (!io.interactive) { io.write('No credential was created. Run --apply in a terminal to review and confirm persistent administrative access.'); return 2; }
    const answer = await io.question(`Type ${preview.result.confirmation} to create this host-bound administrative credential, or press Enter to cancel: `, controller.signal);
    const result = await preview.confirm(answer, controller.signal);
    io.write(formatSetupPairing(result));
    return controller.signal.aborted ? 130 : result.status === 'paired' || result.status === 'paired-shadowed' ? 0 : result.status === 'cancelled' ? 2 : 1;
  } catch { io.write('Pairing interrupted. If a request may have started, run goodvibes-agent setup pair to inspect its outcome before taking further action.'); return controller.signal.aborted ? 130 : 1; }
  finally { reader?.close(); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
