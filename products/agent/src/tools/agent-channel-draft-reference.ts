import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertProjectionExecution, ToolInputProjectionError, type ToolInputProjector, type ToolNativeReferencesCapture } from '@goodvibes-jev/engine/sdk/platform/tools';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { channelDraftWireReference } from '@goodvibes-jev/engine/sdk/platform/channels';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext } from '../input/command-registry.ts';
import { channelDraftFilePath, getDraft, readChannelDrafts } from '../agent/channel-draft.ts';
import { captureAgentExportPath } from './agent-artifact-effect.ts';
import { captureCatalogData, captureCatalogMethods } from './agent-harness-catalog-ranking.ts';
import { captureModelReadingSnapshotGuard } from './agent-harness-model-reading-source.ts';
import { harnessCatalogInvocationAuthority } from './agent-harness-catalog-ingress.ts';

type ExecutionOptions = Parameters<Tool['execute']>[1];
interface FileSource { readonly contents: string; readonly revision: string; }
interface Capture {
  readonly id: string;
  readonly reference: string;
  readonly path: string;
  readonly assertOwner: () => void;
  readonly assertCurrent: () => void;
  readonly initialDrafts: readonly Record<string, unknown>[];
  readonly assertPayload: (value: unknown) => void;
  source: FileSource;
  released: boolean;
}
const captures = new WeakMap<object, Capture>();
const mutableReceiptFields = new Set(['status', 'updatedAt', 'daemonSyncState', 'syncError', 'sendError', 'sentResponseId', 'origin']);
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ToolInputProjectionError('held');
  return captureCatalogData(value) as Record<string, unknown>;
};
const payload = (draft: Record<string, unknown>) => Object.fromEntries(Object.entries(draft).filter(([key]) => !mutableReceiptFields.has(key)));

function readSource(path: string): FileSource {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw new ToolInputProjectionError('held');
  const fingerprint = (stat: typeof before) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  const contents = readFileSync(path, 'utf8');
  const after = lstatSync(path, { bigint: true });
  if (fingerprint(before) !== fingerprint(after)) throw new ToolInputProjectionError('stale');
  return { contents, revision: `${fingerprint(after)}:${createHash('sha256').update(contents).digest('hex')}` };
}

/** A native store lookup binds the only rewritten field; no caller alias grants authority. */
export function createChannelDraftReferenceCapture(context?: CommandContext): NonNullable<ToolInputProjector['captureNativeReferences']> {
  return request => {
    if (request.name !== 'agent_harness' || request.args.mode !== 'channel_draft_send' || typeof request.args.draftId !== 'string') return undefined;
    if (!context) return undefined;
    const assertContext = captureCatalogMethods(context, ['workspace', 'platform']);
    const workspace = context.workspace;
    if (!workspace) return undefined;
    const assertWorkspace = captureCatalogMethods(workspace, ['shellPaths']);
    const paths = workspace?.shellPaths;
    if (!paths) return undefined;
    const assertPaths = captureCatalogMethods(paths, ['homeDirectory', 'workingDirectory', 'resolveUserPath', 'resolveProjectPath']);
    const home = paths.homeDirectory, directory = paths.workingDirectory;
    const path = channelDraftFilePath(paths);
    const physicalParent = captureAgentExportPath(home, dirname(path));
    request.assertCurrent(); request.signal?.throwIfAborted();
    let source: FileSource;
    try { source = readSource(path); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
    const parsed = record(JSON.parse(source.contents));
    if (parsed.version !== 1 || !Array.isArray(parsed.drafts)) throw new ToolInputProjectionError('held');
    const requestedId = request.args.draftId;
    const matching = parsed.drafts.map(record).filter(draft => typeof draft.id === 'string'
      && (draft.id === requestedId || channelDraftWireReference(draft.id) === requestedId));
    if (matching.length === 0) return undefined;
    if (matching.length !== 1) throw new ToolInputProjectionError('held');
    const selected = matching[0]!;
    const originalId = selected.id;
    if (typeof originalId !== 'string' || !getDraft(paths, originalId)) throw new ToolInputProjectionError('held');
    const reference = channelDraftWireReference(originalId);
    const safeArgs = { ...request.args, draftId: reference, nativeReferenceSubjects: { kind: 'channel-draft', draft: { ...selected, id: reference } } };
    // The entire selected native record and every remaining caller field cross
    // the unchanged privacy floor before ordinary projection or model lookup.
    snapshotJudgmentInput(safeArgs, request.name);
    const token = Object.freeze({});
    const assertOwner = () => {
      assertContext(); assertWorkspace(); assertPaths(); request.signal?.throwIfAborted();
      if (context.workspace !== workspace || workspace.shellPaths !== paths || paths.homeDirectory !== home || paths.workingDirectory !== directory
        || channelDraftFilePath(paths) !== path) throw new ToolInputProjectionError('stale');
      physicalParent.assertCurrent(path);
    };
    const capture: Capture = { id: originalId, reference, path, assertOwner,
      initialDrafts: readChannelDrafts(paths).drafts.map(draft => record(draft)),
      assertPayload: captureModelReadingSnapshotGuard(payload(selected)), source, released: false,
      assertCurrent() {
        assertOwner();
        if (capture.released || readSource(path).revision !== capture.source.revision) throw new ToolInputProjectionError('stale');
      },
    };
    capture.assertCurrent(); captures.set(token, capture);
    return { args: safeArgs, fields: ['draftId'], assertCurrent: capture.assertCurrent, executionContext: token,
      async release() { capture.released = true; captures.delete(token); },
    } satisfies ToolNativeReferencesCapture;
  };
}

export interface ChannelDraftNativeReference {
  readonly draftId: string;
  readonly reference: string;
  readonly preparePublication: (path: string, contents: string) => () => void;
  readonly publicText: (text: string) => string;
}

/** Only the exact current body can resolve a private native reference. */
export function resolveChannelDraftNativeReference(args: Record<string, unknown>, options: ExecutionOptions): ChannelDraftNativeReference | undefined {
  const token = options?.inputProjectionContext;
  const capture = token && captures.get(token);
  if (!capture) return undefined;
  const assertBody = () => {
    capture.assertCurrent();
    if (!token || args.draftId !== capture.reference || !harnessCatalogInvocationAuthority(args, options, 'write')) throw new ToolInputProjectionError('held');
    assertProjectionExecution(token, args);
  };
  assertBody();
  return { draftId: capture.id, reference: capture.reference, publicText: text => text.replaceAll(capture.id, capture.reference),
    preparePublication(path, contents) {
      assertBody();
      if (path !== capture.path) throw new ToolInputProjectionError('held');
      const next = record(JSON.parse(contents));
      if (next.version !== 1 || !Array.isArray(next.drafts)) throw new ToolInputProjectionError('held');
      const drafts = next.drafts.map(record);
      const selected = drafts.filter(draft => draft.id === capture.id);
      if (selected.length !== 1 || drafts.length !== capture.initialDrafts.length) throw new ToolInputProjectionError('held');
      capture.assertPayload(payload(selected[0]!));
      const otherBefore = capture.initialDrafts.filter(draft => draft.id !== capture.id);
      const otherAfter = drafts.filter(draft => draft.id !== capture.id);
      captureModelReadingSnapshotGuard(otherBefore)(otherAfter);
      snapshotJudgmentInput({ ...selected[0], id: capture.reference }, 'agent_harness');
      const previous = capture.source;
      return () => {
        capture.assertOwner();
        if (!token || capture.released || capture.source !== previous) throw new ToolInputProjectionError('stale');
        assertProjectionExecution(token, args);
        const published = readSource(path);
        if (published.contents !== contents) throw new ToolInputProjectionError('stale');
        capture.source = published;
        assertBody();
      };
    },
  };
}
