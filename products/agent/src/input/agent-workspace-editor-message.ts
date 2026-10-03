import { createHash } from 'node:crypto';
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
  // Privacy provenance belongs to the message's origin, not today's edited
  // form. Keep only local fingerprints of proven secret echoes for this
  // workspace lifetime, including close/reopen and editor replacement. Neither
  // these fingerprints nor secret field values enter a judgment or decision log.
  private readonly protectedMessages = new Set<string>();
  private readonly protectedSpans = new Map<number, Set<string>>();

  private fingerprint(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private isProtected(editor: AgentWorkspaceLocalEditor): boolean {
    const messageHash = this.fingerprint(editor.message);
    // A known origin is immutable: later field edits cannot remove its taint
    // or reinterpret shortened draft values as additional secret origins.
    if (this.protectedMessages.has(messageHash)) return true;
    let protectedMessage = false;
    for (const field of editor.fields) {
      if (!field.redact || !field.value || !editor.message.includes(field.value)) continue;
      const fingerprints = this.protectedSpans.get(field.value.length) ?? new Set<string>();
      fingerprints.add(this.fingerprint(field.value));
      this.protectedSpans.set(field.value.length, fingerprints);
      protectedMessage = true;
    }
    if (!protectedMessage) {
      // Exact byte-content containment is a security boundary, not a meaning
      // classifier. A rewritten message must not launder a known secret echo.
      for (const [length, fingerprints] of this.protectedSpans) {
        for (let start = 0; start + length <= editor.message.length; start++) {
          if (!fingerprints.has(this.fingerprint(editor.message.slice(start, start + length)))) continue;
          protectedMessage = true;
          break;
        }
        if (protectedMessage) break;
      }
    }
    if (protectedMessage) this.protectedMessages.add(messageHash);
    return protectedMessage;
  }
  public state: EditorMessageState = { status: 'empty', revision: 0 };

  update(editor: AgentWorkspaceLocalEditor | null, requestRender: () => void): void {
    // Typed per-field redaction declarations are security metadata, not a prose classifier.
    const protectedMessage = editor ? this.isProtected(editor) : false;
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
