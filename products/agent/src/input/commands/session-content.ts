import { join, resolve } from 'path';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { SelectionItem } from '../selection-modal.ts';
import type { SessionMeta } from '@goodvibes-jev/engine/sdk/platform/sessions';
import { exportToMarkdown, extractText } from '@goodvibes-jev/engine/sdk/platform/export';
import { requireSessionManager, requireShellPaths } from './runtime-services.ts';
import { sessionCommand } from './session.ts';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { requireYesFlag, stripYesFlag } from './confirmation.ts';
import { readConversationMessageSnapshots } from '../../core/conversation-message-snapshot.ts';

function formatSessionFailure(action: string, error: unknown): string {
  return [
    `Failed to ${action}`,
    `  error ${summarizeError(error)}`,
  ].join('\n');
}

type ConversationSnapshotReader = {
  readonly getMessageSnapshot?: () => ReturnType<typeof readConversationMessageSnapshots>;
  readonly toJSON?: () => unknown;
};

function isObjectArray(value: unknown): value is readonly object[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'object' && entry !== null);
}

function getCurrentConversationMessages(ctx: CommandContext): ReturnType<typeof readConversationMessageSnapshots> {
  const manager = ctx.session.conversationManager as unknown as ConversationSnapshotReader;
  if (typeof manager.getMessageSnapshot === 'function') return manager.getMessageSnapshot();
  if (typeof manager.toJSON === 'function') {
    const serialized = manager.toJSON();
    if (serialized && typeof serialized === 'object' && 'messages' in serialized) {
      const messages = (serialized as { readonly messages?: unknown }).messages;
      if (isObjectArray(messages)) return readConversationMessageSnapshots(messages);
    }
  }
  throw new Error('Conversation manager cannot export message snapshots.');
}

export function registerSessionContentCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'export',
    description: 'Export conversation to a Markdown file',
    usage: '[format] [path] --yes',
    argsHint: '[markdown] [path]',
    async handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const { rest, yes } = stripYesFlag(args);
      let format = 'markdown';
      let outPath: string | undefined;
      for (const arg of rest) {
        if (arg === 'markdown' || arg === 'md' || arg === 'text' || arg === 'txt') {
          format = arg === 'md' ? 'markdown' : arg === 'txt' ? 'text' : arg;
        } else {
          outPath = arg;
        }
      }
      if (!outPath) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        outPath = `./conversation-${ts}.${format === 'markdown' ? 'md' : 'txt'}`;
      }
      const resolvedPath = shellPaths.resolveWorkspacePath(outPath);
      if (!shellPaths.isWithinWorkingDirectory(resolvedPath)) {
        ctx.print([
          'Error',
          '  message Export path must be within the current directory.',
        ].join('\n'));
        return;
      }
      if (!yes) {
        requireYesFlag(ctx, `export conversation to ${resolvedPath}`, '/export [format] [path] --yes');
        return;
      }

      try {
        const msgs = getCurrentConversationMessages(ctx);
        let fileContent: string;
        if (format === 'markdown') {
          fileContent = exportToMarkdown(msgs, {
            model: ctx.session.runtime.model,
            provider: ctx.session.runtime.provider,
            sessionId: ctx.session.runtime.sessionId,
            title: ctx.session.conversationManager.title || undefined,
          });
        } else {
          const lines: string[] = [];
          for (const m of msgs) {
            const role = m.role.toUpperCase();
            const content = extractText(m.content);
            if (!content.trim()) continue;
            lines.push(`[${role}]`);
            lines.push(content);
            lines.push('');
          }
          fileContent = lines.join('\n');
        }
        const { dirname } = await import('node:path');
        const dir = dirname(resolvedPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        await writeFile(resolvedPath, fileContent, 'utf-8');
        ctx.print([
          'Exported conversation',
          `  messages ${msgs.length}`,
          `  path ${resolvedPath}`,
        ].join('\n'));
      } catch (err) {
        ctx.print(formatSessionFailure('export conversation', err));
      }
    },
  });

  registry.register({
    name: 'title',
    description: 'Show or set the conversation title',
    usage: '[text]',
    argsHint: '[text]',
    handler(args, ctx) {
      if (args.length === 0) ctx.print(ctx.session.conversationManager.title ? `Conversation title\n  title ${ctx.session.conversationManager.title}` : 'No title set.');
      else {
        ctx.session.conversationManager.title = args.join(' ');
        ctx.print([
          'Title set',
          `  title ${ctx.session.conversationManager.title}`,
        ].join('\n'));
        ctx.renderRequest();
      }
    },
  });

  registry.register({
    name: 'save',
    description: 'Save current session to .goodvibes/agent/sessions/',
    usage: '[name]',
    argsHint: '[name]',
    handler(args, ctx) {
      const sessionManager = requireSessionManager(ctx);
      const rawName = args[0] || ctx.session.conversationManager.title || `session-${Date.now()}`;
      const messages = ctx.session.conversationManager.getMessageSnapshot();
      const meta: SessionMeta = {
        title: ctx.session.conversationManager.title,
        model: ctx.session.runtime.model,
        provider: ctx.session.runtime.provider,
        timestamp: Date.now(),
        titleSource: ctx.session.conversationManager.getTitleSource(),
        // The user explicitly asked for this save (/save), so it is exempt
        // from the session-conversations retention sweep, unlike the
        // TURN_COMPLETED auto-save (startup-wiring.ts), which stays 'auto'.
        saveSource: 'user',
      };
      try {
        const { filePath, sanitizedName } = sessionManager.save(rawName, messages, meta);
        ctx.print([
          'Session saved',
          `  name ${rawName}`,
          ...(sanitizedName !== rawName ? [`  saved as ${sanitizedName}`] : []),
          `  path ${filePath}`,
        ].join('\n'));
      } catch (e) {
        ctx.print(formatSessionFailure('save session', e));
      }
    },
  });

  registry.register({
    name: 'load',
    description: 'Load a saved session',
    usage: '<name>',
    argsHint: '<name>',
    handler(args, ctx) {
      if (!args[0]) {
        ctx.print('Usage: /load <session-name>\nRun /sessions to list available sessions.');
        return;
      }
      const sessionManager = requireSessionManager(ctx);
      try {
        const { meta, messages, agentRecords } = sessionManager.load(args[0]);
        ctx.session.conversationManager.resetAll();
        ctx.session.conversationManager.fromJSON({ messages: readConversationMessageSnapshots(messages) });
        if (meta.title) ctx.session.conversationManager.title = meta.title;
        ctx.session.conversationManager.rebuildHistory();
        ctx.renderRequest();
        ctx.print([
          'Session loaded',
          `  id ${args[0]}`,
          `  messages ${messages.length}`,
          ...(agentRecords.length > 0 ? [`  ignored connected-host records ${agentRecords.length}`] : []),
        ].join('\n'));
      } catch (e) {
        ctx.print(formatSessionFailure('load session', e));
      }
    },
  });

  registry.register({
    name: 'undo',
    aliases: [],
    description: 'Undo the last conversation turn',
    usage: '',
    argsHint: '',
    handler(args, ctx) {
      if (args.length > 0) {
        ctx.print('Usage: /undo\n  Removes the last conversation turn. Use execution action:"recovery" for local file edit undo.');
        return;
      }
      const success = ctx.session.conversationManager.undo();
      if (success) {
        ctx.print('Last turn undone. Use /redo to restore.');
        ctx.renderRequest();
      } else {
        ctx.print('Nothing to undo.');
      }
    },
  });

  registry.register({
    name: 'redo',
    description: 'Redo the last undone conversation turn',
    usage: '',
    argsHint: '',
    handler(args, ctx) {
      if (args.length > 0) {
        ctx.print('Usage: /redo\n  Restores the last undone conversation turn. Use execution action:"recovery" for local file edit redo.');
        return;
      }
      const success = ctx.session.conversationManager.redo();
      if (success) {
        ctx.print('Turn restored.');
        ctx.renderRequest();
      } else {
        ctx.print('Nothing to redo.');
      }
    },
  });

  registry.register({
    name: 'retry',
    aliases: ['r'],
    description: 'Re-send the last user message',
    usage: '[modified text]',
    argsHint: '[modified text]',
    handler(args, ctx) {
      const lastMsg = ctx.session.conversationManager.getLastUserMessage();
      if (!lastMsg) {
        ctx.print('No message to retry.');
        return;
      }
      ctx.session.conversationManager.undo();
      ctx.submitInput?.(args.length > 0 ? args.join(' ') : lastMsg);
    },
  });

  registry.register({
    name: 'sessions',
    description: 'List saved sessions',
    usage: '[resume <id|name>]',
    argsHint: '[resume <id|name>]',
    async handler(_args, ctx) {
      // Matches the TUI's /sessions (worst-class collision #5): this
      // was `hidden: true` here, invisible in help/autocomplete, even
      // though it is a fully working command identical in behavior to the
      // TUI's visible one. Also forward args to /session (the TUI's fix for
      // the `/sessions resume <id>` muscle-memory case), instead of silently
      // listing and dropping the subcommand+id on the floor.
      if (_args.length > 0) {
        await sessionCommand.handler(_args, ctx);
        return;
      }
      const sessionManager = requireSessionManager(ctx);
      const sessions = sessionManager.list();
      if (ctx.openSelection) {
        const items: SelectionItem[] = sessions.length === 0
          ? [{ id: '_empty', label: 'No saved sessions', detail: 'Open Agent Workspace -> Conversation -> Save current session' }]
          : sessions.map(s => ({ id: s.name, label: s.name, detail: s.title || '(untitled)', actions: 'Enter to load' }));
        ctx.openSelection('Sessions', items, { allowSearch: true }, (result) => {
          if (!result) return;
          try {
            const { meta, messages } = sessionManager.load(result.item.id);
            ctx.session.conversationManager.resetAll();
            ctx.session.conversationManager.fromJSON({ messages: readConversationMessageSnapshots(messages) });
            if (meta.title) ctx.session.conversationManager.title = meta.title;
            ctx.session.conversationManager.rebuildHistory();
            ctx.renderRequest();
            ctx.print([
              'Session loaded',
              `  id ${result.item.id}`,
              `  messages ${messages.length}`,
            ].join('\n'));
          } catch (e) {
            ctx.print(formatSessionFailure('load session', e));
          }
        });
        return;
      }
      const lines = ['Saved sessions', ''];
      for (const s of sessions) lines.push(`  ${s.name.padEnd(30)} ${(s.title || '(untitled)').padEnd(24)} ${new Date(s.timestamp).toLocaleString()}  (${s.messageCount} msgs)`);
      ctx.print(lines.join('\n'));
    },
  });
}
