import { isSecretRefInput, isDaemonOwnedConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import { routeDaemonOwnedCredentialWrite } from './daemon-credential-routing.ts';
import { routeDaemonOwnedConfigWrite } from './daemon-config-routing.ts';
import type { ConfigKey } from './index.ts';
import type { SecretScope, SecretStorageMedium } from './secrets.ts';

export const SECRET_CONFIG_KEYS = new Set<ConfigKey>([
  // email section (app-layer extension, key is string-cast for ConfigKey compatibility)
  'email.passwordRef' as unknown as ConfigKey,
  // calendar OAuth advanced overrides, only the client SECRET is secret-backed; the
  // client id is not a secret (RFC 8252) and stays a plain config value.
  'calendar.google.clientSecretRef' as unknown as ConfigKey,
  'calendar.microsoft.clientSecretRef' as unknown as ConfigKey,
  'surfaces.slack.signingSecret',
  'surfaces.slack.botToken',
  'surfaces.slack.appToken',
  'surfaces.discord.botToken',
  'surfaces.ntfy.token',
  'surfaces.webhook.secret',
  'surfaces.telegram.botToken',
  'surfaces.telegram.webhookSecret',
  'surfaces.googleChat.verificationToken',
  'surfaces.signal.token',
  'surfaces.whatsapp.accessToken',
  'surfaces.whatsapp.verifyToken',
  'surfaces.whatsapp.signingSecret',
  'surfaces.imessage.token',
  'surfaces.msteams.appPassword',
  'surfaces.bluebubbles.password',
  'surfaces.mattermost.botToken',
  'surfaces.matrix.accessToken',
  // Card MATERIAL, the four fields entered through the concealed-input flow in
  // input/commands/payment-card-intake.ts. Synthetic sub-keys one level under
  // the SDK's real `payments` section (CONFIG_SCHEMA has no scalar entry for
  // them, hence the cast, the same situation as `email.passwordRef` above).
  // See input/payments-config.ts for why they are named flat
  // (`payments.cardNumber`, not `payments.card.number`).
  //
  // Membership here is what makes them masked at rest AND mid-edit in the
  // settings modal, and what routes a settings-modal edit through the
  // secret-manager path instead of writing plaintext into a config file.
  'payments.cardNumber' as ConfigKey,
  'payments.cardExpiry' as ConfigKey,
  'payments.cardCvv' as ConfigKey,
  'payments.cardholderName' as ConfigKey,
]);

export interface SecretBackedConfigUpdate {
  readonly configValue: string;
  readonly secretKey?: string;
  readonly secretValue?: string;
  readonly clearSecretKey?: string;
}

export interface SecretBackedConfigManager {
  readonly get: (key: ConfigKey) => unknown;
  readonly setDynamic: (key: ConfigKey, value: unknown) => void;
  readonly validateDynamic?: (key: ConfigKey, value: unknown) => void;
}

export interface SecretBackedSecretStore {
  readonly set: (key: string, value: string, options?: { readonly scope?: SecretScope; readonly medium?: SecretStorageMedium }) => Promise<void>;
  readonly delete?: (key: string, options?: { readonly scope?: SecretScope; readonly medium?: SecretStorageMedium }) => Promise<void>;
}

export function isSecretConfigKey(key: string): key is ConfigKey {
  return SECRET_CONFIG_KEYS.has(key as ConfigKey);
}

export function normalizeSecretKeyPart(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

export function buildGoodVibesSecretKey(configKey: string): string {
  return `GOODVIBES_${configKey.split('.').map(normalizeSecretKeyPart).filter(Boolean).join('_')}`;
}

export function buildGoodVibesSecretRef(secretKey: string): string {
  return `goodvibes://secrets/goodvibes/${encodeURIComponent(secretKey)}`;
}

export function isSecretReferenceValue(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith('goodvibes://secrets/') && isSecretRefInput(normalized);
}

export function isMalformedGoodVibesSecretReferenceValue(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith('goodvibes://') && !isSecretReferenceValue(normalized);
}

export function getSecretWriteMedium(policy: unknown): SecretStorageMedium {
  if (policy === 'plaintext_allowed') return 'plaintext';
  return 'secure';
}

export function buildSecretBackedConfigUpdate(configKey: ConfigKey, rawValue: string): SecretBackedConfigUpdate {
  const value = rawValue.trim();
  const secretKey = buildGoodVibesSecretKey(configKey);
  if (value.length === 0) {
    return {
      configValue: '',
      clearSecretKey: secretKey,
    };
  }
  if (isSecretReferenceValue(value)) {
    return { configValue: value };
  }
  return {
    configValue: buildGoodVibesSecretRef(secretKey),
    secretKey,
    secretValue: rawValue,
  };
}

/**
 * Where a secret-backed write lands when the caller did not name a scope.
 *
 * A daemon-owned config key (`surfaces.*`, `email.*`, `calendar.*`,
 * `payments.*`, ...) names a
 * credential the DAEMON executes with, not this interactive client, so its
 * secret material belongs in the daemon-scoped tier the daemon actually
 * reads, the same rule the SDK's config-ownership.ts already applies to the
 * `goodvibes://` reference that points at it.
 *
 * Defaulting these to 'user' (the historical behavior here) split the pair: the
 * reference landed in the daemon's own settings file, because ConfigManager
 * routes daemon-owned keys there, while the value it pointed at sat in a tier
 * the daemon never resolves. The surface reported success and the daemon found
 * nothing. That is the shape of the mail failure the owner hit, `/google adopt`
 * succeeded in the agent, and the daemon serving Telegram said no email
 * integration was available with the agent closed. For a payment card it is
 * the whole feature failing silently: the daemon is the process that completes
 * an unattended purchase, and it does so with every surface closed.
 */
export function defaultSecretBackedScope(configKey: ConfigKey): SecretScope {
  return isDaemonOwnedConfigKey(configKey) ? 'daemon' : 'user';
}

export async function persistSecretBackedConfigValue(
  configManager: SecretBackedConfigManager,
  secretsManager: SecretBackedSecretStore | null | undefined,
  configKey: ConfigKey,
  rawValue: string,
  options: { readonly scope?: SecretScope } = {},
): Promise<string> {
  const update = buildSecretBackedConfigUpdate(configKey, rawValue);
  // A credential the DAEMON executes with is written by the daemon, as one
  // verified pair: value first, read back, then the config reference. Doing
  // the two halves from here is what split the pair once the daemon became a
  // separate process. An unreachable daemon REJECTS, see
  // daemon-credential-routing.ts for why there is no local fallback.
  //
  // An explicit `scope` overrides this: a caller that names a tier is naming a
  // local tier deliberately (the payments containment tests do), and honouring
  // it keeps that an available, visible choice rather than a silent one.
  if (options.scope === undefined) {
    if (isSecretReferenceValue(update.configValue) && update.secretValue === undefined) {
      // An existing reference is only config, never credential material.
      // Keep it opaque and use the same connected owner as ordinary config
      // writes; credentials.set deliberately rejects references.
      const routed = await routeDaemonOwnedConfigWrite(configKey, update.configValue);
      if (routed === 'daemon') return update.configValue;
    } else {
      const routed = await routeDaemonOwnedCredentialWrite(configKey, rawValue);
      if (routed?.appliedBy === 'daemon') return update.configValue;
    }
  }
  const scope = options.scope ?? defaultSecretBackedScope(configKey);
  if (update.secretKey && !secretsManager) throw new Error('Credential storage is unavailable.');
  if (update.clearSecretKey && !secretsManager?.delete) throw new Error('Credential deletion is unavailable.');
  const medium = getSecretWriteMedium(configManager.get('storage.secretPolicy'));

  // Preflight without publishing a reference or modifying config. The final
  // setter rechecks admission after the wait; later I/O failure may leave a
  // stored value, but must never be reported as a completed config commit.
  configManager.validateDynamic?.(configKey, update.configValue);
  // Finish storage before publishing a reference that readers can resolve.
  if (update.secretKey && update.secretValue !== undefined && secretsManager) {
    await secretsManager.set(update.secretKey, update.secretValue, { scope, medium });
  }

  // Revocation includes material written under earlier storage policies.
  if (update.clearSecretKey && secretsManager?.delete) {
    await secretsManager.delete(update.clearSecretKey, { scope });
  }

  configManager.validateDynamic?.(configKey, update.configValue);
  configManager.setDynamic(configKey, update.configValue);
  return update.configValue;
}
