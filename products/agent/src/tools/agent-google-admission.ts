import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { secretReferenceFor, type ConfigManager, type SecretsManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS, clientCredentialsFromInput, readClientCredentialsFromJson } from '@goodvibes-jev/engine/sdk/platform/google';
import { assertCurrentToolEffect, assertProjectionExecution, commitCurrentToolSettingsPlan, ToolInputProjectionError,
  type ToolInputProjector, type ToolPreparedSettingsMutation } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { retainSurfaceMethods } from './agent-surface-effect.ts';

export interface GoogleAdmissionOwners {
  readonly configManager: ConfigManager;
  readonly secretsManager: SecretsManager;
}

export function retainGoogleConnectionOwners(owners: GoogleAdmissionOwners): () => void {
  const config = owners.configManager, secrets = owners.secretsManager;
  const configMethods = retainSurfaceMethods(config, ['getRaw', 'getConfigurationIncarnation']);
  const secretMethods = retainSurfaceMethods(secrets, ['get', 'resolveLocalCredentialSnapshot', 'getCredentialMutationState', 'captureLocalCredentialReadset']);
  const physicalCurrent = secrets.captureLocalCredentialReadset(), incarnation = config.getConfigurationIncarnation();
  const state = secrets.getCredentialMutationState();
  if (state.pending) throw new ToolInputProjectionError('held');
  const credentials = [GOOGLE_SECRET_KEYS.oauthClientSecret, GOOGLE_SECRET_KEYS.oauthRefreshToken].map(key => {
    const snapshot = secrets.resolveLocalCredentialSnapshot(key);
    if (snapshot.state === 'unsupported') throw new ToolInputProjectionError('held');
    return { key, revision: snapshot.revision };
  });
  return () => {
    configMethods(); secretMethods(); physicalCurrent();
    if (owners.configManager !== config || owners.secretsManager !== secrets || config.getConfigurationIncarnation() !== incarnation) throw new ToolInputProjectionError('stale');
    const latest = secrets.getCredentialMutationState();
    if (latest.pending || latest.generation !== state.generation) throw new ToolInputProjectionError('stale');
    for (const credential of credentials) {
      const snapshot = secrets.resolveLocalCredentialSnapshot(credential.key);
      if (snapshot.state === 'unsupported' || snapshot.revision !== credential.revision) throw new ToolInputProjectionError('stale');
    }
  };
}
export interface GooglePendingCredential {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly assertCurrent: () => void;
  refreshToken: string | null;
}
interface GoogleCapture {
  readonly action: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly pending?: GooglePendingCredential | undefined;
  readonly assertSourceCurrent: () => void;
  readonly assertCompletedCurrent: () => void;
  readonly mutation: ToolPreparedSettingsMutation;
  readonly projectedJson: string;
  spent: boolean;
}
const captures = new WeakMap<object, GoogleCapture>();
const effectSources = new WeakMap<object, { readonly argsJson: string; readonly assertCurrent: () => void }>();
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

function fileObservation(path: string): { readonly raw: string; readonly revision: string } {
  const target = realpathSync(path);
  const linkBefore = lstatSync(path, { bigint: true });
  const before = statSync(path, { bigint: true });
  const raw = readFileSync(path, 'utf8');
  const after = statSync(path, { bigint: true });
  const linkAfter = lstatSync(path, { bigint: true });
  const identity = (value: typeof before) => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');
  if (identity(before) !== identity(after) || identity(linkBefore) !== identity(linkAfter) || realpathSync(path) !== target) throw new ToolInputProjectionError('stale');
  return { raw, revision: createHash('sha256').update(target).update(identity(after)).update(identity(linkAfter)).update(raw).digest('hex') };
}

/** The registered owner prepares actual stores before any hosted reading. */
export function createGoogleSettingsProjector(owners: GoogleAdmissionOwners, pending: () => GooglePendingCredential | null): ToolInputProjector {
  const config = owners.configManager, secrets = owners.secretsManager;
  return { async project(request) {
    const action = text(request.args.action).toLowerCase();
    if (action === 'mail.send' || action === 'calendar.create') {
      request.assertCurrent(); request.signal?.throwIfAborted();
      const nativeCurrent = retainGoogleConnectionOwners(owners);
      const assertCurrent = () => { request.signal?.throwIfAborted(); nativeCurrent(); };
      const context = Object.freeze({}), argsJson = JSON.stringify(request.args);
      effectSources.set(context, { argsJson, assertCurrent });
      return { status: 'projected', args: request.args, executionContext: context, assertCurrent,
        assertRepairedArgs(next) { assertCurrent(); if (JSON.stringify(next) !== argsJson) throw new ToolInputProjectionError('binding-changed'); },
        async release() { effectSources.delete(context); },
      };
    }
    if (!['connect.client', 'connect.clientfile', 'connect.complete'].includes(action)) return { status: 'projected', args: request.args };
    request.assertCurrent(); request.signal?.throwIfAborted();
    const methods = retainSurfaceMethods(config, ['prepareSettingMutationPlan', 'inspectPreparedMutation', 'assertPreparedMutation', 'assertCompletedMutation', 'get', 'getConfigurationIncarnation']);
    const secretMethods = retainSurfaceMethods(secrets, ['prepareImport', 'inspectPreparedImport', 'assertPreparedImport', 'assertCompletedImport', 'resolveLocalCredentialSnapshot']);
    let clientId: string, clientSecret: string;
    let sourceCurrent: () => void;
    let credential: GooglePendingCredential | undefined;
    let importedSecret: { key: string; value: string; scope: 'daemon' } | undefined;
    if (action === 'connect.complete') {
      credential = pending() ?? undefined;
      if (!credential?.refreshToken) throw new ToolInputProjectionError('unavailable');
      credential.assertCurrent(); clientId = credential.clientId; clientSecret = credential.clientSecret;
      const retained = credential, token = credential.refreshToken;
      sourceCurrent = () => { if (pending() !== retained || retained.refreshToken !== token) throw new ToolInputProjectionError('stale'); };
      importedSecret = { key: GOOGLE_SECRET_KEYS.oauthRefreshToken, value: token, scope: 'daemon' };
    } else if (action === 'connect.clientfile') {
      const path = text(request.args.path); if (!path) throw new ToolInputProjectionError('invalid');
      const observation = fileObservation(path), parsed = readClientCredentialsFromJson(observation.raw);
      if (!parsed.ok) throw new ToolInputProjectionError('invalid');
      clientId = parsed.credentials.clientId; clientSecret = parsed.credentials.clientSecret;
      sourceCurrent = () => { if (fileObservation(path).revision !== observation.revision) throw new ToolInputProjectionError('stale'); };
      importedSecret = { key: GOOGLE_SECRET_KEYS.oauthClientSecret, value: clientSecret, scope: 'daemon' };
    } else {
      const reference = text(request.args.clientSecretRef) || secretReferenceFor(GOOGLE_SECRET_KEYS.oauthClientSecret);
      if (reference !== secretReferenceFor(GOOGLE_SECRET_KEYS.oauthClientSecret)) throw new ToolInputProjectionError('invalid');
      const observation = secrets.resolveLocalCredentialSnapshot(GOOGLE_SECRET_KEYS.oauthClientSecret);
      if (observation.state !== 'resolved') throw new ToolInputProjectionError('unconfigured');
      const parsed = clientCredentialsFromInput({ clientId: text(request.args.clientId), clientSecret: observation.value });
      if (!parsed.ok) throw new ToolInputProjectionError('invalid');
      clientId = parsed.credentials.clientId; clientSecret = parsed.credentials.clientSecret;
      sourceCurrent = () => {
        const latest = secrets.resolveLocalCredentialSnapshot(GOOGLE_SECRET_KEYS.oauthClientSecret);
        if (latest.state !== 'resolved' || latest.revision !== observation.revision || latest.value !== observation.value) throw new ToolInputProjectionError('stale');
      };
    }
    const assertSourceCurrent = () => {
      request.signal?.throwIfAborted(); methods(); secretMethods();
      if (owners.configManager !== config || owners.secretsManager !== secrets) throw new ToolInputProjectionError('stale');
      sourceCurrent();
    };
    assertSourceCurrent();
    const mutation = config.prepareSettingMutationPlan([
      { operation: 'set', key: GOOGLE_CONFIG_KEYS.oauthClientId, value: clientId },
      { operation: 'set', key: GOOGLE_CONFIG_KEYS.oauthClientSecretRef, value: secretReferenceFor(GOOGLE_SECRET_KEYS.oauthClientSecret) },
    ]);
    const secretImport = importedSecret ? { owner: secrets, mutation: secrets.prepareImport([importedSecret]) } : undefined;
    const plan: ToolPreparedSettingsMutation = { owner: config, mutation, ...(secretImport ? { secretImport } : {}), assertSourceCurrent };
    const facts = config.inspectPreparedMutation(mutation);
    const effect = { operation: 'set', key: GOOGLE_CONFIG_KEYS.oauthClientId, action, clientId,
      effects: facts.effects ?? [facts], ...(secretImport ? { credential: secrets.inspectPreparedImport(secretImport.mutation) } : {}),
      credentialConfigured: true };
    const projected = { ...request.args }; delete projected.clientSecret;
    const context = Object.freeze({});
    const assertCompletedCurrent = () => {
      assertSourceCurrent(); config.assertCompletedMutation(mutation);
      if (secretImport) secrets.assertCompletedImport(secretImport.mutation);
    };
    const capture: GoogleCapture = { action, clientId, clientSecret, pending: credential, assertSourceCurrent, assertCompletedCurrent, mutation: plan,
      projectedJson: JSON.stringify(projected), spent: false };
    const assertPrepared = () => {
      assertSourceCurrent(); if (capture.spent) throw new ToolInputProjectionError('stale');
      credential?.assertCurrent();
      config.assertPreparedMutation(mutation); if (secretImport) secrets.assertPreparedImport(secretImport.mutation);
    };
    assertPrepared(); captures.set(context, capture);
    return { status: 'projected', args: projected, executionContext: context, settingsMutation: plan,
      settingsAdmissionEvidence: { kind: 'agent-settings', operation: 'set', key: GOOGLE_CONFIG_KEYS.oauthClientId, effect,
        revision: createHash('sha256').update(JSON.stringify(effect)).digest('hex') },
      assertCurrent: assertPrepared,
      assertRepairedArgs(next) { assertPrepared(); if (JSON.stringify(next) !== capture.projectedJson) throw new ToolInputProjectionError('binding-changed'); },
      async release() { captures.delete(context); },
    };
  } };
}

/** This private source restriction cannot replace the original recorded send/write proof. */
export function retainGooglePreparedEffectSource(args: Record<string, unknown>, options: Parameters<Tool['execute']>[1]): () => void {
  const context = options?.inputProjectionContext, retained = context && effectSources.get(context);
  if (!context || !retained) throw new ToolInputProjectionError('held');
  const assertCurrent = () => {
    assertProjectionExecution(context, args);
    if (JSON.stringify(args) !== retained.argsJson) throw new ToolInputProjectionError('binding-changed');
    retained.assertCurrent();
  };
  assertCurrent(); return assertCurrent;
}

export async function commitGoogleSettings(args: Record<string, unknown>, options: Parameters<Tool['execute']>[1]) {
  const context = options?.inputProjectionContext, capture = context && captures.get(context);
  if (!context || !capture || !assertCurrentToolEffect(args, options, 'write')) throw new ToolInputProjectionError('held');
  assertProjectionExecution(context, args); capture.assertSourceCurrent();
  if (capture.spent || JSON.stringify(args) !== capture.projectedJson) throw new ToolInputProjectionError('stale');
  capture.spent = true;
  const receipt = await commitCurrentToolSettingsPlan(args, options);
  let sourceCurrent = true;
  if (receipt.status === 'committed') {
    try { capture.assertCompletedCurrent(); } catch { sourceCurrent = false; }
  }
  return { receipt, sourceCurrent, clientId: capture.clientId, clientSecret: capture.clientSecret, pending: capture.pending, action: capture.action };
}
