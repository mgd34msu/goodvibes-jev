/** Explicit single-account mail inbox; does not enable all-provider default serve. */
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createSurfaceEmailInboxConfigReader } from '@goodvibes-jev/engine/sdk/platform/email';
import { acquireCrossProcessLock } from '@goodvibes-jev/engine/sdk/platform/state/durable-file-io';
import { createEmailInboxOwner, registerInboxSurface,
  type EmailInboxAccount, type InboxSurfaceRegistration } from '@goodvibes-jev/engine/sdk/platform/intake';
import type { ProtectedSourceOwnerOptions } from '@goodvibes-jev/engine/sdk/platform/security';
import type { DaemonInboxFactory } from './daemon-handler-composition.js';

export interface EmailDaemonInboxOptions {
  /** Expected TLS endpoint/account/mailbox established by the trusted host. */
  readonly account: EmailInboxAccount;
  readonly screening: ProtectedSourceOwnerOptions;
}
export interface EmailDaemonInboxFactories {
  readonly createOwner?: typeof createEmailInboxOwner;
  readonly registerSurface?: typeof registerInboxSurface;
}

export function createEmailDaemonInboxFactory(options: EmailDaemonInboxOptions,
  factories: EmailDaemonInboxFactories = {}): DaemonInboxFactory {
  return async (context, _routing, controls) => {
    // The canonical daemon mailbox has no separate enable switch. Its shared
    // reader derives readiness from configured endpoint/account fields.
    const config: { get(key: string): unknown } = context.configManager;
    const mailConfig = createSurfaceEmailInboxConfigReader(key => config.get(key));
    const current = (): void => {
      if (context.configManager.get('cluster.enabled') !== false
        || mailConfig('email.enabled') !== true) throw new Error('Email inbox requires enabled single-node mode');
    };
    current();
    if (!controls.createEmailService) throw new Error('Email inbox requires the canonical owned mail-service constructor');
    const workingDirectory = await realpath(context.workingDirectory);
    current();
    const mail = controls.createEmailService();
    let owner: ReturnType<typeof createEmailInboxOwner> | undefined;
    let release: (() => void) | undefined;
    let surface: InboxSurfaceRegistration | undefined;
    try {
      owner = (factories.createOwner ?? createEmailInboxOwner)({ account: options.account, service: mail.service,
        screening: options.screening, assertCurrent: current,
        getCheckpoint: () => {
          if (!surface?.getImapCheckpoint) throw new Error('Email inbox checkpoint storage is unavailable');
          return surface.getImapCheckpoint('email');
        } });
      current();
      const storeFileName = `inbox-email-${owner.scopeId}.sqlite`;
      release = await acquireCrossProcessLock(join(workingDirectory, '.goodvibes', 'tui', 'operator', `${storeFileName}.owner.lock`),
        { strictOwnership: true, totalTimeoutMs: 100 });
      current();
      const selectedOwner = owner;
      surface = (factories.registerSurface ?? registerInboxSurface)({ ...context, workingDirectory }, {
        adapters: new Map([['email', selectedOwner.adapter]]), storeFileName,
        acquireReadLease: () => selectedOwner.acquireReadLease(),
        gatePolling: (_provider, control) => controls.gatePolling(`email:${selectedOwner.scopeId}`, control),
      });
    } catch {
      try { await owner?.close(); } finally { try { mail.close(); } finally { release?.(); } }
      throw new Error('Email inbox composition could not acquire its owned account and storage');
    }
    const registration = surface;
    const selectedOwner = owner;
    const unlock = release;
    let closing: Promise<void> | undefined;
    return {
      ready: registration.ready,
      close() {
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
      },
    };
  };
}
