import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { ArtifactDescriptor, ArtifactRecord, ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { CommandContext } from '../../input/command-registry.ts';
import { createAgentArtifactsTool } from '../../tools/agent-artifacts-tool.ts';
import { savedReviewArtifactRecords, savedReviewArtifacts, savedReviewQueueRecords } from '../../tools/agent-harness-personal-ops-records.ts';
import { resolveRunRecord, savePersonalOpsReviewArtifact } from '../../tools/agent-harness-personal-ops-runner.ts';
import type { PersonalOpsLane, PersonalOpsLiveRecord } from '../../tools/agent-harness-personal-ops-types.ts';
import { cleanupResearchScreeningFixtures, researchScreeningFixture } from '../helpers/research-screening.ts';

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
  const records: ArtifactRecord[] = [];
  const contents = new Map<string, Buffer>();
  const store: Pick<ArtifactStore, 'create' | 'get' | 'list' | 'readContent'> = {
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
  const save = (id: 'inbox' | 'calendar' = 'inbox', title?: string) => savePersonalOpsReviewArtifact({
    context, lane: lane(id), sourceRecord, inputFields: { query: 'review' }, reviewRecords,
    output: { preview: 'Quarterly review', truncated: false }, title,
  });
  return { context, records, store, save };
}

afterAll(cleanupResearchScreeningFixtures);
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

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

  test.each(['inbox', 'calendar'] as const)('%s reads old epoch and new filenames through unchanged metadata and artifact-ID consumers', async (id) => {
    const f = fixture();
    const legacy = await f.store.create({ kind: 'data', mimeType: 'application/json',
      filename: `${id}-review-cards-${CARD_SHAPED_EPOCH}.json`, text: JSON.stringify({ reviewRecords }),
      metadata: { purpose: 'personal-ops-review-cards', laneId: id, reviewRecordCount: 1, reviewLabels: ['Quarterly review'], reviewRecordIds: ['review-item'] },
    });
    await f.save(id);
    const generated = f.records[1]!;
    expect(savedReviewArtifacts(f.context, id).map((record) => record.id)).toEqual([generated.id, legacy.id]);
    const artifactRecords = savedReviewArtifactRecords(f.context, id, []);
    const queueRecords = savedReviewQueueRecords(f.context, id, []);
    const browser = createAgentArtifactsTool(f.store);
    for (const artifact of [legacy, generated]) {
      expect(artifactRecords.find((record) => record.artifactId === artifact.id)?.label).toContain(artifact.filename!);
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
    const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
    const liveRecords = savedReviewArtifactRecords(f.context, 'inbox', []);
    const result = await resolveRunRecord([{ ...lane('inbox'), liveRecords }],
      { laneId: 'inbox', recordId: '', target: '', query: 'saved inbox review' }, { sourceOwner: screening.owner });
    expect(result).toMatchObject({ status: 'selection_required', candidates: [{ recordId: liveRecords[0]!.id }] });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.context?.battery).toBe('engine.tools.registry-rank');
    expect(JSON.stringify(screening.calls)).toContain(f.records[0]!.filename!);
  });

  test('genuine protected filename material remains intact and refused before local or hosted reading', async () => {
    const f = fixture(); await f.save('inbox', 'review-4111111111111111');
    expect(f.records[0]!.filename).toMatch(/^review-4111111111111111-[a-p]{32}\.json$/);
    const screening = researchScreeningFixture();
    const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
    const liveRecords = savedReviewArtifactRecords(f.context, 'inbox', []);
    await expect(resolveRunRecord([{ ...lane('inbox'), liveRecords }],
      { laneId: 'inbox', recordId: '', target: '', query: 'saved inbox review' }, { sourceOwner: screening.owner }))
      .rejects.toThrow('payment card material');
    expect(screening.calls).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);
  });
});
