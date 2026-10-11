/** Native consent and credential lifetime for the two explicitly approved hosted services. */
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { isSecretRefInput, normalizeSecretRef, type ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ProtectedSourceOwnerOptions } from '@goodvibes-jev/engine/sdk/platform/security';
import type { SecretsManager } from '../config/secrets.js';

export type HostedInboxScreeningSource = 'discord-bot-dms' | 'slack-inbox' | 'email-inbox';
export interface HostedInboxScreeningOperation {
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
}
export interface HostedInboxScreeningAcquisition {
  readonly options: ProtectedSourceOwnerOptions;
  close(): Promise<void>;
}
type ConfigOwner = Pick<ConfigManager, 'get' | 'getIngestionQuarantine' | 'getConfigurationIncarnation' | 'captureDurableConfigurationIncarnation'
  | 'getDurableConfigurationIncarnation' | 'onDidChangeIncarnation' | 'onDidInvalidate'>;
type CredentialOwner = Pick<SecretsManager, 'resolveLocalCredentialSnapshot' | 'captureLocalCredentialReadset' | 'getCredentialMutationState' | 'onDidInvalidateCredentials'>;
export interface HostedInboxScreeningHost {
  readonly config: ConfigOwner;
  readonly secrets: CredentialOwner;
  readonly signal: AbortSignal;
}

/** Values and alias revisions stay private; neither is an authority identifier. */
function captureCredential(key: string, secrets: CredentialOwner): { value: string; assertCurrent(): void } {
  const environment = process.env[key];
  let localKey = key;
  if (environment !== undefined) {
    const usableLiteral = environment.length > 0 && environment.trim() === environment && !/[\r\n\0]/.test(environment);
    if (!isSecretRefInput(environment)) {
      if (!usableLiteral) throw new Error('Hosted inbox screening credential is unavailable');
      return { value: environment, assertCurrent() {
        if (process.env[key] !== environment) throw new Error('Hosted inbox screening credential changed');
      } };
    }
    const reference = normalizeSecretRef(environment);
    if (!reference || reference.source !== 'goodvibes') throw new Error('Hosted inbox screening requires a native local credential');
    localKey = reference.id;
  }
  const snapshot = secrets.resolveLocalCredentialSnapshot(localKey);
  if (snapshot.state !== 'resolved' || !snapshot.value || snapshot.value.trim() !== snapshot.value
    || /[\r\n\0]/.test(snapshot.value)) throw new Error('Hosted inbox screening credential is unavailable');
  return { value: snapshot.value, assertCurrent() {
    if (process.env[key] !== environment) throw new Error('Hosted inbox screening credential changed');
    const next = secrets.resolveLocalCredentialSnapshot(localKey);
    if (next.state !== 'resolved' || next.revision !== snapshot.revision || next.value !== snapshot.value) {
      throw new Error('Hosted inbox screening credential changed');
    }
  } };
}

/** No network, global port, provider route inference or retention attestation is involved. */
export async function acquireHostedInboxScreening(host: HostedInboxScreeningHost,
  source: HostedInboxScreeningSource, operation: HostedInboxScreeningOperation): Promise<HostedInboxScreeningAcquisition> {
  if (!['discord-bot-dms', 'slack-inbox', 'email-inbox'].includes(source)) throw new Error('Hosted inbox screening source is unavailable');
  const { config, secrets } = host;
  const hostSignal = host.signal, operationSignal = operation.signal, accountCurrent = operation.assertCurrent;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([hostSignal, operationSignal, lifetime.signal]);
  const subscriptions: Array<() => void> = [];
  let closed = false;
  const retire = () => lifetime.abort();
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true; retire();
    const failures: unknown[] = [];
    for (const unsubscribe of subscriptions.reverse()) { try { unsubscribe(); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, 'Hosted inbox screening subscriptions did not close');
  };
  try {
    // Mutation onset is decisive, even if the write fails or restores the old bytes.
    subscriptions.push(config.onDidChangeIncarnation(retire));
    subscriptions.push(config.onDidInvalidate(retire));
    subscriptions.push(secrets.onDidInvalidateCredentials(retire));
    const incarnation = config.getConfigurationIncarnation();
    const assertCredentials = secrets.captureLocalCredentialReadset();
    const nativeMethods = [config.get, config.getIngestionQuarantine, config.getConfigurationIncarnation,
      config.captureDurableConfigurationIncarnation, config.getDurableConfigurationIncarnation,
      secrets.resolveLocalCredentialSnapshot, secrets.getCredentialMutationState, secrets.captureLocalCredentialReadset];
    let durableIncarnation: string | undefined;
    const assertNative = (): void => {
      signal.throwIfAborted();
      const quarantine = config.getIngestionQuarantine();
      const reader: { get(key: string): unknown } = config;
      if (closed || host.config !== config || host.secrets !== secrets || host.signal !== hostSignal
        || operation.signal !== operationSignal || operation.assertCurrent !== accountCurrent
        || config.getConfigurationIncarnation() !== incarnation || secrets.getCredentialMutationState().pending
        || nativeMethods.some((method, index) => method !== [config.get, config.getIngestionQuarantine,
          config.getConfigurationIncarnation, config.captureDurableConfigurationIncarnation, config.getDurableConfigurationIncarnation,
          secrets.resolveLocalCredentialSnapshot, secrets.getCredentialMutationState,
          secrets.captureLocalCredentialReadset][index])
        || (durableIncarnation !== undefined && config.getDurableConfigurationIncarnation() !== durableIncarnation)
        || reader.get('surfaces.hostedInboxScreening') !== 'abacus-typesafe-provider-managed'
        || quarantine.some(entry => entry.key === '(whole file)' || entry.key === 'surfaces'
          || entry.key === 'surfaces.hostedInboxScreening')) throw new Error('Hosted inbox screening consent or source changed');
      assertCredentials();
    };
    assertNative();
    durableIncarnation = config.captureDurableConfigurationIncarnation();
    assertNative();
    const abacus = captureCredential('ABACUSAI_API_KEY', secrets);
    const typesafe = captureCredential('TYPESAFE_API_KEY', secrets);
    const assertCurrent = (): void => {
      assertNative(); abacus.assertCurrent(); typesafe.assertCurrent();
      const result: unknown = accountCurrent();
      if (result !== undefined) {
        if (types.isPromise(result)) void result.catch(() => {});
        throw new Error('Hosted inbox screening requires synchronous account currentness');
      }
      assertNative(); abacus.assertCurrent(); typesafe.assertCurrent();
    };
    assertCurrent();
    const options: ProtectedSourceOwnerOptions = Object.freeze({ kind: 'hosted',
      authority: Object.freeze({ kind: 'hosted', ownerId: `daemon-inbox-${source}-${randomUUID()}`,
        revision: randomUUID(), retention: 'provider-managed-zero-retention-unverified', signal, assertCurrent }),
      credentials: Object.freeze({ abacusApiKey: abacus.value, typesafeApiKey: typesafe.value }),
    });
    return Object.freeze({ options, close });
  } catch (error) { await close(); throw error; }
}
