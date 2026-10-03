import type { CommandRegistry } from '../command-registry.ts';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { requireYesFlag, stripYesFlag } from './confirmation.ts';
import { handleContextWindowSubcommand } from './context-window.ts';
import { AGENT_NOTIFICATIONS_METADATA_ONLY_KEY } from '../../config/host-settings.ts';
import {
  countHarnessSettings,
  formatHarnessError,
  formatHarnessMutation,
  formatHarnessSetting,
  formatHarnessSettingList,
  getEffectiveHarnessSetting,
  listEffectiveHarnessSettings,
  resetHarnessSetting,
  setHarnessSetting,
} from '../../agent/harness-control.ts';

function readValuedFlag(args: readonly string[], flag: string): string | undefined {
  const assignmentPrefix = `${flag}=`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === flag) {
      const value = args[index + 1];
      return value && !value.startsWith('--') ? value : undefined;
    }
    if (arg?.startsWith(assignmentPrefix)) return arg.slice(assignmentPrefix.length);
  }
  return undefined;
}

function stripValuedFlag(args: readonly string[], flag: string): readonly string[] {
  const next: string[] = [];
  const assignmentPrefix = `${flag}=`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === flag) {
      const value = args[index + 1];
      if (value && !value.startsWith('--')) index += 1;
      continue;
    }
    if (arg?.startsWith(assignmentPrefix)) {
      continue;
    }
    next.push(arg!);
  }
  return next;
}

function parseSettingListArgs(args: readonly string[]): {
  readonly category?: string;
  readonly prefix?: string;
  readonly query?: string;
  readonly includeHidden: boolean;
  readonly limit?: number;
} {
  const category = readValuedFlag(args, '--category');
  const prefix = readValuedFlag(args, '--prefix');
  const limitText = readValuedFlag(args, '--limit');
  const remaining = stripValuedFlag(stripValuedFlag(stripValuedFlag(args, '--category'), '--prefix'), '--limit')
    .filter((arg) => arg !== '--include-hidden');
  const query = remaining.join(' ').trim();
  return {
    ...(category ? { category } : {}),
    ...(prefix ? { prefix } : {}),
    ...(query ? { query } : {}),
    includeHidden: args.includes('--include-hidden'),
    ...(limitText ? { limit: Number(limitText) } : {}),
  };
}

export function registerOperatorRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'settings',
    aliases: ['cfg-ui'],
    description: 'Open, inspect, or update Agent settings',
    usage: '[category|key|list|get <key>|set <key> <value> --yes|reset <key> --yes]',
    argsHint: '[list|get|set|reset]',
    async handler(args, ctx) {
      const parsed = stripYesFlag(args);
      const commandArgs = [...parsed.rest];
      const sub = commandArgs[0];

      if (!sub) {
        if (ctx.openSettingsModal) ctx.openSettingsModal();
        else ctx.print('Configuration workspace is not available in this runtime.');
        return;
      }

      if (sub === 'list' || sub === 'schema') {
        // `total` is what matched, not what fits on the page, the formatter
        // needs both so a short page can name itself as short.
        const listFilters = parseSettingListArgs(commandArgs.slice(1));
        const listed = await listEffectiveHarnessSettings(ctx.platform.configManager, listFilters);
        ctx.print(formatHarnessSettingList(listed, countHarnessSettings(ctx.platform.configManager, listFilters)));
        return;
      }

      if (sub === 'get' || sub === 'show') {
        const key = commandArgs[1];
        if (!key) {
          ctx.print('Usage: /settings get <key>');
          return;
        }
        ctx.print(formatHarnessSetting(await getEffectiveHarnessSetting(ctx.platform.configManager, key)));
        return;
      }

      if (sub === 'set') {
        const key = commandArgs[1];
        const rawValue = commandArgs.slice(2).join(' ');
        if (!key || rawValue.length === 0) {
          ctx.print('Usage: /settings set <key> <value> --yes');
          return;
        }
        if (!parsed.yes) {
          requireYesFlag(ctx, `set setting ${key}`, '/settings set <key> <value> --yes');
          return;
        }
        try {
          // Text commands supply tokens; only the exact host boolean literals
          // become booleans. JSON-string values and friendly aliases are not
          // permission to include private notification details.
          const value = key === AGENT_NOTIFICATIONS_METADATA_ONLY_KEY
            && (rawValue === 'true' || rawValue === 'false') ? rawValue === 'true' : rawValue;
          const result = await setHarnessSetting(ctx.platform.configManager, ctx.platform.secretsManager, key, value);
          ctx.print(formatHarnessMutation(result));
          ctx.renderRequest();
        } catch (error) {
          ctx.print(formatHarnessError(error));
        }
        return;
      }

      if (sub === 'reset') {
        const key = commandArgs[1];
        if (!key) {
          ctx.print('Usage: /settings reset <key> --yes');
          return;
        }
        if (!parsed.yes) {
          requireYesFlag(ctx, `reset setting ${key}`, '/settings reset <key> --yes');
          return;
        }
        try {
          const result = await resetHarnessSetting(ctx.platform.configManager, ctx.platform.secretsManager, key);
          ctx.print(formatHarnessMutation(result));
          ctx.renderRequest();
        } catch (error) {
          ctx.print(formatHarnessError(error));
        }
        return;
      }

      if (sub.includes('.')) {
        ctx.print(formatHarnessSetting(await getEffectiveHarnessSetting(ctx.platform.configManager, sub)));
        return;
      }

      if (ctx.openSettingsModal) ctx.openSettingsModal(sub);
      else ctx.print('Configuration workspace is not available in this runtime.');
    },
  });

  registry.register({
    name: 'context',
    aliases: ['ctx'],
    description: 'Inspect context window usage (token breakdown per message), or show, set or clear the current model\'s context window',
    usage: '[window [<size>|clear]]',
    argsHint: '[window <size|clear>]',
    hidden: true,
    handler: (args, ctx) => {
      if (args[0]?.toLowerCase() === 'window') {
        handleContextWindowSubcommand(args.slice(1), ctx);
        return;
      }
      if (ctx.openContextInspector) {
        ctx.openContextInspector();
      } else {
        const msgs = ctx.session.conversationManager.getMessagesForLLM();
        if (msgs.length === 0) {
          ctx.print('[context] No messages in conversation.');
          return;
        }
        const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
        let total = 0;
        const lines: string[] = ['Context breakdown:'];
        for (const m of msgs) {
          const text = typeof m.content === 'string'
            ? m.content
            : (m.content as Array<{ type: string; text?: string }>)
              .filter((p) => p.type === 'text')
              .map((p) => p.text ?? '')
              .join('');
          const t = estimateTokens(text);
          total += t;
          lines.push(`  ${m.role.padEnd(12)} ~${t.toLocaleString()} tokens`);
        }
        lines.push(`  ${'Total'.padEnd(12)} ~${total.toLocaleString()} tokens (${msgs.length} messages)`);
        ctx.print(lines.join('\n'));
      }
    },
  });

  registry.register({
    name: 'next-error',
    aliases: ['ne'],
    description: 'Jump to the next error message in the conversation',
    hidden: true,
    handler(_args, ctx) {
      const nextLine = ctx.session.conversationManager.nextErrorLine(ctx.getScrollTop?.() ?? 0);
      if (nextLine < 0) ctx.print('[No error messages found in conversation]');
      else ctx.scrollToLine?.(nextLine);
    },
  });
  registry.register({
    name: 'prev-error',
    aliases: ['pe'],
    description: 'Jump to the previous error message in the conversation',
    hidden: true,
    handler(_args, ctx) {
      const prevLine = ctx.session.conversationManager.prevErrorLine(ctx.getScrollTop?.() ?? 0);
      if (prevLine < 0) ctx.print('[No error messages found in conversation]');
      else ctx.scrollToLine?.(prevLine);
    },
  });

  registry.register({
    name: 'mode',
    aliases: ['hitl'],
    description: 'Manage HITL UX notification mode (quiet/balanced/operator)',
    usage: '[quiet|balanced|operator --yes|show|set-domain <domain> <verbosity> --yes]',
    argsHint: '[preset|show|set-domain]',
    handler(args, ctx) {
      const mgr = ctx.ops.modeManager;
      if (!mgr) {
        ctx.print('Interaction mode manager is not available in this runtime.');
        return;
      }
      const parsed = stripYesFlag(args);
      const commandArgs = [...parsed.rest];
      const sub = commandArgs[0] ?? 'show';

      if (sub === 'quiet' || sub === 'balanced' || sub === 'operator') {
        if (!parsed.yes) {
          requireYesFlag(ctx, `set HITL mode to ${sub}`, '/mode <quiet|balanced|operator> --yes');
          return;
        }
        const newMode = sub as 'quiet' | 'balanced' | 'operator';
        mgr.setHITLMode(newMode);
        try {
          ctx.platform.configManager.setDynamic('behavior.hitlMode' as import('@goodvibes-jev/engine/sdk/platform/config').ConfigKey, newMode);
        } catch (e) {
          logger.warn('[/mode] Failed to persist mode', { error: summarizeError(e) });
        }
        const preset = mgr.getHITLPreset();
        ctx.print(`HITL mode set to: ${preset.name}\n${preset.description}`);
        ctx.renderRequest();
        return;
      }

      if (sub === 'show') {
        const current = mgr.getHITLMode();
        const preset = mgr.getHITLPreset();
        const overrides = mgr.getDomainOverrides();
        const lines: string[] = [
          `HITL mode: ${current}`,
          `  ${preset.description}`,
          `  Default domain verbosity: ${preset.defaultDomainVerbosity}`,
          `  Quiet-while-typing: ${preset.quietWhileTyping}`,
          `  Batch window: ${preset.batchWindowMs}ms`,
        ];
        const overrideEntries = Object.entries(overrides);
        if (overrideEntries.length > 0) {
          lines.push('  Per-domain overrides:');
          for (const [domain, verbosity] of overrideEntries) lines.push(`    ${domain}: ${verbosity}`);
        } else {
          lines.push('  No per-domain overrides.');
        }
        lines.push('');
        lines.push('Available presets:');
        for (const p of mgr.listHITLPresets()) {
          const marker = p.name === current ? '\u25b6' : ' ';
          lines.push(`  ${marker} ${p.name.padEnd(10)} ${p.description}`);
        }
        ctx.print(lines.join('\n'));
        return;
      }

      if (sub === 'set-domain') {
        const domain = commandArgs[1];
        const verbosity = commandArgs[2];
        if (!domain || !verbosity) {
          ctx.print('Usage: /mode set-domain <domain> <minimal|normal|verbose> --yes');
          return;
        }
        if (verbosity !== 'minimal' && verbosity !== 'normal' && verbosity !== 'verbose') {
          ctx.print(`Invalid verbosity "${verbosity}". Valid values minimal, normal, verbose.`);
          return;
        }
        if (!parsed.yes) {
          requireYesFlag(ctx, `set HITL verbosity for ${domain}`, '/mode set-domain <domain> <minimal|normal|verbose> --yes');
          return;
        }
        mgr.setDomainVerbosity(domain, verbosity as 'minimal' | 'normal' | 'verbose');
        ctx.print([
          'Domain verbosity set',
          `  domain ${domain}`,
          `  verbosity ${verbosity}`,
        ].join('\n'));
        return;
      }

      ctx.print(
        'Usage: /mode [quiet|balanced|operator --yes|show|set-domain <domain> <verbosity> --yes]\n'
        + '  /mode                         , show current mode and settings\n'
        + '  /mode show                    , show current mode and settings\n'
        + '  /mode quiet --yes             , suppress all non-critical notifications\n'
        + '  /mode balanced --yes          , show warnings, batch info noise (default)\n'
        + '  /mode operator --yes          , full verbosity, no suppression\n'
        + '  /mode set-domain <d> <v> --yes, per-domain verbosity override (minimal|normal|verbose)'
      );
    },
  });
}
