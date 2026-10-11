import { bindJudgmentPortAuthority, installJudgmentPort, restoreJudgmentPort } from '@goodvibes-jev/engine/errors';
import { createJudgmentSourceLifetime } from './judgment-source-lifetime.js';
import {
  createSystemOnePort,
  JudgmentError,
  judgmentConfigFromEnv,
  PINNED_MODEL,
  withDecisionLog,
  type JudgmentConfig,
  type JudgmentPort,
  type JudgmentRequest,
  type JudgmentResult,
  type Questions,
  type SqliteDecisionLog,
} from '@goodvibes-jev/judgment';
import type { JudgmentKeySource } from '../config/schema-types-judgment.js';
import { openStateDecisionLog } from '../state/decision-log.js';
import type { DisposalRegistry } from './disposal.js';

/** The secret-store and environment name of the judgment API key. */
export const JUDGMENT_KEY_NAME = 'TYPESAFE_API_KEY';

/** What the judgment settings are read from. */
export interface JudgmentSettingsSource {
  readonly config: {
    get(key: 'judgment.endpoint' | 'judgment.keySource' | 'judgment.model' | 'judgment.timeoutMs'): unknown;
    getConfigurationIncarnation?(): number;
    onDidChangeIncarnation?(listener: () => void): () => void;
  };
  readonly secrets: {
    get(key: string): Promise<string | null>;
    getCredentialMutationState?(): Readonly<{ generation: number; pending: boolean }>;
    onDidInvalidateCredentials?(listener: () => void): () => void;
  };
  /** The process environment; TYPESAFE_API_KEY, TYPESAFE_BASE_URL and TYPESAFE_DEFAULT_MODEL. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** The model a request names when it names none: judgment.model, then TYPESAFE_DEFAULT_MODEL, then the pinned version. */
function settingsModel(source: JudgmentSettingsSource): string {
  return text(source.config.get('judgment.model')) || text(source.env['TYPESAFE_DEFAULT_MODEL']) || PINNED_MODEL;
}

async function settingsKey(secrets: JudgmentSettingsSource['secrets'], keySource: JudgmentKeySource, envKey: string | undefined): Promise<string | undefined> {
  if (keySource !== 'secret') return envKey;
  const stored = (await secrets.get(JUDGMENT_KEY_NAME))?.trim();
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
  // Capture the destination and its credential source together before a secret
  // lookup can yield or invoke borrowed code. Hot reload applies to the next
  // reading, never to only part of a reading already acquiring its key.
  const env = {
    TYPESAFE_API_KEY: source.env[JUDGMENT_KEY_NAME],
    TYPESAFE_BASE_URL: text(source.config.get('judgment.endpoint')) || source.env['TYPESAFE_BASE_URL'],
  };
  const model = settingsModel(source);
  const timeoutMs = source.config.get('judgment.timeoutMs');
  const keySource = source.config.get('judgment.keySource') as JudgmentKeySource;
  env.TYPESAFE_API_KEY = await settingsKey(source.secrets, keySource, env.TYPESAFE_API_KEY);
  return judgmentConfigFromEnv(env, {
    model,
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
  });
}

/** Whether two configs reach the same endpoint with the same key, model and timeout. */
const sameConfig = (a: JudgmentConfig, b: JudgmentConfig): boolean =>
  a.endpoint.baseURL === b.endpoint.baseURL && a.endpoint.apiKey === b.endpoint.apiKey && a.model === b.model && a.timeoutMs === b.timeoutMs;

/** A secret-store read cannot strand runtime cancellation or its decision log. */
async function activeSettings(source: JudgmentSettingsSource, signal?: AbortSignal): Promise<JudgmentConfig> {
  if (!signal) return judgmentConfigFromSettings(source);
  signal.throwIfAborted();
  let cancelled = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    cancelled = () => reject(new JudgmentError('aborted', 'the judgment call was cancelled'));
    signal.addEventListener('abort', cancelled, { once: true });
    if (signal.aborted) cancelled();
  });
  try { return await Promise.race([interrupted, judgmentConfigFromSettings(source)]); }
  finally { signal.removeEventListener('abort', cancelled); }
}

/**
 * A port over the live settings. Each call reads the settings, so a changed
 * endpoint, key or model applies on the next judgment with no restart. Each
 * reading keeps the settings captured before its key lookup and throughout
 * the shared transport's retries; an edit never redirects an in-flight key or
 * payload to a new endpoint. The System One client is rebuilt only when the
 * config changes. A missing key fails the call (and the decision log records
 * the failure); nothing decides without Jev.
 */
export function createSettingsJudgmentPort(source: JudgmentSettingsSource): JudgmentPort {
  let current: { config: JudgmentConfig; port: JudgmentPort } | undefined;
  return {
    get model(): string {
      return settingsModel(source);
    },
    async ask(request) {
      const config = await activeSettings(source, request.signal);
      // Key acquisition may finish after runtime shutdown or caller cancellation.
      // Never create another transport or send a late request in that case.
      request.signal?.throwIfAborted();
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
  /**
   * The composition's config, when it can read what waited for a port: the
   * unknown settings keys its load kept (ConfigManager.announceUnknownSettingForms).
   */
  readonly config: JudgmentSettingsSource['config'] & { announceUnknownSettingForms?(): Promise<void> };
  /** The composition's state root; the decision log opens here. */
  readonly stateRoot: string;
  /** Cancels owned calls, drains their records, then closes the log on disposal. */
  readonly disposal: DisposalRegistry;
}

/**
 * Builds a composition's judgment port from the judgment settings, recording
 * every call to the state root's decision log, and installs it as the port
 * every engine decision site reads through. Disposal retires the port and
 * cancels its outstanding calls before closing the log after their records
 * settle. Awaitable scopes wait for this drain; synchronous scopes start it.
 * When still installed, the port it replaced is restored unless retired too.
 */
export function composeJudgment(input: JudgmentServicesInput): JudgmentServices {
  const decisionLog = openStateDecisionLog(input.stateRoot);
  const recorded = withDecisionLog(createSettingsJudgmentPort(input), decisionLog);
  const lifetime = new AbortController();
  const active = new Set<Promise<unknown>>();
  const port: JudgmentPort = {
    get model() { return recorded.model; },
    recorder: recorded.recorder!,
    ask<const Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      // Retained port references must not reopen a retired runtime or write to
      // its closed log. Calls admitted before retirement still record failure.
      if (lifetime.signal.aborted) return Promise.reject(new JudgmentError('aborted', 'the judgment runtime is shutting down'));
      // Reserve ownership before reading borrowed inputs or live settings:
      // their accessors can synchronously initiate runtime disposal.
      const { promise: work, resolve, reject } = Promise.withResolvers<JudgmentResult<Q>>();
      active.add(work);
      const release = () => { active.delete(work); };
      void work.then(release, release);
      try {
        const callerSignal = request.signal;
        const signal = callerSignal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, callerSignal]);
        void recorded.ask({ ...request, signal }).then(resolve, reject);
      } catch (error) { reject(error); }
      return work;
    },
  };
  const sourceLifetime = createJudgmentSourceLifetime(input);
  bindJudgmentPortAuthority(port, sourceLifetime.capture);
  const previous = installJudgmentPort(port);
  // Config loaded before this port existed; what its load kept for a reading is read now.
  void input.config.announceUnknownSettingForms?.();
  input.disposal.add('judgment port and decision log', () => {
    retired.add(port);
    sourceLifetime.dispose();
    restoreJudgmentPort(port, previous !== undefined && !retired.has(previous) ? previous : undefined);
    lifetime.abort(new JudgmentError('aborted', 'the judgment runtime is shutting down'));
    if (active.size === 0) { decisionLog[Symbol.dispose](); return; }
    // Keep returning the promise even through DisposalRegistry's legacy void
    // shape: AsyncDisposalRegistry observes it and waits before older owners.
    return Promise.allSettled([...active]).then(() => { decisionLog[Symbol.dispose](); });
  });
  return { port, decisionLog };
}
