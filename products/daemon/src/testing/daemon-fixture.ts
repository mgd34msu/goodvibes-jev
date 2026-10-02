/**
 * The daemon's actual runtime graph and server over an owned loopback fixture.
 * Adapted from pinned daemon443e5ee. All gateway responses come from the real
 * product and engine registrations. Callers must await stop before releasing
 * paths or transferring ownership.
 *
 * This migration is partial: an explicit inbox factory is required until the
 * built-in adapter/triage product composition is restored. Fixture adapters
 * establish the configured graph's behavior, not built-in-provider parity.
 * No model or external provider is fabricated by this module; tests supply
 * their recorded endpoints and network fixtures explicitly.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { DaemonServer } from '@goodvibes-jev/engine/sdk/platform/daemon';
import { createRuntimeStore } from '@goodvibes-jev/engine/sdk/platform/runtime/store';
import { UserAuthManager } from '@goodvibes-jev/engine/sdk/platform/security';
import { createFeatureFlagManager, deriveFeatureStates, RuntimeEventBus } from '../runtime/index.js';
import { createRuntimeServices, type RuntimeServices, type RuntimeServicesOptions } from '../runtime/services.js';
import { createHostedSessionOptions } from '../runtime/hosted-session-composition.js';
import { createDisposalScope } from '../runtime/disposal-wiring.js';
import type { DaemonInboxFactory } from '../runtime/daemon-handler-composition.js';

/**
 * The capabilities a daemon serves once it is running. Seeded from a real
 * config first (so the registry stays complete), then forced on, because a
 * contract test asking "does this daemon serve X" must not be answered by a
 * feature flag that happens to be off in a fresh temp home.
 */
const DAEMON_CAPABILITY_FLAGS: readonly string[] = [
  'automation-domain',
  'control-plane-gateway',
  'delivery-engine',
  'hitl-ux-modes',
  'ntfy-surface',
  'permission-divergence-dashboard',
  'policy-as-code',
  'route-binding',
  'service-management',
  'slack-surface',
  'unified-runtime-task',
  'watcher-framework',
  'web-surface',
  'webhook-surface',
];

export interface DaemonFixtureOptions {
  /** Explicit owned boot operations; omitted fixtures do not start boot tasks. */
  readonly createBootOperations?: RuntimeServicesOptions['createBootOperations'];
  /** Explicit fixture composition; there is no unimplemented production default. */
  readonly inboxFactory: DaemonInboxFactory;
  /**
   * Root directory for this fixture's home and workspace. Omitted ⇒ a fresh
   * `mkdtemp` under the OS temp directory, removed by `stop()`. Pass one when
   * the caller has its own temp-tree bookkeeping (this repo's suites do).
   */
  readonly root?: string;
  /** Bearer token the daemon accepts. Omitted ⇒ a generated per-fixture token. */
  readonly token?: string;
  /** Last-chance hook to write config before the runtime graph is built. */
  readonly configure?: (configManager: ConfigManager) => void;
  /**
   * Feature flag ids to force on, replacing the default daemon capability set.
   * Rarely needed; stated so a caller testing a flag's OFF behaviour can.
   */
  readonly featureFlagIds?: readonly string[];
  /**
   * Whether this daemon hosts sessions of its own, the way the real entrypoint
   * states it (`src/daemon/cli.ts` passes `createHostedSessionOptions`).
   * Defaults to true: `sessions.hosted.*` is handler-less without it, and a
   * client with no terminal of its own has no other way to start a run.
   */
  readonly hostSessions?: boolean;
  /**
   * A mailbox address to watch. Omitted ⇒ none, and the inbound-mail
   * composition honestly registers no `email.expectation.*` /
   * `email.inbound.status` handler, exactly as it does on a daemon nobody has
   * configured a mailbox for. Pass one to exercise the provisioned shape.
   * Nothing connects: the composition reads the account name, and no source
   * starts until the supervisor does.
   */
  readonly watchedMailbox?: string;
}

export interface DaemonFixture {
  /** The composed runtime graph, the same object `DaemonServer` was handed. */
  readonly services: RuntimeServices;
  /** The running server. */
  readonly daemon: DaemonServer;
  /** `http://127.0.0.1:<bound port>`, valid after `start()` returned. */
  readonly baseUrl: string;
  /** The bearer token this daemon accepts. */
  readonly token: string;
  readonly homeDirectory: string;
  readonly workingDirectory: string;
  /** Fetch a path on this daemon with the bearer token attached. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /**
   * Fetch a path with NO credential. A route that exists answers 401; a path
   * nothing serves answers 404, which is what makes this the side-effect-free
   * way to ask whether a route exists, even for a write verb.
   */
  fetchAnonymous(path: string, init?: RequestInit): Promise<Response>;
  /** Invoke a gateway verb in-process, the way the control plane dispatches it. */
  invoke<T = unknown>(methodId: string, body?: Record<string, unknown>): Promise<T>;
  /** Stop the server, dispose the graph, and remove a temp root this created. */
  stop(): Promise<void>;
}

/**
 * Compose and start a daemon. Always `await fixture.stop()`, the runtime graph
 * starts pollers while it builds, and abandoning it leaves every one of them
 * firing for the rest of the process.
 */
export async function startDaemonFixture(options: DaemonFixtureOptions): Promise<DaemonFixture> {
  if (typeof options?.inboxFactory !== 'function') throw new Error('The partial daemon fixture requires an explicit inbox factory.');
  const ownsRoot = options.root === undefined;
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'goodvibes-daemon-fixture-'));
  const workingDirectory = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  const configDir = join(homeDirectory, '.goodvibes', 'daemon');
  mkdirSync(workingDirectory, { recursive: true });
  mkdirSync(configDir, { recursive: true });

  const scope = createDisposalScope('Daemon fixture');
  let closing: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (closing) return closing;
    closing = scope.close().then(() => {
      // Preserve evidence and paths if owned shutdown failed.
      if (ownsRoot) rmSync(root, { recursive: true, force: true });
    });
    void closing.catch(() => {});
    return closing;
  };
  try {
    const token = options.token ?? `daemon-fixture-${Math.random().toString(36).slice(2)}`;

    const configManager = new ConfigManager({
      surfaceRoot: 'tui',
      configDir,
      workingDir: workingDirectory,
      homeDir: homeDirectory,
    });
    if (options.watchedMailbox !== undefined) {
      configManager.set('surfaces.email.inbound.accounts', JSON.stringify([options.watchedMailbox]));
    }
    options.configure?.(configManager);

    const featureFlags = createFeatureFlagManager();
    const flags = deriveFeatureStates(configManager);
    for (const id of options.featureFlagIds ?? DAEMON_CAPABILITY_FLAGS) flags[id] = 'enabled';
    featureFlags.loadFromConfig({ flags });

    const services = await createRuntimeServices({
      createBootOperations: options.createBootOperations,
      inboxFactory: options.inboxFactory,
      runtimeStore: createRuntimeStore(),
      runtimeBus: new RuntimeEventBus(),
      configManager,
      workingDir: workingDirectory,
      homeDirectory,
      featureFlags,
      getConversationTitle: () => 'daemon fixture',
    });
    scope.registry.add('runtime graph', services.close);

    // Ephemeral port: two concurrent test processes must never collide, and
    // injecting a serveFactory also makes DaemonServer skip its pre-bind OS port
    // probe (the facade only probes when serveFactory === Bun.serve).
    let boundPort = 0;
    const capturingServe = ((serveOptions) => {
      const server = Bun.serve(serveOptions);
      if (server.port !== undefined) boundPort = server.port;
      return server;
    }) as typeof Bun.serve;

    const daemon = new DaemonServer({
      port: 0,
      host: '127.0.0.1',
      userAuth: new UserAuthManager({
        bootstrapFilePath: join(homeDirectory, 'auth-users.json'),
        bootstrapCredentialPath: join(homeDirectory, 'auth-bootstrap.txt'),
        users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
      }),
      runtimeServices: services,
      runtimeBus: services.runtimeBus,
      hasOverriddenHome: true,
      clusterCoordinator: services.clusterCoordinator,
      clusterGroupVerbs: services.clusterGroup.verbs,
      paymentReplies: services.daemonHandlers.paymentReplies,
      serveFactory: capturingServe,
      // What the real entrypoint states, for the same reason it states it: the
      // hosted-session verbs are registered by this composition and by nothing
      // else, so a fixture that leaves it out is a daemon a client cannot start a
      // session on, and every contract test written against it would agree.
      ...(options.hostSessions === false ? {} : { hostedSessions: createHostedSessionOptions(services) }),
    });

    scope.registry.add('daemon server', () => daemon.stop());
    await services.startCluster();
    daemon.enable({ daemon: true }, token);
    await daemon.start();
    if (!daemon.isRunning) {
      throw new Error('daemon fixture: the server refused to start');
    }

    const baseUrl = `http://127.0.0.1:${boundPort}`;

    return {
      services,
      daemon,
      baseUrl,
      token,
      homeDirectory,
      workingDirectory,
      fetch(path, init) {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${token}`);
        if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
        return fetch(`${baseUrl}${path}`, { ...init, headers });
      },
      fetchAnonymous(path, init) {
        return fetch(`${baseUrl}${path}`, init);
      },
      invoke<T>(methodId: string, body: Record<string, unknown> = {}): Promise<T> {
        return services.gatewayMethods.invoke(methodId, { methodId, body } as never) as Promise<T>;
      },
      stop,
    };
  } catch (startupError) {
    try { await stop(); }
    catch (cleanupError) { throw new AggregateError([startupError, cleanupError], 'Daemon fixture startup and cleanup failed'); }
    throw startupError;
  }
}
