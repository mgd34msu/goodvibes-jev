import type { ContentPart } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { NativeConversationIntakeUnsupportedSource } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';

/** Source text is captured before trim, expansion, model directives or shell context. */
export interface NativeConversationInput {
  readonly text: string;
  readonly unsupportedSources: readonly NativeConversationIntakeUnsupportedSource[];
}
export interface ProductInputContext {
  readonly source?: NativeConversationInput;
  readonly spokenOutput?: boolean;
}

/** References are declared even when their expansion fails; they are never silent text authority. */
export function captureNativeConversationInput(text: string, content?: readonly ContentPart[]): NativeConversationInput {
  const sources: NativeConversationIntakeUnsupportedSource[] = [];
  const add = (kind: NativeConversationIntakeUnsupportedSource['kind'], label: string) => {
    sources.push({ kind, label: label.slice(0, 200) });
  };
  for (const match of text.matchAll(/\[(TEXT|IMAGE): [^\]]+\]/g)) add(match[1] === 'IMAGE' ? 'image' : 'context', match[0]);
  for (const match of text.matchAll(/(?:^|\s)(!@|@)(\S+)/g)) add(match[1] === '!@' ? 'file' : 'context', match[0].trim());
  if (content?.some(part => part.type !== 'text')) add('image', 'attached-content');
  return Object.freeze({ text, unsupportedSources: Object.freeze(sources.map(source => Object.freeze(source))) });
}
