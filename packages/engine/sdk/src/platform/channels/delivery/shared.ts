import { assertDeliveryCurrent, type DeliveryLifetime } from '../../utils/delivery-lifetime.js';
import { ArtifactStore, type ArtifactAttachment, type ArtifactReference } from '../../artifacts/index.js';
import { ConfigManager } from '../../config/manager.js';
import type { ConfigKey } from '../../config/schema-types.js';
import { ServiceRegistry, type ServiceSecretField } from '../../config/service-registry.js';
import type { SecretsManager } from '../../config/secrets.js';
import { resolveSecretInput } from '../../config/secret-refs.js';
import type {
  ChannelDeliveryRequest,
  ChannelDeliveryResult,
  ChannelDeliverySurfaceKind,
  ChannelDeliveryTarget,
} from './types.js';
import { instrumentedFetch } from '../../utils/fetch-with-timeout.js';
import { resolveReachableBaseUrl } from '../../utils/reachable-base-url.js';
import { HttpStatusError } from '@goodvibes-jev/engine/errors';

/** The lifetime is checked only after payload preparation, without an intervening await. */
export function deliveryFetch(
  lifetime: DeliveryLifetime,
  url: string | URL | Request,
  init?: RequestInit,
  diagnosticMode: 'default' | 'opaque-url' = 'default',
): Promise<Response> {
  assertDeliveryCurrent(lifetime);
  return instrumentedFetch(url, {
    ...init,
    ...(lifetime.signal ? { signal: init?.signal ? AbortSignal.any([init.signal, lifetime.signal]) : lifetime.signal } : {}),
  }, diagnosticMode);
}

export function resolveChannelDeliverySurfaceKind(
  target: ChannelDeliveryTarget,
): ChannelDeliverySurfaceKind | undefined {
  return target.surfaceKind ?? (target.kind === 'webhook' ? 'webhook' : undefined);
}

export function titleFromBody(body: string): string {
  const firstLine = body.split('\n').find((line) => line.trim().length > 0) ?? 'goodvibes automation';
  return firstLine.slice(0, 80);
}

export function success(responseId?: string): ChannelDeliveryResult {
  return responseId === undefined ? {} : { responseId };
}

function buildArtifactContentPath(artifactId: string): string {
  return `/api/artifacts/${encodeURIComponent(artifactId)}/content`;
}

function buildArtifactContentUrl(configManager: ConfigManager, artifactId: string): string | undefined {
  // The URL is posted INTO a chat message, so it is read off this host.
  const baseUrl = resolveReachableBaseUrl(configManager, 'off-host');
  if (!baseUrl) return undefined;
  return new URL(buildArtifactContentPath(artifactId), `${baseUrl}/`).toString();
}

export async function resolveAttachments(
  request: ChannelDeliveryRequest,
  artifactStore: ArtifactStore,
  configManager: ConfigManager,
  inlineLimitBytes?: number,
): Promise<ArtifactAttachment[]> {
  const references = request.attachments ?? [];
  const attachments: ArtifactAttachment[] = [];
  for (const reference of references) {
    attachments.push(await artifactStore.toAttachment(reference, {
      contentUrl: buildArtifactContentUrl(configManager, reference.artifactId),
      ...(typeof inlineLimitBytes === 'number' ? { includeBase64IfSmallerThan: inlineLimitBytes } : {}),
    }));
  }
  return attachments;
}

export function appendAttachmentSummary(body: string, attachments: readonly ArtifactAttachment[]): string {
  if (attachments.length === 0) return body;
  const lines = attachments.map((attachment) => {
    const target = attachment.contentUrl ?? attachment.contentPath;
    const name = attachment.filename ?? attachment.label ?? attachment.artifactId;
    return `- ${name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes): ${target}`;
  });
  return `${body.trimEnd()}\n\nAttachments:\n${lines.join('\n')}`;
}

export function trimForSurface(body: string, maxChars: number): string {
  const normalized = body.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function firstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

/** Resolve only the selected credential; a broken configured reference cannot switch accounts. */
export async function resolveDeliveryCredential(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'>,
  options: {
    readonly serviceName: string;
    readonly serviceField: ServiceSecretField;
    readonly configKey: ConfigKey;
    readonly serviceDefault?: (() => string | undefined) | undefined;
    readonly environmentValue: string | undefined;
  },
): Promise<string | undefined> {
  const registered = firstNonEmpty(await serviceRegistry.resolveSecret(options.serviceName, options.serviceField));
  if (registered) return registered;
  const serviceDefault = firstNonEmpty(options.serviceDefault?.());
  if (serviceDefault) return serviceDefault;
  const configured = configManager.get(options.configKey);
  if (configured !== undefined && configured !== null
    && (typeof configured !== 'string' || configured.trim().length > 0)) {
    const resolved = firstNonEmpty(await resolveSecretInput(configured, {
      diagnosticMode: 'structural',
      resolveLocalSecret: (key) => secretsManager.get(key),
      homeDirectory: secretsManager.getGlobalHome?.() ?? undefined,
      configKey: options.configKey,
    }));
    if (!resolved) throw new Error(`Could not resolve channel delivery credential for ${options.configKey}`);
    return resolved;
  }
  return firstNonEmpty(options.environmentValue);
}

const msTeamsTokenCache = new Map<string, { readonly token: string; readonly expiresAt: number }>();

export async function resolveMSTeamsAccessToken(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'>,
  lifetime: DeliveryLifetime = {},
): Promise<string> {
  const appId = firstNonEmpty(
    String(configManager.get('surfaces.msteams.appId') ?? ''),
    process.env.MSTEAMS_APP_ID,
  );
  const appPassword = await resolveDeliveryCredential(configManager, serviceRegistry, secretsManager, {
    serviceName: 'msteams',
    serviceField: 'password',
    configKey: 'surfaces.msteams.appPassword',
    environmentValue: process.env.MSTEAMS_APP_PASSWORD,
  });
  const tenantId = firstNonEmpty(
    String(configManager.get('surfaces.msteams.tenantId') ?? ''),
    process.env.MSTEAMS_TENANT_ID,
    'botframework.com',
  )!;
  if (!appId) throw new Error('Missing Microsoft Teams app id');
  if (!appPassword) throw new Error('Missing Microsoft Teams app password');
  const cacheKey = `${tenantId}:${appId}`;
  const cached = msTeamsTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: appId,
    client_secret: appPassword,
    scope: 'https://api.botframework.com/.default',
  });
  const response = await deliveryFetch(lifetime, `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const payload = await requireOkResponse('Microsoft Teams token request failed', response);
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  const token = typeof record?.access_token === 'string' ? record.access_token.trim() : '';
  const expiresIn = typeof record?.expires_in === 'number'
    ? record.expires_in
    : typeof record?.expires_in === 'string'
      ? Number(record.expires_in)
      : 300;
  if (!token) throw new Error('Microsoft Teams token request did not return an access token');
  msTeamsTokenCache.set(cacheKey, {
    token,
    expiresAt: Date.now() + Math.max(60, Number.isFinite(expiresIn) ? expiresIn : 300) * 1_000,
  });
  return token;
}

export function extractResponseId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const direct = record.id;
  if (typeof direct === 'string' && direct.trim().length > 0) return direct.trim();
  if (typeof direct === 'number' && Number.isFinite(direct)) return String(direct);
  const name = record.name;
  if (typeof name === 'string' && name.trim().length > 0) return name.trim();
  const messageId = record.message_id;
  if (typeof messageId === 'number' && Number.isFinite(messageId)) return String(messageId);
  if (typeof messageId === 'string' && messageId.trim().length > 0) return messageId.trim();
  const result = record.result;
  if (result && typeof result === 'object') return extractResponseId(result);
  return undefined;
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  try {
    const text = await response.text();
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

export async function requireOkResponse(label: string, response: Response): Promise<unknown> {
  const payload = await readResponsePayload(response);
  if (!response.ok) {
    const detail = typeof payload === 'string'
      ? payload
      : payload && typeof payload === 'object'
        ? JSON.stringify(payload)
        : '';
    throw new HttpStatusError(`${label} HTTP ${response.status}${detail ? `: ${detail}` : ''}`, { status: response.status });
  }
  return payload;
}

export async function postBridgePayload(
  bridgeUrl: string,
  payload: Record<string, unknown>,
  options: {
    readonly label: string;
    readonly token?: string | undefined;
    readonly lifetime?: DeliveryLifetime | undefined;
  },
): Promise<string | undefined> {
  const response = await deliveryFetch(options.lifetime ?? {}, bridgeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      'X-GoodVibes-Channel': String(payload.surface ?? 'bridge'),
    },
    body: JSON.stringify(payload),
  });
  const result = await requireOkResponse(options.label, response);
  return extractResponseId(result) ?? bridgeUrl;
}
