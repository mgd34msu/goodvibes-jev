import { assertAutonomousData, captureAutonomousChoices } from '../permissions/autonomous.js';
import { captureProjectionArgs, type ProjectedToolCall, type ToolInputProjectionOptions } from '../tools/input-projection.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolCall } from '../types/tools.js';

export interface ProjectedToolBatch {
  readonly calls: ToolCall[];
  assertCurrent(): void;
  release(): Promise<void>;
}

/** Own wrapper fields as well as arguments, without inherited getters. */
export function captureToolInputCalls(incoming: readonly ToolCall[]): ToolCall[] {
  assertAutonomousData(incoming);
  if (!Array.isArray(incoming) || Object.getPrototypeOf(incoming) !== Array.prototype) throw new Error('Tool input batch is invalid');
  const entries = Object.getOwnPropertyDescriptors(incoming);
  const length = Object.getOwnPropertyDescriptor(incoming, 'length')?.value as unknown;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0
    || Reflect.ownKeys(entries).length !== length + 1) throw new Error('Tool input batch is invalid');
  const calls: ToolCall[] = [];
  for (let index = 0; index < length; index++) {
    const entry = entries[String(index)];
    if (!entry || !('value' in entry)) throw new Error('Tool input batch is invalid');
    const call: unknown = entry.value;
    if (!call || typeof call !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(call))) throw new Error('Tool input batch is invalid');
    const descriptors = Object.getOwnPropertyDescriptors(call);
    const id = descriptors['id']?.value as unknown;
    const name = descriptors['name']?.value as unknown;
    const args = descriptors['arguments']?.value as unknown;
    if (typeof id !== 'string' || typeof name !== 'string' || !descriptors['arguments'] || !('value' in descriptors['arguments'])) throw new Error('Tool input batch is invalid');
    captureAutonomousChoices({ resumeConditions: [{ id, revision: 'tool-call' }] });
    calls.push({ id, name, arguments: captureProjectionArgs(args, name) });
  }
  return calls;
}

/** Capture the whole batch before any original call reaches history or progress. */
export async function projectToolInputBatch(
  registry: ToolRegistry,
  incoming: readonly ToolCall[],
  options: ToolInputProjectionOptions = {},
): Promise<ProjectedToolBatch> {
  const captured = captureToolInputCalls(incoming);
  const projections: ProjectedToolCall[] = [];
  let released = false;
  let releasePromise: Promise<void> | undefined;
  const release = () => {
    if (releasePromise) return releasePromise;
    released = true;
    releasePromise = Promise.allSettled(projections.map(call => Promise.resolve().then(() => registry.releaseProjected(call)))).then(results => {
      if (results.some(result => result.status === 'rejected')) throw new Error('Tool input batch cleanup failed');
    });
    return releasePromise;
  };
  const assertCurrent = () => {
    if (released) throw new Error('Tool input batch was released');
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
    for (const call of projections) registry.assertProjected(call);
    options.assertCurrent?.();
    options.signal?.throwIfAborted();
    for (const call of projections) registry.assertProjectedSnapshot(call);
  };
  try {
    const calls: ToolCall[] = [];
    for (const call of captured) {
      assertCurrent();
      // Unknown tools retain the existing recoverable UnknownPreparedToolError
      // path, after complete local preflight. They have no registered projector.
      if (!registry.has(call.name)) { calls.push(Object.freeze(call)); continue; }
      const projected = await registry.projectCall(call.id, call.name, call.arguments, options);
      projections.push(projected);
      calls.push(Object.freeze({ id: projected.callId, name: projected.name, arguments: projected.args }));
    }
    assertCurrent();
    return Object.freeze({ calls: Object.freeze(calls) as unknown as ToolCall[], assertCurrent, release });
  } catch (error) {
    await release();
    throw error;
  }
}
