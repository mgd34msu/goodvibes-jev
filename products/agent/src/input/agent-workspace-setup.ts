import type { AgentBehaviorDiscoverySummary } from '../agent/behavior-discovery-summary.ts';

export type AgentWorkspaceSetupStatus = 'ready' | 'recommended' | 'optional' | 'blocked';

export interface AgentWorkspaceSetupChecklistItem {
  readonly id: string;
  readonly label: string;
  readonly status: AgentWorkspaceSetupStatus;
  readonly detail: string;
  readonly breadcrumb?: string;
}

export interface AgentWorkspaceSetupChecklistInput {
  readonly provider: string;
  readonly model: string;
  readonly runtimeBaseUrl: string;
  readonly connectedHostTokenPresent: boolean;
  readonly connectedHostTokenReadable: boolean;
  readonly connectedHostTokenPath: string;
  readonly connectedHostTokenError?: string | null;
  readonly connectedHostAuthReceiptReady?: boolean;
  readonly activeSubscriptionCount: number;
  readonly pendingSubscriptionCount: number;
  readonly availableSubscriptionProviderCount: number;
  readonly sessionMemoryCount: number;
  readonly localMemoryCount: number;
  readonly localMemoryReviewQueueCount: number;
  readonly localNoteCount: number;
  readonly localNoteReviewQueueCount: number;
  readonly routineCount: number;
  readonly enabledRoutineCount: number;
  readonly missingRoutineRequirementCount: number;
  readonly skillCount: number;
  readonly enabledSkillCount: number;
  readonly skillBundleCount: number;
  readonly enabledSkillBundleCount: number;
  readonly missingSkillRequirementCount: number;
  readonly activePersonaName: string;
  readonly discoveredPersonas: AgentBehaviorDiscoverySummary;
  readonly discoveredSkills: AgentBehaviorDiscoverySummary;
  readonly discoveredRoutines: AgentBehaviorDiscoverySummary;
  readonly readyChannelCount: number;
  readonly voiceProviderCount: number;
  readonly mediaProviderCount: number;
  readonly runtimeProfileCount: number;
  readonly runtimeStarterTemplateCount: number;
}

function setupStatusForCount(count: number, ready: AgentWorkspaceSetupStatus, empty: AgentWorkspaceSetupStatus): AgentWorkspaceSetupStatus {
  return count > 0 ? ready : empty;
}

function sampleNames(summary: AgentBehaviorDiscoverySummary): string {
  if (summary.names.length === 0) return '';
  const suffix = summary.count > summary.names.length ? `, +${summary.count - summary.names.length} more` : '';
  return ` Found: ${summary.names.join(', ')}${suffix}.`;
}

export function buildAgentWorkspaceSetupChecklist(input: AgentWorkspaceSetupChecklistInput): readonly AgentWorkspaceSetupChecklistItem[] {
  const providerReady = input.provider !== 'unknown' && input.model !== 'unknown';
  const tokenPathKnown = input.connectedHostTokenPath !== '(Agent home unavailable)';
  const connectedHostAuthReceiptReady = input.connectedHostAuthReceiptReady === true;
  const connectedHostAuthStatus: AgentWorkspaceSetupStatus = input.connectedHostTokenReadable || connectedHostAuthReceiptReady
    ? 'ready'
    : tokenPathKnown
      ? 'blocked'
      : 'recommended';
  const hasActivePersona = input.activePersonaName !== '(none)' && input.activePersonaName !== '(unavailable)';
  const discoveredBehaviorCount = input.discoveredPersonas.count + input.discoveredSkills.count + input.discoveredRoutines.count;
  return [
    {
      id: 'runtime',
      label: 'Connected host',
      status: 'ready',
      detail: `Agent will connect to ${input.runtimeBaseUrl}; protected host routes also need the Agent companion token below.`,
      breadcrumb: 'Connected Host',
    },
    {
      id: 'connected-host-auth',
      label: 'Connected-host auth',
      status: connectedHostAuthStatus,
      detail: connectedHostAuthReceiptReady
        ? `Durable connected-host auth receipt is ready${input.connectedHostTokenReadable ? ` and Agent has a readable operator token at ${input.connectedHostTokenPath}` : ''}.`
        : input.connectedHostTokenReadable
        ? `Agent has a readable connected-host operator token at ${input.connectedHostTokenPath}.`
        : input.connectedHostTokenError
          ? `The connected-host operator token exists but cannot be read at ${input.connectedHostTokenPath}. Use the confirmed setup token provisioning route, then rerun auth review.`
          : tokenPathKnown
            ? `Provision Agent's local connected-host operator token at ${input.connectedHostTokenPath} before pairing channels, Knowledge, schedules, or protected daemon routes.`
            : 'Shell paths are unavailable in this runtime, so connected-host auth cannot be verified from the workspace snapshot.',
      breadcrumb: 'Connected Host',
    },
    {
      id: 'provider-model',
      label: 'Provider and model',
      status: providerReady ? 'ready' : 'blocked',
      detail: providerReady
        ? `Current chat route is ${input.provider} / ${input.model}.`
        : 'Choose a provider and model before relying on assistant turns.',
      breadcrumb: 'Start -> Choose main model',
    },
    {
      id: 'subscriptions',
      label: 'Provider subscriptions',
      status: input.activeSubscriptionCount > 0
        ? 'ready'
        : input.pendingSubscriptionCount > 0
          ? 'recommended'
          : input.availableSubscriptionProviderCount > 0 ? 'recommended' : 'optional',
      detail: input.activeSubscriptionCount > 0
        ? `${input.activeSubscriptionCount} provider subscription session(s) are active.`
        : input.pendingSubscriptionCount > 0
          ? `${input.pendingSubscriptionCount} provider subscription login(s) are pending completion.`
          : input.availableSubscriptionProviderCount > 0
            ? `${input.availableSubscriptionProviderCount} subscription-capable provider(s) are available. Start login if you want subscription routing.`
            : 'No subscription-capable providers are available yet. Use API keys or add an OAuth provider service.',
      breadcrumb: 'Start -> Sign in to a provider',
    },
    {
      id: 'agent-knowledge',
      label: 'Agent Knowledge',
      status: 'recommended',
      detail: 'Check isolated Agent Knowledge status, then ingest source-backed material into the Agent segment only.',
      breadcrumb: 'Knowledge',
    },
    {
      id: 'profile',
      label: 'Agent profile',
      status: input.runtimeProfileCount > 0 ? 'ready' : discoveredBehaviorCount > 0 ? 'recommended' : 'optional',
      detail: input.runtimeProfileCount > 0
        ? `${input.runtimeProfileCount} isolated Agent profile(s) are available.`
        : discoveredBehaviorCount > 0
          ? `${discoveredBehaviorCount} discovered behavior file(s) can seed an isolated Agent profile from the Profiles workspace.`
        : `${input.runtimeStarterTemplateCount} starter template(s) are available if this machine needs separate operator identities.`,
      breadcrumb: 'Profiles',
    },
    {
      id: 'persona',
      label: 'Persona',
      status: hasActivePersona ? 'ready' : 'recommended',
      detail: hasActivePersona
        ? `Active persona: ${input.activePersonaName}.${input.discoveredPersonas.count > 0 ? ` ${input.discoveredPersonas.count} discovered persona file(s) are still available to import.` : ''}`
        : input.discoveredPersonas.count > 0
          ? `${input.discoveredPersonas.count} discovered persona file(s) can be imported into the Agent-local registry.${sampleNames(input.discoveredPersonas)}`
          : 'Create or choose a persona to make the assistant voice and policy explicit.',
      breadcrumb: 'Personas',
    },
    {
      id: 'skills',
      label: 'Skills',
      status: input.missingSkillRequirementCount > 0
        ? 'recommended'
        : input.enabledSkillCount > 0 || input.enabledSkillBundleCount > 0
          ? 'ready'
          : input.skillCount > 0 || input.skillBundleCount > 0 || input.discoveredSkills.count > 0
            ? 'recommended'
            : 'optional',
      detail: input.skillCount > 0 || input.skillBundleCount > 0
        ? `${input.enabledSkillCount}/${input.skillCount} local skill(s) enabled; ${input.enabledSkillBundleCount}/${input.skillBundleCount} bundle(s) enabled.${input.missingSkillRequirementCount > 0 ? ` ${input.missingSkillRequirementCount} missing setup requirement(s).` : ''}${input.discoveredSkills.count > 0 ? ` ${input.discoveredSkills.count} discovered skill file(s) are still available to import.` : ''}`
        : input.discoveredSkills.count > 0
          ? `${input.discoveredSkills.count} discovered skill file(s) can be imported as local reusable procedures.${sampleNames(input.discoveredSkills)}`
          : 'Create reusable local skills and bundles for repeated workflows.',
      breadcrumb: 'Skills',
    },
    {
      id: 'routines',
      label: 'Routines',
      status: input.missingRoutineRequirementCount > 0
        ? 'recommended'
        : setupStatusForCount(input.enabledRoutineCount, 'ready', input.routineCount > 0 || input.discoveredRoutines.count > 0 ? 'recommended' : 'optional'),
      detail: input.routineCount > 0
        ? `${input.enabledRoutineCount}/${input.routineCount} local routine(s) enabled.${input.missingRoutineRequirementCount > 0 ? ` ${input.missingRoutineRequirementCount} missing setup requirement(s).` : ''}${input.discoveredRoutines.count > 0 ? ` ${input.discoveredRoutines.count} discovered routine file(s) are still available to import.` : ''}`
        : input.discoveredRoutines.count > 0
          ? `${input.discoveredRoutines.count} discovered routine file(s) can be imported as main-conversation workflows.${sampleNames(input.discoveredRoutines)}`
          : 'Create local routines first; promote schedules only with explicit confirmation.',
      breadcrumb: 'Routines',
    },
    {
      id: 'memory',
      label: 'Local memory',
      status: setupStatusForCount(input.localMemoryCount, 'ready', 'optional'),
      detail: input.localMemoryCount > 0
        ? `${input.localMemoryCount} Agent memory record(s) are available; ${input.localMemoryReviewQueueCount} need review.`
        : 'Memory starts empty; durable facts should be stored deliberately and never include secrets.',
      breadcrumb: 'Memory',
    },
    {
      id: 'notes',
      label: 'Scratchpad notes',
      status: setupStatusForCount(input.localNoteCount, 'ready', 'optional'),
      detail: input.localNoteCount > 0
        ? `${input.localNoteCount} Agent scratchpad note(s) are available; ${input.localNoteReviewQueueCount} need review.`
        : 'Notes start empty; use them for source triage, temporary decisions, and handoff before promoting anything durable.',
      breadcrumb: 'Notes',
    },
    {
      id: 'channels',
      label: 'Channels',
      status: setupStatusForCount(input.readyChannelCount, 'ready', 'optional'),
      detail: input.readyChannelCount > 0
        ? `${input.readyChannelCount} external channel(s) are ready.`
        : 'Pair or review channels only when you want the assistant reachable outside this terminal.',
      breadcrumb: 'Messaging',
    },
    {
      id: 'voice-media',
      label: 'Voice and media',
      status: input.voiceProviderCount > 0 || input.mediaProviderCount > 0 ? 'ready' : 'optional',
      detail: `${input.voiceProviderCount} voice provider(s), ${input.mediaProviderCount} media provider(s). Configure these only when useful.`,
      breadcrumb: 'Voice & Media',
    },
  ];
}
