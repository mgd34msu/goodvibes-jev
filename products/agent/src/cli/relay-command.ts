import { FEATURE_SETTINGS } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import type { CliCommandOutput } from './types.ts';
import type { CliCommandRuntime } from './management.ts';

/**
 * `goodvibes-agent relay status|pair`, the outbound zero-knowledge relay
 * (SDK 1.6.1, platform/relay) that lets a daemon register with a
 * self-hostable rendezvous relay so surfaces can reach it from outside the
 * LAN. Relay reachability (RelayReachability, the live registration
 * lifecycle, and the relay identity keypair a pairing payload is minted
 * from) is owned entirely by the SDK's DaemonServer facade
 * (buildDaemonRelayReachability, started at boot in facade.ts), the daemon
 * process holding the relay identity's private key material.
 *
 * GoodVibes Agent does not host that daemon. Its product boundary is
 * explicit and enforced elsewhere in this CLI (see parser.ts's
 * BLOCKED_PRODUCT_COMMAND_HINTS: "GoodVibes Agent connects to an externally
 * managed GoodVibes host and does not start or manage host processes" /
 * "does not start listeners or expose inbound host endpoints"). Relay is the
 * same shape of concern as those blocked commands, so this command reports
 * what is honestly knowable from here, the connected host's imported
 * relay.* configuration and the relay-connect feature flag's static
 * definition, and refuses to fabricate a live registration status or a
 * pairing payload neither of which this process can observe or mint. The
 * SDK's operator wire ships no remote relay-status/pairing route yet (relay
 * reuses the existing REST surface for tunneled traffic, not a status
 * query), so there is no live check to perform even for a genuinely
 * connected host.
 */

const RELAY_USAGE = 'Usage: goodvibes-agent relay [status|pair]';

function jsonOrText(runtime: CliCommandRuntime, value: unknown, text: string): string {
  return runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(value, null, 2) : text;
}

function relayConnectFlagSummary(): { readonly id: string; readonly name: string; readonly defaultState: string } {
  const feature = FEATURE_SETTINGS.find((entry) => entry.id === 'relay-connect');
  return {
    id: 'relay-connect',
    name: feature?.name ?? 'Outbound Zero-Knowledge Relay',
    defaultState: feature === undefined ? 'disabled' : feature.defaultEnabled ? 'enabled' : 'disabled',
  };
}

function handleRelayStatus(runtime: CliCommandRuntime): CliCommandOutput {
  const config = runtime.configManager;
  const enabled = config.get('relay.enabled') === true;
  const url = String(config.get('relay.url') ?? '');
  const rendezvousId = String(config.get('relay.rendezvousId') ?? '');
  const label = String(config.get('relay.label') ?? '');
  const requireStepUpForMutations = config.get('relay.requireStepUpForMutations') === true;
  const flag = relayConnectFlagSummary();

  const payload = {
    ok: true,
    source: 'agent-local-config' as const,
    liveVerified: false,
    config: { enabled, url, rendezvousId, label, requireStepUpForMutations },
    flag,
    note: 'This reflects goodvibes-agent\'s own imported copy of relay.* settings, not a live check of the connected GoodVibes daemon\'s actual relay registration, Agent hosts no daemon and the SDK has no remote relay-status route yet.',
  };

  const lines = [
    'GoodVibes relay (connected-host configuration; not live-verified)',
    `  relay.enabled: ${enabled ? 'true' : 'false'}`,
    `  relay.url: ${url || '(empty)'}`,
    `  relay.rendezvousId: ${rendezvousId || '(not generated yet)'}`,
    `  relay.label: ${label || '(empty)'}`,
    `  relay.requireStepUpForMutations: ${requireStepUpForMutations ? 'true' : 'false'}`,
    `  ${flag.id} feature flag: ${flag.name} (default ${flag.defaultState})`,
    '',
    'disabled/registered/offline is a property of the daemon that actually holds the relay',
    'identity and dials the relay server, that daemon is managed outside goodvibes-agent.',
    'Check its own status/doctor output, or the connected host directly.',
  ];

  return { output: jsonOrText(runtime, payload, lines.join('\n')), exitCode: 0 };
}

function handleRelayPair(runtime: CliCommandRuntime): CliCommandOutput {
  const message = [
    'GoodVibes Agent cannot mint a relay pairing payload.',
    'A pairing payload (relay URL + rendezvous id + pinned daemon public key) is minted',
    'in-process by the daemon that holds the relay identity\'s private key, Agent never',
    'holds that key material because it does not host the daemon (see "goodvibes-agent',
    'relay status"). Run the pairing step on the machine hosting the connected GoodVibes',
    'daemon, or use that host\'s own relay pairing surface once it ships one.',
  ].join('\n');
  const payload = { ok: false, available: false, reason: 'relay-identity-not-hosted-here', error: message };
  return { output: jsonOrText(runtime, payload, message), exitCode: 1 };
}

export function handleRelayCommand(runtime: CliCommandRuntime): CliCommandOutput {
  const [sub = 'status'] = runtime.cli.commandArgs;
  if (sub === 'status') return handleRelayStatus(runtime);
  if (sub === 'pair' || sub === 'pairing' || sub === 'qr' || sub === 'qrcode') return handleRelayPair(runtime);
  const message = `Unknown relay subcommand: ${sub}\n${RELAY_USAGE}`;
  return { output: jsonOrText(runtime, { ok: false, error: message }, message), exitCode: 2 };
}
