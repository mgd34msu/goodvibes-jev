import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { run as runCommand } from '../sdk/src/platform/hooks/runners/command.ts';
import { run as runPrompt } from '../sdk/src/platform/hooks/runners/prompt.ts';
import { run as runHttp } from '../sdk/src/platform/hooks/runners/http.ts';
import { run as runTypeScript } from '../sdk/src/platform/hooks/runners/typescript.ts';
import { OwnedProcessGroupUnsupportedError, runProcess } from '../sdk/src/platform/runtime/remote/host/backends/process-runner.ts';
import type { HookEvent } from '../sdk/src/platform/hooks/types.ts';
import { ToolLLM } from '../sdk/src/platform/config/tool-llm.ts';
import type { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import type { LLMProvider } from '../sdk/src/platform/providers/interface.ts';

const event: HookEvent = { path: 'Pre:tool:read', phase: 'Pre', category: 'tool', specific: 'read', sessionId: 'owned-hook', timestamp: 0, payload: {} };
const roots: string[] = [];
const globals: string[] = [];
const registry = globalThis as unknown as Record<string, unknown>;
afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
  (Bun.spawn as unknown as { mockRestore?: () => void }).mockRestore?.();
  for (const key of globals.splice(0)) delete registry[key];
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
async function staysPending(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await tick();
  expect(settled).toBe(false);
}
function directory() {
  const root = mkdtempSync(join(tmpdir(), 'owned-hooks-'));
  roots.push(root);
  return root;
}
function toolLLM(chat: LLMProvider['chat']) {
  return new ToolLLM({
    configManager: { get: ((key: string) => {
      if (key === 'tools.llmEnabled') return true;
      if (key === 'tools.llmProvider') return 'fixture';
      if (key === 'tools.llmModel') return 'fixture-model';
      return '';
    }) as ConfigManager['get'] },
    providerRegistry: {
      getCurrentModel: () => { throw new Error('configured route expected'); },
      getForModel: () => ({ name: 'fixture', models: [], chat }),
      resolveModelPricing: () => ({ status: 'unknown' }),
    },
  });
}
const response = () => ({ content: '{"ok":true}', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'completed' as const });

describe('owned prompt invocation', () => {
  for (const cause of ['abort', 'timeout'] as const) {
    test(`${cause} reaches provider and joins its actual settlement`, async () => {
      const controller = new AbortController();
      const started = deferred<AbortSignal>();
      const aborted = deferred<void>();
      const released = deferred<void>();
      const llm = toolLLM(async ({ signal }) => {
        if (!signal) throw new Error('missing provider signal');
        signal.addEventListener('abort', () => aborted.resolve(), { once: true });
        started.resolve(signal);
        await released.promise;
        return response();
      });
      const work = runPrompt({ match: '*', type: 'prompt', prompt: '$ARGUMENTS', timeout: cause === 'timeout' ? 0.03 : 5 }, event, llm, { signal: controller.signal });
      try {
        const signal = await started.promise;
        if (cause === 'abort') controller.abort(new Error('turn stopped'));
        await aborted.promise;
        expect(signal.aborted).toBe(true);
        await staysPending(work);
      } finally { released.resolve(); }
      const result = await work;
      expect(result.ok).toBe(false);
      expect(result.error).toContain(cause === 'abort' ? 'turn stopped' : 'timed out');
    });
  }

  test('pre-aborted options never invoke the provider', async () => {
    let called = false;
    const controller = new AbortController();
    controller.abort();
    const result = await runPrompt({ match: '*', type: 'prompt', prompt: 'check' }, event, toolLLM(async () => { called = true; return response(); }), { signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe('owned HTTP invocation', () => {
  for (const cause of ['abort', 'timeout'] as const) {
    test(`${cause} covers response body and joins delayed consumption`, async () => {
      const parent = new AbortController();
      const aborted = deferred<void>();
      let body!: ReadableStreamDefaultController<Uint8Array>;
      let signal: AbortSignal | null | undefined;
      spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
        signal = init?.signal;
        signal?.addEventListener('abort', () => aborted.resolve(), { once: true });
        // Deliberately non-cooperative transport: the wrapper cannot claim
        // cleanup just because it requested cancellation after the headers.
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }));
      }) as typeof fetch);
      const work = runHttp({ match: '*', type: 'http', url: 'https://example.com/hook', timeout: cause === 'timeout' ? 0.03 : 5 }, event, { signal: parent.signal });
      try {
        await tick();
        if (cause === 'abort') parent.abort(new Error('turn stopped'));
        await aborted.promise;
        expect(signal?.aborted).toBe(true);
        await staysPending(work);
      } finally { body.close(); }
      const result = await work;
      expect(result.ok).toBe(false);
      expect(result.error).toContain(cause === 'abort' ? 'turn stopped' : 'timed out');
    });
  }

  test('pre-aborted options never issue a request', async () => {
    const fetch = spyOn(globalThis, 'fetch');
    const controller = new AbortController();
    controller.abort();
    expect((await runHttp({ match: '*', type: 'http', url: 'https://example.com/hook' }, event, { signal: controller.signal })).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

function tsFixture(source: (key: string) => string, value: unknown) {
  const root = directory();
  const key = `owned_hook_${randomUUID()}`;
  globals.push(key);
  registry[key] = value;
  writeFileSync(join(root, 'hook.ts'), source(JSON.stringify(key)));
  return root;
}

describe('owned TypeScript invocation', () => {
  for (const cause of ['abort', 'timeout'] as const) {
    test(`${cause} signals the handler but waits when it ignores cancellation`, async () => {
      const parent = new AbortController();
      const started = deferred<AbortSignal>();
      const aborted = deferred<void>();
      const release = deferred<void>();
      const root = tsFixture((key) => `const control = globalThis[${key}]; export default async (_event, { signal }) => { control.start(signal); await control.release; return { ok: true }; };`, {
        start(signal: AbortSignal) { signal.addEventListener('abort', () => aborted.resolve(), { once: true }); started.resolve(signal); },
        release: release.promise,
      });
      const work = runTypeScript({ match: '*', type: 'ts', path: 'hook.ts', timeout: cause === 'timeout' ? 0.03 : 5 }, event, root, { signal: parent.signal });
      try {
        const signal = await started.promise;
        if (cause === 'abort') parent.abort(new Error('turn stopped'));
        await aborted.promise;
        expect(signal.aborted).toBe(true);
        await staysPending(work);
      } finally { release.resolve(); }
      const result = await work;
      expect(result.ok).toBe(false);
      expect(result.error).toContain(cause === 'abort' ? 'turn stopped' : 'timed out');
    });
  }

  test('abort during module import joins import and does not admit its handler', async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    let called = false;
    const root = tsFixture((key) => `const control = globalThis[${key}]; control.start(); await control.release; export default () => { control.call(); return {ok: true}; };`, {
      start: () => started.resolve(), release: release.promise, call: () => { called = true; },
    });
    const controller = new AbortController();
    const work = runTypeScript({ match: '*', type: 'ts', path: 'hook.ts' }, event, root, { signal: controller.signal });
    try {
      await started.promise;
      controller.abort();
      await staysPending(work);
    } finally { release.resolve(); }
    expect((await work).ok).toBe(false);
    expect(called).toBe(false);
  });

  test('pre-aborted options do not import the module', async () => {
    let imported = false;
    const root = tsFixture((key) => `globalThis[${key}](); export default () => ({ok: true});`, () => { imported = true; });
    const controller = new AbortController();
    controller.abort();
    expect((await runTypeScript({ match: '*', type: 'ts', path: 'hook.ts' }, event, root, { signal: controller.signal })).ok).toBe(false);
    expect(imported).toBe(false);
  });
});

test('Windows owned-command support is explicitly unavailable before any child starts', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const spawn = spyOn(Bun, 'spawn');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    await expect(runProcess({ args: ['fixture'], timeoutMs: 100, ownedProcessGroup: true })).rejects.toBeInstanceOf(OwnedProcessGroupUnsupportedError);
    const result = await runCommand({ match: '*', type: 'command', command: 'fixture' }, event, {});
    expect(result).toEqual({
      ok: false,
      code: 'OWNED_PROCESS_GROUP_UNSUPPORTED',
      error: 'Owned process-group cleanup is unavailable on Windows; command was not started.',
    });
    expect(spawn).not.toHaveBeenCalled();
  } finally { Object.defineProperty(process, 'platform', platform); }
});

if (process.platform !== 'win32') {
  describe('owned command invocation', () => {
    test('joins a held stdin completion after timeout rather than abandoning it', async () => {
      const input = deferred<void>();
      const exit = deferred<number>();
      const killed = deferred<void>();
      const empty = () => new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
      const child = {
        pid: 2147483647, stdout: empty(), stderr: empty(),
        stdin: { write() {}, end: () => input.promise },
        exited: exit.promise,
        kill() { killed.resolve(); exit.resolve(137); },
      };
      spyOn(Bun, 'spawn').mockImplementation((() => child) as unknown as typeof Bun.spawn);
      const work = runProcess({ args: ['fixture'], stdin: 'event', timeoutMs: 20, ownedProcessGroup: true });
      try {
        await killed.promise;
        await staysPending(work);
      } finally { input.resolve(); }
      expect((await work).timedOut).toBe(true);
    });

    test('I/O failure requests stop but still joins other admitted I/O', async () => {
      const input = deferred<void>();
      const exit = deferred<number>();
      const killed = deferred<void>();
      const child = {
        pid: 2147483647,
        stdout: new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('fixture stream failed')); } }),
        stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
        stdin: { write() {}, end: () => input.promise },
        exited: exit.promise,
        kill() { killed.resolve(); exit.resolve(137); },
      };
      spyOn(Bun, 'spawn').mockImplementation((() => child) as unknown as typeof Bun.spawn);
      const work = runProcess({ args: ['fixture'], stdin: 'event', timeoutMs: 5000, ownedProcessGroup: true });
      try {
        await killed.promise;
        await staysPending(work);
      } finally { input.resolve(); }
      await expect(work).rejects.toThrow('fixture stream failed');
    });

    test('pre-aborted options never spawn the command', async () => {
      const spawn = spyOn(Bun, 'spawn');
      const controller = new AbortController();
      controller.abort();
      expect((await runCommand({ match: '*', type: 'command', command: 'echo should-not-run' }, event, { signal: controller.signal })).ok).toBe(false);
      expect(spawn).not.toHaveBeenCalled();
    });

    for (const cause of ['abort', 'timeout', 'normal'] as const) {
      test(`${cause} leaves no live owned descendant, including ignored TERM and redirected pipes`, async () => {
        const root = directory();
        const pidPath = join(root, 'descendant.pid');
        const marker = join(root, 'descendant-late-work');
        const releaseParent = join(root, 'parent-exit');
        const releaseChild = join(root, 'child-exit');
        const childWork = cause === 'normal'
          ? `setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(releaseChild)})) { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'finished normally'); process.exit(0); } }, 10);`
          : `setInterval(() => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'); }, 5000);`;
        const childCode = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); ${childWork}`;
        const parentCode = `process.on('SIGTERM', () => {}); Bun.spawn([process.execPath, '--no-env-file', '-e', ${JSON.stringify(childCode)}], { stdout: 'ignore', stderr: 'ignore' }); setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(releaseParent)})) process.exit(0); }, 10);`;
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        const controller = new AbortController();
        const command = `${quote(process.execPath)} --no-env-file -e ${quote(parentCode)}`;
        const work = runCommand({ match: '*', type: 'command', command, timeout: cause === 'timeout' ? 1 : 10 }, event, { signal: controller.signal });
        let pid: number | undefined;
        try {
          for (let attempt = 0; attempt < 300 && !existsSync(pidPath); attempt++) await tick();
          expect(existsSync(pidPath)).toBe(true);
          pid = Number(readFileSync(pidPath, 'utf8'));
          if (cause === 'abort') controller.abort();
          if (cause === 'normal') {
            writeFileSync(releaseParent, 'exit');
            await staysPending(work);
            writeFileSync(releaseChild, 'exit');
          }
          const result = await work;
          expect(result.ok).toBe(cause === 'normal');
          if (cause === 'timeout') expect(result.error).toContain('timed out');
          if (process.platform === 'linux') {
            let state = 'gone';
            try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]!; } catch {}
            expect(['gone', 'Z', 'X']).toContain(state);
          } else {
            expect(() => process.kill(pid!, 0)).toThrow();
          }
          expect(existsSync(marker)).toBe(cause === 'normal');
        } finally {
          controller.abort();
          if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
          await work;
        }
      }, 15_000);
    }
  });
}
