import { captureJudgmentPort, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import { readMultimodalPdf } from './pdf-source.js';
import { assertJudgmentInput, captureOwnedJson } from '../gate/judgment-input.js';
import { rankMultimodalEntities, MultimodalEntityHeldError } from './entity-centrality.js';
import { createHash, randomUUID } from 'node:crypto';
import { ArtifactStore } from '../artifacts/index.js';
import type { ArtifactDescriptor, ArtifactRecord } from '../artifacts/types.js';
import { MediaProviderRegistry } from '../media/index.js';
import { readKnowledgeArtifactJudgmentSource, extractKnowledgeArtifact } from '../knowledge/extractors.js';
import { KnowledgeService } from '../knowledge/index.js';
import { VoiceService } from '../voice/index.js';
import type { VoiceAudioArtifact } from '../voice/index.js';
import type {
  MultimodalAnalysisRequest,
  MultimodalAnalysisResult,
  MultimodalDetail,
  MultimodalKind,
  MultimodalPacket,
  MultimodalProviderDescriptor,
  MultimodalServiceStatus,
  MultimodalWritebackResult,
} from './types.js';

const PACKET_BUDGETS: Record<MultimodalDetail, number> = {
  compact: 280,
  standard: 680,
  detailed: 1_280,
};

function estimateTokens(...values: Array<string | undefined>): number {
  const total = values.reduce((sum, value) => sum + (value?.length ?? 0), 0);
  return Math.max(1, Math.ceil(total / 4));
}

function compactText(value: string | undefined, maxLength = 240): string | undefined {
  const trimmed = value?.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1).trim()}…`;
}

function coerceStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim());
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function audioFormatFromMimeType(mimeType: string): VoiceAudioArtifact['format'] {
  const lower = mimeType.toLowerCase();
  if (lower.includes('wav')) return 'wav';
  if (lower.includes('mpeg') || lower.includes('mp3')) return 'mp3';
  if (lower.includes('ogg')) return 'ogg';
  if (lower.includes('webm')) return 'webm';
  if (lower.includes('flac')) return 'flac';
  return 'wav';
}

function detailLimit(detail: MultimodalDetail, compact: number, standard: number, detailed: number): number {
  switch (detail) {
    case 'compact':
      return compact;
    case 'detailed':
      return detailed;
    default:
      return standard;
  }
}

function mergeUnique(...groups: Array<readonly string[] | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const group of groups) {
    for (const entry of group ?? []) {
      const trimmed = entry.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

export class MultimodalService {
  private readonly sources = new WeakMap<MultimodalAnalysisResult, { text: string; artifacts: readonly ArtifactDescriptor[] }>();
  private readonly analyses = new Map<string, { result: MultimodalAnalysisResult; assertCurrent: () => void }>();

  private source(result: MultimodalAnalysisResult, text: string, artifacts: readonly ArtifactDescriptor[] = [result.artifact]): MultimodalAnalysisResult {
    this.sources.set(result, { text, artifacts });
    return result;
  }

  private ownedResult(result: MultimodalAnalysisResult): { result: MultimodalAnalysisResult; assertCurrent: () => void } {
    const snapshot = captureOwnedJson(result) as MultimodalAnalysisResult;
    const retained = this.analyses.get(snapshot.id);
    if (!retained || JSON.stringify(snapshot) !== JSON.stringify(retained.result)) throw new MultimodalEntityHeldError('stale');
    retained.assertCurrent();
    return retained;
  }

  constructor(
    private readonly artifactStore: ArtifactStore,
    private readonly mediaProviders: MediaProviderRegistry,
    private readonly voiceService: VoiceService,
    private readonly knowledgeService: KnowledgeService,
  ) {}

  async getStatus(): Promise<MultimodalServiceStatus> {
    const providers = await this.listProviders();
    return {
      enabled: providers.length > 0,
      providerCount: providers.length,
      providers,
      note: 'Multimodal analysis routes images through media understanding, audio through speech-to-text, documents through TS extractors, and video through keyframe/transcript fusion. Generated markdown packets and write-back are optional.',
    };
  }

  async listProviders(): Promise<readonly MultimodalProviderDescriptor[]> {
    const media = (await this.mediaProviders.status())
      .filter((provider) => provider.capabilities.includes('understand'))
      .map<MultimodalProviderDescriptor>((provider) => ({
        id: provider.id,
        label: provider.label,
        transport: 'media',
        capabilities: ['image.describe'],
        configured: provider.configured,
        metadata: provider.metadata,
      }));
    const voice = (await this.voiceService.getStatus(true)).providers
      .filter((provider) => provider.capabilities.includes('stt'))
      .map<MultimodalProviderDescriptor>((provider) => ({
        id: provider.id,
        label: provider.label,
        transport: provider.capabilities.includes('realtime') ? 'hybrid' : 'voice',
        capabilities: provider.capabilities.includes('realtime')
          ? ['audio.transcribe', 'audio.realtime']
          : ['audio.transcribe'],
        configured: provider.configured,
        metadata: provider.metadata,
      }));
    const extractors: MultimodalProviderDescriptor[] = [
      {
        id: 'knowledge-extractors',
        label: 'Built-in Knowledge Extractors',
        transport: 'extractor',
        capabilities: ['document.extract', 'video.keyframe-fusion'],
        configured: true,
        metadata: {},
      },
    ];
    return [...media, ...voice, ...extractors].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }

  async analyze(request: MultimodalAnalysisRequest, options: { readonly signal?: AbortSignal | undefined } = {}): Promise<MultimodalAnalysisResult> {
    const owned = captureOwnedJson(request) as MultimodalAnalysisRequest;
    const active = () => { if (options.signal?.aborted) throw new MultimodalEntityHeldError('stale'); };
    active();
    assertJudgmentInput({ prompt: owned.prompt, metadata: owned.metadata, artifactInput: owned.artifact ? {
      filename: owned.artifact.filename, mimeType: owned.artifact.mimeType, uri: owned.artifact.uri, metadata: owned.artifact.metadata,
    } : undefined });
    let authority: JudgmentPortCapture | undefined;
    try { authority = captureJudgmentPort('multimodal.entity-centrality', { signal: options.signal, assertCurrent: active }); }
    catch { /* No port at entry cannot be replaced by a later installation for this operation. */ }
    const { descriptor, record, buffer } = await this.resolveArtifactInput(owned);
    authority?.assertCurrent();
    const initial = captureOwnedJson(descriptor) as ArtifactDescriptor;
    const assertArtifact = (artifact: ArtifactDescriptor) => {
      active();
      if (JSON.stringify(this.artifactStore.get(artifact.id)) !== JSON.stringify(artifact)) throw new MultimodalEntityHeldError('stale');
    };
    assertArtifact(initial);
    assertJudgmentInput({ filename: initial.filename, metadata: initial.metadata, prompt: owned.prompt, metadataInput: owned.metadata, artifactMetadata: owned.artifact?.metadata });
    const assertEntryCurrent = () => { assertArtifact(initial); authority?.assertCurrent(); };
    let result: MultimodalAnalysisResult;
    switch (this.resolveKind(initial)) {
      case 'image': result = await this.analyzeImage(initial, owned); break;
      case 'audio': result = await this.analyzeAudio(initial, buffer, owned); break;
      case 'video': result = await this.analyzeVideo(initial, owned, assertEntryCurrent); break;
      default: result = await this.analyzeDocument(record, buffer, owned, assertEntryCurrent); break;
    }
    const source = this.sources.get(result)!;
    const artifacts = captureOwnedJson(source.artifacts) as readonly ArtifactDescriptor[];
    const assertCurrent = () => { assertEntryCurrent(); for (const artifact of artifacts) assertArtifact(artifact); };
    assertCurrent();
    const ranked = await rankMultimodalEntities(source.text, result.kind === 'image' ? 8 : 10, { signal: options.signal, assertCurrent, authority });
    ranked.assertCurrent();
    const retained = captureOwnedJson({ ...result, entities: ranked.entities }) as MultimodalAnalysisResult;
    // Bounded retention supports explicit HTTP packet/write-back round trips. Eviction is a hold, never re-admission.
    if (this.analyses.size >= 128) this.analyses.delete(this.analyses.keys().next().value!);
    this.analyses.set(retained.id, { result: retained, assertCurrent: ranked.assertCurrent });
    return retained;
  }

  buildPacket(result: MultimodalAnalysisResult, detail: MultimodalDetail = 'standard', budgetLimit = PACKET_BUDGETS[detail]): MultimodalPacket {
    result = this.ownedResult(result).result;
    const highlights = [
      result.summary,
      ...result.labels.slice(0, detailLimit(detail, 2, 4, 8)),
      ...result.segments.map((segment) => compactText(segment.text, detailLimit(detail, 100, 180, 260))).filter((segment): segment is string => Boolean(segment)),
    ].filter((entry): entry is string => Boolean(entry));
    const lines = [
      '## Multimodal Analysis',
      `Kind: ${result.kind} | detail: ${detail} | artifact: ${result.artifact.id}`,
    ];
    if (result.summary) lines.push(`Summary: ${result.summary}`);
    if (result.labels.length > 0) lines.push(`Labels: ${result.labels.join(', ')}`);
    if (result.entities.length > 0) lines.push(`Entities: ${result.entities.join(', ')}`);
    if (result.text) lines.push(`Text: ${compactText(result.text, detailLimit(detail, 180, 320, 520))}`);
    for (const segment of result.segments.slice(0, detailLimit(detail, 2, 4, 8))) {
      const segmentLabel = segment.title ? `${segment.kind}:${segment.title}` : segment.kind;
      if (segment.text) lines.push(`- ${segmentLabel}: ${compactText(segment.text, detailLimit(detail, 120, 220, 360))}`);
    }
    const rendered = lines.join('\n');
    return {
      detail,
      budgetLimit,
      estimatedTokens: estimateTokens(rendered),
      rendered,
      highlights: highlights.slice(0, detailLimit(detail, 4, 8, 16)),
    };
  }

  async writeBackAnalysis(
    result: MultimodalAnalysisResult,
    input: {
      readonly sessionId?: string | undefined;
      readonly title?: string | undefined;
      readonly tags?: readonly string[] | undefined;
      readonly folderPath?: string | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    } = {},
    options: { readonly signal?: AbortSignal | undefined; readonly assertCurrent?: (() => void) | undefined } = {},
  ): Promise<MultimodalWritebackResult> {
    const retained = this.ownedResult(result);
    const owned = { result: retained.result, assertCurrent: () => {
      if (options.signal?.aborted) throw new MultimodalEntityHeldError('stale');
      options.assertCurrent?.(); retained.assertCurrent();
    } };
    result = owned.result;
    input = captureOwnedJson(input) as typeof input;
    owned.assertCurrent();
    const analysisArtifact = await this.artifactStore.create({
      kind: 'document',
      mimeType: 'application/json',
      filename: `${result.artifact.filename ?? result.artifact.id}.analysis.json`,
      text: `${JSON.stringify(result, null, 2)}\n`,
      metadata: {
        ...(input.metadata ?? {}),
        sourceArtifactId: result.artifact.id,
        multimodalKind: result.kind,
        providerIds: [...result.providerIds],
      },
    }, { signal: options.signal, assertCurrent: owned.assertCurrent });
    let committedSourceId: string | undefined;
    let completionWarning: string | undefined;
    try {
      owned.assertCurrent();
      const ingest = await this.knowledgeService.ingestArtifact({
        artifactId: analysisArtifact.id,
        title: input.title ?? `${result.artifact.filename ?? result.artifact.id} analysis`,
        tags: mergeUnique(
          input.tags,
          result.labels,
          result.entities,
          [`multimodal:${result.kind}`],
        ),
        folderPath: input.folderPath,
        sessionId: input.sessionId,
        sourceType: 'document',
        connectorId: 'multimodal-analysis',
        metadata: {
          ...(input.metadata ?? {}),
          sourceArtifactId: result.artifact.id,
          multimodalKind: result.kind,
          providerIds: [...result.providerIds],
        },
      }, { signal: options.signal, assertCurrent: owned.assertCurrent, onCommitted: (id) => { committedSourceId = id; } });
      committedSourceId ??= ingest.source.id;
      // Once the guarded knowledge transaction commits, its receipt is final.
      // Usage is optional bookkeeping and must not revive a canceled operation.
      try {
        owned.assertCurrent();
        await this.knowledgeService.recordUsage({
          targetKind: 'source',
          targetId: ingest.source.id,
          usageKind: 'multimodal-writeback',
          sessionId: input.sessionId,
          metadata: {
            sourceArtifactId: result.artifact.id,
            multimodalKind: result.kind,
          },
        }, owned.assertCurrent);
      } catch { /* The committed source remains valid; no stale usage is written. */ }
    } catch (error) {
      if (!committedSourceId) {
        const current = this.artifactStore.get(analysisArtifact.id);
        if (JSON.stringify(current) === JSON.stringify(analysisArtifact)) this.artifactStore.delete(analysisArtifact.id);
        throw error;
      }
      completionWarning = 'The knowledge transaction committed, but post-commit persistence or bookkeeping did not finish. The committed records were retained; durable completion needs verification.';
    }
    return {
      analysisArtifact,
      knowledgeSourceId: committedSourceId,
      metadata: {
        ...(completionWarning ? { completionWarning } : {}),
        sourceArtifactId: result.artifact.id,
        multimodalKind: result.kind,
      },
    };
  }

  private async resolveArtifactInput(
    request: MultimodalAnalysisRequest,
  ): Promise<{ descriptor: ArtifactDescriptor; record: ArtifactRecord; buffer: Buffer }> {
    const artifactId = request.artifactId ?? request.artifact?.artifactId;
    if (artifactId) {
      const descriptor = captureOwnedJson(this.artifactStore.get(artifactId)) as ArtifactDescriptor | null;
      if (!descriptor) throw new MultimodalEntityHeldError('stale');
      const { record, buffer } = await this.artifactStore.readContent(artifactId);
      if (record.sha256 !== descriptor.sha256 || createHash('sha256').update(buffer).digest('hex') !== descriptor.sha256) throw new MultimodalEntityHeldError('stale');
      return {
        descriptor,
        record,
        buffer,
      };
    }

    const artifact = request.artifact;
    if (!artifact) throw new Error('Multimodal analysis requires artifactId or artifact input.');
    const created = await this.artifactStore.create({
      ...(artifact.dataBase64 ? { dataBase64: artifact.dataBase64 } : {}),
      ...(artifact.uri ? { uri: artifact.uri, allowPrivateHosts: artifact.allowPrivateHosts } : {}),
      ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
      ...(artifact.filename ? { filename: artifact.filename } : {}),
      metadata: artifact.metadata ?? {},
    });
    const { record, buffer } = await this.artifactStore.readContent(created.id);
    return { descriptor: created, record, buffer };
  }

  private resolveKind(descriptor: ArtifactDescriptor): MultimodalKind {
    switch (descriptor.kind) {
      case 'image':
        return 'image';
      case 'audio':
        return 'audio';
      case 'video':
        return 'video';
      default:
        return 'document';
    }
  }

  private async analyzeImage(
    descriptor: ArtifactDescriptor,
    request: MultimodalAnalysisRequest,
  ): Promise<MultimodalAnalysisResult> {
    assertJudgmentInput({ metadata: descriptor.metadata, filename: descriptor.filename, prompt: request.prompt, requestMetadata: request.metadata });
    const provider = this.mediaProviders.findProvider('understand', request.imageProviderId);
    if (!provider?.analyze) {
      throw new Error('No image-understanding provider is registered.');
    }
    const response = await provider.analyze({
      artifact: {
        artifactId: descriptor.id,
        mimeType: descriptor.mimeType,
        filename: descriptor.filename,
        sizeBytes: descriptor.sizeBytes,
        metadata: descriptor.metadata,
      },
      prompt: request.prompt,
      modelId: request.modelId,
      metadata: request.metadata,
    });
    const result = captureOwnedJson(response) as typeof response;
    assertJudgmentInput(result);
    const text = compactText(result.text, 2_000);
    const summary = compactText(result.description ?? text, 320);
    const segments = [
      ...(text ? [{ kind: 'ocr' as const, text, metadata: {} }] : []),
      ...(summary ? [{ kind: 'summary' as const, text: summary, metadata: {} }] : []),
    ];
    return this.source({
      id: `mm-${randomUUID().slice(0, 8)}`,
      kind: 'image',
      artifact: descriptor,
      providerIds: [result.providerId],
      summary,
      ...(text ? { text } : {}),
      labels: mergeUnique(result.labels),
      entities: [],
      segments,
      metadata: result.metadata,
    }, [result.description ?? '', result.text ?? '', ...(result.labels ?? [])].join(' '));
  }

  private async analyzeAudio(
    descriptor: ArtifactDescriptor,
    buffer: Buffer,
    request: MultimodalAnalysisRequest,
  ): Promise<MultimodalAnalysisResult> {
    assertJudgmentInput({ metadata: descriptor.metadata, prompt: request.prompt, requestMetadata: request.metadata });
    const response = await this.voiceService.transcribe(request.audioProviderId, {
      audio: {
        mimeType: descriptor.mimeType,
        format: audioFormatFromMimeType(descriptor.mimeType),
        dataBase64: buffer.toString('base64'),
        metadata: descriptor.metadata,
      },
      language: request.language,
      modelId: request.modelId,
      prompt: request.prompt,
      metadata: request.metadata,
    });
    const transcript = captureOwnedJson(response) as typeof response;
    assertJudgmentInput(transcript);
    const summary = compactText(transcript.text, 320);
    const text = compactText(transcript.text, 4_000);
    const segments = (transcript.segments ?? []).map((segment) => ({
      kind: 'transcript' as const,
      text: segment.text,
      startMs: segment.startMs,
      endMs: segment.endMs,
      confidence: segment.confidence,
      metadata: {},
    }));
    return this.source({
      id: `mm-${randomUUID().slice(0, 8)}`,
      kind: 'audio',
      artifact: descriptor,
      providerIds: [transcript.providerId],
      summary,
      ...(text ? { text } : {}),
      labels: request.language ? [request.language] : transcript.language ? [transcript.language] : [],
      entities: [],
      segments,
      metadata: transcript.metadata,
    }, [transcript.text, ...(transcript.segments ?? []).map(segment => segment.text)].join(' '));
  }

  private async analyzeDocument(
    record: ArtifactRecord,
    buffer: Buffer,
    _request: MultimodalAnalysisRequest,
    assertCurrent: () => void,
  ): Promise<MultimodalAnalysisResult> {
    // Screen original bytes decoded as text before an extractor clips summaries/search text.
    const isPdf = record.mimeType === 'application/pdf' || record.filename?.toLowerCase().endsWith('.pdf');
    const pdf = isPdf ? await readMultimodalPdf(buffer, assertCurrent) : undefined;
    const source = pdf?.source ?? await readKnowledgeArtifactJudgmentSource(record, buffer);
    assertCurrent();
    const extraction = captureOwnedJson(pdf?.extraction ?? await extractKnowledgeArtifact(record, buffer)) as Awaited<ReturnType<typeof extractKnowledgeArtifact>>;
    assertCurrent();
    assertJudgmentInput(extraction);
    const segments = extraction.sections.slice(0, 12).map((section) => ({
      kind: 'section' as const,
      title: section,
      text: section,
      metadata: {},
    }));
    const text = compactText([extraction.summary ?? '', extraction.excerpt ?? ''].join('\n\n'), 4_000);
    return this.source({
      id: `mm-${randomUUID().slice(0, 8)}`,
      kind: 'document',
      artifact: this.artifactStore.get(record.id)!,
      providerIds: ['knowledge-extractors'],
      summary: compactText(extraction.summary ?? extraction.excerpt, 320),
      ...(text ? { text } : {}),
      labels: mergeUnique(extraction.sections.slice(0, 8)),
      entities: [],
      segments,
      metadata: {
        extractorId: extraction.extractorId,
        format: extraction.format,
        structure: extraction.structure,
        extractionMetadata: extraction.metadata,
      },
    }, extraction.format === 'unknown' ? '' : source);
  }

  private async analyzeVideo(
    descriptor: ArtifactDescriptor,
    request: MultimodalAnalysisRequest,
    assertCurrent: () => void,
  ): Promise<MultimodalAnalysisResult> {
    const requestMetadata = request.metadata ?? {};
    const keyframeIds = coerceStringList(requestMetadata.keyframeArtifactIds ?? descriptor.metadata.keyframeArtifactIds);
    const transcriptArtifactId = typeof requestMetadata.transcriptArtifactId === 'string'
      ? requestMetadata.transcriptArtifactId
      : typeof descriptor.metadata.transcriptArtifactId === 'string'
        ? descriptor.metadata.transcriptArtifactId
        : undefined;
    const audioArtifactId = typeof requestMetadata.audioArtifactId === 'string'
      ? requestMetadata.audioArtifactId
      : typeof descriptor.metadata.audioArtifactId === 'string'
        ? descriptor.metadata.audioArtifactId
        : undefined;

    if (keyframeIds.length > 6) throw new MultimodalEntityHeldError('budget');
    const referencedIds = [...new Set([...keyframeIds, ...(audioArtifactId ? [audioArtifactId] : []), ...(transcriptArtifactId ? [transcriptArtifactId] : [])])];
    const referenced = new Map(referencedIds.map(id => {
      const artifact = captureOwnedJson(this.artifactStore.get(id)) as ArtifactDescriptor | null;
      if (!artifact) throw new MultimodalEntityHeldError('stale');
      assertJudgmentInput({ metadata: artifact.metadata, filename: artifact.filename });
      return [id, artifact] as const;
    }));
    const check = () => { assertCurrent(); for (const artifact of referenced.values()) {
      if (JSON.stringify(this.artifactStore.get(artifact.id)) !== JSON.stringify(artifact)) throw new MultimodalEntityHeldError('stale');
    } };
    check();
    const sourceTexts: string[] = [];
    const sourceArtifacts: ArtifactDescriptor[] = [descriptor, ...referenced.values()];
    const sceneSegments: Array<MultimodalAnalysisResult['segments'][number]> = [];
    const labels: string[] = [];
    const providerIds = new Set<string>();

    for (const [index, keyframeId] of keyframeIds.entries()) {
      check();
      const frameDescriptor = referenced.get(keyframeId)!;
      if (!frameDescriptor) continue;
      const frameAnalysis = await this.analyzeImage(frameDescriptor, {
        imageProviderId: request.imageProviderId,
        modelId: request.modelId,
        prompt: request.prompt ? `${request.prompt}\nFocus on this video keyframe.` : 'Describe this video keyframe.',
        metadata: request.metadata,
      });
      sourceTexts.push(this.sources.get(frameAnalysis)!.text);
      sourceArtifacts.push(captureOwnedJson(frameDescriptor) as ArtifactDescriptor);
      for (const providerId of frameAnalysis.providerIds) providerIds.add(providerId);
      labels.push(...frameAnalysis.labels);
      sceneSegments.push({
        kind: 'scene',
        title: `Scene ${index + 1}`,
        text: frameAnalysis.summary ?? frameAnalysis.text,
        metadata: {
          frameArtifactId: frameDescriptor.id,
        },
      });
    }

    if (audioArtifactId) {
      check();
      const audioDescriptor = referenced.get(audioArtifactId)!;
      if (audioDescriptor) {
        const audioResult = await this.analyzeAudio(
          audioDescriptor,
          (await this.artifactStore.readContent(audioArtifactId)).buffer,
          {
            audioProviderId: request.audioProviderId,
            modelId: request.modelId,
            prompt: request.prompt,
            language: request.language,
            metadata: request.metadata,
          },
        );
        sourceTexts.push(this.sources.get(audioResult)!.text);
        sourceArtifacts.push(captureOwnedJson(audioDescriptor) as ArtifactDescriptor);
        for (const providerId of audioResult.providerIds) providerIds.add(providerId);
        labels.push(...audioResult.labels);
        sceneSegments.push(...audioResult.segments.slice(0, 6));
      }
    }
    if (transcriptArtifactId) {
      check();
      const transcriptDescriptor = referenced.get(transcriptArtifactId)!;
      if (transcriptDescriptor) {
        const transcriptText = (await this.artifactStore.readContent(transcriptArtifactId)).buffer
          .toString('utf-8')
          .trim();
        assertJudgmentInput(transcriptText);
        sourceTexts.push(transcriptText);
        sourceArtifacts.push(captureOwnedJson(transcriptDescriptor) as ArtifactDescriptor);
        if (transcriptText) {
          sceneSegments.push({
            kind: 'transcript',
            text: compactText(transcriptText, 4_000) ?? transcriptText,
            metadata: { transcriptArtifactId },
          });
        }
      }
    }

    check();
    const summary = compactText([
      sceneSegments[0]?.text,
      sceneSegments[1]?.text,
      sceneSegments.find((segment) => segment.kind === 'transcript')?.text,
    ].filter(Boolean).join(' '), 320) ?? 'Video metadata is available but no keyframes or transcripts were provided for deeper analysis.';

    return this.source({
      id: `mm-${randomUUID().slice(0, 8)}`,
      kind: 'video',
      artifact: descriptor,
      providerIds: [...providerIds].length > 0 ? [...providerIds] : ['knowledge-extractors'],
      summary,
      text: compactText(sceneSegments.map((segment) => segment.text).filter(Boolean).join('\n\n'), 4_000),
      labels: mergeUnique(labels),
      entities: [],
      segments: sceneSegments,
      metadata: {
        keyframeArtifactIds: keyframeIds,
        transcriptArtifactId,
        audioArtifactId,
      },
    }, sourceTexts.join('\n\n'), sourceArtifacts);
  }
}
