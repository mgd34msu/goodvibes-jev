import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import type { ArtifactDescriptor, ArtifactRecord, ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { recordedEffectFixture } from '../helpers/recorded-effect-admission.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { createAgentArtifactsTool } from '../../tools/agent-artifacts-tool.ts';
import { savedReviewArtifactRecords, savedReviewArtifacts, savedReviewQueueRecords } from '../../tools/agent-harness-personal-ops-records.ts';
import { resolveRunRecord, savePersonalOpsReviewArtifact } from '../../tools/agent-harness-personal-ops-runner.ts';
import type { PersonalOpsLane, PersonalOpsLiveRecord } from '../../tools/agent-harness-personal-ops-types.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner, researchScreeningFixture } from '../helpers/research-screening.ts';

// This epoch passes the canonical Luhn guard. It must not become a generated
// semantic label, even though old saved files remain readable by artifact ID.
const CARD_SHAPED_EPOCH = 1_700_000_000_004;
const reviewRecords = [{ id: 'review-item', label: 'Quarterly review', kind: 'inbox-thread' }];
const sourceRecord: PersonalOpsLiveRecord = {
  id: 'connector-read', label: 'Read inbox', status: 'ready', summary: 'Read review items',
  userRoute: 'Personal Ops', modelRoute: 'connector-read', qualifiedName: 'mcp__inbox__search',
};

function lane(id: 'inbox' | 'calendar'): PersonalOpsLane {
  return { id, label: id, status: 'ready', outcome: 'Review', current: 'Review', next: 'Inspect',
    userRoute: 'Personal Ops', modelRoute: 'personal_ops', signals: [] };
}

function fixture() {
  const root = makeProjectTempDir('personal-ops-review-artifacts');
  const records: ArtifactRecord[] = [];
  const contents = new Map<string, Buffer>();
  const store: Pick<ArtifactStore, 'create' | 'get' | 'list' | 'readContent' | 'storagePath'> = {
    storagePath: root,
    async create(input): Promise<ArtifactDescriptor> {
      const id = `artifact-${records.length + 1}`;
      const buffer = Buffer.from(input.text ?? '');
      const record: ArtifactRecord = {
        id, kind: input.kind ?? 'data', mimeType: input.mimeType ?? 'application/json', filename: input.filename,
        sizeBytes: buffer.byteLength, sha256: `sha-${records.length + 1}`, createdAt: Date.now() + records.length,
        acquisitionMode: input.acquisitionMode ?? 'inline-data', fetchMode: input.fetchMode ?? 'not-applicable',
        metadata: input.metadata ?? {}, contentPath: `/unused/${id}.data`, metadataPath: `/unused/${id}.json`,
      };
      records.push(record); contents.set(id, buffer); return record;
    },
    get: (id) => records.find((record) => record.id === id) ?? null,
    list: (limit = 100) => [...records].reverse().slice(0, limit),
    async readContent(id) {
      const record = records.find((entry) => entry.id === id);
      const buffer = contents.get(id);
      if (!record || !buffer) throw new Error(`Unknown artifact: ${id}`);
      return { record, buffer };
    },
  };
  const context = { platform: { artifactStore: store } } as unknown as CommandContext;
  const effect = recordedEffectFixture({
    definition: { name: 'save_review_fixture', description: 'Save isolated authored review cards', parameters: { type: 'object', properties: { lane: { type: 'string' }, title: { type: 'string' } } }, sideEffects: ['state'] },
    async execute(args, executionOptions) {
      const saved = await savePersonalOpsReviewArtifact({
        context, lane: lane(args.lane === 'calendar' ? 'calendar' : 'inbox'), sourceRecord,
        inputFields: { query: 'review' }, reviewRecords, output: { preview: 'Quarterly review', truncated: false },
        ...(typeof args.title === 'string' ? { title: args.title } : {}), invocationArgs: args, executionOptions, sourceOwner: ordinaryResearchOwner(),
      });
      return { success: true, output: JSON.stringify(saved) };
    },
  }, 'prompt', {}, root);
  const save = (id: 'inbox' | 'calendar' = 'inbox', title?: string) => effect.run({ lane: id, ...(title === undefined ? {} : { title }) });
  return { context, records, store, save };
}

afterAll(cleanupResearchScreeningFixtures);
let previous: ReturnType<typeof installJudgmentPort>;
let decisions: SqliteDecisionLog;
let privacyReadings: ReturnType<typeof fakePort>;
beforeEach(() => {
  const readings = fakePort((name, question, rawState) => {
    if (rawState && typeof rawState === 'object' && !Array.isArray(rawState) && 'context' in rawState && 'candidates' in rawState) {
      const context = rawState.context;
      if (context && typeof context === 'object' && !Array.isArray(context) && 'purpose' in context && typeof context.purpose === 'string') {
        const targets: Readonly<Record<string, string>> = {
          'review record field serving one of: label, subject, title, summary': '1',
          'review record field serving one of: kind': '2',
          'review record field serving one of: id': '0',
        };
        const target = targets[context.purpose];
        if (target === undefined) throw new Error(`Unexpected review fixture purpose ${context.purpose}`);
        if (name === 'pick') return choiceAnswer(question, target, 0.999);
        return noulAnswer(name === `fits_${target}` ? 0.999 : 0.001);
      }
    }
    if (question.type === 'choice') return choiceAnswer(question,
      name === 'disposition' ? 'act' : name === 'kind' ? Object.hasOwn(question.criteria, 'read') ? 'read' : 'other' : 'generic', 0.999);
    return noulAnswer(0.001);
  });
  privacyReadings = readings;
  decisions = new SqliteDecisionLog(':memory:');
  previous = installJudgmentPort(withDecisionLog(readings.port, decisions));
});
afterEach(() => { installJudgmentPort(previous); decisions[Symbol.dispose](); });

describe('Personal Ops generated review artifact filenames', () => {
  test('uses unique alphabetic UUID suffixes at a card-shaped epoch and retains safe titles and JSON metadata', async () => {
    const f = fixture();
    const now = spyOn(Date, 'now').mockReturnValue(CARD_SHAPED_EPOCH);
    try {
      expect(() => snapshotJudgmentInput(`inbox-review-cards-${Date.now()}.json`)).toThrow('payment card material');
      await f.save('inbox', 'Quarterly / review.v1');
      await f.save('inbox', 'Quarterly / review.v1');
      expect(new Set(f.records.map((record) => record.filename)).size).toBe(2);
      for (const record of f.records) {
        expect(record.filename).toMatch(/^Quarterly-review\.v1-[a-p]{32}\.json$/);
        expect(() => snapshotJudgmentInput(record.filename)).not.toThrow();
        expect(record.mimeType).toBe('application/json');
        expect(record.metadata).toMatchObject({ purpose: 'personal-ops-review-cards', laneId: 'inbox', reviewRecordCount: 1 });
        const { buffer } = await f.store.readContent(record.id);
        expect(JSON.parse(buffer.toString())).toMatchObject({ version: 1, laneId: 'inbox', reviewRecords, inputFieldKeys: ['query'] });
      }
    } finally { now.mockRestore(); }
  });

  test.each(['inbox', 'calendar'] as const)('%s retains old artifact-ID access while protecting card-shaped epoch labels', async (id) => {
    const f = fixture();
    const legacy = await f.store.create({ kind: 'data', mimeType: 'application/json',
      filename: `${id}-review-cards-${CARD_SHAPED_EPOCH}.json`, text: JSON.stringify({ reviewRecords }),
      metadata: { purpose: 'personal-ops-review-cards', laneId: id, reviewRecordCount: 1, reviewLabels: ['Quarterly review'], reviewRecordIds: ['review-item'] },
    });
    await f.save(id);
    const generated = f.records[1]!;
    const reading = { sourceOwner: ordinaryResearchOwner() };
    expect((await savedReviewArtifacts(f.context, id, reading)).map((record) => record.id)).toEqual([generated.id, legacy.id]);
    const artifactRecords = await savedReviewArtifactRecords(f.context, id, [], reading);
    const queueRecords = await savedReviewQueueRecords(f.context, id, [], reading);
    const browser = createAgentArtifactsTool(f.store);
    for (const artifact of [legacy, generated]) {
      const label = artifactRecords.find((record) => record.artifactId === artifact.id)?.label;
      if (artifact === legacy) {
        expect(label).toContain('[REDACTED]');
        expect(JSON.stringify(artifactRecords)).not.toContain(artifact.filename!);
      } else expect(label).toContain(artifact.filename!);
      expect(queueRecords.find((record) => record.artifactId === artifact.id)?.modelRoute)
        .toBe(`agent_artifacts show artifactId:"${artifact.id}" includeContent:true`);
      const result = await browser.execute({ mode: 'show', artifactId: artifact.id, includeContent: true });
      expect(result.success).toBe(true);
      expect(String(result.output)).toContain(artifact.filename!);
      expect(String(result.output)).toContain('Quarterly review');
    }
  });

  test('generated saved labels reach the actual Personal Ops canonical catalog reader', async () => {
    const f = fixture(); await f.save();
    const screening = researchScreeningFixture();
    const fake = fakePort(() => noulAnswer(0.99));
    installJudgmentPort({ ...privacyReadings.port, ask(request) {
      return request.context?.battery === 'engine.tools.registry-rank'
        ? fake.port.ask(request) : privacyReadings.port.ask(request);
    } });
    const liveRecords = await savedReviewArtifactRecords(f.context, 'inbox', [], { sourceOwner: screening.owner });
    const result = await resolveRunRecord([{ ...lane('inbox'), liveRecords }],
      { laneId: 'inbox', recordId: '', target: '', query: 'saved inbox review' }, { sourceOwner: screening.owner });
    expect(result).toMatchObject({ status: 'selection_required', candidates: [{ recordId: liveRecords[0]!.id }] });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.context?.battery).toBe('engine.tools.registry-rank');
    expect(JSON.stringify(screening.calls)).toContain(f.records[0]!.filename!);
  });

  test('genuine protected filename material is refused before admission or artifact creation', async () => {
    const f = fixture();
    const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
    await expect(f.save('inbox', 'review-4111111111111111')).rejects.toThrow();
    expect(f.records).toHaveLength(0);
    expect(JSON.stringify(fake.requests)).not.toContain('4111111111111111');
  });
});
