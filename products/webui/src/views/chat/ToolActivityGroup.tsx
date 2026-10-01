/**
 * ToolActivityGroup, folds a completed turn's tool calls into the assistant
 * message that produced them, instead of letting them evaporate once the turn
 * ends (see useChatStream's toolActivityByMessageId doc comment for where the
 * data comes from and why it is only ever present for a turn this browser tab
 * watched run live).
 *
 * Every turn, one call or many, collapses to ONE line ("Read 2 files, searched
 * the web · 4 s", design doc "Chat": the same rule as the TUI, collapsed output
 * is one compact line) that expands inline to the per-call detail: the tool,
 * its key argument, and its result. Counts are real; the duration is shown
 * only when this browser timed the calls.
 */
import { ChevronRight } from 'lucide-react';
import {
  describeToolActivity,
  toolFriendlyLabel,
  toolKeyArg,
  toolResultText,
  type CompletedToolCall,
} from './message-utils';

/** Results longer than this render a truncated preview with the full text behind expand. */
const RESULT_PREVIEW_LIMIT = 240;

function ToolActivityEntry({ call }: { call: CompletedToolCall }) {
  const label = toolFriendlyLabel(call.toolName);
  const keyArg = toolKeyArg(call.toolInput);
  const resultText = toolResultText(call.result);
  const isTruncated = resultText.length > RESULT_PREVIEW_LIMIT;
  const preview = isTruncated ? `${resultText.slice(0, RESULT_PREVIEW_LIMIT)}…` : resultText;

  return (
    <li className={`message-tool-activity__item${call.isError ? ' message-tool-activity__item--error' : ''}`}>
      <div className="message-tool-activity__header">
        <span className="message-tool-activity__label">{label}</span>
        {keyArg && <span className="message-tool-activity__arg" title={keyArg}>{keyArg}</span>}
        {call.isError && <span className="message-tool-activity__error-badge">error</span>}
      </div>
      {resultText && (
        isTruncated ? (
          <details className="message-tool-activity__result">
            <summary>{preview}</summary>
            <pre>{resultText}</pre>
          </details>
        ) : (
          <pre className="message-tool-activity__result-inline">{resultText}</pre>
        )
      )}
    </li>
  );
}

export function ToolActivityGroup({ toolActivity }: { toolActivity: readonly CompletedToolCall[] }) {
  if (toolActivity.length === 0) return null;
  const hasError = toolActivity.some((call) => call.isError);
  return (
    <details className={`message-tool-activity${hasError ? ' message-tool-activity--has-error' : ''}`}>
      <summary className="message-tool-activity__summary">
        <ChevronRight size={14} aria-hidden="true" className="message-tool-activity__chevron" />
        <span className="message-tool-activity__line">{describeToolActivity(toolActivity)}</span>
      </summary>
      <ul className="message-tool-activity__list" aria-label="Tool calls">
        {toolActivity.map((call) => <ToolActivityEntry key={call.toolCallId} call={call} />)}
      </ul>
    </details>
  );
}
