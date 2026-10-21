import { createHash } from 'node:crypto';
import { hashState, type JsonValue } from '@goodvibes-jev/judgment';
import type { ContractView } from './types.js';
import type { FileChange } from './evidence.js';
import { commandObservation } from './command-observation.js';

type JsonObject = { [key: string]: JsonValue };
const object = (value: JsonValue | undefined): value is JsonObject => value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);
const metadata = (value: JsonValue): JsonValue => object(value) && value['operation'] === 'read-current-file'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'text')) : value;

/** Keep every returned-read field while naming repeated columns only once. */
function observationTable(value: JsonValue | undefined): JsonValue {
  if (!Array.isArray(value) || !value.length || !value.every(read => object(read)
    && typeof read['path'] === 'string' && Array.isArray(read['returnedRanges']) && typeof read['returnedLines'] === 'number')) return value ?? [];
  const table = { columns: ['path', 'returnedRanges', 'returnedLines', 'additionalFields'],
    rows: value.map(read => {
      const record = read as JsonObject;
      const rest = Object.fromEntries(Object.entries(record).filter(([key]) => !['path', 'returnedRanges', 'returnedLines'].includes(key)));
      return [record['path']!, record['returnedRanges']!, record['returnedLines']!, ...(Object.keys(rest).length ? [rest] : [])];
    }),
    meaning: 'Lossless rows of actual returned-read observations for this unit. Expand each row using columns; additionalFields, when present, preserves every other original field unchanged. An absent fourth column means no additional fields. Ranges and attribution are unchanged. A returned read is not semantic approval or test execution.' };
  return JSON.stringify(table).length < JSON.stringify(value).length ? table : value;
}

/** Root-to-unit links can reuse the identical criterion already supplied below. */
function criterionLinks(value: JsonValue, units: readonly JsonObject[]): JsonValue {
  if (!Array.isArray(value)) return value;
  const byId = new Map<string, JsonObject | null>();
  for (const unit of units) if (Array.isArray(unit['criteria'])) for (const criterion of unit['criteria']) {
    if (!object(criterion) || typeof criterion['id'] !== 'string') continue;
    const id = criterion['id'];
    if (!byId.has(id)) byId.set(id, criterion);
    else {
      const previous = byId.get(id);
      if (previous && hashState(previous) !== hashState(criterion)) byId.set(id, null);
    }
  }
  return value.map(row => !object(row) || !Array.isArray(row['servedBy']) ? row : { ...row,
    servedBy: row['servedBy'].map(criterion => {
      if (!object(criterion) || typeof criterion['id'] !== 'string') return criterion;
      const source = byId.get(criterion['id']);
      return source && hashState(source) === hashState(criterion) ? { criterionRef: criterion['id'] } : criterion;
    }) });
}

/** Historical command bodies stay addressable; current claims and failures keep
 * their full primary receipts in the review itself. */
function commandView(contract: Pick<ContractView, 'id' | 'units'>, value: JsonValue | undefined, text: string | undefined): JsonValue {
  if (text === undefined || !Array.isArray(value)) return value ?? [];
  const retained = new Map(contract.units.flatMap(unit => (unit.commandEvidence ?? []).map((receipt, index) => [
    hashState(commandObservation(receipt)),
    { storage: 'native-contract-store', contractId: contract.id, unitId: unit.id, field: 'commandEvidence', index },
  ] as const)));
  return value.map(receipt => {
    if (!object(receipt) || typeof receipt['callId'] !== 'string' || receipt['executionSucceeded'] !== true
      || receipt['exitCode'] !== 0 || receipt['success'] !== true || typeof receipt['command'] !== 'string'
      || typeof receipt['head'] !== 'string') return receipt;
    const id = receipt['callId'];
    if (new RegExp('(?<![\\w.-])' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-]|\\.[\\w-])').test(text)) return receipt;
    const bodySource = retained.get(hashState(receipt));
    if (!bodySource) return receipt;
    const { command, head, stderr, sourceCapture, ...identity } = receipt;
    return { ...identity, observationKind: 'retained-command-receipt-index',
      commandDigest: hashState(command), commandBytes: Buffer.byteLength(command),
      stdoutDigest: hashState(head), stdoutBytes: Buffer.byteLength(head),
      ...(typeof stderr === 'string' ? { stderrDigest: hashState(stderr), stderrBytes: Buffer.byteLength(stderr) } : {}),
      ...(sourceCapture === undefined ? {} : { sourceCapture: object(sourceCapture)
        ? Object.fromEntries(Object.entries(sourceCapture).filter(([key]) => key !== 'meaning')) : sourceCapture }), bodySource };
  });
}

/** Current artifact text comes from an actual current host read, or an admitted,
 * previously checked read matching its bytes. Exact diffs preserve other changes.
 * Scoped native receipts compose retained work; no root is auto-passed. */
export function finalAnswerEvidence(contract: Pick<ContractView, 'id' | 'ask' | 'units'>, evidence: JsonObject, summaries: JsonValue, changes: readonly FileChange[] = [], currentOutput?: string) {
  const host = evidence['orchestration'];
  if (!object(host) || !Array.isArray(host['currentFiles'])) return undefined;
  const files = host['currentFiles'].filter(object);
  if (!files.length || files.some(file => file['success'] !== true || typeof file['binary'] !== 'boolean')) return undefined;
  const artifacts: { path: string; sha256: string; sourceUnitId?: string; sourceCheckId?: string; content: string; decisionIds: string[]; sourceHostOperation?: JsonValue }[] = [];
  const currentChanges: { path: string; sha256: string; diff: string }[] = [];
  for (const file of files) {
    if (file['binary'] === true) continue;
    if (typeof file['path'] !== 'string' || typeof file['sha256'] !== 'string') return undefined;
    if (file['operation'] === 'read-current-file' && file['source'] === 'native-host-filesystem' && typeof file['text'] === 'string') {
      if (Buffer.byteLength(file['text']) !== file['bytes'] || createHash('sha256').update(file['text']).digest('hex') !== file['sha256']) return undefined;
      artifacts.push({ path: file['path'], sha256: file['sha256'], content: file['text'], decisionIds: [], sourceHostOperation: metadata(file) });
      continue;
    }
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
  const artifactPaths = new Set(files.flatMap(file => typeof file['path'] === 'string' ? [file['path']] : []));
  const units = Array.isArray(host['units']) ? host['units'].filter(object).map(unit => {
    const source = contract.units.find(source => source.id === unit['id']);
    const check = source?.checks.at(-1);
    const retainedResult = source?.role === 'research' && source.status === 'passed'
      && check?.result === 'pass' && check.decisionIds.length > 0
      && source.readEvidence?.some(read => read.contentKind !== 'declared-reference' && !artifactPaths.has(read.path))
      && unit['acceptedAnswerDigest'] === hashState(source.answer ?? '');
    return {
    id: unit['id'] ?? null, goal: unit['goal'] ?? null, status: unit['status'] ?? null,
    criteria: unit['criteria'] ?? null, latestCheck: unit['latestCheck'] ?? null,
    acceptedAnswerDigest: unit['acceptedAnswerDigest'] ?? null,
    ...(retainedResult ? { acceptedAnswer: source.answer ?? '' } : {}),
    acceptedAnswerSource: { storage: 'native-contract-store', contractId: host['contractId'] ?? null, unitId: unit['id'] ?? null, field: 'answer' },
    readObservations: observationTable(unit['readObservations']),
  }; }) : [];
  const view: JsonObject = {
    originalRequest: contract.ask,
    fullSourceEvidence: { digest: hashState(evidence), bytes: Buffer.byteLength(JSON.stringify(evidence)),
      meaning: 'Digest of the complete native evidence prepared for this decision before projection. Its source records remain in the owned contract, accepted unit answers and read observations, command/check records, task evidence and checked tree. The view below carries current primary artifacts/diffs, every scoped native criterion/check/read range, complete accepted research results with non-artifact source observations, referenced execution bodies, all failures and unknown child outcomes, and complete gates. Unreferenced successful command bodies remain available at their exact native storage references and are not execution proof for an unshown claim. Earlier verdicts establish only their checked scope. This digest grants no approval and does not replace judging every original root requirement.' },
    currentArtifacts: artifacts,
    currentTextualChanges: currentChanges,
    hostOperations: Array.isArray(evidence['hostOperations']) ? evidence['hostOperations'].map(metadata) : [],
    commands: commandView(contract, evidence['commands'], currentOutput === undefined ? undefined
      : currentOutput + '\n' + artifacts.map(artifact => artifact.content).join('\n')),
    commandEvidenceMeaning: 'A retained-command-receipt-index preserves an actual successful child execution identity whose id is not referenced by the current answer or artifacts. Its complete command/result remain unchanged at the exact bodySource, bound by the recorded digests. Capture identities retain their original digest/bytes. Indexed command bodies are not supplied here; metadata or previous acceptance cannot prove an unshown purpose or execution result. Referenced executions, failures, unknown child outcomes and receipts without an exact native source remain in full.',
    gates: evidence['gates'] ?? [],
    criteria: criterionLinks(object(summaries) ? summaries['checks'] ?? summaries : summaries, units),
    criteriaReferenceMeaning: 'A servedBy criterionRef resolves by exact id to orchestration.units[].criteria, including its complete literal text and recorded verdict. Only identical complete criterion values are referenced; conflicting or additional fields remain inline. All original root criteria remain separately supplied unchanged. These references are native evidence links, not new approval.',
    orchestration: { contractId: host['contractId'] ?? null, planChecks: host['planChecks'] ?? [],
      currentAnswerSource: host['currentAnswerSource'] ?? null,
      repairPlanAdmissions: host['repairPlanAdmissions'] ?? [], referenceOperations: host['referenceOperations'] ?? [],
      sourceReferenceComparisons: host['sourceReferenceComparisons'] ?? [], sourceJsonReferenceComparisons: host['sourceJsonReferenceComparisons'] ?? [],
      currentValidation: host['currentValidation'] ?? null, groups: host['groups'] ?? [], units,
      createdAt: host['createdAt'] ?? null, origin: host['origin'] ?? null,
      ownerPriorReads: host['ownerPriorReads'] ?? null,
      inputGeneration: host['inputGeneration'] ?? null, firstUnitStartedAt: host['firstUnitStartedAt'] ?? null,
      currentFiles: host['currentFiles'].map(metadata), privateArtifacts: host['privateArtifacts'] ?? [],
      historicalContextDigest: hashState({ historicalContext: host['continuationEvidence'] ?? null }),
      meaning: 'Current artifact contents are complete actual host filesystem reads bound to current byte size and SHA256, or retained successful worker reads matching that identity and their real passed native checks. A sourceHostOperation records a fresh host read for this review, never a worker inspection, execution or earlier acceptance. The native reviewer must judge those actual contents now. Current textual changes retain the exact native-collected diff already supplied in the original evidence beside fresh file identity; a diff does not establish unchanged whole-file contents or semantic approval. No textual change is omitted. Prior native checks establish only their checked scope; they do not approve this new answer or later changes. Every original requirement remains unchanged in the separate mandatory fulfillment check. Complete source records remain retained and digest-bound. Historical task progress and superseded answer drafts are not the current final answer.',
    },
  };
  return { evidence: view, artifacts };
}
