import { runCapabilityProbe, type ProbeContext } from './capability-probe-runner.ts';
import type {
  CapabilityDeclaration,
  CapabilityDisagreement,
  CapabilityIndexReport,
  CapabilityState,
  ResolvedCapability,
  ResolvedPrerequisite,
} from './capability-types.ts';
import { knownServiceEvidence, type KnownServiceEvidence } from './known-service-evidence.ts';

/**
 * The one authoritative index of what this agent can do right now.
 *
 * Providers register a declaration; the index resolves it against reality. It
 * never asks a list whether it is empty, and it never reads a name or a
 * description to decide what something can do.
 */

const declarations = new Map<string, CapabilityDeclaration>();

/**
 * Registration contract. Call once, at composition time, for each capability a
 * provider makes available. Re-registering the same id replaces it, so a
 * provider that reloads does not leave a stale entry behind.
 */
export function registerCapability(declaration: CapabilityDeclaration): void {
  declarations.set(declaration.id, declaration);
}

/**
 * Registers a declaration only when nothing has claimed that id yet.
 *
 * Built-in placeholders use this so a real provider, the Google connector,
 * say, can register the same id later and win, no matter which order the two
 * run in. A placeholder describes what the agent would need in order to do
 * something; a provider describes how it actually does it.
 */
export function registerFallbackCapability(declaration: CapabilityDeclaration): void {
  if (declarations.has(declaration.id)) return;
  declarations.set(declaration.id, declaration);
}

export function registeredCapabilityDeclarations(): readonly CapabilityDeclaration[] {
  return [...declarations.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function resetCapabilityIndexForTests(): void {
  declarations.clear();
}

function resolvePrerequisites(
  declaration: CapabilityDeclaration,
  context: ProbeContext,
): readonly ResolvedPrerequisite[] {
  return declaration.prerequisites.map((prerequisite) => {
    const result = runCapabilityProbe(prerequisite.probe, context);
    return {
      id: prerequisite.id,
      label: prerequisite.label,
      satisfied: result.satisfied,
      detail: result.detail,
      fix: result.satisfied ? null : prerequisite.fix,
      optional: prerequisite.optional === true,
    };
  });
}

function resolveDeclaration(declaration: CapabilityDeclaration, context: ProbeContext): ResolvedCapability {
  const prerequisites = resolvePrerequisites(declaration, context);
  const invocation = declaration.invocations.find((candidate) =>
    runCapabilityProbe(candidate.availability, context).satisfied);
  const blocking = prerequisites.filter((entry) => !entry.satisfied && !entry.optional);

  const base = {
    id: declaration.id,
    title: declaration.title,
    summary: declaration.summary,
    provider: declaration.provider,
    prerequisites,
  };

  if (!invocation) {
    // No route exists. Say which routes were declared and why none applied,
    // rather than a bare "unavailable".
    const declaredRoutes = declaration.invocations.map((entry) => entry.modelRoute);
    return {
      ...base,
      state: 'unavailable' as CapabilityState,
      modelRoute: null,
      invocationKind: null,
      reason: declaredRoutes.length === 0
        ? `No route to do this is registered in this build (declared by ${declaration.provider}).`
        : `None of the declared routes are available in this session: ${declaredRoutes.join('; ')}.`,
      fix: `Install or enable a provider for ${declaration.id}, then this becomes usable without any other change.`,
    };
  }

  if (blocking.length > 0) {
    const first = blocking[0]!;
    return {
      ...base,
      state: 'needs-setup' as CapabilityState,
      modelRoute: null,
      invocationKind: invocation.kind,
      reason: `${first.label} is missing: ${first.detail}.`,
      fix: first.fix,
    };
  }

  return {
    ...base,
    state: 'ready' as CapabilityState,
    modelRoute: invocation.modelRoute,
    invocationKind: invocation.kind,
    reason: null,
    fix: null,
  };
}

/**
 * Finds capabilities the agent is not offering while the thing they depend on
 * is sitting right there, configured.
 *
 * This is the check that would have caught the incident this module exists for:
 * Google credentials present on disk, and an agent telling its owner it could
 * not send email. A disagreement is a defect in this index, it is reported
 * loudly, never swallowed.
 */
export function detectCapabilityDisagreements(
  resolved: readonly ResolvedCapability[],
  evidence: readonly KnownServiceEvidence[],
  context: ProbeContext,
): readonly CapabilityDisagreement[] {
  const byId = new Map(resolved.map((entry) => [entry.id, entry]));
  const disagreements: CapabilityDisagreement[] = [];

  for (const service of evidence) {
    const found = service.evidence
      .map((probe) => runCapabilityProbe(probe, context))
      .filter((result) => result.satisfied)
      .map((result) => result.detail);
    if (found.length === 0) continue;

    const capability = byId.get(service.capabilityId);
    if (capability?.state === 'ready') continue;

    disagreements.push({
      capabilityId: service.capabilityId,
      title: service.title,
      reportedState: capability?.state ?? 'unavailable',
      evidence: found,
      problem: capability
        ? `${service.title} is reported as ${capability.state}, but ${service.label} is configured on this machine.`
        : `${service.label} is configured on this machine, but nothing is registered to use it, so the agent will report it cannot ${service.title.toLowerCase()}.`,
      fix: service.fix,
    });
  }

  // A registered capability that carries its own configuration evidence gets
  // the same treatment, so providers benefit from the check automatically.
  for (const capability of resolved) {
    if (capability.state === 'ready') continue;
    const declaration = declarations.get(capability.id);
    const probes = declaration?.configurationEvidence ?? [];
    if (probes.length === 0) continue;
    if (disagreements.some((entry) => entry.capabilityId === capability.id)) continue;
    const found = probes
      .map((probe) => runCapabilityProbe(probe, context))
      .filter((result) => result.satisfied)
      .map((result) => result.detail);
    if (found.length === 0) continue;
    disagreements.push({
      capabilityId: capability.id,
      title: capability.title,
      reportedState: capability.state,
      evidence: found,
      problem: `${capability.title} is reported as ${capability.state}, but its service is configured on this machine.`,
      fix: capability.fix ?? `Check the ${capability.id} provider: its prerequisites are present but the capability is not usable.`,
    });
  }

  return disagreements;
}

export interface ResolveIndexOptions {
  /** Home directory used to look for well-known service configuration. */
  readonly homeDirectory: string;
  readonly now?: () => Date;
}

export function resolveCapabilityIndex(context: ProbeContext, options: ResolveIndexOptions): CapabilityIndexReport {
  const capabilities = registeredCapabilityDeclarations()
    .map((declaration) => resolveDeclaration(declaration, context));
  const disagreements = detectCapabilityDisagreements(
    capabilities,
    knownServiceEvidence(options.homeDirectory),
    context,
  );
  const idsIn = (state: CapabilityState): readonly string[] =>
    capabilities.filter((entry) => entry.state === state).map((entry) => entry.id);
  return {
    resolvedAt: (options.now?.() ?? new Date()).toISOString(),
    capabilities,
    ready: idsIn('ready'),
    needsSetup: idsIn('needs-setup'),
    unavailable: idsIn('unavailable'),
    disagreements,
  };
}
