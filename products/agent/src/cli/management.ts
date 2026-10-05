import { runNativeHeadlessCommand } from './native-headless-command.ts';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import type { ConfigManager, ConfigKey, GoodVibesConfig } from '../config/index.ts';
import { CONFIG_SCHEMA } from '../config/index.ts';
import { formatProviderModel, getModelIdFromProviderModel } from '../config/provider-model.ts';
import { createRuntimeServices } from '../runtime/services.ts';
import { createRuntimeStore } from '../runtime/store/index.ts';
import { readConnectedHostOperatorToken } from '../runtime/connected-host-auth.ts';
import type { RuntimeServices } from '../runtime/services.ts';
import { SecretsManager } from '../config/secrets.ts';
import { RuntimeEventBus, configureRuntimeEventBusDefaults, runtimeEventBusOptionsFrom } from '@/runtime/index.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { writeFatalLine } from '../utils/fatal-boot-write.ts';
import { listProviderRuntimeSnapshots } from '@goodvibes-jev/engine/sdk/platform/providers';
import { BUILTIN_SECRET_PROVIDER_SOURCES, describeSecretRef, isSecretRefInput, resolveSecretRef } from '@goodvibes-jev/engine/sdk/platform/config';
import { getSubscriptionProviderConfig, listAvailableSubscriptionProviders } from '@goodvibes-jev/engine/sdk/platform/config';
import { beginOpenAICodexLogin, exchangeOpenAICodexCode } from '@goodvibes-jev/engine/sdk/platform/config';
import { inspectProviderAuth } from '@/runtime/index.ts';
import type { GoodVibesCliParseResult } from './types.ts';
import { formatProviderAuthRoute, summarizeProviderAuthRoutes } from './provider-auth-routes.ts';
import { classifyProviderSetup } from './provider-classification.ts';
import { handleBundleCommand } from './bundle-command.ts';
import { handleImportCommand } from './import-command.ts';
import { handleSecrets, handleSessions, handleTasks, renderPairing, renderSubscriptions } from './management-commands.ts';
import { handleAgentKnowledgeCommand, handleAgentKnowledgeShortcutCommand, handleCompatCommand, handleDelegateCommand } from './agent-knowledge-command.ts';
import { handlePersonasCommand } from './personas-command.ts';
import { handleSkillsCommand } from './skills-command.ts';
import { handleMemoryCommand } from './memory-command.ts';
import { handleProfilesCommand } from './profiles-command.ts';
import { handleRoutinesCommand } from './routines-command.ts';
import { handleCiCommand } from './ci-command.ts';
import { handlePrincipalsCommand } from './principals-command.ts';
import { handleOwnerProfileCommand } from './owner-profile-command.ts';
import { handleChannelProfilesCommand } from './channel-profiles-command.ts';
import { handleWorkspacesCommand } from './workspaces-command.ts';
import { handleBrowserCommand } from './browser-command.ts';
import { handleRelayCommand } from './relay-command.ts';
import { handleFleetCommand } from './fleet-command.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { dialHostForConfiguredHost } from '../config/connected-host-dial.ts';

export interface CliCommandRuntime {
  readonly cli: GoodVibesCliParseResult;
  readonly configManager: ConfigManager;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
}

interface CliCommandResult {
  readonly handled: boolean;
  readonly exitCode: number;
}

type Formatter = (value: unknown, text: string) => string;

export function yesNo(value: unknown): string {
  return value === true ? 'yes' : 'no';
}

export function formatJsonOrText(cli: GoodVibesCliParseResult): Formatter {
  return (value, text) => cli.flags.outputFormat === 'json'
    ? JSON.stringify(value, null, 2)
    : text;
}

function exitCodeForText(output: string): number {
  if (output.startsWith('Usage:') || output.startsWith('Invalid ') || output.startsWith('Unsupported')) return 2;
  if (output.startsWith('Session not found') || output.startsWith('Unknown task') || output.startsWith('Task submit failed ')) return 1;
  if (output.startsWith('No stored ') || output.startsWith('No pending ') || output.startsWith('No model ') || output.startsWith('No provider ') || output.startsWith('No auth ')) return 1;
  if (output.startsWith('Unknown ')) return 1;
  if (output === 'Bundle has no config object to import.') return 1;
  return 0;
}

function splitCommandOption(token: string): { readonly name: string; readonly value: string | undefined } {
  const index = token.indexOf('=');
  if (index < 0) return { name: token, value: undefined };
  return { name: token.slice(0, index), value: token.slice(index + 1) };
}

export function hasCommandFlag(args: readonly string[], name: string): boolean {
  return args.some((arg) => splitCommandOption(arg).name === name);
}

export function extractAuthorizationCode(input: string): string {
  try {
    const url = new URL(input);
    return url.searchParams.get('code') ?? input;
  } catch {
    return input;
  }
}

export function isPresentConfigValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== undefined && value !== null && value !== false;
}

function inferProviderFromRegistryKey(modelKey: string): string {
  if (modelKey.includes(':')) return modelKey.split(':')[0] || 'openai';
  if (modelKey.includes('/')) return modelKey.split('/')[0] || 'openai';
  return 'openai';
}

export function getNestedValue(source: unknown, key: string): unknown {
  let cursor = source;
  for (const part of key.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = Reflect.get(cursor, part);
  }
  return cursor;
}

function getLocalNetworkIp(): string {
  try {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const netInfo of nets[name] ?? []) {
        if (netInfo.family === 'IPv4' && !netInfo.internal) return netInfo.address;
      }
    }
  } catch {
    return '127.0.0.1';
  }
  return '127.0.0.1';
}

/**
 * Where THIS process dials. Shares the wildcard→loopback mapping with every
 * other dial site (config/connected-host-dial.ts).
 */
const connectHostForBindHost = dialHostForConfiguredHost;

/**
 * Where ANOTHER machine dials, a pairing QR code, a phone-facing link. A
 * wildcard resolves to this host's LAN address here, NOT to loopback, because
 * loopback on the other device is the other device. Deliberately not the
 * function above.
 */
export function urlHostForBindHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return getLocalNetworkIp();
  return host || '127.0.0.1';
}

export function openBrowser(url: string): string {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', () => {});
    child.unref();
    return 'browser open requested';
  } catch (error) {
    return `browser open failed: ${summarizeError(error)}`;
  }
}

export async function probeTcp(host: string, port: number, timeoutMs = 750): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: connectHostForBindHost(host), port });
    const finish = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export async function withRuntimeServices<T>(
  runtime: CliCommandRuntime,
  fn: (services: RuntimeServices) => Promise<T> | T,
  options: { readonly modelData?: 'background' | 'skip' } = {},
): Promise<T> {
  // Point the bus listener cap at runtime.eventBus.maxListeners before the
  // first bus exists, so every bus this process builds later uses it.
  configureRuntimeEventBusDefaults(runtimeEventBusOptionsFrom((key) => runtime.configManager.get(key)));
  const runtimeBus = new RuntimeEventBus();
  const runtimeStore = createRuntimeStore();
  const services = createRuntimeServices({
    // One-shot commands consume the stored catalog; a background refresh would
    // outlive this graph. Interactive startup retains its normal refresh.
    modelDiscovery: 'skip',
    configManager: runtime.configManager,
    runtimeBus,
    runtimeStore,
    workingDir: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
  });
  if (options.modelData !== 'skip') {
    services.providerRegistry.initModelLimits();
    services.benchmarkStore.initBenchmarks();
    services.providerRegistry.initCatalog();
  }
  try {
    await services.providerRegistry.ready();
    return await fn(services);
  } finally {
    services.providerRegistry.stopWatching();
    // A one-shot CLI command composes the WHOLE runtime graph to answer one
    // question. stopWatching() only ever covered the provider registry, so
    // every such command left the config watch, fleet tick, memory governor and
    // the rest running until the process happened to exit.
    services.dispose();
  }
}

export function readAuthPaths(runtime: CliCommandRuntime) {
  const shellPaths = createShellPathService({
    workingDirectory: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
  });
  const userStorePath = shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'auth-users.json');
  const bootstrapCredentialPath = shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'auth-bootstrap.txt');
  const operatorToken = readConnectedHostOperatorToken(runtime.homeDirectory);
  return {
    userStorePath,
    userStorePresent: existsSync(userStorePath),
    bootstrapCredentialPath,
    bootstrapCredentialPresent: existsSync(bootstrapCredentialPath),
    operatorTokenPath: operatorToken.path,
    operatorTokenPresent: operatorToken.present && Boolean(operatorToken.token),
  };
}

export async function runNonInteractiveAgent(runtime: CliCommandRuntime): Promise<number> {
  return runNativeHeadlessCommand(runtime);
}

async function renderProviders(runtime: CliCommandRuntime): Promise<string> {
  return await withRuntimeServices(runtime, async (services) => {
    const binary = runtime.cli.binary;
    const [sub = 'list', ...rest] = runtime.cli.commandArgs;
    const snapshots = await listProviderRuntimeSnapshots(services.providerRegistry);
    const current = services.providerRegistry.getCurrentModel();
    if (sub === 'current') {
      const snapshot = snapshots.find((candidate) => candidate.providerId === current.provider);
      const authRoutes = snapshot?.runtime.auth?.routes ?? [];
      const value = {
        provider: current.provider,
        model: current.registryKey,
        configured: snapshot?.runtime.auth?.configured ?? true,
        configuredVia: snapshot?.runtime.auth?.mode ?? 'unknown',
        authRoutes,
        authRouteSummary: summarizeProviderAuthRoutes(authRoutes),
      };
      return formatJsonOrText(runtime.cli)(value, [
        'GoodVibes current provider',
        `  provider: ${current.provider}`,
        `  model: ${current.registryKey}`,
        `  configured: ${yesNo(value.configured)}`,
        `  via: ${value.configuredVia}`,
        `  auth routes: ${value.authRouteSummary}`,
      ].join('\n'));
    }
    if (sub === 'use' || sub === 'set') {
      const provider = rest[0];
      if (!provider) return `Usage: ${binary} providers use <provider> [modelRegistryKey]`;
      const providerModels = services.providerRegistry
        .getSelectableModels()
        .filter((model) => model.provider === provider || model.registryKey.startsWith(`${provider}:`));
      const requestedModel = rest[1];
      const selected = requestedModel
        ? providerModels.find((model) => model.registryKey === requestedModel || model.id === requestedModel)
        : providerModels.find((model) => model.registryKey === current.registryKey) ?? providerModels[0];
      if (providerModels.length === 0 || !selected) {
        if (requestedModel) {
          runtime.configManager.setDynamic('provider.model', formatProviderModel(provider, requestedModel));
        } else {
          runtime.configManager.setDynamic('provider.model', formatProviderModel(provider, getModelIdFromProviderModel(runtime.configManager.get('provider.model'))));
        }
        return [
          'Provider selected',
          `  provider ${provider}`,
          ...(requestedModel ? [`  model ${requestedModel}`] : []),
          `  warning model catalog entry was not available locally; ${requestedModel ? 'saved explicit selection' : 'model selection was left unchanged'}.`,
        ].join('\n');
      }
      runtime.configManager.setDynamic('provider.model', selected.registryKey);
      return [
        'Provider selected',
        `  provider ${selected.provider}`,
        `  model ${selected.registryKey}`,
      ].join('\n');
    }
    if (sub === 'inspect' || sub === 'show') {
      const provider = rest[0];
      if (!provider) return `Usage: ${binary} providers inspect <provider>`;
      const snapshot = snapshots.find((candidate) => candidate.providerId === provider);
      if (!snapshot) return `No provider found ${provider}`;
      const setup = classifyProviderSetup({
        providerId: snapshot.providerId,
        authMode: snapshot.runtime.auth?.mode,
        configured: snapshot.runtime.auth?.configured ?? true,
        modelCount: snapshot.modelCount,
      });
      const authRoutes = snapshot.runtime.auth?.routes ?? [];
      return formatJsonOrText(runtime.cli)({
        ...snapshot,
        setup,
        authRoutes,
        authRouteSummary: summarizeProviderAuthRoutes(authRoutes),
      }, [
        `Provider ${snapshot.providerId}`,
        `  active: ${yesNo(snapshot.active)}`,
        `  setup: ${setup.setupLabel}`,
        `  configured: ${yesNo(snapshot.runtime.auth?.configured ?? true)}`,
        `  via: ${snapshot.runtime.auth?.mode ?? 'unknown'}`,
        `  models: ${snapshot.modelCount}`,
        `  auth routes: ${summarizeProviderAuthRoutes(authRoutes)}`,
        ...authRoutes.map((route) => `    ${formatProviderAuthRoute(route)}`),
        `  detail: ${snapshot.runtime.auth?.detail ?? snapshot.runtime.notes?.join('; ') ?? ''}`,
      ].join('\n'));
    }
    if (sub !== 'list') return `Usage: ${binary} providers [list|current|inspect <provider>|use <provider> [modelRegistryKey]]`;
    const value = snapshots.map((snapshot) => ({
      ...classifyProviderSetup({
        providerId: snapshot.providerId,
        authMode: snapshot.runtime.auth?.mode,
        configured: snapshot.runtime.auth?.configured ?? true,
        modelCount: snapshot.modelCount,
      }),
      provider: snapshot.providerId,
      active: snapshot.active,
      configured: snapshot.runtime.auth?.configured ?? true,
      configuredVia: snapshot.runtime.auth?.mode ?? 'unknown',
      models: snapshot.modelCount,
      current: current.provider === snapshot.providerId,
      detail: snapshot.runtime.auth?.detail ?? snapshot.runtime.notes?.join('; ') ?? '',
      authRoutes: snapshot.runtime.auth?.routes ?? [],
      authRouteSummary: summarizeProviderAuthRoutes(snapshot.runtime.auth?.routes),
    }));
    return formatJsonOrText(runtime.cli)(value, [
      'GoodVibes providers',
      ...value.map((provider) =>
        `  ${provider.current ? '*' : ' '} ${provider.provider.padEnd(18)} setup ${provider.setupClass} configured ${yesNo(provider.configured)} via ${provider.configuredVia ?? 'n/a'} models ${provider.models} routes ${provider.authRouteSummary} ${provider.detail ?? ''}`.trimEnd(),
      ),
    ].join('\n'));
  });
}

async function renderModels(runtime: CliCommandRuntime): Promise<string> {
  return await withRuntimeServices(runtime, async (services) => {
    const binary = runtime.cli.binary;
    const [subOrFilter, ...rest] = runtime.cli.commandArgs;
    const current = services.providerRegistry.getCurrentModel().registryKey;
    const providerSnapshots = await listProviderRuntimeSnapshots(services.providerRegistry);
    const classifyModelProvider = (providerId: string) => {
      const snapshot = providerSnapshots.find((candidate) => candidate.providerId === providerId);
      return classifyProviderSetup({
        providerId,
        authMode: snapshot?.runtime.auth?.mode,
        configured: snapshot?.runtime.auth?.configured,
        modelCount: snapshot?.modelCount,
      });
    };
    if (subOrFilter === 'current') {
      const model = services.providerRegistry.getCurrentModel();
      const setup = classifyModelProvider(model.provider);
      const providerSnapshot = providerSnapshots.find((candidate) => candidate.providerId === model.provider);
      const value = {
        registryKey: model.registryKey,
        provider: model.provider,
        id: model.id,
        displayName: model.displayName,
        contextWindow: services.providerRegistry.getContextWindowForModel(model),
        // False when nothing states the window (a guess, or disproven by a larger accepted request).
        contextWindowKnown: services.providerRegistry.getKnownContextWindowForModel(model) !== null,
        providerConfigured: providerSnapshot?.runtime.auth?.configured ?? true,
        setup,
      };
      return formatJsonOrText(runtime.cli)(value, [
        'GoodVibes current model',
        `  model: ${model.registryKey}`,
        `  provider: ${model.provider}`,
        `  setup: ${setup.setupLabel}`,
        `  provider configured: ${yesNo(value.providerConfigured)}`,
        `  context: ${value.contextWindowKnown ? value.contextWindow.toLocaleString() : 'unknown'}`,
      ].join('\n'));
    }
    if (subOrFilter === 'use' || subOrFilter === 'set') {
      const modelKey = rest[0];
      if (!modelKey) return `Usage: ${binary} models use <registryKey>`;
      const model = services.providerRegistry
        .getSelectableModels()
        .find((candidate) => candidate.registryKey === modelKey || candidate.id === modelKey);
      if (!model) {
        const provider = inferProviderFromRegistryKey(modelKey);
        runtime.configManager.setDynamic('provider.model', formatProviderModel(provider, modelKey));
        await services.favoritesStore.recordUsage(modelKey);
        return [
          'Model selected',
          `  model ${modelKey}`,
          '  warning model catalog entry was not available locally; saved explicit selection.',
        ].join('\n');
      }
      runtime.configManager.setDynamic('provider.model', model.registryKey);
      await services.favoritesStore.recordUsage(model.registryKey);
      return [
        'Model selected',
        `  model ${model.registryKey}`,
      ].join('\n');
    }
    if (subOrFilter === 'pin' || subOrFilter === 'unpin') {
      const modelKey = rest[0];
      if (!modelKey) return `Usage: ${binary} models ${subOrFilter} <registryKey>`;
      if (subOrFilter === 'pin') await services.favoritesStore.pinModel(modelKey);
      else await services.favoritesStore.unpinModel(modelKey);
      return [
        `Model ${subOrFilter === 'pin' ? 'pinned' : 'unpinned'}`,
        `  model ${modelKey}`,
      ].join('\n');
    }
    if (subOrFilter === 'pinned') {
      const pinned = await services.favoritesStore.getPinned();
      return formatJsonOrText(runtime.cli)({ pinned }, [
        `GoodVibes pinned models (${pinned.length})`,
        ...pinned.map((model) => `  ${model}`),
      ].join('\n'));
    }
    if (subOrFilter === 'recent') {
      const recent = await services.favoritesStore.getRecentModels(25);
      return formatJsonOrText(runtime.cli)({ recent }, [
        `GoodVibes recent models (${recent.length})`,
        ...recent.map((model) => `  ${model}`),
      ].join('\n'));
    }
    const filter = subOrFilter === 'list' ? rest[0]?.toLowerCase() : subOrFilter?.toLowerCase();
    const models = services.providerRegistry
      .getSelectableModels()
      .filter((model) => !filter || model.provider.toLowerCase() === filter || model.registryKey.toLowerCase().includes(filter))
      .slice(0, 200);
    const value = models.map((model) => ({
      registryKey: model.registryKey,
      provider: model.provider,
      ...classifyModelProvider(model.provider),
      id: model.id,
      displayName: model.displayName,
      contextWindow: services.providerRegistry.getContextWindowForModel(model),
      contextWindowKnown: services.providerRegistry.getKnownContextWindowForModel(model) !== null,
      current: model.registryKey === current,
    }));
    return formatJsonOrText(runtime.cli)(value, [
      `GoodVibes models${filter ? ` (${filter})` : ''}`,
      ...value.map((model) => `  ${model.current ? '*' : ' '} ${model.registryKey.padEnd(42)} setup ${model.setupClass} context ${model.contextWindowKnown ? model.contextWindow.toLocaleString() : 'unknown'} ${model.displayName}`),
    ].join('\n'));
  });
}

async function renderAuth(runtime: CliCommandRuntime): Promise<string> {
  const [sub = 'status'] = runtime.cli.commandArgs;
  const blocked = new Set([
    'add-user',
    'add',
    'delete-user',
    'remove-user',
    'rotate-password',
    'passwd',
    'revoke-session',
    'revoke-sessions',
    'clear-bootstrap',
  ]);
  if (blocked.has(sub)) {
    return [
      'Unsupported: connected-host auth user/session administration is outside GoodVibes Agent.',
      'GoodVibes Agent does not create, delete, rotate, revoke, or clear connected-host users, sessions, or bootstrap credentials.',
      'Use the owning GoodVibes host for auth administration.',
    ].join('\n');
  }
  if (sub !== 'status' && sub !== 'review' && sub !== 'list' && sub !== 'users' && sub !== 'sessions') {
    return 'Usage: goodvibes-agent auth [status|review|users|sessions]';
  }
  const paths = readAuthPaths(runtime);
  const value = {
    authOwner: 'external-runtime',
    operatorTokenPresent: paths.operatorTokenPresent,
    operatorTokenPath: paths.operatorTokenPath,
    compatibilityUserStorePresent: paths.userStorePresent,
    compatibilityUserStorePath: paths.userStorePath,
    compatibilityBootstrapCredentialPresent: paths.bootstrapCredentialPresent,
    compatibilityBootstrapCredentialPath: paths.bootstrapCredentialPath,
    permissionMode: runtime.configManager.get('permissions.mode'),
  };
  if (sub === 'users' || sub === 'sessions') {
    return formatJsonOrText(runtime.cli)(value, [
      `GoodVibes Agent auth ${sub}`,
      '  owner connected GoodVibes host',
      `  operator token ${paths.operatorTokenPresent ? 'present' : 'missing'}`,
      `  operator token path ${paths.operatorTokenPath}`,
      `  ${sub} managed outside Agent`,
      '  Agent does not enumerate or mutate connected-host users/sessions from the local CLI.',
    ].join('\n'));
  }
  return formatJsonOrText(runtime.cli)(value, [
    'GoodVibes Agent auth',
    '  owner connected GoodVibes host',
    `  permission mode ${String(value.permissionMode)}`,
    `  operator token ${paths.operatorTokenPresent ? 'present' : 'missing'} (${paths.operatorTokenPath})`,
    `  compatibility user store ${paths.userStorePresent ? 'present' : 'missing'} (${paths.userStorePath})`,
    `  compatibility bootstrap credential ${paths.bootstrapCredentialPresent ? 'present' : 'missing'} (${paths.bootstrapCredentialPath})`,
    '  connected-host user/session administration outside Agent',
    '  next goodvibes-agent providers',
    '  next goodvibes-agent subscription providers',
  ].join('\n'));
}


export async function handleGoodVibesCliCommand(runtime: CliCommandRuntime): Promise<CliCommandResult> {
  try {
    switch (runtime.cli.command) {
      case 'run':
        return { handled: true, exitCode: await runNonInteractiveAgent(runtime) };
      case 'providers': {
        const output = await renderProviders(runtime);
        console.log(output);
        return { handled: true, exitCode: exitCodeForText(output) };
      }
      case 'models': {
        const output = await renderModels(runtime);
        console.log(output);
        return { handled: true, exitCode: exitCodeForText(output) };
      }
      case 'auth': {
        const output = await renderAuth(runtime);
        console.log(output);
        return { handled: true, exitCode: exitCodeForText(output) };
      }
      case 'compat': {
        const result = await handleCompatCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'profiles': {
        const result = await handleProfilesCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'personas': {
        const result = await handlePersonasCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'skills': {
        const result = await handleSkillsCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'memory': {
        const result = await handleMemoryCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'routines': {
        const result = await handleRoutinesCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'ci': {
        const result = await handleCiCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'principals': {
        const result = await handlePrincipalsCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'owner-profile': {
        // A shell invocation prints to his terminal and nowhere else, no model
        // reads it, so his own People list is not withheld from him here.
        const result = await handleOwnerProfileCommand(runtime, { outputEntersModelContext: false });
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'channel-profiles': {
        const result = await handleChannelProfilesCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'workspaces': {
        const result = await handleWorkspacesCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'relay': {
        const result = handleRelayCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'browser': {
        const result = await handleBrowserCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'fleet': {
        const result = await handleFleetCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'knowledge': {
        const result = await handleAgentKnowledgeCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'ask':
      case 'search': {
        const result = await handleAgentKnowledgeShortcutCommand(runtime, runtime.cli.command);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'delegate': {
        const result = await handleDelegateCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'subscription': {
        const output = await renderSubscriptions(runtime);
        console.log(output);
        return { handled: true, exitCode: exitCodeForText(output) };
      }
      case 'secrets': {
        const output = await handleSecrets(runtime);
        console.log(output);
        return { handled: true, exitCode: exitCodeForText(output) };
      }
      case 'sessions': {
        const output = await handleSessions(runtime);
        if (output === null) return { handled: false, exitCode: 0 };
        console.log(output);
        return { handled: true, exitCode: exitCodeForText(output) };
      }
      case 'tasks': {
        const output = await handleTasks(runtime);
        if (output) console.log(output);
        return { handled: true, exitCode: exitCodeForText(output) };
      }
      case 'pair':
        console.log(await renderPairing(runtime));
        return { handled: true, exitCode: 0 };
      case 'bundle': {
        const result = await handleBundleCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'import': {
        const result = await handleImportCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      default:
        return { handled: false, exitCode: 0 };
    }
  } catch (error) {
    // The catch-all for every CLI subcommand failure, and the last write before
    // entrypoint.ts exits on the returned code. Straight to the descriptor, for
    // the same reason the fatal startup report is: see utils/fatal-boot-write.ts.
    writeFatalLine(summarizeError(error));
    return { handled: true, exitCode: 1 };
  }
}
