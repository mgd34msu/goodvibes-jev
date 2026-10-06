import { createInterface } from 'node:readline/promises';
import { TuiConfigManager } from '../config/host-settings.ts';
import { applyRuntimeConfigValue } from '@goodvibes-jev/engine/terminal-shell';
import { canonicalizePairingHost } from '../runtime/tui-host-credential-store.ts';
import { formatTuiHostPairing, previewTuiHostPairing } from '../runtime/tui-host-pairing.ts';

export const TUI_HOST_PAIR_HELP = 'Usage: goodvibes host pair [--url <exact-origin>] [--name <device-name>] [--bootstrap-shared] [--apply]. --apply requires fresh owner-terminal confirmation; --yes and scripted approval are unsupported.';
export interface TuiHostPairingTerminal {
  readonly interactive: boolean;
  write(text: string): void;
  question(text: string, signal: AbortSignal): Promise<string>;
}

/** This standalone route exits before ordinary startup, onboarding, daemon
 * adoption, generic command dispatch, or any model/tool runtime is created.
 */
export async function runTuiHostCommand(
  args: readonly string[],
  roots: { readonly homeDirectory: string; readonly defaultWorkingDirectory: string },
  terminal?: TuiHostPairingTerminal,
): Promise<number> {
  let reader: ReturnType<typeof createInterface> | undefined;
  const controller = new AbortController(); const interrupt = () => controller.abort();
  const openReader = () => {
    if (!reader) {
      reader = createInterface({ input: process.stdin, output: process.stdout });
      reader.on('SIGINT', interrupt); reader.on('close', interrupt);
    }
    return reader;
  };
  const io = terminal ?? {
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    write: (text: string) => { process.stdout.write(`${text}\n`); },
    question: (text: string, signal: AbortSignal) => {
      const active = openReader();
      active.write(null, { ctrl: true, name: 'u' }); // discard pre-prompt typeahead
      return active.question(text, { signal });
    },
  };
  let name = 'GoodVibes TUI'; let url: string | undefined; let bootstrapShared = false; let apply = false;
  const seen = new Set<string>();
  if (args.length === 0 || args.length === 1 && (args[0] === '--help' || args[0] === 'help')) { io.write(TUI_HOST_PAIR_HELP); return 0; }
  if (args[0] !== 'pair') { io.write(TUI_HOST_PAIR_HELP); return 2; }
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--help' && args.length === 2) { io.write(TUI_HOST_PAIR_HELP); return 0; }
    if (seen.has(arg)) { io.write(TUI_HOST_PAIR_HELP); return 2; }
    seen.add(arg);
    if (arg === '--apply') { apply = true; continue; }
    if (arg === '--bootstrap-shared') { bootstrapShared = true; continue; }
    if ((arg === '--url' || arg === '--name') && args[index + 1] && !args[index + 1]!.startsWith('--')) {
      const value = args[++index]!;
      if (arg === '--url') url = value; else name = value;
      continue;
    }
    io.write(TUI_HOST_PAIR_HELP); return 2;
  }
  if (url !== undefined && !canonicalizePairingHost(url)) { io.write('Use an exact HTTP(S) origin without a path, user information, query or fragment.'); return 2; }
  if (apply && !io.interactive) { io.write('No credential was created. Run --apply in an owner terminal to review and confirm persistent administrative access.'); return 2; }
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  // Own Ctrl-C and EOF throughout preview/request/verification, not only while
  // question() is pending. Lines entered before the fresh prompt are discarded.
  if (!terminal && io.interactive) openReader();
  try {
    const configManager = new TuiConfigManager({ workingDir: roots.defaultWorkingDirectory, homeDir: roots.homeDirectory, surfaceRoot: 'tui', readOnly: true });
    if (url !== undefined) applyRuntimeConfigValue(configManager, 'controlPlane.publicBaseUrl', canonicalizePairingHost(url)!);
    if (bootstrapShared) io.write('Explicit bootstrap: the existing daemon-global operator-tokens.json token will authenticate only to the selected host for this migration preview. Native work never uses it as a fallback. No secret is printed or copied.');
    const preview = await previewTuiHostPairing({ configManager, homeDirectory: roots.homeDirectory, bootstrapShared }, name, controller.signal);
    io.write(formatTuiHostPairing(preview.result));
    if (!apply || !preview.confirm || !preview.result.confirmation) return controller.signal.aborted ? 130 : ['preview', 'already-paired'].includes(preview.result.status) ? 0 : 1;
    const answer = await io.question(`Type ${preview.result.confirmation} to create this host-bound administrative credential, or press Enter to cancel: `, controller.signal);
    const result = await preview.confirm(answer, controller.signal);
    io.write(formatTuiHostPairing(result));
    return controller.signal.aborted ? 130 : result.status === 'paired' ? 0 : result.status === 'cancelled' ? 2 : 1;
  } catch {
    io.write('Pairing interrupted. If a request may have started, run goodvibes host pair to inspect its outcome before taking further action.');
    return controller.signal.aborted ? 130 : 1;
  } finally {
    reader?.removeListener('SIGINT', interrupt); reader?.removeListener('close', interrupt); reader?.close();
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
}
