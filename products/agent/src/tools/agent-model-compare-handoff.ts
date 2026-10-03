import { randomUUID } from 'node:crypto';
import type { ArtifactRecord } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { createZipArchive, packageArtifactFilename, sanitizeArtifactMetadata, sanitizeArtifactSourceUri, type ArtifactPackageEntry } from './artifact-archive.ts';
import type { AgentModelCompareArtifactStore, LoadedComparisonHandoff, SavedComparisonArtifact } from './agent-model-compare-types.ts';
import { MAX_HANDOFF_ARCHIVE_ARTIFACTS, MAX_HANDOFF_ARTIFACT_BYTES, MAX_HANDOFF_DIFF_INPUT_LINES, MAX_HANDOFF_DIFF_ROWS, MAX_HANDOFF_DIFF_SECTION_PREVIEW_CHARS } from './agent-model-compare-types.ts';
import { isModelCompareHandoffArtifact, isModelCompareRouteDecisionArtifact, toSavedComparisonArtifact } from './agent-model-compare-run.ts';
import { isTextLike, readString, readStringList, previewText } from './agent-model-compare-utils.ts';

export interface LoadedHandoffArchiveArtifact {
  readonly role: 'handoff' | 'source' | 'related' | 'route-decision';
  readonly record: ArtifactRecord;
  readonly buffer: Buffer;
}

export interface ComparisonHandoffArchivePayload {
  readonly artifactCount: number;
  readonly sourceBytes: number;
  readonly includedArtifactIds: readonly string[];
  readonly routeDecisionArtifactIds: readonly string[];
  readonly entries: readonly ArtifactPackageEntry[];
}

export function formatArchiveBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '(unknown)';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export async function loadHandoffFromArtifact(
  artifactStore: AgentModelCompareArtifactStore | undefined,
  artifactId: string,
): Promise<LoadedComparisonHandoff | null> {
  if (!artifactStore?.readContent) return null;
  const { record } = await artifactStore.readContent(artifactId);
  if (!isModelCompareHandoffArtifact(record)) return null;
  const sourceArtifactId = readString(record.metadata.sourceArtifactId);
  if (!sourceArtifactId) {
    throw new Error(`Reviewer handoff ${record.id} is missing sourceArtifactId metadata. Recreate the handoff with mode:"handoff".`);
  }
  const sourceKind = readString(record.metadata.sourceKind) === 'judgment' ? 'judgment' : 'comparison';
  return {
    artifact: toSavedComparisonArtifact(record),
    handoffId: readString(record.metadata.handoffId) || `handoff_from_${record.id}`,
    sourceArtifactId,
    sourceKind,
    comparisonId: readString(record.metadata.comparisonId) || 'unknown-comparison',
    relatedArtifactIds: readStringList(record.metadata.relatedArtifactIds).filter((relatedId) => relatedId !== record.id && relatedId !== sourceArtifactId),
    revealIncludedInHandoff: record.metadata.revealIncludedInHandoff === true,
  };
}

export interface LoadedHandoffDiffArtifact {
  readonly handoff: LoadedComparisonHandoff;
  readonly text: string;
  readonly truncatedBytes: number;
  readonly originalLineCount: number;
}

export interface HandoffDiffRow {
  readonly kind: 'same' | 'left' | 'right';
  readonly text: string;
}

export async function loadHandoffDiffArtifact(
  artifactStore: AgentModelCompareArtifactStore | undefined,
  artifactId: string,
): Promise<LoadedHandoffDiffArtifact | null> {
  if (!artifactStore?.readContent) return null;
  const { record, buffer } = await artifactStore.readContent(artifactId);
  if (!isModelCompareHandoffArtifact(record)) return null;
  if (!isTextLike(record.mimeType)) {
    throw new Error(`Reviewer handoff ${record.id} is ${record.mimeType}; diff can only compare text-like handoff artifacts.`);
  }
  const handoff = await loadHandoffFromArtifact(artifactStore, artifactId);
  if (!handoff) return null;
  const sliced = buffer.subarray(0, Math.min(buffer.byteLength, MAX_HANDOFF_ARTIFACT_BYTES));
  const text = sliced.toString('utf-8').replace(/\0/g, '').trimEnd();
  return {
    handoff,
    text,
    truncatedBytes: Math.max(0, buffer.byteLength - sliced.byteLength),
    originalLineCount: text.split('\n').length,
  };
}

export function normalizedSectionContent(lines: readonly string[]): string {
  return lines.join('\n').replace(/\s+/g, ' ').trim();
}

export function handoffSectionMap(text: string): Map<string, string> {
  const lineMap = handoffSectionLineMap(text);
  const normalized = new Map<string, string>();
  for (const [section, lines] of lineMap) {
    normalized.set(section, normalizedSectionContent(lines));
  }
  return normalized;
}

export function handoffSectionLineMap(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current = '(preamble)';
  let inCodeFence = false;
  sections.set(current, []);
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      sections.get(current)?.push(line);
      inCodeFence = !inCodeFence;
      continue;
    }
    const heading = inCodeFence ? null : /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    const headingText = heading?.[2] ?? '';
    const opensPacketSection = Boolean(heading) && (
      heading![1]!.length === 2
      || (heading![1]!.length === 1 && headingText === 'Blind Model Comparison Reviewer Handoff')
    );
    if (opensPacketSection) {
      current = headingText || '(untitled)';
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    sections.get(current)?.push(line);
  }
  return sections;
}

export function normalizeHandoffSectionAlias(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function resolveHandoffSectionName(sectionId: string, lineMap: Map<string, string[]>): string | null {
  const normalized = normalizeHandoffSectionAlias(sectionId);
  if (!normalized || normalized === 'all' || normalized === 'full') return null;
  if (normalized === 'metadata' || normalized === 'metadatadelta') return 'Metadata delta';
  const aliases = new Map<string, string>([
    ['preamble', '(preamble)'],
    ['header', 'Blind Model Comparison Reviewer Handoff'],
    ['summary', 'Blind Model Comparison Reviewer Handoff'],
    ['overview', 'Blind Model Comparison Reviewer Handoff'],
    ['policy', 'Handoff Policy'],
    ['handoffpolicy', 'Handoff Policy'],
    ['related', 'Related Artifacts'],
    ['relatedartifacts', 'Related Artifacts'],
    ['artifacts', 'Related Artifacts'],
    ['comparison', 'Comparison Evidence'],
    ['comparisonevidence', 'Comparison Evidence'],
    ['evidence', 'Comparison Evidence'],
  ]);
  const aliased = aliases.get(normalized);
  if (aliased && lineMap.has(aliased)) return aliased;
  for (const section of lineMap.keys()) {
    if (normalizeHandoffSectionAlias(section) === normalized) return section;
  }
  return '';
}

export function formatHandoffMetadataDelta(
  label: string,
  left: string | readonly string[] | boolean,
  right: string | readonly string[] | boolean,
): string {
  const leftValue = Array.isArray(left) ? left.join(', ') || '(none)' : String(left === '' ? '(none)' : left);
  const rightValue = Array.isArray(right) ? right.join(', ') || '(none)' : String(right === '' ? '(none)' : right);
  return leftValue === rightValue
    ? `  ${label}: same (${leftValue})`
    : `  ${label}: changed ${leftValue} -> ${rightValue}`;
}

export function buildLineDiff(left: readonly string[], right: readonly string[]): readonly HandoffDiffRow[] {
  const rows = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      rows[leftIndex]![rightIndex] = left[leftIndex] === right[rightIndex]
        ? rows[leftIndex + 1]![rightIndex + 1]! + 1
        : Math.max(rows[leftIndex + 1]![rightIndex]!, rows[leftIndex]![rightIndex + 1]!);
    }
  }

  const diff: HandoffDiffRow[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      diff.push({ kind: 'same', text: left[leftIndex]! });
      leftIndex += 1;
      rightIndex += 1;
    } else if (rows[leftIndex + 1]![rightIndex]! >= rows[leftIndex]![rightIndex + 1]!) {
      diff.push({ kind: 'left', text: left[leftIndex]! });
      leftIndex += 1;
    } else {
      diff.push({ kind: 'right', text: right[rightIndex]! });
      rightIndex += 1;
    }
  }
  while (leftIndex < left.length) {
    diff.push({ kind: 'left', text: left[leftIndex]! });
    leftIndex += 1;
  }
  while (rightIndex < right.length) {
    diff.push({ kind: 'right', text: right[rightIndex]! });
    rightIndex += 1;
  }
  return diff;
}

export function formatHandoffDiffRows(rows: readonly HandoffDiffRow[]): readonly string[] {
  const lines: string[] = [];
  let hiddenUnchanged = 0;
  let emittedChanges = 0;
  let omittedChanges = 0;
  for (const row of rows) {
    if (row.kind === 'same') {
      hiddenUnchanged += 1;
      continue;
    }
    if (emittedChanges >= MAX_HANDOFF_DIFF_ROWS) {
      omittedChanges += 1;
      continue;
    }
    if (hiddenUnchanged > 0) {
      lines.push(`  ... ${hiddenUnchanged} unchanged line(s) hidden`);
      hiddenUnchanged = 0;
    }
    const prefix = row.kind === 'left' ? '- ' : '+ ';
    lines.push(`${prefix}${previewText(row.text || '(blank)', 220)}`);
    emittedChanges += 1;
  }
  if (hiddenUnchanged > 0 && lines.length > 0) lines.push(`  ... ${hiddenUnchanged} unchanged line(s) hidden`);
  if (omittedChanges > 0) lines.push(`  ... ${omittedChanges} changed line(s) omitted by diff row cap`);
  return lines.length > 0 ? lines : ['  No textual changes detected in the bounded handoff preview.'];
}

export function formatHandoffSectionDiff(
  left: LoadedHandoffDiffArtifact,
  right: LoadedHandoffDiffArtifact,
): readonly string[] {
  const leftSections = handoffSectionMap(left.text);
  const rightSections = handoffSectionMap(right.text);
  const sectionNames = Array.from(new Set([...leftSections.keys(), ...rightSections.keys()]));
  if (sectionNames.length === 0) return ['  No markdown sections detected.'];
  return sectionNames.map((section) => {
    const leftValue = leftSections.get(section);
    const rightValue = rightSections.get(section);
    if (leftValue === undefined) return `  ${section}: added on right (${previewText(rightValue ?? '', MAX_HANDOFF_DIFF_SECTION_PREVIEW_CHARS) || 'empty'})`;
    if (rightValue === undefined) return `  ${section}: removed from right (${previewText(leftValue, MAX_HANDOFF_DIFF_SECTION_PREVIEW_CHARS) || 'empty'})`;
    if (leftValue === rightValue) return `  ${section}: same`;
    return `  ${section}: changed`;
  });
}

export function formatHandoffDiff(input: {
  readonly left: LoadedHandoffDiffArtifact;
  readonly right: LoadedHandoffDiffArtifact;
  readonly sectionId?: string;
}): string {
  const leftSectionLines = handoffSectionLineMap(input.left.text);
  const rightSectionLines = handoffSectionLineMap(input.right.text);
  const sectionName = resolveHandoffSectionName(
    input.sectionId ?? '',
    new Map([...leftSectionLines, ...rightSectionLines]),
  );
  const sectionAvailable = sectionName !== '';
  const allSections = ['Metadata delta', ...Array.from(new Set([...leftSectionLines.keys(), ...rightSectionLines.keys()]))]
    .filter((section) => section !== '(preamble)')
    .join(', ');
  const leftRawLines = sectionName
    ? leftSectionLines.get(sectionName) ?? []
    : input.left.text.split('\n');
  const rightRawLines = sectionName
    ? rightSectionLines.get(sectionName) ?? []
    : input.right.text.split('\n');
  const leftLines = leftRawLines.slice(0, MAX_HANDOFF_DIFF_INPUT_LINES);
  const rightLines = rightRawLines.slice(0, MAX_HANDOFF_DIFF_INPUT_LINES);
  const diffRows = buildLineDiff(leftLines, rightLines);
  return [
    'Blind model comparison reviewer handoff visual diff',
    `left ${input.left.handoff.artifact.artifactId} (${input.left.handoff.handoffId})`,
    `right ${input.right.handoff.artifact.artifactId} (${input.right.handoff.handoffId})`,
    `section jump ${sectionName ? sectionName : input.sectionId && !sectionAvailable ? `unmatched ${input.sectionId}` : 'all'}`,
    `available sections ${allSections || '(none)'}`,
    `line window ${leftLines.length}/${input.left.originalLineCount} left, ${rightLines.length}/${input.right.originalLineCount} right`,
    ...(input.left.truncatedBytes > 0 || input.right.truncatedBytes > 0
      ? [`truncated bytes left ${input.left.truncatedBytes}, right ${input.right.truncatedBytes}`]
      : []),
    '',
    'Metadata delta',
    formatHandoffMetadataDelta('comparison', input.left.handoff.comparisonId, input.right.handoff.comparisonId),
    formatHandoffMetadataDelta('source', `${input.left.handoff.sourceArtifactId} (${input.left.handoff.sourceKind})`, `${input.right.handoff.sourceArtifactId} (${input.right.handoff.sourceKind})`),
    formatHandoffMetadataDelta('related artifacts', input.left.handoff.relatedArtifactIds, input.right.handoff.relatedArtifactIds),
    formatHandoffMetadataDelta('reveal included', input.left.handoff.revealIncludedInHandoff, input.right.handoff.revealIncludedInHandoff),
    '',
    'Section delta',
    ...formatHandoffSectionDiff(input.left, input.right),
    '',
    'Aligned line diff',
    ...(sectionAvailable ? formatHandoffDiffRows(diffRows) : [`  Section ${input.sectionId || '(blank)'} was not found. Use all, policy, related, or comparison.`]),
    '',
    'No selected model was changed.',
  ].join('\n');
}

export async function loadHandoffArchiveArtifacts(
  artifactStore: AgentModelCompareArtifactStore | undefined,
  handoff: LoadedComparisonHandoff,
  routeDecisionArtifactIds: readonly string[] = [],
): Promise<readonly LoadedHandoffArchiveArtifact[]> {
  if (!artifactStore?.readContent) {
    throw new Error('Reviewer handoff archive requires an artifact store with readContent support.');
  }
  const requested: Array<{ readonly id: string; readonly role: LoadedHandoffArchiveArtifact['role'] }> = [
    { id: handoff.artifact.artifactId, role: 'handoff' },
    { id: handoff.sourceArtifactId, role: 'source' },
    ...handoff.relatedArtifactIds.map((id) => ({ id, role: 'related' as const })),
    ...routeDecisionArtifactIds.map((id) => ({ id, role: 'route-decision' as const })),
  ];
  const seen = new Set<string>();
  const artifacts: LoadedHandoffArchiveArtifact[] = [];
  for (const request of requested) {
    if (!request.id || seen.has(request.id)) continue;
    seen.add(request.id);
    if (artifacts.length >= MAX_HANDOFF_ARCHIVE_ARTIFACTS) {
      throw new Error(`Reviewer handoff archive supports at most ${MAX_HANDOFF_ARCHIVE_ARTIFACTS} artifacts.`);
    }
    const loaded = await artifactStore.readContent(request.id);
    artifacts.push({ role: request.role, ...loaded });
  }
  return artifacts;
}

export function findRouteDecisionArtifactIdsForHandoff(
  artifactStore: AgentModelCompareArtifactStore | undefined,
  handoff: LoadedComparisonHandoff,
): readonly string[] {
  if (!artifactStore?.list) return [];
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const artifact of artifactStore.list(100).filter(isModelCompareRouteDecisionArtifact)) {
    const judgmentArtifactId = readString(artifact.metadata.judgmentArtifactId);
    const comparisonId = readString(artifact.metadata.comparisonId);
    const matchesSource = handoff.sourceKind === 'judgment'
      ? judgmentArtifactId === handoff.sourceArtifactId
      : comparisonId === handoff.comparisonId;
    if (!matchesSource || seen.has(artifact.id)) continue;
    seen.add(artifact.id);
    matches.push(artifact.id);
  }
  return matches;
}

export function buildComparisonHandoffArchivePayload(input: {
  readonly handoff: LoadedComparisonHandoff;
  readonly artifacts: readonly LoadedHandoffArchiveArtifact[];
}): ComparisonHandoffArchivePayload {
  const usedFilenames = new Set<string>();
  const entries: ArtifactPackageEntry[] = [];
  const manifestArtifacts: Array<Record<string, unknown>> = [];
  const fileLines: string[] = [];
  let sourceBytes = 0;
  const routeDecisionArtifactIds = input.artifacts
    .filter((artifact) => artifact.role === 'route-decision')
    .map((artifact) => artifact.record.id);

  for (let index = 0; index < input.artifacts.length; index += 1) {
    const artifact = input.artifacts[index]!;
    const filename = packageArtifactFilename(artifact.record, index, usedFilenames);
    const relativePath = `artifacts/${artifact.role}/${filename}`;
    entries.push({ path: relativePath, buffer: artifact.buffer });
    sourceBytes += artifact.buffer.byteLength;
    fileLines.push(`- ${artifact.role}: ${artifact.record.id} -> ${relativePath} (${formatArchiveBytes(artifact.buffer.byteLength)}, ${artifact.record.mimeType})`);
    manifestArtifacts.push({
      role: artifact.role,
      id: artifact.record.id,
      file: relativePath,
      originalFilename: artifact.record.filename ?? null,
      kind: artifact.record.kind,
      mimeType: artifact.record.mimeType,
      sizeBytes: artifact.record.sizeBytes,
      copiedBytes: artifact.buffer.byteLength,
      sha256: artifact.record.sha256,
      createdAt: new Date(artifact.record.createdAt).toISOString(),
      expiresAt: artifact.record.expiresAt ? new Date(artifact.record.expiresAt).toISOString() : null,
      acquisitionMode: artifact.record.acquisitionMode,
      fetchMode: artifact.record.fetchMode,
      sourceUri: sanitizeArtifactSourceUri(artifact.record.sourceUri) ?? null,
      metadata: sanitizeArtifactMetadata(artifact.record.metadata),
    });
  }

  const createdAt = new Date().toISOString();
  const manifest = {
    version: 1,
    product: 'goodvibes-agent',
    archiveKind: 'agent-model-compare-handoff',
    createdAt,
    comparisonId: input.handoff.comparisonId,
    handoff: {
      handoffId: input.handoff.handoffId,
      handoffArtifactId: input.handoff.artifact.artifactId,
      sourceArtifactId: input.handoff.sourceArtifactId,
      sourceKind: input.handoff.sourceKind,
      relatedArtifactIds: input.handoff.relatedArtifactIds,
      routeDecisionArtifactIds,
      revealIncludedInHandoff: input.handoff.revealIncludedInHandoff,
    },
    artifactCount: input.artifacts.length,
    sourceBytes,
    policy: {
      content: 'Exact saved artifact bytes copied into artifacts/.',
      transcript: 'Artifact contents are not printed by the compare tool.',
      metadata: 'Secret-like metadata keys and URL query parameters are redacted in this manifest.',
      routeMutation: 'No selected model route is changed by this archive.',
      retention: 'Original saved artifacts are retained in the Agent artifact store.',
    },
    artifacts: manifestArtifacts,
  };

  entries.push({
    path: 'manifest.json',
    buffer: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf-8'),
  });
  entries.push({
    path: 'README.md',
    buffer: Buffer.from(
      [
        '# GoodVibes Agent Comparison Handoff Archive',
        '',
        `Generated: ${createdAt}`,
        `Comparison: ${input.handoff.comparisonId}`,
        `Handoff artifact: ${input.handoff.artifact.artifactId}`,
        `Source artifact: ${input.handoff.sourceArtifactId} (${input.handoff.sourceKind})`,
        `Related artifacts: ${input.handoff.relatedArtifactIds.length}`,
        `Route-decision receipts: ${routeDecisionArtifactIds.length}`,
        `Source bytes: ${sourceBytes}`,
        '',
        'Files',
        ...fileLines,
        '',
        'Manifest',
        '- `manifest.json` contains redacted artifact metadata, archive policy, and file paths.',
        '- Artifact bytes live under `artifacts/` and are copied exactly from the saved Agent artifact store.',
        '- Original artifacts remain saved in Agent. This archive does not change the selected model.',
        '',
      ].join('\n'),
      'utf-8',
    ),
  });

  return {
    artifactCount: input.artifacts.length,
    sourceBytes,
    includedArtifactIds: input.artifacts.map((artifact) => artifact.record.id),
    routeDecisionArtifactIds,
    entries,
  };
}

export async function saveComparisonHandoffArchiveArtifact(input: {
  readonly artifactStore?: AgentModelCompareArtifactStore;
  readonly handoff: LoadedComparisonHandoff;
  readonly payload: ComparisonHandoffArchivePayload;
  readonly archive: Buffer;
}): Promise<SavedComparisonArtifact> {
  if (!input.artifactStore) throw new Error('Cannot create reviewer handoff archive because the artifact store is unavailable.');
  const archiveId = `hndarc_${randomUUID()}`;
  const descriptor = await input.artifactStore.create({
    kind: 'archive',
    mimeType: 'application/zip',
    filename: `blind-model-comparison-handoff-archive-${archiveId}.zip`,
    dataBase64: input.archive.toString('base64'),
    metadata: {
      purpose: 'agent-model-compare-handoff-archive',
      archiveId,
      handoffArtifactId: input.handoff.artifact.artifactId,
      handoffId: input.handoff.handoffId,
      sourceArtifactId: input.handoff.sourceArtifactId,
      sourceKind: input.handoff.sourceKind,
      relatedArtifactIds: input.handoff.relatedArtifactIds,
      routeDecisionArtifactIds: input.payload.routeDecisionArtifactIds,
      includedArtifactIds: input.payload.includedArtifactIds,
      comparisonId: input.handoff.comparisonId,
      artifactCount: input.payload.artifactCount,
      sourceBytes: input.payload.sourceBytes,
      archiveBytes: input.archive.byteLength,
      revealIncludedInHandoff: input.handoff.revealIncludedInHandoff,
    },
  });
  return toSavedComparisonArtifact(descriptor);
}

export function formatExportPreview(input: {
  readonly sourceKind: 'comparison' | 'judgment';
  readonly sourceArtifactId: string;
  readonly comparisonId: string;
  readonly reveal: boolean;
}): string {
  return [
    'Agent blind model comparison export preview',
    `  source ${input.sourceArtifactId} (${input.sourceKind})`,
    `  comparison ${input.comparisonId}`,
    `  format markdown`,
    `  reveal ${input.reveal ? 'include model identities when available' : 'keep model identities hidden'}`,
    '  policy creates one local markdown artifact and does not change model routing',
  ].join('\n');
}

export function formatHandoffPreview(input: {
  readonly sourceKind: 'comparison' | 'judgment';
  readonly sourceArtifactId: string;
  readonly comparisonId: string;
  readonly reveal: boolean;
  readonly relatedArtifactIds: readonly string[];
}): string {
  return [
    'Agent blind model comparison reviewer handoff preview',
    `  source ${input.sourceArtifactId} (${input.sourceKind})`,
    `  comparison ${input.comparisonId}`,
    `  related artifacts ${input.relatedArtifactIds.join(', ') || '(missing)'}`,
    `  reveal ${input.reveal ? 'include model identities when available' : 'keep model identities hidden'}`,
    '  policy creates one local markdown handoff artifact and does not change model routing',
  ].join('\n');
}

export function formatHandoffArchivePreview(input: {
  readonly handoff: LoadedComparisonHandoff;
  readonly routeDecisionArtifactIds: readonly string[];
}): string {
  return [
    'Agent blind model comparison reviewer handoff archive preview',
    `  handoff ${input.handoff.artifact.artifactId} (${input.handoff.handoffId})`,
    `  comparison ${input.handoff.comparisonId}`,
    `  source ${input.handoff.sourceArtifactId} (${input.handoff.sourceKind})`,
    `  related artifacts ${input.handoff.relatedArtifactIds.join(', ') || '(none)'}`,
    `  route-decision receipts ${input.routeDecisionArtifactIds.join(', ') || '(none)'}`,
    `  reveal ${input.handoff.revealIncludedInHandoff ? 'handoff includes model identities when available' : 'handoff keeps model identities hidden'}`,
    '  policy creates one local ZIP artifact with exact handoff/source/evidence bytes, redacted manifest metadata, and no model route change',
  ].join('\n');
}

export function formatExportResult(input: {
  readonly sourceKind: 'comparison' | 'judgment';
  readonly sourceArtifactId: string;
  readonly comparisonId: string;
  readonly artifact: SavedComparisonArtifact;
}): string {
  return [
    `Blind model comparison export saved for ${input.comparisonId}`,
    `source ${input.sourceArtifactId} (${input.sourceKind})`,
    `artifact ${input.artifact.artifactId}${input.artifact.filename ? ` ${input.artifact.filename}` : ''} (${input.artifact.mimeType}, ${input.artifact.sizeBytes} bytes)`,
    'No selected model was changed.',
  ].join('\n');
}

export function formatHandoffResult(input: {
  readonly sourceKind: 'comparison' | 'judgment';
  readonly sourceArtifactId: string;
  readonly comparisonId: string;
  readonly relatedArtifactCount: number;
  readonly artifact: SavedComparisonArtifact;
}): string {
  return [
    `Blind model comparison reviewer handoff saved for ${input.comparisonId}`,
    `source ${input.sourceArtifactId} (${input.sourceKind})`,
    `related artifacts ${input.relatedArtifactCount}`,
    `artifact ${input.artifact.artifactId}${input.artifact.filename ? ` ${input.artifact.filename}` : ''} (${input.artifact.mimeType}, ${input.artifact.sizeBytes} bytes)`,
    `archive agent_model_compare mode:"handoffArchive" artifactId:"${input.artifact.artifactId}" confirm:true explicitUserRequest:"..."`,
    'No selected model was changed.',
  ].join('\n');
}

export function formatHandoffArchiveResult(input: {
  readonly handoff: LoadedComparisonHandoff;
  readonly artifact: SavedComparisonArtifact;
  readonly artifactCount: number;
  readonly routeDecisionArtifactCount: number;
  readonly sourceBytes: number;
  readonly archiveBytes: number;
}): string {
  const exportPath = `exports/${input.artifact.filename ?? `${input.artifact.artifactId}.zip`}`;
  return [
    `Blind model comparison reviewer handoff archive saved for ${input.handoff.comparisonId}`,
    `handoff ${input.handoff.artifact.artifactId} (${input.handoff.handoffId})`,
    `source ${input.handoff.sourceArtifactId} (${input.handoff.sourceKind})`,
    `related artifacts ${input.handoff.relatedArtifactIds.length}`,
    `route-decision receipts ${input.routeDecisionArtifactCount}`,
    `included artifacts ${input.artifactCount}`,
    `source bytes ${formatArchiveBytes(input.sourceBytes)}`,
    `archive ${input.artifact.artifactId}${input.artifact.filename ? ` ${input.artifact.filename}` : ''} (${input.artifact.mimeType}, ${input.archiveBytes} bytes)`,
    `export agent_artifacts mode:"export" artifactId:"${input.artifact.artifactId}" destinationPath:"${exportPath}" confirm:true explicitUserRequest:"..."`,
    'policy exact saved artifact bytes packaged; manifest metadata redacted; original artifacts retained',
    'No selected model was changed.',
  ].join('\n');
}
