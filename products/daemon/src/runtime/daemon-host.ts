/** Owned source host for an explicitly configured daemon, not a CLI/default inbox. */
import { DaemonServer, HttpListener, createSafeHostServeFactory } from '@goodvibes-jev/engine/sdk/platform/daemon';
import { createAsyncDisposalScope } from '@goodvibes-jev/engine/sdk/platform/runtime/disposal';
import { createDaemonBootOperations } from './boot-composition.js';
import type { DaemonBootSnapshot } from './boot-tasks.js';
import { createHostedSessionOptions } from './hosted-session-composition.js';
import { createRuntimeServices, type RuntimeServices, type RuntimeServicesOptions } from './services.js';

export interface DaemonHostBinding {
  readonly host?: string;
  readonly port?: number;
  readonly token?: string;
  /** The shared safe-request boundary always wraps this transport. */
  readonly serveFactory?: typeof Bun.serve;
}

export interface DaemonHostOptions {
  /** Config/home ownership has already been resolved by the caller. */
  readonly runtime: Omit<RuntimeServicesOptions, 'createBootOperations'>;
  readonly daemon?: DaemonHostBinding;
  /** Explicit opt-in; an absent binding constructs no secondary listener. */
  readonly httpListener?: DaemonHostBinding;
}

export type DaemonHostServer = Pick<DaemonServer, 'enable' | 'start' | 'stop' | 'waitForRestart' | 'isRunning'>;
export type DaemonHostListener = Pick<HttpListener, 'enable' | 'start' | 'stop' | 'waitForRestart' | 'isRunning'>;

/** Narrow construction seams also permit held-acquisition lifecycle tests. */
export interface DaemonHostFactories {
  readonly createRuntime?: typeof createRuntimeServices;
  readonly createServer?: (config: ConstructorParameters<typeof DaemonServer>[0]) => DaemonHostServer;
  readonly createListener?: (config: ConstructorParameters<typeof HttpListener>[0]) => DaemonHostListener;
}

export interface DaemonHostSnapshot {
  readonly state: 'idle' | 'starting' | 'ready' | 'degraded' | 'closing' | 'closed' | 'failed';
  readonly boot?: DaemonBootSnapshot;
}

export interface DaemonHost {
  readonly services: RuntimeServices | undefined;
  readonly daemon: DaemonHostServer | undefined;
  readonly httpListener: DaemonHostListener | undefined;
  /** On failure cleanup begins; await close() for its result. Retry with a fresh owner. */
  start(): Promise<DaemonHostSnapshot>;
  /** Fences later phases immediately; awaits every admitted phase and owner. */
  close(): Promise<void>;
  snapshot(): DaemonHostSnapshot;
}

const INTERRUPTED = Symbol('daemon host interrupted');

/**
 * Construction is inert so a process runner can install signals first. The
 * same graph supplies boot, hosted sessions, cluster identity and payments.
 * Every resource is owned before enable/start. No service adoption or update
 * artifact is supplied by this source-only host.
 */
export function createDaemonHost(options: DaemonHostOptions, factories: DaemonHostFactories = {}): DaemonHost {
  const scope = createAsyncDisposalScope('Daemon host');
  let services: RuntimeServices | undefined;
  let daemon: DaemonHostServer | undefined;
  let listener: DaemonHostListener | undefined;
  let state: DaemonHostSnapshot['state'] = 'idle';
  let closed = false;
  let work: Promise<void> | undefined;
  let starting: Promise<DaemonHostSnapshot> | undefined;
  let closing: Promise<void> | undefined;
  let bootClosing: Promise<void> | undefined;
  let startupFailure: Error | undefined;
  const cleanupFailures: Error[] = [];
  let phase = 'runtime acquisition';

  const snapshot = (): DaemonHostSnapshot => ({ state, ...(services?.bootTasks ? { boot: services.bootTasks.snapshot() } : {}) });
  const fence = (): void => { if (closed) throw INTERRUPTED; };
  // Never inspect, stringify or retain rejection values from external owners.
  async function bounded(label: string, action: () => void | Promise<void>): Promise<void> {
    try { await action(); } catch {
      const failure = new Error(`Daemon host ${label} failed`);
      cleanupFailures.push(failure);
      throw failure;
    }
  }
  function closeBoot(): Promise<void> | undefined {
    if (!services?.bootTasks) return undefined;
    if (!bootClosing) {
      bootClosing = bounded('boot drain', () => services!.bootTasks!.close());
      void bootClosing.catch(() => {});
    }
    return bootClosing;
  }
  function ownListener(label: string, owner: DaemonHostServer | DaemonHostListener): void {
    scope.registry.add(label, async () => {
      const failures: Error[] = [];
      // An already-admitted config restart must finish before the final stop.
      try { await bounded(`${label} restart drain`, () => owner.waitForRestart()); }
      catch { failures.push(new Error(`${label} restart drain failed`)); }
      try { await bounded(`${label} stop`, () => owner.stop()); }
      catch { failures.push(new Error(`${label} stop failed`)); }
      if (failures.length) throw new AggregateError(failures, `Daemon host ${label} cleanup failed`);
    });
  }

  async function run(): Promise<void> {
    try {
      fence();
      if (typeof options.runtime.inboxFactory !== 'function') throw new Error('Explicit inbox factory required');
      services = await (factories.createRuntime ?? createRuntimeServices)({
        ...options.runtime, createBootOperations: createDaemonBootOperations,
      });
      const runtime = services;
      scope.registry.add('runtime graph', () => bounded('runtime graph close', () => runtime.close()));
      if (closed) { closeBoot(); fence(); }
      if (!runtime.bootTasks) throw new Error('Daemon boot owner missing');

      phase = 'server construction';
      const binding = options.daemon;
      daemon = (factories.createServer ?? ((config) => new DaemonServer(config)))({
        host: binding?.host, port: binding?.port,
        workingDir: runtime.workingDirectory, homeDirectory: runtime.homeDirectory,
        daemonHomeDir: options.runtime.daemonHomeDirectory,
        configManager: runtime.configManager, userAuth: runtime.localUserAuthManager,
        runtimeBus: runtime.runtimeBus, runtimeServices: runtime,
        serveFactory: createSafeHostServeFactory('Configured daemon', binding?.serveFactory),
        clusterCoordinator: runtime.clusterCoordinator, clusterGroupVerbs: runtime.clusterGroup.verbs,
        paymentReplies: runtime.daemonHandlers.paymentReplies,
        hostedSessions: createHostedSessionOptions(runtime),
      });
      ownListener('daemon server', daemon);
      fence();
      daemon.enable({ daemon: true }, binding?.token);
      fence();

      if (options.httpListener) {
        phase = 'HTTP listener construction';
        const http = options.httpListener;
        listener = (factories.createListener ?? ((config) => new HttpListener(config)))({
          host: http.host, port: http.port, configManager: runtime.configManager,
          userAuth: runtime.localUserAuthManager, hookDispatcher: runtime.hookDispatcher,
          serveFactory: createSafeHostServeFactory('Configured HTTP listener', http.serveFactory),
        });
        ownListener('HTTP listener', listener);
        fence();
        listener.enable({ httpListener: true }, http.token ?? binding?.token);
        fence();
      }

      phase = 'cluster startup';
      await runtime.startCluster();
      fence();
      phase = 'device housekeeping';
      // Await the recovery sweep instead of detaching a startup promise.
      await runtime.devicePosture.startHousekeeping();
      fence();
      phase = 'server startup';
      await daemon.start();
      fence();
      if (!daemon.isRunning) throw new Error('Daemon server did not start');
      if (listener) {
        phase = 'HTTP listener startup';
        await listener.start();
        fence();
        if (!listener.isRunning) throw new Error('HTTP listener did not start');
      }
      phase = 'boot startup';
      const boot = await runtime.bootTasks.start();
      fence();
      state = boot.state === 'ready' ? 'ready' : 'degraded';
    } catch (error) {
      if (error === INTERRUPTED) return;
      startupFailure = new Error(`Daemon host ${phase} failed`);
      throw startupFailure;
    }
  }

  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    state = 'closing';
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void closing.catch(() => {});
    // Boot's own close fences notification/provider/plugin admissions now,
    // even if an accepted factory or plugin is still holding startup open.
    closeBoot();
    void (async () => {
      try { await work; } catch { /* Report startup separately, after cleanup. */ }
      try { await closeBoot(); } catch { /* The bounded owner failure is retained. */ }
      // Late runtime/server acquisitions have registered by this point. Their
      // dependencies survive until boot and accepted server startup drain.
      try { await scope.close(); } catch { /* Every callback retains its bounded failures. */ }
      if (cleanupFailures.length) throw new AggregateError([...cleanupFailures], 'Daemon host cleanup failed');
    })().then(() => { state = startupFailure ? 'failed' : 'closed'; resolve(); }, (error: Error) => { state = 'failed'; reject(error); });
    return closing;
  }

  function start(): Promise<DaemonHostSnapshot> {
    if (closed) return Promise.reject(new Error('Daemon host is closed'));
    if (starting) return starting;
    state = 'starting';
    work = Promise.resolve().then(run);
    starting = work.then(snapshot, () => {
      // Surface failure before drainage: the process runner must be able to
      // start its deadline even if this cleanup never settles.
      void close();
      throw startupFailure;
    });
    void starting.catch(() => {});
    return starting;
  }

  return { get services() { return services; }, get daemon() { return daemon; }, get httpListener() { return listener; }, start, close, snapshot };
}
