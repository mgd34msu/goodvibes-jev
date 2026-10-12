/**
 * Draft-only style-reply descriptors. The Agent's Personal Ops route accepts
 * an explicitly supplied sent-message corpus and inbound DTO, then invokes
 * protected SDK readings. It never assumes a mailbox or reads a provider.
 * A current native source owner and settled readings are required at execution.
 * Delivery remains a separate admitted SMTP or connector operation.
 */

// ---------------------------------------------------------------------------
// Workflow status helper
// ---------------------------------------------------------------------------

/**
 * Determine the workflow status for the style-reply lane.
 *
 * The lane is 'ready' when the composition provides a protected native source
 * owner and judgment transport. The supplied corpus needs no mailbox connector.
 */
export function styleReplyWorkflowStatus(hasStyleReadingCapability: boolean): 'ready' | 'needs-setup' {
  return hasStyleReadingCapability ? 'ready' : 'needs-setup';
}

// ---------------------------------------------------------------------------
// Workflow descriptor
// ---------------------------------------------------------------------------

/**
 * Personal Ops workflow card for the writing-style-matched draft-reply flow.
 *
 * Presence in inbox lane's `workflows` array makes it discoverable via
 * `personal_ops action:"intake" query:"draft reply in my style"` and similar.
 */
export function styleReplyWorkflow(hasStyleReadingCapability: boolean) {
  const status = styleReplyWorkflowStatus(hasStyleReadingCapability);
  return {
    id: 'inbox-style-matched-draft-reply',
    label: 'Writing-style-matched draft reply',
    status,
    summary:
      'Compose a draft email reply that mirrors the user\'s own writing style '
      + '(tone, length, greeting, sign-off) inferred from prior sent messages. '
      + 'The draft uses protected style readings and is NEVER auto-sent.',
    next: status === 'ready'
      ? 'Call personal_ops action:"read" laneId:"inbox" recordId:"inbox-style-reply-draft" '
        + 'with fields.inbound, fields.sentMessages and optional fields.context. '
        + 'Review the composed draft in the Agent transcript before sending through the confirmed send route.'
      : 'Configure the protected native source owner and style-reading transport before drafting from supplied messages.',
    modelRoute: 'personal_ops action:"read" laneId:"inbox" recordId:"inbox-style-reply-draft" '
      + 'fields:{inbound:{from:"...",subject:"...",bodyPreview:"..."},sentMessages:[{bodyPreview:"..."}],context:"key points to include"}',
    inspectRoutes: [
      'personal_ops action:"lane" laneId:"inbox" includeParameters:true',
      'personal_ops action:"intake" query:"draft reply in my style" includeParameters:true',
    ],
    prerequisites: status === 'needs-setup'
      ? ['Provide the protected native source owner and style-reading transport before using style-matched drafts.']
      : [
        'Supply the inbound message and explicit sent-message corpus; no sent mailbox is inferred.',
        'The native source owner must admit the complete source and the readings must settle.',
        'Optionally supply key-points context to weave into the draft.',
        'Review the draft in the Agent transcript before any send route.',
      ],
    runBoundary:
      'Composing requires a protected admitted source owner and current semantic readings; it performs no send. '
      + 'Sending requires the confirmed SMTP/connector route with explicit user review of recipients and body.',
  };
}

// ---------------------------------------------------------------------------
// Live record descriptor
// ---------------------------------------------------------------------------

/**
 * Live record for the inbox lane's liveRecords array that exposes the
 * style-reply composer as a Personal Ops read route.
 *
 * The `effect` is 'read-only' (the draft composer performs no mail delivery);
 * it carries no `freshness` so it is not counted as a provider read. Send is a
 * separate confirmed route.
 */
export function styleReplyLiveRecord(hasStyleReadingCapability: boolean) {
  const status = hasStyleReadingCapability ? 'ready' : 'needs-setup';
  return {
    id: 'inbox-style-reply-draft',
    label: 'Draft reply in my writing style',
    status,
    summary:
      'Compose a draft email reply from protected readings that mirrors the user\'s tone, '
      + 'length, greeting, and sign-off. The draft is shown for review; '
      + 'no send occurs until the user explicitly confirms through the send route.',
    userRoute: 'Agent Workspace → Personal Ops → Inbox → Draft reply in my style',
    modelRoute:
      'personal_ops action:"read" laneId:"inbox" recordId:"inbox-style-reply-draft" '
      + 'fields:{inbound:{from:"<from>",subject:"<subject>",bodyPreview:"<full supplied body>"},sentMessages:[{bodyPreview:"<sent body>"}],context:"<key points>"}',
    tags: ['style-reply', 'draft', 'inbox', 'personal-ops', 'writing-style'],
    // Note: the surface's live-record effect union only supports
    // 'read-only' | 'confirmed-effect'. Style-reply composition has no provider
    // effect, so 'read-only' is the correct value. The draft-only nature is
    // communicated via the followUpRoutes policy and reviewBoundary.
    effect: 'read-only' as const,
    capability: 'inbox-style-reply-draft',
    confirmationRequired: false, // draft composition; no mail delivery
    requiredFields: ['inbound', 'sentMessages'],
    optionalFields: ['context'],
    sampleInput: {
      inbound: { from: 'Alice Smith <alice@example.com>', subject: 'Project update', bodyPreview: 'Hi, is the project on track?' },
      sentMessages: [{ bodyPreview: 'Hi Alice,\nThe milestone is ready.\nThanks' }],
      context: 'Mention the milestone is on track and you will share a detailed update by Friday.',
    },
    followUpRoutes: [
      {
        id: 'send-after-review',
        label: 'Send reviewed draft (confirmed)',
        effect: 'confirmed-effect' as const,
        modelRoute:
          'personal_ops action:"intake" query:"send this reviewed draft through the configured mail connector"',
        requiresConfirmation: true,
        policy:
          'Review the exact recipients and body, then use only a separately admitted native SMTP or connector send path. Caller fields grant no send authority.',
      },
    ],
    // No `freshness`: this record is a draft composition, not a provider-backed
    // read, so it must not be classified as a fresh provider record (which would
    // inflate the Personal Ops queue's freshProviderReads count). Drafts are
    // composed from protected supplied fields and are session-local.
  };
}

// ---------------------------------------------------------------------------
// Aggregated export for easy import in buildLanes()
// ---------------------------------------------------------------------------

export interface StyleReplyLaneAdditions {
  readonly workflow: ReturnType<typeof styleReplyWorkflow>;
  readonly liveRecord: ReturnType<typeof styleReplyLiveRecord>;
}

/**
 * Returns both the workflow and live record for the style-reply lane.
 * Call once per buildLanes() invocation; result is deterministic.
 */
export function buildStyleReplyLaneAdditions(hasStyleReadingCapability: boolean): StyleReplyLaneAdditions {
  return {
    workflow: styleReplyWorkflow(hasStyleReadingCapability),
    liveRecord: styleReplyLiveRecord(hasStyleReadingCapability),
  };
}
