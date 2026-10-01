import { randomBytes } from 'node:crypto';

import type { CommandContext } from '../command-registry.ts';
import { type SessionMeta } from '@goodvibes-jev/engine/sdk/platform/sessions';
import type { TranscriptEventKind } from '@goodvibes-jev/engine/sdk/platform/core';
import type { SessionReturnContextSummary } from '@/runtime/index.ts';
import type { ConversationMessageSnapshot } from '../../core/conversation.ts';
import { formatReturnContextForDisplay, getReturnContextMode, maybeAssistReturnContextSummary } from '@/runtime/index.ts';
import { requireProviderApi, requireSessionManager } from './runtime-services.ts';
import { redactSensitiveData, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { requireYesFlag, stripYesFlag } from './confirmation.ts';
import { readConversationMessageSnapshots } from '../../core/conversation-message-snapshot.ts';

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
    'review_state',
    'session_restore',
    'diagnostic_notice',
    'system_notice',
  ]);
  return allowed.has(normalized as TranscriptEventKind | 'all') ? (normalized as TranscriptEventKind | 'all') : 'all';
}

function formatSessionFailure(action: string, error: unknown): string {
  return [
    `Failed to ${action}`,
    `  error ${summarizeError(error)}`,
  ].join('\n');
}

function buildTranscriptReviewLines(
  ctx: CommandContext,
  kind: TranscriptEventKind | 'all',
  mode: 'events' | 'groups' | 'hotspots',
): string[] {
  const index = ctx.session.conversationManager.getTranscriptEventIndex();
  const events = kind === 'all' ? index.events : index.events.filter((event) => event.kind === kind);
  const groups = kind === 'all' ? index.groups : index.groups.filter((group) => group.kind === kind);

  if (mode === 'groups') {
    return [
      `Transcript Groups${kind === 'all' ? '' : ` ${kind}`}`,
      `  groups ${groups.length}`,
      ...groups.slice(0, 12).map((group) => (
        `  ${group.kind.padEnd(20)} ${String(group.events.length).padStart(2)} event(s)  msgs=${group.messageIndexes[0]}-${group.messageIndexes[group.messageIndexes.length - 1]}  ${group.title}`
      )),
      ...(groups.length > 12 ? [`  … ${groups.length - 12} more group(s)`] : []),
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
      'Transcript Hotspots',
      ...[...kindCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([eventKind, count]) => `  ${eventKind.padEnd(20)} ${count}`),
      '',
      'Busiest groups',
      ...busiestGroups.map((group) => `  ${group.kind.padEnd(20)} ${String(group.events.length).padStart(2)}  ${group.title}`),
    ];
  }

  return [
    `Transcript Events${kind === 'all' ? '' : ` ${kind}`}`,
    `  events ${events.length}`,
    ...events.slice(0, 16).map((event) => `  #${String(event.messageIndex).padStart(3)}  ${event.kind.padEnd(20)} ${event.title}, ${event.detail}`),
    ...(events.length > 16 ? [`  … ${events.length - 16} more event(s)`] : []),
  ];
}

function printSessionExport(
  ctx: { print: (text: string) => void },
  sessionId: string,
  title: string,
  messages: readonly ConversationMessageSnapshot[],
  format: string,
): void {
  const lines: string[] = [];
  if (format === 'markdown') {
    lines.push(`# Session: ${title || sessionId}`);
    lines.push('');
    for (const msg of messages) {
      const content = conversationMessageContentText(msg);
      if (!content.trim()) continue;
      if (msg.role === 'user') {
        lines.push('## User');
        lines.push('');
        lines.push(content);
        lines.push('');
      } else if (msg.role === 'assistant') {
        lines.push('## Assistant');
        lines.push('');
        lines.push(content);
        lines.push('');
      } else if (msg.role === 'tool') {
        const toolName = msg.toolName ?? 'tool';
        lines.push(`## Tool Result: ${toolName}`);
        lines.push('');
        lines.push('```');
        lines.push(content.slice(0, 2000) + (content.length > 2000 ? '\n...(truncated)' : ''));
        lines.push('```');
        lines.push('');
      }
    }
  } else {
    for (const msg of messages) {
      const role = msg.role.toUpperCase();
      const content = conversationMessageContentText(msg);
      if (!content.trim()) continue;
      lines.push(`[${role}]`);
      lines.push(content);
      lines.push('');
    }
  }
  // A transcript is the one place a value the model was handed becomes a
  // durable document. redactSensitiveData carries the platform's credential
  // patterns AND, in a process that has loaded the owner profile, that
  // profile's closed-tier values, his address, his contact details, the People
  // section, so an exported session cannot become the copy of the dossier that
  // the file itself is careful not to be (docs/owner-profile.md §10, §11.3).
  // Where no profile is loaded this behaves exactly as it did before.
  ctx.print(redactSensitiveData(lines.join('\n')));
}

function conversationMessageContentText(message: ConversationMessageSnapshot): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map((part) => {
    if (part.type === 'text') return part.text;
    return `[image: ${part.mediaType}]`;
  }).join('\n');
}

export async function handleSessionWorkflowCommand(args: string[], ctx: CommandContext): Promise<boolean> {
  const sm = requireSessionManager(ctx);
  const sub = args[0];

  if (!sub) {
    const id = ctx.session.runtime.sessionId;
    const msgCount = ctx.session.conversationManager.getMessageCount();
    const title = ctx.session.conversationManager.title || '(untitled)';
    const meta = sm.getMeta(id);
    const started = meta ? new Date(meta.timestamp).toLocaleString() : 'this session';
    ctx.print([
      'Current session',
      `  id ${id}`,
      `  name ${title}`,
      `  started ${started}`,
      `  messages ${msgCount}`,
      `  model ${ctx.session.runtime.model} (${ctx.session.runtime.provider})`,
    ].join('\n'));
    return true;
  }

  if (sub === 'list') {
    const sessions = sm.list();
    if (sessions.length === 0) {
      ctx.print('No saved sessions. Use /session save [name] to save the current session.');
      return true;
    }
    const lines = ['Sessions (most recent first)', ''];
    for (const session of sessions) {
      const date = new Date(session.timestamp).toLocaleString();
      const name = session.title || session.name;
      const model = session.model ? ` [${session.model}]` : '';
      const active = session.name === ctx.session.runtime.sessionId ? ' ●' : '  ';
      lines.push(`${active} ${session.name.padEnd(28)} ${name.slice(0, 22).padEnd(22)} ${date}  ${session.messageCount} msgs${model}`);
      if (session.returnContext?.activeTasks || session.returnContext?.blockedTasks || session.returnContext?.pendingApprovals) {
        const posture = [
          session.returnContext.activeTasks ? `active ${session.returnContext.activeTasks}` : null,
          session.returnContext.blockedTasks ? `blocked ${session.returnContext.blockedTasks}` : null,
          session.returnContext.pendingApprovals ? `approvals ${session.returnContext.pendingApprovals}` : null,
        ].filter(Boolean).join('  ');
        if (posture) lines.push(`     posture ${posture}`);
      }
    }
    ctx.print(lines.join('\n'));
    return true;
  }

  if (sub === 'rename') {
    const newName = args.slice(1).join(' ').trim();
    if (!newName) {
      ctx.print('Usage: /session rename <new-name>');
      return true;
    }
    try {
      const existingMeta = sm.getMeta(ctx.session.runtime.sessionId);
      if (!existingMeta) {
        sm.save(ctx.session.runtime.sessionId, ctx.session.conversationManager.getMessageSnapshot(), {
          title: ctx.session.conversationManager.title || '',
          model: ctx.session.runtime.model,
          provider: ctx.session.runtime.provider,
          timestamp: Date.now(),
          titleSource: ctx.session.conversationManager.getTitleSource(),
          // Backfilling a save so /session rename has a file to rename is still
          // user-directed (the user typed /session rename), stamp 'user' so
          // retention never reclaims it. See saveSource's doc comment on SessionMeta.
          saveSource: 'user',
        });
      }
      sm.rename(ctx.session.runtime.sessionId, newName);
      ctx.session.conversationManager.title = newName;
      ctx.print([
        'Session renamed',
        `  name ${newName}`,
      ].join('\n'));
      ctx.renderRequest();
    } catch (e) {
      ctx.print(formatSessionFailure('rename session', e));
    }
    return true;
  }

  if (sub === 'resume') {
    const target = args.slice(1).join(' ').trim();
    if (!target) {
      ctx.print('Usage: /session resume <session-id-or-name>');
      return true;
    }
    const sessions = sm.list();
    const found = sessions.find((session) =>
      session.name === target ||
      session.name.startsWith(target) ||
      session.title.toLowerCase() === target.toLowerCase(),
    );
    if (!found) {
      ctx.print(`Session not found ${target}\nUse /session list to see available sessions.`);
      return true;
    }
    try {
      const { meta, messages } = sm.load(found.name);
      const providerApi = requireProviderApi(ctx);
      ctx.session.conversationManager.resetAll();
      ctx.session.conversationManager.fromJSON({ messages: readConversationMessageSnapshots(messages), title: meta.title, titleSource: meta.titleSource });
      ctx.session.conversationManager.rebuildHistory();
      ctx.session.runtime.sessionId = found.name;
      // The live session is now homed on the resumed id, write the
      // last-session pointer through the surface-bound closure so the next
      // launch's "resume last session" reads this session, not a stale one.
      ctx.session.writeLastSessionPointer?.(found.name);
      // Reload the resumed session's rewind anchors so a message-anchored
      // /rewind can still reach turns from before this run. The message
      // boundaries stay valid because the resume above rehydrated the same
      // history the anchors were recorded against.
      const restoredAnchorCount = ctx.session.restoreTurnAnchors?.(found.name) ?? 0;
      if (meta.model) {
        try {
          const selected = await providerApi.selectModel(meta.model);
          ctx.session.runtime.model = selected.registryKey;
          ctx.session.runtime.provider = selected.providerId;
        } catch {
          ctx.session.runtime.model = meta.model;
          // model may not exist locally
        }
      }
      if (meta.provider) ctx.session.runtime.provider = meta.provider;
      ctx.renderRequest();
      ctx.print([
        'Resumed session',
        `  id ${found.name}`,
        `  name ${meta.title || '(untitled)'}`,
        `  messages ${messages.length}`,
        `  model ${meta.model || ctx.session.runtime.model}`,
        ...(restoredAnchorCount > 0
          ? [`  rewind points ${restoredAnchorCount} restored from before the resume`]
          : []),
      ].join('\n'));
      const returnContextMode = getReturnContextMode(ctx.platform.configManager);
      if (returnContextMode !== 'off' && meta.returnContext) {
        for (const line of formatReturnContextForDisplay(meta.returnContext)) {
          ctx.print(`  ${line}`);
        }
        if ((meta.returnContext.remoteRunners?.length ?? 0) > 0) {
          ctx.print('  Remote re-entry. Handle remote build-host recovery outside Agent; delegate explicit build/fix/review recovery from Agent.');
        }
        if ((meta.returnContext.worktreePaths?.length ?? 0) > 0) {
          ctx.print('  Worktree re-entry. Open GoodVibes TUI in the target workspace; delegate explicit build/fix/review recovery from Agent.');
        }
        if (returnContextMode === 'assisted') {
          const helperModel = providerApi.createHelperModel(ctx.platform.configManager);
          void maybeAssistReturnContextSummary(ctx.platform.configManager, helperModel, meta.returnContext).then((assisted) => {
            if (!assisted.assistedNarrative) return;
            ctx.print(`  Assist ${assisted.assistedNarrative}`);
            ctx.renderRequest();
          });
        }
      }
    } catch (e) {
      ctx.print(formatSessionFailure('resume session', e));
    }
    return true;
  }

  if (sub === 'fork') {
    const sourceSessionId = ctx.session.runtime.sessionId;
    const newId = `user-${randomBytes(4).toString('hex')}`;
    const messages = ctx.session.conversationManager.getMessageSnapshot();
    const currentTitle = ctx.session.conversationManager.title;
    const forkName = args[1] ? args.slice(1).join(' ').trim() : `fork-of-${sourceSessionId.slice(0, 8)}`;
    const meta: SessionMeta = {
      title: forkName,
      model: ctx.session.runtime.model,
      provider: ctx.session.runtime.provider,
      timestamp: Date.now(),
      titleSource: ctx.session.conversationManager.getTitleSource(),
      // /session fork is user-directed, stamp 'user' so retention never
      // reclaims the forked file. See saveSource's doc comment on SessionMeta.
      saveSource: 'user',
    };
    try {
      sm.save(newId, messages, meta);
      ctx.session.runtime.sessionId = newId;
      // Fork re-homes the live session onto the new id, write the
      // last-session pointer through the surface-bound closure, same as
      // /session resume, so the next launch resumes the fork, not the source.
      ctx.session.writeLastSessionPointer?.(newId);
      ctx.session.conversationManager.title = forkName;
      ctx.renderRequest();
      ctx.print([
        'Session forked',
        `  id ${newId}`,
        `  name ${forkName}`,
        `  from ${currentTitle || sourceSessionId}`,
        `  messages ${messages.length}`,
      ].join('\n'));
    } catch (e) {
      ctx.print(formatSessionFailure('fork session', e));
    }
    return true;
  }

  if (sub === 'save') {
    const messages = ctx.session.conversationManager.getMessageSnapshot();
    const rawName = args[1] ? args.slice(1).join(' ').trim() : (ctx.session.conversationManager.title || ctx.session.runtime.sessionId);
    const meta: SessionMeta = {
      title: ctx.session.conversationManager.title,
      model: ctx.session.runtime.model,
      provider: ctx.session.runtime.provider,
      timestamp: Date.now(),
      titleSource: ctx.session.conversationManager.getTitleSource(),
      // /session save is user-directed, stamp 'user' so retention never
      // reclaims it. See saveSource's doc comment on SessionMeta.
      saveSource: 'user',
    };
    try {
      const { filePath, sanitizedName } = sm.save(rawName, messages, meta);
      ctx.session.runtime.sessionId = sanitizedName;
      ctx.print([
        'Session saved',
        `  name ${rawName}`,
        ...(sanitizedName !== rawName ? [`  saved as ${sanitizedName}`] : []),
        `  path ${filePath}`,
      ].join('\n'));
    } catch (e) {
      ctx.print(formatSessionFailure('save session', e));
    }
    return true;
  }

  if (sub === 'info') {
    const target = args[1] || ctx.session.runtime.sessionId;
    const sessions = sm.list();
    const found = sessions.find((session) => session.name === target || session.name.startsWith(target));
    if (!found) {
      ctx.print(`Session not found ${target}`);
      return true;
    }
    const date = new Date(found.timestamp).toLocaleString();
    ctx.print([
      `Session ${found.name}`,
      `  title ${found.title || '(untitled)'}`,
      `  model ${found.model || '(unknown)'}`,
      `  provider ${found.provider || '(unknown)'}`,
      `  date ${date}`,
      `  messages ${found.messageCount}`,
      `  file ${found.filePath}`,
      ...(found.returnContext ? formatReturnContextForDisplay(found.returnContext).map((line) => `  ${line}`) : []),
    ].join('\n'));
    return true;
  }

  if (sub === 'export') {
    const target = args[1];
    if (!target) {
      ctx.print('Usage: /session export <session-id> [markdown|text]\nUse /session export . to export the current session.');
      return true;
    }
    const format = (args[2] || 'markdown').toLowerCase();
    const sessionId = target === '.' ? ctx.session.runtime.sessionId : target;
    const sessions = sm.list();
    const found = sessions.find((session) => session.name === sessionId || session.name.startsWith(sessionId));
    if (!found && target !== '.') {
      try {
        const { meta, messages } = sm.load(sessionId);
        printSessionExport(ctx, sessionId, meta.title, readConversationMessageSnapshots(messages), format);
      } catch {
        ctx.print(`Session not found ${sessionId}`);
      }
      return true;
    }
    const loadName = found ? found.name : sessionId;
    try {
      const { meta, messages } = sm.load(loadName);
      printSessionExport(ctx, loadName, meta.title, readConversationMessageSnapshots(messages), format);
    } catch (e) {
      ctx.print(formatSessionFailure('export session', e));
    }
    return true;
  }

  if (sub === 'search') {
    const query = args.slice(1).join(' ').trim();
    if (!query) {
      ctx.print('Usage: /session search <keyword>');
      return true;
    }
    const results = sm.search(query);
    if (results.length === 0) {
      ctx.print(`No sessions found matching "${query}"`);
      return true;
    }
    const lines = [`Search results for "${query}" (${results.length} session${results.length !== 1 ? 's' : ''})\n`];
    for (const result of results) {
      const date = new Date(result.session.timestamp).toLocaleString();
      lines.push(`  ${result.session.name}  ${result.session.title || '(untitled)'}  ${date}  (${result.matchCount} match${result.matchCount !== 1 ? 'es' : ''})`);
      for (const snippet of result.snippets) {
        lines.push(`    > ${snippet}`);
      }
      lines.push('');
    }
    ctx.print(lines.join('\n'));
    return true;
  }

  if (sub === 'events' || sub === 'groups' || sub === 'hotspots') {
    const kind = parseTranscriptKind(args[1]);
    ctx.print(buildTranscriptReviewLines(ctx, kind, sub).join('\n'));
    return true;
  }

  if (sub === 'delete') {
    const parsed = stripYesFlag(args);
    const target = parsed.rest[1];
    if (!target) {
      ctx.print('Usage: /session delete <session-id> --yes');
      return true;
    }
    if (!parsed.yes) {
      requireYesFlag(ctx, `delete saved session ${target}`, '/session delete <session-id> --yes');
      return true;
    }
    const sessions = sm.list();
    const found = sessions.find((session) => session.name === target || session.name.startsWith(target));
    if (!found) {
      ctx.print(`Session not found ${target}`);
      return true;
    }
    if (found.name === ctx.session.runtime.sessionId) {
      ctx.print(`Cannot delete the active session (${found.name}).\nSwitch to another session first with /session resume <id>.`);
      return true;
    }
    try {
      sm.delete(found.name);
      ctx.print([
        'Session deleted',
        `  id ${found.name}`,
        ...(found.title ? [`  title ${found.title}`] : []),
      ].join('\n'));
    } catch (e) {
      ctx.print(formatSessionFailure('delete session', e));
    }
    return true;
  }

  return false;
}

// NOTE (core-verb pass): this file used to also export
// registerSessionWorkflowCommands(), a second top-level `/session` (alias
// `sess`) registration with its own usage text. It was NEVER called from
// startup, commands.ts only registers `sessionCommand` from ./session.ts,
// so it was dead code (would throw a CommandRegistry collision error if
// anyone ever did call it, since sessionCommand already owns the name). It
// has been deleted; there is no functional change, because sessionCommand's
// own default-branch fallback already calls handleSessionWorkflowCommand
// above for every subcommand this dead registrar advertised, including
// events/groups/hotspots, see ./session.ts's usage text, which now documents
// them too. See docs/decisions/2026-07-06-core-verb-spec.md (agent /session
// orphan, worst-class collision #4) and
// src/test/input/session-single-registration.test.ts for the regression
// guard.
