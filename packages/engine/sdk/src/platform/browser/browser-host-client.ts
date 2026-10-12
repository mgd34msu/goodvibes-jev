import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from 'playwright-core';
import { types as nodeTypes } from 'node:util';
import { captureOwnedJson } from '../gate/judgment-input.js';

/**
 * Talks to the Node-hosted browser process.
 *
 * The objects handed back here are shaped like the Playwright objects the
 * engine already uses, so every operation, snapshots, refs, clicks, frames,
 * runs unchanged whether the browser was launched in this process or attached
 * to through the host. There is no second implementation of how the browser is
 * driven, only a second way of reaching it.
 */

interface PendingCall {
  readonly child: ChildProcessWithoutNullStreams;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export class BrowserHostError extends Error {
  constructor(message: string, readonly fix: string | null = null) {
    super(message);
    this.name = 'BrowserHostError';
  }
}

/** Node runtimes to try, most specific first. */
function nodeCandidates(): readonly string[] {
  const candidates: string[] = [];
  if (process.execPath.toLowerCase().endsWith('node')) candidates.push(process.execPath);
  candidates.push('node');
  return [...new Set(candidates)];
}

/**
 * Where the host script is, for an ordinary install of this package.
 *
 * The first candidate is the compiled output's own directory, which is where
 * the build stages the script for anyone consuming the published package. The
 * second is the source tree, so the suite and a dev-linked checkout find it
 * without a build. A product that compiles this module into a single-file
 * executable stages the script itself and passes `scriptPath` instead, there
 * is nowhere for this function to look inside a binary.
 */
export function browserHostScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'browser-host.mjs'),
    join(here, '..', '..', '..', 'src', 'platform', 'browser', 'browser-host.mjs'),
  ];
  return candidates.find((path) => existsSync(path)) ?? candidates[0]!;
}

export interface BrowserHostOptions {
  /** An explicit host-script location, for a build that stages it elsewhere. */
  readonly scriptPath?: string | undefined;
  /**
   * What to tell someone whose host script is missing, phrased for how this
   * build was installed. The SDK ships no installer, so the product says it.
   */
  readonly missingScriptFix?: string | undefined;
}

export class BrowserHostClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;
  private startupChild: ChildProcessWithoutNullStreams | null = null;
  private ready: (() => void) | null = null;
  private notReady: (() => void) | null = null;
  private startupError: string | null = null;

  constructor(private readonly options: BrowserHostOptions = {}) {}

  async start(): Promise<void> {
    if (this.child) return;
    const script = this.options.scriptPath ?? browserHostScriptPath();
    if (!existsSync(script)) {
      throw new BrowserHostError(
        `The browser host script is missing (${script}).`,
        this.options.missingScriptFix ?? 'Reinstall this build so its files are complete.',
      );
    }
    let lastError = '';
    for (const runtime of nodeCandidates()) {
      try {
        const child = spawn(runtime, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
        // One reader for the lifetime of the process: the ready line and every
        // later response arrive through the same parser.
        let buffer = '';
        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          let index = buffer.indexOf('\n');
          while (index >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (line) this.handleLine(line, child);
            index = buffer.indexOf('\n');
          }
        });
        const started = await this.waitForReady(child);
        if (started) {
          this.child = child;
          this.observeHostLifetime(child);
          if (this.child !== child) throw new BrowserHostError('The browser host exited during startup.');
          return;
        }
        lastError = this.startupError ?? `${runtime} did not start the browser host`;
        child.kill('SIGTERM');
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new BrowserHostError(
      `Could not start the browser host: ${lastError}`,
      'Attaching to an already-open browser needs real Node on PATH, the shim Bun provides is not enough. Install Node, or use action:"launch", which needs no Node and opens a visible window with a saved profile you can sign into once.',
    );
  }

  private waitForReady(child: ChildProcessWithoutNullStreams): Promise<boolean> {
    this.startupChild = child;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.startupChild === child) this.startupChild = null;
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), 10_000);
      this.ready = () => finish(true);
      this.notReady = () => finish(false);
      child.on('error', () => finish(false));
      child.on('exit', () => finish(false));
    });
  }

  private retireHost(child: ChildProcessWithoutNullStreams): void {
    if (this.child === child) this.child = null;
  }

  private settleRetiredHost(child: ChildProcessWithoutNullStreams): void {
    this.retireHost(child);
    for (const [id, call] of this.pending) {
      if (call.child !== child) continue;
      this.pending.delete(id);
      call.reject(new BrowserHostError('The browser host stopped before the operation completed.', 'Attach again.'));
    }
  }

  private terminateHost(child: ChildProcessWithoutNullStreams): void {
    this.retireHost(child);
    try { child.kill('SIGTERM'); } catch { /* The host may already have exited. */ }
  }

  private observeHostLifetime(child: ChildProcessWithoutNullStreams): void {
    child.once('exit', () => this.settleRetiredHost(child));
    child.once('close', () => this.settleRetiredHost(child));
    child.once('error', () => this.terminateHost(child));
    child.stdin.once('error', () => this.terminateHost(child));
    child.stdout.once('error', () => this.terminateHost(child));
    if (child.exitCode !== null || child.signalCode !== null) this.settleRetiredHost(child);
  }

  private handleLine(line: string, child?: ChildProcessWithoutNullStreams): void {
    let message: { id?: number; ok?: boolean; result?: unknown; error?: string };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    if (message.id === 0) {
      if (child && child !== this.startupChild) return;
      // The host's own hello line, or its refusal to run under this runtime.
      if (message.ok === false) {
        this.startupError = message.error ?? 'the browser host refused to start';
        this.notReady?.();
      } else {
        this.ready?.();
      }
      this.ready = null;
      this.notReady = null;
      return;
    }
    const call = this.pending.get(message.id);
    if (!call || (child && call.child !== child)) return;
    this.pending.delete(message.id);
    if (message.ok) call.resolve(message.result);
    else call.reject(new BrowserHostError(message.error ?? 'the browser host reported a failure'));
  }

  async call<T>(command: string, params: Record<string, unknown> = {}, options: { readonly signal?: AbortSignal | undefined } = {}): Promise<T> {
    const signal = options.signal;
    signal?.throwIfAborted();
    const child = this.child;
    if (!child) throw new BrowserHostError('The browser host is not running.', 'Attach again.');
    const id = this.nextId;
    this.nextId += 1;
    let retained: PendingCall | undefined;
    const response = new Promise<unknown>((resolve, reject) => {
      retained = { child, resolve, reject }; this.pending.set(id, retained);
    });
    let sent = false, cancelled = false;
    const cancel = (): void => {
      if (!sent || cancelled || this.child !== child || this.pending.get(id) !== retained) return;
      cancelled = true;
      try { child.stdin.write(`${JSON.stringify({ command: 'cancel', params: { id } })}\n`); }
      catch { this.terminateHost(child); }
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const request = JSON.stringify({ id, command, params });
      signal?.throwIfAborted();
      if (this.child !== child) throw new BrowserHostError('The browser host is no longer current.');
      try { child.stdin.write(`${request}\n`); sent = true; }
      catch { this.terminateHost(child); }
      if (signal?.aborted) cancel();
      // Cancellation receives the original operation's response only after native work settles.
      const result = await response;
      signal?.throwIfAborted();
      if (this.child !== child) throw new BrowserHostError('The browser host is no longer current.');
      return result as T;
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (!sent && this.pending.get(id) === retained) this.pending.delete(id);
    }
  }

  /**
   * Ends the host process only. The browser it attached to is untouched: this
   * agent never started it, so it is not this agent's to close.
   */
  stop(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    this.retireHost(child);
    try { child.stdin.end(); } catch { /* The transport may already be closed. */ }
    try { child.kill('SIGTERM'); } catch { /* The host may already have exited. */ }
  }
}

interface RemoteFrameDescriptor {
  readonly chain: readonly string[];
  readonly url: string;
  readonly main: boolean;
}

function sourceOf(fn: unknown): string {
  return typeof fn === 'function' ? fn.toString() : String(fn);
}

/** A locator addressed by page, frame chain, and selector, no remote handles. */
function remoteLocator(
  client: BrowserHostClient,
  pageId: string,
  frameChain: readonly string[],
  selector: string,
  index?: number,
): Record<string, unknown> {
  const call = async (method: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const { signal, ...nativeArgs } = args;
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new BrowserHostError('The browser action signal is invalid.');
    const response = await client.call<{ value: unknown }>('locator', {
      pageId,
      frameChain,
      selector,
      method,
      args: { ...nativeArgs, ...(index === undefined ? {} : { index }) },
    }, { signal });
    return response.value;
  };
  const locator: Record<string, unknown> = {
    count: async () => await call('count') as number,
    first: () => remoteLocator(client, pageId, frameChain, selector, 0),
    nth: (position: number) => remoteLocator(client, pageId, frameChain, selector, position),
    evaluate: async (fn: unknown, arg?: unknown) => call('describe', { source: sourceOf(fn), arg }),
    click: async (options?: Record<string, unknown>) => {
      await call('click', options ?? {});
    },
    fill: async (text: string, options?: Record<string, unknown>) => {
      await call('fill', { text, ...options });
    },
    pressSequentially: async (text: string, options?: Record<string, unknown>) => {
      await call('typeSequentially', { text, ...options });
    },
    press: async (key: string, options?: Record<string, unknown>) => {
      await call('press', { key, ...options });
    },
    selectOption: async (values: readonly string[], options?: Record<string, unknown>) => await call('selectOption', { values, ...options }) as string[],
    scrollIntoViewIfNeeded: async (options?: Record<string, unknown>) => {
      await call('scrollIntoView', options ?? {});
    },
  };
  return locator;
}

function remoteFrameLocator(client: BrowserHostClient, pageId: string, chain: readonly string[]): Record<string, unknown> {
  return {
    locator: (selector: string) => remoteLocator(client, pageId, chain, selector),
    frameLocator: (selector: string) => remoteFrameLocator(client, pageId, [...chain, selector]),
  };
}

/**
 * A Page as the engine uses one, backed by the host.
 *
 * `__frameChain` on the frame objects is read by the snapshot code, which would
 * otherwise have to ask each frame for its own element, a round trip the host
 * already made when it listed them.
 */
export function remotePage(client: BrowserHostClient, pageId: string, initialUrl: string): Page {
  let url = initialUrl;
  const pageCall = async (method: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const response = await client.call<{ value: unknown }>('pageCall', { pageId, method, args });
    return response.value;
  };
  const frameFor = (descriptor: RemoteFrameDescriptor): Record<string, unknown> => ({
    __frameChain: descriptor.chain,
    url: () => descriptor.url,
    parentFrame: () => (descriptor.main ? null : {}),
    frameElement: async () => ({ evaluate: async () => descriptor.chain.at(-1) ?? '' }),
    evaluate: async (fn: unknown, arg?: unknown) => {
      const response = await client.call<{ value: unknown }>('evaluate', {
        pageId,
        frameChain: descriptor.chain,
        source: sourceOf(fn),
        arg,
      });
      return response.value;
    },
  });

  let frames: RemoteFrameDescriptor[] = [{ chain: [], url: initialUrl, main: true }];
  const refreshFrames = async (options?: { readonly complete?: boolean }): Promise<void> => {
    if (options?.complete !== true) {
      const response = await client.call<{ frames: RemoteFrameDescriptor[] }>('frames', { pageId });
      frames = response.frames;
      return;
    }
    const response = captureOwnedJson(await client.call<unknown>('frames', { pageId, complete: true }), nodeTypes.isProxy);
    if (!response || typeof response !== 'object' || Array.isArray(response)
      || !('complete' in response) || response.complete !== true || !('url' in response) || typeof response.url !== 'string'
      || !('frames' in response) || !Array.isArray(response.frames) || Object.keys(response).length !== 3) throw new BrowserHostError('Complete current browser frames are unavailable.');
    const currentFrames: RemoteFrameDescriptor[] = [];
    for (const descriptor of response.frames) {
      if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor) || Object.keys(descriptor).length !== 3
        || !('chain' in descriptor) || !Array.isArray(descriptor.chain) || descriptor.chain.some((part: unknown) => typeof part !== 'string' || !part)
        || !('url' in descriptor) || typeof descriptor.url !== 'string' || !('main' in descriptor) || typeof descriptor.main !== 'boolean') throw new BrowserHostError('Complete current browser frames are unavailable.');
      const chain: string[] = [];
      for (const part of descriptor.chain) { if (typeof part !== 'string') throw new BrowserHostError('Complete current browser frames are unavailable.'); chain.push(part); }
      if (descriptor.main !== (chain.length === 0)) throw new BrowserHostError('Complete current browser frames are unavailable.');
      currentFrames.push({ chain, url: descriptor.url, main: descriptor.main });
    }
    if (currentFrames.filter(frame => frame.main).length !== 1 || new Set(currentFrames.map(frame => JSON.stringify(frame.chain))).size !== currentFrames.length
      || currentFrames.find(frame => frame.main)?.url !== response.url) throw new BrowserHostError('Complete current browser frames are unavailable.');
    frames = currentFrames;
    url = response.url;
  };
  const page: Record<string, unknown> = {
    url: () => url,
    title: async () => await pageCall('title') as string,
    on: () => undefined,
    close: async () => {
      await client.call('closePage', { pageId });
    },
    goto: async (target: string, options?: Record<string, unknown>) => {
      const value = await pageCall('goto', { url: target, ...options }) as { status: number } | null;
      url = await pageCall('url') as string;
      await refreshFrames();
      return value ? { status: () => value.status } : null;
    },
    goBack: async (options?: Record<string, unknown>) => {
      const moved = await pageCall('goBack', options ?? {}) as boolean;
      url = await pageCall('url') as string;
      return moved ? {} : null;
    },
    goForward: async (options?: Record<string, unknown>) => {
      const moved = await pageCall('goForward', options ?? {}) as boolean;
      url = await pageCall('url') as string;
      return moved ? {} : null;
    },
    waitForLoadState: async (state?: string, options?: Record<string, unknown>) => {
      await pageCall('waitForLoadState', { state, ...options });
    },
    waitForURL: async (target: string, options?: Record<string, unknown>) => {
      url = await pageCall('waitForURL', { url: target, ...options }) as string;
    },
    getByText: (text: string) => ({
      first: () => ({
        waitFor: async (options?: Record<string, unknown>) => {
          await pageCall('waitForText', { text, ...options });
        },
      }),
    }),
    screenshot: async (options?: Record<string, unknown>) => {
      const value = await pageCall('screenshot', options ?? {}) as { bytes: number };
      return { byteLength: value.bytes };
    },
    mouse: {
      wheel: async (_x: number, delta: number) => {
        await pageCall('wheel', { delta });
      },
    },
    evaluate: async (fn: unknown, arg?: unknown) => {
      const response = await client.call<{ value: unknown }>('evaluate', { pageId, frameChain: [], source: sourceOf(fn), arg });
      return response.value;
    },
    locator: (selector: string) => remoteLocator(client, pageId, [], selector),
    frameLocator: (selector: string) => remoteFrameLocator(client, pageId, [selector]),
    mainFrame: () => frameFor(frames.find((frame) => frame.main) ?? { chain: [], url, main: true }),
    frames: () => frames.map(frameFor),
    refreshFrames,
  };
  return page as unknown as Page;
}

export interface RemoteContextHandle {
  readonly context: BrowserContext;
  readonly refresh: () => Promise<void>;
}

/** A BrowserContext as the engine uses one, backed by the host. */
export function remoteContext(client: BrowserHostClient, initialPages: readonly { pageId: string; url: string }[]): BrowserContext {
  const pages = initialPages.map((entry) => remotePage(client, entry.pageId, entry.url));
  const context: Record<string, unknown> = {
    pages: () => pages,
    on: () => undefined,
    newPage: async () => {
      const created = await client.call<{ pageId: string }>('newPage');
      const page = remotePage(client, created.pageId, 'about:blank');
      pages.push(page);
      return page;
    },
    // Releasing the transport, never closing someone else's browser.
    close: async () => {
      await client.call('release');
      client.stop();
    },
  };
  return context as unknown as BrowserContext;
}
