/**
 * Offline readings for the posture agreement tests. These exact calls exercise
 * the real public PermissionManager; only its judgment I/O is supplied here.
 * Unknown calls and questions fail rather than silently becoming safe.
 */
import { isDeepStrictEqual } from 'node:util';
import type { PermissionRequestAnalysis } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

type Family = NonNullable<PermissionRequestAnalysis['riskFamily']>;
const FACTS = ['mutates', 'outward', 'secrets', 'irreversible', 'beyondProject', 'weakensSecurity', 'obfuscated', 'catastrophic', 'cardDetails'] as const;
type Fact = (typeof FACTS)[number];
interface Fixture {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly family: Family;
  readonly yes: readonly Fact[];
  readonly uncertain?: readonly Fact[];
  readonly kind?: 'read';
}

export const POSTURE_CALLS = {
  read: { tool: 'read', args: { path: 'demo.ts' }, family: 'generic', yes: [] },
  secretRead: { tool: 'read', args: { path: '.env.production' }, family: 'generic', yes: ['secrets'] },
  readOnlyExec: { tool: 'exec', args: { command: 'ls' }, family: 'shell-read', yes: [] },
  unknownRead: { tool: 'notes_preview', args: { action: 'status' }, family: 'generic', kind: 'read', yes: [] },
  criticalEdit: { tool: 'write', args: { path: 'sandbox.vmBackend' }, family: 'sandbox-policy-change', yes: ['mutates', 'weakensSecurity'] },
  write: { tool: 'write', args: { path: 'demo.ts' }, family: 'file-mutation', yes: ['mutates'] },
  exec: { tool: 'exec', args: { command: 'bun run build' }, family: 'shell-mutation', yes: ['mutates'] },
  agent: { tool: 'agent', args: { mode: 'spawn', task: 'verify release' }, family: 'agent-spawn', yes: ['mutates', 'beyondProject'] },
  critical: { tool: 'exec', args: { command: 'git config core.hooksPath /dev/null' }, family: 'shell-mutation', yes: ['mutates', 'weakensSecurity'] },
  outwardUncertain: { tool: 'fetch', args: { urls: [{ url: 'https://example.test/message', method: 'POST', body: 'fixture message' }] }, family: 'network-egress', yes: ['mutates', 'outward'], uncertain: ['cardDetails'] },
  catastrophic: { tool: 'exec', args: { command: 'rm -rf /' }, family: 'shell-destructive', yes: ['mutates', 'irreversible', 'beyondProject', 'catastrophic'] },
} as const satisfies Record<string, Fixture>;

export function approvalPostureReadings() {
  return fakePort((name, question, state) => {
    const call = state as { tool?: unknown; arguments?: unknown };
    const fixture: Fixture | undefined = Object.values(POSTURE_CALLS).find((candidate) =>
      candidate.tool === call.tool && isDeepStrictEqual(candidate.args, call.arguments));
    if (!fixture) throw new Error('approval-posture: no reading for this exact tool call');
    if (name === 'kind') {
      const kinds = { read: 'read', exec: 'shell', write: 'write', fetch: 'network', agent: 'delegation', notes_preview: 'read' };
      const kind = kinds[fixture.tool as keyof typeof kinds];
      if (!kind) throw new Error('approval-posture: no kind for fixture');
      return choiceAnswer(question, kind, 0.99);
    }
    if (name === 'family') return choiceAnswer(question, fixture.family, 0.99);
    if ((FACTS as readonly string[]).includes(name)) return noulAnswer(fixture.uncertain?.includes(name as Fact) ? 0.5 : fixture.yes.includes(name as Fact) ? 0.99 : 0.01);
    throw new Error(`approval-posture: no reading for question ${name}`);
  });
}
