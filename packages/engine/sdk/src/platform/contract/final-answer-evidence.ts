import { createHash } from 'node:crypto';
import { hashState, type JsonValue } from '@goodvibes-jev/judgment';
import type { ContractView } from './types.js';

type JsonObject = { [key: string]: JsonValue };
const object = (value: JsonValue | undefined): value is JsonObject => value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);

/** A content review may use current artifact text only when an admitted,
 * previously checked read exactly matches the current host-observed bytes.
 * The separate original fulfillment check keeps its full evidence unchanged. */
export function finalAnswerEvidence(contract: Pick<ContractView, 'ask' | 'units'>, evidence: JsonObject, summaries: JsonValue) {
  const host = evidence['orchestration'];
  if (!object(host) || !Array.isArray(host['currentFiles'])) return undefined;
  const files = host['currentFiles'].filter(object);
  if (!files.length || files.some(file => file['success'] !== true || typeof file['binary'] !== 'boolean')) return undefined;
  const artifacts: { path: string; sha256: string; sourceUnitId: string; sourceCheckId: string; content: string; decisionIds: string[] }[] = [];
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
    // Never replace primary change evidence with missing or stale artifact text.
    if (!found) return undefined;
    artifacts.push(found);
  }
  if (!artifacts.length) return undefined;
  const units = Array.isArray(host['units']) ? host['units'].filter(object).map(unit => ({
    id: unit['id'] ?? null, goal: unit['goal'] ?? null, status: unit['status'] ?? null,
    criteria: unit['criteria'] ?? null, latestCheck: unit['latestCheck'] ?? null,
    acceptedAnswerDigest: unit['acceptedAnswerDigest'] ?? null,
    readObservations: Array.isArray(unit['readObservations']) ? unit['readObservations'].filter(object).map(read => ({
      path: read['path'] ?? null, returnedRanges: read['returnedRanges'] ?? null, returnedLines: read['returnedLines'] ?? null,
    })) : [],
  })) : [];
  const view: JsonObject = {
    originalRequest: contract.ask,
    ownerPriorReads: host['ownerPriorReads'] ?? null,
    currentArtifacts: artifacts,
    hostOperations: evidence['hostOperations'] ?? [],
    commands: evidence['commands'] ?? [],
    gates: evidence['gates'] ?? [],
    criteria: object(summaries) ? summaries['checks'] ?? summaries : summaries,
    orchestration: { contractId: host['contractId'] ?? null, planChecks: host['planChecks'] ?? [],
      currentValidation: host['currentValidation'] ?? null, groups: host['groups'] ?? [], units,
      historicalContextDigest: hashState({ historicalContext: host['continuationEvidence'] ?? null }),
      meaning: 'Current artifact contents are actual successful returned reads bound to current file SHA256 and real passed native checks. Prior native checks establish only their checked scope; they do not approve this new answer or later changes. Original requirements remain unchanged in the mandatory separate fulfillment check. Historical task progress and superseded answer drafts remain durably saved; they are not the current final answer.',
    },
  };
  return { evidence: view, artifacts };
}
