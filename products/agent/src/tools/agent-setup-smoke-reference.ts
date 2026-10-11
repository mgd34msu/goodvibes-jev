import { ArtifactStore, type ArtifactCreateInput, type ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { lstatSync } from 'node:fs';
import { judgmentInputCardProblem, snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { assertCurrentToolEffect, assertCurrentToolExecution, assertProjectionExecution, ToolInputProjectionError, type ToolInputProjector, type ToolNativeReferencesCapture, type ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { containsIssuerCredential } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { CommandContext } from '../input/command-registry.ts';
import { captureCatalogMethods } from './agent-harness-catalog-ranking.ts';
import { captureAgentExportPath } from './agent-artifact-effect.ts';
import { MAX_SETUP_SMOKE_FIELD_CHARS, SETUP_SMOKE_EVIDENCE_FIELD_DEFINITIONS, redactSetupSmokeEvidenceFull } from './agent-harness-setup-smoke.ts';
import type { SetupSmokeArtifactStore, SetupSmokeEvidenceField } from './agent-harness-setup-posture-types.ts';

type ExecutionOptions = Parameters<Tool['execute']>[1];
interface Capture {
  readonly name: 'agent_harness' | 'setup';
  readonly context: CommandContext;
  readonly args: Record<string, unknown>;
  readonly evidence: readonly SetupSmokeEvidenceField[];
  readonly store: SetupSmokeArtifactStore | undefined;
  readonly create: SetupSmokeArtifactStore['create'];
  readonly assertCurrent: () => void;
  rawFields: Readonly<Record<string, unknown>> | undefined;
  released: boolean;
}
const captures = new WeakMap<object, Capture>();
const nativeStoragePath = Object.getOwnPropertyDescriptor(ArtifactStore.prototype, 'storagePath');

/** Safe text remains complete; redaction markers carry no replaced value. */
function evidenceParts(text: string): readonly Record<string, string>[] {
  const parts: Record<string, string>[] = [];
  const markers = /<redacted>|\[REDACTED(?:_[A-Z_]+)?\]/g;
  let cursor = 0;
  for (const match of text.matchAll(markers)) {
    if (match.index > cursor) parts.push({ kind: 'text', text: text.slice(cursor, match.index) });
    parts.push({ kind: 'redacted', marker: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ kind: 'text', text: text.slice(cursor) });
  return parts;
}

/** This source owner runs before ordinary argument privacy capture. */
export function createSetupSmokeReferenceCapture(context?: CommandContext,
  selectSetupSmoke?: (args: Readonly<Record<string, unknown>>) => boolean): NonNullable<ToolInputProjector['captureNativeReferences']> {
  const name = selectSetupSmoke ? 'setup' : 'agent_harness';
  return request => {
    if (request.name !== name || !context) return undefined;
    if (selectSetupSmoke ? !selectSetupSmoke(request.args) : request.args.mode !== 'run_setup_smoke') return undefined;
    if (!selectSetupSmoke && request.args.setupItemId !== undefined && request.args.setupItemId !== 'install-smoke') return undefined;
    const fields = request.args.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return undefined;
    const rawFields = fields as Readonly<Record<string, unknown>>;
    const selected = SETUP_SMOKE_EVIDENCE_FIELD_DEFINITIONS.filter(field => typeof rawFields[field.id] === 'string');
    if (!selected.length) return undefined;
    const signal = request.signal;
    request.assertCurrent(); request.signal?.throwIfAborted();
    // Inspect the entire source, including content after the artifact display cap
    // and cards appearing after an earlier credential. This creates no grant.
    if (judgmentInputCardProblem(request.args, request.name)) throw new ToolInputProjectionError('held');
    const assertContext = captureCatalogMethods(context, ['workspace', 'platform']);
    const platform = context.platform;
    const workspace = context.workspace;
    const assertPlatform = captureCatalogMethods(platform, ['artifactStore', 'configManager']);
    const config = platform.configManager;
    const assertConfig = captureCatalogMethods(config, ['getConfigurationIncarnation']);
    const incarnation = config.getConfigurationIncarnation();
    const assertWorkspace = workspace ? captureCatalogMethods(workspace, ['shellPaths']) : () => {};
    const paths = workspace?.shellPaths;
    const assertPaths = paths ? captureCatalogMethods(paths, ['homeDirectory', 'workingDirectory']) : () => {};
    const physicalHome = paths ? captureAgentExportPath(paths.homeDirectory, paths.homeDirectory) : undefined;
    const physicalWorkspace = paths ? captureAgentExportPath(paths.workingDirectory, paths.workingDirectory) : undefined;
    const store = (platform as { readonly artifactStore?: SetupSmokeArtifactStore }).artifactStore;
    const assertStore = store ? captureCatalogMethods(store, ['create']) : () => {};
    const create = store?.create;
    // Only the SDK's captured native getter is invoked. Custom fixture stores
    // retain their opaque identity without acquiring an invented filesystem.
    const nativeStore = store && Object.getPrototypeOf(store) === ArtifactStore.prototype ? store : undefined;
    const storeRoot = nativeStore ? nativeStoragePath?.get?.call(nativeStore) as string : undefined;
    const physicalStore = storeRoot ? captureAgentExportPath(storeRoot, storeRoot) : undefined;
    if (storeRoot && lstatSync(storeRoot).isSymbolicLink()) throw new ToolInputProjectionError('held');
    const safeFields = { ...rawFields };
    const evidence: SetupSmokeEvidenceField[] = [];
    const subjects = selected.map(definition => {
      const raw = rawFields[definition.id] as string;
      const cleared = redactSetupSmokeEvidenceFull(raw.trim());
      if (containsIssuerCredential(cleared)) throw new ToolInputProjectionError('held');
      safeFields[definition.id] = `native-smoke:${definition.id}`;
      if (cleared) evidence.push(Object.freeze({ ...definition, value: cleared.slice(0, MAX_SETUP_SMOKE_FIELD_CHARS) }));
      return { id: definition.id, label: definition.label, parts: evidenceParts(cleared) };
    });
    const safeArgs = { ...request.args, fields: safeFields, nativeReferenceSubjects: {
      kind: 'setup-smoke-evidence', purpose: 'Save redacted user-run setup smoke evidence as a local artifact.', evidence: subjects,
    } };
    // Complete safe text, every unselected caller field, and each reference still
    // cross the ordinary unchanged credential/card floor and fresh admission.
    snapshotJudgmentInput(safeArgs, request.name);
    const token = Object.freeze({});
    const capture: Capture = { name, context, args: safeArgs, evidence: Object.freeze(evidence), store, create,
      rawFields, released: false,
      assertCurrent() {
        signal?.throwIfAborted();
        assertContext(); assertPlatform(); assertConfig(); assertWorkspace(); assertPaths(); assertStore();
        physicalHome?.assertCurrent(); physicalWorkspace?.assertCurrent();
        physicalStore?.assertCurrent();
        if (nativeStore && (Object.getOwnPropertyDescriptor(ArtifactStore.prototype, 'storagePath')?.get !== nativeStoragePath?.get
          || Object.hasOwn(nativeStore, 'storagePath') || nativeStoragePath?.get?.call(nativeStore) !== storeRoot
          || (storeRoot && lstatSync(storeRoot).isSymbolicLink()))) throw new ToolInputProjectionError('stale');
        if (capture.released || context.platform !== platform || context.workspace !== workspace
          || workspace?.shellPaths !== paths || platform.configManager !== config
          || config.getConfigurationIncarnation() !== incarnation
          || (platform as { readonly artifactStore?: unknown }).artifactStore !== store) throw new ToolInputProjectionError('stale');
      },
    };
    capture.assertCurrent(); captures.set(token, capture);
    const retire = () => { capture.released = true; capture.rawFields = undefined; captures.delete(token); };
    signal?.addEventListener('abort', retire, { once: true });
    const release = async () => { signal?.removeEventListener('abort', retire); retire(); };
    return { args: safeArgs, fields: [], paths: selected.map(field => ['fields', field.id]),
      assertCurrent: capture.assertCurrent, executionContext: token, release } satisfies ToolNativeReferencesCapture;
  };
}

export interface SetupSmokeNativeEvidence {
  readonly fields: readonly SetupSmokeEvidenceField[];
  readonly assertCurrent: () => void;
  readonly createArtifact: ((input: ArtifactCreateInput) => Promise<ArtifactDescriptor>) | undefined;
}

/** Opaque strings and copied options cannot resolve the one-use native source. */
export function resolveSetupSmokeNativeEvidence(args: Record<string, unknown>, options: ExecutionOptions, context: CommandContext): SetupSmokeNativeEvidence {
  const token = options?.inputProjectionContext;
  const capture = token && captures.get(token);
  const assertCurrent = () => {
    options?.signal?.throwIfAborted();
    if (!assertCurrentToolEffect(args, options, 'write') || !assertCurrentToolEffect(args, options, 'send')) throw new ToolInputProjectionError('held');
    if (capture) {
      if (!token || capture.context !== context) throw new ToolInputProjectionError('held');
      assertProjectionExecution(token, args); capture.assertCurrent();
    }
  };
  assertCurrent();
  if (!capture) {
    // No selected output requires no private source and cannot save references.
    if (args.fields && Object.keys(args.fields as object).length) throw new ToolInputProjectionError('held');
    return { fields: [], assertCurrent, createArtifact: undefined };
  }
  return { fields: capture.evidence, assertCurrent, createArtifact: capture.create && capture.store
    ? async input => {
      assertCurrent();
      const result = await capture.create!.call(capture.store, input, { signal: options?.signal, assertCurrent });
      assertCurrent();
      return result;
    } : undefined };
}

/** Transfer only the live parent's private source into a freshly admitted child. */
export async function executeNestedSetupSmoke(registry: ToolRegistry, callId: string, args: Record<string, unknown>,
  options: ExecutionOptions, childArgs: Record<string, unknown>, context: CommandContext) {
  const ownership = resolveSetupSmokeNativeEvidence(args, options, context);
  const token = options?.inputProjectionContext;
  const capture = token && captures.get(token);
  if (childArgs.mode !== 'run_setup_smoke' || childArgs.setupItemId !== 'install-smoke'
    || childArgs.fields !== args.fields || (capture && (capture.name !== 'setup' || !capture.rawFields
      || !Object.isFrozen(capture.rawFields)))) throw new ToolInputProjectionError('held');
  const fields = capture?.rawFields;
  ownership.assertCurrent();
  // Child execution has its own async invocation context. The registry retains
  // the exact parent admission; this additional restriction owns only its
  // execution lifetime and private source, without impersonating the child.
  const assertSource = () => {
    if (!assertCurrentToolExecution(args, options)) throw new ToolInputProjectionError('held');
    if (capture) {
      if (!token || captures.get(token) !== capture || capture.rawFields !== fields) throw new ToolInputProjectionError('stale');
      assertProjectionExecution(token, args); capture.assertCurrent();
    }
  };
  const result = await registry.executeNested(callId, 'agent_harness', {
    ...childArgs, ...(fields ? { fields } : {}),
  }, options, { assertCurrent: assertSource });
  ownership.assertCurrent();
  return result;
}
