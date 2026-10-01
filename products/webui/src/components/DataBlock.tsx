import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { compactJson } from '../lib/object';
import { MarkdownMessage } from './MarkdownMessage';
import { Button } from './ui/Button';
import { CodeFrame, DetailSection } from './data-view/DataView';
import { useOptionalToast } from '../lib/toast';
import '../styles/components/feedback.css';

interface DataBlockProps {
  title: string;
  value: unknown;
  empty?: string;
}

/** Copy button for the JSON <pre> branch. */
function DataBlockCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const toastCtx = useOptionalToast();

  function handleCopy(): void {
    if (!navigator.clipboard) {
      toastCtx?.toast({ title: 'Copy failed', description: 'Clipboard API unavailable', tone: 'danger', durationMs: 3000 });
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1300);
      },
      () => {
        toastCtx?.toast({ title: 'Copy failed', description: 'Could not write to clipboard', tone: 'danger', durationMs: 3000 });
      },
    );
  }

  return (
    <Button
      size="sm"
      variant="ghost"
      className="feedback-data-block__copy"
      onClick={handleCopy}
      title="Copy"
      aria-label="Copy value"
      icon={copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

export function DataBlock({ title, value, empty = 'No data' }: DataBlockProps) {
  const hasValue = value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);

  return (
    <DetailSection title={title}>
      {hasValue
        ? typeof value === 'string'
          ? <div className="feedback-data-block__markdown"><MarkdownMessage content={value} /></div>
          : (
            <div className="feedback-data-block__code">
              <DataBlockCopyButton text={compactJson(value)} />
              <CodeFrame>{compactJson(value)}</CodeFrame>
            </div>
          )
        : <p className="feedback-data-block__empty">{empty}</p>}
    </DetailSection>
  );
}
