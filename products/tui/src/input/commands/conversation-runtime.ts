import { captureTranscriptSource, readTranscriptIndex, transcriptReadingCanceled, TRANSCRIPT_UNAVAILABLE } from './transcript-reading.ts';
import { deriveComposerState } from '../../core/composer-state.ts';
import type { TranscriptEventKind } from '@goodvibes-jev/engine/sdk/platform/core';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireReadModels } from './runtime-services.ts';

function parseTranscriptKind(raw: string | undefined): TranscriptEventKind | 'all' {
  const normalized = (raw ?? 'all').toLowerCase().replace(/-/g, '_');
  const allowed = new Set<TranscriptEventKind | 'all'>([
    'all',
    'user_input',
    'assistant_output',
    'tool_call',
    'tool_result',
    'approval_request',
    'approval_resolution',
    'task_transition',
    'remote_status',
    'policy_warning',
    'artifact_preview',
    'contract_state',
    'session_restore',
    'diagnostic_notice',
    'system_notice',
  ]);
  return allowed.has(normalized as TranscriptEventKind | 'all')
    ? (normalized as TranscriptEventKind | 'all')
    : 'all';
}

async function buildTranscriptLines(
  ctx: CommandContext,
  kind: TranscriptEventKind | 'all',
  mode: 'events' | 'groups' | 'hotspots',
  source: ReturnType<typeof captureTranscriptSource>,
): Promise<string[]> {
  const index = await readTranscriptIndex(ctx, source);
  if (!index) return [TRANSCRIPT_UNAVAILABLE];
  const events = kind === 'all' ? index.events : index.events.filter((event) => event.kind === kind);
  const groups = kind === 'all' ? index.groups : index.groups.filter((group) => group.kind === kind);

  if (mode === 'groups') {
    return [
      `Conversation Groups${kind === 'all' ? '' : `: ${kind}`}`,
      `  groups: ${groups.length}`,
      ...groups.slice(0, 12).map((group) => (
        `  ${group.kind.padEnd(20)} ${String(group.events.length).padStart(2)} event(s)  msgs=${group.messageIndexes[0]}-${group.messageIndexes[group.messageIndexes.length - 1]}  ${group.title}`
      )),
      ...(groups.length > 12 ? [`  ... ${groups.length - 12} more group(s)`] : []),
    ];
  }

  if (mode === 'hotspots') {
    const kindCounts = new Map<TranscriptEventKind, number>();
    for (const event of index.events) {
      kindCounts.set(event.kind, (kindCounts.get(event.kind) ?? 0) + 1);
    }
    const busiestGroups = [...index.groups]
      .sort((a, b) => b.events.length - a.events.length || a.messageIndexes[0]! - b.messageIndexes[0]!)
      .slice(0, 8);
    return [
      'Conversation Hotspots',
      ...[...kindCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([eventKind, count]) => `  ${eventKind.padEnd(20)} ${count}`),
      '',
      'Busiest groups',
      ...busiestGroups.map((group) => `  ${group.kind.padEnd(20)} ${String(group.events.length).padStart(2)}  ${group.title}`),
    ];
  }

  return [
    `Conversation Events${kind === 'all' ? '' : `: ${kind}`}`,
    `  events: ${events.length}`,
    ...events.slice(0, 16).map((event) => `  #${String(event.messageIndex).padStart(3)}  ${event.kind.padEnd(20)} ${event.title} - ${event.detail}`),
    ...(events.length > 16 ? [`  ... ${events.length - 16} more event(s)`] : []),
  ];
}

function buildComposerReview(ctx: CommandContext): string[] {
  const session = requireReadModels(ctx).session.getSnapshot();
  const composer = deriveComposerState({
    text: '',
    commandMode: false,
    pendingApproval: session.pendingApproval,
    hasAttachments: false,
    turnState: session.turnState,
  });
  return [
    'Composer Review',
    `  mode: ${composer.modeLabel}`,
    `  status: ${composer.statusLabel}`,
    `  risk: ${composer.pendingRisk}`,
    `  flags: ${composer.flags.length > 0 ? composer.flags.join(', ') : 'none'}`,
    `  turn state: ${session.turnState}`,
    `  messages: ${session.messageCount || ctx.session.conversationManager.getMessageCount()}`,
    `  context tokens: ${session.estimatedContextTokens}`,
    `  context warning: ${session.contextWarningActive ? 'yes' : 'no'}`,
  ];
}

async function buildConversationSearch(ctx: CommandContext, query: string, kind: TranscriptEventKind | 'all', source: ReturnType<typeof captureTranscriptSource>): Promise<string[]> {
  const index = await readTranscriptIndex(ctx, source);
  if (!index) return [TRANSCRIPT_UNAVAILABLE];
  const q = query.trim().toLowerCase();
  const events = (kind === 'all' ? index.events : index.events.filter((event) => event.kind === kind))
    .filter((event) => q.length === 0 || event.title.toLowerCase().includes(q) || event.detail.toLowerCase().includes(q));
  return [
    `Conversation Search${kind === 'all' ? '' : `: ${kind}`}`,
    `  query: ${query || '(empty)'}`,
    `  matches: ${events.length}`,
    ...events.slice(0, 16).map((event) => `  #${String(event.messageIndex).padStart(3)}  ${event.kind.padEnd(20)} ${event.title} - ${event.detail}`),
    ...(events.length > 16 ? [`  ... ${events.length - 16} more match(es)`] : []),
  ];
}

async function buildConversationRestoreReview(ctx: CommandContext, source: ReturnType<typeof captureTranscriptSource>): Promise<string[]> {
  const index = await readTranscriptIndex(ctx, source);
  if (!index) return [TRANSCRIPT_UNAVAILABLE];
  const restoreKinds = new Set<TranscriptEventKind>([
    'session_restore',
    'approval_request',
    'approval_resolution',
    'task_transition',
    'remote_status',
    'diagnostic_notice',
  ]);
  const events = index.events.filter((event) => restoreKinds.has(event.kind));
  return [
    'Conversation Restore Review',
    `  restore-relevant events: ${events.length}`,
    ...events.slice(0, 16).map((event) => `  #${String(event.messageIndex).padStart(3)}  ${event.kind.padEnd(20)} ${event.title} - ${event.detail}`),
    ...(events.length > 16 ? [`  ... ${events.length - 16} more restore event(s)`] : []),
    '  next: /conversation hotspots',
    '  next: /session list',
  ];
}

export function registerConversationRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'conversation',
    aliases: ['transcript', 'composer'],
    description: 'Review conversation structure, transcript hotspots, and composer posture',
    usage: '[review|events [kind]|groups [kind]|hotspots|composer|find <query> [kind]|next [kind]|prev [kind]|restore]',
    async handler(args, ctx) {
      const source = captureTranscriptSource(ctx);
      try {
        const sub = (args[0] ?? 'review').toLowerCase();
        if (sub === 'composer') {
          ctx.print(buildComposerReview(ctx).join('\n'));
          return;
        }
        if (sub === 'find' || sub === 'search') {
          const trailing = args.length > 2 ? args[args.length - 1] : undefined;
          const parsedTrailingKind = parseTranscriptKind(trailing);
          const hasExplicitKind = Boolean(trailing) && parsedTrailingKind !== 'all';
          const kind = hasExplicitKind ? parsedTrailingKind : 'all';
          const queryParts = args.slice(1, hasExplicitKind ? -1 : undefined);
          const query = queryParts.join(' ').trim();
          const lines = await buildConversationSearch(ctx, query, kind, source); source.assertPublishable(); ctx.print(lines.join('\n'));
          return;
        }
        if (sub === 'restore') {
          const lines = await buildConversationRestoreReview(ctx, source); source.assertPublishable(); ctx.print(lines.join('\n'));
          return;
        }
        if (sub === 'next' || sub === 'prev') {
          const kind = parseTranscriptKind(args[1]);
          const currentLine = ctx.getScrollTop?.() ?? 0;
          const targetLine = sub === 'next'
            ? await source.conversation.nextTranscriptEventLine(currentLine, kind, { assertCurrent: source.assertCurrent, lifetime: source.lifetime })
            : await source.conversation.prevTranscriptEventLine(currentLine, kind, { assertCurrent: source.assertCurrent, lifetime: source.lifetime });
          source.assertPublishable();
          if (targetLine < 0) {
            ctx.print(`No ${kind === 'all' ? 'transcript' : kind} events found.`);
            return;
          }
          ctx.scrollToLine?.(targetLine);
          ctx.print(`Jumped to ${kind === 'all' ? 'next transcript event' : `${kind} event`} at line ${targetLine + 1}.`);
          return;
        }
        if (sub === 'events' || sub === 'groups' || sub === 'hotspots') {
          const kind = parseTranscriptKind(args[1]);
          const lines = await buildTranscriptLines(ctx, kind, sub, source); source.assertPublishable(); ctx.print(lines.join('\n'));
          return;
        }
        if (sub !== 'review' && sub !== 'status') {
          ctx.print('Usage: /conversation [review|events [kind]|groups [kind]|hotspots|composer|find <query> [kind]|next [kind]|prev [kind]|restore]');
          return;
        }

        const index = await readTranscriptIndex(ctx, source);
        source.assertPublishable();
        if (!index) { ctx.print(TRANSCRIPT_UNAVAILABLE); return; }
        const session = requireReadModels(ctx).session.getSnapshot();
        const byKind = new Map<TranscriptEventKind, number>();
        for (const event of index.events) {
          byKind.set(event.kind, (byKind.get(event.kind) ?? 0) + 1);
        }
        ctx.print([
          'Conversation Review',
          `  messages: ${session.messageCount || ctx.session.conversationManager.getMessageCount()}`,
          `  events: ${index.events.length}`,
          `  groups: ${index.groups.length}`,
          `  turn state: ${session.turnState}`,
          `  context tokens: ${session.estimatedContextTokens}`,
          `  families: ${[...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => `${kind}=${count}`).join(', ') || 'none'}`,
          '  next: /conversation hotspots',
          '  next: /conversation composer',
          '  next: /conversation find approval approval_request',
          '  next: /conversation next tool_result',
          '  next: /conversation restore',
        ].join('\n'));
      } catch (error) {
        try { source.assertPublishable(); } catch { return; }
        if (!transcriptReadingCanceled(error)) ctx.print(TRANSCRIPT_UNAVAILABLE);
      }
    },
  });
}
