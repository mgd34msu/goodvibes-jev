/** Native private import ingress and independently recorded publication admission. */
import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { createSettingsImportPreconditionHandler, type SettingsImportPreconditionFacts, type SettingsImportPreconditionHandler } from '@goodvibes-jev/engine/daemon-sdk';
import type { ConfigManager, PreparedConfigMutation, PreparedConfigMutationTransition, PreparedConfigMutationReceipt } from '../../config/manager.js';
import type { SecretsManager, PreparedSecretImport, SecretImportEntry } from '../../config/secrets.js';
import { isDaemonOwnedConfigKey } from '../../config/config-ownership.js';
import { isSecretBearingConfigKey } from '../../config/secret-bearing-config-keys.js';
import { isSecretRefInput } from '../../config/secret-refs.js';
import { daemonSecretKeyFor } from '../../config/daemon-secret-keys.js';
import { captureOwnedJson, snapshotJudgmentInput } from '../../gate/judgment-input.js';
import { admitExternalRequest, type ExternalPermissionHost } from '../../permissions/external-request.js';
import { confirmFileDurable } from '../../utils/atomic-json-store.js';
import type { NativeExecutionAuthority, NativePairedSnapshot } from '../../security/http-auth.js';
import type { DaemonControlPlaneHelper, SettingsAdminAuthority } from '../control-plane.js';
import type { ServingSettingsAuthority } from './settings-precondition.js';

export interface ServingSettingsImportAuthority extends ServingSettingsAuthority {
  readonly captureNativeExecutionAuthority: (req: Request) => NativeExecutionAuthority | null;
  readonly extractAuthToken: DaemonControlPlaneHelper['extractAuthToken'];
  readonly requireAdmin: DaemonControlPlaneHelper['requireAdmin'];
}
export type ServingSettingsImportSecrets = Pick<SecretsManager, 'prepareImport' | 'inspectPreparedImport' | 'assertPreparedImport' | 'withPreparedImport' | 'assertCompletedImport'>;
interface Prepared {
  readonly config: PreparedConfigMutation;
  readonly facts: SettingsImportPreconditionFacts;
  readonly host: ExternalPermissionHost;
  readonly assertWorkspace: () => void;
  readonly secret?: { readonly owner: ServingSettingsImportSecrets; readonly handle: PreparedSecretImport; readonly methods: readonly unknown[] };
  transition?: PreparedConfigMutationTransition;
  finishSecret?: (assertCurrent: () => void) => PreparedConfigMutationReceipt;
  secretCompleted?: true;
  configCompleted?: true;
}
interface Authority {
  readonly admin: SettingsAdminAuthority;
  readonly native: NativeExecutionAuthority;
  readonly expected: NativePairedSnapshot;
  readonly token: string;
}
const SCOPE = 'write:config';
function allowed(snapshot: NativePairedSnapshot | null): snapshot is NativePairedSnapshot {
  return snapshot !== null && snapshot.kind === 'pairing-token' && (snapshot.scopes.includes('*') || snapshot.scopes.includes(SCOPE));
}
function assertPrivateValuesAbsent(value: unknown, values: readonly string[]): void {
  if (typeof value === 'string' && values.some(secret => value.includes(secret))) throw new Error('Native import private value in public facts');
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    assertPrivateValuesAbsent(key, values); assertPrivateValuesAbsent(child, values);
  }
}
function retainWorkspace(path: string | undefined): () => void {
  if (!path || !isAbsolute(path)) throw new Error('Native import workspace unavailable');
  const identity = (path: string) => {
    const link = lstatSync(path, { bigint: true }), target = statSync(path, { bigint: true });
    if (!target.isDirectory()) throw new Error('Native import workspace unavailable');
    return [realpathSync(path), link.dev, link.ino, target.dev, target.ino,
      ...(link.isSymbolicLink() ? [link.mtimeNs, link.ctimeNs] : [])].join(':');
  };
  const parents: { path: string; identity: string }[] = [];
  for (let current = path;;) {
    parents.push({ path: current, identity: identity(current) });
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  return () => { for (const parent of parents) if (identity(parent.path) !== parent.identity) throw new Error('Native import workspace changed'); };
}
export function createServingSettingsImportPrecondition(input: {
  readonly manager: ConfigManager;
  readonly authority: ServingSettingsImportAuthority;
  readonly secrets: () => ServingSettingsImportSecrets | null;
  readonly host: () => ExternalPermissionHost | undefined;
  readonly assertServingOwner: () => void;
}): SettingsImportPreconditionHandler {
  const { manager, authority } = input;
  const authorityMethods = [authority.settingsLifetime, authority.captureSettingsAdminAuthority, authority.withSettingsAdminAuthority,
    authority.captureNativeExecutionAuthority, authority.extractAuthToken, authority.requireAdmin];
  const configMethods = [manager.getSchema, manager.prepareSettingMutationPlan, manager.inspectPreparedMutation, manager.assertPreparedMutation,
    manager.protectPreparedMutationTargets, manager.beginPreparedMutation, manager.assertPreparedMutationTransition, manager.finishPreparedMutation, manager.assertCompletedMutation];
  const assertOwner = (prepared?: Prepared) => {
    input.assertServingOwner();
    if ([authority.settingsLifetime, authority.captureSettingsAdminAuthority, authority.withSettingsAdminAuthority,
      authority.captureNativeExecutionAuthority, authority.extractAuthToken, authority.requireAdmin].some((method, index) => method !== authorityMethods[index])
      || [manager.getSchema, manager.prepareSettingMutationPlan, manager.inspectPreparedMutation, manager.assertPreparedMutation,
        manager.protectPreparedMutationTargets, manager.beginPreparedMutation, manager.assertPreparedMutationTransition, manager.finishPreparedMutation, manager.assertCompletedMutation].some((method, index) => method !== configMethods[index])
      || prepared && input.host() !== prepared.host
      || prepared?.secret && (input.secrets() !== prepared.secret.owner || [prepared.secret.owner.prepareImport, prepared.secret.owner.inspectPreparedImport,
        prepared.secret.owner.assertPreparedImport, prepared.secret.owner.withPreparedImport, prepared.secret.owner.assertCompletedImport].some((method, index) => method !== prepared.secret!.methods[index]))) throw new Error('Native settings import owner changed');
  };
  const assertPrepared = (prepared: Prepared) => {
    prepared.host.signal.throwIfAborted();
    prepared.assertWorkspace();
    assertOwner(prepared); manager.assertSettingsWritable();
    if (prepared.configCompleted) manager.assertCompletedMutation(prepared.config);
    else if (prepared.transition) manager.assertPreparedMutationTransition(prepared.config, prepared.transition);
    else manager.assertPreparedMutation(prepared.config);
    if (prepared.secretCompleted && prepared.secret) prepared.secret.owner.assertCompletedImport(prepared.secret.handle);
    else if (prepared.secret && !prepared.finishSecret) prepared.secret.owner.assertPreparedImport(prepared.secret.handle);
  };
  const assertAuthority = (req: Request, captured: Authority) => {
    assertOwner(); req.signal.throwIfAborted();
    const current = captured.native.current();
    if (authority.extractAuthToken(req) !== captured.token || !allowed(current)
      || JSON.stringify(current) !== JSON.stringify(captured.expected)) throw new Error('Native settings import authority changed');
  };
  return createSettingsImportPreconditionHandler({
    lifetime: authority.settingsLifetime,
    captureAuthority(req): Authority | null {
      assertOwner();
      const admin = authority.captureSettingsAdminAuthority(req), native = authority.captureNativeExecutionAuthority(req), expected = native?.current();
      if (admin?.kind !== 'pairing-token' || !native || !expected || !allowed(expected) || authority.requireAdmin(req) !== null) return null;
      return Object.freeze({ admin, native, expected, token: authority.extractAuthToken(req) });
    },
    withAuthority(req, captured, operation) {
      assertAuthority(req, captured);
      return authority.withSettingsAdminAuthority(req, captured.admin, check => operation(() => { check(); assertAuthority(req, captured); }));
    },
    async admit(req, captured, prepared, assertBound, apply) {
      const host = input.host();
      if (!host || host.workspaceTrust === undefined) throw new Error('Native settings import admission unavailable');
      const signal = AbortSignal.any([host.signal, req.signal]);
      const current = () => {
        signal.throwIfAborted(); assertBound(); assertAuthority(req, captured); assertPrepared(prepared);
        if (input.host() !== host) throw new Error('Native settings import admission owner changed');
      };
      const source = Object.freeze({ goal: 'Import the complete authenticated settings plan into its selected native daemon owners.', criteria: Object.freeze([
        'Apply exactly every prepared setting and its derived daemon credential to the retained native destinations.',
        'Keep private credential values in native storage and honor current paired admin, write scope, workspace, privacy and permission constraints.',
        'This import does not authorize provider subscription storage, message delivery, purchases or additional settings.',
      ]) });
      current();
      // This is the safe complete owner descriptor. Never snapshot the private ingress body.
      const args = snapshotJudgmentInput({ method: 'settings.import', prepared: prepared.facts }, 'write') as Record<string, unknown>;
      const admission = await admitExternalRequest(host, { connectionId: randomUUID(), destination: 'settings.import', signal, assertCurrent: current },
        { sourceOf: () => source, signal, assertCurrent: current }, { tool: 'write', args,
          serverPolicy: { principalKind: 'paired-token', admin: true, scopes: [SCOPE], effect: 'write', method: 'settings.import' } });
      try {
        current();
        if (!admission.result.approved) throw new Error('Native settings import held');
        return await apply(() => { current(); admission.claim(); current(); }, current);
      } finally { admission.close(); }
    },
    owner: {
      prepare(request): Prepared {
        assertOwner();
        const host = input.host();
        if (!host || host.workspaceTrust === undefined) throw new Error('Native settings import admission unavailable');
        const assertWorkspace = retainWorkspace(host.workspaceRoot);
        const schema = manager.getSchema(), entries: SecretImportEntry[] = [];
        if (request.settings.length > schema.length || new Set(request.settings.map(entry => entry.key)).size !== request.settings.length) throw new Error('Native settings import invalid');
        const changes = request.settings.map(entry => {
          const setting = schema.find(setting => setting.key === entry.key);
          if (!setting || !isDaemonOwnedConfigKey(setting.key)) throw new Error('Native settings import invalid');
          let value = captureOwnedJson(entry.value);
          if (isSecretBearingConfigKey(setting.key)) {
            if (typeof value !== 'string') throw new Error('Native credential setting invalid');
            const normalized = value.trim(), key = daemonSecretKeyFor(setting.key);
            if (!normalized) { value = ''; entries.push({ key, scope: 'daemon', operation: 'delete' }); }
            else if (normalized.startsWith('goodvibes://secrets/') && isSecretRefInput(normalized)) value = normalized;
            else if (normalized.startsWith('goodvibes://')) throw new Error('Native credential reference invalid');
            else { entries.push({ key, scope: 'daemon', value }); value = `goodvibes://secrets/goodvibes/${key}`; }
          }
          // Undeclared inline credential/card material cannot cross even this private-to-public boundary.
          const safe = snapshotJudgmentInput({ operation: 'set', key: setting.key, value }, 'goodvibes_settings') as { value: unknown };
          return { operation: 'set' as const, key: setting.key, value: safe.value };
        });
        const config = manager.prepareSettingMutationPlan(changes);
        manager.protectPreparedMutationTargets(config);
        const configFacts = manager.inspectPreparedMutation(config);
        const secretOwner = input.secrets();
        if (entries.length && !secretOwner) throw new Error('Native credential owner unavailable');
        const secret = entries.length && secretOwner ? { owner: secretOwner, handle: secretOwner.prepareImport(entries), methods: [secretOwner.prepareImport,
          secretOwner.inspectPreparedImport, secretOwner.assertPreparedImport, secretOwner.withPreparedImport, secretOwner.assertCompletedImport] } : undefined;
        const credential = secret?.owner.inspectPreparedImport(secret.handle);
        const effects = (configFacts.effects ?? [configFacts]).map(effect => {
          if (effect.operation !== 'set') throw new Error('Native settings import invalid');
          return Object.freeze({ operation: 'set' as const, key: effect.key, value: effect.value, destinations: effect.destinations });
        });
        const facts: SettingsImportPreconditionFacts = Object.freeze({ operation: 'import', effects: Object.freeze(effects), incarnation: configFacts.incarnation,
          destinations: Object.freeze([...(credential?.destinations ?? []), ...configFacts.destinations]),
          ...(credential ? { credential: Object.freeze({ items: Object.freeze(credential.items.map(item => {
            if (item.scope !== 'daemon') throw new Error('Native credential scope invalid');
            return Object.freeze({ key: item.key, scope: item.scope, configured: item.configured });
          })), destinations: credential.destinations }) } : {}) });
        assertPrivateValuesAbsent(facts, entries.flatMap(entry => entry.operation !== 'delete' ? [entry.value] : []));
        snapshotJudgmentInput(facts, 'goodvibes_settings');
        const prepared = { config, facts, host, assertWorkspace, ...(secret ? { secret } : {}) }; assertPrepared(prepared); return prepared;
      },
      inspect: prepared => prepared.facts,
      assert: assertPrepared,
      async withPrepared(prepared, operation, current) {
        assertPrepared(prepared); current();
        if (!prepared.secret) return operation();
        return prepared.secret.owner.withPreparedImport(prepared.secret.handle, finish => {
          prepared.finishSecret = finish;
          try { current(); return operation(); } finally { delete prepared.finishSecret; }
        }, current);
      },
      begin(prepared) { const transition = manager.beginPreparedMutation(prepared.config); prepared.transition = transition; return transition; },
      assertTransition(prepared, transition) { assertOwner(prepared); manager.assertPreparedMutationTransition(prepared.config, transition); },
      finish(prepared, transition, assertCurrent) {
        const completedPaths: string[] = [];
        const current = () => { assertCurrent(); assertPrepared(prepared); };
        const confirm = (paths: readonly string[]): string | null => {
          for (const path of paths) {
            try { current(); confirmFileDurable(path); current(); }
            catch { return path; }
          }
          return null;
        };
        if (prepared.secret) {
          if (!prepared.finishSecret) throw new Error('Native credential publication unavailable');
          const receipt = prepared.finishSecret(current); completedPaths.push(...receipt.completedPaths);
          if (receipt.status !== 'committed') {
            const uncertainPath = receipt.uncertainPath ?? prepared.facts.effects[0]!.destinations[0]?.path;
            return Object.freeze({ ...receipt, ...(uncertainPath ? { uncertainPath } : {}) });
          }
          prepared.secretCompleted = true;
          const uncertainPath = confirm(receipt.completedPaths);
          if (uncertainPath !== null) return Object.freeze({ status: 'partial', completedPaths: Object.freeze(completedPaths), uncertainPath });
        }
        let receipt: PreparedConfigMutationReceipt;
        try { current(); receipt = manager.finishPreparedMutation(prepared.config, transition, current); }
        catch {
          const uncertainPath = prepared.facts.effects[0]!.destinations[0]?.path;
          return Object.freeze({ status: completedPaths.length ? 'partial' : 'unknown', completedPaths: Object.freeze(completedPaths), ...(uncertainPath ? { uncertainPath } : {}) });
        }
        completedPaths.push(...receipt.completedPaths);
        if (receipt.status !== 'committed') return Object.freeze({ ...receipt, status: completedPaths.length ? 'partial' : 'unknown', completedPaths: Object.freeze(completedPaths) });
        prepared.configCompleted = true;
        // Restriction-only completion handles retain the exact native results;
        // directory/file confirmation stays inside the original paired admin lease.
        const uncertainPath = confirm(receipt.completedPaths);
        if (uncertainPath !== null) return Object.freeze({ status: completedPaths.length ? 'partial' : 'unknown', completedPaths: Object.freeze(completedPaths), uncertainPath });
        let verifiedInOwningStore = false;
        try { assertOwner(prepared); manager.assertCompletedMutation(prepared.config); if (prepared.secret) prepared.secret.owner.assertCompletedImport(prepared.secret.handle); verifiedInOwningStore = true; }
        catch { /* The completed durable receipt survives a reporting failure. */ }
        return Object.freeze({ status: 'committed', completedPaths: Object.freeze(completedPaths), verifiedInOwningStore });
      },
    },
  });
}
