import { describe, expect, test } from 'bun:test';
import { getNodeRuntimeBoundaryStatus, isNodeLikeRuntime } from '../sdk/src/platform/node/runtime-boundary.js';

describe('SDK runtime boundaries', () => {
  test('node runtime boundary detects node-like and non-node-like runtimes', () => {
    const nodeRuntime = {
      process: { versions: { node: '22.0.0' }, release: { name: 'node' } },
    } as Parameters<typeof getNodeRuntimeBoundaryStatus>[0];
    const browserRuntime = {} as Parameters<typeof getNodeRuntimeBoundaryStatus>[0];
    // Bun: process present but process.versions.node is undefined
    const bunRuntime = {
      process: { versions: {}, release: { name: 'bun' } },
    } as Parameters<typeof getNodeRuntimeBoundaryStatus>[0];
    // Workerd: process present with a release.name of 'workerd'
    const workerdRuntime = {
      process: { versions: {}, release: { name: 'workerd' } },
    } as Parameters<typeof getNodeRuntimeBoundaryStatus>[0];
    const nodeStatus = getNodeRuntimeBoundaryStatus(nodeRuntime);
    const browserLikeStatus = getNodeRuntimeBoundaryStatus(browserRuntime);
    const bunStatus = getNodeRuntimeBoundaryStatus(bunRuntime);
    const workerdStatus = getNodeRuntimeBoundaryStatus(workerdRuntime);

    expect(nodeStatus.nodeLike).toBe(true);
    expect(nodeStatus.hasFilesystemAssumption).toBe(true);
    expect(isNodeLikeRuntime(nodeRuntime)).toBe(true);
    expect(browserLikeStatus.nodeLike).toBe(false);
    expect(browserLikeStatus.hasFilesystemAssumption).toBe(false);
    expect(isNodeLikeRuntime(browserRuntime)).toBe(false);
    // Bun and workerd with no node version should fall back to runtimeName = 'unknown' or their release name
    expect(isNodeLikeRuntime(bunRuntime)).toBe(false);
    expect(isNodeLikeRuntime(workerdRuntime)).toBe(false);
    expect(bunStatus.nodeLike).toBe(false);
    expect(workerdStatus.nodeLike).toBe(false);
  });
});
