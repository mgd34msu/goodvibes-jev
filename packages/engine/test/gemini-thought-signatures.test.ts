/**
 * Gemini thinking models require each function call's thought signature to be
 * sent back with the call (and its response) on the next request. One
 * GeminiProvider serves every agent that uses Gemini at once, so signatures
 * are kept by the id of the call they came with: another agent's turn, even
 * one that ends with no tool call, never drops them, and two calls of the same
 * tool keep their own signatures. (The contract runner's live proof found two
 * units on one provider failing with "Function call is missing a
 * thought_signature" when they were kept by function name and cleared on any
 * turn without tool calls.)
 */
import { afterEach, expect, test } from 'bun:test';
import { GeminiProvider } from '../sdk/src/platform/providers/gemini.ts';
import type { ChatRequest } from '../sdk/src/platform/providers/interface.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

type Part = Record<string, unknown>;

/** Answers each request with the next scripted list of parts, as an SSE stream, and keeps each request body. */
function scriptGemini(responses: Part[][]): { readonly bodies: { contents: { role: string; parts: Part[] }[] }[] } {
  const bodies: { contents: { role: string; parts: Part[] }[] }[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const parts = responses.shift() ?? [{ text: 'done' }];
    const chunk = { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
    return new Response(`data: ${JSON.stringify(chunk)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  return { bodies };
}

function request(messages: ChatRequest['messages']): ChatRequest {
  return { model: 'gemini-3-flash-preview', messages, maxTokens: 256 };
}

test("each call's signature goes back with that call, whatever another conversation did in between", async () => {
  const { bodies } = scriptGemini([
    [{ functionCall: { name: 'read', args: { path: 'a.ts' } }, thoughtSignature: 'sig-a1' }, { functionCall: { name: 'read', args: { path: 'b.ts' } }, thoughtSignature: 'sig-a2' }],
    [{ text: 'the other conversation finished without a tool call' }],
    [{ text: 'A is done' }],
  ]);
  const provider = new GeminiProvider('key');
  const first = await provider.chat(request([{ role: 'user', content: 'read both files' }]));
  expect(first.toolCalls).toHaveLength(2);
  // Another agent on the same provider ends a turn with no tool call.
  await provider.chat(request([{ role: 'user', content: 'say hello' }]));
  const [callA, callB] = first.toolCalls;
  await provider.chat(request([
    { role: 'user', content: 'read both files' },
    { role: 'assistant', content: '', toolCalls: first.toolCalls },
    { role: 'tool', callId: callA!.id, name: 'read', content: 'A' },
    { role: 'tool', callId: callB!.id, name: 'read', content: 'B' },
  ]));
  const sent = bodies[2]!.contents;
  const modelParts = sent.find((content) => content.role === 'model')!.parts;
  expect(modelParts.map((part) => part['thoughtSignature'])).toEqual(['sig-a1', 'sig-a2']);
  const responseParts = sent.at(-1)!.parts;
  expect(responseParts.map((part) => part['thoughtSignature'])).toEqual(['sig-a1', 'sig-a2']);
});
