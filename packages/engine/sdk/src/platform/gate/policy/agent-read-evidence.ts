/** Pre-admission observations. Only the common autonomous owner selects a disposition. */
import type { EntryType, JudgmentPort } from '@goodvibes-jev/judgment';
import type { ToolAdmissionEvidence } from '../../tools/input-projection.js';
import type { AutonomousToolSource } from '../../permissions/autonomous.js';
import { autonomousSourceEvidence } from '../../permissions/autonomous.js';
import { sideEffect } from '../batteries/side-effect.js';
import { agentReadScope } from '../batteries/agent-read-scope.js';
import { readingState } from '../reading.js';

export async function readAgentReadEvidence(
  evidence: ToolAdmissionEvidence, source: AutonomousToolSource, port: JudgmentPort, signal?: AbortSignal,
): Promise<{ readonly allowed: boolean; readonly paths: readonly Record<string, unknown>[] }> {
  const paths: Record<string, unknown>[] = [];
  let allowed = true;
  for (const path of evidence.paths) {
    signal?.throwIfAborted();
    const secret = await sideEffect.run(port, readingState('read', { path }, evidence.root),
      { site: 'engine.gate.agent-read-secrets', only: ['secrets'], ...(signal ? { signal } : {}) });
    const aliases = Object.freeze(evidence.aliases?.filter(alias => alias.path === path || alias.target === path) ?? []);
    const scopeState = { path, aliases, workingDirectory: evidence.root, source: autonomousSourceEvidence(source) } as unknown as EntryType;
    const scope = await agentReadScope.run(port, scopeState,
      { site: 'engine.gate.agent-read-scope', only: ['platform_source', 'platform_requested'], ...(signal ? { signal } : {}) });
    signal?.throwIfAborted();
    if (!secret.result.decisionId || !scope.result.decisionId) throw new Error('Agent read evidence has no recorded provenance');
    const secrets = secret.readings.secrets;
    const platform = scope.readings.platform_source;
    const requested = scope.readings.platform_requested;
    // These are the declared non-secret and original-request scope ceilings.
    // An uncertain observation cannot expand either surface.
    const nonSecret = secrets.verdict === 'no' && secrets.outcome === 'act';
    const inScope = (platform.verdict === 'no' && platform.outcome === 'act')
      || (requested.verdict === 'yes' && requested.outcome === 'act');
    allowed &&= nonSecret && inScope;
    paths.push(Object.freeze({ path, aliases, secrets: secrets.verdict, secretsOutcome: secrets.outcome,
      platform: platform.verdict, platformOutcome: platform.outcome,
      requested: requested.verdict, requestedOutcome: requested.outcome }));
  }
  return Object.freeze({ allowed, paths: Object.freeze(paths) });
}
