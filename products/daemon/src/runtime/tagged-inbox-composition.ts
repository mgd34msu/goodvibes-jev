/** Root-held credential and permission owners for explicit provider tag handles. */
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import type { PermissionManager } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { daemonSecretKeyFor } from '@goodvibes-jev/engine/sdk/platform/config';
import { createSurfaceEmailSecretReader } from '@goodvibes-jev/engine/sdk/platform/email';
import { createOwnedInboxTagging, createTriageTagger, type OwnedInboxTagging, type OwnedInboxSource, type TriageTaggerOptions } from '@goodvibes-jev/engine/sdk/platform/intake';
import type { DaemonInboxControls } from './daemon-handler-composition.js';
import type { InboxSurfaceRegistration } from '@goodvibes-jev/engine/sdk/platform/intake';
import type { SecretsManager } from '../config/secrets.js';
export interface DaemonTriagePermissionHost {
  readonly permissionManager: PermissionManager;
  readonly port: JudgmentPort;
  readonly signal: AbortSignal;
}
export interface DaemonTriageTaggingRequest {
  readonly source: OwnedInboxSource;
  readonly provider: 'slack' | 'discord' | 'email';
  readonly accountScopeId: string;
  readonly assertCurrent: () => void;
  readonly imap?: TriageTaggerOptions['imap'];
  readonly forumTagIds?: TriageTaggerOptions['forumTagIds'];
}
export interface DaemonTriageTaggingActivation {
  /** Explicit constructor-owned delivery of a capability, never a persisted switch. */
  readonly onReady: (owner: OwnedInboxTagging) => void;
}
export function createDaemonTriageTaggingFactory(input: {
  readonly host: DaemonTriagePermissionHost;
  readonly secrets: Pick<SecretsManager, 'get' | 'resolveLocalCredentialSnapshot'>;
  readonly onInvalidate: (listener: () => void) => () => void;
  readonly assertCurrent: () => void;
}, factories: { readonly createTagger?: typeof createTriageTagger } = {}) {
  const makeTagger = factories.createTagger ?? createTriageTagger;
  const get = input.secrets.get.bind(input.secrets);
  const snapshot = input.secrets.resolveLocalCredentialSnapshot.bind(input.secrets);
  const onInvalidate = input.onInvalidate, assertRoot = input.assertCurrent, host = Object.freeze({ ...input.host });
  const mail = createSurfaceEmailSecretReader({ get });
  return (request: DaemonTriageTaggingRequest): OwnedInboxTagging => {
    if (!['slack', 'discord', 'email'].includes(request.provider)) throw new Error('Triage requires a supported owned provider');
    const provider = request.provider, scope = request.accountScopeId, assertAccount = request.assertCurrent;
    const current = () => { host.signal.throwIfAborted(); assertRoot(); assertAccount(); };
    const credentialKey = provider === 'email' ? 'surfaces.email.password' : `surfaces.${provider}.botToken`;
    const keys = provider === 'email'
      ? [daemonSecretKeyFor('surfaces.email.password'), daemonSecretKeyFor('surfaces.email.imap.password')]
      : [daemonSecretKeyFor(credentialKey)];
    const resolve = () => provider === 'email' ? mail.get(keys[0]!) : get(keys[0]!);
    const tagger = makeTagger({ provider, accountScopeId: scope, signal: host.signal, assertCurrent: current, port: host.port,
      credentialKey, credentials: { resolveRef: async () => null, resolveConfigSecret: async key => key === credentialKey ? resolve() : null },
      ...(request.imap ? { imap: request.imap } : {}),
      ...(request.forumTagIds ? { forumTagIds: request.forumTagIds } : {}),
      captureCredential() {
        current();
        const observations: ReturnType<typeof snapshot>[] = [];
        let value: string | undefined;
        for (const key of keys) {
          const observation = snapshot(key); observations.push(observation);
          if (observation.state === 'unsupported') throw new Error('Triage local credential ownership unavailable');
          if (observation.state === 'resolved' && observation.value.length) { value = observation.value; break; }
        }
        if (!value) throw new Error('Triage local credential absent');
        return { value, assertCurrent() {
          current();
          for (let i = 0; i < observations.length; i++) {
            const before = observations[i]!, now = snapshot(keys[i]!);
            if (before.state === 'unsupported' || now.state === 'unsupported' || before.state !== now.state || before.revision !== now.revision
              || (before.state === 'resolved' && (now.state !== 'resolved' || before.value !== now.value))) throw new Error('Triage local credential changed');
          }
        } };
      },
    });
    const owner = createOwnedInboxTagging({ source: request.source, tagger, permissionManager: host.permissionManager, port: host.port, signal: host.signal, assertCurrent: current, onInvalidate });
    return { applyTags: owner.applyTags.bind(owner), async close() { await owner.close(); await tagger.close(); } };
  };
}

/** Deliver only a ready source's explicit handle; mutation drainage precedes source teardown. */
export async function attachDaemonInboxTagging<T extends InboxSurfaceRegistration>(
  source: T, activation: DaemonTriageTaggingActivation,
  controls: Pick<DaemonInboxControls, 'createTriageTagging'>,
  request: Omit<DaemonTriageTaggingRequest, 'source'>,
): Promise<T> {
  const onReady = activation.onReady;
  let tagging: OwnedInboxTagging;
  try {
    if (!controls.createTriageTagging || !('acquireRead' in source) || typeof source.acquireRead !== 'function'
      || !('providerIds' in source) || !Array.isArray(source.providerIds) || source.providerIds.length !== 1 || source.providerIds[0] !== request.provider) {
      throw new Error('Triage tagging requires one exact owned source');
    }
    tagging = controls.createTriageTagging({ ...request, source: source as T & OwnedInboxSource });
  } catch (error) { await source.close(); throw error; }
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    const deferred = Promise.withResolvers<void>(); closing = deferred.promise;
    // Publish close before callbacks can reenter. Failure retains the underlying source.
    try { void tagging.close().then(() => source.close()).then(deferred.resolve, deferred.reject); }
    catch (error) { deferred.reject(error); }
    return closing;
  };
  const ready = source.ready.then(() => {
    if (closing) throw new Error('Triage source retired before ready');
    request.assertCurrent();
    const returned: unknown = onReady(Object.freeze({ applyTags: tagging.applyTags.bind(tagging), close: tagging.close.bind(tagging) }));
    if (returned !== undefined) {
      if (returned && typeof returned === 'object' && 'then' in returned) void Promise.resolve(returned).catch(() => {});
      throw new Error('Triage onReady must synchronously receive ownership');
    }
  }).catch(async error => { await close(); throw error; });
  void ready.catch(() => {});
  return { ...source, ready, close, unregister() { void close().catch(() => {}); } };
}
