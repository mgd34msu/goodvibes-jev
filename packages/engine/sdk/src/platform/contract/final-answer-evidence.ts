import { createHash } from 'node:crypto';
import { hashState, type JsonValue } from '@goodvibes-jev/judgment';
import type { ContractView } from './types.js';
import type { FileChange } from './evidence.js';

type JsonObject = { [key: string]: JsonValue };
const object = (value: JsonValue | undefined): value is JsonObject => value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);

/** Current artifact text requires an admitted, previously checked read matching
 * current host-observed bytes. Exact native diffs preserve other changes.
 * Scoped native receipts compose retained work; no root is auto-passed. */
export function finalAnswerEvidence(contract: Pick<ContractView, 'ask' | 'units'>, evidence: JsonObject, summaries: JsonValue, changes: readonly FileChange[] = []) {
  const host = evidence['orchestration'];
  if (!object(host) || !Array.isArray(host['currentFiles'])) return undefined;
  const files = host['currentFiles'].filter(object);
  if (!files.length || files.some(file => file['success'] !== true || typeof file['binary'] !== 'boolean')) return undefined;
  const artifacts: { path: string; sha256: string; sourceUnitId: string; sourceCheckId: string; content: string; decisionIds: string[] }[] = [];
  const currentChanges: { path: string; sha256: string; diff: string }[] = [];
  for (const file of files) {
    if (file['binary'] === true) continue;
    if (typeof file['path'] !== 'string' || typeof file['sha256'] !== 'string') return undefined;
    let found: typeof artifacts[number] | undefined;
    for (const unit of [...contract.units].reverse()) {
      const check = unit.checks.at(-1);
      if (unit.status !== 'passed' || check?.result !== 'pass' || check.decisionIds.length === 0) continue;
      for (const read of unit.readEvidence ?? []) {
        if (read.contentKind !== 'declared-reference' || read.returnedContent === undefined
          || !(read.path === file['path'] || read.path.endsWith('/' + file['path']))) continue;
        const text = read.returnedContent.split('\n').map(line => line.replace(/^\s*\d+\s*\| ?/, '')).join('\n');
        if (![text, text + '\n', text.replace(/\n$/, '')].some(value => createHash('sha256').update(value).digest('hex') === file['sha256'])) continue;
        found = { path: file['path'], sha256: file['sha256'], sourceUnitId: unit.id,
          sourceCheckId: check.id, content: read.returnedContent, decisionIds: [...check.decisionIds] };
        break;
      }
      if (found) break;
    }
    // Keep the actual native diff when an auxiliary file was read without
    // retained full contents. Never omit a change or invent its current text.
    if (!found) {
      const change = changes.find(change => change.path === file['path'] && change.diff.trim().length > 0);
      if (!change || typeof evidence['diff'] !== 'string' || !evidence['diff'].includes(change.diff)) return undefined;
      currentChanges.push({ path: file['path'], sha256: file['sha256'], diff: change.diff });
      continue;
    }
    artifacts.push(found);
  }
  if (!artifacts.length && !currentChanges.length) return undefined;
  const units = Array.isArray(host['units']) ? host['units'].filter(object).map(unit => ({
    id: unit['id'] ?? null, goal: unit['goal'] ?? null, status: unit['status'] ?? null,
    criteria: unit['criteria'] ?? null, latestCheck: unit['latestCheck'] ?? null,
    acceptedAnswerDigest: unit['acceptedAnswerDigest'] ?? null,
    acceptedAnswerSource: { storage: 'native-contract-store', contractId: host['contractId'] ?? null, unitId: unit['id'] ?? null, field: 'answer' },
    readObservations: unit['readObservations'] ?? [],
  })) : [];
  const view: JsonObject = {
    originalRequest: contract.ask,
    fullSourceEvidence: { digest: hashState(evidence), bytes: Buffer.byteLength(JSON.stringify(evidence)),
      meaning: 'Digest of the complete native evidence prepared for this decision before projection. Its source records remain in the owned contract, accepted unit answers and read observations, command/check records, task evidence and checked tree. The view below carries current primary artifacts/diffs, every scoped native criterion/check/read range, and complete commands and gates. Earlier verdicts establish only their checked scope. This digest grants no approval and does not replace judging every original root requirement.' },
    currentArtifacts: artifacts,
    currentTextualChanges: currentChanges,
    hostOperations: evidence['hostOperations'] ?? [],
    commands: evidence['commands'] ?? [],
    gates: evidence['gates'] ?? [],
    criteria: object(summaries) ? summaries['checks'] ?? summaries : summaries,
    orchestration: { contractId: host['contractId'] ?? null, planChecks: host['planChecks'] ?? [],
      currentValidation: host['currentValidation'] ?? null, groups: host['groups'] ?? [], units,
      createdAt: host['createdAt'] ?? null, origin: host['origin'] ?? null,
      ownerPriorReads: host['ownerPriorReads'] ?? null,
      inputGeneration: host['inputGeneration'] ?? null, firstUnitStartedAt: host['firstUnitStartedAt'] ?? null,
      currentFiles: host['currentFiles'] ?? [], privateArtifacts: host['privateArtifacts'] ?? [],
      historicalContextDigest: hashState({ historicalContext: host['continuationEvidence'] ?? null }),
      meaning: 'Current artifact contents are actual successful returned reads bound to current file SHA256 and real passed native checks. Current textual changes retain the exact native-collected diff already supplied in the original evidence beside fresh file identity; a diff does not establish unchanged whole-file contents or semantic approval. No textual change is omitted. Prior native checks establish only their checked scope; they do not approve this new answer or later changes. Every original requirement remains unchanged in the separate mandatory fulfillment check. Complete source records remain retained and digest-bound. Historical task progress and superseded answer drafts are not the current final answer.',
    },
  };
  return { evidence: view, artifacts };
}
