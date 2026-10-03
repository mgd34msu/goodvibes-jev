import { randomUUID } from 'node:crypto';
import type { AgentModelCompareArtifactStore, LoadedComparisonJudgment, SavedComparisonArtifact, StoredComparison } from './agent-model-compare-types.ts';
import { DEFAULT_SIDE_BY_SIDE_PREVIEW_BYTES, MAX_HANDOFF_ARTIFACT_BYTES } from './agent-model-compare-types.ts';
import { formatComparisonDimensionLines, formatUsage, toSavedComparisonArtifact } from './agent-model-compare-run.ts';
import { isTextLike, readString, previewText } from './agent-model-compare-utils.ts';

export function markdownBlock(value: string): string {
  const fence = value.includes('```') ? '~~~~' : '```';
  return `${fence}\n${value || '(empty)'}\n${fence}`;
}

export function comparisonExportMarkdown(comparison: StoredComparison, reveal: boolean): string {
  const lines = [
    '# Blind Model Comparison',
    '',
    `Comparison: ${comparison.comparisonId}`,
    `Created: ${comparison.createdAt}`,
    `Prompt: ${comparison.promptPreview}`,
    `Rubric: ${comparison.rubric || '(none)'}`,
    ...(comparison.sourceArtifact ? [`Source artifact: ${comparison.sourceArtifact.artifactId} (${comparison.sourceArtifact.mimeType}, ${comparison.sourceArtifact.sizeBytes} bytes)`] : []),
    ...(comparison.benchmarkKind ? [`Benchmark: ${comparison.benchmarkKind}`] : []),
    ...(comparison.taskType ? [`Task type: ${comparison.taskType}`] : []),
    ...(comparison.documentId ? [`Document: ${comparison.documentId}`] : []),
    `Reveal included: ${reveal ? 'yes' : 'no'}`,
    '',
    '## Candidates',
    '',
  ];
  for (const candidate of comparison.candidates) {
    lines.push(`### Candidate ${candidate.blindId}`);
    lines.push('');
    lines.push(`Status: ${candidate.status}`);
    lines.push(`Latency: ${candidate.latencyMs}ms`);
    if (reveal) lines.push(`Model: ${candidate.model.registryKey} (${candidate.model.displayName})`);
    if (candidate.status === 'failed') {
      lines.push(`Error: ${reveal ? candidate.error ?? 'unknown' : 'Provider-specific error hidden until reveal.'}`);
      lines.push('');
      continue;
    }
    lines.push(`Stop: ${candidate.stopReason ?? 'unknown'}`);
    lines.push(`Usage: ${formatUsage(candidate.usage)}`);
    lines.push('');
    lines.push(markdownBlock(candidate.content));
    lines.push('');
  }
  lines.push('## Decision Worksheet');
  lines.push('');
  lines.push('- Winner:');
  lines.push('- Reasons:');
  lines.push('- Risks:');
  lines.push('');
  return lines.join('\n');
}

export function judgmentExportMarkdown(judgment: LoadedComparisonJudgment): string {
  const lines = [
    '# Blind Model Comparison Judgment',
    '',
    `Judgment: ${judgment.judgmentId}`,
    `Comparison: ${judgment.comparisonId}`,
    `Winner: Candidate ${judgment.winnerBlindId}`,
    ...(judgment.winnerModel ? [`Winner model: ${judgment.winnerModel.registryKey} (${judgment.winnerModel.displayName})`] : ['Winner model: (not revealed in judgment)']),
    '',
    '## Reasons',
    '',
    judgment.reasons || '(none)',
    '',
  ];
  if (judgment.notes) {
    lines.push('## Notes');
    lines.push('');
    lines.push(judgment.notes);
    lines.push('');
  }
  lines.push('## Route Update');
  lines.push('');
  if (judgment.winnerModel) {
    lines.push(`Confirmed apply route: agent_model_compare mode:"apply" artifactId:"${judgment.artifact.artifactId}" confirm:true explicitUserRequest:"..."`);
  } else {
    lines.push('Save or reveal the judgment before applying a model route update.');
  }
  lines.push('');
  return lines.join('\n');
}

export async function saveComparisonExportArtifact(input: {
  readonly artifactStore?: AgentModelCompareArtifactStore;
  readonly sourceArtifactId: string;
  readonly sourceKind: 'comparison' | 'judgment';
  readonly comparisonId: string;
  readonly markdown: string;
  readonly reveal: boolean;
}): Promise<SavedComparisonArtifact> {
  if (!input.artifactStore) throw new Error('Cannot export comparison because the artifact store is unavailable.');
  const exportId = `exp_${randomUUID()}`;
  const descriptor = await input.artifactStore.create({
    kind: 'data',
    mimeType: 'text/markdown',
    filename: `blind-model-comparison-export-${exportId}.md`,
    text: input.markdown,
    metadata: {
      purpose: 'agent-model-compare-export',
      exportId,
      sourceArtifactId: input.sourceArtifactId,
      sourceKind: input.sourceKind,
      comparisonId: input.comparisonId,
      revealIncludedInExport: input.reveal,
    },
  });
  return toSavedComparisonArtifact(descriptor);
}

export async function loadHandoffRelatedArtifacts(
  artifactStore: AgentModelCompareArtifactStore | undefined,
  artifactIds: readonly string[],
  maxBytes = MAX_HANDOFF_ARTIFACT_BYTES,
): Promise<readonly { readonly artifact: SavedComparisonArtifact; readonly text?: string; readonly truncatedBytes: number }[]> {
  if (!artifactStore?.readContent) {
    throw new Error('Reviewer handoff requires an artifact store with readContent support.');
  }
  const related: { readonly artifact: SavedComparisonArtifact; readonly text?: string; readonly truncatedBytes: number }[] = [];
  for (const artifactId of artifactIds) {
    const { record, buffer } = await artifactStore.readContent(artifactId);
    const artifact = toSavedComparisonArtifact(record);
    if (!isTextLike(record.mimeType)) {
      related.push({ artifact, truncatedBytes: 0 });
      continue;
    }
    const sliced = buffer.subarray(0, Math.min(buffer.byteLength, maxBytes));
    related.push({
      artifact,
      text: sliced.toString('utf-8').replace(/\0/g, '').trimEnd(),
      truncatedBytes: Math.max(0, buffer.byteLength - sliced.byteLength),
    });
  }
  return related;
}

export function comparisonHandoffMarkdown(input: {
  readonly sourceKind: 'comparison' | 'judgment';
  readonly sourceArtifactId: string;
  readonly comparisonId: string;
  readonly comparisonMarkdown: string;
  readonly reveal: boolean;
  readonly relatedArtifacts: readonly { readonly artifact: SavedComparisonArtifact; readonly text?: string; readonly truncatedBytes: number }[];
}): string {
  const lines = [
    '# Blind Model Comparison Reviewer Handoff',
    '',
    `Comparison: ${input.comparisonId}`,
    `Comparison artifact: ${input.sourceArtifactId}`,
    `Comparison artifact kind: ${input.sourceKind}`,
    `Reveal included: ${input.reveal ? 'yes' : 'no'}`,
    `Related artifacts: ${input.relatedArtifacts.length}`,
    '',
    '## Handoff Policy',
    '',
    '- This packet is local reviewer evidence.',
    '- It does not change model routing.',
    '- Route changes require a separate confirmed `agent_model_compare mode:"apply"` call.',
    '',
    '## Related Artifacts',
    '',
  ];
  for (const related of input.relatedArtifacts) {
    lines.push(`### ${related.artifact.artifactId}`);
    lines.push('');
    lines.push(`Filename: ${related.artifact.filename ?? '(none)'}`);
    lines.push(`MIME: ${related.artifact.mimeType}`);
    lines.push(`Size: ${related.artifact.sizeBytes} bytes`);
    lines.push('');
    if (related.text === undefined) {
      lines.push('_Content omitted for non-text artifact; binary/base64 bytes were not included._');
    } else {
      lines.push(markdownBlock(related.text || '(empty text artifact)'));
      if (related.truncatedBytes > 0) {
        lines.push('');
        lines.push(`_Truncated ${related.truncatedBytes} byte(s) from this artifact preview._`);
      }
    }
    lines.push('');
  }
  lines.push('## Comparison Evidence');
  lines.push('');
  lines.push(input.comparisonMarkdown);
  lines.push('');
  return lines.join('\n');
}

export function formatRelatedArtifactEvidence(input: {
  readonly artifacts: readonly { readonly artifact: SavedComparisonArtifact; readonly text?: string; readonly truncatedBytes: number }[];
  readonly previewBytes: number;
}): readonly string[] {
  if (input.artifacts.length === 0) return ['  No related artifacts were provided.'];
  const lines: string[] = [];
  for (const related of input.artifacts) {
    lines.push(`  ${related.artifact.artifactId}${related.artifact.filename ? ` ${related.artifact.filename}` : ''} (${related.artifact.mimeType}, ${related.artifact.sizeBytes} bytes)`);
    if (related.text === undefined) {
      lines.push('    non-text artifact; content omitted');
      continue;
    }
    const excerpt = previewText(related.text || '(empty text artifact)', input.previewBytes)
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n');
    lines.push(excerpt);
    if (related.truncatedBytes > 0) lines.push(`    truncated ${related.truncatedBytes} byte(s)`);
  }
  return lines;
}

export function formatComparisonEvidencePane(input: {
  readonly comparison?: StoredComparison;
  readonly judgment?: LoadedComparisonJudgment;
  readonly reveal: boolean;
  readonly previewBytes: number;
}): readonly string[] {
  if (input.judgment) {
    const judgment = input.judgment;
    return [
      `  judgment ${judgment.judgmentId}`,
      `  comparison ${judgment.comparisonId}`,
      `  winner Candidate ${judgment.winnerBlindId}`,
      `  winner model ${judgment.winnerModel ? `${judgment.winnerModel.registryKey} (${judgment.winnerModel.displayName})` : '(not revealed)'}`,
      ...(judgment.benchmarkKind ? [`  benchmark ${judgment.benchmarkKind}`] : []),
      ...(judgment.taskType ? [`  task type ${judgment.taskType}`] : []),
      ...(judgment.documentId ? [`  document ${judgment.documentId}`] : []),
      `  reasons ${previewText(judgment.reasons || '(none)', input.previewBytes)}`,
      ...(judgment.notes ? [`  notes ${previewText(judgment.notes, input.previewBytes)}`] : []),
    ];
  }
  const comparison = input.comparison;
  if (!comparison) return ['  No comparison evidence loaded.'];
  const lines = [
    `  comparison ${comparison.comparisonId}`,
    `  prompt ${comparison.promptPreview}`,
    `  rubric ${comparison.rubric || '(none)'}`,
    ...formatComparisonDimensionLines(comparison).map((line) => `  ${line}`),
    `  candidates ${comparison.candidates.length}`,
  ];
  for (const candidate of comparison.candidates) {
    lines.push(`  Candidate ${candidate.blindId}: ${candidate.status}; latency ${candidate.latencyMs}ms`);
    if (input.reveal) lines.push(`    model ${candidate.model.registryKey} (${candidate.model.displayName})`);
    if (candidate.status === 'failed') {
      lines.push(`    error ${input.reveal ? candidate.error ?? 'unknown' : 'Provider-specific error hidden until reveal.'}`);
      continue;
    }
    lines.push(`    output ${previewText(candidate.content || '(empty)', input.previewBytes)}`);
  }
  return lines;
}

export function formatSideBySideReview(input: {
  readonly sourceKind: 'comparison' | 'judgment';
  readonly sourceArtifactId: string;
  readonly comparisonId: string;
  readonly comparison?: StoredComparison;
  readonly judgment?: LoadedComparisonJudgment;
  readonly reveal: boolean;
  readonly relatedArtifacts: readonly { readonly artifact: SavedComparisonArtifact; readonly text?: string; readonly truncatedBytes: number }[];
  readonly previewBytes: number;
}): string {
  return [
    'Blind model comparison side-by-side reviewer view',
    `comparison ${input.comparisonId}`,
    `source ${input.sourceArtifactId} (${input.sourceKind})`,
    `related artifacts ${input.relatedArtifacts.length}`,
    `preview bytes ${input.previewBytes}`,
    '',
    'Left pane: related document/artifact evidence',
    ...formatRelatedArtifactEvidence({ artifacts: input.relatedArtifacts, previewBytes: input.previewBytes }),
    '',
    'Right pane: comparison evidence',
    ...formatComparisonEvidencePane({
      comparison: input.comparison,
      judgment: input.judgment,
      reveal: input.reveal,
      previewBytes: input.previewBytes,
    }),
    '',
    'Reviewer next actions',
    `  create handoff agent_model_compare mode:"handoff" artifactId:"${input.sourceArtifactId}" relatedArtifactIds:${JSON.stringify(input.relatedArtifacts.map((entry) => entry.artifact.artifactId))} confirm:true explicitUserRequest:"..."`,
    `  export report agent_model_compare mode:"export" artifactId:"${input.sourceArtifactId}" confirm:true explicitUserRequest:"..."`,
    'No selected model was changed.',
  ].join('\n');
}

export async function saveComparisonHandoffArtifact(input: {
  readonly artifactStore?: AgentModelCompareArtifactStore;
  readonly sourceArtifactId: string;
  readonly sourceKind: 'comparison' | 'judgment';
  readonly comparisonId: string;
  readonly relatedArtifactIds: readonly string[];
  readonly markdown: string;
  readonly reveal: boolean;
}): Promise<SavedComparisonArtifact> {
  if (!input.artifactStore) throw new Error('Cannot create reviewer handoff because the artifact store is unavailable.');
  const handoffId = `hnd_${randomUUID()}`;
  const descriptor = await input.artifactStore.create({
    kind: 'data',
    mimeType: 'text/markdown',
    filename: `blind-model-comparison-handoff-${handoffId}.md`,
    text: input.markdown,
    metadata: {
      purpose: 'agent-model-compare-handoff',
      handoffId,
      sourceArtifactId: input.sourceArtifactId,
      sourceKind: input.sourceKind,
      relatedArtifactIds: input.relatedArtifactIds,
      comparisonId: input.comparisonId,
      revealIncludedInHandoff: input.reveal,
    },
  });
  return toSavedComparisonArtifact(descriptor);
}
