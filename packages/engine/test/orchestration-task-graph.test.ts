/**
 * The task graph for an elastic workstream (orchestration/task-graph.ts), which
 * the contract runner's planned-fix groups are built with: declared edges are
 * kept, tasks that change the same file run one after another with the most
 * severe first, extra edges are added on top, and an edge that would close a
 * cycle is dropped.
 */
import { describe, expect, test } from 'bun:test';
import { ELASTIC_PHASE_CAPACITY, clusterOf, planTaskGraph, type GraphTask } from '../sdk/src/platform/orchestration/index.js';

const task = (id: string, files: string[], severity: GraphTask['severity'] = 'major', dependsOn: string[] = []): GraphTask => ({ id, title: id, task: `do ${id}`, severity, files, dependsOn });

describe('planTaskGraph', () => {
  test('same-file tasks serialize most severe first, then in the order given; other tasks stay free', () => {
    const { specs, edgeCount } = planTaskGraph([
      task('a', ['src/x.ts'], 'minor'),
      task('b', ['src/x.ts'], 'critical'),
      task('c', ['src/x.ts'], 'minor'),
      task('d', ['src/y.ts']),
    ]);
    expect(specs.map((spec) => [spec.id, spec.dependsOn])).toEqual([['a', ['b']], ['b', []], ['c', ['a']], ['d', []]]);
    expect(edgeCount).toBe(2);
    expect(specs[0]).toMatchObject({ title: 'a', task: 'do a', cluster: 'src', files: ['src/x.ts'] });
  });

  test('declared edges are kept, extra edges are added, and an edge that would close a cycle is dropped', () => {
    const { specs } = planTaskGraph(
      [task('a', ['src/x.ts'], 'major', ['b']), task('b', ['src/x.ts'], 'critical'), task('c', [])],
      () => [{ from: 'c', to: 'a' }, { from: 'b', to: 'c' }, { from: 'c', to: 'missing' }],
    );
    // a waits for b as declared (and as the shared file asks); c waits for a; b waiting for c would close b <- a <- c <- b.
    expect(specs.map((spec) => [spec.id, spec.dependsOn])).toEqual([['a', ['b']], ['b', []], ['c', ['a']]]);
  });

  test('clusters are the first path segments, and the elastic capacity leaves the fleet ceiling to limit', () => {
    expect(clusterOf(['packages/engine/src/a.ts'])).toBe('packages/engine');
    expect(clusterOf(['src/a.ts'])).toBe('src');
    expect(clusterOf([])).toBe('general');
    expect(ELASTIC_PHASE_CAPACITY).toBe(64);
  });
});
