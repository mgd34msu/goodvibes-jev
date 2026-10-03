import type { AgentWorkspaceActionResult, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';

type AgentWorkspaceFieldReader = (fieldId: string) => string;

type AgentWorkspaceSecretEditorSubmission =
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

function isAffirmative(value: string): boolean {
  return /^(y|yes|true)$/i.test(value.trim());
}

function secretScopeFlag(scope: string): string | null {
  const normalized = scope.trim().toLowerCase();
  if (normalized === 'user') return '--user';
  if (normalized === 'project') return '--project';
  return null;
}

function secretStorageFlag(storage: string): string | null {
  const normalized = storage.trim().toLowerCase();
  if (normalized === 'plaintext') return '--plaintext';
  if (normalized === 'secure') return '--secure';
  return null;
}

function appendOptionalSecretFlags(parts: string[], scope: string, storage: string): void {
  const scopeFlag = secretScopeFlag(scope);
  const storageFlag = secretStorageFlag(storage);
  if (scopeFlag) parts.push(scopeFlag);
  if (storageFlag) parts.push(storageFlag);
}

export function isAgentWorkspaceSecretEditorKind(kind: AgentWorkspaceLocalEditor['kind']): kind is 'secret-set' | 'secret-link' | 'secret-test' | 'secret-delete' {
  return kind === 'secret-set' || kind === 'secret-link' || kind === 'secret-test' || kind === 'secret-delete';
}

export function buildAgentWorkspaceSecretEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
): AgentWorkspaceSecretEditorSubmission {
  if (editor.kind === 'secret-set') {
    if (!isAffirmative(readField('confirm'))) {
      return {
        kind: 'editor',
        editor: { ...editor, message: 'Secret value storage not confirmed. Type yes, then press Enter.' },
        status: 'Secret value storage not confirmed.',
      };
    }
    const key = readField('key');
    const parts = ['/secrets', 'set', quoteSlashCommandArg(key), quoteSlashCommandArg(readField('value'))];
    appendOptionalSecretFlags(parts, readField('scope'), readField('storage'));
    parts.push('--yes');
    const redactedParts = ['/secrets', 'set', quoteSlashCommandArg(key), '<redacted>'];
    appendOptionalSecretFlags(redactedParts, readField('scope'), readField('storage'));
    redactedParts.push('--yes');
    return {
      kind: 'dispatch',
      command: parts.join(' '),
      status: 'Opening secret value storage.',
      actionResult: {
        kind: 'dispatched',
        title: 'Opening secret value storage',
        detail: 'The workspace handed a confirmed secret value storage command to the shell-owned command router without rendering the raw value.',
        command: redactedParts.join(' '),
        safety: 'safe',
      },
    };
  }
  if (editor.kind === 'secret-link') {
    if (!isAffirmative(readField('confirm'))) {
      return {
        kind: 'editor',
        editor: { ...editor, message: 'Secret reference link not confirmed. Type yes, then press Enter.' },
        status: 'Secret reference link not confirmed.',
      };
    }
    const key = readField('key');
    const parts = ['/secrets', 'link', quoteSlashCommandArg(key), quoteSlashCommandArg(readField('ref'))];
    appendOptionalSecretFlags(parts, readField('scope'), readField('storage'));
    parts.push('--yes');
    const redactedParts = ['/secrets', 'link', quoteSlashCommandArg(key), '<secret-ref>'];
    appendOptionalSecretFlags(redactedParts, readField('scope'), readField('storage'));
    redactedParts.push('--yes');
    return {
      kind: 'dispatch',
      command: parts.join(' '),
      status: 'Opening secret reference link.',
      actionResult: {
        kind: 'dispatched',
        title: 'Opening secret reference link',
        detail: 'The workspace handed a confirmed secret reference link command to the shell-owned command router without rendering the full reference.',
        command: redactedParts.join(' '),
        safety: 'safe',
      },
    };
  }
  if (editor.kind === 'secret-test') {
    if (!isAffirmative(readField('confirm'))) {
      return {
        kind: 'editor',
        editor: { ...editor, message: 'Secret reference test not confirmed. Type yes, then press Enter.' },
        status: 'Secret reference test not confirmed.',
      };
    }
    return {
      kind: 'dispatch',
      command: `/secrets test ${quoteSlashCommandArg(readField('ref'))}`,
      status: 'Opening secret reference test.',
      actionResult: {
        kind: 'dispatched',
        title: 'Opening secret reference test',
        detail: 'The workspace handed a confirmed secret reference test command to the shell-owned command router; the command output remains redacted.',
        command: '/secrets test <secret-ref>',
        safety: 'safe',
      },
    };
  }
  if (!isAffirmative(readField('confirm'))) {
    return {
      kind: 'editor',
      editor: { ...editor, message: 'Secret deletion not confirmed. Type yes, then press Enter.' },
      status: 'Secret deletion not confirmed.',
    };
  }
  const key = readField('key');
  const parts = ['/secrets', 'delete', quoteSlashCommandArg(key)];
  appendOptionalSecretFlags(parts, readField('scope'), readField('storage'));
  parts.push('--yes');
  return {
    kind: 'dispatch',
    command: parts.join(' '),
    status: 'Opening secret deletion.',
    actionResult: {
      kind: 'dispatched',
      title: 'Opening secret deletion',
      detail: 'The workspace handed a confirmed secret deletion command to the shell-owned command router.',
      command: parts.join(' '),
      safety: 'safe',
    },
  };
}
