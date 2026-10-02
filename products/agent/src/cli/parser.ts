import type {
  GoodVibesCliCommand,
  GoodVibesCliFlags,
  GoodVibesCliOutputFormat,
  GoodVibesCliParseResult,
} from './types.ts';

const COMMAND_ALIASES: Readonly<Record<string, GoodVibesCliCommand>> = {
  run: 'run',
  exec: 'run',
  e: 'run',
  status: 'status',
  doctor: 'doctor',
  onboarding: 'onboarding',
  setup: 'onboarding',
  models: 'models',
  model: 'models',
  providers: 'providers',
  provider: 'providers',
  profiles: 'profiles',
  profile: 'profiles',
  personas: 'personas',
  persona: 'personas',
  skills: 'skills',
  skill: 'skills',
  'agent-skills': 'skills',
  memory: 'memory',
  memories: 'memory',
  routines: 'routines',
  routine: 'routines',
  ci: 'ci',
  principals: 'principals',
  principal: 'principals',
  // `profile` already means `profiles` (isolated Agent profile homes), so the
  // owner profile takes its own unambiguous name rather than re-pointing a
  // command that works today.
  'owner-profile': 'owner-profile',
  'owner-profiles': 'owner-profile',
  'about-me': 'owner-profile',
  'channel-profiles': 'channel-profiles',
  'channel-profile': 'channel-profiles',
  workspaces: 'workspaces',
  workspace: 'workspaces',
  browser: 'browser',
  relay: 'relay',
  fleet: 'fleet',
  fleets: 'fleet',
  auth: 'auth',
  compat: 'compat',
  compatibility: 'compat',
  knowledge: 'knowledge',
  know: 'knowledge',
  kb: 'knowledge',
  ask: 'ask',
  search: 'search',
  find: 'search',
  delegate: 'delegate',
  build: 'delegate',
  subscription: 'subscription',
  subscriptions: 'subscription',
  secrets: 'secrets',
  secret: 'secrets',
  sessions: 'sessions',
  session: 'sessions',
  tasks: 'tasks',
  task: 'tasks',
  pair: 'pair',
  qrcode: 'pair',
  qr: 'pair',
  bundle: 'bundle',
  bundles: 'bundle',
  import: 'import',
  migrate: 'import',
  completion: 'completion',
  completions: 'completion',
  help: 'help',
  version: 'version',
};

const BLOCKED_PRODUCT_COMMAND_HINTS: Readonly<Partial<Record<string, (binary: string) => string>>> = {
  app: (binary) => `Unsupported command: app. Launch the Agent TUI with "${binary}" and no command.`,
  bridge: () => 'Unsupported command: bridge. GoodVibes Agent connects to an externally managed GoodVibes host and does not expose bridge processes.',
  'control-plane': () => 'Unsupported command: control-plane. GoodVibes Agent can inspect connected-host posture, but it does not manage host endpoints.',
  controlplane: () => 'Unsupported command: controlplane. GoodVibes Agent can inspect connected-host posture, but it does not manage host endpoints.',
  cp: () => 'Unsupported command: cp. GoodVibes Agent can inspect connected-host posture, but it does not manage host endpoints.',
  daemon: () => 'Unsupported command: daemon. GoodVibes Agent connects to an externally managed GoodVibes host and does not start or manage host processes.',
  'http-listener': () => 'Unsupported command: http-listener. GoodVibes Agent does not start listeners or expose inbound host endpoints.',
  launch: (binary) => `Unsupported command: launch. Launch the Agent TUI with "${binary}" and no command.`,
  listener: () => 'Unsupported command: listener. GoodVibes Agent does not start listeners or expose inbound host endpoints.',
  remote: () => 'Unsupported command: remote. GoodVibes Agent uses explicit connected-host routes and does not manage remote host transport.',
  serve: () => 'Unsupported command: serve. GoodVibes Agent connects to an externally managed GoodVibes host and does not start server processes.',
  server: () => 'Unsupported command: server. GoodVibes Agent connects to an externally managed GoodVibes host and does not start server processes.',
  service: () => 'Unsupported command: service. GoodVibes Agent keeps host lifecycle ownership outside this product.',
  services: () => 'Unsupported command: services. GoodVibes Agent keeps host lifecycle ownership outside this product.',
  start: (binary) => `Unsupported command: start. Launch the Agent TUI with "${binary}" and no command; Agent does not start connected-host processes.`,
  surface: () => 'Unsupported command: surface. GoodVibes Agent does not manage connected-host surfaces.',
  surfaces: () => 'Unsupported command: surfaces. GoodVibes Agent does not manage connected-host surfaces.',
  tui: (binary) => `Unsupported command: tui. Launch the Agent TUI with "${binary}" and no command.`,
  web: () => 'Unsupported command: web. GoodVibes Agent does not start web servers or expose browser routes.',
  webhook: () => 'Unsupported command: webhook. GoodVibes Agent can send explicit channel messages, but it does not create webhook listeners.',
};

export function listGoodVibesCliCommandTokens(): readonly string[] {
  return Object.keys(COMMAND_ALIASES).sort();
}

export function listGoodVibesCliCommands(): readonly GoodVibesCliCommand[] {
  return [...new Set<GoodVibesCliCommand>(['tui', ...Object.values(COMMAND_ALIASES)])].sort();
}

export function listBlockedGoodVibesCliCommandTokens(): readonly string[] {
  return Object.keys(BLOCKED_PRODUCT_COMMAND_HINTS).sort();
}

function createDefaultFlags(): GoodVibesCliFlags {
  return {
    provider: undefined,
    model: undefined,
    agentProfile: undefined,
    runtimeUrl: undefined,
    workingDir: undefined,
    help: false,
    version: false,
    prompt: undefined,
    print: false,
    outputFormat: 'text',
    configOverrides: [],
    enableFeatures: [],
    disableFeatures: [],
    noAltScreen: false,
    port: undefined,
    hostname: undefined,
    open: false,
    continueLast: false,
    resume: undefined,
    session: undefined,
    fork: false,
    rawOutput: false,
    acceptRawOutputRisk: false,
  };
}

function splitOption(token: string): { readonly name: string; readonly value: string | undefined } {
  const index = token.indexOf('=');
  if (index < 0) return { name: token, value: undefined };
  return {
    name: token.slice(0, index),
    value: token.slice(index + 1),
  };
}

function getValue(
  argv: readonly string[],
  index: number,
  inlineValue: string | undefined,
  optionName: string,
  errors: string[],
): { readonly value: string | undefined; readonly nextIndex: number } {
  if (inlineValue !== undefined) return { value: inlineValue, nextIndex: index };
  const next = argv[index + 1];
  if (next === undefined || (next.startsWith('-') && next !== '-')) {
    errors.push(`${optionName} requires a value.`);
    return { value: undefined, nextIndex: index };
  }
  return { value: next, nextIndex: index + 1 };
}

function getOptionalValue(
  argv: readonly string[],
  index: number,
  inlineValue: string | undefined,
): { readonly value: string | undefined; readonly nextIndex: number } {
  if (inlineValue !== undefined) return { value: inlineValue, nextIndex: index };
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('-')) return { value: undefined, nextIndex: index };
  return { value: next, nextIndex: index + 1 };
}

function parsePort(value: string | undefined, optionName: string, errors: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    errors.push(`${optionName} must be a port number from 1 to 65535.`);
    return undefined;
  }
  const port = Number.parseInt(value, 10);
  if (port < 1 || port > 65535) {
    errors.push(`${optionName} must be a port number from 1 to 65535.`);
    return undefined;
  }
  return port;
}

function normalizeOutputFormat(value: string | undefined, errors: string[]): GoodVibesCliOutputFormat {
  if (value === 'text' || value === 'json' || value === 'stream-json') return value;
  errors.push('--output-format must be one of: text, json, stream-json.');
  return 'text';
}

function inferProviderFromModel(model: string, currentProvider: string | undefined): string | undefined {
  if (currentProvider !== undefined) return currentProvider;
  if (model.includes(':')) return model.split(':')[0];
  if (model.includes('/')) return model.split('/')[0];
  return undefined;
}

function withFlag<K extends keyof GoodVibesCliFlags>(
  flags: GoodVibesCliFlags,
  key: K,
  value: GoodVibesCliFlags[K],
): GoodVibesCliFlags {
  return { ...flags, [key]: value };
}

function appendFlagArray<K extends 'configOverrides' | 'enableFeatures' | 'disableFeatures'>(
  flags: GoodVibesCliFlags,
  key: K,
  value: string,
): GoodVibesCliFlags {
  return {
    ...flags,
    [key]: [...flags[key], value],
  };
}

export function parseGoodVibesCli(
  argv: readonly string[],
  binary = 'goodvibes-agent',
): GoodVibesCliParseResult {
  let flags = createDefaultFlags();
  let command: GoodVibesCliCommand = 'tui';
  let rawCommand: string | undefined;
  const commandArgs: string[] = [];
  const positionals: string[] = [];
  const errors: string[] = [];
  let sawCommand = false;
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;

    if (passthrough) {
      if (sawCommand) commandArgs.push(token);
      else positionals.push(token);
      continue;
    }

    if (token === '--') {
      passthrough = true;
      continue;
    }

    if (!token.startsWith('-') || token === '-') {
      if (!sawCommand) {
        const commandToken = token.toLowerCase();
        if (BLOCKED_PRODUCT_COMMAND_HINTS[commandToken]) {
          command = 'unknown';
          rawCommand = token;
          sawCommand = true;
          continue;
        }
        const normalized = COMMAND_ALIASES[commandToken];
        if (normalized) {
          command = normalized;
          rawCommand = token;
          sawCommand = true;
          continue;
        }
      }
      positionals.push(token);
      if (sawCommand) commandArgs.push(token);
      continue;
    }

    const { name, value: inlineValue } = splitOption(token);

    if (name === '--help' || name === '-h') {
      flags = withFlag(flags, 'help', true);
      continue;
    }
    if (name === '--version' || name === '-v') {
      flags = withFlag(flags, 'version', true);
      continue;
    }
    if (name === '--print') {
      flags = withFlag(flags, 'print', true);
      if (!sawCommand) command = 'run';
      continue;
    }
    if (name === '--json') {
      flags = withFlag(flags, 'outputFormat', 'json');
      continue;
    }
    if (name === '--no-alt-screen') {
      flags = withFlag(flags, 'noAltScreen', true);
      continue;
    }
    if (name === '--open') {
      flags = withFlag(flags, 'open', true);
      continue;
    }
    if (name === '--continue') {
      flags = withFlag(flags, 'continueLast', true);
      continue;
    }
    if (name === '--fork') {
      flags = withFlag(flags, 'fork', true);
      continue;
    }
    if (name === '--raw-output') {
      flags = withFlag(flags, 'rawOutput', true);
      continue;
    }
    if (name === '--accept-raw-output-risk') {
      flags = withFlag(flags, 'acceptRawOutputRisk', true);
      continue;
    }

    if (name === '--provider') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      if (consumed.value !== undefined) flags = withFlag(flags, 'provider', consumed.value);
      continue;
    }
    if (name === '--model' || name === '-m') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      if (consumed.value !== undefined) {
        flags = withFlag(flags, 'model', consumed.value);
        flags = withFlag(flags, 'provider', inferProviderFromModel(consumed.value, flags.provider));
      }
      continue;
    }
    if (name === '--agent-profile') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      if (consumed.value !== undefined) flags = withFlag(flags, 'agentProfile', consumed.value);
      continue;
    }
    if (name === '--runtime-url' || name === '--runtime') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      if (consumed.value !== undefined) flags = withFlag(flags, 'runtimeUrl', consumed.value);
      continue;
    }
    if (name === '--working-dir' || name === '--cd' || name === '-C') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      if (consumed.value !== undefined) flags = withFlag(flags, 'workingDir', consumed.value);
      continue;
    }
    if (name === '--prompt' || name === '-p') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      if (consumed.value !== undefined) {
        flags = withFlag(flags, 'prompt', consumed.value);
        if (!sawCommand) command = 'run';
      }
      continue;
    }
    if (name === '--output-format' || name === '--output' || name === '-o') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      flags = withFlag(flags, 'outputFormat', normalizeOutputFormat(consumed.value, errors));
      continue;
    }
    if (name === '--config') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      if (consumed.value !== undefined) flags = appendFlagArray(flags, 'configOverrides', consumed.value);
      continue;
    }
    if (name === '-c') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      if (consumed.value !== undefined) flags = appendFlagArray(flags, 'configOverrides', consumed.value);
      continue;
    }
    if (name === '--enable') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      if (consumed.value !== undefined) flags = appendFlagArray(flags, 'enableFeatures', consumed.value);
      continue;
    }
    if (name === '--disable') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      if (consumed.value !== undefined) flags = appendFlagArray(flags, 'disableFeatures', consumed.value);
      continue;
    }
    if (name === '--port') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      flags = withFlag(flags, 'port', parsePort(consumed.value, name, errors));
      continue;
    }
    if (name === '--hostname' || name === '--host') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      if (consumed.value !== undefined) flags = withFlag(flags, 'hostname', consumed.value);
      continue;
    }
    if (name === '--resume' || name === '-r') {
      const consumed = getOptionalValue(argv, index, inlineValue);
      index = consumed.nextIndex;
      flags = withFlag(flags, 'resume', consumed.value ?? 'latest');
      continue;
    }
    if (name === '--session' || name === '-s') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      if (consumed.value !== undefined) flags = withFlag(flags, 'session', consumed.value);
      continue;
    }

    if (sawCommand) {
      commandArgs.push(token);
      continue;
    }

    errors.push(`Unknown option: ${name}`);
  }

  if (flags.prompt === undefined && (command === 'run' || flags.print) && positionals.length > 0) {
    flags = withFlag(flags, 'prompt', positionals.join(' '));
  }

  if (rawCommand !== undefined && command === 'unknown') {
    const blockedHint = BLOCKED_PRODUCT_COMMAND_HINTS[rawCommand.toLowerCase()];
    errors.push(blockedHint ? blockedHint(binary) : `Unknown command ${rawCommand}`);
  }

  return {
    binary,
    command,
    rawCommand,
    commandArgs,
    positionals,
    flags,
    errors,
  };
}
