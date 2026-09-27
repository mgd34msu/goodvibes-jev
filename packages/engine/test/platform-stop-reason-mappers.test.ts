import { describe, it, expect } from 'bun:test';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { forgetProviderReadings } from '../sdk/src/platform/routing/provider-readings.js';
import type { ChatStopReason } from '../sdk/src/platform/providers/interface.js';
import {
  mapAnthropicStopReason,
  mapOpenAIStopReason,
  mapGeminiStopReason,
  mapLlamaCppStopReason,
  readOllamaStopReason,
  mapCodexStopReason,
  mapLmStudioStopReason,
  isContextOverflowSignal,
} from '../sdk/src/platform/providers/stop-reason-maps.js';

// ---------------------------------------------------------------------------
// Tests, Anthropic
// ---------------------------------------------------------------------------

describe('Anthropic stop reason mapper', () => {
  it('maps end_turn → completed', () => {
    expect(mapAnthropicStopReason('end_turn')).toBe<ChatStopReason>('completed');
  });
  it('maps max_tokens → max_tokens', () => {
    expect(mapAnthropicStopReason('max_tokens')).toBe<ChatStopReason>('max_tokens');
  });
  it('maps tool_use → tool_call', () => {
    expect(mapAnthropicStopReason('tool_use')).toBe<ChatStopReason>('tool_call');
  });
  it('maps stop_sequence → stop_sequence', () => {
    expect(mapAnthropicStopReason('stop_sequence')).toBe<ChatStopReason>('stop_sequence');
  });
  it('falls through to unknown for unmapped values', () => {
    expect(mapAnthropicStopReason('some_future_reason')).toBe<ChatStopReason>('unknown');
  });
  it('returns unknown for null', () => {
    expect(mapAnthropicStopReason(null)).toBe<ChatStopReason>('unknown');
  });
  it('returns unknown for undefined', () => {
    expect(mapAnthropicStopReason(undefined)).toBe<ChatStopReason>('unknown');
  });
  it('returns unknown for empty string', () => {
    expect(mapAnthropicStopReason('')).toBe<ChatStopReason>('unknown');
  });
  it('maps model_context_window_exceeded → context_overflow', () => {
    expect(mapAnthropicStopReason('model_context_window_exceeded')).toBe<ChatStopReason>('context_overflow');
  });
});

// ---------------------------------------------------------------------------
// Tests, context-overflow warning signal
// ---------------------------------------------------------------------------

describe('isContextOverflowSignal', () => {
  it('true for the normalized context_overflow stop reason', () => {
    expect(isContextOverflowSignal('context_overflow')).toBe(true);
  });
  it('true for raw model_context_window_exceeded even when normalized is unknown', () => {
    expect(isContextOverflowSignal('unknown', 'model_context_window_exceeded')).toBe(true);
  });
  it('true for raw context_length_exceeded (openai-compatible servers)', () => {
    expect(isContextOverflowSignal('unknown', 'context_length_exceeded')).toBe(true);
  });
  it('false for completed with an ordinary raw reason', () => {
    expect(isContextOverflowSignal('completed', 'end_turn')).toBe(false);
  });
  it('false for max_tokens: output cap is not a context warning', () => {
    expect(isContextOverflowSignal('max_tokens', 'max_tokens')).toBe(false);
  });
  it('false when no raw reason is provided and normalized is not overflow', () => {
    expect(isContextOverflowSignal('unknown')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests, OpenAI
// ---------------------------------------------------------------------------

describe('OpenAI stop reason mapper', () => {
  it('maps stop → completed', () => {
    expect(mapOpenAIStopReason('stop')).toBe<ChatStopReason>('completed');
  });
  it('maps length → max_tokens', () => {
    expect(mapOpenAIStopReason('length')).toBe<ChatStopReason>('max_tokens');
  });
  it('maps tool_calls → tool_call', () => {
    expect(mapOpenAIStopReason('tool_calls')).toBe<ChatStopReason>('tool_call');
  });
  it('maps content_filter → content_filter', () => {
    expect(mapOpenAIStopReason('content_filter')).toBe<ChatStopReason>('content_filter');
  });
  it('maps function_call → tool_call', () => {
    expect(mapOpenAIStopReason('function_call')).toBe<ChatStopReason>('tool_call');
  });
  it('falls through to unknown for unmapped values', () => {
    expect(mapOpenAIStopReason('some_future_reason')).toBe<ChatStopReason>('unknown');
  });
  it('returns unknown for null', () => {
    expect(mapOpenAIStopReason(null)).toBe<ChatStopReason>('unknown');
  });
  it('returns unknown for undefined', () => {
    expect(mapOpenAIStopReason(undefined)).toBe<ChatStopReason>('unknown');
  });
  it('returns unknown for empty string', () => {
    expect(mapOpenAIStopReason('')).toBe<ChatStopReason>('unknown');
  });
});

// ---------------------------------------------------------------------------
// Tests, Gemini
// ---------------------------------------------------------------------------

describe('Gemini stop reason mapper', () => {
  it('maps STOP → completed', () => {
    expect(mapGeminiStopReason('STOP')).toBe<ChatStopReason>('completed');
  });
  it('maps MAX_TOKENS → max_tokens', () => {
    expect(mapGeminiStopReason('MAX_TOKENS')).toBe<ChatStopReason>('max_tokens');
  });
  it('maps SAFETY → content_filter', () => {
    expect(mapGeminiStopReason('SAFETY')).toBe<ChatStopReason>('content_filter');
  });
  it('maps RECITATION → content_filter', () => {
    expect(mapGeminiStopReason('RECITATION')).toBe<ChatStopReason>('content_filter');
  });
  it('maps OTHER → unknown', () => {
    expect(mapGeminiStopReason('OTHER')).toBe<ChatStopReason>('unknown');
  });
  it('maps BLOCKLIST → content_filter', () => {
    expect(mapGeminiStopReason('BLOCKLIST')).toBe<ChatStopReason>('content_filter');
  });
  it('maps PROHIBITED_CONTENT → content_filter', () => {
    expect(mapGeminiStopReason('PROHIBITED_CONTENT')).toBe<ChatStopReason>('content_filter');
  });
  it('maps SPII → content_filter', () => {
    expect(mapGeminiStopReason('SPII')).toBe<ChatStopReason>('content_filter');
  });
  it('maps MALFORMED_FUNCTION_CALL → unknown', () => {
    expect(mapGeminiStopReason('MALFORMED_FUNCTION_CALL')).toBe<ChatStopReason>('unknown');
  });
  it('falls through to unknown for unmapped values', () => {
    expect(mapGeminiStopReason('SOME_FUTURE_REASON')).toBe<ChatStopReason>('unknown');
  });
  it('returns unknown for null', () => {
    expect(mapGeminiStopReason(null)).toBe<ChatStopReason>('unknown');
  });
  it('returns unknown for undefined', () => {
    expect(mapGeminiStopReason(undefined)).toBe<ChatStopReason>('unknown');
  });
});

// ---------------------------------------------------------------------------
// Tests, llama.cpp
// ---------------------------------------------------------------------------

describe('llama.cpp stop reason mapper', () => {
  it('maps hasToolCalls=true → tool_call (regardless of finish_reason)', () => {
    expect(mapLlamaCppStopReason('stop', true)).toBe<ChatStopReason>('tool_call');
    expect(mapLlamaCppStopReason(null, true)).toBe<ChatStopReason>('tool_call');
  });
  it('maps tool_calls → tool_call', () => {
    expect(mapLlamaCppStopReason('tool_calls', false)).toBe<ChatStopReason>('tool_call');
  });
  it('maps length → max_tokens', () => {
    expect(mapLlamaCppStopReason('length', false)).toBe<ChatStopReason>('max_tokens');
  });
  it('maps stop (no tools) → completed', () => {
    expect(mapLlamaCppStopReason('stop', false)).toBe<ChatStopReason>('completed');
  });
  it('maps null (no tools) → completed', () => {
    expect(mapLlamaCppStopReason(null, false)).toBe<ChatStopReason>('completed');
  });
});

// ---------------------------------------------------------------------------
// Tests, Ollama
// ---------------------------------------------------------------------------

describe('Ollama stop reason mapper', () => {
  it('maps hasToolCalls=true to tool_call', async () => {
    expect(await readOllamaStopReason('stop', true, 'test')).toBe<ChatStopReason>('tool_call');
  });
  it('maps both documented tool-call spellings to tool_call', async () => {
    expect(await readOllamaStopReason('tool-calls', false, 'test')).toBe<ChatStopReason>('tool_call');
    expect(await readOllamaStopReason('tool_calls', false, 'test')).toBe<ChatStopReason>('tool_call');
  });
  it('maps length and max_tokens to max_tokens', async () => {
    expect(await readOllamaStopReason('length', false, 'test')).toBe<ChatStopReason>('max_tokens');
    expect(await readOllamaStopReason('max_tokens', false, 'test')).toBe<ChatStopReason>('max_tokens');
  });
  it('maps stop, load and unload to completed with no reading', async () => {
    expect(await readOllamaStopReason('stop', false, 'test')).toBe<ChatStopReason>('completed');
    expect(await readOllamaStopReason('unload', false, 'test')).toBe<ChatStopReason>('completed');
  });
  it('reads an unfamiliar done_reason once', async () => {
    forgetProviderReadings();
    const { port, requests } = fakePort((_name, question) => choiceAnswer(question, 'max_tokens', 0.95));
    const previous = installJudgmentPort(port);
    try {
      expect(await readOllamaStopReason('context_full', false, 'test')).toBe<ChatStopReason>('max_tokens');
      expect(await readOllamaStopReason('context_full', false, 'test')).toBe<ChatStopReason>('max_tokens');
      expect(requests).toHaveLength(1);
    } finally {
      installJudgmentPort(previous);
      forgetProviderReadings();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests, OpenAI Codex (responses API)
// ---------------------------------------------------------------------------

describe('OpenAI Codex stop reason mapper', () => {
  it('maps completed + tool calls → tool_call', () => {
    expect(mapCodexStopReason('completed', true)).toBe<ChatStopReason>('tool_call');
  });
  it('maps completed + no tool calls → completed', () => {
    expect(mapCodexStopReason('completed', false)).toBe<ChatStopReason>('completed');
  });
  it('maps incomplete → max_tokens', () => {
    expect(mapCodexStopReason('incomplete', false)).toBe<ChatStopReason>('max_tokens');
  });
  it('maps failed → error', () => {
    expect(mapCodexStopReason('failed', false)).toBe<ChatStopReason>('error');
  });
  it('maps cancelled → error', () => {
    expect(mapCodexStopReason('cancelled', false)).toBe<ChatStopReason>('error');
  });
  it('maps undefined → completed', () => {
    expect(mapCodexStopReason(undefined, false)).toBe<ChatStopReason>('completed');
  });
});

// ---------------------------------------------------------------------------
// Tests, LM Studio (responses API)
// ---------------------------------------------------------------------------

describe('LM Studio stop reason mapper', () => {
  it('maps completed + tool calls → tool_call', () => {
    expect(mapLmStudioStopReason('completed', true)).toBe<ChatStopReason>('tool_call');
  });
  it('maps completed + no tool calls → completed', () => {
    expect(mapLmStudioStopReason('completed', false)).toBe<ChatStopReason>('completed');
  });
  it('maps incomplete → max_tokens', () => {
    expect(mapLmStudioStopReason('incomplete', false)).toBe<ChatStopReason>('max_tokens');
  });
  it('maps failed → error', () => {
    expect(mapLmStudioStopReason('failed', false)).toBe<ChatStopReason>('error');
  });
  it('maps undefined → completed', () => {
    expect(mapLmStudioStopReason(undefined, false)).toBe<ChatStopReason>('completed');
  });
});

// ---------------------------------------------------------------------------
// Integration, llama.cpp provider wiring
// ---------------------------------------------------------------------------

describe('llama.cpp provider stop-reason wiring', () => {
  it('tool_calls finish_reason → tool_call stopReason', () => {
    // Simulates: choice.finish_reason='tool_calls', no accumulated tool calls
    expect(mapLlamaCppStopReason('tool_calls', false)).toBe<ChatStopReason>('tool_call');
  });

  it('accumulated tool calls → tool_call stopReason regardless of finish_reason', () => {
    expect(mapLlamaCppStopReason('stop', true)).toBe<ChatStopReason>('tool_call');
  });

  it('length finish_reason → max_tokens stopReason', () => {
    expect(mapLlamaCppStopReason('length', false)).toBe<ChatStopReason>('max_tokens');
  });

  it('stop finish_reason → completed stopReason', () => {
    expect(mapLlamaCppStopReason('stop', false)).toBe<ChatStopReason>('completed');
  });
});

// ---------------------------------------------------------------------------
// Integration, OpenAI Codex provider wiring
// ---------------------------------------------------------------------------

describe('OpenAI Codex provider stop-reason wiring', () => {
  it('response.completed with tool calls → tool_call stopReason', () => {
    // Simulates: status='completed', resolvedToolCalls.length > 0
    expect(mapCodexStopReason('completed', true)).toBe<ChatStopReason>('tool_call');
  });

  it('response.completed with no tool calls → completed stopReason', () => {
    expect(mapCodexStopReason('completed', false)).toBe<ChatStopReason>('completed');
  });

  it('response.incomplete → max_tokens stopReason', () => {
    expect(mapCodexStopReason('incomplete', false)).toBe<ChatStopReason>('max_tokens');
  });

  it('response.failed → error stopReason', () => {
    expect(mapCodexStopReason('failed', false)).toBe<ChatStopReason>('error');
  });

  it('response.cancelled → error stopReason', () => {
    expect(mapCodexStopReason('cancelled', false)).toBe<ChatStopReason>('error');
  });
});

// ---------------------------------------------------------------------------
// Integration, LM Studio provider wiring
// ---------------------------------------------------------------------------

describe('LM Studio provider stop-reason wiring', () => {
  it('response.completed with tool calls → tool_call stopReason', () => {
    // Simulates: status='completed', resolvedToolCalls.length > 0
    expect(mapLmStudioStopReason('completed', true)).toBe<ChatStopReason>('tool_call');
  });

  it('response.completed with no tool calls → completed stopReason', () => {
    expect(mapLmStudioStopReason('completed', false)).toBe<ChatStopReason>('completed');
  });

  it('response.incomplete → max_tokens stopReason', () => {
    expect(mapLmStudioStopReason('incomplete', false)).toBe<ChatStopReason>('max_tokens');
  });

  it('response.failed → error stopReason', () => {
    expect(mapLmStudioStopReason('failed', false)).toBe<ChatStopReason>('error');
  });
});

// ---------------------------------------------------------------------------
// ChatStopReason type exhaustiveness
// ---------------------------------------------------------------------------

describe('ChatStopReason type exhaustiveness', () => {
  it('all canonical values are valid ChatStopReason literals', () => {
    const allValues: ChatStopReason[] = [
      'completed',
      'max_tokens',
      'tool_call',
      'stop_sequence',
      'content_filter',
      'error',
      'unknown',
    ];
    // Every value round-trips through a type-safe assignment
    for (const v of allValues) {
      const r: ChatStopReason = v;
      expect(typeof r).toBe('string');
    }
    expect(allValues).toHaveLength(7);
  });
});
