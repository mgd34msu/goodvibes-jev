/** Root-owned, least-capability mail and explicit tagging constructors. */
import { EmailService } from '@goodvibes-jev/engine/sdk/platform/email';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { OwnedInboxTagging } from '@goodvibes-jev/engine/sdk/platform/intake';
import { composeMailDeps } from './mail-composition.js';
import { createDaemonTriageTaggingFactory, type DaemonTriagePermissionHost, type DaemonTriageTaggingRequest } from './tagged-inbox-composition.js';
import type { SecretsManager } from '../config/secrets.js';
import type { DaemonInboxControls, DaemonInboxFactory } from './daemon-handler-composition.js';
import type { HandlerContext, OwnedHandlerSurface } from '../daemon/handlers/context.js';
import type { RoutingRegistration } from '../daemon/handlers/index.js';
import { acquireHostedInboxScreening, type HostedInboxScreeningHost, type HostedInboxScreeningAcquisition } from './hosted-source-screening-composition.js';

type MailInput = Omit<Parameters<typeof composeMailDeps>[0], 'registerDispose'> & {
  readonly configManager: Partial<Pick<ConfigManager, 'subscribe' | 'getIngestionQuarantine' | 'getConfigurationIncarnation'
    | 'captureDurableConfigurationIncarnation' | 'getDurableConfigurationIncarnation' | 'onDidChangeIncarnation'>>;
  readonly secretsManager: Parameters<typeof composeMailDeps>[0]['secretsManager'] & Partial<HostedInboxScreeningHost['secrets']>;
};

function hasHostedScreeningOwners(input: MailInput): input is MailInput & {
  configManager: HostedInboxScreeningHost['config']; secretsManager: HostedInboxScreeningHost['secrets'];
} {
  const { configManager: config, secretsManager: secrets } = input;
  return typeof config.get === 'function' && typeof config.getIngestionQuarantine === 'function'
    && typeof config.getConfigurationIncarnation === 'function' && typeof config.onDidChangeIncarnation === 'function'
    && typeof config.captureDurableConfigurationIncarnation === 'function' && typeof config.getDurableConfigurationIncarnation === 'function'
    && typeof config.onDidInvalidate === 'function' && typeof secrets.resolveLocalCredentialSnapshot === 'function'
    && typeof secrets.captureLocalCredentialReadset === 'function' && typeof secrets.getCredentialMutationState === 'function'
    && typeof secrets.onDidInvalidateCredentials === 'function';
}

/** Even a factory that throws after construction cannot orphan subscriptions. */
export async function registerOwnedMailInbox(factory: DaemonInboxFactory, context: HandlerContext,
  routing: RoutingRegistration, controls: Pick<DaemonInboxControls, 'gatePolling' | 'gatePollingOwned'>,
  mailInput: MailInput, triageHost?: DaemonTriagePermissionHost): Promise<OwnedHandlerSurface> {
  const mailClosers: Array<() => void> = [];
  const taggingOwners: OwnedInboxTagging[] = [];
  const screeningAcquisitions: HostedInboxScreeningAcquisition[] = [];
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  let retired = false, initialized = false, epoch = 0;
  const initialEpoch = epoch;
  const invalidate = () => {
    epoch++;
    for (const listener of [...listeners]) { try { listener(); } catch { /* One consumer cannot suppress another's invalidation. */ } }
  };
  const assertCurrent = () => {
    lifetime.signal.throwIfAborted();
    if (retired || (!initialized && epoch !== initialEpoch)) throw new Error('Inbox construction or lifecycle was revoked');
  };
  const credentialInvalidation = mailInput.secretsManager.onDidInvalidateCredentials?.bind(mailInput.secretsManager)
    ?? (mailInput.secretsManager.onDidChange ? (listener: () => void) => mailInput.secretsManager.onDidChange!(() => listener()) : undefined);
  const onAccountInvalidation = mailInput.configManager.onDidInvalidate && credentialInvalidation
    ? (listener: () => void): (() => void) => {
      if (retired) throw new Error('Inbox account lifecycle is retired');
      let stopConfig: (() => void) | undefined, stopSecrets: (() => void) | undefined;
      let closed = false;
      const close = () => { if (closed) return; closed = true; try { stopConfig?.(); } finally { stopSecrets?.(); } };
      mailClosers.push(close);
      try {
        stopConfig = mailInput.configManager.onDidInvalidate!(listener);
        stopSecrets = credentialInvalidation(listener);
        return close;
      } catch (error) { close(); throw error; }
    } : undefined;
  const subscribeConfig = mailInput.configManager.subscribe?.bind(mailInput.configManager);
  const closeMail = (): void => {
    if (retired) return;
    retired = true;
    const errors: unknown[] = [];
    for (const close of mailClosers.reverse()) { try { close(); } catch (error) { errors.push(error); } }
    listeners.clear();
    if (errors.length) throw new AggregateError(errors, 'Inbox mail lifetimes did not close cleanly');
  };
  const drainTagging = async () => {
    const results = await Promise.allSettled(taggingOwners.map(owner => owner.close()));
    if (results.some(result => result.status === 'rejected')) throw new Error('Inbox tagging did not drain; source dependencies retained');
  };
  const drainScreening = async () => {
    const results = await Promise.allSettled(screeningAcquisitions.map(owner => owner.close()));
    if (results.some(result => result.status === 'rejected')) throw new Error('Hosted inbox screening acquisition did not close cleanly');
  };
  try {
    // Subscribe before invoking the asynchronous source factory, closing startup ABA gaps.
    if (triageHost && mailInput.secretsManager.resolveLocalCredentialSnapshot && onAccountInvalidation) {
      mailClosers.push(mailInput.configManager.onDidInvalidate!(invalidate));
      mailClosers.push(mailInput.secretsManager.onDidChange!(invalidate));
    }
    const snapshot = mailInput.secretsManager.resolveLocalCredentialSnapshot;
    const createTagging = triageHost && snapshot && onAccountInvalidation ? createDaemonTriageTaggingFactory({
      host: { ...triageHost, signal: AbortSignal.any([triageHost.signal, lifetime.signal]) },
      secrets: { get: mailInput.secretsManager.get.bind(mailInput.secretsManager), resolveLocalCredentialSnapshot: snapshot.bind(mailInput.secretsManager) },
      onInvalidate(listener) { assertCurrent(); listeners.add(listener); return () => { listeners.delete(listener); }; }, assertCurrent,
    }) : undefined;
    const registration = await factory(context, routing, { ...controls,
      ...(hasHostedScreeningOwners(mailInput) ? { acquireHostedScreening: async (source, operation) => {
        assertCurrent();
        const acquisition = await acquireHostedInboxScreening({ config: mailInput.configManager, secrets: mailInput.secretsManager,
          signal: lifetime.signal }, source, operation);
        screeningAcquisitions.push(acquisition);
        try { assertCurrent(); acquisition.options.authority.assertCurrent(); }
        catch (error) { await acquisition.close(); throw error; }
        return acquisition;
      } } satisfies Pick<DaemonInboxControls, 'acquireHostedScreening'> : {}),
      ...(onAccountInvalidation ? { onAccountInvalidation } : {}),
      ...(subscribeConfig ? { onConfigurationChange: (key, listener) => {
        assertCurrent(); return subscribeConfig(key, listener);
      } } satisfies Pick<DaemonInboxControls, 'onConfigurationChange'> : {}),
      ...(createTagging ? { createTriageTagging(request: DaemonTriageTaggingRequest) {
        assertCurrent(); const owner = createTagging(request); taggingOwners.push(owner); return owner;
      } } : {}),
      createEmailService() {
        if (retired) throw new Error('Inbox mail constructor is retired');
        const disposers: Array<() => void> = [];
        let closed = false;
        const close = (): void => {
          if (closed) return;
          closed = true;
          const errors: unknown[] = [];
          for (const dispose of disposers.reverse()) { try { dispose(); } catch (error) { errors.push(error); } }
          if (errors.length) throw new AggregateError(errors, 'Inbox mail service did not close cleanly');
        };
        mailClosers.push(close);
        try {
          const { emailServiceDeps } = composeMailDeps({ ...mailInput, registerDispose: dispose => { disposers.push(dispose); } });
          return Object.freeze({ service: new EmailService(emailServiceDeps), close });
        } catch (error) { close(); throw error; }
      },
    });
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (closing) return closing;
      const deferred = Promise.withResolvers<void>(); closing = deferred.promise;
      lifetime.abort();
      void drainTagging().then(async () => {
        try { await registration.close(); } finally { try { await drainScreening(); } finally { closeMail(); } }
      }).then(deferred.resolve, deferred.reject);
      return closing;
    };
    const ready = Promise.resolve(registration.ready).then(() => {
      if (taggingOwners.length || screeningAcquisitions.length) assertCurrent();
      initialized = true;
    }).catch(async error => { await close(); throw error; });
    void ready.catch(() => {});
    return { ...(registration.ready === undefined ? {} : { ready }), close };
  } catch (error) {
    lifetime.abort();
    try { await drainTagging(); } finally { try { await drainScreening(); } finally { closeMail(); } }
    throw error;
  }
}
