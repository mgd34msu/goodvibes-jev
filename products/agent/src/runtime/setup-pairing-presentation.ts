import type { AgentHostPairingResult } from './agent-host-pairing.ts';

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
