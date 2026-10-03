import type { CommandRegistry } from '../command-registry.ts';
import { requireShellPaths } from './runtime-services.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import {
  discoveredProvidersFilePath,
  loadLanScanConsent,
  saveLanScanConsent,
  NETWORK_SCAN_DISABLE_COMMAND,
  NETWORK_SCAN_ENABLE_COMMAND,
} from '../../runtime/lan-scan-consent.ts';

function statusText(storePath: string, decision: ReturnType<typeof loadLanScanConsent>): string {
  if (!decision || decision.decision === 'declined') {
    return [
      'Local network scanning: off',
      '  What it would do   Check other devices on your local network (your subnet only, nothing beyond it) for model servers such as Ollama or LM Studio.',
      `  What it stores     Found servers would be saved to ${storePath}.`,
      `  Turn it on         ${NETWORK_SCAN_ENABLE_COMMAND}`,
    ].join('\n');
  }
  return [
    'Local network scanning: on',
    `  Turned on           ${decision.decidedAt}`,
    '  What it does        Checks other devices on your local network (your subnet only, nothing beyond it) for model servers such as Ollama or LM Studio, each time the agent starts.',
    `  What it stores      Found servers are saved to ${storePath}.`,
    '  See discovered      /provider',
    `  Turn it off         ${NETWORK_SCAN_DISABLE_COMMAND}`,
  ].join('\n');
}

/**
 * /network-scan, the consent + status surface for the Phase-8 LAN provider
 * discovery scan (see src/runtime/lan-scan-consent.ts). Declining or never
 * deciding is a first-class, fully supported path: the scan simply never
 * runs until this command turns it on.
 */
export function registerNetworkScanRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'network-scan',
    aliases: ['discover-lan'],
    description: 'Turn local-network scanning for model servers on or off, or check its status',
    usage: '[on|off|status]',
    argsHint: '[on|off|status]',
    handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const storePath = discoveredProvidersFilePath(shellPaths, GOODVIBES_AGENT_SURFACE_ROOT);
      const sub = (args[0] ?? 'status').toLowerCase();

      if (sub === 'status' || sub === '') {
        ctx.print(statusText(storePath, loadLanScanConsent(shellPaths, GOODVIBES_AGENT_SURFACE_ROOT)));
        return;
      }

      if (sub === 'on' || sub === 'enable') {
        saveLanScanConsent(shellPaths, GOODVIBES_AGENT_SURFACE_ROOT, 'granted');
        ctx.print(
          'Local network scanning is now on. Starting next launch, the agent will check other devices on your ' +
          `local network (your subnet only) for model servers such as Ollama or LM Studio, and save what it finds to ${storePath}. ` +
          'Run /provider to see discovered servers. Turn it off anytime with /network-scan off.',
        );
        return;
      }

      if (sub === 'off' || sub === 'disable') {
        saveLanScanConsent(shellPaths, GOODVIBES_AGENT_SURFACE_ROOT, 'declined');
        ctx.print(
          `Local network scanning is now off. Nothing on your network will be probed. Turn it back on anytime with ${NETWORK_SCAN_ENABLE_COMMAND}.`,
        );
        return;
      }

      ctx.print(`Usage: /network-scan [on|off|status]\n${statusText(storePath, loadLanScanConsent(shellPaths, GOODVIBES_AGENT_SURFACE_ROOT))}`);
    },
  });
}
