import { readCodeLanguage, type CodeLanguageResult } from '../lib/code-language-judgment';
import { subscribeClientLifetime } from '../lib/client-lifetime';
import { isValidElement, ReactNode, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { highlightCode, normalizeLanguage } from '../lib/highlight';
import { useWebUiPreferences } from '../lib/ui-preferences';
import { IconButton } from './ui/IconButton';
import '../styles/components/markdown.css';



function codeElementFromChildren(children: ReactNode) {
  const child = Array.isArray(children) ? children[0] : children;
  return isValidElement<{ className?: string; children?: ReactNode }>(child) ? child : null;
}

function languageFromCodeChild(children: ReactNode): string {
  const child = codeElementFromChildren(children);
  if (!child) return '';
  const className = child.props.className ?? '';
  const match = /language-([\w-]+)/.exec(className);
  return match?.[1] ?? '';
}

function textFromReactNode(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textFromReactNode).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textFromReactNode(node.props.children);
  return '';
}

function codeTextFromChildren(children: ReactNode): string {
  const child = codeElementFromChildren(children);
  return textFromReactNode(child?.props.children ?? children);
}

interface MessageSource { readonly sessionId: string; readonly messageId: string }
interface CodeBlockProps {
  source?: MessageSource;
  content: string;
  start?: number;
  end?: number;
  children: ReactNode;
  lineNumbers: boolean;
}

function CodeBlock({ children, lineNumbers, source, content, start, end }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const language = languageFromCodeChild(children);
  const code = codeTextFromChildren(children);
  const visibleCode = code.endsWith('\n') ? code.slice(0, -1) : code;
  const [reading, setReading] = useState<{ signature: string; result: CodeLanguageResult }>();
  const [identityRevision, setIdentityRevision] = useState(0);
  const declaredLanguage = normalizeLanguage(language);
  const sessionId = source?.sessionId; const messageId = source?.messageId;
  const signature = JSON.stringify([sessionId, messageId, content, start, end, identityRevision]);
  useEffect(() => subscribeClientLifetime(() => { setReading(undefined); setIdentityRevision(value => value + 1); }), []);
  useEffect(() => {
    if (declaredLanguage || !sessionId || !messageId || start === undefined || end === undefined) return;
    const abort = new AbortController();
    void readCodeLanguage({ sessionId, messageId, content, start, end }, abort.signal).then(result => {
      if (!abort.signal.aborted) setReading({ signature, result });
    });
    return () => abort.abort();
  }, [declaredLanguage, sessionId, messageId, content, start, end, signature]);
  const inferredLanguage = reading?.signature === signature && reading.result.status === 'ready' && reading.result.isCurrent() ? reading.result.language : '';
  const highlighted = highlightCode(visibleCode, declaredLanguage || inferredLanguage);
  const highlightedLines = highlighted.html.split('\n');
  const displayLanguage = language || highlighted.language;

  async function copyCode() {
    if (!code) return;
    await navigator.clipboard?.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1300);
  }

  return (
    <div className={lineNumbers ? 'markdown-code-block numbered' : 'markdown-code-block'}>
      <div className="markdown-code-header">
        <div className="markdown-code-label">{displayLanguage || 'code'}</div>
        <IconButton
          className="markdown-code-copy"
          size="sm"
          label={copied ? 'Copied' : 'Copy code'}
          icon={copied ? <Check /> : <Copy />}
          tooltipPlacement="top"
          onClick={() => void copyCode()}
        />
      </div>
      {lineNumbers ? (
        <pre className="markdown-code-pre">
          <code>
            {highlightedLines.map((line, index) => (
              <span className="markdown-code-line" key={`${index}-${line}`}>
                <span className="markdown-code-line-number" aria-hidden="true">{index + 1}</span>
                <span
                  className="markdown-code-line-content"
                  dangerouslySetInnerHTML={{ __html: line || '&nbsp;' }}
                />
              </span>
            ))}
          </code>
        </pre>
      ) : (
        <pre className="markdown-code-pre">
          <code dangerouslySetInnerHTML={{ __html: highlighted.html }} />
        </pre>
      )}
    </div>
  );
}

interface MarkdownMessageProps {
  content: string;
  lineNumbers?: boolean;
  source?: MessageSource;
}

export function MarkdownMessage({ content, lineNumbers, source }: MarkdownMessageProps) {
  const [preferences] = useWebUiPreferences();
  const showLineNumbers = lineNumbers ?? preferences.codeBlockLineNumbers;

  return (
    <div className="markdown-message">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          pre: ({ children, node }) => {
            return (
              <CodeBlock lineNumbers={showLineNumbers} source={source} content={content} start={node?.position?.start.offset} end={node?.position?.end.offset}>
                {children}
              </CodeBlock>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
