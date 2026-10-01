import { describe, expect, test } from 'bun:test';
import {
  extractMessageId,
  extractSessionId,
  companionMessagesFromListResponse,
  companionSessionsFromListResponse,
  mergeCompanionMessages,
  mergeCompanionSessions,
} from './companion-chat';

describe('companion chat helpers', () => {
  test('extracts ids from companion chat SDK responses', () => {
    expect(extractSessionId({ sessionId: 'sess-1' })).toBe('sess-1');
    expect(extractSessionId({ session: { id: 'sess-2' } })).toBe('sess-2');
    expect(extractMessageId({ messageId: 'msg-1' })).toBe('msg-1');
    expect(extractMessageId({ message: { id: 'msg-2' } })).toBe('msg-2');
  });

  test('merges local sessions before fetched session detail arrives', () => {
    expect(mergeCompanionSessions(
      [{ id: 'new', sessionId: 'new', kind: 'companion-chat', title: 'hello', status: 'active', createdAt: 1, updatedAt: 1 }],
      [{ id: 'old', title: 'existing' }],
    ).map(extractSessionId)).toEqual(['new', 'old']);
  });

  test('normalizes companion chat session list response shapes', () => {
    expect(companionSessionsFromListResponse({ sessions: [{ sessionId: 'top' }] }).map(extractSessionId)).toEqual(['top']);
    expect(companionSessionsFromListResponse({ sessions: { items: [{ sessionId: 'nested' }] } }).map(extractSessionId)).toEqual(['nested']);
    expect(companionSessionsFromListResponse({ result: { data: [{ session: { id: 'wrapped' } }] } }).map(extractSessionId)).toEqual(['wrapped']);
  });

  test('normalizes companion chat message list response shapes', () => {
    expect(companionMessagesFromListResponse({ messages: [{ id: 'top' }] }).map(extractMessageId)).toEqual(['top']);
    expect(companionMessagesFromListResponse({ messages: { items: [{ id: 'nested' }] } }).map(extractMessageId)).toEqual(['nested']);
    expect(companionMessagesFromListResponse({ result: { data: [{ id: 'wrapped' }] } }).map(extractMessageId)).toEqual(['wrapped']);
  });

  test('merges local assistant messages until daemon messages refresh', () => {
    const messages = mergeCompanionMessages(
      [{ id: 'user-1', sessionId: 's', role: 'user', content: 'hi', createdAt: 1 }],
      [{ id: 'assistant-1', sessionId: 's', role: 'assistant', content: 'hello', createdAt: 2 }],
      's',
    );

    expect(messages.map(extractMessageId)).toEqual(['user-1', 'assistant-1']);
  });
});
