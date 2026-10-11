/** Trusted legacy-import composition. Recorded decisions are evidence, never serialized capabilities. */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson, JudgmentError, type DecisionLog, type EntryType, type JudgmentPort } from '@goodvibes-jev/judgment';
import type { JevDecision } from '@goodvibes-jev/judgment/decisions';
import { decideAutonomous } from '../../gate/autonomous-decision.js';
import { captureLegacyImportAction } from './import-action-binding.js';
import { validateLegacyWorkLedgerManifest, type LegacyMigrationManifest } from './legacy-import.js';
import { workLedgerCommandSchema, WorkLedgerAccessError, type WorkLedgerAuthority, type WorkLedgerResult, type WorkLedgerRejection, type WorkLedgerService } from './types.js';
import type { NativeExecutionScopeOwner, NativePairedExecutionAuthority, NativePairedExecutionSnapshot } from './native-execution.js';

export const NATIVE_IMPORT_SCOPES = ['write:work-ledger-import', 'read:knowledge'] as const;
export const NATIVE_IMPORT_SITE = 'work-ledger.legacy-import';
export type NativeLegacyImportResult = WorkLedgerResult | { readonly kind: 'decision'; readonly decision: JevDecision };
export interface NativeLegacyImportDependencies {
  readonly hostId: string; readonly projectId: string; readonly projectRoot: string; readonly storeId: string;
  readonly service: WorkLedgerService; readonly authority: WorkLedgerAuthority;
  readonly scopes: NativeExecutionScopeOwner; readonly port: JudgmentPort; readonly decisionLog: Pick<DecisionLog, 'get'>;
  readonly readSource: (id: string) => { readonly source: unknown; readonly generation: string | null };
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/**
 * Lossless display of host protocol metadata. These fields are created by the
 * manifest/store owners, not an exemption for arbitrary source content. Raw
 * metadata, descriptions, links and original entity fragments stay untouched.
 * Exact original bytes remain in the action binding and committed manifest.
 */
export function legacyImportSemanticManifest(manifest: LegacyMigrationManifest) {
  const timestamp = (value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new JudgmentError('invalid-request', 'Invalid source store timestamp');
    // Group digits without rounding, Date range limits or fractional-ms loss.
    return { encoding: 'epoch-milliseconds-decimal', decimal: String(value).replace(/(\d{3})(?=\d)/g, '$1_') };
  };
  const digest = (value: string) => `sha256:${value.match(/.{4}/g)!.join('.')}`;
  return { ...manifest, hostId: /^[a-f0-9-]{36}$/i.test(manifest.hostId) ? manifest.hostId.replaceAll('-', '.') : manifest.hostId,
    digest: digest(manifest.digest), sources: manifest.sources.map(capture => ({
      ...capture, digest: digest(capture.digest), generation: digest(capture.generation), source: { ...capture.source,
        createdAt: timestamp(capture.source['createdAt']),
        updatedAt: timestamp(capture.source['updatedAt']),
      },
    })),
  };
}

class NativeImportPrecommitError extends JudgmentError {
  constructor(readonly code: WorkLedgerRejection, reason: string) { super('rejected', reason); }
}

const refusal = (code: WorkLedgerRejection, reason: string, revision: number | null = null): WorkLedgerResult => ({ kind: 'rejected', code, reason, revision });
function paired(authority: NativePairedExecutionAuthority): NativePairedExecutionSnapshot {
  const current = authority.current();
  if (!current || current.kind !== 'pairing-token' || current.principalId !== current.authorityId || current.authorityRevision !== current.tokenId
    || !NATIVE_IMPORT_SCOPES.every(scope => current.scopes.includes('*') || current.scopes.includes(scope))) throw new NativeImportPrecommitError('forbidden', 'Native import requires current paired authority and dedicated scopes');
  return Object.freeze({ ...current, scopes: Object.freeze([...current.scopes].sort()) });
}

export function createNativeLegacyImportHost(deps: NativeLegacyImportDependencies) {
  const projectRoot = realpathSync(deps.projectRoot), storeId = resolve(deps.storeId);
  const lifetime = new AbortController();
  let closed = false; let closing: Promise<void> | undefined;
  const deliveries = new Map<string, { commandJson: string; promise: Promise<NativeLegacyImportResult> }>();
  function run(input: unknown, authority: NativePairedExecutionAuthority, options: { readonly signal?: AbortSignal | undefined; readonly isAuthorized: () => boolean }): Promise<NativeLegacyImportResult> {
    if (closed) return Promise.resolve(refusal('closed', 'Native import host is closed.'));
    const command = workLedgerCommandSchema.parse(input);
    if (command.type !== 'import_legacy') throw new JudgmentError('invalid-request', 'Expected an exact legacy import command');
    command.manifest = validateLegacyWorkLedgerManifest(command.manifest);
    const expected = paired(authority);
    const action = captureLegacyImportAction({ storeId, projectId: deps.projectId, principalKind: expected.kind, principalId: expected.principalId, command });
    const prior = deliveries.get(action.requestKey);
    if (prior) return prior.commandJson === action.commandJson ? prior.promise
      : Promise.resolve(refusal('request_conflict', 'Original request is already processing a different command.'));
    const promise = Promise.resolve().then(async (): Promise<NativeLegacyImportResult> => {
      const actor = deps.authority.issueActor({ projectId: deps.projectId, role: 'coordinator',
        actorId: `host:legacy-import:${hash(['token', expected.principalId])}` });
      const signal = options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal;
      let submitted = false;
      const authorized = () => !closed && options.isAuthorized() && JSON.stringify(paired(authority)) === JSON.stringify(expected);
      try {
        if (!authorized()) return refusal('forbidden', 'Native import authority changed.');
        // Durable receipt first: source, ledger revision, process host ID and Jev availability may all have changed.
        const replay = await deps.service.lookupLegacyImport(command, actor);
        if (!authorized()) return refusal('forbidden', 'Native import authority changed.');
        if (replay) return replay;
        if (signal.aborted) return refusal('cancelled', 'Import was cancelled before admission.');
        if (command.manifest.hostId !== deps.hostId || command.manifest.projectId !== deps.projectId) return refusal('conflict', 'Selected host or project changed.');
        const scope = deps.scopes.currentScope(projectRoot);
        const snapshot = await deps.service.readSnapshot(actor);
        if (snapshot.revision !== command.expectedRevision) return refusal('conflict', 'Aggregate ledger revision changed.', snapshot.revision);
        const assertCurrent = () => {
          if (closed) throw new NativeImportPrecommitError('closed', 'Native import host is closed.');
          if (signal.aborted) throw new NativeImportPrecommitError('cancelled', 'Import was cancelled before admission.');
          if (!authorized()) throw new NativeImportPrecommitError('forbidden', 'Native import authority changed.');
          if (realpathSync(deps.projectRoot) !== projectRoot || scope.root !== projectRoot) throw new NativeImportPrecommitError('conflict', 'Native import workspace changed.');
          const currentScope = deps.scopes.currentScope(projectRoot);
          if (currentScope.scopeId !== scope.scopeId || currentScope.scopeRevision !== scope.scopeRevision || currentScope.root !== scope.root) throw new NativeImportPrecommitError('conflict', 'Native import workspace registration changed.');
          const sources = command.manifest.sources.map((capture): { source: unknown; generation: string | null; digest: string } => {
            const current = deps.readSource(String(capture.source.id));
            // Rebuild the canonical manifest envelope, not the store snapshot envelope.
            // The complete-row generation still binds every persisted source byte.
            return { source: current.source, generation: current.generation, digest: capture.digest };
          });
          try { validateLegacyWorkLedgerManifest({ ...command.manifest, sources }); }
          catch { throw new NativeImportPrecommitError('stale_source', 'Complete persisted import sources changed.'); }
        };
        assertCurrent();
        const binding = { sourceId: hash({ storeId, projectId: deps.projectId, sources: command.manifest.sources.map(source => source.source.id) }),
          inputRevision: command.manifest.digest, actionId: action.actionId, actionRevision: hash(action.commandJson),
          authorityId: hash({ pairedPrincipal: expected.authorityId }), authorityRevision: hash({ pairedIncarnation: expected.authorityRevision }),
          scopeId: hash({ workspaceScope: scope.scopeId }), scopeRevision: hash({ workspaceGeneration: scope.scopeRevision }) };
        const result = await decideAutonomous({ port: deps.port, site: NATIVE_IMPORT_SITE,
          instructions: 'Decide whether this exact bounded historical import is supported by the complete captured source records. Imported work starts unverified and unclaimed; historical statuses, execution approvals and artifacts grant no native execution, completion, or verification authority. Preserve exact goals, criteria, provenance, project and ledger revision. Act only on the offered import. Reject if unsupported. No human approval or client decision can authorize this operation.',
          actionDescription: 'Atomically import exactly this captured legacy manifest into the selected native project ledger.', binding,
          state: { manifest: legacyImportSemanticManifest(command.manifest), expectedLedgerRevision: command.expectedRevision, existingWorkIds: snapshot.works.map(view => view.work.id) } as unknown as EntryType,
          evidence: [{ id: 'complete-import-manifest', revision: command.manifest.digest }, { id: 'native-ledger', revision: String(snapshot.revision) }],
          continuations: [], conditions: [], allowAct: true, assertCurrent, signal });
        const assertRecorded = (claimed: boolean) => {
          result.assertCurrent();
          for (const id of result.decision.judgmentDecisionIds) {
            const entry = deps.decisionLog.get(id);
            if (!entry || entry.status !== 'answered' || entry.context.site !== NATIVE_IMPORT_SITE
              || !entry.notes.some(note => note.kind === 'action' && note.action === `autonomous:${claimed ? 'claim' : result.decision.outcome}:${result.decision.decisionId}`)
              || !entry.notes.some(note => note.kind === 'readings' && note.readings !== null && typeof note.readings === 'object' && !Array.isArray(note.readings)
                && canonicalJson(note.readings['autonomousDecision']) === canonicalJson(result.decision as unknown as EntryType))) throw new JudgmentError('unrecorded', 'Native import requires actual recorded decision lineage');
          }
        };
        assertRecorded(false);
        if (result.decision.outcome !== 'act') return { kind: 'decision', decision: result.decision };
        return await authority.withCurrent(expected, async assertAuthority => deps.scopes.withCurrentScope(scope, async assertScope => {
          submitted = true;
          return deps.service.execute(command, actor, { signal, isAuthorized: () => { try { assertAuthority(); assertScope(); return authorized(); } catch { return false; } },
            assertImportAdmission: () => { assertAuthority(); assertScope(); assertRecorded(false); result.recordClaim(); assertRecorded(true); },
          });
        }));
      } catch (error) {
        // Only this call's proven pre-execution boundaries settle as rejection.
        // A failure after execute starts can hide a durable commit and must not.
        if (!submitted) {
          if (error instanceof NativeImportPrecommitError) return refusal(error.code, error.message);
          if (signal.aborted && (error === signal.reason || error instanceof JudgmentError && error.kind === 'aborted')) {
            return closed ? refusal('closed', 'Native import host is closed.') : refusal('cancelled', 'Import was cancelled before admission.');
          }
          if (error instanceof WorkLedgerAccessError && (error.code === 'closed' || error.code === 'forbidden')) return refusal(error.code, error.message);
        }
        throw error;
      } finally { deps.authority.revokeActor(actor); }
    });
    deliveries.set(action.requestKey, { commandJson: action.commandJson, promise });
    void promise.then(() => deliveries.delete(action.requestKey), () => deliveries.delete(action.requestKey));
    return promise;
  }
  return { run, close(): Promise<void> {
    if (closing) return closing;
    closed = true; lifetime.abort();
    return closing = Promise.allSettled([...deliveries.values()].map(item => item.promise)).then(() => {});
  } };
}
