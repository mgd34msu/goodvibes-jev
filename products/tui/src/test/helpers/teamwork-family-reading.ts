import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import type { ArchetypeFamily } from '@goodvibes-jev/engine/sdk/platform/agents';

export interface RecordedArchetype {
  readonly name: string;
  readonly description: string;
  readonly tools: readonly string[];
  readonly family: ArchetypeFamily | 'unknown';
}
export const recordedBuiltinArchetypes: readonly RecordedArchetype[] = [
  { name: 'orchestrator', description: 'Contract owner: represents a contract and carries its answer', tools: ['read', 'find', 'analyze', 'inspect', 'registry'], family: 'general' },
  { name: 'planner', description: 'Read-only goal-decomposition agent (no write/edit/exec/delegate)', tools: ['read', 'find', 'analyze', 'inspect'], family: 'research' },
  { name: 'engineer', description: 'Full-stack implementation agent', tools: ['read', 'write', 'edit', 'find', 'exec', 'analyze', 'inspect', 'fetch', 'registry'], family: 'implement' },
  { name: 'reviewer', description: 'Code review and quality assessment', tools: ['read', 'find', 'analyze', 'inspect', 'fetch', 'registry'], family: 'review' },
  { name: 'tester', description: 'Test writing and execution', tools: ['read', 'write', 'find', 'exec', 'analyze', 'inspect'], family: 'test' },
  { name: 'researcher', description: 'Codebase exploration and analysis', tools: ['read', 'find', 'analyze', 'inspect', 'fetch', 'registry'], family: 'research' },
  { name: 'integrator', description: 'Cross-deliverable integration agent', tools: ['read', 'write', 'edit', 'find', 'exec', 'analyze', 'inspect', 'fetch', 'registry'], family: 'implement' },
  { name: 'general', description: 'General purpose agent', tools: ['read', 'write', 'edit', 'find', 'exec', 'analyze', 'inspect', 'fetch', 'registry'], family: 'general' },
];
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

/** Every answer binds the exact declared native entry, not its name alone. */
export function recordedFamilyPort(entries: readonly RecordedArchetype[], confidence = .99) {
  return fakePort((name, question, state) => {
    const match = /^archetype(\d+)__family$/.exec(name);
    if (!match || question.type !== 'choice' || !object(state) || !Array.isArray(state.archetypes)) throw new Error('Unexpected archetype fixture request.');
    const entry: unknown = state.archetypes[Number(match[1])];
    if (!object(entry) || typeof entry.name !== 'string' || typeof entry.description !== 'string' || !Array.isArray(entry.tools)
      || Object.keys(entry).sort().join(',') !== 'description,name,tools') throw new Error('Unexpected archetype fixture evidence.');
    const expected = entries.find(candidate => candidate.name === entry.name);
    if (!expected || entry.description !== expected.description || JSON.stringify(entry.tools) !== JSON.stringify(expected.tools)
      || state.archetypes.length !== entries.length) throw new Error('Unrecorded archetype fixture evidence.');
    return choiceAnswer(question, expected.family, confidence);
  });
}
