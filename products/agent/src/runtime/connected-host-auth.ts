import { canonicalizePairingHost, readAgentHostPairing, type AgentHostPairing } from './connected-host-pairing-store.ts';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type JsonRecord = Record<string, unknown>;

export interface ConnectedHostOperatorToken {
  readonly path: string;
  readonly present: boolean;
  readonly token: string | null;
  /** Opaque identity of the exact selected credential, including its provenance. */
  readonly selectionIdentity: string;
  /** Only private pairing records bind a token to a locally known principal. */
  readonly expectedPrincipalId?: string;
  readonly error?: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function connectedHostOperatorTokenPath(homeDirectory: string): string {
  return join(homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json');
}

export function readConnectedHostOperatorToken(homeDirectory: string, hostUrl?: string): ConnectedHostOperatorToken {
  const selected = (value: Omit<ConnectedHostOperatorToken, 'selectionIdentity'>, pairing?: AgentHostPairing): ConnectedHostOperatorToken => ({
    ...value,
    // Only the selected record participates: shadowed credentials cannot change
    // this authority. Never expose the private record in the returned identity.
    selectionIdentity: createHash('sha256').update(JSON.stringify([
      'agent-connected-host-selection:v1', hostUrl === undefined ? null : canonicalizePairingHost(hostUrl) ?? hostUrl,
      resolve(homeDirectory), value.path, value.token, pairing ?? null,
    ])).digest('hex'),
  });
  const connectedHostEnvToken = process.env.GOODVIBES_CONNECTED_HOST_TOKEN?.trim();
  if (connectedHostEnvToken) {
    return selected({
      path: 'env:GOODVIBES_CONNECTED_HOST_TOKEN',
      present: true,
      token: connectedHostEnvToken,
    });
  }
  const legacyEnvToken = process.env.GOODVIBES_DAEMON_TOKEN?.trim();
  if (legacyEnvToken) {
    return selected({
      path: 'env:GOODVIBES_DAEMON_TOKEN',
      present: true,
      token: legacyEnvToken,
    });
  }
  if (hostUrl !== undefined) {
    const pairing = readAgentHostPairing(homeDirectory, hostUrl);
    if (pairing.status === 'paired') return selected({ path: 'Agent host-bound pairing store', present: true, token: pairing.token, expectedPrincipalId: `pairing:${pairing.tokenId}` }, pairing);
    if (pairing.status === 'unknown') return selected({ path: 'Agent host-bound pairing store', present: true, token: null, error: 'A prior pairing outcome is unknown; no credential fallback or remint is allowed.' }, pairing);
    if (pairing.status === 'unavailable') return selected({ path: 'Agent host-bound pairing store', present: true, token: null, error: 'The Agent host-bound pairing store could not be read safely.' }, pairing);
  }
  const path = connectedHostOperatorTokenPath(homeDirectory);
  if (!existsSync(path)) return selected({ path, present: false, token: null });
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    const token = isRecord(parsed) && typeof parsed.token === 'string' && parsed.token.trim().length > 0
      ? parsed.token
      : null;
    return selected({ path, present: true, token });
  } catch {
    // Parser diagnostics can quote the secret-bearing source text.
    return selected({ path, present: true, token: null, error: 'Connected-host token record could not be read.' });
  }
}

export function connectedHostOperatorTokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

export function connectedHostTokenRequiredMessage(path: string): string {
  return [
    'Connected-host operator token is required.',
    `  token path ${path}`,
    '  Agent can create or repair the local canonical token only through the confirmed setup route:',
    '  agent_harness mode:"provision_connected_host_token" setupItemId:"connected-host-auth" confirm:true explicitUserRequest:"..."',
    '  Then rerun this command or inspect agent_harness mode:"connected_host_status".',
  ].join('\n');
}
