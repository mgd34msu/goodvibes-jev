import { attachDaemonInboxTagging, type DaemonTriageTaggingActivation } from './tagged-inbox-composition.js';
import { createMultiOwnerDaemonInboxFactory } from './multiowner-inbox-composition.js';
import { createInboxRouteResolver } from '@goodvibes-jev/engine/sdk/platform/channels';
import type { ClusterClock } from '@goodvibes-jev/engine/sdk/platform/cluster';
import { ownInboxEligibility } from './inbox-eligibility.js';
/** Explicit single-account mail inbox; does not enable all-provider default serve. */
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createSurfaceEmailInboxConfigReader } from '@goodvibes-jev/engine/sdk/platform/email';
import { acquireCrossProcessLock } from '@goodvibes-jev/engine/sdk/platform/state/durable-file-io';
import { createEmailInboxOwner, registerInboxSurface, createOwnedInboxSource,
  type EmailInboxAccount, type EmailInboxOwner, type InboxSurfaceRegistration } from '@goodvibes-jev/engine/sdk/platform/intake';
import type { ProtectedSourceOwnerOptions } from '@goodvibes-jev/engine/sdk/platform/security';
import type { DaemonInboxSourceFactory } from './multiowner-inbox-composition.js';
import type { DaemonInboxFactory } from './daemon-handler-composition.js';

export interface EmailDaemonInboxOptions {
  readonly triageTagging?: DaemonTriageTaggingActivation;
  /** Expected TLS endpoint/account/mailbox established by the trusted host. */
  readonly account: EmailInboxAccount;
  readonly screening: ProtectedSourceOwnerOptions;
}
export interface EmailDaemonInboxFactories {
  readonly createOwner?: (...args: Parameters<typeof createEmailInboxOwner>) => EmailInboxOwner;
  readonly registerSurface?: typeof registerInboxSurface;
  /** Constructor-only deterministic clock, never decoded from configuration. */
  readonly eligibilityClock?: ClusterClock;
}

/** Independently owned email account, with no canonical method binding. */
export interface EmailDaemonInboxSourceFactories extends Omit<EmailDaemonInboxFactories, 'registerSurface'> {
  readonly createSource?: typeof createOwnedInboxSource;
}

export function createEmailDaemonInboxSourceFactory(options: EmailDaemonInboxOptions,
  factories: EmailDaemonInboxSourceFactories = {}): DaemonInboxSourceFactory {
  return createEmailAccountFactory(options, factories, factories.createSource ?? createOwnedInboxSource);
}

export function createEmailDaemonInboxFactory(options: EmailDaemonInboxOptions,
  factories: EmailDaemonInboxFactories = {}): DaemonInboxFactory {
  if (options.triageTagging) {
    if (factories.registerSurface) throw new Error('Triage tagging requires an owned source, not a legacy registrar');
    return createMultiOwnerDaemonInboxFactory([createEmailDaemonInboxSourceFactory(options, factories)]);
  }
  return createEmailAccountFactory(options, factories, factories.registerSurface ?? registerInboxSurface);
}

function createEmailAccountFactory<T extends InboxSurfaceRegistration>(options: EmailDaemonInboxOptions,
  factories: Pick<EmailDaemonInboxFactories, 'createOwner' | 'eligibilityClock'>,
  register: (context: Parameters<DaemonInboxFactory>[0], options: Parameters<typeof registerInboxSurface>[1]) => T,
): (...args: Parameters<DaemonInboxFactory>) => Promise<T> {
  const triageTagging = options.triageTagging ? Object.freeze({ onReady: options.triageTagging.onReady }) : undefined;
  if (triageTagging && typeof triageTagging.onReady !== 'function') throw new Error('Triage tagging requires an explicit owner callback');
  return async (context, routing, controls) => {
    if (triageTagging && (!controls.createTriageTagging || !controls.onAccountInvalidation)) throw new Error('Triage tagging requires the canonical daemon permission and credential owners');
    const resolveProfileId = routing.resolveProfileId.bind(routing);
    const resolveRouteId = createInboxRouteResolver({
      getProfileForChannel: resolveProfileId, resolveProfile: resolveProfileId,
    });
    // The canonical daemon mailbox has no separate enable switch. Its shared
    // reader derives readiness from configured endpoint/account fields.
    const config: { get(key: string): unknown } = context.configManager;
    const mailConfig = createSurfaceEmailInboxConfigReader(key => config.get(key));
    const clustered = context.configManager.get('cluster.enabled') === true;
    if (clustered && !controls.gatePollingOwned) throw new Error('Clustered inbox requires owned gate retirement');
    const current = (): void => {
      if ((context.configManager.get('cluster.enabled') === true) !== clustered
        || mailConfig('email.enabled') !== true) throw new Error('Email inbox requires enabled stable cluster mode');
    };
    current();
    if (!controls.createEmailService) throw new Error('Email inbox requires the canonical owned mail-service constructor');
    const workingDirectory = await realpath(context.workingDirectory);
    current();
    const mail = controls.createEmailService();
    let eligibility: ReturnType<typeof ownInboxEligibility> | undefined;
    let owner: EmailInboxOwner | undefined;
    let release: (() => void) | undefined;
    let surface: T | undefined;
    try {
      owner = (factories.createOwner ?? createEmailInboxOwner)({ account: options.account, service: mail.service,
        screening: options.screening, assertCurrent: current, resolveRouteId,
        getCheckpoint: () => {
          if (!surface?.getImapCheckpoint) throw new Error('Email inbox checkpoint storage is unavailable');
          return surface.getImapCheckpoint('email');
        } });
      if (clustered && typeof owner.verifyEligibility !== 'function') throw new Error('Clustered email inbox requires an eligible owner');
      current();
      const storeFileName = `inbox-email-${owner.scopeId}.sqlite`;
      release = await acquireCrossProcessLock(join(workingDirectory, '.goodvibes', 'tui', 'operator', `${storeFileName}.owner.lock`),
        { strictOwnership: true, totalTimeoutMs: 100 });
      current();
      const selectedOwner = owner;
      surface = register({ ...context, workingDirectory }, {
        adapters: new Map([['email', selectedOwner.adapter]]), storeFileName, ...(clustered ? { awaitInitialPoll: false } : {}),
        acquireReadLease: () => selectedOwner.acquireReadLease(),
        gatePolling: (_provider, control) => {
          if (!clustered) return controls.gatePolling(`email:${selectedOwner.scopeId}`, control);
          eligibility = ownInboxEligibility({ verify: async () => { await surface!.ready; return selectedOwner.verifyEligibility!(); }, control,
            ...(factories.eligibilityClock ? { clock: factories.eligibilityClock } : {}),
            register: gated => controls.gatePollingOwned!(`email:${selectedOwner.scopeId}`, gated),
          });
          return () => eligibility!.close();
        },
      });
    } catch {
      try { await Promise.all([owner?.close(), eligibility?.close()]); } finally { try { mail.close(); } finally { release?.(); } }
      throw new Error('Email inbox composition could not acquire its owned account and storage');
    }
    const registration = surface;
    const selectedOwner = owner;
    const unlock = release;
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (!closing) {
        closing = Promise.resolve().then(async () => {
          const results = await Promise.allSettled([registration.close(), selectedOwner.close()]);
          let mailFailure = false;
          try { mail.close(); } catch { mailFailure = true; }
          // Storage retirement failure retains the lifetime lease.
          if (results[0]!.status === 'fulfilled') unlock();
          if (mailFailure || results.some(result => result.status === 'rejected')) throw new Error('Email inbox composition did not close cleanly');
        });
      }
      return closing;
    };
    const result = {
      ...registration,
      unregister() { void close().catch(() => {}); },
      ready: Promise.all([registration.ready, eligibility?.ready]).then(() => {}),
      close,
    };
    return triageTagging ? attachDaemonInboxTagging(result, triageTagging, controls, {
      provider: 'email', accountScopeId: selectedOwner.scopeId, assertCurrent: current,
      imap: { host: selectedOwner.account.host, port: selectedOwner.account.port, user: selectedOwner.account.username, mailbox: selectedOwner.account.mailbox },
    }) : result;
  };
}
