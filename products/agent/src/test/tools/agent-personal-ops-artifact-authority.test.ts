import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { PermissionMode } from '@goodvibes-jev/engine/sdk/platform/config';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { CommandContext } from '../../input/command-registry.ts';
import { savePersonalOpsReviewArtifact } from '../../tools/agent-harness-personal-ops-runner.ts';
import type { PersonalOpsLane, PersonalOpsLiveRecord } from '../../tools/agent-harness-personal-ops-types.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { recordedEffectFixture } from '../helpers/recorded-effect-admission.ts';

const lane: PersonalOpsLane = { id: 'inbox', label: 'Inbox', status: 'ready', outcome: 'Review', current: 'Review', next: 'Inspect', userRoute: 'Personal Ops', modelRoute: 'personal_ops', signals: [] };
const sourceRecord: PersonalOpsLiveRecord = { id: 'inbox-read', label: 'Read inbox', status: 'ready', summary: 'Read selected items', userRoute: 'Personal Ops', modelRoute: 'inbox-read' };
const roots: string[] = [];
let previous: ReturnType<typeof installJudgmentPort>;
let decisions: SqliteDecisionLog;
let onPrivacyRead: (() => void) | undefined;

beforeEach(() => {
  decisions = new SqliteDecisionLog(':memory:');
  const answers = fakePort((name, question) => {
    if (question.type === 'choice') {
      const value = name === 'disposition' ? 'act' : name === 'kind' ? 'read' : name === 'family' || name === 'capability' ? 'generic' : undefined;
      if (value === undefined || !Object.hasOwn(question.criteria, value)) throw new Error(`Unexpected synthetic choice ${name}`);
      return choiceAnswer(question, value, 0.999);
    }
    if (question.type === 'noul') {
      if (name === 'lineHasCredential') onPrivacyRead?.();
      return noulAnswer(0.001);
    }
    throw new Error(`Unexpected synthetic question ${name}`);
  });
  previous = installJudgmentPort(withDecisionLog(answers.port, decisions));
});
afterEach(() => {
  onPrivacyRead = undefined; installJudgmentPort(previous); decisions[Symbol.dispose]();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(mode: PermissionMode = 'prompt', configure?: (store: ArtifactStore) => void) {
  const root = makeProjectTempDir('personal-ops-artifact-authority'); roots.push(root);
  const store = new ArtifactStore({ rootDir: join(root, 'artifacts') }); configure?.(store);
  const context = { platform: { artifactStore: store } } as unknown as CommandContext;
  const output = { preview: 'A reviewed inbox result', truncated: false };
  let inBody = false;
  let retained: { args: Record<string, unknown>; options: Parameters<Tool['execute']>[1] } | undefined;
  const admitted = recordedEffectFixture({
    definition: { name: 'review_artifact_write', description: 'Save isolated authored review cards.', sideEffects: ['state'], parameters: { type: 'object', properties: {}, additionalProperties: true } },
    async execute(args, options) {
      inBody = true; retained = { args, options };
      const saved = await savePersonalOpsReviewArtifact({ context, lane, sourceRecord, inputFields: { query: 'review' }, reviewRecords: [], output, invocationArgs: args, executionOptions: options });
      return { success: true, output: JSON.stringify(saved) };
    },
  }, mode, {}, root);
  const afterBodyStarts = (callback: () => void) => {
    let done = false;
    onPrivacyRead = () => { if (inBody && !done) { done = true; callback(); } };
  };
  return { root, store, context, output, admitted, afterBodyStarts, savedInvocation: () => retained };
}

test('caller flags and a fabricated callback cannot publish review cards', async () => {
  const f = fixture();
  await expect(savePersonalOpsReviewArtifact({ context: f.context, lane, sourceRecord, inputFields: {}, reviewRecords: [], output: f.output,
    invocationArgs: { confirm: true, explicitUserRequest: 'Caller annotation' }, executionOptions: { assertCurrent() {} }, assertCurrent() {} })).rejects.toThrow(ToolInputProjectionError);
  expect(f.store.list()).toHaveLength(0); expect(readdirSync(f.store.storagePath)).toEqual([]);
});

test('current recorded admission publishes real review bytes without caller flags', async () => {
  const f = fixture();
  expect((await f.admitted.run({})).success).toBe(true);
  const descriptor = f.store.list()[0]; if (!descriptor) throw new Error('Review artifact was not published');
  const record = f.store.getRecord(descriptor.id); if (!record) throw new Error('Review artifact metadata was not persisted');
  expect(JSON.parse(readFileSync(record.contentPath, 'utf8'))).toMatchObject({ version: 1, laneId: 'inbox', outputPreview: f.output.preview, inputFieldKeys: ['query'] });
  expect(JSON.parse(readFileSync(record.metadataPath, 'utf8')).metadata).toMatchObject({ purpose: 'personal-ops-review-cards', fullRawConnectorOutputStored: false });
  expect(readdirSync(f.store.storagePath)).toHaveLength(2);
  const old = f.savedInvocation(); if (!old) throw new Error('Exact invocation was not captured');
  await expect(savePersonalOpsReviewArtifact({ context: f.context, lane, sourceRecord, inputFields: {}, reviewRecords: [], output: f.output, invocationArgs: old.args, executionOptions: old.options })).rejects.toThrow(ToolInputProjectionError);
  expect(f.store.list()).toHaveLength(1);
});

test('read-only policy vetoes publication despite a synthetic read classification', async () => {
  const f = fixture('plan');
  expect(await f.admitted.run({ confirm: true, explicitUserRequest: 'Caller annotation' })).toMatchObject({ success: false, error: 'plan_mode' });
  expect(f.store.list()).toHaveLength(0); expect(readdirSync(f.store.storagePath)).toEqual([]);
});

test.each(['cancel', 'revoke', 'source', 'physical-root', 'create-accessor', 'path-accessor'] as const)('a %s change during privacy reading cannot publish review bytes', async change => {
  const f = fixture(); const controller = new AbortController(); let getters = 0;
  f.afterBodyStarts(() => {
    if (change === 'cancel') controller.abort(new Error('Review save cancelled'));
    else if (change === 'revoke') f.admitted.setMode('plan');
    else if (change === 'source') f.output.preview = 'Concurrent source replacement';
    else if (change === 'physical-root') { renameSync(f.store.storagePath, join(f.root, 'retired')); mkdirSync(join(f.root, 'artifacts')); }
    else Object.defineProperty(f.store, change === 'create-accessor' ? 'create' : 'storagePath', { configurable: true, get() { getters++; throw new Error('Replacement accessor must not run'); } });
  });
  await expect(f.admitted.run({}, controller.signal)).rejects.toThrow();
  expect(getters).toBe(0); expect(readdirSync(join(f.root, 'artifacts'))).toEqual([]);
  if (change === 'physical-root') expect(readdirSync(join(f.root, 'retired'))).toEqual([]);
});

test('native ArtifactStore receives the final authority fence before its asynchronous write', async () => {
  const controller = new AbortController(); let attempted = 0;
  const f = fixture('prompt', store => {
    const create = store.create.bind(store);
    store.create = async (input, ownership) => { attempted++; await Promise.resolve(); controller.abort(); return create(input, ownership); };
  });
  await expect(f.admitted.run({}, controller.signal)).rejects.toThrow();
  expect(attempted).toBe(1); expect(f.store.list()).toHaveLength(0); expect(readdirSync(f.store.storagePath)).toEqual([]);
});
