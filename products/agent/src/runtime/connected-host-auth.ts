import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type JsonRecord = Record<string, unknown>;

export interface ConnectedHostOperatorToken {
  readonly path: string;
  readonly present: boolean;
  readonly token: string | null;
  readonly error?: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function connectedHostOperatorTokenPath(homeDirectory: string): string {
  return join(homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json');
}

export function readConnectedHostOperatorToken(homeDirectory: string): ConnectedHostOperatorToken {
  const connectedHostEnvToken = process.env.GOODVIBES_CONNECTED_HOST_TOKEN?.trim();
  if (connectedHostEnvToken) {
    return {
      path: 'env:GOODVIBES_CONNECTED_HOST_TOKEN',
      present: true,
      token: connectedHostEnvToken,
    };
  }
  const legacyEnvToken = process.env.GOODVIBES_DAEMON_TOKEN?.trim();
  if (legacyEnvToken) {
    return {
      path: 'env:GOODVIBES_DAEMON_TOKEN',
      present: true,
      token: legacyEnvToken,
    };
  }
  const path = connectedHostOperatorTokenPath(homeDirectory);
  if (!existsSync(path)) return { path, present: false, token: null };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    const token = isRecord(parsed) && typeof parsed.token === 'string' && parsed.token.trim().length > 0
      ? parsed.token
      : null;
    return { path, present: true, token };
  } catch (error) {
    return { path, present: true, token: null, error: error instanceof Error ? error.message : String(error) };
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
