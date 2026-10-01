/**
 * ArtifactsPanel, slide-over panel for viewing message artifacts and code blocks.
 *
 * Exports:
 *   useArtifactsPanel() , returns { openArtifacts(message) }
 *
 * The panel renders:
 *   - Fenced code blocks extracted from message content (syntax-highlighted)
 *   - File/artifact attachments listed by name and type
 *
 * Usage (from MessageItem or ChatView):
 *   const { openArtifacts } = useArtifactsPanel();
 *   <button onClick={() => openArtifacts(message)}>View artifacts</button>
 *
 * Requires PeekProvider and ToastProvider in the component tree.
 */

import { useCallback, useState } from 'react';
import { Copy, Check, FileText } from 'lucide-react';
import { highlightCode } from '../../lib/highlight';
import { usePeek } from '../../components/peek/PeekPanel';
import { IconButton } from '../../components/ui/IconButton';
import { useRightPanel } from '../../components/shell/ShellContext';
import { useToast } from '../../lib/toast';
import type { ChatMessage } from './types';
import '../../styles/components/chat-artifacts.css';

// ---------------------------------------------------------------------------
// Fenced code block extraction
// ---------------------------------------------------------------------------

export interface CodeArtifact {
  language: string;
  code: string;
  index: number;
}

export interface FileArtifact {
  id: string;
  label: string;
  mimeType: string;
}

/** Extract fenced code blocks from raw markdown content. */
function extractCodeBlocks(content: string): CodeArtifact[] {
  const results: CodeArtifact[] = [];
  // Match ```lang\n...code...\n``` blocks (non-greedy)
  const fenceRe = /^```([^\n]*)\n([\s\S]*?)^```/gm;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = fenceRe.exec(content)) !== null) {
    const language = match[1].trim();
    const code = match[2];
    results.push({ language, code, index: index++ });
  }
  return results;
}

/** Normalize attachment/artifact shape from ChatMessage. */
function extractFileArtifacts(message: ChatMessage): FileArtifact[] {
  const items: FileArtifact[] = [];

  if (message.attachments) {
    for (const att of message.attachments) {
      const id =
        typeof att.artifactId === 'string'
          ? att.artifactId
          : typeof att.id === 'string'
            ? att.id
            : '';
      const label =
        typeof att.label === 'string'
          ? att.label
          : typeof att.filename === 'string'
            ? att.filename
            : typeof att.name === 'string'
              ? att.name
              : 'Attachment';
      const mimeType =
        typeof att.mimeType === 'string'
          ? att.mimeType
          : typeof att.type === 'string'
            ? att.type
            : 'application/octet-stream';
      items.push({ id, label, mimeType });
    }
  }

  if (message.artifacts) {
    for (const art of message.artifacts) {
      const id =
        typeof art.artifactId === 'string'
          ? art.artifactId
          : typeof art.id === 'string'
            ? art.id
            : '';
      const label =
        typeof art.label === 'string'
          ? art.label
          : typeof art.filename === 'string'
            ? art.filename
            : typeof art.name === 'string'
              ? art.name
              : 'Artifact';
      const mimeType =
        typeof art.mimeType === 'string'
          ? art.mimeType
          : typeof art.type === 'string'
            ? art.type
            : 'application/octet-stream';
      items.push({ id, label, mimeType });
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// ArtifactCodeBlock sub-component
// ---------------------------------------------------------------------------

interface ArtifactCodeBlockProps {
  artifact: CodeArtifact;
  onCopy: (code: string) => void;
}

function ArtifactCodeBlock({ artifact, onCopy }: ArtifactCodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const { language: lang, code } = artifact;
  const visibleCode = code.endsWith('\n') ? code.slice(0, -1) : code;
  const highlighted = highlightCode(visibleCode, lang);
  const displayLanguage = lang || highlighted.language;
  const { toast } = useToast();

  function handleCopy(): void {
    if (!navigator.clipboard) {
      toast({ title: 'Copy failed', description: 'Clipboard API unavailable', tone: 'danger', durationMs: 3000 });
      return;
    }
    navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1300);
        onCopy(code);
      },
      () => {
        toast({ title: 'Copy failed', description: 'Could not write to clipboard', tone: 'danger', durationMs: 3000 });
      },
    );
  }

  return (
    <div className="artifact-code-block">
      <div className="artifact-code-header">
        <span className="artifact-code-label">{displayLanguage || 'code'}</span>
        <IconButton
          size="sm"
          className="artifact-code-copy"
          label="Copy code"
          icon={copied ? <Check /> : <Copy />}
          tooltipPlacement="left"
          onClick={handleCopy}
        />
      </div>
      <pre className="artifact-code-pre">
        <code dangerouslySetInnerHTML={{ __html: highlighted.html }} />
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ArtifactFileItem sub-component
// ---------------------------------------------------------------------------

interface ArtifactFileItemProps {
  artifact: FileArtifact;
}

function ArtifactFileItem({ artifact }: ArtifactFileItemProps) {
  return (
    <div className="artifact-file-item">
      <FileText size={16} className="artifact-file-icon" aria-hidden="true" />
      <div className="artifact-file-info">
        <span className="artifact-file-label">{artifact.label}</span>
        {artifact.mimeType ? (
          <span className="artifact-file-mime">{artifact.mimeType}</span>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ArtifactsPanelContent, rendered inside usePeek
// ---------------------------------------------------------------------------

interface ArtifactsPanelContentProps {
  codeBlocks: CodeArtifact[];
  fileArtifacts: FileArtifact[];
  onCopy: (code: string) => void;
}

function ArtifactsPanelContent({
  codeBlocks,
  fileArtifacts,
  onCopy,
}: ArtifactsPanelContentProps) {
  const hasCode = codeBlocks.length > 0;
  const hasFiles = fileArtifacts.length > 0;
  // The artifacts panel is a large right-side panel (440 wide): while it is
  // open the sidebar folds to its icon rail so the conversation keeps its
  // width (design doc "Sidebar auto-collapse"). The peek drawer hosting it
  // announces itself too; both registrations are released on close.
  useRightPanel(true, { force: true });

  if (!hasCode && !hasFiles) {
    return (
      <div className="artifacts-empty">
        <p>No artifacts found in this message.</p>
      </div>
    );
  }

  return (
    <div className="artifacts-panel-content">
      {hasCode ? (
        <section className="artifacts-section">
          <h3 className="artifacts-section-title">Code</h3>
          <div className="artifacts-code-list">
            {codeBlocks.map((block) => (
              <ArtifactCodeBlock
                key={block.index}
                artifact={block}
                onCopy={onCopy}
              />
            ))}
          </div>
        </section>
      ) : null}
      {hasFiles ? (
        <section className="artifacts-section">
          <h3 className="artifacts-section-title">Attachments</h3>
          <div className="artifacts-file-list">
            {fileArtifacts.map((file) => (
              <ArtifactFileItem key={file.id || file.label} artifact={file} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public hook, useArtifactsPanel
// ---------------------------------------------------------------------------

/**
 * Hook that provides `openArtifacts(message)`, opens the PeekPanel
 * populated with the message's code blocks and file attachments.
 *
 * Must be used inside both PeekProvider and ToastProvider.
 *
 * @example
 *   const { openArtifacts } = useArtifactsPanel();
 *   <button onClick={() => openArtifacts(message)}>Artifacts</button>
 */
export function useArtifactsPanel(): {
  openArtifacts: (message: ChatMessage) => void;
} {
  const { open } = usePeek();
  const { toast } = useToast();

  const openArtifacts = useCallback(
    (message: ChatMessage): void => {
      const content =
        typeof message.content === 'string'
          ? message.content
          : typeof message.text === 'string'
            ? message.text
            : typeof message.body === 'string'
              ? message.body
              : '';

      const codeBlocks = extractCodeBlocks(content);
      const fileArtifacts = extractFileArtifacts(message);

      const total = codeBlocks.length + fileArtifacts.length;
      const title = total === 1 ? '1 artifact' : `${total} artifacts`;

      function handleCopy(_code: string): void {
        toast({ title: 'Copied to clipboard', tone: 'success', durationMs: 2000 });
      }

      open({
        title,
        content: (
          <ArtifactsPanelContent
            codeBlocks={codeBlocks}
            fileArtifacts={fileArtifacts}
            onCopy={handleCopy}
          />
        ),
      });
    },
    [open, toast],
  );

  return { openArtifacts };
}
