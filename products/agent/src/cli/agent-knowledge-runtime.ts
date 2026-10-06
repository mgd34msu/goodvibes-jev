import { createBrowserAgentSdk, type BrowserAgentSdk } from '@goodvibes-jev/engine/sdk/browser/agent';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { VERSION } from '../version.ts';
import { normalizeAgentKnowledgeScopeAliases } from '../agent/knowledge-scope-alias.ts';
import { readConnectedHostOperatorToken } from '../runtime/connected-host-auth.ts';
import { connectedHostBaseUrl } from '../config/connected-host-dial.ts';
import type { ConnectedHostCallMethod } from './agent-knowledge-methods.ts';

export type JsonRecord = Record<string, unknown>;

export interface AgentKnowledgeConnection {
  readonly baseUrl: string;
  readonly token: string | null;
  readonly tokenPath: string;
}

export interface AgentKnowledgeConnectionRuntime {
  readonly configManager: {
    get(key: string): unknown;
  };
  readonly homeDirectory: string;
}

export interface AgentKnowledgeFailure {
  readonly ok: false;
  readonly kind:
    | 'connected_host_unavailable'
    | 'auth_required'
    | 'connected_host_incompatible'
    | 'connected_host_route_unavailable'
    | 'connected_host_error'
    | 'scope_contamination';
  readonly error: string;
  readonly baseUrl: string;
  readonly route: string;
}

export interface AgentKnowledgeSuccess<TData> {
  readonly ok: true;
  readonly kind: string;
  readonly route: string;
  readonly data: TData;
}

export type AgentKnowledgeResult<TData> = AgentKnowledgeSuccess<TData> | AgentKnowledgeFailure;

export function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readString(record: JsonRecord | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' ? value : null;
}

export function readPackageMetadata(): { readonly version: string } {
  return { version: VERSION };
}

export function resolveConnectedHostConnection(runtime: AgentKnowledgeConnectionRuntime): AgentKnowledgeConnection {
  const baseUrl = connectedHostBaseUrl(
    runtime.configManager.get('controlPlane.host'),
    runtime.configManager.get('controlPlane.port'),
  );
  const token = readConnectedHostOperatorToken(runtime.homeDirectory, baseUrl);
  return { baseUrl, token: token.token, tokenPath: token.path };
}

export async function fetchConnectedHostStatus(connection: AgentKnowledgeConnection): Promise<{ readonly ok: boolean; readonly status: number; readonly body: unknown }> {
  try {
    const response = await fetch(`${connection.baseUrl}/status`, {
      headers: connection.token ? { authorization: `Bearer ${connection.token}` } : undefined,
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: summarizeError(error) };
  }
}

export async function classifyKnowledgeError(error: unknown, connection: AgentKnowledgeConnection, route: string): Promise<AgentKnowledgeFailure> {
  const message = summarizeError(error);
  const lower = message.toLowerCase();
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('auth')) {
    return { ok: false, kind: 'auth_required', error: message, baseUrl: connection.baseUrl, route };
  }
  if (lower.includes('404') || lower.includes('not found')) {
    const connectedHost = await fetchConnectedHostStatus(connection);
    if (connectedHost.ok) {
      return {
        ok: false,
        kind: 'connected_host_incompatible',
        error: `Connected GoodVibes host compatibility does not satisfy Agent Knowledge requirements; Agent Knowledge route is unavailable.`,
        baseUrl: connection.baseUrl,
        route,
      };
    }
    return { ok: false, kind: 'connected_host_route_unavailable', error: message, baseUrl: connection.baseUrl, route };
  }
  if (lower.includes('fetch') || lower.includes('connect') || lower.includes('econnrefused')) {
    return { ok: false, kind: 'connected_host_unavailable', error: message, baseUrl: connection.baseUrl, route };
  }
  return { ok: false, kind: 'connected_host_error', error: message, baseUrl: connection.baseUrl, route };
}

export function normalizeAgentKnowledgeData<TData>(data: TData): TData {
  return normalizeAgentKnowledgeScopeAliases(data);
}

export function createAgentSdk(connection: AgentKnowledgeConnection): BrowserAgentSdk {
  const sdk = createBrowserAgentSdk({
    baseUrl: connection.baseUrl,
    authToken: connection.token,
  });
  return {
    ...sdk,
    knowledge: {
      ...sdk.knowledge,
      ask: async (input) => normalizeAgentKnowledgeData(await sdk.knowledge.ask(input)),
      search: async (input) => normalizeAgentKnowledgeData(await sdk.knowledge.search(input)),
      status: async (input) => normalizeAgentKnowledgeData(await sdk.knowledge.status(input)),
      map: async (input) => normalizeAgentKnowledgeData(await sdk.knowledge.map(input)),
    },
  };
}

const AGENT_KNOWLEDGE_SCOPE_KEYS = new Set(['spaceid', 'knowledgespaceid', 'namespace']);
const AGENT_KNOWLEDGE_SCOPE_TEXT_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  {
    label: 'default knowledge scope id',
    pattern: /["']?(?:knowledge[-_\s]*space[-_\s]*id|knowledgespaceid|space[-_\s]*id|spaceid|namespace)["']?\s*[:=]\s*["']?default["']?/i,
  },
  { label: 'host assistant payload marker', pattern: /home\s*assistant/i },
  { label: 'host graph payload marker', pattern: /home\s*graph|homegraph/i },
];

function normalizedJsonKey(key: string): string {
  return key.replace(/[-_\s]/g, '').toLowerCase();
}

function findAgentKnowledgeTextContamination(value: string): string | null {
  for (const { label, pattern } of AGENT_KNOWLEDGE_SCOPE_TEXT_PATTERNS) {
    if (pattern.test(value)) return label;
  }
  return null;
}

export function findAgentKnowledgeScopeContamination(value: unknown): string | null {
  const seen = new WeakSet<object>();
  const visit = (node: unknown): string | null => {
    if (typeof node === 'string') return findAgentKnowledgeTextContamination(node);
    if (!node || typeof node !== 'object') return null;
    if (seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const nested = visit(item);
        if (nested) return nested;
      }
      return null;
    }
    for (const [key, nestedValue] of Object.entries(node as JsonRecord)) {
      const keyFinding = findAgentKnowledgeTextContamination(key);
      if (keyFinding && keyFinding !== 'default knowledge scope id') return keyFinding;
      const normalizedKey = normalizedJsonKey(key);
      if (
        AGENT_KNOWLEDGE_SCOPE_KEYS.has(normalizedKey)
        && typeof nestedValue === 'string'
        && nestedValue.trim().toLowerCase() === 'default'
      ) {
        return `${key}=default`;
      }
      const nested = visit(nestedValue);
      if (nested) return nested;
    }
    return null;
  };
  return visit(value);
}

export function agentKnowledgeScopeContaminationFailure(
  connection: AgentKnowledgeConnection,
  route: string,
  finding: string,
): AgentKnowledgeFailure {
  return {
    ok: false,
    kind: 'scope_contamination',
    error: [
      `Agent Knowledge route returned non-Agent knowledge contamination (${finding}).`,
      'GoodVibes Agent must use only isolated /api/goodvibes-agent/knowledge/* scope data.',
    ].join(' '),
    baseUrl: connection.baseUrl,
    route,
  };
}

export function validateAgentKnowledgeData<TData>(
  data: TData,
  connection: AgentKnowledgeConnection,
  method: ConnectedHostCallMethod,
): AgentKnowledgeResult<TData> {
  const normalized = normalizeAgentKnowledgeData(data);
  const contamination = findAgentKnowledgeScopeContamination(normalized);
  if (contamination) return agentKnowledgeScopeContaminationFailure(connection, method.route, contamination);
  return { ok: true, kind: method.kind, route: method.route, data: normalized };
}

export async function postAgentKnowledgeJson<TData>(
  connection: AgentKnowledgeConnection,
  route: string,
  body: JsonRecord,
): Promise<TData> {
  const response = await fetch(`${connection.baseUrl}${route}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${connection.token ?? ''}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) {
    const detail = isRecord(parsed) && typeof parsed.error === 'string' ? parsed.error : text;
    throw new Error(`HTTP ${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`);
  }
  return normalizeAgentKnowledgeData(parsed as TData);
}

function queryRoute(route: string, query: JsonRecord): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim().length > 0) params.append(key, item);
      }
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      params.set(key, String(value));
    }
  }
  const suffix = params.toString();
  return suffix ? `${route}?${suffix}` : route;
}

export async function getAgentKnowledgeJson<TData>(
  connection: AgentKnowledgeConnection,
  route: string,
  query: JsonRecord = {},
): Promise<TData> {
  const response = await fetch(`${connection.baseUrl}${queryRoute(route, query)}`, {
    headers: {
      authorization: `Bearer ${connection.token ?? ''}`,
    },
  });
  const text = await response.text();
  let parsed: unknown = text;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) {
    const detail = isRecord(parsed) && typeof parsed.error === 'string' ? parsed.error : text;
    throw new Error(`HTTP ${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`);
  }
  return normalizeAgentKnowledgeData(parsed as TData);
}

export function findDisallowedKnowledgeScopeFlag(args: readonly string[]): string | null {
  const disallowed = [
    '--space',
    '--knowledge-space',
    '--knowledge-space-id',
    ['--knowledge', 'SpaceId'].join(''),
    '--include-all-spaces',
    ['--include', 'AllSpaces'].join(''),
    ['--home', 'graph'].join(''),
    ['--home', '-graph'].join(''),
  ];
  for (const token of args) {
    for (const flag of disallowed) {
      if (token === flag || token.startsWith(`${flag}=`)) return flag;
    }
  }
  return null;
}

export function formatScopeFlagRejection(flag: string): string {
  return [
    `Agent Knowledge is isolated; ${flag} is not accepted.`,
    'GoodVibes Agent must not use default knowledge or non-Agent product spaces.',
    'Use only /api/goodvibes-agent/knowledge/* Agent-owned routes.',
  ].join('\n');
}

export async function runKnowledgeCall<TData>(
  runtime: AgentKnowledgeConnectionRuntime,
  method: ConnectedHostCallMethod,
  call: (connection: AgentKnowledgeConnection) => Promise<TData>,
): Promise<AgentKnowledgeResult<TData>> {
  const connection = resolveConnectedHostConnection(runtime);
  if (!connection.token) {
    return {
      ok: false,
      kind: 'auth_required',
      error: `No connected-host operator token found at ${connection.tokenPath}`,
      baseUrl: connection.baseUrl,
      route: method.route,
    };
  }
  try {
    const data = await call(connection);
    return validateAgentKnowledgeData(data, connection, method);
  } catch (error) {
    return classifyKnowledgeError(error, connection, method.route);
  }
}
