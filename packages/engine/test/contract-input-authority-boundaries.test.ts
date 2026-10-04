import type { Contract } from '../sdk/src/platform/contract/types.js';
import type { ContractInputAuthority } from '../sdk/src/platform/contract/input-authority.js';
import { test, expect, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  captureContractInput,
  materializeContractInput,
  contractInputPath,
} from '../sdk/src/platform/contract/input-snapshot.js';
import {
  createContractInputAuthority,
  authorizeContractInputPath,
  bindContractInputAuthority,
  getContractInputAuthority,
  revokeContractInputAuthority,
  assertContractInputAuthority,
} from '../sdk/src/platform/contract/input-authority.js';
function git(root: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', root, ...args]);
  if (r.status) throw Error(r.stderr.toString());
}
async function fixture(
  fn: (context: {
    root: string;
    view: string;
    contract: Contract;
    abort: AbortController;
    token: ContractInputAuthority;
  }) => Promise<void>,
  mutable = false,
) {
  const root = mkdtempSync(join(tmpdir(), 'pr56-independent-'));
  try {
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Fixture');
    git(root, 'config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
    writeFileSync(join(root, 'a.txt'), 'synthetic-owned');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'fixture');
    const receipt = await captureContractInput(root);
    const view = contractInputPath(receipt);
    git(root, 'worktree', 'add', '--no-checkout', '-b', 'fixture-view', view, receipt.inputCommit);
    await materializeContractInput(receipt, view);
    const contract = { inputSnapshot: receipt, projectRoot: root } as Contract;
    const abort = new AbortController();
    const token = await createContractInputAuthority(contract, view, {
      signal: abort.signal,
      mutable,
      branch: 'fixture-view',
    });
    await fn({ root, view, contract, abort, token });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test('independent opaque binding and dual-path allow/deny', async () =>
  fixture(async ({ root, view, token }) => {
    const obj = {};
    bindContractInputAuthority(obj, token);
    expect(getContractInputAuthority(obj)).toBe(token);
    expect(getContractInputAuthority({ ...obj })).toBeUndefined();
    expect(() => bindContractInputAuthority({}, JSON.parse(JSON.stringify(token)))).toThrow();
    const seen: string[] = [];
    expect(
      await authorizeContractInputPath(token, 'a.txt', async (p) => {
        seen.push(p);
        return true;
      }),
    ).toBe(join(view, 'a.txt'));
    expect(seen).toEqual([join(root, 'a.txt'), join(view, 'a.txt')]);
    await expect(authorizeContractInputPath(token, 'a.txt', async (p) => p !== join(root, 'a.txt'))).rejects.toThrow();
    await expect(authorizeContractInputPath(token, 'a.txt', undefined)).rejects.toThrow();
  }));
test('independent revocation and cancellation during awaited permission', async () =>
  fixture(async ({ token, abort }) => {
    await expect(
      authorizeContractInputPath(token, 'a.txt', async () => {
        await Promise.resolve();
        abort.abort();
        return true;
      }),
    ).rejects.toThrow();
  }));
test('independent revoked token rejects delivery', async () =>
  fixture(async ({ token }) => {
    await expect(
      authorizeContractInputPath(token, 'a.txt', async () => {
        revokeContractInputAuthority(token);
        return true;
      }),
    ).rejects.toThrow();
  }));
test('independent outside/excluded/root mismatch hold', async () =>
  fixture(async ({ root, token }) => {
    for (const path of ['../a.txt', '.git/config', '.goodvibes/private.txt'])
      await expect(authorizeContractInputPath(token, path, async () => true)).rejects.toThrow();
    await expect(assertContractInputAuthority(token, root)).rejects.toThrow();
  }));
test('independent original symlink cannot borrow copied permission', async () =>
  fixture(async ({ root, token }) => {
    writeFileSync(join(root, 'other.txt'), 'synthetic alias');
    rmSync(join(root, 'a.txt'));
    symlinkSync('other.txt', join(root, 'a.txt'));
    await expect(authorizeContractInputPath(token, 'a.txt', async () => true)).rejects.toThrow();
  }));
test('independent cloned receipt is not the admitted generation', async () =>
  fixture(async ({ contract, token }) => {
    contract.inputSnapshot = structuredClone(contract.inputSnapshot);
    await expect(assertContractInputAuthority(token)).rejects.toThrow();
  }));
import { capturedInputTool, capturedInputReadFilter } from '../sdk/src/platform/tools/shared/captured-input-tools.js';
import { ReadTool } from '../sdk/src/platform/tools/read/index.js';
import { ProjectIndex } from '../sdk/src/platform/state/project-index.js';
import { FileStateCache } from '../sdk/src/platform/state/file-cache.js';
import { createEditTool } from '../sdk/src/platform/tools/edit/index.js';
import { createAnalyzeTool } from '../sdk/src/platform/tools/analyze/index.js';
test('independent tool argument mutation during permission await stays held', async () =>
  fixture(async ({ root, view, token }) => {
    const args = { files: [{ path: 'a.txt' }] };
    let changed = false;
    const filter = async (p: string) => {
      if (!changed && p === join(root, 'a.txt')) {
        args.files[0]!.path = '.gitignore';
        changed = true;
      }
      return p !== join(root, '.gitignore');
    };
    const delivered = new Set<string>();
    const guarded = capturedInputReadFilter(token, view, filter, undefined, delivered);
    const index = new ProjectIndex(view);
    try {
      const tool = capturedInputTool(
        new ReadTool(index, undefined, undefined, guarded),
        token,
        view,
        filter,
        undefined,
      );
      const result = await tool.execute(args);
      expect(result.success).toBe(true);
      expect(result.output).toContain('synthetic-owned');
      expect(result.output ? JSON.parse(result.output).files?.[0]?.content : '').not.toContain('.goodvibes/');
    } finally {
      await index.dispose();
    }
  }));
import { createWriteTool } from '../sdk/src/platform/tools/write/index.js';
test('independent write args remain pinned through permission callbacks', async () =>
  fixture(async ({ root, view, token }) => {
    const args = {
      files: [
        {
          path: 'a.txt',
          content: 'synthetic authorized write',
          mode: 'overwrite',
        },
      ],
    };
    let changed = false;
    const filter = async (p: string) => {
      if (!changed && p === join(root, 'a.txt')) {
        args.files[0]!.path = '.gitignore';
        changed = true;
      }
      return p !== join(root, '.gitignore');
    };
    const guarded = capturedInputReadFilter(token, view, filter, undefined, new Set<string>());
    const tool = capturedInputTool(
      createWriteTool({ projectRoot: view, capturedReadAccess: guarded }),
      token,
      view,
      filter,
      undefined,
    );
    const result = await tool.execute(args);
    expect(result.success).toBe(true);
    expect(readFileSync(join(view, '.gitignore'), 'utf8')).toBe('.goodvibes/\n');
    expect(readFileSync(join(view, 'a.txt'), 'utf8')).toBe('synthetic authorized write');
  }, true));
test('same-root mutable leases keep their own cancellation signals', async () =>
  fixture(async ({ contract, view, token }) => {
    const secondStop = new AbortController();
    const second = await createContractInputAuthority(contract, view, {
      signal: secondStop.signal,
      mutable: true,
      branch: 'fixture-view',
    });
    secondStop.abort();
    await expect(assertContractInputAuthority(second)).rejects.toThrow();
    await expect(authorizeContractInputPath(token, 'a.txt', async () => true)).resolves.toBe(join(view, 'a.txt'));
  }, true));

test('captured invocation keeps the original per-call cancellation signal', async () =>
  fixture(async ({ root, view, token }) => {
    const stop = new AbortController();
    const options: { signal?: AbortSignal } = { signal: stop.signal };
    const filter = async (path: string) => {
      if (path === join(root, 'a.txt')) {
        stop.abort();
        options.signal = new AbortController().signal;
      }
      return true;
    };
    const guarded = capturedInputReadFilter(token, view, filter, undefined, new Set());
    const index = new ProjectIndex(view);
    try {
      const tool = capturedInputTool(
        new ReadTool(index, undefined, undefined, guarded),
        token,
        view,
        filter,
        undefined,
      );
      const result = await tool.execute({ files: [{ path: 'a.txt' }] }, options);
      expect(result.output ?? '').not.toContain('synthetic-owned');
      expect(result.success).toBe(false);
    } finally {
      await index.dispose();
    }
  }));

for (const name of ['edit', 'analyze'] as const) {
  for (const control of ['allowed', 'denied', 'outside', 'cancelled', 'mutated'] as const) {
    test(`guarded ${name} keeps ${control} backend access in its captured view`, async () =>
      fixture(async ({ root, view, token, abort }) => {
        const target = control === 'outside' ? join(root, 'a.txt') : 'a.txt';
        const args =
          name === 'edit'
            ? { edits: [{ path: target, find: 'synthetic-owned', replace: 'synthetic-edited' }] }
            : {
                mode: 'preview',
                projectRoot: '.',
                files: [target],
                find: 'synthetic-owned',
                replace: 'synthetic-preview',
              };
        const filter = async (path: string) => {
          if (path === join(root, 'a.txt')) {
            if (control === 'cancelled') abort.abort();
            if (control === 'mutated') {
              if ('edits' in args) args.edits![0]!.path = join(root, 'a.txt');
              else args.files![0] = join(root, 'a.txt');
            }
            if (control === 'denied') return false;
          }
          return true;
        };
        const backend =
          name === 'edit'
            ? createEditTool(new FileStateCache(), { cwd: view })
            : createAnalyzeTool(
                {
                  chat: async () => {
                    throw new Error('preview must not call a provider');
                  },
                },
                undefined,
                view,
              );
        const tool = capturedInputTool(backend, token, view, filter, abort.signal);
        const opened: string[] = [];
        const read = fs.readFileSync;
        const readTap = spyOn(fs, 'readFileSync').mockImplementation(((
          ...input: Parameters<typeof fs.readFileSync>
        ) => {
          opened.push(String(input[0]));
          return read(...input);
        }) as typeof fs.readFileSync);
        const file = Bun.file;
        const fileTap = spyOn(Bun, 'file').mockImplementation(((...input: Parameters<typeof Bun.file>) => {
          opened.push(String(input[0]));
          return file(...input);
        }) as typeof Bun.file);
        let result: Awaited<ReturnType<typeof tool.execute>>;
        try {
          result = await tool.execute(args);
        } finally {
          readTap.mockRestore();
          fileTap.mockRestore();
        }
        if (control === 'allowed' || control === 'mutated') {
          expect(result.success).toBe(true);
          expect(opened).toContain(join(view, 'a.txt'));
          expect(readFileSync(join(view, 'a.txt'), 'utf8')).toBe(
            name === 'edit' ? 'synthetic-edited' : 'synthetic-owned',
          );
          if (name === 'analyze') expect(result.output).toContain('synthetic-preview');
        } else {
          expect(opened).not.toContain(join(view, 'a.txt'));
          expect(result.output ?? '').not.toContain('synthetic-owned');
          expect(readFileSync(join(view, 'a.txt'), 'utf8')).toBe('synthetic-owned');
        }
        expect(opened).not.toContain(join(root, 'a.txt'));
        expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('synthetic-owned');
      }, true));
  }
}

test('captured edit with dependents reports unavailable diagnostics without host compiler admission', async () =>
  fixture(async ({ view, token }) => {
    writeFileSync(join(view, 'a.ts'), 'export const answer = 1;\n');
    writeFileSync(join(view, 'b.ts'), 'import { answer } from "./a"; export const result = answer;\n');
    const tool = capturedInputTool(
      createEditTool(new FileStateCache(), { cwd: view }),
      token,
      view,
      async () => true,
      undefined,
    );
    let admitted = 0;
    const tap = spyOn(Bun, 'spawn').mockImplementation((() => {
      admitted++;
      throw new Error('host compiler must not be started');
    }) as typeof Bun.spawn);
    try {
      const result = await tool.execute({ edits: [{ path: 'a.ts', find: 'answer = 1', replace: 'answer = 2' }] });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Automatic dependency diagnostics are unavailable');
      expect(readFileSync(join(view, 'a.ts'), 'utf8')).toContain('answer = 2');
      expect(admitted).toBe(0);
    } finally {
      tap.mockRestore();
    }
  }, true));

for (const allowed of [false, true]) {
  test(`captured notebook extraction keeps original-path ${allowed ? 'allow' : 'deny'}`, async () =>
    fixture(async ({ root, view, token }) => {
      writeFileSync(
        join(view, 'fixture.ipynb'),
        JSON.stringify({
          nbformat: 4,
          nbformat_minor: 0,
          metadata: {},
          cells: [
            { cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: ['NOTEBOOK_OWNED_MARKER'] },
          ],
        }),
      );
      const filter = async (path: string) => allowed || path !== join(root, 'fixture.ipynb');
      const index = new ProjectIndex(view);
      const access = capturedInputReadFilter(token, view, filter, undefined, new Set());
      const tool = capturedInputTool(new ReadTool(index, undefined, undefined, access), token, view, filter, undefined);
      const opened: string[] = [];
      const read = fs.readFileSync;
      const tap = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
        opened.push(String(args[0]));
        return read(...args);
      }) as typeof fs.readFileSync);
      try {
        const result = await tool.execute({ files: [{ path: 'fixture.ipynb' }] });
        if (allowed) {
          expect(result.success).toBe(true);
          expect(result.output).toContain('NOTEBOOK_OWNED_MARKER');
          expect(opened).toContain(join(view, 'fixture.ipynb'));
        } else {
          expect(result.output ?? '').not.toContain('NOTEBOOK_OWNED_MARKER');
          expect(opened).not.toContain(join(view, 'fixture.ipynb'));
        }
      } finally {
        tap.mockRestore();
        await index.dispose();
      }
    }, true));
}

test('captured content search rechecks stored-rule revocation before consulting its existing cache', async () =>
  fixture(async ({ root, view, token }) => {
    const { ConfigManager } = await import('../sdk/src/platform/config/index.js');
    const { createClientRuntimeServices } = await import('../sdk/src/platform/runtime/bootstrap.js');
    const { RuntimeEventBus, createRuntimeStore } = await import('../sdk/src/platform/runtime/state.js');
    const { createLaunchTolerantProviderRegistry } = await import('../sdk/src/platform/providers/index.js');
    const { fakePort, noulAnswer } = await import('@goodvibes-jev/judgment/testing');
    const { installJudgmentPort } = await import('../errors/src/index.js');
    const { createFindTool } = await import('../sdk/src/platform/tools/find/index.js');
    const { FindRuntimeService } = await import('../sdk/src/platform/tools/find/shared.js');
    const config = new ConfigManager({
      surfaceRoot: 'agent',
      configDir: join(root, '.goodvibes', 'cfg'),
      workingDir: root,
      homeDir: root,
    });
    config.set('permissions.engine', 'policy-engine');
    config.set('permissions.mode', 'prompt');
    const runtime = createClientRuntimeServices({
      surfaceRoot: 'agent',
      configManager: config,
      workingDir: root,
      homeDirectory: root,
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      modelDiscovery: 'skip',
      providerRegistryFactory: createLaunchTolerantProviderRegistry,
      requestApproval: async () => ({ approved: true }),
    });
    const previous = installJudgmentPort(fakePort(() => noulAnswer(0.01)).port);
    const search = new FindRuntimeService();
    const filter = async (path: string) => (await runtime.permissionManager.readAccess(path)) === 'allow';
    const access = capturedInputReadFilter(token, view, filter, undefined, new Set());
    const tool = capturedInputTool(
      createFindTool(view, undefined, search, access, access),
      token,
      view,
      filter,
      undefined,
    );
    const args = { queries: [{ id: 'q', mode: 'content', pattern: 'synthetic' }] };
    const cache = spyOn(search, 'searchCacheGet');
    try {
      const first = await tool.execute(args);
      expect(first.success).toBe(true);
      expect(first.output).toContain('synthetic-owned');
      const afterFirst = cache.mock.calls.length;
      expect(afterFirst).toBeGreaterThan(0);
      await runtime.userPermissionRuleStore.add({
        rule: {
          id: 'revoke-cached-read',
          type: 'path-scope',
          origin: 'user',
          effect: 'deny',
          toolPattern: 'read',
          pathPatterns: [join(root, 'a.txt')],
        },
        createdAt: Date.now(),
        tier: 'path',
        tool: 'read',
      });
      expect(await runtime.permissionManager.readAccess(join(root, 'a.txt'))).toBe('restricted');
      const second = await tool.execute(args);
      expect(second.success).toBe(false);
      expect(second.output ?? '').not.toContain('synthetic-owned');
      expect(cache.mock.calls.length).toBe(afterFirst);
    } finally {
      cache.mockRestore();
      runtime.dispose();
      installJudgmentPort(previous);
    }
  }, true));

test('construction-owned auxiliary read assertions remain tied to their exact lease', async () =>
  fixture(async ({ token, contract, view }) => {
    const { registerContractInputReadAssertion, assertContractInputReadAccess } =
      await import('../sdk/src/platform/contract/input-authority.js');
    let current = true;
    let checks = 0;
    registerContractInputReadAssertion(token, async () => {
      checks++;
      if (!current) throw new Error('declared dependency permission changed');
    });
    await assertContractInputReadAccess(token, async () => true);
    expect(checks).toBe(1);
    current = false;
    await expect(assertContractInputReadAccess(token, async () => true)).rejects.toThrow(
      'declared dependency permission changed',
    );
    const other = await createContractInputAuthority(contract, view, { mutable: true, branch: 'fixture-view' });
    await assertContractInputReadAccess(other, async () => true);
    expect(checks).toBe(2);
    revokeContractInputAuthority(token);
    expect(() => registerContractInputReadAssertion(token, async () => {})).toThrow('revoked');
  }, true));

for (const allowed of [false, true]) {
  test(`captured inspection keeps original-path ${allowed ? 'allow' : 'deny'}`, async () =>
    fixture(async ({ root, view, token }) => {
      const { InspectTool } = await import('../sdk/src/platform/tools/inspect/index.js');
      writeFileSync(join(view, 'component.tsx'), 'export function OwnedWidget() { return <div>fixture</div>; }\n');
      const filter = async (path: string) => allowed || path !== join(root, 'component.tsx');
      const tool = capturedInputTool(new InspectTool(undefined, view), token, view, filter, undefined);
      const opened: string[] = [];
      const read = fs.readFileSync;
      const tap = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
        opened.push(String(args[0]));
        return read(...args);
      }) as typeof fs.readFileSync);
      try {
        const result = await tool.execute({ mode: 'components', projectRoot: '.', file: 'component.tsx' });
        if (allowed) {
          expect(result.success).toBe(true);
          expect(result.output).toContain('OwnedWidget');
          expect(opened).toContain(join(view, 'component.tsx'));
        } else {
          expect(result.success).toBe(false);
          expect(result.output ?? '').not.toContain('OwnedWidget');
          expect(opened).not.toContain(join(view, 'component.tsx'));
        }
      } finally {
        tap.mockRestore();
      }
    }, true));
}

test('captured fetch retains the existing allowed local HTTP path and checks revocation before outward effects', async () =>
  fixture(async ({ token, view, root }) => {
    const { createFetchTool } = await import('../sdk/src/platform/tools/fetch/index.js');
    let requests = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        requests++;
        return new Response('OWNED_FETCH_BODY');
      },
    });
    let allowed = true;
    const filter = async (path: string) => allowed || path !== join(root, 'a.txt');
    const tool = capturedInputTool(createFetchTool({ isLocalhostAllowed: () => true }), token, view, filter, undefined);
    try {
      const first = await tool.execute({ urls: [{ url: `http://127.0.0.1:${server.port}/`, extract: 'raw' }] });
      expect(first.success).toBe(true);
      expect(first.output).toContain('OWNED_FETCH_BODY');
      expect(requests).toBe(1);
      await authorizeContractInputPath(token, 'a.txt', filter);
      allowed = false;
      const second = await tool.execute({ urls: [{ url: `http://127.0.0.1:${server.port}/`, extract: 'raw' }] });
      expect(second.success).toBe(false);
      expect(requests).toBe(1);
    } finally {
      server.stop(true);
    }
  }, true));

test('captured fetch cannot select local file URLs or disk output/cache paths', async () =>
  fixture(async ({ root, token, view }) => {
    const { createFetchTool } = await import('../sdk/src/platform/tools/fetch/index.js');
    const opened: string[] = [];
    const read = fs.readFileSync;
    const tap = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      opened.push(String(args[0]));
      return read(...args);
    }) as typeof fs.readFileSync);
    const tool = capturedInputTool(createFetchTool(), token, view, async () => true, undefined);
    try {
      const result = await tool.execute({
        urls: [{ url: `file://${join(view, 'a.txt')}`, extract: 'raw' }],
        output_path: join(root, 'unexpected.txt'),
        cache_path: join(root, 'unexpected-cache'),
      });
      expect(result.output ?? '').not.toContain('synthetic-owned');
      expect(opened).not.toContain(join(view, 'a.txt'));
      expect(fs.existsSync(join(root, 'unexpected.txt'))).toBe(false);
      expect(fs.existsSync(join(root, 'unexpected-cache'))).toBe(false);
    } finally {
      tap.mockRestore();
    }
  }, true));

test('captured inspector rechecks a path changed to a symlink during original permission await', async () =>
  fixture(async ({ root, token, view }) => {
    const { InspectTool } = await import('../sdk/src/platform/tools/inspect/index.js');
    writeFileSync(join(view, 'component.tsx'), 'export function AllowedWidget() { return <div/>; }');
    writeFileSync(join(view, 'denied.tsx'), 'export function PRIVATE_WIDGET_MARKER() { return <div/>; }');
    let changed = false;
    const filter = async (path: string) => {
      if (!changed && path === join(root, 'component.tsx')) {
        changed = true;
        rmSync(join(view, 'component.tsx'));
        symlinkSync('denied.tsx', join(view, 'component.tsx'));
      }
      return path !== join(root, 'denied.tsx');
    };
    const tool = capturedInputTool(new InspectTool(undefined, view), token, view, filter, undefined);
    const opened: string[] = [];
    const read = fs.readFileSync;
    const tap = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      opened.push(String(args[0]));
      return read(...args);
    }) as typeof fs.readFileSync);
    try {
      const result = await tool.execute({ mode: 'components', projectRoot: '.', file: 'component.tsx' });
      expect(result.success).toBe(false);
      expect(result.output ?? '').not.toContain('PRIVATE_WIDGET_MARKER');
      expect(opened).not.toContain(join(view, 'component.tsx'));
      expect(opened).not.toContain(join(view, 'denied.tsx'));
    } finally {
      tap.mockRestore();
    }
  }, true));

for (const scenario of ['allowed', 'denied', 'immutable', 'cancelled'] as const) {
  test(`captured inspector scaffold honors ${scenario} write authority`, async () =>
    fixture(async ({ root, view, token, abort }) => {
      const { InspectTool } = await import('../sdk/src/platform/tools/inspect/index.js');
      const target = join(view, 'src/widget/index.ts');
      const filter = async (path: string) => {
        if (scenario === 'cancelled') abort.abort();
        return scenario !== 'denied' || path !== join(root, 'src/widget/index.ts');
      };
      const tool = capturedInputTool(new InspectTool(undefined, view), token, view, filter, abort.signal);
      const result = await tool.execute({ mode: 'scaffold', projectRoot: '.', moduleName: 'Widget', dryRun: false });
      expect(result.success).toBe(scenario === 'allowed');
      expect(fs.existsSync(target)).toBe(scenario === 'allowed');
      expect(fs.existsSync(join(root, 'src/widget/index.ts'))).toBe(false);
      if (scenario === 'allowed') expect(readFileSync(target, 'utf8')).toContain("export * from './widget.js'");
    }, scenario !== 'immutable'));
}


test('per-call cancellation during final delivery reauthorization withholds actual read result', async () =>
  fixture(async ({ view, token }) => {
    const cancel = new AbortController();
    let backendDone = false;
    const filter = async () => {
      await Promise.resolve();
      if (backendDone) cancel.abort();
      return true;
    };
    const index = new ProjectIndex(view);
    const access = capturedInputReadFilter(token, view, filter, undefined, new Set());
    const read = new ReadTool(index, undefined, undefined, access);
    const observed: import('../sdk/src/platform/types/tools.js').Tool = {
      definition: read.definition,
      execute: async (args, options) => {
        const result = await read.execute(args, options);
        expect(result.success).toBe(true);
        expect(result.output).toContain('synthetic-owned');
        backendDone = true;
        return result;
      },
    };
    const guarded = capturedInputTool(observed, token, view, filter, undefined);
    try {
      const result = await guarded.execute({ files: [{ path: 'a.txt' }] }, { signal: cancel.signal });
      expect(cancel.signal.aborted).toBe(true);
      expect(result.success).toBe(false);
      expect(result.output ?? '').not.toContain('synthetic-owned');
    } finally {
      await index.dispose();
    }
  }, true));
