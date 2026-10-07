import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireCrossProcessLock } from '@goodvibes-jev/engine/sdk/platform/state/durable-file-io';
import {
  createSlackInboxOwner, registerInboxSurface,
  type SlackInboxAccount, type InboxSurfaceRegistration,
} from '@goodvibes-jev/engine/sdk/platform/intake';
import type { ProtectedSourceOwnerOptions } from '@goodvibes-jev/engine/sdk/platform/security';
import type { DaemonInboxFactory } from './daemon-handler-composition.js';

export interface SlackDaemonInboxOptions {
  /** Explicit expected Slack workspace AND user/bot identity; not token-derived. */
  readonly account: SlackInboxAccount;
  /** Trusted established local-service authority, including live revocation. */
  readonly screening: ProtectedSourceOwnerOptions;
  readonly timeoutMs?: number;
}

/** In-process constructor capabilities; never sourced from CLI/config/message data. */
export interface SlackDaemonInboxFactories {
  readonly createOwner?: typeof createSlackInboxOwner;
  readonly registerSurface?: typeof registerInboxSurface;
}

/**
 * Real Slack-only composition for an explicitly configured single-node host.
 * This neither installs a global provider registry nor claims all-provider serve.
 */
export function createSlackDaemonInboxFactory(
  options: SlackDaemonInboxOptions,
  factories: SlackDaemonInboxFactories = {},
): DaemonInboxFactory {
  return async (context, _routing, controls) => {
    // Reject unsupported cluster mode before credentials, sockets or disk writes.
    if (context.configManager.get('cluster.enabled') !== false) throw new Error('Slack inbox composition requires single-node mode');
    if (context.configManager.get('surfaces.slack.enabled') !== true) throw new Error('Slack inbox composition requires Slack to be enabled');
    const expectedWorkspace = options.account.workspaceId;
    const account = Object.freeze({ workspaceId: expectedWorkspace, userId: options.account.userId });
    const current = (): void => {
      if (context.configManager.get('cluster.enabled') !== false
        || context.configManager.get('surfaces.slack.enabled') !== true
        || context.configManager.get('surfaces.slack.workspaceId') !== expectedWorkspace) {
        throw new Error('Slack inbox configuration scope changed');
      }
    };
    current();
    const workingDirectory = await realpath(context.workingDirectory);
    current();
    const owner = await (factories.createOwner ?? createSlackInboxOwner)(context, {
      account, screening: options.screening, assertCurrent: current,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    let release: (() => void) | undefined;
    let surface: InboxSurfaceRegistration | undefined;
    try {
      current();
      const storeFileName = `inbox-slack-${owner.scopeId}.sqlite`;
      release = await acquireCrossProcessLock(join(workingDirectory, '.goodvibes', 'tui', 'operator', `${storeFileName}.owner.lock`), {
        strictOwnership: true, totalTimeoutMs: 100,
      });
      current();
      surface = (factories.registerSurface ?? registerInboxSurface)({ ...context, workingDirectory }, {
        adapters: new Map([['slack', owner.adapter]]), storeFileName,
        assertReadCurrent: owner.assertReadCurrent,
        // Keep wire provider='slack'; only the owner/election discriminator is scoped.
        gatePolling: (_provider, control) => controls.gatePolling(`slack:${owner.scopeId}`, control),
      });
    } catch {
      try { await owner.close(); } finally { release?.(); }
      throw new Error('Slack inbox composition could not acquire its owned storage');
    }
    const registration = surface;
    const unlock = release;
    let closing: Promise<void> | undefined;
    return {
      ready: registration.ready,
      close() {
        if (!closing) {
          closing = Promise.resolve().then(async () => {
            const [store, provider] = await Promise.allSettled([registration.close(), owner.close()]);
            // Never release a store lease on a failed storage retirement.
            if (store.status === 'fulfilled') unlock();
            if (store.status === 'rejected' || provider.status === 'rejected') throw new Error('Slack inbox composition did not close cleanly');
          });
        }
        return closing;
      },
    };
  };
}
