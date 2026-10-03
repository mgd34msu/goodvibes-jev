import { describe, expect, test } from 'bun:test';
import { inflateRawSync } from 'node:zlib';
import type { ArtifactCreateInput, ArtifactDescriptor, ArtifactRecord, ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { ChatRequest, ChatResponse, LLMProvider } from '@goodvibes-jev/engine/sdk/platform/providers';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import {
  createAgentModelCompareTool,
  registerAgentModelCompareTool,
  type AgentModelCompareCatalogModel,
} from '../../tools/agent-model-compare-tool.ts';

class CompareTestProvider implements LLMProvider {
  readonly models: string[];
  readonly calls: ChatRequest[] = [];

  constructor(
    readonly name: string,
    modelId: string,
    private readonly content: string,
  ) {
    this.models = [modelId];
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    this.calls.push(params);
    return {
      content: this.content,
      toolCalls: [],
      usage: { inputTokens: 11, outputTokens: 7 },
      stopReason: 'completed',
    };
  }
}

function artifactStore() {
  const inputs: ArtifactCreateInput[] = [];
  const records: ArtifactRecord[] = [];
  const contents = new Map<string, Buffer>();
  const store: Pick<ArtifactStore, 'create' | 'list' | 'readContent'> = {
    async create(input: ArtifactCreateInput): Promise<ArtifactDescriptor> {
      inputs.push(input);
      const id = `artifact-${inputs.length}`;
      const buffer = typeof input.dataBase64 === 'string'
        ? Buffer.from(input.dataBase64, 'base64')
        : Buffer.from(input.text ?? '', 'utf-8');
      const record: ArtifactRecord = {
        id: `artifact-${inputs.length}`,
        kind: input.kind ?? 'data',
        mimeType: input.mimeType ?? 'application/json',
        filename: input.filename,
        sizeBytes: buffer.byteLength,
        sha256: `sha-${inputs.length}`,
        createdAt: Date.now(),
        acquisitionMode: 'inline-data',
        fetchMode: 'not-applicable',
        metadata: input.metadata ?? {},
        contentPath: `/tmp/${id}.data`,
        metadataPath: `/tmp/${id}.json`,
      };
      records.push(record);
      contents.set(id, buffer);
      return record;
    },
    list(limit = 100): ArtifactDescriptor[] {
      return [...records].reverse().slice(0, limit);
    },
    async readContent(id: string): Promise<{ record: ArtifactRecord; buffer: Buffer }> {
      const record = records.find((entry) => entry.id === id);
      const buffer = contents.get(id);
      if (!record || !buffer) throw new Error(`Unknown artifact: ${id}`);
      return { record, buffer };
    },
  };
  return { inputs, store };
}

function unzipLocalEntries(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 4 < buffer.byteLength && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf-8');
    const compressed = buffer.subarray(dataStart, dataEnd);
    entries.set(name, method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed));
    offset = dataEnd;
  }
  return entries;
}

function fixture(options: {
  readonly artifactStore?: Pick<ArtifactStore, 'create'> & Partial<Pick<ArtifactStore, 'list' | 'readContent'>>;
  readonly applyModelRoute?: (registryKey: string) => { readonly previousModel?: string; readonly selectedModel: string };
} = {}) {
  const models: AgentModelCompareCatalogModel[] = [
    {
      modelId: 'gpt-4.1',
      providerId: 'openai',
      registryKey: 'openai:gpt-4.1',
      displayName: 'GPT-4.1',
      selectable: true,
      current: true,
    },
    {
      modelId: 'claude-sonnet',
      providerId: 'anthropic',
      registryKey: 'anthropic:claude-sonnet',
      displayName: 'Claude Sonnet',
      selectable: true,
    },
  ];
  const openai = new CompareTestProvider('openai', 'gpt-4.1', 'Candidate A style answer.');
  const anthropic = new CompareTestProvider('anthropic', 'claude-sonnet', 'Candidate B style answer.');
  const providers = new Map<string, CompareTestProvider>([
    ['openai', openai],
    ['anthropic', anthropic],
  ]);
  const recordedUsage: string[] = [];
  const appliedModelRoutes: string[] = [];
  let selectedModel = 'openai:gpt-4.1';
  const tool = createAgentModelCompareTool({
    modelCatalog: {
      listModels: () => models,
      getCurrentModel: () => models[0]!,
      recordModelUsage: async (registryKey) => {
        recordedUsage.push(registryKey);
      },
    },
    providerRegistry: {
      getForModel: (modelId, providerId) => {
        const provider = providers.get(providerId ?? '');
        if (!provider || !provider.models.includes(modelId)) throw new Error(`Unknown model ${providerId}:${modelId}`);
        return provider;
      },
    },
    artifactStore: options.artifactStore,
    applyModelRoute: options.applyModelRoute ?? ((registryKey) => {
      const previousModel = selectedModel;
      selectedModel = registryKey;
      appliedModelRoutes.push(registryKey);
      return { previousModel, selectedModel };
    }),
  });

  return {
    appliedModelRoutes,
    anthropic,
    openai,
    recordedUsage,
    tool,
  };
}

describe('agent_model_compare tool', () => {
  test('previews without calling providers when confirmation is missing', async () => {
    const item = fixture();

    const result = await item.tool.execute({
      mode: 'run',
      prompt: 'Compare release note drafts.',
      confirm: false,
      explicitUserRequest: 'Compare release notes.',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Agent blind model comparison preview');
    expect(result.error).toContain('confirmation required');
    expect(item.openai.calls).toEqual([]);
    expect(item.anthropic.calls).toEqual([]);
  });

  test('runs identical prompts and hides identities until reveal', async () => {
    const item = fixture();

    const result = await item.tool.execute({
      mode: 'run',
      prompt: 'Write a concise product update.',
      modelRefs: ['openai:gpt-4.1', 'anthropic:claude-sonnet'],
      rubric: 'Prefer accurate, user-facing phrasing.',
      confirm: true,
      explicitUserRequest: 'Compare product update drafts.',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Candidate A');
    expect(result.output).toContain('Candidate B');
    expect(result.output).toContain('Identities hidden');
    expect(result.output).not.toContain('openai:gpt-4.1');
    expect(result.output).not.toContain('anthropic:claude-sonnet');
    expect(item.openai.calls[0]?.messages).toEqual(item.anthropic.calls[0]?.messages);
    expect(item.openai.calls[0]?.messages[0]).toEqual({ role: 'user', content: 'Write a concise product update.' });
    expect(item.recordedUsage.sort()).toEqual(['anthropic:claude-sonnet', 'openai:gpt-4.1']);

    const comparisonId = result.output!.match(/cmp_[0-9a-f-]+/)?.[0];
    expect(comparisonId).toBeTruthy();

    const reveal = await item.tool.execute({
      mode: 'reveal',
      comparisonId,
    });
    expect(reveal.success).toBe(true);
    expect(reveal.output).toContain('A: openai:gpt-4.1 (GPT-4.1)');
    expect(reveal.output).toContain('B: anthropic:claude-sonnet (Claude Sonnet)');
  });

  test('can reveal identities immediately when explicitly requested', async () => {
    const item = fixture();

    const result = await item.tool.execute({
      mode: 'run',
      prompt: 'Write a concise product update.',
      candidateCount: 2,
      reveal: true,
      confirm: true,
      explicitUserRequest: 'Compare product update drafts and reveal now.',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Reveal');
    expect(result.output).toContain('A: openai:gpt-4.1 (GPT-4.1)');
    expect(result.output).toContain('No selected model was changed.');
  });

  test('saves a durable comparison artifact without leaking identities into blind output', async () => {
    const artifacts = artifactStore();
    const item = fixture({ artifactStore: artifacts.store });

    const result = await item.tool.execute({
      mode: 'run',
      prompt: 'Write a concise product update.',
      modelRefs: ['openai:gpt-4.1', 'anthropic:claude-sonnet'],
      rubric: 'Prefer accurate, user-facing phrasing.',
      confirm: true,
      explicitUserRequest: 'Compare product update drafts.',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('artifact artifact-1 blind-model-comparison-');
    expect(result.output).toContain('includes full prompt, blinded outputs, and reveal map');
    expect(result.output).not.toContain('openai:gpt-4.1');
    expect(result.output).not.toContain('anthropic:claude-sonnet');
    expect(artifacts.inputs).toHaveLength(1);
    expect(artifacts.inputs[0]?.filename).toMatch(/^blind-model-comparison-cmp_/);
    expect(artifacts.inputs[0]?.metadata).toMatchObject({
      purpose: 'agent-model-compare',
      candidateCount: 2,
      completedCandidates: 2,
      revealStored: true,
      revealIncludedInTranscript: false,
    });

    const payload = JSON.parse(artifacts.inputs[0]?.text ?? '{}') as {
      readonly schema?: string;
      readonly prompt?: string;
      readonly rubric?: string;
      readonly reviewFlow?: { readonly routeMutation?: string };
      readonly candidates?: readonly {
        readonly blindId?: string;
        readonly content?: string;
        readonly model?: { readonly registryKey?: string };
      }[];
    };
    expect(payload.schema).toBe('goodvibes.agent.model_compare.v1');
    expect(payload.prompt).toBe('Write a concise product update.');
    expect(payload.rubric).toBe('Prefer accurate, user-facing phrasing.');
    expect(payload.reviewFlow?.routeMutation).toBe('none');
    expect(payload.candidates?.map((candidate) => candidate.blindId)).toEqual(['A', 'B']);
    expect(payload.candidates?.[0]?.model?.registryKey).toBe('openai:gpt-4.1');
    expect(payload.candidates?.[1]?.model?.registryKey).toBe('anthropic:claude-sonnet');
    expect(payload.candidates?.[0]?.content).toBe('Candidate A style answer.');
  });

  test('tags local model benchmark comparison artifacts for setup history', async () => {
    const artifacts = artifactStore();
    const item = fixture({ artifactStore: artifacts.store });

    const result = await item.tool.execute({
      mode: 'run',
      prompt: 'local model benchmark: Ollama',
      modelRefs: ['openai:gpt-4.1', 'anthropic:claude-sonnet'],
      benchmarkKind: 'local-model-route',
      confirm: true,
      explicitUserRequest: 'Compare this local model route before making it default.',
    });

    expect(result.success).toBe(true);
    expect(artifacts.inputs).toHaveLength(1);
    expect(artifacts.inputs[0]?.metadata).toMatchObject({
      purpose: 'agent-model-compare',
      benchmarkKind: 'local-model-route',
      candidateCount: 2,
      completedCandidates: 2,
    });
    const latencyEvidence = artifacts.inputs[0]?.metadata?.candidateLatencyEvidence;
    expect(Array.isArray(latencyEvidence)).toBe(true);
    expect((latencyEvidence as unknown as readonly Record<string, unknown>[]).map((entry) => entry.registryKey)).toEqual([
      'openai:gpt-4.1',
      'anthropic:claude-sonnet',
    ]);
    expect(typeof ((latencyEvidence as unknown as Array<Record<string, unknown>>)[0] as Record<string, unknown>).latencyMs).toBe('number');
    const payload = JSON.parse(artifacts.inputs[0]?.text ?? '{}') as {
      readonly benchmarkKind?: string;
      readonly prompt?: string;
      readonly reviewFlow?: { readonly routeMutation?: string };
    };
    expect(payload.benchmarkKind).toBe('local-model-route');
    expect(payload.prompt).toBe('local model benchmark: Ollama');
    expect(payload.reviewFlow?.routeMutation).toBe('none');
  });

  test('runs blind comparison from a saved text artifact as shared prompt context', async () => {
    const artifacts = artifactStore();
    const source = await artifacts.store.create({
      kind: 'document',
      mimeType: 'text/markdown',
      filename: 'launch-brief.md',
      text: 'Launch facts: ship the safer artifact reuse workflow.',
      metadata: { purpose: 'source-brief' },
    });
    const item = fixture({ artifactStore: artifacts.store });

    const result = await item.tool.execute({
      mode: 'run',
      artifactId: source.id,
      prompt: 'Write a concise launch summary from the saved artifact.',
      modelRefs: ['openai:gpt-4.1', 'anthropic:claude-sonnet'],
      rubric: 'Prefer faithful use of saved source facts.',
      confirm: true,
      explicitUserRequest: 'Compare summaries from the saved launch brief artifact.',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain(`source artifact ${source.id}`);
    expect(result.output).toContain('artifact artifact-2 blind-model-comparison-');
    expect(result.output).not.toContain('openai:gpt-4.1');
    expect(item.openai.calls[0]?.messages).toEqual(item.anthropic.calls[0]?.messages);
    const prompt = item.openai.calls[0]?.messages[0]?.content;
    expect(prompt).toContain('Write a concise launch summary from the saved artifact.');
    expect(prompt).toContain('Saved artifact context');
    expect(prompt).toContain(`Artifact ID: ${source.id}`);
    expect(prompt).toContain('Launch facts: ship the safer artifact reuse workflow.');
    expect(artifacts.inputs).toHaveLength(2);
    expect(artifacts.inputs[1]?.metadata).toMatchObject({
      purpose: 'agent-model-compare',
      sourceArtifactId: source.id,
    });
    const payload = JSON.parse(artifacts.inputs[1]?.text ?? '{}') as {
      readonly sourceArtifact?: { readonly artifactId?: string };
      readonly prompt?: string;
    };
    expect(payload.sourceArtifact?.artifactId).toBe(source.id);
    expect(payload.prompt).toContain('Launch facts: ship the safer artifact reuse workflow.');
  });

  test('filters saved preference analytics by task type document id and benchmark tag', async () => {
    const artifacts = artifactStore();
    const source = await artifacts.store.create({
      kind: 'document',
      mimeType: 'text/markdown',
      filename: 'launch-plan.md',
      text: 'Launch plan: keep the evidence packet concise.',
      metadata: { purpose: 'agent-document-export', documentId: 'doc_launch' },
    });
    const runner = fixture({ artifactStore: artifacts.store });

    const documentRun = await runner.tool.execute({
      mode: 'run',
      artifactId: source.id,
      prompt: 'Draft a launch update from this document.',
      modelRefs: ['openai:gpt-4.1', 'anthropic:claude-sonnet'],
      benchmarkKind: 'doc-draft',
      taskType: 'writing',
      confirm: true,
      explicitUserRequest: 'Compare launch update drafts for this document.',
    });
    expect(documentRun.success).toBe(true);
    expect(documentRun.output).toContain('benchmark doc-draft');
    expect(documentRun.output).toContain('task type writing');
    expect(documentRun.output).toContain('document doc_launch');

    const reviewer = fixture({ artifactStore: artifacts.store });
    const documentJudgment = await reviewer.tool.execute({
      mode: 'judge',
      artifactId: 'artifact-2',
      winnerBlindId: 'B',
      reasons: 'Document draft was more concrete.',
      reveal: true,
      confirm: true,
      explicitUserRequest: 'Save the document comparison winner.',
    });
    expect(documentJudgment.success).toBe(true);
    expect(artifacts.inputs[2]?.metadata).toMatchObject({
      purpose: 'agent-model-compare-judgment',
      benchmarkKind: 'doc-draft',
      taskType: 'writing',
      documentId: 'doc_launch',
      sourceDocumentId: 'doc_launch',
    });

    const researchRun = await runner.tool.execute({
      mode: 'run',
      prompt: 'Answer a research question.',
      modelRefs: ['openai:gpt-4.1', 'anthropic:claude-sonnet'],
      benchmarkKind: 'research-bench',
      taskType: 'research',
      confirm: true,
      explicitUserRequest: 'Compare research answer drafts.',
    });
    expect(researchRun.success).toBe(true);
    const researchJudgment = await reviewer.tool.execute({
      mode: 'judge',
      artifactId: 'artifact-4',
      winnerBlindId: 'A',
      reasons: 'Research answer was easier to scan.',
      confirm: true,
      explicitUserRequest: 'Save the research comparison winner.',
    });
    expect(researchJudgment.success).toBe(true);

    const analytics = await reviewer.tool.execute({
      mode: 'analytics',
      benchmarkKind: 'doc-draft',
      taskType: 'writing',
      documentId: 'doc_launch',
      includeReasons: true,
    });
    expect(analytics.success).toBe(true);
    expect(analytics.output).toContain('filters benchmarkKind doc-draft; taskType writing; documentId doc_launch');
    expect(analytics.output).toContain('judgments 1; revealed 1; hidden 0');
    expect(analytics.output).toContain('Trend dimensions');
    expect(analytics.output).toContain('doc-draft: 1');
    expect(analytics.output).toContain('writing: 1');
    expect(analytics.output).toContain('doc_launch: 1');
    expect(analytics.output).toContain('Document draft was more concrete.');
    expect(analytics.output).not.toContain('Research answer was easier to scan.');

    const synthesis = await reviewer.tool.execute({
      mode: 'synthesis',
      documentId: 'missing-doc',
    });
    expect(synthesis.success).toBe(true);
    expect(synthesis.output).toContain('No saved comparison judgments matched filters documentId missing-doc');
  });

  test('rejects non-text source artifacts for blind comparison prompts', async () => {
    const artifacts = artifactStore();
    const image = await artifacts.store.create({
      kind: 'image',
      mimeType: 'image/png',
      filename: 'image.png',
      text: '',
      metadata: { purpose: 'generated-image' },
    });
    const item = fixture({ artifactStore: artifacts.store });

    const result = await item.tool.execute({
      mode: 'run',
      artifactId: image.id,
      prompt: 'Compare descriptions of this saved image.',
      confirm: true,
      explicitUserRequest: 'Compare a saved image artifact.',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('can only inline text-like artifacts');
    expect(item.openai.calls).toEqual([]);
    expect(item.anthropic.calls).toEqual([]);
  });

  test('reviews and reveals a saved comparison artifact across tool instances', async () => {
    const artifacts = artifactStore();
    const runner = fixture({ artifactStore: artifacts.store });

    const run = await runner.tool.execute({
      mode: 'run',
      prompt: 'Write a concise product update.',
      modelRefs: ['openai:gpt-4.1', 'anthropic:claude-sonnet'],
      confirm: true,
      explicitUserRequest: 'Compare product update drafts.',
    });
    expect(run.success).toBe(true);

    const reviewer = fixture({ artifactStore: artifacts.store });
    const list = await reviewer.tool.execute({ mode: 'review' });
    expect(list.success).toBe(true);
    expect(list.output).toContain('Saved blind comparison artifacts');
    expect(list.output).toContain('artifact-1');
    expect(list.output).toContain('Write a concise product update.');

    const review = await reviewer.tool.execute({
      mode: 'review',
      artifactId: 'artifact-1',
    });
    expect(review.success).toBe(true);
    expect(review.output).toContain('Blind model comparison review');
    expect(review.output).toContain('Review board');
    expect(review.output).toContain('Candidate A style answer.');
    expect(review.output).toContain('Decision worksheet');
    expect(review.output).not.toContain('openai:gpt-4.1');
    expect(review.output).not.toContain('anthropic:claude-sonnet');

    const reveal = await reviewer.tool.execute({
      mode: 'reveal',
      artifactId: 'artifact-1',
    });
    expect(reveal.success).toBe(true);
    expect(reveal.output).toContain('A: openai:gpt-4.1 (GPT-4.1)');
    expect(reveal.output).toContain('B: anthropic:claude-sonnet (Claude Sonnet)');

    const preview = await reviewer.tool.execute({
      mode: 'judge',
      artifactId: 'artifact-1',
      winnerBlindId: 'B',
      reasons: 'Candidate B was more concrete.',
      confirm: false,
      explicitUserRequest: 'Save the comparison winner.',
    });
    expect(preview.success).toBe(false);
    expect(preview.error).toContain('comparison judgment preview');
    expect(artifacts.inputs).toHaveLength(1);

    const judgment = await reviewer.tool.execute({
      mode: 'judge',
      artifactId: 'artifact-1',
      winnerBlindId: 'B',
      reasons: 'Candidate B was more concrete.',
      notes: 'Use this as evidence before any route change.',
      reveal: true,
      confirm: true,
      explicitUserRequest: 'Save the comparison winner.',
    });
    expect(judgment.success).toBe(true);
    expect(judgment.output).toContain('Blind model comparison judgment saved');
    expect(judgment.output).toContain('winner Candidate B');
    expect(judgment.output).toContain('winner model anthropic:claude-sonnet');
    expect(judgment.output).toContain('settings action:"set" key:"provider.model" value:"anthropic:claude-sonnet"');
    expect(judgment.output).toContain('No selected model was changed.');
    expect(artifacts.inputs).toHaveLength(2);

    const judgmentPayload = JSON.parse(artifacts.inputs[1]?.text ?? '{}') as {
      readonly schema?: string;
      readonly winnerBlindId?: string;
      readonly winnerModel?: { readonly registryKey?: string };
      readonly reasons?: string;
      readonly routeHandoff?: { readonly policy?: string };
    };
    expect(judgmentPayload.schema).toBe('goodvibes.agent.model_compare_judgment.v1');
    expect(judgmentPayload.winnerBlindId).toBe('B');
    expect(judgmentPayload.winnerModel?.registryKey).toBe('anthropic:claude-sonnet');
    expect(judgmentPayload.reasons).toBe('Candidate B was more concrete.');
    expect(judgmentPayload.routeHandoff?.policy).toContain('does not change the selected model');

    const hiddenJudgment = await reviewer.tool.execute({
      mode: 'judge',
      artifactId: 'artifact-1',
      winnerBlindId: 'A',
      reasons: 'Candidate A was easier to scan.',
      confirm: true,
      explicitUserRequest: 'Save the comparison winner without reveal.',
    });
    expect(hiddenJudgment.success).toBe(true);
    expect(hiddenJudgment.output).toContain('winner Candidate A');
    expect(hiddenJudgment.output).toContain('reveal the winning model before model-route inspection');
    expect(hiddenJudgment.output).not.toContain('openai:gpt-4.1');
    expect(hiddenJudgment.output).not.toContain('anthropic:claude-sonnet');
    expect(artifacts.inputs).toHaveLength(3);

    const hiddenPayload = JSON.parse(artifacts.inputs[2]?.text ?? '{}') as {
      readonly winnerModel?: unknown;
      readonly routeHandoff?: { readonly routeInspection?: string };
      readonly candidates?: readonly { readonly model?: unknown }[];
    };
    expect(hiddenPayload.winnerModel).toBeUndefined();
    expect(hiddenPayload.routeHandoff?.routeInspection).not.toContain('openai:gpt-4.1');
    expect(hiddenPayload.candidates?.some((candidate) => candidate.model)).toBe(false);

    const analytics = await reviewer.tool.execute({
      mode: 'analytics',
      includeReasons: true,
    });
    expect(analytics.success).toBe(true);
    expect(analytics.output).toContain('Blind model comparison analytics');
    expect(analytics.output).toContain('judgments 2; revealed 1; hidden 1');
    expect(analytics.output).toContain('anthropic:claude-sonnet (Claude Sonnet): 1');
    expect(analytics.output).toContain('Candidate A: 1');
    expect(analytics.output).toContain('Candidate B: 1');
    expect(analytics.output).toContain('artifact-2');
    expect(analytics.output).toContain('artifact-3');
    expect(analytics.output).toContain('Candidate B was more concrete.');
    expect(analytics.output).toContain('Use this as evidence before any route change.');
    expect(analytics.output).toContain('No selected model was changed.');

    const synthesis = await reviewer.tool.execute({
      mode: 'synthesis',
      includeReasons: true,
    });
    expect(synthesis.success).toBe(true);
    expect(synthesis.output).toContain('Blind model comparison synthesis');
    expect(synthesis.output).toContain('judgments 2; revealed 1; hidden 1');
    expect(synthesis.output).toContain('Winning model direction');
    expect(synthesis.output).toContain('anthropic:claude-sonnet (Claude Sonnet): 1');
    expect(synthesis.output).toContain('Hidden winners: 1 judgment');
    expect(synthesis.output).toContain('Cross-session reason themes');
    expect(synthesis.output).toContain('Concrete/actionable output: 1 judgment');
    expect(synthesis.output).toContain('example artifact-2: Candidate B was more concrete.');
    expect(synthesis.output).toContain('Clear/scannable communication: 1 judgment');
    expect(synthesis.output).toContain('example artifact-3: Candidate A was easier to scan.');
    expect(synthesis.output).toContain('Recommended next actions');
    expect(synthesis.output).toContain('Reveal hidden judgments before applying model-level route changes.');
    expect(synthesis.output).toContain('No selected model was changed.');

    const listAfterJudgment = await reviewer.tool.execute({ mode: 'review' });
    expect(listAfterJudgment.success).toBe(true);
    expect(listAfterJudgment.output).toContain('artifact-1');
    expect(listAfterJudgment.output).not.toContain('artifact-2');
    expect(listAfterJudgment.output).not.toContain('artifact-3');

    const hiddenApply = await reviewer.tool.execute({
      mode: 'apply',
      artifactId: 'artifact-3',
      confirm: true,
      explicitUserRequest: 'Apply the hidden comparison winner.',
    });
    expect(hiddenApply.success).toBe(false);
    expect(hiddenApply.error).toContain('does not include a revealed winner model');
    expect(reviewer.appliedModelRoutes).toEqual([]);

    const applyPreview = await reviewer.tool.execute({
      mode: 'apply',
      artifactId: 'artifact-2',
      confirm: false,
      explicitUserRequest: 'Apply the comparison winner.',
    });
    expect(applyPreview.success).toBe(false);
    expect(applyPreview.error).toContain('route update preview');
    expect(applyPreview.error).toContain('model anthropic:claude-sonnet');
    expect(reviewer.appliedModelRoutes).toEqual([]);

    const apply = await reviewer.tool.execute({
      mode: 'apply',
      artifactId: 'artifact-2',
      confirm: true,
      explicitUserRequest: 'Apply the comparison winner.',
    });
    expect(apply.success).toBe(true);
    expect(apply.output).toContain('Applied blind model comparison winner');
    expect(apply.output).toContain('selected model anthropic:claude-sonnet');
    expect(apply.output).toContain('previous model openai:gpt-4.1');
    expect(apply.output).toContain('route decision receipt artifact-4');
    expect(reviewer.appliedModelRoutes).toEqual(['anthropic:claude-sonnet']);
    expect(artifacts.inputs).toHaveLength(4);
    expect(artifacts.inputs[3]?.metadata).toMatchObject({
      purpose: 'agent-model-compare-route-decision',
      decision: 'applied-winner',
      judgmentArtifactId: 'artifact-2',
      winnerModel: 'anthropic:claude-sonnet',
      previousModel: 'openai:gpt-4.1',
      selectedModel: 'anthropic:claude-sonnet',
    });
    const applyReceiptPayload = JSON.parse(artifacts.inputs[3]?.text ?? '{}') as {
      readonly schema?: string;
      readonly decision?: string;
      readonly selectedModel?: string;
    };
    expect(applyReceiptPayload.schema).toBe('goodvibes.agent.model_compare.route_decision.v1');
    expect(applyReceiptPayload.decision).toBe('applied-winner');
    expect(applyReceiptPayload.selectedModel).toBe('anthropic:claude-sonnet');

    const exportPreview = await reviewer.tool.execute({
      mode: 'export',
      artifactId: 'artifact-1',
      confirm: false,
      explicitUserRequest: 'Export the comparison report.',
    });
    expect(exportPreview.success).toBe(false);
    expect(exportPreview.error).toContain('comparison export preview');
    expect(artifacts.inputs).toHaveLength(4);

    const comparisonExport = await reviewer.tool.execute({
      mode: 'export',
      artifactId: 'artifact-1',
      reveal: false,
      confirm: true,
      explicitUserRequest: 'Export the comparison report.',
    });
    expect(comparisonExport.success).toBe(true);
    expect(comparisonExport.output).toContain('Blind model comparison export saved');
    expect(comparisonExport.output).toContain('source artifact-1 (comparison)');
    expect(comparisonExport.output).toContain('artifact-5');
    expect(comparisonExport.output).toContain('No selected model was changed.');
    expect(artifacts.inputs).toHaveLength(5);
    expect(artifacts.inputs[4]?.mimeType).toBe('text/markdown');
    expect(artifacts.inputs[4]?.metadata?.purpose).toBe('agent-model-compare-export');
    expect(artifacts.inputs[4]?.metadata?.sourceKind).toBe('comparison');
    const comparisonExportText = artifacts.inputs[4]?.text ?? '';
    expect(comparisonExportText).toContain('# Blind Model Comparison');
    expect(comparisonExportText).toContain('Candidate A style answer.');
    expect(comparisonExportText).toContain('Candidate B style answer.');
    expect(comparisonExportText).not.toContain('openai:gpt-4.1');
    expect(comparisonExportText).not.toContain('anthropic:claude-sonnet');

    const judgmentExport = await reviewer.tool.execute({
      mode: 'export',
      artifactId: 'artifact-2',
      confirm: true,
      explicitUserRequest: 'Export the judgment report.',
    });
    expect(judgmentExport.success).toBe(true);
    expect(judgmentExport.output).toContain('Blind model comparison export saved');
    expect(judgmentExport.output).toContain('source artifact-2 (judgment)');
    expect(judgmentExport.output).toContain('artifact-6');
    expect(artifacts.inputs).toHaveLength(6);
    expect(artifacts.inputs[5]?.mimeType).toBe('text/markdown');
    expect(artifacts.inputs[5]?.metadata?.purpose).toBe('agent-model-compare-export');
    expect(artifacts.inputs[5]?.metadata?.sourceKind).toBe('judgment');
    const judgmentExportText = artifacts.inputs[5]?.text ?? '';
    expect(judgmentExportText).toContain('# Blind Model Comparison Judgment');
    expect(judgmentExportText).toContain('Winner model: anthropic:claude-sonnet');
    expect(judgmentExportText).toContain('Candidate B was more concrete.');
    expect(judgmentExportText).toContain('Use this as evidence before any route change.');

    const listAfterExport = await reviewer.tool.execute({ mode: 'review' });
    expect(listAfterExport.success).toBe(true);
    expect(listAfterExport.output).toContain('artifact-1');
    expect(listAfterExport.output).not.toContain('artifact-4');
    expect(listAfterExport.output).not.toContain('artifact-5');
    expect(listAfterExport.output).not.toContain('artifact-6');

    const analyticsAfterExport = await reviewer.tool.execute({
      mode: 'analytics',
      includeReasons: false,
    });
    expect(analyticsAfterExport.success).toBe(true);
    expect(analyticsAfterExport.output).toContain('judgments 2; revealed 1; hidden 1');
    expect(analyticsAfterExport.output).not.toContain('artifact-4');
    expect(analyticsAfterExport.output).not.toContain('artifact-5');
    expect(analyticsAfterExport.output).not.toContain('artifact-6');
    expect(analyticsAfterExport.output).not.toContain('Candidate B was more concrete.');

    const documentExport = await artifacts.store.create({
      kind: 'data',
      mimeType: 'text/markdown',
      filename: 'launch-plan.md',
      text: [
        '# Launch Plan',
        '',
        'Ship the reviewed document workflow.',
        '',
        '## Review Comments',
        '',
        '- c1 [resolved] Clarify the launch owner.',
      ].join('\n'),
      metadata: {
        purpose: 'agent-document-export',
        documentId: 'doc_launch',
      },
    });
    expect(documentExport.id).toBe('artifact-7');

    const sideBySide = await reviewer.tool.execute({
      mode: 'sideBySide',
      artifactId: 'artifact-2',
      relatedArtifactIds: [documentExport.id],
      previewBytes: 600,
    });
    expect(sideBySide.success).toBe(true);
    expect(sideBySide.output).toContain('Blind model comparison side-by-side reviewer view');
    expect(sideBySide.output).toContain('Left pane: related document/artifact evidence');
    expect(sideBySide.output).toContain('Right pane: comparison evidence');
    expect(sideBySide.output).toContain('artifact-7 launch-plan.md');
    expect(sideBySide.output).toContain('# Launch Plan');
    expect(sideBySide.output).toContain('winner Candidate B');
    expect(sideBySide.output).toContain('winner model anthropic:claude-sonnet');
    expect(sideBySide.output).toContain('create handoff agent_model_compare mode:"handoff"');
    expect(sideBySide.output).toContain('No selected model was changed.');
    expect(artifacts.inputs).toHaveLength(7);

    const sideBySideList = await reviewer.tool.execute({ mode: 'sideBySide' });
    expect(sideBySideList.success).toBe(true);
    expect(sideBySideList.output).toContain('Saved blind comparison artifacts');
    expect(sideBySideList.output).toContain('mode:"sideBySide"');
    expect(sideBySideList.output).toContain('Choose a saved comparison or judgment artifactId');
    expect(artifacts.inputs).toHaveLength(7);

    const handoffPreview = await reviewer.tool.execute({
      mode: 'handoff',
      artifactId: 'artifact-2',
      relatedArtifactIds: [documentExport.id],
      confirm: false,
      explicitUserRequest: 'Create a reviewer handoff.',
    });
    expect(handoffPreview.success).toBe(false);
    expect(handoffPreview.error).toContain('reviewer handoff preview');
    expect(handoffPreview.error).toContain(`related artifacts ${documentExport.id}`);
    expect(artifacts.inputs).toHaveLength(7);

    const handoff = await reviewer.tool.execute({
      mode: 'handoff',
      artifactId: 'artifact-2',
      relatedArtifactIds: [documentExport.id],
      confirm: true,
      explicitUserRequest: 'Create a reviewer handoff.',
    });
    expect(handoff.success).toBe(true);
    expect(handoff.output).toContain('Blind model comparison reviewer handoff saved');
    expect(handoff.output).toContain('source artifact-2 (judgment)');
    expect(handoff.output).toContain('related artifacts 1');
    expect(handoff.output).toContain('artifact artifact-8');
    expect(handoff.output).toContain('No selected model was changed.');
    expect(artifacts.inputs).toHaveLength(8);
    expect(artifacts.inputs[7]?.mimeType).toBe('text/markdown');
    expect(artifacts.inputs[7]?.metadata).toMatchObject({
      purpose: 'agent-model-compare-handoff',
      sourceArtifactId: 'artifact-2',
      sourceKind: 'judgment',
      relatedArtifactIds: [documentExport.id],
    });
    const handoffText = artifacts.inputs[7]?.text ?? '';
    expect(handoffText).toContain('# Blind Model Comparison Reviewer Handoff');
    expect(handoffText).toContain('## Related Artifacts');
    expect(handoffText).toContain('# Launch Plan');
    expect(handoffText).toContain('## Review Comments');
    expect(handoffText).toContain('## Comparison Evidence');
    expect(handoffText).toContain('# Blind Model Comparison Judgment');
    expect(handoffText).toContain('Winner model: anthropic:claude-sonnet');
    expect(handoffText).toContain('Route changes require a separate confirmed');

    const archivePreview = await reviewer.tool.execute({
      mode: 'handoffArchive',
      artifactId: 'artifact-8',
      confirm: false,
      explicitUserRequest: 'Archive the reviewer handoff.',
    });
    expect(archivePreview.success).toBe(false);
    expect(archivePreview.error).toContain('reviewer handoff archive preview');
    expect(archivePreview.error).toContain('source artifact-2 (judgment)');
    expect(archivePreview.error).toContain(`related artifacts ${documentExport.id}`);
    expect(archivePreview.error).toContain('route-decision receipts artifact-4');
    expect(artifacts.inputs).toHaveLength(8);

    const archive = await reviewer.tool.execute({
      mode: 'handoffArchive',
      artifactId: 'artifact-8',
      confirm: true,
      explicitUserRequest: 'Archive the reviewer handoff.',
    });
    expect(archive.success).toBe(true);
    expect(archive.output).toContain('Blind model comparison reviewer handoff archive saved');
    expect(archive.output).toContain('handoff artifact-8');
    expect(archive.output).toContain('source artifact-2 (judgment)');
    expect(archive.output).toContain('route-decision receipts 1');
    expect(archive.output).toContain('included artifacts 4');
    expect(archive.output).toContain('archive artifact-9');
    expect(archive.output).toContain('export agent_artifacts mode:"export" artifactId:"artifact-9"');
    expect(archive.output).toContain('No selected model was changed.');
    expect(artifacts.inputs).toHaveLength(9);
    expect(artifacts.inputs[8]?.kind).toBe('archive');
    expect(artifacts.inputs[8]?.mimeType).toBe('application/zip');
    expect(artifacts.inputs[8]?.metadata).toMatchObject({
      purpose: 'agent-model-compare-handoff-archive',
      handoffArtifactId: 'artifact-8',
      sourceArtifactId: 'artifact-2',
      sourceKind: 'judgment',
      relatedArtifactIds: [documentExport.id],
      routeDecisionArtifactIds: ['artifact-4'],
      includedArtifactIds: ['artifact-8', 'artifact-2', documentExport.id, 'artifact-4'],
      artifactCount: 4,
    });
    const archiveBytes = Buffer.from(String(artifacts.inputs[8]?.dataBase64 ?? ''), 'base64');
    const entries = unzipLocalEntries(archiveBytes);
    expect(entries.get('README.md')?.toString('utf-8')).toContain('GoodVibes Agent Comparison Handoff Archive');
    const manifest = JSON.parse(entries.get('manifest.json')?.toString('utf-8') ?? '{}') as {
      readonly archiveKind?: string;
      readonly handoff?: {
        readonly sourceArtifactId?: string;
        readonly relatedArtifactIds?: readonly string[];
        readonly routeDecisionArtifactIds?: readonly string[];
      };
      readonly artifacts?: readonly { readonly role?: string; readonly id?: string; readonly file?: string }[];
    };
    expect(manifest.archiveKind).toBe('agent-model-compare-handoff');
    expect(manifest.handoff?.sourceArtifactId).toBe('artifact-2');
    expect(manifest.handoff?.relatedArtifactIds).toEqual([documentExport.id]);
    expect(manifest.handoff?.routeDecisionArtifactIds).toEqual(['artifact-4']);
    expect(manifest.artifacts?.map((entry) => entry.role)).toEqual(['handoff', 'source', 'related', 'route-decision']);
    const handoffEntry = manifest.artifacts?.find((entry) => entry.role === 'handoff');
    const sourceEntry = manifest.artifacts?.find((entry) => entry.role === 'source');
    const relatedEntry = manifest.artifacts?.find((entry) => entry.role === 'related');
    const routeDecisionEntry = manifest.artifacts?.find((entry) => entry.role === 'route-decision');
    expect(entries.get(String(handoffEntry?.file))?.toString('utf-8')).toContain('# Blind Model Comparison Reviewer Handoff');
    expect(entries.get(String(sourceEntry?.file))?.toString('utf-8')).toContain('"schema": "goodvibes.agent.model_compare_judgment.v1"');
    expect(entries.get(String(relatedEntry?.file))?.toString('utf-8')).toContain('# Launch Plan');
    expect(entries.get(String(routeDecisionEntry?.file))?.toString('utf-8')).toContain('"schema": "goodvibes.agent.model_compare.route_decision.v1"');

    const archiveList = await reviewer.tool.execute({ mode: 'handoffArchive' });
    expect(archiveList.success).toBe(true);
    expect(archiveList.output).toContain('Saved blind comparison reviewer handoffs');
    expect(archiveList.output).toContain('artifact-8');

    const documentExportV2 = await artifacts.store.create({
      kind: 'data',
      mimeType: 'text/markdown',
      filename: 'launch-plan-v2.md',
      text: [
        '# Launch Plan',
        '',
        'Ship the reviewer handoff diff workflow.',
        '',
        '## Review Comments',
        '',
        '- c1 [resolved] Clarify the launch owner.',
        '- c2 [open] Confirm the reviewer packet before archive.',
      ].join('\n'),
      metadata: {
        purpose: 'agent-document-export',
        documentId: 'doc_launch',
      },
    });
    expect(documentExportV2.id).toBe('artifact-10');

    const secondHandoff = await reviewer.tool.execute({
      mode: 'handoff',
      artifactId: 'artifact-2',
      relatedArtifactIds: [documentExportV2.id],
      confirm: true,
      explicitUserRequest: 'Create a second reviewer handoff for comparison.',
    });
    expect(secondHandoff.success).toBe(true);
    expect(secondHandoff.output).toContain('artifact artifact-11');

    const handoffDiff = await reviewer.tool.execute({
      mode: 'handoffDiff',
      leftArtifactId: 'artifact-8',
      rightArtifactId: 'artifact-11',
    });
    expect(handoffDiff.success).toBe(true);
    expect(handoffDiff.output).toContain('Blind model comparison reviewer handoff visual diff');
    expect(handoffDiff.output).toContain('left artifact-8');
    expect(handoffDiff.output).toContain('right artifact-11');
    expect(handoffDiff.output).toContain('Metadata delta');
    expect(handoffDiff.output).toContain('related artifacts: changed');
    expect(handoffDiff.output).toContain('Section delta');
    expect(handoffDiff.output).toContain('Related Artifacts: changed');
    expect(handoffDiff.output).toContain('- Ship the reviewed document workflow.');
    expect(handoffDiff.output).toContain('+ Ship the reviewer handoff diff workflow.');
    expect(handoffDiff.output).toContain('+ - c2 [open] Confirm the reviewer packet before archive.');
    expect(handoffDiff.output).toContain('No selected model was changed.');

    const relatedHandoffDiff = await reviewer.tool.execute({
      mode: 'handoffDiff',
      leftArtifactId: 'artifact-8',
      rightArtifactId: 'artifact-11',
      sectionId: 'related',
    });
    expect(relatedHandoffDiff.success).toBe(true);
    expect(relatedHandoffDiff.output).toContain('section jump Related Artifacts');
    expect(relatedHandoffDiff.output).toContain('available sections Metadata delta');
    expect(relatedHandoffDiff.output).toContain('- Ship the reviewed document workflow.');
    expect(relatedHandoffDiff.output).toContain('+ Ship the reviewer handoff diff workflow.');

    const handoffDiffList = await reviewer.tool.execute({ mode: 'handoffDiff' });
    expect(handoffDiffList.success).toBe(true);
    expect(handoffDiffList.output).toContain('Saved blind comparison reviewer handoffs');
    expect(handoffDiffList.output).toContain('leftArtifactId');
    expect(handoffDiffList.output).toContain('artifact-11');
  });

  test('can deliberately skip artifact persistence', async () => {
    const artifacts = artifactStore();
    const item = fixture({ artifactStore: artifacts.store });

    const result = await item.tool.execute({
      mode: 'run',
      prompt: 'Write a concise product update.',
      saveArtifact: false,
      confirm: true,
      explicitUserRequest: 'Compare product update drafts without saving.',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('artifact not saved (saveArtifact false)');
    expect(artifacts.inputs).toEqual([]);
  });

  test('records leave-unchanged route-decision receipts without changing model routing', async () => {
    const artifacts = artifactStore();
    const runner = fixture({ artifactStore: artifacts.store });

    const run = await runner.tool.execute({
      mode: 'run',
      prompt: 'Compare route-decision wording.',
      modelRefs: ['openai:gpt-4.1', 'anthropic:claude-sonnet'],
      confirm: true,
      explicitUserRequest: 'Compare route-decision wording.',
    });
    expect(run.success).toBe(true);

    const reviewer = fixture({ artifactStore: artifacts.store });
    const judgment = await reviewer.tool.execute({
      mode: 'judge',
      artifactId: 'artifact-1',
      winnerBlindId: 'B',
      reasons: 'Candidate B was better, but keep the current model for now.',
      reveal: true,
      confirm: true,
      explicitUserRequest: 'Save the comparison winner.',
    });
    expect(judgment.success).toBe(true);

    const preview = await reviewer.tool.execute({
      mode: 'routeDecision',
      artifactId: 'artifact-2',
      decision: 'left-unchanged',
      confirm: false,
      explicitUserRequest: 'Leave the current model unchanged for this judgment.',
    });
    expect(preview.success).toBe(false);
    expect(preview.error).toContain('route-decision preview');
    expect(preview.error).toContain('decision left-unchanged');
    expect(artifacts.inputs).toHaveLength(2);
    expect(reviewer.appliedModelRoutes).toEqual([]);

    const receipt = await reviewer.tool.execute({
      mode: 'routeDecision',
      artifactId: 'artifact-2',
      decision: 'left-unchanged',
      confirm: true,
      explicitUserRequest: 'Leave the current model unchanged for this judgment.',
    });
    expect(receipt.success).toBe(true);
    expect(receipt.output).toContain('Recorded blind model comparison route decision left-unchanged');
    expect(receipt.output).toContain('route decision receipt artifact-3');
    expect(receipt.output).toContain('No selected model was changed.');
    expect(reviewer.appliedModelRoutes).toEqual([]);
    expect(artifacts.inputs).toHaveLength(3);
    expect(artifacts.inputs[2]?.metadata).toMatchObject({
      purpose: 'agent-model-compare-route-decision',
      decision: 'left-unchanged',
      judgmentArtifactId: 'artifact-2',
      winnerModel: 'anthropic:claude-sonnet',
      currentModel: 'openai:gpt-4.1',
      selectedModel: 'openai:gpt-4.1',
    });
  });

  test('is registered in the model tool registry', () => {
    const item = fixture();
    const registry = new ToolRegistry();

    registerAgentModelCompareTool(registry, {
      modelCatalog: {
        listModels: () => [],
      },
      providerRegistry: {
        getForModel: () => item.openai,
      },
    });

    expect(registry.has('agent_model_compare')).toBe(true);
  });
});
