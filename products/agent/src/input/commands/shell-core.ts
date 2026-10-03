import type { CommandContext, CommandRegistry, SlashCommand } from '../command-registry.ts';
import type { SelectionItem } from '../selection-modal.ts';
import {
  describeEffortForModel,
  describeServingEffort,
  effortPresentationForModel,
  publishActiveEffortOptions,
  requestedEffortLevel,
  resolveRequestedEffortForServingModel,
  servingEffortForLevel,
  toEffortModel,
} from '../../providers/reasoning-effort-surface.ts';
import { compactConversation, requireKeybindingsManager, requireProviderApi } from './runtime-services.ts';
import { startFreshConversation, type FreshConversationResult } from './fresh-conversation.ts';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';

function commandCategory(commandName: string): string {
  if ([
    'agent',
    'agent-profile',
    'brief',
    'health',
    'welcome',
    'setup',
    'tasks',
    'approval',
    'automation',
    'delegate',
    'schedule',
    'workplan',
    'plan',
  ].includes(commandName)) return 'Agent Operator';
  if ([
    'knowledge',
    'memory',
    'notes',
    'vibe',
    'vibes',
    'personas',
    'skills',
    'routines',
  ].includes(commandName)) return 'Knowledge & Local Context';
  if ([
    'channels',
    'notify',
    'qrcode',
    'pair',
  ].includes(commandName)) return 'Channels';
  if ([
    'model',
    'provider',
    'providers',
    'effort',
    'pin',
    'unpin',
    'refresh-models',
    'mode',
    'tts',
    'voice',
    'media',
    'image',
  ].includes(commandName)) return 'Model, Voice & Media';
  if ([
    'settings',
    'config',
    'keybindings',
    'shortcuts',
    'mcp',
    'secrets',
    'auth',
    'accounts',
    'subscription',
    'compat',
    'security',
    'trust',
    'bundle',
  ].includes(commandName)) return 'Setup & Security';
  if ([
    'save',
    'load',
    'sessions',
    'session',
    'conversation',
    'export',
    'title',
    'clear',
    'reset',
    'compact',
    'undo',
    'redo',
    'retry',
    'expand',
    'collapse',
    'context',
    'bookmarks',
    'paste',
    'next-error',
    'prev-error',
  ].includes(commandName)) return 'Conversation';
  return 'Tools & System';
}

function commandDetail(command: SlashCommand): string {
  const parts = [command.description];
  if (command.usage) parts.push(`usage: /${command.name} ${command.usage}`);
  if (command.aliases?.length) parts.push(`aliases: ${command.aliases.map((alias) => `/${alias}`).join(', ')}`);
  return parts.join(' | ');
}

/**
 * List registered commands as selection items.
 *
 * Hidden commands (`SlashCommand.hidden`) still run when typed and stay
 * discoverable via `/commands`, which lists everything labeled "(hidden)".
 * `/help` (both the interactive picker and the plain-text fallback) filters
 * them out per the doc contract on `SlashCommand.hidden`.
 */
function listRegisteredCommandItems(registry: CommandRegistry, options: { includeHidden: boolean }): SelectionItem[] {
  return registry.list()
    .slice()
    .filter((command) => options.includeHidden || !command.hidden)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((command) => ({
      id: `/${command.name}`,
      label: command.hidden ? `/${command.name} (hidden)` : `/${command.name}`,
      detail: commandDetail(command),
      category: commandCategory(command.name),
      primaryAction: 'select',
      actions: '[Enter] run command',
    }));
}

function registeredCommandListText(registry: CommandRegistry): string {
  const commands = listRegisteredCommandItems(registry, { includeHidden: false });
  return [
    'Open the Agent workspace first, then press / inside it to search every product action.',
    '',
    'Registered slash commands:',
    ...commands.map((item) => `  ${item.label} - ${item.detail}`),
  ].join('\n');
}

function openRegisteredCommandSelection(
  registry: CommandRegistry,
  ctx: CommandContext,
  options: { includeHidden: boolean },
): void {
  const items = listRegisteredCommandItems(registry, options);
  ctx.openSelection?.('Help  -  Commands', items, { allowSearch: true }, (result) => {
    if (!result) return;
    const command = result.item.id;
    if (command.startsWith('/')) {
      const parts = command.slice(1).trim().split(/\s+/);
      const name = parts[0];
      const cmdArgs = parts.slice(1);
      void (ctx.executeCommand?.(name, cmdArgs) ?? registry.execute(name, cmdArgs, ctx));
    }
  });
}

export function registerShellCoreCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'model',
    aliases: ['m'],
    description: 'Select or display the current LLM model',
    usage: '[model-id]',
    argsHint: '[name]',
    async handler(args, ctx) {
      const providerApi = requireProviderApi(ctx);
      if (args.length === 0) {
        if (ctx.openModelPicker) {
          ctx.openModelPicker();
        } else {
          const models = await providerApi.listModels({ selectableOnly: true });
          const lines = ['Available models:', ...models.map((model) =>
            `  ${model.current ? '▶' : ' '} ${model.registryKey.padEnd(36)} ${model.displayName} (${model.providerId})`,
          )];
          ctx.print(lines.join('\n'));
        }
      } else {
        const modelId = args[0];
        try {
          const selected = await providerApi.selectModel(modelId);
          ctx.session.runtime.model = selected.registryKey;
          ctx.session.runtime.provider = selected.providerId;
          ctx.platform.configManager.set('provider.model', selected.registryKey);
          ctx.print([
            'Switched model',
            `  model ${selected.displayName}`,
            `  provider ${selected.providerId}`,
          ].join('\n'));
          // The REQUESTED level may not exist on the model just selected.
          // Re-resolve it here, exactly as the picker's commit path does, so
          // `/model x` and picking x from the picker cannot disagree about
          // what is actually being sent.
          //
          // The resolution reads config (the requested preference) and writes
          // only the session's effective level. Writing the snapped value back
          // over the preference is what used to make the downgrade permanent.
          const switchedTo = toEffortModel(ctx.provider.providerRegistry.getCurrentModel());
          publishActiveEffortOptions(switchedTo, ctx.session.runtime.sessionId);
          const serving = resolveRequestedEffortForServingModel(ctx.platform.configManager, switchedTo);
          ctx.session.runtime.reasoningEffort = serving.effective ?? '';
          if (serving.requested !== '') {
            ctx.print([
              'Reasoning effort',
              `  level ${describeServingEffort(serving, switchedTo)}`,
            ].join('\n'));
            if (serving.note) ctx.print(serving.note);
          }
          void providerApi.recordModelUsage(selected.registryKey).catch((err) => { logger.debug('model usage record failed', { err }); });
        } catch (e) {
          ctx.print([
            'Error',
            `  message ${summarizeError(e)}`,
          ].join('\n'));
        }
      }
    },
  });

  registry.register({
    name: 'commands',
    aliases: ['cmds'],
    description: 'Browse all commands in a scrollable list',
    handler(_args, ctx) {
      if (ctx.openSelection) {
        openRegisteredCommandSelection(registry, ctx, { includeHidden: true });
        return;
      }
      if (ctx.openHelpOverlay) {
        ctx.openHelpOverlay();
        return;
      }
      ctx.print('Use /help for interactive command list');
    },
  });

  registry.register({
    name: 'shortcuts',
    aliases: ['keys', 'keybinds'],
    description: 'Show keyboard shortcuts reference',
    hidden: true,
    handler(_args, ctx) {
      if (ctx.openShortcutsOverlay) {
        ctx.openShortcutsOverlay();
        return;
      }
      ctx.print('Use ? key or /help for shortcuts');
    },
  });

  registry.register({
    name: 'keybindings',
    aliases: ['kb'],
    description: 'List current keyboard bindings and their config file path',
    hidden: true,
    handler(_args, ctx) {
      const km = requireKeybindingsManager(ctx);
      const all = km.getAll();
      const lines: string[] = [
        `Keybindings config: ${km.getConfigPath()}`,
        '',
        `  ${'Action'.padEnd(28)}  ${'Binding'.padEnd(20)}  Description`,
        `  ${'─'.repeat(28)}  ${'─'.repeat(20)}  ${'─'.repeat(34)}`,
      ];
      for (const { action, combos, description } of all) {
        const label = combos.map((combo) => km.formatCombo(combo)).join(', ');
        lines.push(`  ${action.padEnd(28)}  ${label.padEnd(20)}  ${description}`);
      }
      lines.push('');
      lines.push('To customize: create the config file with { "action": { "key": "x", "ctrl": true } }');
      ctx.print(lines.join('\n'));
    },
  });

  registry.register({
    name: 'paste',
    aliases: ['clip'],
    description: 'Insert clipboard text or image into the prompt',
    handler(_args, ctx) {
      if (!ctx.pasteFromClipboard) {
        ctx.print('Paste is not available in this context.');
        return;
      }
      const result = ctx.pasteFromClipboard();
      if (!result.pasted) {
        ctx.print('Clipboard does not contain supported text or image data.');
      }
    },
  });

  registry.register({
    name: 'help',
    aliases: ['h', '?'],
    description: 'Show available commands and keyboard shortcuts',
    argsHint: '[command]',
    handler(_args, ctx) {
      if (ctx.openSelection) {
        openRegisteredCommandSelection(registry, ctx, { includeHidden: false });
        return;
      }
      ctx.print(registeredCommandListText(registry));
    },
  });

  registry.register({
    name: 'clear',
    aliases: ['cls'],
    description: 'Start a fresh conversation (the current one is saved as its own session)',
    handler(_args, ctx) {
      if (ctx.isGenerating?.()) {
        ctx.print('A turn is still running. Stop it with Esc or let it finish, then /clear.');
        return;
      }
      let result: FreshConversationResult;
      try {
        result = startFreshConversation(ctx);
      } catch (e) {
        ctx.print(`Could not save the current conversation, so nothing was cleared: ${summarizeError(e)}`);
        return;
      }
      if (result.savedAs) ctx.print(`Fresh conversation. The previous one is saved as ${result.savedAs}: /session resume ${result.savedAs} returns to it.`);
      ctx.renderRequest();
    },
  });

  registry.register({
    name: 'reset',
    aliases: [],
    description: 'Full reset: clear display and conversation context',
    hidden: true,
    handler(_args, ctx) {
      ctx.session.conversationManager.resetAll();
      if (ctx.reloadSystemPrompt) {
        ctx.session.runtime.systemPrompt = ctx.reloadSystemPrompt();
      }
      ctx.session.conversationManager.rebuildHistory();
      ctx.renderRequest();
    },
  });

  registry.register({
    name: 'compact',
    aliases: [],
    description: 'Summarize conversation to free context window',
    async handler(_args, ctx) {
      ctx.print('Compacting conversation...');
      await compactConversation(ctx);
      ctx.print('Conversation compacted.');
      ctx.renderRequest();
    },
  });

  registry.register({
    name: 'quit',
    aliases: [':q'],
    description: 'Exit the application',
    handler(_args, ctx) {
      ctx.exit();
    },
  });

  registry.register({
    name: 'effort',
    aliases: ['e'],
    description: 'Show or set reasoning effort level',
    hidden: true,
    // No fixed list here. The accepted levels belong to the serving model, so
    // a fixed '[instant|low|medium|high]' hint would be wrong for every model
    // that offers 'none', 'minimal', 'xhigh' or 'max', and for every model
    // that rejects 'instant'. Running `/effort` with no argument prints the
    // real ones for the model currently in use.
    usage: '[level]',
    argsHint: '[level]',
    async handler(args, ctx) {
      // The ModelDefinition (not the provider-api record) is what carries the
      // structured ReasoningEffortSpec the honest wording is generated from.
      const definition = ctx.provider.providerRegistry.getCurrentModel();
      const model = toEffortModel(definition);
      const presentation = effortPresentationForModel(model);
      // Validation of provider.reasoningEffort happens against these real
      // levels rather than a fixed four-value list.
      publishActiveEffortOptions(model, ctx.session.runtime.sessionId);

      if (!presentation.configurable) {
        ctx.print(presentation.headline);
        if (presentation.caveat) ctx.print(presentation.caveat);
        return;
      }

      // The user's REQUESTED level, not the session's effective one: this
      // command is where the preference is read back and re-chosen, so it must
      // show what was asked for even while a capped model is serving.
      const current = requestedEffortLevel(ctx.platform.configManager);
      // What the list should open on, though, is the level in EFFECT, the
      // requested level snapped to this model. The requested level may not be
      // in the list at all when the model caps lower, and preselecting a
      // missing id lands the cursor on the lowest level instead of on what is
      // actually running.
      const inEffect = servingEffortForLevel(current, model).effective ?? current;

      const applyLevel = (level: string): void => {
        // An explicit user choice, the one kind of write that is allowed to
        // change the stored preference.
        ctx.platform.configManager.set('provider.reasoningEffort', level);
        const serving = servingEffortForLevel(level, model);
        ctx.session.runtime.reasoningEffort = serving.effective ?? '';
        ctx.print([
          'Reasoning effort set',
          `  level ${describeServingEffort(serving, model)}`,
        ].join('\n'));
        if (serving.note) ctx.print(serving.note);
      };

      if (args.length === 0) {
        if (ctx.openSelection) {
          const items: SelectionItem[] = presentation.choices.map((choice) => ({
            id: choice.level,
            label: choice.level,
            detail: choice.level === inEffect ? `◉ ${choice.description}` : choice.description,
          }));
          ctx.openSelection('Reasoning Effort', items, { preSelectId: inEffect, allowSearch: false }, (result) => {
            if (!result) return;
            applyLevel(result.item.id);
            ctx.renderRequest();
          });
          return;
        }
        ctx.print(describeEffortForModel(model, current || undefined).join('\n'));
        return;
      }

      const requested = args[0]!;
      if (!presentation.choices.some((choice) => choice.level === requested)) {
        const offered = presentation.choices.map((choice) => choice.level).join(', ');
        ctx.print([
          `${definition.displayName} does not offer reasoning effort '${requested}'.`,
          `  Levels it offers: ${offered}`,
        ].join('\n'));
        return;
      }

      applyLevel(requested);
    },
  });

}
