import type { AgentWorkspaceActionResult, AgentWorkspaceLocalEditor, AgentWorkspaceReviewPacketDefaults } from './agent-workspace-types.ts';

type AgentWorkspaceFieldReader = (fieldId: string) => string;

export interface AgentDocumentReviewerReadinessToolArgs {
  readonly mode: 'document_ops_lane';
  readonly laneId: 'reviewer_readiness' | 'review_packet_wizard';
  readonly includeParameters: boolean;
}

export interface AgentDocumentReviewPacketPresetToolArgs {
  readonly mode: 'save';
  readonly name: string;
  readonly documentId?: string;
  readonly documentTitle?: string;
  readonly documentExportArtifactId?: string;
  readonly comparisonArtifactId?: string;
  readonly judgmentArtifactId?: string;
  readonly revealedJudgmentArtifactId?: string;
  readonly routeDecisionArtifactId?: string;
  readonly routeDecision?: string;
  readonly handoffArtifactId?: string;
  readonly handoffArchiveArtifactId?: string;
  readonly relatedArtifactIds: readonly string[];
  readonly summary?: string;
  readonly confirm: boolean;
  readonly explicitUserRequest: string;
}

export interface AgentDocumentReviewPacketPresetRefreshToolArgs {
  readonly mode: 'refresh';
  readonly artifactId: string;
  readonly name?: string;
  readonly summary?: string;
  readonly confirm: boolean;
  readonly explicitUserRequest: string;
}

export interface AgentDocumentReviewPacketShareToolArgs {
  readonly archiveArtifactId: string;
  readonly title?: string;
  readonly message?: string;
  readonly channel?: string;
  readonly route?: string;
  readonly webhook?: string;
  readonly link?: string;
  readonly confirm: boolean;
  readonly explicitUserRequest: string;
}

export function createAgentDocumentReviewerReadinessEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'document-reviewer-readiness',
    mode: 'create',
    title: 'Review Readiness Preflight',
    selectedFieldIndex: 0,
    message: 'Inspect unresolved document comments, proposed suggestions, missing source artifacts, unrevealed comparisons, route-change decisions, and reviewer handoff evidence before export, archive, or route update.',
    fields: [
      { id: 'scope', label: 'Scope', value: 'documents-and-compare', required: false, multiline: false, hint: 'Read-only preflight for Document Ops reviewer readiness.' },
      { id: 'includeRoutes', label: 'Repair routes', value: 'yes', required: false, multiline: false, hint: 'yes/no. Yes includes exact inspect and repair routes for the next action.' },
    ],
  };
}

export function createAgentDocumentReviewPacketWizardEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'document-review-packet-wizard',
    mode: 'create',
    title: 'Review Packet Wizard',
    selectedFieldIndex: 0,
    message: 'Walk the current reviewer packet through draft review, document export, comparison judgment, handoff, route decision, and final archive review. This is read-only and returns existing routes.',
    fields: [
      { id: 'focus', label: 'Focus', value: 'next', required: false, multiline: false, hint: 'next, all, blocked, backtrack, or final. The wizard never mutates state by itself.' },
      { id: 'includeRoutes', label: 'Routes', value: 'yes', required: false, multiline: false, hint: 'yes/no. Yes includes exact user, model, action, and backtrack routes.' },
    ],
  };
}

export function createAgentDocumentReviewPacketPresetEditor(
  defaults: AgentWorkspaceReviewPacketDefaults | null = null,
): AgentWorkspaceLocalEditor {
  const title = defaults?.documentTitle || defaults?.documentId || 'Current reviewer packet';
  return {
    kind: 'document-review-packet-preset',
    mode: 'create',
    title: 'Save Review Packet Preset',
    selectedFieldIndex: 0,
    message: 'Save the current document, comparison, judgment, route decision, handoff, archive, and related evidence ids as a reusable local preset artifact. This does not change the document, selected model, or archive state.',
    fields: [
      { id: 'name', label: 'Preset name', value: `${title} preset`, required: true, multiline: false, hint: 'Short user-visible name for reusing this review packet.' },
      { id: 'documentId', label: 'Document id', value: defaults?.documentId ?? '', required: false, multiline: false, hint: 'Agent document draft id.' },
      { id: 'documentTitle', label: 'Document title', value: defaults?.documentTitle ?? '', required: false, multiline: false, hint: 'Optional title shown in preset summaries.' },
      { id: 'documentExportArtifactId', label: 'Document export', value: defaults?.documentExportArtifactId ?? '', required: false, multiline: false, hint: 'Exported document evidence artifact id.' },
      { id: 'comparisonArtifactId', label: 'Comparison', value: defaults?.comparisonArtifactId ?? '', required: false, multiline: false, hint: 'Saved blind comparison artifact id.' },
      { id: 'judgmentArtifactId', label: 'Judgment', value: defaults?.judgmentArtifactId ?? '', required: false, multiline: false, hint: 'Saved comparison judgment artifact id.' },
      { id: 'revealedJudgmentArtifactId', label: 'Revealed judgment', value: defaults?.revealedJudgmentArtifactId ?? '', required: false, multiline: false, hint: 'Revealed judgment artifact id for route decisions.' },
      { id: 'routeDecisionArtifactId', label: 'Route decision', value: defaults?.routeDecisionArtifactId ?? '', required: false, multiline: false, hint: 'Saved leave-unchanged or applied-winner route-decision receipt id.' },
      { id: 'routeDecision', label: 'Decision label', value: defaults?.routeDecision ?? '', required: false, multiline: false, hint: 'left-unchanged or applied-winner when known.' },
      { id: 'handoffArtifactId', label: 'Reviewer handoff', value: defaults?.handoffArtifactId ?? '', required: false, multiline: false, hint: 'Reviewer handoff artifact id.' },
      { id: 'handoffArchiveArtifactId', label: 'Handoff archive', value: defaults?.handoffArchiveArtifactId ?? '', required: false, multiline: false, hint: 'Final reviewer handoff ZIP artifact id.' },
      { id: 'relatedArtifactIds', label: 'Related artifacts', value: defaults?.relatedArtifactIds.join('\n') ?? '', required: false, multiline: true, hint: 'Comma- or newline-separated source, export, attachment, receipt, or evidence artifact ids.' },
      { id: 'summary', label: 'Summary', value: defaults?.summary ?? '', required: false, multiline: false, hint: 'Short packet summary shown in list and timeline views.' },
      { id: 'confirm', label: 'Confirm save', value: 'no', required: true, multiline: false, hint: 'Type yes only after the user explicitly asks to save this packet preset.' },
    ],
  };
}

export function createAgentDocumentReviewPacketPresetRefreshEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'document-review-packet-preset-refresh',
    mode: 'create',
    title: 'Refresh Review Packet Preset',
    selectedFieldIndex: 0,
    message: 'Save a new preset artifact from an existing stale preset using its freshness recommendations. This keeps the source preset as audit history and does not change documents, model routing, handoffs, or archives.',
    fields: [
      { id: 'artifactId', label: 'Preset artifact id', value: '', required: true, multiline: false, hint: 'Existing review packet preset artifact id from list/show output.' },
      { id: 'name', label: 'New preset name', value: '', required: false, multiline: false, hint: 'Optional. Defaults to the old preset name plus "refreshed".' },
      { id: 'summary', label: 'New summary', value: '', required: false, multiline: false, hint: 'Optional. Defaults to the old summary with stale ids replaced when possible.' },
      { id: 'confirm', label: 'Confirm refresh', value: 'no', required: true, multiline: false, hint: 'Type yes only after the user explicitly asks to refresh this packet preset.' },
    ],
  };
}

export function createAgentDocumentReviewPacketShareEditor(
  defaults: AgentWorkspaceReviewPacketDefaults | null = null,
): AgentWorkspaceLocalEditor {
  return {
    kind: 'document-review-packet-share',
    mode: 'create',
    title: 'Share Review Packet',
    selectedFieldIndex: 0,
    message: 'Share one saved reviewer handoff ZIP archive reference through a configured channel target. The tool validates the archive, includes packet evidence ids, and does not send ZIP bytes.',
    fields: [
      { id: 'archiveArtifactId', label: 'Archive artifact id', value: defaults?.handoffArchiveArtifactId ?? '', required: true, multiline: false, hint: defaults?.handoffArchiveArtifactId ? `Default from latest packet archive. Packet default: ${defaults.summary}.` : 'Saved reviewer handoff ZIP artifact id from the final archive step.' },
      { id: 'title', label: 'Title', value: 'GoodVibes Agent review packet', required: false, multiline: false, hint: 'Optional delivery title.' },
      { id: 'message', label: 'Message', value: '', required: false, multiline: true, hint: 'Optional note. The tool appends archive evidence, counts, ids, and export route automatically.' },
      { id: 'channel', label: 'Channel target', value: '', required: false, multiline: false, hint: 'Optional surface[:route[:label]], such as slack:ops:Ops. Fill exactly one target field.' },
      { id: 'route', label: 'Route target', value: '', required: false, multiline: false, hint: 'Optional route id or route:label. Fill exactly one target field.' },
      { id: 'webhook', label: 'Webhook URL', value: '', required: false, multiline: false, hint: 'Optional http(s) webhook target. Fill exactly one target field.' },
      { id: 'link', label: 'Link target', value: '', required: false, multiline: false, hint: 'Optional link delivery target. Fill exactly one target field.' },
      { id: 'confirm', label: 'Confirm share', value: 'no', required: true, multiline: false, hint: 'Type yes only after the user explicitly asks to share this review packet.' },
    ],
  };
}

function isAffirmative(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'yes' || normalized === 'true';
}

function readList(value: string): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value.split(/[,\n]/)) {
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function optionalField(readField: AgentWorkspaceFieldReader, fieldId: string): string | undefined {
  const value = readField(fieldId).trim();
  return value ? value : undefined;
}

export function buildAgentDocumentReviewerReadinessToolArgs(
  readField: AgentWorkspaceFieldReader,
): AgentDocumentReviewerReadinessToolArgs {
  return {
    mode: 'document_ops_lane',
    laneId: 'reviewer_readiness',
    includeParameters: isAffirmative(readField('includeRoutes')),
  };
}

export function buildAgentDocumentReviewPacketWizardToolArgs(
  readField: AgentWorkspaceFieldReader,
): AgentDocumentReviewerReadinessToolArgs {
  return {
    mode: 'document_ops_lane',
    laneId: 'review_packet_wizard',
    includeParameters: isAffirmative(readField('includeRoutes')),
  };
}

export function buildAgentDocumentReviewPacketPresetToolArgs(
  readField: AgentWorkspaceFieldReader,
  explicitUserRequest: string,
): AgentDocumentReviewPacketPresetToolArgs {
  const documentId = optionalField(readField, 'documentId');
  const documentTitle = optionalField(readField, 'documentTitle');
  const documentExportArtifactId = optionalField(readField, 'documentExportArtifactId');
  const comparisonArtifactId = optionalField(readField, 'comparisonArtifactId');
  const judgmentArtifactId = optionalField(readField, 'judgmentArtifactId');
  const revealedJudgmentArtifactId = optionalField(readField, 'revealedJudgmentArtifactId');
  const routeDecisionArtifactId = optionalField(readField, 'routeDecisionArtifactId');
  const routeDecision = optionalField(readField, 'routeDecision');
  const handoffArtifactId = optionalField(readField, 'handoffArtifactId');
  const handoffArchiveArtifactId = optionalField(readField, 'handoffArchiveArtifactId');
  const summary = optionalField(readField, 'summary');
  return {
    mode: 'save',
    name: readField('name').trim() || 'Reviewer packet preset',
    ...(documentId ? { documentId } : {}),
    ...(documentTitle ? { documentTitle } : {}),
    ...(documentExportArtifactId ? { documentExportArtifactId } : {}),
    ...(comparisonArtifactId ? { comparisonArtifactId } : {}),
    ...(judgmentArtifactId ? { judgmentArtifactId } : {}),
    ...(revealedJudgmentArtifactId ? { revealedJudgmentArtifactId } : {}),
    ...(routeDecisionArtifactId ? { routeDecisionArtifactId } : {}),
    ...(routeDecision ? { routeDecision } : {}),
    ...(handoffArtifactId ? { handoffArtifactId } : {}),
    ...(handoffArchiveArtifactId ? { handoffArchiveArtifactId } : {}),
    relatedArtifactIds: readList(readField('relatedArtifactIds')),
    ...(summary ? { summary } : {}),
    confirm: isAffirmative(readField('confirm')),
    explicitUserRequest,
  };
}

export function buildAgentDocumentReviewPacketPresetRefreshToolArgs(
  readField: AgentWorkspaceFieldReader,
  explicitUserRequest: string,
): AgentDocumentReviewPacketPresetRefreshToolArgs {
  const name = optionalField(readField, 'name');
  const summary = optionalField(readField, 'summary');
  return {
    mode: 'refresh',
    artifactId: readField('artifactId').trim(),
    ...(name ? { name } : {}),
    ...(summary ? { summary } : {}),
    confirm: isAffirmative(readField('confirm')),
    explicitUserRequest,
  };
}

export function buildAgentDocumentReviewPacketShareToolArgs(
  readField: AgentWorkspaceFieldReader,
  explicitUserRequest: string,
): AgentDocumentReviewPacketShareToolArgs {
  const title = optionalField(readField, 'title');
  const message = optionalField(readField, 'message');
  const channel = optionalField(readField, 'channel');
  const route = optionalField(readField, 'route');
  const webhook = optionalField(readField, 'webhook');
  const link = optionalField(readField, 'link');
  return {
    archiveArtifactId: readField('archiveArtifactId').trim(),
    ...(title ? { title } : {}),
    ...(message ? { message } : {}),
    ...(channel ? { channel } : {}),
    ...(route ? { route } : {}),
    ...(webhook ? { webhook } : {}),
    ...(link ? { link } : {}),
    confirm: isAffirmative(readField('confirm')),
    explicitUserRequest,
  };
}

export function buildAgentDocumentReviewerReadinessPromptSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  promptDispatchAvailable: boolean,
): {
  readonly kind: 'editor';
  readonly editor: AgentWorkspaceLocalEditor;
  readonly status: string;
  readonly actionResult: AgentWorkspaceActionResult;
} | {
  readonly kind: 'prompt';
  readonly prompt: string;
  readonly status: string;
  readonly actionResult: AgentWorkspaceActionResult;
} {
  if (!promptDispatchAvailable) {
    return {
      kind: 'editor',
      editor: {
        ...editor,
        message: 'Prompt dispatch is unavailable in this runtime. Use agent_harness mode:"run_workspace_action" with this editor schema.',
      },
      status: 'Prompt dispatch unavailable.',
      actionResult: {
        kind: 'error',
        title: 'Prompt dispatch unavailable',
        detail: 'This runtime cannot submit the reviewer-readiness preflight from the workspace form.',
        safety: 'read-only',
      },
    };
  }

  const includeRoutes = isAffirmative(readField('includeRoutes'));
  return {
    kind: 'prompt',
    prompt: [
      'Inspect Document Ops reviewer readiness with the `agent_harness` tool.',
      'Use mode:"document_ops_lane" and laneId:"reviewer_readiness".',
      `Include exact repair routes: ${includeRoutes ? 'yes' : 'no'}.`,
      'Do not export, archive, reveal, apply a route update, or mutate a document from this preflight.',
    ].join('\n'),
    status: 'Submitting reviewer-readiness preflight.',
    actionResult: {
      kind: 'guidance',
      title: 'Review readiness preflight',
      detail: 'Submitted a read-only Document Ops readiness check before export, handoff archive, or route update.',
      safety: 'read-only',
    },
  };
}

export function buildAgentDocumentReviewPacketPresetPromptSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  promptDispatchAvailable: boolean,
): {
  readonly kind: 'editor';
  readonly editor: AgentWorkspaceLocalEditor;
  readonly status: string;
  readonly actionResult: AgentWorkspaceActionResult;
} | {
  readonly kind: 'prompt';
  readonly prompt: string;
  readonly status: string;
  readonly actionResult: AgentWorkspaceActionResult;
} {
  if (!promptDispatchAvailable) {
    return {
      kind: 'editor',
      editor: {
        ...editor,
        message: 'Prompt dispatch is unavailable in this runtime. Use agent_harness mode:"run_workspace_action" with this editor schema.',
      },
      status: 'Prompt dispatch unavailable.',
      actionResult: {
        kind: 'error',
        title: 'Prompt dispatch unavailable',
        detail: 'This runtime cannot submit the review packet preset save from the workspace form.',
        safety: 'safe',
      },
    };
  }

  const toolArgs = buildAgentDocumentReviewPacketPresetToolArgs(
    readField,
    'Save this Document Ops review packet preset from the workspace form.',
  );
  return {
    kind: 'prompt',
    prompt: [
      'Save a reusable Document Ops review packet preset with the `agent_review_packet_presets` tool.',
      `Use these preset fields: ${JSON.stringify(toolArgs, null, 2)}.`,
      'Only call the tool with confirm:true when the user explicitly asked GoodVibes Agent to save this preset. The save creates one local preset artifact and must not mutate documents, model routing, handoffs, or archives.',
    ].join('\n'),
    status: 'Submitting review packet preset save.',
    actionResult: {
      kind: 'guidance',
      title: 'Save review packet preset',
      detail: 'Submitted a confirmed preset-save request for the current document/review packet artifact ids.',
      safety: 'safe',
    },
  };
}

export function buildAgentDocumentReviewPacketPresetRefreshPromptSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  promptDispatchAvailable: boolean,
): {
  readonly kind: 'editor';
  readonly editor: AgentWorkspaceLocalEditor;
  readonly status: string;
  readonly actionResult: AgentWorkspaceActionResult;
} | {
  readonly kind: 'prompt';
  readonly prompt: string;
  readonly status: string;
  readonly actionResult: AgentWorkspaceActionResult;
} {
  if (!promptDispatchAvailable) {
    return {
      kind: 'editor',
      editor: {
        ...editor,
        message: 'Prompt dispatch is unavailable in this runtime. Use agent_harness mode:"run_workspace_action" with this editor schema.',
      },
      status: 'Prompt dispatch unavailable.',
      actionResult: {
        kind: 'error',
        title: 'Prompt dispatch unavailable',
        detail: 'This runtime cannot submit the review packet preset refresh from the workspace form.',
        safety: 'safe',
      },
    };
  }

  const toolArgs = buildAgentDocumentReviewPacketPresetRefreshToolArgs(
    readField,
    'Refresh this Document Ops review packet preset from the workspace form.',
  );
  return {
    kind: 'prompt',
    prompt: [
      'Refresh a stale reusable Document Ops review packet preset with the `agent_review_packet_presets` tool.',
      `Use these refresh fields: ${JSON.stringify(toolArgs, null, 2)}.`,
      'Only call the tool with confirm:true when the user explicitly asked GoodVibes Agent to refresh this preset. The refresh creates one new local preset artifact from freshness recommendations and must not mutate documents, model routing, handoffs, archives, or the source preset.',
    ].join('\n'),
    status: 'Submitting review packet preset refresh.',
    actionResult: {
      kind: 'guidance',
      title: 'Refresh review packet preset',
      detail: 'Submitted a confirmed preset-refresh request that saves a new local artifact from freshness recommendations.',
      safety: 'safe',
    },
  };
}

export function buildAgentDocumentReviewPacketSharePromptSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  promptDispatchAvailable: boolean,
): {
  readonly kind: 'editor';
  readonly editor: AgentWorkspaceLocalEditor;
  readonly status: string;
  readonly actionResult: AgentWorkspaceActionResult;
} | {
  readonly kind: 'prompt';
  readonly prompt: string;
  readonly status: string;
  readonly actionResult: AgentWorkspaceActionResult;
} {
  if (!promptDispatchAvailable) {
    return {
      kind: 'editor',
      editor: {
        ...editor,
        message: 'Prompt dispatch is unavailable in this runtime. Use agent_harness mode:"run_workspace_action" with this editor schema.',
      },
      status: 'Prompt dispatch unavailable.',
      actionResult: {
        kind: 'error',
        title: 'Prompt dispatch unavailable',
        detail: 'This runtime cannot submit the review packet share from the workspace form.',
        safety: 'safe',
      },
    };
  }

  const toolArgs = buildAgentDocumentReviewPacketShareToolArgs(
    readField,
    'Share this Document Ops review packet archive from the workspace form.',
  );
  return {
    kind: 'prompt',
    prompt: [
      'Share a saved Document Ops reviewer packet archive with the `agent_review_packet_share` tool.',
      `Use these share fields: ${JSON.stringify(toolArgs, null, 2)}.`,
      'Only call the tool with confirm:true when the user explicitly asked GoodVibes Agent to share this packet. The tool validates the saved handoff archive, sends a plain-text archive reference through the configured target, and must not print or attach ZIP bytes.',
    ].join('\n'),
    status: 'Submitting review packet share.',
    actionResult: {
      kind: 'guidance',
      title: 'Share review packet',
      detail: 'Submitted a confirmed reviewer packet share request that sends a channel reference to the saved handoff archive.',
      safety: 'safe',
    },
  };
}

export function buildAgentDocumentReviewPacketWizardPromptSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  promptDispatchAvailable: boolean,
): {
  readonly kind: 'editor';
  readonly editor: AgentWorkspaceLocalEditor;
  readonly status: string;
  readonly actionResult: AgentWorkspaceActionResult;
} | {
  readonly kind: 'prompt';
  readonly prompt: string;
  readonly status: string;
  readonly actionResult: AgentWorkspaceActionResult;
} {
  if (!promptDispatchAvailable) {
    return {
      kind: 'editor',
      editor: {
        ...editor,
        message: 'Prompt dispatch is unavailable in this runtime. Use agent_harness mode:"run_workspace_action" with this editor schema.',
      },
      status: 'Prompt dispatch unavailable.',
      actionResult: {
        kind: 'error',
        title: 'Prompt dispatch unavailable',
        detail: 'This runtime cannot submit the review packet wizard from the workspace form.',
        safety: 'read-only',
      },
    };
  }

  const focus = readField('focus').trim() || 'next';
  const includeRoutes = isAffirmative(readField('includeRoutes'));
  return {
    kind: 'prompt',
    prompt: [
      'Inspect the Document Ops review packet wizard with the `agent_harness` tool.',
      'Use mode:"document_ops_lane" and laneId:"review_packet_wizard".',
      `Focus: ${focus}.`,
      `Include exact routes: ${includeRoutes ? 'yes' : 'no'}.`,
      'Do not export, archive, reveal, apply a route update, or mutate a document from this wizard. Use the returned existing routes only after explicit user confirmation.',
    ].join('\n'),
    status: 'Submitting review packet wizard.',
    actionResult: {
      kind: 'guidance',
      title: 'Review packet wizard',
      detail: 'Submitted a read-only guided packet flow with progress, backtrack routes, route decision, and final evidence review.',
      safety: 'read-only',
    },
  };
}
