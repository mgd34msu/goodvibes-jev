import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import {
  createSystemOnePort,
  JudgmentError,
  judgmentConfigFromEnv,
  PINNED_MODEL,
  withDecisionLog,
  type JudgmentConfig,
  type JudgmentPort,
  type SqliteDecisionLog,
} from '@goodvibes-jev/judgment';
import type { JudgmentKeySource } from '../config/schema-types-judgment.js';
import { openStateDecisionLog } from '../state/decision-log.js';
import type { DisposalRegistry } from './disposal.js';

/** The secret-store and environment name of the judgment API key. */
export const JUDGMENT_KEY_NAME = 'TYPESAFE_API_KEY';

/** What the judgment settings are read from. */
export interface JudgmentSettingsSource {
  readonly config: { get(key: 'judgment.endpoint' | 'judgment.keySource' | 'judgment.model' | 'judgment.timeoutMs'): unknown };
  readonly secrets: { get(key: string): Promise<string | null> };
  /** The process environment; TYPESAFE_API_KEY, TYPESAFE_BASE_URL and TYPESAFE_DEFAULT_MODEL. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** The model a request names when it names none: judgment.model, then TYPESAFE_DEFAULT_MODEL, then the pinned version. */
function settingsModel(source: JudgmentSettingsSource): string {
  return text(source.config.get('judgment.model')) || text(source.env['TYPESAFE_DEFAULT_MODEL']) || PINNED_MODEL;
}

async function settingsKey(source: JudgmentSettingsSource): Promise<string | undefined> {
  const keySource = source.config.get('judgment.keySource') as JudgmentKeySource;
  if (keySource !== 'secret') return source.env[JUDGMENT_KEY_NAME];
  const stored = (await source.secrets.get(JUDGMENT_KEY_NAME))?.trim();
  if (!stored) {
    throw new JudgmentError('invalid-request', `judgment.keySource is secret and the secret store holds no ${JUDGMENT_KEY_NAME}; the judgment port has no key`);
  }
  return stored;
}

/**
 * The judgment config the engine settings describe: judgmentConfigFromEnv
 * over the environment, with judgment.endpoint, the key from judgment.keySource
 * and judgment.model standing in for their environment variables when set.
 */
export async function judgmentConfigFromSettings(source: JudgmentSettingsSource): Promise<JudgmentConfig> {
  const env = {
    ...source.env,
    [JUDGMENT_KEY_NAME]: await settingsKey(source),
    TYPESAFE_BASE_URL: text(source.config.get('judgment.endpoint')) || source.env['TYPESAFE_BASE_URL'],
  };
  const timeoutMs = source.config.get('judgment.timeoutMs');
  return judgmentConfigFromEnv(env, {
    model: settingsModel(source),
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
  });
}

/** Whether two configs reach the same endpoint with the same key, model and timeout. */
const sameConfig = (a: JudgmentConfig, b: JudgmentConfig): boolean =>
  a.endpoint.baseURL === b.endpoint.baseURL && a.endpoint.apiKey === b.endpoint.apiKey && a.model === b.model && a.timeoutMs === b.timeoutMs;

/**
 * A port over the live settings. Each call reads the settings, so a changed
 * endpoint, key or model applies on the next judgment with no restart; the
 * System One client is rebuilt only when they change. A missing key fails the
 * call (and the decision log records the failure); nothing decides without Jev.
 */
export function createSettingsJudgmentPort(source: JudgmentSettingsSource): JudgmentPort {
  let current: { config: JudgmentConfig; port: JudgmentPort } | undefined;
  return {
    get model(): string {
      return settingsModel(source);
    },
    async ask(request) {
      const config = await judgmentConfigFromSettings(source);
      if (current === undefined || !sameConfig(current.config, config)) current = { config, port: createSystemOnePort(config) };
      return current.port.ask(request);
    },
  };
}

/** Ports whose composition has been disposed; never reinstalled. */
const retired = new WeakSet<JudgmentPort>();

export interface JudgmentServices {
  /** The installed port: settings-driven, recording to the decision log. */
  readonly port: JudgmentPort;
  readonly decisionLog: SqliteDecisionLog;
}

export interface JudgmentServicesInput extends JudgmentSettingsSource {
  /** The composition's state root; the decision log opens here. */
  readonly stateRoot: string;
  /** Closes the log and uninstalls the port when the composition is disposed. */
  readonly disposal: DisposalRegistry;
}

/**
 * Builds a composition's judgment port from the judgment settings, recording
 * every call to the state root's decision log, and installs it as the port
 * every engine decision site reads through. Disposal closes the log and, when
 * this port is still the installed one, puts back the port it replaced unless
 * that one's composition is gone too.
 */
export function composeJudgment(input: JudgmentServicesInput): JudgmentServices {
  const decisionLog = openStateDecisionLog(input.stateRoot);
  const port = withDecisionLog(createSettingsJudgmentPort(input), decisionLog);
  const previous = installJudgmentPort(port);
  input.disposal.add('judgment port and decision log', () => {
    retired.add(port);
    const installed = installJudgmentPort(previous !== undefined && !retired.has(previous) ? previous : undefined);
    if (installed !== port) installJudgmentPort(installed);
    decisionLog[Symbol.dispose]();
  });
  return { port, decisionLog };
}
