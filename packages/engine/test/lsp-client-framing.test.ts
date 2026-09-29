/**
 * LSP Content-Length counts bytes. A message whose body holds multi-byte
 * characters must be cut at the byte length the header gives, or the next
 * frame's bytes leak into it and both messages are lost.
 */
import { describe, expect, test } from 'bun:test';
import { LspClient } from '../sdk/src/platform/intelligence/lsp/client.ts';

describe('LSP framing by byte length', () => {
  test('two frames with non-ASCII bodies are both parsed and nothing is left over', () => {
    const first = JSON.stringify({ jsonrpc: '2.0', method: 'window/logMessage', params: { message: 'café, naïve, 日本語' } });
    const second = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { label: 'ünïcödé' } });
    const [messages, rest] = LspClient.parseMessages(LspClient.encodeFrame(first) + LspClient.encodeFrame(second));
    expect(messages).toEqual([JSON.parse(first), JSON.parse(second)]);
    expect(rest).toBe('');
  });

  test('a frame whose body has not fully arrived waits for the rest', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 2, result: 'naïve' });
    const frame = LspClient.encodeFrame(body);
    const [messages, rest] = LspClient.parseMessages(frame.slice(0, frame.length - 3));
    expect(messages).toEqual([]);
    expect(rest).toBe(frame.slice(0, frame.length - 3));
  });
});
