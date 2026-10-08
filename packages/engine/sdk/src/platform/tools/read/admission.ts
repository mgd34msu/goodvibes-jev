/** Read subjects belong to the real backend, not to caller-authored permission arguments. */
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { ProjectIndex } from '../../state/project-index.js';
import type { ToolExecuteOptions } from '../../types/tools.js';
import { resolveAndValidatePath } from '../../utils/path-safety.js';
import { assertProjectionExecution, ToolInputProjectionError, type ToolInputProjector } from '../input-projection.js';
import { assertCurrentToolExecution } from '../registry.js';
import { AGENT_MAX_READ_FILES } from './policy-contract.js';

interface ReadSubject {
  readonly input: string;
  readonly path: string;
  readonly canonical: string;
  readonly revision: string;
}
interface ReadCapture {
  readonly index: Pick<ProjectIndex, 'baseDir'>;
  readonly root: string;
  readonly subjects: readonly ReadSubject[];
  released: boolean;
}
const captures = new WeakMap<object, ReadCapture>();

function paths(args: Record<string, unknown>): readonly string[] {
  if (!Array.isArray(args.files) || args.files.length === 0 || args.files.length > AGENT_MAX_READ_FILES) throw new ToolInputProjectionError('invalid');
  return args.files.map(file => {
    if (!file || typeof file !== 'object' || typeof file.path !== 'string' || !file.path) throw new ToolInputProjectionError('invalid');
    return file.path;
  });
}

/** Resource identity only; no contents or credential data enter semantic evidence. */
function revision(path: string, root: string): string {
  const parents: string[] = [];
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    try {
      const stat = lstatSync(parent);
      parents.push(`${parent}:${realpathSync(parent)}:${stat.dev}:${stat.ino}:${stat.mode}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      parents.push(`${parent}:absent`);
    }
    if (parent === root || parent === dirname(parent)) break;
  }
  try {
    const link = lstatSync(path);
    const stat = statSync(path, { bigint: true });
    return JSON.stringify([parents, realpathSync(path), link.dev, link.ino, link.mode,
      String(stat.dev), String(stat.ino), String(stat.mode), String(stat.nlink), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return JSON.stringify([parents, 'absent']);
  }
}

function assertCapture(capture: ReadCapture): void {
  if (capture.released || realpathSync(resolve(capture.index.baseDir)) !== capture.root) throw new ToolInputProjectionError('stale');
  for (const subject of capture.subjects) {
    if (resolveAndValidatePath(subject.input, capture.root) !== subject.path
      || canonicalPath(subject.path) !== subject.canonical
      || revision(subject.path, capture.root) !== subject.revision) {
      throw new ToolInputProjectionError('stale');
    }
  }
}

function canonicalPath(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return path;
  }
}

/** Installed only by the Agent composition's declared read surface. Never an admission grant. */
export function createAgentReadInputProjector(index: Pick<ProjectIndex, 'baseDir'>): ToolInputProjector {
  return {
    async project(request) {
      request.assertCurrent(); request.signal?.throwIfAborted();
      const root = realpathSync(resolve(index.baseDir));
      const subjects = Object.freeze(paths(request.args).map(input => {
        const path = resolveAndValidatePath(input, root);
        return Object.freeze({ input, path, canonical: canonicalPath(path), revision: revision(path, root) });
      }));
      const capture: ReadCapture = { index, root, subjects, released: false };
      // Generated resource protocol identity, not semantic text or file bytes.
      const resourceRevision = createHash('sha256').update(JSON.stringify({ root, subjects })).digest('hex');
      const context = Object.freeze({}); captures.set(context, capture);
      return {
        status: 'projected', args: request.args, executionContext: context,
        // Both requested alias and actual target are protected semantic inputs.
        // A target hidden behind an ordinary alias must still receive its own
        // secrets and requested-platform-scope observations.
        admissionEvidence: Object.freeze({ kind: 'agent-read', root,
          paths: Object.freeze([...new Set(subjects.flatMap(subject => [subject.path, subject.canonical]))]),
          aliases: Object.freeze(subjects.filter(subject => subject.path !== subject.canonical)
            .map(subject => Object.freeze({ path: subject.path, target: subject.canonical }))), revision: resourceRevision }),
        assertCurrent: () => assertCapture(capture),
        assertRepairedArgs: args => {
          const next = paths(args);
          if (next.length !== subjects.length || next.some((path, index) => path !== subjects[index]!.input)) throw new ToolInputProjectionError('binding-changed');
          assertCapture(capture);
        },
        release: async () => { capture.released = true; captures.delete(context); },
      };
    },
  };
}

/** Adopted wrapper entry. Both resource projection and genuine admission are required. */
export function assertAdmittedAgentRead(args: Record<string, unknown>, options?: ToolExecuteOptions): void {
  const context = options?.inputProjectionContext;
  const capture = context && captures.get(context);
  if (!context || !capture || !assertCurrentToolExecution(args, options)) throw new ToolInputProjectionError('held');
  assertProjectionExecution(context, args);
  assertCapture(capture);
}

/** The actual byte-reader's guard; legacy SDK reads keep their existing owner contracts. */
export function readExecutionGuard(args: Record<string, unknown>, options: ToolExecuteOptions | undefined, index: Pick<ProjectIndex, 'baseDir'>): () => void {
  const context = options?.inputProjectionContext;
  const capture = context && captures.get(context);
  return () => {
    options?.signal?.throwIfAborted();
    assertCurrentToolExecution(args, options);
    if (capture) {
      assertAdmittedAgentRead(args, options);
      if (capture.index !== index) throw new ToolInputProjectionError('binding-changed');
    }
  };
}
