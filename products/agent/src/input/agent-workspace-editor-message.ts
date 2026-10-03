import { createHash } from 'node:crypto';
import { readEditorMessage, type EditorMessageReading } from '@goodvibes-jev/engine/sdk/platform/presentation/editor-message';
import type { AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';

export type EditorMessageState =
  | { readonly status: 'empty'; readonly revision: number }
  | { readonly status: 'pending' | 'unavailable' | 'protected'; readonly revision: number }
  | { readonly status: 'read' | 'uncertain'; readonly revision: number; readonly reading: EditorMessageReading };

interface ProtectedSpan { readonly length: number; readonly digest: string; }
interface MessageOrigin { readonly messageHash: string; readonly spans: readonly ProtectedSpan[]; }

/**
 * Owned by the input state, never by paint. Identity and relevant context bind
 * every completion; selecting a field or repainting cannot start another read.
 * Field values are deliberately excluded from judgment input. Declared secrets
 * echoed into an error are held locally using literal containment, not meaning.
 */
export class WorkspaceEditorMessage {
  private revision = 0;
  private key: string | undefined;
  private controller: AbortController | undefined;
  // Message origin is immutable while its wording is unchanged. Field edits
  // cannot make preexisting help secret-derived or make an old echo safe.
  // Only the current message lineage is held strongly. Weak associations let
  // an editor object carry its origin when reused without retaining old forms.
  private origin: MessageOrigin | undefined;
  private readonly editorOrigins = new WeakMap<AgentWorkspaceLocalEditor, MessageOrigin>();

  private fingerprint(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private contains(message: string, span: ProtectedSpan): boolean {
    for (let start = 0; start + span.length <= message.length; start++) {
      if (this.fingerprint(message.slice(start, start + span.length)) === span.digest) return true;
    }
    return false;
  }

  private messageOrigin(editor: AgentWorkspaceLocalEditor): MessageOrigin {
    const messageHash = this.fingerprint(editor.message);
    const retained = this.editorOrigins.get(editor);
    if (retained?.messageHash === messageHash) return this.origin = retained;
    if (this.origin?.messageHash === messageHash) {
      this.editorOrigins.set(editor, this.origin);
      return this.origin;
    }
    // A new message inherits only the proven origin spans it still contains.
    // A genuinely new safe message ends the previous privacy lineage. Closing
    // alone does not: a reopened/reworded current error must remain protected.
    const spans = (this.origin?.spans ?? []).filter((span) => this.contains(editor.message, span));
    for (const field of editor.fields) {
      if (!field.redact || !field.value || !editor.message.includes(field.value)) continue;
      const digest = this.fingerprint(field.value);
      if (!spans.some((span) => span.length === field.value.length && span.digest === digest)) {
        spans.push(Object.freeze({ length: field.value.length, digest }));
      }
    }
    const origin = Object.freeze({ messageHash, spans: Object.freeze(spans) });
    this.editorOrigins.set(editor, origin);
    return this.origin = origin;
  }
  public state: EditorMessageState = { status: 'empty', revision: 0 };

  update(editor: AgentWorkspaceLocalEditor | null, requestRender: () => void): void {
    // Typed per-field redaction declarations are security metadata, not a prose classifier.
    const protectedMessage = editor ? this.messageOrigin(editor).spans.length > 0 : false;
    const key = editor ? JSON.stringify([editor.kind, editor.mode, editor.recordId, editor.title, editor.message, protectedMessage]) : undefined;
    if (key === this.key) return;
    this.controller?.abort();
    this.key = key;
    const revision = ++this.revision;
    if (!editor || !editor.message) {
      this.state = { status: 'empty', revision };
      return;
    }
    if (protectedMessage) {
      this.state = { status: 'protected', revision };
      return;
    }
    const controller = this.controller = new AbortController();
    this.state = { status: 'pending', revision };
    void readEditorMessage({ message: editor.message, kind: editor.kind, mode: editor.mode }, controller.signal).then((reading) => {
      if (controller.signal.aborted || revision !== this.revision) {
        reading.recordAction('Discarded stale editor message presentation reading.');
        return;
      }
      const verdict = reading.readings.blocking;
      const settled = verdict.outcome === 'act' && verdict.verdict !== 'uncertain';
      this.state = { status: settled ? 'read' : 'uncertain', revision, reading };
      reading.recordAction(settled ? `Editor message presentation: ${verdict.verdict === 'yes' ? 'warn' : 'info'}.` : 'Editor message presentation remains uncertain; no semantic tone assigned.');
      requestRender();
    }).catch(() => {
      if (controller.signal.aborted || revision !== this.revision) return;
      this.state = { status: 'unavailable', revision };
      requestRender();
    });
  }
}
