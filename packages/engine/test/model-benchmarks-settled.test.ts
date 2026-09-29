/**
 * BenchmarkStore.benchmarksSettled: the route planner orders each tier's
 * candidates by the benchmark leaderboard, so the contract runner's route
 * selector waits for the leaderboard load initBenchmarks starts before it
 * picks (runtime/contract-composition.ts). The promise settles once that load
 * has put the leaderboard in the store, at once when no load was started, and
 * never rejects when the load fails.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BenchmarkStore } from '../sdk/src/platform/providers/model-benchmarks.ts';

const originalFetch = globalThis.fetch;
const dirs: string[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store(): BenchmarkStore {
  const dir = mkdtempSync(join(tmpdir(), 'benchmarks-settled-'));
  dirs.push(dir);
  return new BenchmarkStore({ dir });
}

function mockLeaderboard(respond: () => Promise<Response>): void {
  // @ts-expect-error: a test double narrower than the full fetch overload set
  globalThis.fetch = async (url: string | URL | Request) => {
    if (!String(url).includes('zeroeval')) return new Response('not found', { status: 404 });
    return respond();
  };
}

test('settles at once when no load was started', async () => {
  await store().benchmarksSettled();
});

test('settles once the load initBenchmarks started has put the leaderboard in the store', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  mockLeaderboard(async () => {
    await gate;
    return new Response(JSON.stringify([{ id: 'model-a', name: 'Model A', swe_bench_verified_score: 0.6, gpqa_score: 0.8 }]), { status: 200 });
  });
  const benchmarks = store();
  benchmarks.initBenchmarks();
  let settled = false;
  const waiting = benchmarks.benchmarksSettled().then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(settled).toBe(false);
  expect(benchmarks.getKnownBenchmarks('model-a')).toBeUndefined();
  release();
  await waiting;
  expect(benchmarks.getKnownBenchmarks('model-a')?.benchmarks).toEqual({ swe: 0.6, gpqa: 0.8 });
});

test('a failed load settles without rejecting and leaves the store empty', async () => {
  mockLeaderboard(async () => new Response('unavailable', { status: 503 }));
  const benchmarks = store();
  benchmarks.initBenchmarks();
  await benchmarks.benchmarksSettled();
  expect(benchmarks.getTopBenchmarkModelIds(5)).toEqual([]);
});
