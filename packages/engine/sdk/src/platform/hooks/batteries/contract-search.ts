/**
 * `engine.hooks.contract-search`: which hook points fit what an operator types
 * after `/hooks contracts`? The rerank pattern: one yes/no per (query, hook
 * point) pair, each in its own request. Candidates are the registered hook
 * point contracts, rendered by hookContractCandidate so the fixtures and
 * HookApi.contracts show the model the same thing.
 *
 * Replaced a substring test over the pattern, description, authority and
 * execution mode, which read "intercept mcp" as literal text and matched
 * nothing.
 *
 * Band: low stakes. The result is a listing a person reads; a wrong entry
 * costs a glance.
 */
import { defineRerank, STAKES_BANDS, type Candidate } from '@goodvibes-jev/judgment';
import { listHookPointContracts, type HookPointContract } from '../contracts.js';

/** A hook point as the search reads it: its event path, what it is for, and what a hook there may do. */
export function hookContractCandidate(contract: HookPointContract): Candidate {
  return {
    id: contract.pattern,
    content: {
      pattern: contract.pattern,
      description: contract.description,
      authority: contract.authority,
      executionMode: contract.executionMode,
    },
  };
}

const CANDIDATES: readonly Candidate[] = listHookPointContracts().map(hookContractCandidate);

export const hookContractSearch = defineRerank({
  name: 'engine.hooks.contract-search',
  version: 1,
  description: 'Which hook points match what an operator types to filter the hook contract listing.',
  accuracyFloor: 0.9,
  instructions: 'Is `candidate` a hook point the operator is looking for with `query`?',
  criteria: {
    true: 'The query names or describes this hook point: its event (tool call, file change, LLM request, MCP call, compaction, permission, lifecycle, config, budget and so on), its phase (before, after success, after failure, lifecycle, change) or what a hook there may do (intercept and block, or only observe), in any wording.',
    false: 'The hook point is for a different event or phase, even if it shares some words with the query. When the query names a specific event, such as an MCP call, a hook point for a broader event that merely includes it, such as any tool call, is not the one asked for.',
  },
  band: STAKES_BANDS.low.yesNo,
  fixtures: [
    {
      name: 'stop a tool call before it runs',
      query: 'stop a tool call before it runs',
      candidates: CANDIDATES,
      expect: { top: 'Pre:tool:*' },
    },
    {
      name: 'failed mcp calls',
      query: 'an MCP server call failed',
      candidates: CANDIDATES,
      expect: { top: 'Fail:mcp:call' },
    },
    {
      name: 'outbound model requests',
      query: 'rewrite or block requests going out to the model',
      candidates: CANDIDATES,
      expect: { top: 'Pre:llm:chat' },
    },
    {
      name: 'agent start and stop',
      query: 'when a sub-agent starts or finishes',
      candidates: CANDIDATES,
      expect: { top: 'Lifecycle:agent:*' },
    },
    {
      name: 'compaction errors',
      query: 'compaction blew up',
      candidates: CANDIDATES,
      expect: { top: 'Fail:compact:*' },
    },
    {
      name: 'spend limits',
      query: 'spending crossed a limit',
      candidates: CANDIDATES,
      expect: { top: 'Change:budget:*' },
    },
    {
      name: 'settings edited',
      query: 'someone edited the settings',
      candidates: CANDIDATES,
      expect: { top: 'Change:config:*' },
    },
    {
      name: 'approval answered',
      query: 'after the user allows or denies a tool',
      candidates: CANDIDATES,
      expect: { top: 'Post:permission:decision' },
    },
    {
      name: 'nothing about hooks',
      query: 'switch the TUI to a light colour theme',
      candidates: CANDIDATES,
      expect: { top: 'none' },
    },
  ],
});
