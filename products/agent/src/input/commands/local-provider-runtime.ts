import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import type { CommandRegistry } from '../command-registry.ts';
import { fetchModelContextWindows } from '@goodvibes-jev/engine/sdk/platform/discovery';
import type { CustomProviderConfig } from '@goodvibes-jev/engine/sdk/platform/providers';
import { requireProviderApi, requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { requireYesFlag, stripYesFlag } from './confirmation.ts';

function isValidProviderName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

function readDiscoveredModelIds(body: unknown): string[] {
  if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data)) return [];
  return body.data
    .filter((model): model is { readonly id: unknown } => Boolean(model) && typeof model === 'object' && 'id' in model)
    .map((model) => String(model.id))
    .filter(Boolean);
}

export function registerLocalProviderRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'provider',
    aliases: ['p'],
    description: 'Switch provider or manage custom providers (add/remove)',
    hidden: true,
    usage: '[add <name> <baseURL> [apiKey] --yes | remove <name> --yes | <provider-name>]',
    argsHint: '[name|add --yes|remove --yes]',
    async handler(args, ctx) {
      const parsed = stripYesFlag(args);
      const commandArgs = [...parsed.rest];
      const shellPaths = requireShellPaths(ctx);
      if (commandArgs[0] === 'add') {
        const addArgs = commandArgs.slice(1);
        if (addArgs.length < 2) {
          ctx.print('Usage: /provider add <name> <baseURL> [apiKey] --yes\nExample: /provider add my-server http://192.168.0.85:8001/v1 --yes');
          return;
        }
        const [name, baseURL, apiKey] = addArgs;
        if (!parsed.yes) {
          requireYesFlag(ctx, `add custom provider ${name}`, '/provider add <name> <baseURL> [apiKey] --yes');
          return;
        }
        if (!isValidProviderName(name)) {
          ctx.print([
            'Error',
            '  message Provider name must contain only letters, numbers, hyphens, and underscores.',
          ].join('\n'));
          return;
        }
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(baseURL);
        } catch {
          ctx.print([
            'Error',
            `  message ${baseURL} is not a valid URL. Example http://192.168.0.85:8001/v1`,
          ].join('\n'));
          return;
        }
        const providersDir = shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'providers');
        const providerFile = join(providersDir, `${name}.json`);
        if (existsSync(providerFile)) {
          ctx.print(`Provider ${name} already exists at ${providerFile}\nRemove it first with /provider remove ${name} --yes`);
          return;
        }

        ctx.print(`Probing ${baseURL}/models ...`);
        let discoveredModelIds: string[] = [];
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
          const res = await fetch(`${baseURL}/models`, { signal: controller.signal, headers });
          clearTimeout(timeoutId);
          if (res.ok) {
            const body = await res.json() as unknown;
            discoveredModelIds = readDiscoveredModelIds(body);
          }
        } catch {
          ctx.print(`Could not reach ${baseURL}/models, creating provider with a minimal starter config.`);
        }

        let contextWindows: Record<string, number> = {};
        if (discoveredModelIds.length > 0) {
          if (parsedUrl.protocol === 'http:') {
            try {
              contextWindows = await fetchModelContextWindows(parsedUrl.hostname, parseInt(parsedUrl.port) || 80, 'unknown', discoveredModelIds);
            } catch {}
          } else {
            ctx.print('Note: Context window detection is only supported for http:// URLs. Windows the endpoint does not report are left unknown.');
          }
        }
        const defaultModel = `${name}-model`;
        // A window is written only when the endpoint reported one. A guessed
        // number written here would read as the model's real window forever
        // after (the meter, compaction and prompt tier all trust it), so an
        // unreported window is left out and the model's window is unknown.
        const models: CustomProviderConfig['models'] = discoveredModelIds.length === 0
          ? [{
              id: defaultModel,
              displayName: defaultModel,
              capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
            }]
          : discoveredModelIds.map((id) => ({
              id,
              displayName: id,
              ...(contextWindows[id] !== undefined && contextWindows[id] > 0 ? { contextWindow: contextWindows[id] } : {}),
              capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
            }));
        const config: CustomProviderConfig = {
          name,
          displayName: name,
          type: 'openai-compat',
          baseURL,
          ...(apiKey ? { apiKey } : {}),
          models,
        };
        try {
          mkdirSync(providersDir, { recursive: true });
          await writeFile(providerFile, JSON.stringify(config, null, 2), 'utf-8');
        } catch (e) {
          ctx.print(`Error writing provider file ${summarizeError(e)}`);
          return;
        }
        ctx.print(`Provider ${name} added with ${models.length} model(s)\n${discoveredModelIds.length > 0 ? discoveredModelIds.map((id) => `  • ${id} (${contextWindows[id] !== undefined && contextWindows[id] > 0 ? `${contextWindows[id].toLocaleString()} ctx` : 'context window unknown'})`).join('\n') : `  • ${defaultModel} (starter entry)`}\nThe file watcher will auto-register it shortly.`);
        return;
      }

      if (commandArgs[0] === 'remove' || commandArgs[0] === 'rm') {
        const name = commandArgs[1];
        if (!name) {
          ctx.print('Usage: /provider remove <name> --yes');
          return;
        }
        if (!parsed.yes) {
          requireYesFlag(ctx, `remove custom provider ${name}`, '/provider remove <name> --yes');
          return;
        }
        if (!isValidProviderName(name)) {
          ctx.print([
            'Error',
            '  message Provider name must contain only letters, numbers, hyphens, and underscores.',
          ].join('\n'));
          return;
        }
        const providerFile = shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'providers', `${name}.json`);
        if (!existsSync(providerFile)) {
          ctx.print(`No custom provider ${name} found at ${providerFile}`);
          return;
        }
        try {
          await unlink(providerFile);
          ctx.print(`Provider ${name} removed. The file watcher will deregister it shortly.`);
        } catch (e) {
          ctx.print(`Error removing provider file ${summarizeError(e)}`);
        }
        return;
      }

      if (commandArgs.length === 0) {
        if (ctx.openProviderPicker) {
          ctx.openProviderPicker();
          return;
        }
        const providers = requireProviderApi(ctx).listProviderIds();
        ctx.print(['Available providers', ...providers.map((provider) => `  ${provider === ctx.session.runtime.provider ? '▶' : ' '} ${provider}`)].join('\n'));
        return;
      }

      const providerName = commandArgs[0];
      const requestedModel = commandArgs[1];
      const providerApi = requireProviderApi(ctx);
      try {
      const selectable = await providerApi.listModels({
        providerId: providerName,
        selectableOnly: true,
      });
      const match = selectable[0];
      if (!match) {
        ctx.print([
          `Unknown provider ${providerName}`,
          `available providers ${providerApi.listProviderIds().join(', ')}`,
        ].join('\n'));
        return;
      }
        const registryKey = requestedModel
          ? requestedModel.includes(':') ? requestedModel : `${providerName}:${requestedModel}`
          : match.registryKey;
        const selected = await providerApi.selectModel(registryKey);
        ctx.session.runtime.model = selected.registryKey;
        ctx.session.runtime.provider = selected.providerId;
        ctx.platform.configManager.set('provider.model', selected.registryKey);
        ctx.print(`Switched to provider: ${selected.providerId} (model: ${selected.modelId})`);
      } catch (e) {
        ctx.print([
          'Error',
          `  message ${summarizeError(e)}`,
        ].join('\n'));
      }
    },
  });
}
