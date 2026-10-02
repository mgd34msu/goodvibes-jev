import { randomUUID } from 'node:crypto';
import type { ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { DEFAULT_LIST_LIMIT, MAX_FRESHNESS_ARTIFACT_SCAN, MAX_LIST_LIMIT, REVIEW_PACKET_PRESET_SCHEMA, auditPresetFreshness, buildPresetRecord, clamp, compactText, defaultPacketSummary, isPresetArtifact, packetFromMetadata, parseMode, parsePresetBody, presetCreateInput, readBoolean, readMetadataString, readNumber, readString, sourceArtifactId, type AgentReviewPacketPresetArtifactStore, type AgentReviewPacketPresetsToolArgs, type LoadedReviewPacketPreset, type ReviewPacketFreshnessAudit, type ReviewPacketPresetPacket, type ReviewPacketPresetRecord } from './agent-review-packet-presets-core.ts';
function formatPacketLines(packet: ReviewPacketPresetPacket): readonly string[] {
  return [
    `  summary ${packet.summary}`,
    packet.documentId ? `  document ${packet.documentId}${packet.documentTitle ? ` (${packet.documentTitle})` : ''}` : '',
    packet.documentExportArtifactId ? `  documentExport ${packet.documentExportArtifactId}` : '',
    packet.comparisonArtifactId ? `  comparison ${packet.comparisonArtifactId}` : '',
    packet.judgmentArtifactId ? `  judgment ${packet.judgmentArtifactId}` : '',
    packet.revealedJudgmentArtifactId ? `  revealedJudgment ${packet.revealedJudgmentArtifactId}` : '',
    packet.routeDecisionArtifactId ? `  routeDecision ${packet.routeDecisionArtifactId}${packet.routeDecision ? ` (${packet.routeDecision})` : ''}` : '',
    packet.handoffArtifactId ? `  handoff ${packet.handoffArtifactId}` : '',
    packet.handoffArchiveArtifactId ? `  handoffArchive ${packet.handoffArchiveArtifactId}` : '',
    `  related ${packet.relatedArtifactIds.length > 0 ? packet.relatedArtifactIds.join(', ') : '(none)'}`,
  ].filter(Boolean);
}

function formatPresetPreview(record: ReviewPacketPresetRecord): string {
  return [
    'Agent review packet preset preview',
    `  name ${record.name}`,
    `  preset ${record.presetId}`,
    ...formatPacketLines(record.packet),
    '  policy save one local preset artifact only; documents, model routing, handoffs, and archives are unchanged',
  ].join('\n');
}

function formatSaveResult(descriptor: ArtifactDescriptor, record: ReviewPacketPresetRecord): string {
  return [
    'Review packet preset saved',
    `  artifact ${descriptor.id}`,
    `  preset ${record.presetId}`,
    `  name ${record.name}`,
    ...formatPacketLines(record.packet),
    `  inspect agent_review_packet_presets mode:"show" artifactId:"${descriptor.id}"`,
    '  list agent_review_packet_presets mode:"list"',
    '  policy local preset artifact only; documents, model routing, handoffs, and archives unchanged',
  ].join('\n');
}

function packetReferenceFingerprint(packet: ReviewPacketPresetPacket): string {
  return JSON.stringify({
    documentId: packet.documentId ?? '',
    documentTitle: packet.documentTitle ?? '',
    documentExportArtifactId: packet.documentExportArtifactId ?? '',
    comparisonArtifactId: packet.comparisonArtifactId ?? '',
    judgmentArtifactId: packet.judgmentArtifactId ?? '',
    revealedJudgmentArtifactId: packet.revealedJudgmentArtifactId ?? '',
    routeDecisionArtifactId: packet.routeDecisionArtifactId ?? '',
    routeDecision: packet.routeDecision ?? '',
    handoffArtifactId: packet.handoffArtifactId ?? '',
    handoffArchiveArtifactId: packet.handoffArchiveArtifactId ?? '',
    relatedArtifactIds: packet.relatedArtifactIds,
  });
}

function hasRefreshableReplacements(audit: ReviewPacketFreshnessAudit): boolean {
  return audit.missing.some((missing) => Boolean(missing.replacementId)) || audit.superseded.length > 0;
}

function unresolvedFreshnessCount(audit: ReviewPacketFreshnessAudit): number {
  return audit.missing.filter((missing) => !missing.replacementId).length;
}

function updateSummaryReferences(summary: string, audit: ReviewPacketFreshnessAudit): string {
  let updated = summary;
  const replace = (from: string, to: string | undefined): void => {
    if (!to || !from || from === to) return;
    updated = updated.split(from).join(to);
  };
  for (const missing of audit.missing) replace(missing.id, missing.replacementId);
  for (const superseded of audit.superseded) replace(superseded.id, superseded.replacementId);
  return updated.trim();
}

function refreshedPacket(
  original: ReviewPacketPresetPacket,
  audit: ReviewPacketFreshnessAudit,
  explicitSummary: string,
): ReviewPacketPresetPacket {
  const recommended = audit.recommendedPacket;
  const summary = explicitSummary
    || updateSummaryReferences(original.summary, audit)
    || defaultPacketSummary(recommended);
  return { ...recommended, summary };
}

function buildRefreshRecord(input: {
  readonly args: AgentReviewPacketPresetsToolArgs;
  readonly loaded: LoadedReviewPacketPreset;
  readonly audit: ReviewPacketFreshnessAudit;
  readonly packet: ReviewPacketPresetPacket;
}): ReviewPacketPresetRecord {
  const explicitUserRequest = readString(input.args.explicitUserRequest);
  if (!explicitUserRequest) {
    throw new Error('explicitUserRequest is required so refreshed packet presets stay tied to a direct user request.');
  }
  const oldName = input.loaded.body?.name
    || readMetadataString(input.loaded.descriptor.metadata, 'name')
    || input.loaded.descriptor.filename
    || input.loaded.descriptor.id;
  const oldPresetId = input.loaded.body?.presetId || readMetadataString(input.loaded.descriptor.metadata, 'presetId');
  const requestedName = readString(input.args.name);
  return {
    schema: REVIEW_PACKET_PRESET_SCHEMA,
    schemaVersion: 1,
    presetId: `packet_preset_${randomUUID()}`,
    name: requestedName || `${oldName} refreshed`,
    createdAt: new Date().toISOString(),
    explicitUserRequest,
    packet: refreshedPacket(input.packet, input.audit, readString(input.args.summary)),
    refresh: {
      sourceArtifactId: input.loaded.descriptor.id,
      ...(oldPresetId ? { sourcePresetId: oldPresetId } : {}),
      missingCount: input.audit.missing.length,
      supersededCount: input.audit.superseded.length,
      unresolvedCount: unresolvedFreshnessCount(input.audit),
    },
    policy: {
      effect: 'save-local-preset-artifact-only',
      documentsChanged: false,
      modelRouteChanged: false,
      handoffArchiveCreated: false,
    },
  };
}

function formatRefreshPreview(
  source: LoadedReviewPacketPreset,
  audit: ReviewPacketFreshnessAudit,
  record: ReviewPacketPresetRecord,
): string {
  return [
    'Agent review packet preset refresh preview',
    `  refreshOf ${source.descriptor.id}`,
    `  name ${record.name}`,
    ...formatFreshnessLines(audit),
    '  refreshed packet',
    ...formatPacketLines(record.packet),
    '  policy save one new local preset artifact only; source preset, documents, model routing, handoffs, and archives are unchanged',
  ].join('\n');
}

function formatRefreshResult(
  descriptor: ArtifactDescriptor,
  source: LoadedReviewPacketPreset,
  audit: ReviewPacketFreshnessAudit,
  record: ReviewPacketPresetRecord,
): string {
  return [
    'Review packet preset refreshed',
    `  artifact ${descriptor.id}`,
    `  refreshedFrom ${source.descriptor.id}`,
    `  preset ${record.presetId}`,
    `  name ${record.name}`,
    ...formatPacketLines(record.packet),
    `  freshness repaired ${audit.missing.filter((missing) => Boolean(missing.replacementId)).length + audit.superseded.length}; unresolved ${unresolvedFreshnessCount(audit)}`,
    `  inspect agent_review_packet_presets mode:"show" artifactId:"${descriptor.id}"`,
    '  policy local preset artifact only; source preset, documents, model routing, handoffs, and archives unchanged',
  ].join('\n');
}

function formatAlreadyCurrent(source: LoadedReviewPacketPreset, audit: ReviewPacketFreshnessAudit): string {
  return [
    'Review packet preset already current',
    `  artifact ${source.descriptor.id}`,
    `  ${formatFreshnessSummary(audit)}`,
    '  no new preset artifact created',
    '  policy documents, model routing, handoffs, and archives unchanged',
  ].join('\n');
}

function formatFreshnessSummary(audit: ReviewPacketFreshnessAudit): string {
  if (!audit.available) return 'freshness unchecked; artifact list unavailable';
  if (audit.status === 'current') return `freshness current; checked ${audit.scannedArtifacts} artifact(s)`;
  return `freshness needs-review; missing ${audit.missing.length}; newer ${audit.superseded.length}; checked ${audit.scannedArtifacts} artifact(s)`;
}

function formatFreshnessLines(audit: ReviewPacketFreshnessAudit): readonly string[] {
  if (!audit.available) return ['  freshness unchecked; artifact list unavailable'];
  const lines = [`  ${formatFreshnessSummary(audit)}`];
  for (const missing of audit.missing.slice(0, 8)) {
    lines.push(
      `  missing ${missing.label} ${missing.id}${missing.replacementId ? `; recommended ${missing.replacementId} (${missing.reason ?? 'matching artifact'})` : ''}`,
    );
  }
  for (const superseded of audit.superseded.slice(0, 8)) {
    lines.push(`  newer ${superseded.label} ${superseded.id} -> ${superseded.replacementId} (${superseded.reason})`);
  }
  const shownMissing = Math.min(audit.missing.length, 8);
  const shownSuperseded = Math.min(audit.superseded.length, 8);
  const hidden = Math.max(0, audit.missing.length + audit.superseded.length - shownMissing - shownSuperseded);
  if (hidden > 0) lines.push(`  freshness omitted ${hidden} additional issue(s)`);
  if (audit.status === 'needs-review') {
    lines.push('  policy inspect freshness before reuse; recommended routes below use newer ids when a safe replacement was found');
  }
  return lines;
}

function formatList(
  artifacts: readonly ArtifactDescriptor[],
  total: number,
  allArtifacts: readonly ArtifactDescriptor[] | null,
  store?: AgentReviewPacketPresetArtifactStore,
): string {
  if (artifacts.length === 0) {
    return [
      'Saved review packet presets',
      '  none found',
      '  save agent_review_packet_presets mode:"save" name:"..." confirm:true explicitUserRequest:"..."',
    ].join('\n');
  }
  return [
    'Saved review packet presets',
    `  shown ${artifacts.length}/${total}`,
    ...artifacts.flatMap((artifact) => {
      const packet = packetFromMetadata(artifact);
      const audit = auditPresetFreshness({ packet, descriptor: artifact, artifacts: allArtifacts, store });
      const name = readMetadataString(artifact.metadata, 'name') || artifact.filename || artifact.id;
      const source = sourceArtifactId(packet) || '(no source)';
      return [
        `  - ${artifact.id}: ${name}`,
        `    summary ${compactText(packet.summary, 120)}`,
        `    document ${packet.documentId ?? '(none)'}; source ${source}; handoff ${packet.handoffArtifactId ?? '(none)'}; archive ${packet.handoffArchiveArtifactId ?? '(none)'}; related ${packet.relatedArtifactIds.length}`,
        `    ${formatFreshnessSummary(audit)}`,
        audit.status === 'needs-review' && hasRefreshableReplacements(audit)
          ? `    refresh agent_review_packet_presets mode:"refresh" artifactId:"${artifact.id}" confirm:true explicitUserRequest:"..."`
          : '',
        `    inspect agent_review_packet_presets mode:"show" artifactId:"${artifact.id}"`,
      ].filter(Boolean);
    }),
  ].join('\n');
}

function formatShow(loaded: LoadedReviewPacketPreset, audit: ReviewPacketFreshnessAudit): string {
  const packet = loaded.body?.packet ?? packetFromMetadata(loaded.descriptor);
  const routePacket = audit.recommendedPacket;
  const name = loaded.body?.name || readMetadataString(loaded.descriptor.metadata, 'name') || loaded.descriptor.filename || loaded.descriptor.id;
  const presetId = loaded.body?.presetId || readMetadataString(loaded.descriptor.metadata, 'presetId') || loaded.descriptor.id;
  const sourceId = sourceArtifactId(routePacket);
  const related = JSON.stringify(routePacket.relatedArtifactIds);
  return [
    'Saved review packet preset',
    `  artifact ${loaded.descriptor.id}`,
    `  preset ${presetId}`,
    `  name ${name}`,
    ...formatPacketLines(packet),
    ...formatFreshnessLines(audit),
    loaded.body?.explicitUserRequest ? `  explicitUserRequest ${compactText(loaded.body.explicitUserRequest, 140)}` : '',
    sourceId ? `  sideBySide agent_model_compare mode:"sideBySide" artifactId:"${sourceId}" relatedArtifactIds:${related}` : '',
    sourceId ? `  handoff agent_model_compare mode:"handoff" artifactId:"${sourceId}" relatedArtifactIds:${related} confirm:true explicitUserRequest:"..."` : '',
    routePacket.revealedJudgmentArtifactId ? `  routeDecision agent_model_compare mode:"routeDecision" artifactId:"${routePacket.revealedJudgmentArtifactId}" decision:"left-unchanged" confirm:true explicitUserRequest:"..."` : '',
    routePacket.handoffArtifactId ? `  archive agent_model_compare mode:"handoffArchive" artifactId:"${routePacket.handoffArtifactId}" confirm:true explicitUserRequest:"..."` : '',
    routePacket.handoffArchiveArtifactId ? `  inspectArchive agent_artifacts mode:"show" artifactId:"${routePacket.handoffArchiveArtifactId}"` : '',
    audit.status === 'needs-review' && hasRefreshableReplacements(audit)
      ? `  refreshPreset agent_review_packet_presets mode:"refresh" artifactId:"${loaded.descriptor.id}" confirm:true explicitUserRequest:"..."`
      : '',
    '  policy read-only inspection; reuse routes still require explicit confirmation where shown',
  ].filter(Boolean).join('\n');
}

async function loadPresetArtifact(
  store: AgentReviewPacketPresetArtifactStore,
  artifactId: string,
): Promise<LoadedReviewPacketPreset | null> {
  if (store.readContent) {
    const { record, buffer } = await store.readContent(artifactId);
    if (!isPresetArtifact(record)) return null;
    return { descriptor: record, record, body: parsePresetBody(buffer) ?? undefined };
  }
  const descriptor = store.list?.(200).find((artifact) => artifact.id === artifactId) ?? null;
  if (!descriptor || !isPresetArtifact(descriptor)) return null;
  return { descriptor };
}

export function createAgentReviewPacketPresetsTool(
  artifactStore?: AgentReviewPacketPresetArtifactStore,
): Tool {
  return {
    definition: {
      name: 'agent_review_packet_presets',
      description: 'Save and refresh reusable Document Ops packet presets.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['list', 'show', 'save', 'refresh'],
            description: 'List, show, save, or refresh one review packet preset.',
          },
          artifactId: {
            type: 'string',
            description: 'Saved preset artifact id for show or refresh mode.',
          },
          name: {
            type: 'string',
            description: 'Human-friendly preset name for save or refresh mode.',
          },
          documentId: {
            type: 'string',
            description: 'Agent document draft id captured by the preset.',
          },
          documentTitle: {
            type: 'string',
            description: 'Optional document title captured by the preset.',
          },
          documentExportArtifactId: {
            type: 'string',
            description: 'Exported document evidence artifact id.',
          },
          comparisonArtifactId: {
            type: 'string',
            description: 'Saved blind comparison artifact id.',
          },
          judgmentArtifactId: {
            type: 'string',
            description: 'Saved comparison judgment artifact id.',
          },
          revealedJudgmentArtifactId: {
            type: 'string',
            description: 'Revealed judgment artifact id for route decisions.',
          },
          routeDecisionArtifactId: {
            type: 'string',
            description: 'Saved route-decision receipt artifact id.',
          },
          routeDecision: {
            type: 'string',
            description: 'Route decision label such as left-unchanged.',
          },
          handoffArtifactId: {
            type: 'string',
            description: 'Reviewer handoff artifact id.',
          },
          handoffArchiveArtifactId: {
            type: 'string',
            description: 'Final reviewer handoff ZIP artifact id.',
          },
          relatedArtifactIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Related evidence artifact ids to reuse.',
          },
          summary: {
            type: 'string',
            description: 'Short preset summary.',
          },
          limit: {
            type: 'number',
            description: 'Maximum presets to list.',
          },
          confirm: {
            type: 'boolean',
            description: 'Required true for save or refresh mode.',
          },
          explicitUserRequest: {
            type: 'string',
            description: 'User request authorizing preset save or refresh.',
          },
        },
        required: ['mode'],
        additionalProperties: false,
      },
      sideEffects: ['state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs: Record<string, unknown>) => {
      const args = rawArgs as AgentReviewPacketPresetsToolArgs;
      try {
        const mode = parseMode(args.mode);
        if (mode === 'list') {
          if (!artifactStore?.list) return failure('Review packet preset list is unavailable because this runtime cannot list artifacts.');
          const limit = clamp(readNumber(args.limit, DEFAULT_LIST_LIMIT), 1, MAX_LIST_LIMIT);
          const allArtifacts = artifactStore.list(Math.max(MAX_FRESHNESS_ARTIFACT_SCAN, limit * 4));
          const source = allArtifacts.filter(isPresetArtifact);
          const ordered = source.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
          return output(formatList(ordered.slice(0, limit), source.length, allArtifacts, artifactStore));
        }
        if (mode === 'show') {
          const artifactId = readString(args.artifactId);
          if (!artifactId) return failure('artifactId is required for mode:"show".');
          if (!artifactStore?.readContent && !artifactStore?.list) return failure('Review packet preset show is unavailable because this runtime cannot read or list artifacts.');
          const loaded = await loadPresetArtifact(artifactStore, artifactId);
          if (!loaded) return failure(`Unknown review packet preset artifact ${artifactId}. Use agent_review_packet_presets mode:"list" first.`);
          const allArtifacts = artifactStore.list?.(MAX_FRESHNESS_ARTIFACT_SCAN) ?? null;
          const packet = loaded.body?.packet ?? packetFromMetadata(loaded.descriptor);
          return output(formatShow(loaded, auditPresetFreshness({
            packet,
            descriptor: loaded.descriptor,
            artifacts: allArtifacts,
            store: artifactStore,
          })));
        }
        if (mode === 'refresh') {
          const artifactId = readString(args.artifactId);
          if (!artifactId) return failure('artifactId is required for mode:"refresh".');
          if (!artifactStore?.create) return failure('Review packet preset refresh is unavailable because this runtime did not provide an artifact store.');
          if (!artifactStore.readContent && !artifactStore.list) return failure('Review packet preset refresh is unavailable because this runtime cannot read or list artifacts.');
          if (!artifactStore.list) return failure('Review packet preset refresh is unavailable because this runtime cannot list artifacts for freshness checks.');
          const loaded = await loadPresetArtifact(artifactStore, artifactId);
          if (!loaded) return failure(`Unknown review packet preset artifact ${artifactId}. Use agent_review_packet_presets mode:"list" first.`);
          const allArtifacts = artifactStore.list(MAX_FRESHNESS_ARTIFACT_SCAN);
          const packet = loaded.body?.packet ?? packetFromMetadata(loaded.descriptor);
          const audit = auditPresetFreshness({
            packet,
            descriptor: loaded.descriptor,
            artifacts: allArtifacts,
            store: artifactStore,
          });
          if (audit.status === 'current') return output(formatAlreadyCurrent(loaded, audit));
          const record = buildRefreshRecord({ args, loaded, audit, packet });
          if (
            !hasRefreshableReplacements(audit)
            || packetReferenceFingerprint(packet) === packetReferenceFingerprint(record.packet)
          ) {
            return failure([
              'Review packet preset refresh could not find a safe replacement to save.',
              ...formatFreshnessLines(audit),
              'Inspect the preset and repair missing evidence manually before saving a new preset.',
            ].join('\n'));
          }
          if (!readBoolean(args.confirm)) {
            return failure([
              formatRefreshPreview(loaded, audit, record),
              '',
              'Refresh confirmation required. Call this tool with confirm:true only when the user explicitly asked GoodVibes Agent to refresh this reviewer packet preset.',
            ].join('\n'));
          }
          const descriptor = await artifactStore.create(presetCreateInput(record));
          return output(formatRefreshResult(descriptor, loaded, audit, record));
        }
        if (!artifactStore?.create) return failure('Review packet preset save is unavailable because this runtime did not provide an artifact store.');
        const record = buildPresetRecord(args);
        if (!readBoolean(args.confirm)) {
          return failure([
            formatPresetPreview(record),
            '',
            'Preset confirmation required. Call this tool with confirm:true only when the user explicitly asked GoodVibes Agent to save this reviewer packet preset.',
          ].join('\n'));
        }
        const descriptor = await artifactStore.create(presetCreateInput(record));
        return output(formatSaveResult(descriptor, record));
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

function output(text: string): { readonly success: true; readonly output: string } {
  return { success: true, output: text };
}

function failure(error: string): { readonly success: false; readonly error: string } {
  return { success: false, error };
}

export function registerAgentReviewPacketPresetsTool(
  registry: ToolRegistry,
  artifactStore?: AgentReviewPacketPresetArtifactStore,
): void {
  registry.register(createAgentReviewPacketPresetsTool(artifactStore));
}
