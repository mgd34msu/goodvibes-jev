import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'bun:test';
import { withTestTimeout } from './_helpers/test-timeout.ts';

const ENGINE_ROOT = resolve(import.meta.dir, '..');
const JUDGMENT_ROOT = resolve(ENGINE_ROOT, '../judgment');
const PUBLIC_ENTRY = '@goodvibes-jev/engine/sdk/platform/voice/wake/runtime';
const BUNDLE_CEILING_MS = 30_000;

interface BrowserSurface {
  readonly wake: typeof import('../sdk/src/platform/voice/wake/runtime.js');
  readonly display: typeof import('../sdk/src/platform/utils/batteries/display-payload.js');
  readonly retry: typeof import('../sdk/src/platform/types/batteries/retry-wait.js');
  readonly provider: typeof import('../sdk/src/platform/routing/batteries/provider.js');
  readonly judgment: typeof import('@goodvibes-jev/judgment/decisions');
}

interface BuildMetafile {
  readonly inputs: Readonly<Record<string, { readonly imports: readonly { readonly path: string; readonly external?: boolean }[] }>>;
}

/** Retain the whole public wake surface and every repaired battery, without host shims. */
async function bundleConsumer(source: boolean): Promise<BrowserSurface> {
  const dir = mkdtempSync(join(tmpdir(), 'gv-wake-browser-'));
  try {
    const scope = join(dir, 'node_modules', '@goodvibes-jev');
    mkdirSync(scope, { recursive: true });
    symlinkSync(ENGINE_ROOT, join(scope, 'engine'), 'dir');
    symlinkSync(JUDGMENT_ROOT, join(scope, 'judgment'), 'dir');
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    const entry = join(dir, 'consumer.ts');
    const battery = (path: string) => JSON.stringify(join(ENGINE_ROOT, `sdk/${source ? 'src' : 'dist'}/platform/${path}.${source ? 'ts' : 'js'}`));
    writeFileSync(entry, `
      import * as wake from '${PUBLIC_ENTRY}';
      import * as judgment from '@goodvibes-jev/judgment/decisions';
      import * as display from ${battery('utils/batteries/display-payload')};
      import * as retry from ${battery('types/batteries/retry-wait')};
      import * as provider from ${battery('routing/batteries/provider')};
      globalThis.browserSurface = { wake, judgment, display, retry, provider };
    `);
    const output = join(dir, 'consumer.js');
    const metafile = join(dir, 'metafile.json');
    const child = Bun.spawn([
      process.execPath, 'build', entry, '--target=browser', '--format=iife',
      `--outfile=${output}`, `--metafile=${metafile}`, ...(source ? ['--conditions=bun'] : []),
    ], { cwd: dir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const stdout = new Response(child.stdout).text().catch(() => '');
    const stderr = new Response(child.stderr).text().catch(() => '');
    try {
      const code = await withTestTimeout(child.exited, BUNDLE_CEILING_MS, 'wake runtime browser bundle timed out');
      expect(code, `${await stdout}\n${await stderr}`).toBe(0);
      const graph = JSON.parse(readFileSync(metafile, 'utf8')) as BuildMetafile;
      const paths = Object.keys(graph.inputs).map((path) => path.replaceAll('\\', '/'));
      const tree = source ? 'src' : 'dist';
      const extension = source ? 'ts' : 'js';
      // The package resolver really used the requested condition, and the
      // formerly leaking modules are present rather than optimized away.
      for (const suffix of [
        `sdk/${tree}/platform/voice/wake/runtime.${extension}`,
        `sdk/${tree}/platform/utils/batteries/display-payload.${extension}`,
        `sdk/${tree}/platform/types/batteries/retry-wait.${extension}`,
        `sdk/${tree}/platform/routing/batteries/provider.${extension}`,
        `judgment/${tree}/decisions.${extension}`,
      ]) expect(paths.some((path) => path.endsWith(suffix)), `missing ${suffix}`).toBe(true);
      // Inspect actual bundle inputs and their edges. schema-shared has an
      // unused edge to providers/reasoning-effort; none of that provider graph
      // may survive into the bundle, and no edge may name a host API or store.
      const edges = Object.values(graph.inputs).flatMap((input) => input.imports);
      const forbidden = /(?:^|\/)(?:node:|bun:)|sqlite|AsyncLocalStorage|judgment\/(?:src|dist)\/(?:index\.|log\/|port\/(?:client|transport|failover))|sdk\/(?:src|dist)\/platform\/logging\//;
      expect([...paths, ...edges.map((edge) => edge.path)].filter((path) => forbidden.test(path))).toEqual([]);
      expect(paths.filter((path) => /sdk\/(?:src|dist)\/platform\/providers\//.test(path))).toEqual([]);
      expect(edges.filter((edge) => edge.external)).toEqual([]);
      // A plain realm has no process, Bun, require, fetch, database or storage
      // globals. The real module initializers and exported functions run here.
      return runInNewContext(`${readFileSync(output, 'utf8')}\nbrowserSurface;`, Object.create(null), {
        timeout: 5_000,
      }) as BrowserSurface;
    } finally {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      await child.exited.catch(() => undefined);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const source of [true, false]) {
  describe(`wake browser runtime through the ${source ? 'Bun source' : 'published import'} condition`, () => {
    test('executes neutral decisions and the wake error path without a host runtime', async () => {
      const { wake, display, retry, provider, judgment } = await bundleConsumer(source);
      expect(judgment.estimateTokens('abcdefg')).toBe(3);
      expect(judgment.LIMITS.maxChoiceOptions).toBe(255);
      expect(judgment.NONE).toBe('none');
      expect(await judgment.mapLimit([3, 1, 2], 2, async (value) => value * 2)).toEqual([6, 2, 4]);
      expect(display.payloadSpans('model [gpt-4o] {"used":29870}').map((span) => span.text))
        .toEqual(['[gpt-4o]', '{"used":29870}']);
      expect(retry.numberSpans('retry after 1.5 seconds').map((span) => span.value)).toEqual([1.5]);
      expect(provider.localServerIdentity.routes).toContain('vllm');
      expect(provider.reasoningFamily.routes).toContain('deepseek-reasoner');

      // Sessions are supplied by the host by design. Exercise the real front
      // end and error formatting when one injected classifier rejects, while
      // a second classifier still produces wake detections.
      const warnings: { readonly message: string; readonly meta: Readonly<Record<string, unknown>> | undefined }[] = [];
      const embedding = {
        inputNames: ['input'], outputNames: ['embedding'],
        run: async () => ({ embedding: { data: new Float32Array(wake.WAKE_EMBED_DIM).fill(0.5), dims: [1, 1, 1, wake.WAKE_EMBED_DIM] } }),
      };
      const broken = {
        inputNames: ['input'], outputNames: ['score'],
        run: async () => { throw new Error('corrupt custom model'); },
      };
      const working = {
        inputNames: ['input'], outputNames: ['score'],
        run: async () => ({ score: { data: Float32Array.of(0.99), dims: [1, 1] } }),
      };
      const engine = new wake.WakeWordEngine({
        embedding, models: [{ id: 'broken', session: broken }, { id: 'working', session: working }],
        tuning: { threshold: 0.9, patienceFrames: 1, cooldownMs: 0 },
        now: () => 1_000,
        warn: (message, meta) => warnings.push({ message, meta }),
      });
      const detections: string[] = [];
      for (let frame = 0; frame < wake.WAKE_CLASSIFIER_FRAMES; frame += 1) {
        const result = await engine.pushFrame(new Float32Array(wake.WAKE_CHUNK_SAMPLES));
        detections.push(...result.detections.map((detection) => detection.modelId));
      }
      expect(engine.framesSeen).toBe(wake.WAKE_CLASSIFIER_FRAMES);
      expect(detections).toEqual(['working']);
      expect(warnings).toEqual([{
        message: 'wake model inference failed',
        meta: { modelId: 'broken', error: 'corrupt custom model' },
      }]);
    }, 40_000);
  });
}
