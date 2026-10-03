import { readEditorMessage, type EditorMessageReading } from '@goodvibes-jev/engine/sdk/platform/presentation/editor-message';
import type { AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';

export type EditorMessageState =
  | { readonly status: 'empty'; readonly revision: number }
  | { readonly status: 'pending' | 'unavailable' | 'protected'; readonly revision: number }
  | { readonly status: 'read' | 'uncertain'; readonly revision: number; readonly reading: EditorMessageReading };

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
  public state: EditorMessageState = { status: 'empty', revision: 0 };

  update(editor: AgentWorkspaceLocalEditor | null, requestRender: () => void): void {
    // Typed per-field redaction declarations are security metadata, not a prose classifier.
    const protectedMessage = editor?.fields.some((field) => field.redact && field.value.length > 0 && editor.message.includes(field.value)) ?? false;
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
