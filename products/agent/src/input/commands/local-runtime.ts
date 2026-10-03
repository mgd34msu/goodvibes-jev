import { dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { CommandRegistry, CommandContext } from '../command-registry.ts';
import type { SelectionItem } from '../selection-modal.ts';
import type { ContentPart } from '@goodvibes-jev/engine/sdk/platform/providers';
import { resolveAndValidatePath } from '@goodvibes-jev/engine/sdk/platform/utils';
import { BUILTIN_SECRET_PROVIDER_SOURCES, describeSecretRef, isSecretRefInput, resolveSecretRef } from '@goodvibes-jev/engine/sdk/platform/config';
import { requireBookmarkManager, requireProviderApi, requireSecretsManager } from './runtime-services.ts';
import { credentialWriteScopeWasRelocated, resolveCredentialDeleteScope, resolveCredentialWriteScope } from '../../config/credential-scope.ts';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { requireYesFlag, stripYesFlag } from './confirmation.ts';
import {
  formatAgentMediaGenerationResult,
  generateAgentMedia,
} from '../../agent/media-generation.ts';

function isGoodVibesSecretRefInput(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith('goodvibes://secrets/') && isSecretRefInput(normalized);
}

function isMalformedGoodVibesSecretRefInput(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith('goodvibes://') && !isGoodVibesSecretRefInput(normalized);
}

function toggleBlocks(typeFilter: string, collapsed: boolean, ctx: CommandContext): void {
  const VALID_TYPES = ['all', 'thinking', 'tool', 'code'] as const;
  if (!VALID_TYPES.includes(typeFilter as typeof VALID_TYPES[number])) {
    ctx.print(`Unknown type ${typeFilter}\nValid types ${VALID_TYPES.join(', ')}`);
    return;
  }
  const blockRegistry = ctx.session.conversationManager.getBlockRegistry();
  if (!blockRegistry || blockRegistry.length === 0) {
    ctx.print('No blocks found.');
    return;
  }
  let count = 0;
  for (let i = 0; i < blockRegistry.length; i++) {
    const block = blockRegistry[i];
    // A merged assistant turn (type 'assistant_turn', see
    // work-tree-model.ts) owns the whole tool subtree beneath its
    // header, so '/expand tool'/'collapse tool' treats it the same as a plain
    // 'tool' block, toggling the header's collapse key shows or hides every
    // tool row underneath it.
    const matchesType = typeFilter === 'all'
      || (typeFilter === 'tool' && (block.type === 'tool' || block.type === 'assistant_turn'))
      || (typeFilter === 'code' && block.type === 'code')
      || (typeFilter === 'thinking' && block.type === 'thinking');
    if (!matchesType) continue;
    const isCurrentlyCollapsed = ctx.session.conversationManager.isCollapsed(i);
    if (collapsed ? !isCurrentlyCollapsed : isCurrentlyCollapsed) {
      ctx.session.conversationManager.toggleCollapseAtLine(block.startLine);
      // Expanding a turn also expands each result's own collapse key in the
      // same pass. A result hidden by a collapsed turn pushes no BlockMeta of
      // its own, so it never surfaces from this loop to be toggled
      // individually, without this, '/expand tool' would only open the turn
      // header and each result would still render at its own default collapse
      // state, needing a second pass. '/collapse tool' needs no matching step:
      // collapsing the turn hides every result regardless of its own key.
      if (!collapsed && block.type === 'assistant_turn' && block.groupMemberIndexes) {
        for (const [k, memberIdx] of block.groupMemberIndexes.entries()) {
          const memberKey = block.groupMemberKeys?.[k] ?? `msg_${memberIdx}`;
          ctx.session.conversationManager.setCollapsed(memberKey, false);
          // An explicit /expand is a deliberate user action on this key, same
          // as Tab/Ctrl+Y/Ctrl+B, exempts it from search's close-time
          // auto-re-collapse (see ConversationManager.noteUserTouch).
          ctx.session.conversationManager.noteUserTouch(memberKey);
        }
      }
      count++;
    }
  }
  ctx.print(`${collapsed ? 'Collapsed' : 'Expanded'} ${count} block${count !== 1 ? 's' : ''}${typeFilter !== 'all' ? ` (${typeFilter})` : ''}.`);
  ctx.renderRequest();
}

interface MediaGenerateArgs {
  readonly prompt: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly outputMimeType?: string;
  readonly yes: boolean;
  readonly errors: readonly string[];
}

function readFlagValue(args: readonly string[], index: number, flag: string, errors: string[]): string | null {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    errors.push(`${flag} requires a value.`);
    return null;
  }
  return value;
}

function parseMediaGenerateArgs(args: readonly string[]): MediaGenerateArgs {
  const parsed = stripYesFlag([...args]);
  const errors: string[] = [];
  const promptParts: string[] = [];
  let providerId: string | undefined;
  let modelId: string | undefined;
  let outputMimeType: string | undefined;
  for (let index = 0; index < parsed.rest.length; index += 1) {
    const arg = parsed.rest[index];
    if (arg === '--provider') {
      providerId = readFlagValue(parsed.rest, index, arg, errors) ?? providerId;
      index += 1;
    } else if (arg === '--model') {
      modelId = readFlagValue(parsed.rest, index, arg, errors) ?? modelId;
      index += 1;
    } else if (arg === '--mime') {
      outputMimeType = readFlagValue(parsed.rest, index, arg, errors) ?? outputMimeType;
      index += 1;
    } else if (arg?.startsWith('--')) {
      errors.push(`Unknown media generation flag ${arg}`);
    } else if (arg) {
      promptParts.push(arg);
    }
  }
  const prompt = promptParts.join(' ').trim();
  if (!prompt) errors.push('Media generation prompt is required.');
  return {
    prompt,
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(outputMimeType ? { outputMimeType } : {}),
    yes: parsed.yes,
    errors,
  };
}

export function registerLocalRuntimeCommands(registry: CommandRegistry): void {
  registry.register({ name: 'expand', description: 'Expand blocks by type', hidden: true, usage: '[all|thinking|tool|code]', argsHint: '[all|thinking|tool|code]', handler(args, ctx) { toggleBlocks(args[0] || 'all', false, ctx); } });
  registry.register({ name: 'collapse', description: 'Collapse blocks by type', hidden: true, usage: '[all|thinking|tool|code]', argsHint: '[all|thinking|tool|code]', handler(args, ctx) { toggleBlocks(args[0] || 'all', true, ctx); } });

  registry.register({
    name: 'activity',
    description: 'Show running work, what needs you, what is coming up, and recent activity',
    handler(_args, ctx) {
      if (ctx.openActivityModal) {
        ctx.openActivityModal();
        return;
      }
      ctx.print('The Activity view needs the interactive shell.');
    },
  });

  registry.register({
    name: 'notifications',
    description: 'Show every notice and notification in full, newest first',
    handler(_args, ctx) {
      if (ctx.openNotifications) {
        ctx.openNotifications();
        return;
      }
      ctx.print('The notification history needs the interactive shell.');
    },
  });

  registry.register({
    name: 'bookmarks',
    aliases: ['bm'],
    description: 'List bookmarked blocks',
    hidden: true,
    handler(_args, ctx) {
      if (ctx.openBookmarkModal) {
        ctx.openBookmarkModal();
        return;
      }
      const bm = requireBookmarkManager(ctx);
      const entries = bm.list();
      if (ctx.openSelection) {
        const deleteAction = new Map([['d', 'delete' as const]]);
        const items: SelectionItem[] = entries.length === 0
          ? [{ id: '_empty', label: 'No bookmarks', detail: 'Use Ctrl+B to bookmark' }]
          : entries.map(entry => ({ id: entry.key, label: entry.label, detail: new Date(entry.timestamp).toLocaleTimeString(), actions: '[d] delete' }));
        ctx.openSelection('Bookmarks', items, { allowSearch: true, customActions: deleteAction }, (result) => {
          if (!result) return;
          if (result.action === 'delete') {
            bm.toggle(result.item.id);
            ctx.print(`Bookmark removed: ${result.item.id}`);
          } else {
            ctx.jumpToBookmark?.(result.item.id);
          }
        });
        return;
      }
      ctx.print(['Bookmarks:', '', ...entries.map(entry => `  ${entry.key.padEnd(32)} ${entry.label}  (${new Date(entry.timestamp).toLocaleTimeString()})`)].join('\n'));
    },
  });

  registry.register({
    name: 'secrets',
    description: 'Manage hierarchy-aware secrets, external secret refs, and secure/plaintext storage policy controls',
    hidden: true,
    usage: 'set <KEY> <value> [--user|--project] [--secure|--plaintext] --yes | link <KEY> <secret-ref> [--user|--project] [--secure|--plaintext] --yes | get <KEY> | test <secret-ref> | providers | list | delete <KEY> [--user|--project] [--secure|--plaintext] --yes',
    argsHint: '<set|link|get|test|providers|list|delete> [KEY]',
    async handler(args, ctx) {
      const mgr = requireSecretsManager(ctx);
      const parsed = stripYesFlag(args);
      const [sub, ...rest] = parsed.rest;
      if (!sub || sub === 'list') {
        const records = await mgr.listDetailed();
        const storedRecords = records.filter((record) => record.source !== 'env');
        ctx.print(storedRecords.length === 0
          ? '[secrets] No secrets stored. Use: /secrets set <KEY> <value> --yes'
          : [
            '[secrets] Stored keys:',
            ...storedRecords.map((record) => `  ${record.key} (${record.source}${record.refSource ? `, ref:${record.refSource}` : ''}${record.overriddenByEnv ? ', env override' : ''})`),
          ].join('\n'));
        return;
      }
      if (sub === 'providers') {
        ctx.print([
          '[secrets] Built-in secret providers:',
          ...BUILTIN_SECRET_PROVIDER_SOURCES.map((source) => `  ${source}`),
          '',
          'Examples:',
          '  /secrets link OPENAI_API_KEY goodvibes://secrets/env/OPENAI_API_KEY --yes',
          '  /secrets link SLACK_BOT_TOKEN goodvibes://secrets/bitwarden?item=GoodVibes%20Slack&field=password&sessionEnv=BW_SESSION --yes',
          '  /secrets link SLACK_BOT_TOKEN goodvibes://secrets/vaultwarden?item=GoodVibes%20Slack&field=password&server=https%3A%2F%2Fvault.example.test --yes',
          '  /secrets link STRIPE_TOKEN goodvibes://secrets/bws/00000000-0000-0000-0000-000000000000?field=value&accessTokenEnv=BWS_ACCESS_TOKEN --yes',
          '  /secrets link OPENAI_API_KEY goodvibes://secrets/1password?vault=Private&item=GoodVibes%20OpenAI&field=API%20Key --yes',
        ].join('\n'));
        return;
      }
      if (sub === 'test') {
        const refText = rest.join(' ').trim();
        if (!refText) {
          ctx.print('[secrets] Usage: /secrets test <secret-ref>');
          return;
        }
        if (!isGoodVibesSecretRefInput(refText)) {
          ctx.print('[secrets] Invalid secret reference. Use /secrets providers for examples.');
          return;
        }
        try {
          const resolved = await resolveSecretRef(refText, { resolveLocalSecret: (key) => mgr.get(key) });
          ctx.print([
            `[secrets] ${describeSecretRef(refText)}`,
            `  status ${resolved.value ? 'resolved <redacted>' : 'missing'}`,
          ].join('\n'));
        } catch (error) {
          ctx.print(`[secrets] ${describeSecretRef(refText)} failed ${summarizeError(error)}`);
        }
        return;
      }
      if (sub === 'set' || sub === 'link') {
        const flags = new Set(rest.filter((value) => value.startsWith('--')));
        const valueParts = rest.filter((value) => !value.startsWith('--'));
        const [key, ...rawValueParts] = valueParts;
        if (!key || valueParts.length === 0) {
          ctx.print(`[secrets] Usage: /secrets ${sub} <KEY> <${sub === 'link' ? 'secret-ref' : 'value'}> [--user|--project] [--secure|--plaintext] --yes`);
          return;
        }
        const value = rawValueParts.join(' ');
        if (!parsed.yes) {
          requireYesFlag(ctx, `${sub === 'link' ? 'link secret reference for' : 'store secret value for'} ${key}`, `/secrets ${sub} <KEY> <${sub === 'link' ? 'secret-ref' : 'value'}> [--user|--project] [--secure|--plaintext] --yes`);
          return;
        }
        if (sub === 'link' && !isGoodVibesSecretRefInput(value)) {
          ctx.print('[secrets] Invalid secret reference. Use /secrets providers for examples.');
          return;
        }
        if (sub === 'set' && isMalformedGoodVibesSecretRefInput(value)) {
          ctx.print('[secrets] Invalid secret reference. Use /secrets providers for examples.');
          return;
        }
        // Same relocation rule as the `secrets set` CLI subcommand: the flag the
        // operator typed is honoured for everything except a credential the
        // daemon reads, which goes to the daemon tier and is reported as having
        // gone there. The printed scope is the tier the value ACTUALLY landed
        // in, printing the requested one would be a line that says the write
        // went somewhere it did not.
        const requestedScope = flags.has('--user') ? 'user' : 'project';
        const scope = resolveCredentialWriteScope(key, requestedScope);
        const medium = flags.has('--plaintext') ? 'plaintext' : 'secure';
        await mgr.set(key, value, { scope, medium });
        const relocationNote = credentialWriteScopeWasRelocated(key, requestedScope)
          ? `\n  filed in the daemon tier instead of ${requestedScope}, the daemon is what reads this credential, and it reads only its own tier`
          : '';
        ctx.print(sub === 'link'
          ? `[secrets] Linked: ${key} -> ${describeSecretRef(value)} (${scope}, ${medium})${relocationNote}`
          : `[secrets] Stored: ${key} (${scope}, ${medium})${relocationNote}`);
        return;
      }
      if (sub === 'get') {
        const [key] = rest;
        if (!key) {
          ctx.print('[secrets] Usage: /secrets get <KEY>');
          return;
        }
        const value = await mgr.get(key);
        ctx.print(value === null ? `[secrets] Not found: ${key}` : `[secrets] ${key} = <stored> (use /secrets list to see all keys)`);
        return;
      }
      if (sub === 'delete') {
        const flags = new Set(rest.filter((value) => value.startsWith('--')));
        const [key] = rest.filter((value) => !value.startsWith('--'));
        if (!key) {
          ctx.print('[secrets] Usage: /secrets delete <KEY> [--user|--project] [--secure|--plaintext] --yes');
          return;
        }
        if (!parsed.yes) {
          requireYesFlag(ctx, `delete secret ${key}`, '/secrets delete <KEY> [--user|--project] [--secure|--plaintext] --yes');
          return;
        }
        // Sweep every tier for a daemon-read credential: it lives in the daemon
        // tier whatever the caller asked for, and a delete narrowed to the
        // requested scope would report success while leaving the live copy in
        // place.
        await mgr.delete(key, {
          scope: resolveCredentialDeleteScope(key, flags.has('--user') ? 'user' : flags.has('--project') ? 'project' : undefined),
          medium: flags.has('--plaintext') ? 'plaintext' : flags.has('--secure') ? 'secure' : undefined,
        });
        ctx.print([
          '[secrets] Deleted',
          `  key ${key}`,
        ].join('\n'));
        return;
      }
      ctx.print('[secrets] Usage: /secrets set <KEY> <value> [--user|--project] [--secure|--plaintext] --yes | link <KEY> <secret-ref> [--user|--project] [--secure|--plaintext] --yes | get <KEY> | test <secret-ref> | providers | list | delete <KEY> [--user|--project] [--secure|--plaintext] --yes');
    },
  });

  registry.register({
    name: 'image',
    aliases: ['img'],
    description: 'Attach an image file to the next message',
    usage: '<path> [prompt text]',
    argsHint: '<path> [prompt]',
    async handler(args, ctx) {
      if (args.length === 0) {
        ctx.print('Usage: /image <path> [prompt text]\nSupported formats: PNG, JPEG, WebP, GIF');
        return;
      }
      const rawPath = args[0];
      const promptText = args.slice(1).join(' ') || `Attached image: ${rawPath.split('/').pop() ?? rawPath}`;
      const projectRoot = ctx.workspace.shellPaths?.workingDirectory ?? ctx.platform.configManager.getWorkingDirectory();
      if (!projectRoot) {
        ctx.print([
          'Error',
          '  message working directory is unavailable.',
        ].join('\n'));
        return;
      }
      let resolvedPath: string;
      try {
        resolvedPath = resolveAndValidatePath(rawPath, projectRoot);
      } catch (err) {
        ctx.print([
          'Error',
          `  message ${summarizeError(err)}`,
        ].join('\n'));
        return;
      }
      if (!existsSync(resolvedPath)) {
        ctx.print(`File not found ${rawPath}`);
        return;
      }
      const ext = resolvedPath.slice(resolvedPath.lastIndexOf('.')).toLowerCase();
      const mediaType = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' } as Record<string, string>)[ext];
      if (!mediaType) {
        ctx.print(`Unsupported image format ${ext}\nSupported .png, .jpg, .jpeg, .webp, .gif`);
        return;
      }
      const stat = statSync(resolvedPath);
      if (stat.size > 20 * 1024 * 1024) {
        ctx.print(`Image too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Maximum 20MB`);
        return;
      }
      let data: string;
      try {
        data = (await readFile(resolvedPath)).toString('base64');
      } catch (err) {
        ctx.print(`Failed to read image ${summarizeError(err)}`);
        return;
      }
      const currentModel = await requireProviderApi(ctx).getCurrentModel();
      if (!currentModel.capabilities.multimodal) {
        ctx.print(`Warning: ${currentModel.displayName} does not support image input. The image will be stripped when sending.`);
      }
      const content: ContentPart[] = [{ type: 'text', text: promptText }, { type: 'image', data, mediaType }];
      ctx.submitInput?.(promptText, content);
    },
  });

  registry.register({
    name: 'media',
    description: 'Inspect media providers or generate media through configured providers',
    hidden: true,
    usage: 'providers | generate [--provider <id>] [--model <id>] [--mime <mime>] <prompt> --yes',
    argsHint: '<providers|generate>',
    async handler(args, ctx) {
      const subcommand = args[0]?.toLowerCase() || 'providers';
      const registry = ctx.platform.mediaProviderRegistry;
      if (!registry) {
        ctx.print('[media] Media providers are not available in this runtime.');
        return;
      }
      if (subcommand === 'providers' || subcommand === 'status' || subcommand === 'list') {
        const statuses = await registry.status();
        ctx.print([
          '[media] Providers:',
          ...statuses.map((provider) => `  ${provider.id}: ${provider.state}${provider.configured ? '' : ' (setup needed)'} - ${provider.capabilities.join(', ')}${provider.detail ? ` - ${provider.detail}` : ''}`),
        ].join('\n'));
        return;
      }
      if (subcommand !== 'generate') {
        ctx.print('[media] Usage: /media providers | /media generate [--provider <id>] [--model <id>] [--mime <mime>] <prompt> --yes');
        return;
      }
      const artifactStore = ctx.platform.artifactStore;
      if (!artifactStore) {
        ctx.print('[media] Artifact storage is not available in this runtime.');
        return;
      }
      const parsed = parseMediaGenerateArgs(args.slice(1));
      if (parsed.errors.length > 0) {
        ctx.print(`[media] ${parsed.errors.join('\n[media] ')}`);
        return;
      }
      if (!parsed.yes) {
        requireYesFlag(ctx, `generate media for "${parsed.prompt}"`, '/media generate [--provider <id>] [--model <id>] [--mime <mime>] <prompt> --yes');
        return;
      }
      try {
        const result = await generateAgentMedia(registry, artifactStore, parsed);
        ctx.print(formatAgentMediaGenerationResult(result));
      } catch (error) {
        ctx.print(`[media] Generation failed ${summarizeError(error)}`);
      }
    },
  });

  registry.register({
    name: 'refresh-models',
    description: 'Refresh model catalog, benchmarks, and token limits',
    hidden: true,
    async handler(_args, ctx) {
      const providerApi = requireProviderApi(ctx);
      let catalogOk = false;
      let benchmarksOk = false;
      let limitsOk = false;
      ctx.print('Refreshing model catalog...');
      try {
        const catalog = await providerApi.refreshCatalog();
        catalogOk = true;
        ctx.print(`Model catalog refreshed: ${catalog.modelCount} models from ${catalog.providerCount} providers`);
      } catch (e) {
        ctx.print(`Catalog refresh failed ${summarizeError(e)}`);
      }
      ctx.print('Refreshing benchmarks...');
      try {
        const benchmarkCount = await providerApi.refreshBenchmarks();
        benchmarksOk = true;
        ctx.print(benchmarkCount > 0
          ? `Benchmarks refreshed: ${benchmarkCount} model records available.`
          : 'Benchmarks refreshed.');
      } catch (e) {
        ctx.print(`Benchmarks refresh failed ${summarizeError(e)}`);
      }
      ctx.print('Refreshing token limits...');
      try {
        const count = await providerApi.refreshModelLimits();
        limitsOk = true;
        ctx.print(`Token limits refreshed: ${count} models updated.`);
      } catch (e) {
        ctx.print(`Token limits refresh failed ${summarizeError(e)}`);
      }
      if (!catalogOk || !benchmarksOk || !limitsOk) ctx.print('Some refreshes failed, see messages above.');
    },
  });

  registry.register({
    name: 'pin',
    description: 'Pin a model to the favorites list',
    hidden: true,
    usage: '<model-id>',
    argsHint: '<model-id>',
    async handler(args, ctx) {
      const providerApi = requireProviderApi(ctx);
      const modelId = args[0];
      if (!modelId) {
        const favorites = await providerApi.getFavorites();
        ctx.print(
          favorites.pinned.length === 0
            ? 'No pinned models. Use /pin <model-id> to pin one.'
            : `Pinned models:\n${favorites.pinned.map((entry) => `  ★ ${entry.registryKey ?? entry.modelId}`).join('\n')}`,
        );
        return;
      }
      const favorites = await providerApi.getFavorites();
      if (favorites.pinned.some((entry) => entry.modelId === modelId || entry.registryKey === modelId)) {
        ctx.print(`Model already pinned ${modelId}`);
        return;
      }
      try {
        await providerApi.pinModel(modelId);
        ctx.print(`Pinned: ${modelId}`);
      } catch (e) {
        ctx.print([
          'Error',
          `  message ${summarizeError(e)}`,
        ].join('\n'));
      }
    },
  });

  registry.register({
    name: 'unpin',
    description: 'Unpin a model from the favorites list',
    hidden: true,
    usage: '<model-id>',
    argsHint: '<model-id>',
    async handler(args, ctx) {
      const providerApi = requireProviderApi(ctx);
      const modelId = args[0];
      if (!modelId) {
        ctx.print('Usage: /unpin <model-id>');
        return;
      }
      const favorites = await providerApi.getFavorites();
      const pinned = favorites.pinned.find((entry) => entry.registryKey === modelId || entry.modelId === modelId);
      if (!pinned) {
        ctx.print(`Model is not pinned: ${modelId}`);
        return;
      }
      await providerApi.unpinModel(pinned.registryKey);
      ctx.print(`Unpinned: ${modelId}`);
    },
  });
}
