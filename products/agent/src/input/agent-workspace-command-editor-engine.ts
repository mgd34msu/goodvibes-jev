// Shared engine for the agent-workspace "command editor" domains (access, channel,
// knowledge, library, mcp, media, memory, operations, provider, session, skill-bundle,
// task). Every one of those domains follows the same two-stage shape: a declarative
// field-spec factory (kind -> { title, mode, message, fields }) and a submission step
// that reads the filled fields and builds a slash-command string handed to the
// shell-owned command router. This module factors that repeated structural pattern
// (the editor-construction factory, the submission dispatch/blocked-editor result
// shapes, and the handful of small helpers every domain re-implemented locally) into
// one place. Each domain keeps its own field content and command-building logic
// (real product value, not boilerplate) as entries in a `Record<Kind, ...>` table.
//
// Consolidates the ~26 near-identical editor+submission file pairs
// identified by an earlier design ruling into this engine + per-domain data tables.
import type { AgentWorkspaceActionResult, AgentWorkspaceEditorField, AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';

export type AgentWorkspaceFieldReader = (fieldId: string) => string;

/** The data shape every domain's per-kind editor literal already followed. */
export interface AgentWorkspaceEditorSpec {
  readonly mode: 'create' | 'update' | 'delete';
  readonly title: string;
  readonly message: string;
  readonly selectedFieldIndex: number;
  readonly fields: readonly AgentWorkspaceEditorField[];
}

/**
 * A table entry is either a static spec, or (for the handful of kinds whose wording
 * depends on which kind was requested, such as voice-enable/voice-disable sharing one
 * shape) a function of the kind that returns one.
 */
export type AgentWorkspaceEditorSpecEntry<K extends string> =
  | AgentWorkspaceEditorSpec
  | ((kind: K) => AgentWorkspaceEditorSpec);

export function createAgentWorkspaceEditorFromTable<K extends string>(
  kind: K,
  table: Readonly<Record<K, AgentWorkspaceEditorSpecEntry<K>>>,
): AgentWorkspaceLocalEditor {
  const entry = table[kind];
  const spec: AgentWorkspaceEditorSpec = typeof entry === 'function' ? (entry as (kind: K) => AgentWorkspaceEditorSpec)(kind) : (entry as AgentWorkspaceEditorSpec);
  return {
    kind: kind as AgentWorkspaceEditorKind,
    mode: spec.mode,
    title: spec.title,
    selectedFieldIndex: spec.selectedFieldIndex,
    message: spec.message,
    fields: spec.fields,
  };
}

export type AgentWorkspaceCommandEditorSubmission =
  | {
    readonly kind: 'editor';
    readonly editor: AgentWorkspaceLocalEditor;
    readonly status: string;
    readonly actionResult?: AgentWorkspaceActionResult;
  }
  | {
    readonly kind: 'dispatch';
    readonly command: string;
    readonly status: string;
    readonly actionResult: AgentWorkspaceActionResult;
  };

export type AgentWorkspaceCommandDispatchSafety = NonNullable<AgentWorkspaceActionResult['safety']>;

export function isAffirmative(value: string): boolean {
  return /^(y|yes|true)$/i.test(value.trim());
}

export function splitCommaList(value: string): readonly string[] {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

/** Pushes `flag, quoteSlashCommandArg(value)` onto `parts` when `value` is non-blank. */
export function appendOptionalArg(parts: string[], flag: string, value: string): void {
  if (value.trim().length > 0) parts.push(flag, quoteSlashCommandArg(value));
}

/**
 * The confirmed/dispatched result shape every domain built by hand: status is always
 * `${title}.`, and the actionResult always carries kind: 'dispatched' with the same
 * command, title, detail, and safety. Kinds whose actionResult.command legitimately
 * differs from the dispatched command (for example a redacted secret) skip this
 * helper and build the literal directly, same as before consolidation.
 */
export function dispatchCommandEditorSubmission(
  command: string,
  title: string,
  detail: string,
  safety: AgentWorkspaceCommandDispatchSafety,
): AgentWorkspaceCommandEditorSubmission {
  return {
    kind: 'dispatch',
    command,
    status: `${title}.`,
    actionResult: { kind: 'dispatched', title, detail, command, safety },
  };
}

/**
 * The "stay in the editor" result shape used for unconfirmed actions and other
 * validation failures: the editor's message is replaced with `message`, and status
 * defaults to the same text (the convention most domains used). Pass an explicit
 * `status` for the domains that show a shorter status line than the in-editor message.
 */
export function editorMessageSubmission(
  editor: AgentWorkspaceLocalEditor,
  message: string,
  status: string = message,
): AgentWorkspaceCommandEditorSubmission {
  return {
    kind: 'editor',
    editor: { ...editor, message },
    status,
  };
}

export type AgentWorkspaceCommandSubmissionHandler = (
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
) => AgentWorkspaceCommandEditorSubmission;

export function buildCommandEditorSubmissionFromTable<K extends string>(
  kind: K,
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  table: Readonly<Record<K, AgentWorkspaceCommandSubmissionHandler>>,
): AgentWorkspaceCommandEditorSubmission {
  return table[kind](editor, readField);
}
