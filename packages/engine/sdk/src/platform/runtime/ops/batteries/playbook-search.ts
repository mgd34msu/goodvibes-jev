/**
 * `engine.ops.playbook-search`: which operational playbooks fit a symptom an
 * operator describes in their own words? The rerank pattern: one yes/no per
 * (query, playbook) pair, each in its own request, sorted by probability.
 * Candidates are the registered playbooks, rendered by playbookCandidate so
 * the fixtures and findPlaybooksBySymptom show the model the same thing.
 *
 * Band: low stakes. The result only lists runbooks for a person to read; a
 * wrong match costs a glance.
 */
import { defineRerank, STAKES_BANDS, type Candidate } from '@goodvibes-jev/judgment';
import type { Playbook } from '../types.js';
import {
  compactionFailurePlaybook,
  exportRecoveryPlaybook,
  permissionDeadlockPlaybook,
  pluginDegradationPlaybook,
  reconnectFailurePlaybook,
  sessionUnrecoverablePlaybook,
  stuckTurnPlaybook,
} from '../playbooks/index.js';

/** A playbook as the search reads it: what it addresses and the symptoms it lists. */
export function playbookCandidate(playbook: Playbook): Candidate {
  return {
    id: playbook.id,
    content: { name: playbook.name, description: playbook.description, symptoms: playbook.symptoms },
  };
}

const CANDIDATES: readonly Candidate[] = [
  stuckTurnPlaybook,
  reconnectFailurePlaybook,
  permissionDeadlockPlaybook,
  pluginDegradationPlaybook,
  exportRecoveryPlaybook,
  sessionUnrecoverablePlaybook,
  compactionFailurePlaybook,
].map(playbookCandidate);

export const playbookSearch = defineRerank({
  name: 'engine.ops.playbook-search',
  version: 1,
  description: 'Which operational playbooks address a symptom an operator describes in their own words.',
  accuracyFloor: 0.9,
  instructions: 'Is `candidate` a playbook for the problem described in `query`?',
  criteria: {
    true: 'The problem in the query is one this playbook addresses: the query describes one of its symptoms or the failure it is written for, in any wording.',
    false: 'The playbook is for a different problem, even if it mentions some of the same words.',
  },
  band: STAKES_BANDS.low.yesNo,
  fixtures: [
    {
      name: 'agent stopped making progress',
      query: 'the agent has been working on my request for ten minutes and nothing new shows up, the spinner is frozen',
      candidates: CANDIDATES,
      expect: { top: 'stuck-turn' },
    },
    {
      name: 'mcp server keeps dropping',
      query: 'our MCP server keeps disconnecting and reconnecting, tool calls say connection not available',
      candidates: CANDIDATES,
      expect: { top: 'reconnect-failure' },
    },
    {
      name: 'approval prompt ignores input',
      query: 'a tool is waiting for my approval but the approve prompt does not react when I press y, and everything else is queued behind it',
      candidates: CANDIDATES,
      expect: { top: 'permission-deadlock' },
    },
    {
      name: 'plugin tool always fails',
      query: 'every call to the jira plugin tool fails within a few milliseconds',
      candidates: CANDIDATES,
      expect: { top: 'plugin-degradation' },
    },
    {
      name: 'telemetry not arriving',
      query: 'traces are not reaching our OTLP collector and the logs say export failed permanently',
      candidates: CANDIDATES,
      expect: { top: 'export-recovery' },
    },
    {
      name: 'whole session down',
      query: 'the whole session died, there is a red system failure banner and I cannot start any new turn',
      candidates: CANDIDATES,
      expect: { top: 'session-unrecoverable' },
    },
    {
      name: 'context full and compaction erroring',
      query: 'the context window is nearly full and every compaction attempt errors out',
      candidates: CANDIDATES,
      expect: { top: 'compaction-failure' },
    },
    {
      name: 'a question no playbook covers',
      query: 'how do I switch the TUI to a light colour theme?',
      candidates: CANDIDATES,
      expect: { top: 'none' },
    },
  ],
});
