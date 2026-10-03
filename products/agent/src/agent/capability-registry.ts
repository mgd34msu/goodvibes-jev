/**
 * Capability readiness registry, the single source of truth for how mature
 * each advertised capability is.
 *
 * The agent advertises capabilities (voice, deep research, computer control,
 * calendar, email, telephony, local models, and more) whose real maturity
 * varies. This registry records, for every advertised capability, a declared
 * readiness level that must be verifiable rather than aspirational.
 *
 * LEVELS (and nothing else):
 *   - `certified`   A live-verification scenario exercises the capability and
 *                   passed in the current release report. Each certified entry
 *                   names the scenario id it maps to (see live-verifier.ts).
 *   - `working`     Implemented and covered by unit/integration tests, but no
 *                   live-verification scenario exercises it yet.
 *   - `needs-setup` Implemented, but the user must configure something
 *                   (credentials, a provider, a device) before it can run.
 *   - `preview`     Partial implementation. The note states plainly what works.
 *
 * A capability that would only be "planning-only" is NOT given a level here,
 * it is removed from advertised surfaces instead, consistent with the honesty
 * bar. So every entry below has a real, shipped surface behind it.
 *
 * Onboarding copy, help text, and the tool catalogs render the level FROM this
 * registry (see renderCapabilityReadinessLine). No surface hand-writes a
 * duplicate maturity claim.
 */

export type CapabilityReadinessLevel = 'certified' | 'working' | 'needs-setup' | 'preview';

/** The four declared levels, in maturity order. */
export const CAPABILITY_READINESS_LEVELS: readonly CapabilityReadinessLevel[] = [
  'certified',
  'working',
  'needs-setup',
  'preview',
];

/** Plain user-facing label for each level, rendered in parentheses. */
export const CAPABILITY_READINESS_USER_LABEL: Record<CapabilityReadinessLevel, string> = {
  certified: 'verified live',
  working: 'working',
  'needs-setup': 'needs setup',
  preview: 'preview',
};

export interface AdvertisedCapability {
  /** Stable capability id. */
  readonly id: string;
  /** Plain-language title shown to users. */
  readonly title: string;
  /** Declared readiness level. */
  readonly level: CapabilityReadinessLevel;
  /**
   * The live-verification scenario id this capability maps to. Required for
   * `certified`, and must be absent for every other level.
   */
  readonly scenarioId?: string;
  /**
   * Surface identifiers where this capability is advertised: onboarding
   * category ids, model-tool names, and command names. Used to attach the
   * rendered readiness line to the right surface.
   */
  readonly surfaces: readonly string[];
  /**
   * The literal capability nouns as they appear in user-facing copy. The
   * enforcement tests grep advertised surfaces for these and require a
   * registry entry, so a surface can never advertise a capability that has no
   * declared level.
   */
  readonly advertisedNames: readonly string[];
  /** Plain description of what works and what does not. */
  readonly readinessNote: string;
}

export const CAPABILITY_REGISTRY: readonly AdvertisedCapability[] = [
  {
    id: 'models',
    title: 'Model routing',
    level: 'certified',
    scenarioId: 'openai-compatible-models',
    surfaces: ['setup', 'models'],
    advertisedNames: ['model routing'],
    readinessNote:
      'Cloud, subscription, and local model routing. A live check confirms the models route returns available models in each release report.',
  },
  {
    id: 'agent-knowledge',
    title: 'Agent Knowledge',
    level: 'certified',
    scenarioId: 'agent-knowledge-ask-isolated',
    surfaces: ['onboarding-context', 'agent_knowledge'],
    advertisedNames: ['Agent Knowledge', 'Knowledge'],
    readinessNote:
      'Isolated per-home knowledge with source provenance. A live check exercises the isolated ask route in each release report, and answers fail closed when provenance is missing.',
  },
  {
    id: 'local-model-cookbook',
    title: 'Local model cookbook',
    level: 'working',
    surfaces: ['setup', 'models'],
    advertisedNames: ['local model'],
    readinessNote:
      'Hardware-scored local model recommendations scan processor, memory, and platform. Per-card memory and accelerator-model detection is not shipped.',
  },
  {
    id: 'deep-research',
    title: 'Deep research',
    level: 'working',
    surfaces: ['research'],
    advertisedNames: ['research', 'deep research'],
    readinessNote:
      'Research runs, source review, and saved reports are implemented and unit-tested. Browser-backed runs need a connected host.',
  },
  {
    id: 'documents',
    title: 'Documents and review packets',
    level: 'working',
    surfaces: ['documents'],
    advertisedNames: ['documents'],
    readinessNote:
      'Versioned drafts, suggestions, exports, and reviewer handoff packets are implemented and unit-tested.',
  },
  {
    id: 'blind-model-comparison',
    title: 'Model comparison',
    level: 'working',
    surfaces: ['documents', 'models'],
    advertisedNames: ['model comparison'],
    readinessNote:
      'Blind comparison with delayed reveal, saved judgments, and confirmed route decisions are implemented and unit-tested.',
  },
  {
    id: 'schedules-automation',
    title: 'Schedules and automation',
    level: 'working',
    surfaces: ['automation', 'schedule'],
    advertisedNames: ['schedules', 'routines'],
    readinessNote:
      'Schedules, reminders, and routines with a visible queue are implemented and unit-tested.',
  },
  {
    id: 'local-context-memory',
    title: 'Memory and personality',
    level: 'working',
    surfaces: ['onboarding-context', 'memory'],
    advertisedNames: ['memory', 'personas', 'skills', 'routines'],
    readinessNote:
      'Local memory, personas, skills, and routines with review-first promotion are implemented and unit-tested.',
  },
  {
    id: 'execution-shell',
    title: 'Local execution',
    level: 'working',
    surfaces: ['execution', 'terminal', 'process'],
    advertisedNames: ['run commands', 'shell commands'],
    readinessNote:
      'Local read, search, file edit, and bounded foreground commands are implemented and unit-tested.',
  },
  {
    id: 'multi-agent-delegation',
    title: 'Delegated work',
    level: 'working',
    surfaces: ['delegation'],
    advertisedNames: ['delegation'],
    readinessNote:
      'Visible serial-by-default subagent records are implemented and unit-tested. Remote execution backends are limited to a connected host.',
  },
  {
    id: 'image-input',
    title: 'Image input',
    level: 'working',
    surfaces: ['onboarding-voice-media'],
    advertisedNames: ['image input'],
    readinessNote:
      'Attaching an image is implemented and unit-tested. The selected model must support image understanding.',
  },
  {
    id: 'messaging-channels',
    title: 'Messaging',
    level: 'needs-setup',
    surfaces: ['onboarding-channels', 'channels'],
    advertisedNames: ['messaging', 'Slack', 'Discord', 'Telegram'],
    readinessNote:
      'Messaging adapters are implemented; each channel must be enabled and given credentials before it can deliver.',
  },
  {
    id: 'voice',
    title: 'Voice controls',
    level: 'needs-setup',
    surfaces: ['onboarding-voice-media', 'device'],
    advertisedNames: ['voice'],
    readinessNote:
      'Wake-word capture is implemented here. Turning on wake detection is one act you perform for the user: set voice.wake.enabled (the surface row voice.wake.surfaces.agent moves with it automatically) and the pinned models are downloaded and verified if they are missing; never tell the user to run a command for any of it. What they say after the wake phrase then reaches the conversation input. It needs a capture device, a recorder on PATH, and a speech-to-text provider. Noise suppression and speech-gating are available on the same rows (voice.wake.noiseSuppression, voice.wake.vadThreshold). Push-to-talk and continuous talk mode are not shipped.',
  },
  {
    id: 'text-to-speech',
    title: 'Spoken output',
    level: 'needs-setup',
    surfaces: ['onboarding-voice-media', 'device'],
    advertisedNames: ['text-to-speech', 'TTS'],
    readinessNote:
      'Spoken replies work once a text-to-speech provider is configured.',
  },
  {
    id: 'media-generation',
    title: 'Media generation',
    level: 'needs-setup',
    surfaces: ['onboarding-voice-media'],
    advertisedNames: ['media generation'],
    readinessNote:
      'Image and video generation is implemented; it needs configured media providers.',
  },
  {
    id: 'telephony',
    title: 'Telephony',
    level: 'needs-setup',
    surfaces: ['onboarding-voice-media', 'channels'],
    advertisedNames: ['telephony', 'SMS'],
    readinessNote:
      'SMS, voice call, and bridge delivery are backed by a real delivery strategy; they need Twilio or bridge credentials.',
  },
  {
    id: 'email',
    title: 'Email',
    level: 'needs-setup',
    surfaces: ['email', 'personal-ops'],
    advertisedNames: ['email'],
    readinessNote:
      'Direct IMAP and SMTP email is implemented; it needs account settings. Writing-style replies, auto-tagging, and spam triage are not shipped.',
  },
  {
    id: 'calendar',
    title: 'Calendar',
    level: 'needs-setup',
    surfaces: ['calendar', 'personal-ops'],
    advertisedNames: ['calendar'],
    readinessNote:
      'Calendar import and export through .ics files is implemented. Direct CalDAV server sync is not shipped.',
  },
  {
    id: 'browser-control',
    title: 'Browser control',
    level: 'working',
    surfaces: ['browser'],
    advertisedNames: ['browser', 'browser automation', 'web automation'],
    readinessNote:
      'The agent drives a real browser itself: opening pages, reading them, clicking, typing, and taking screenshots, with a saved profile that keeps sign-ins between runs. It installs its own browser on first use. Connecting to a browser you already have open is available but does not complete its handshake on this runtime.',
  },
  {
    id: 'computer-control',
    title: 'Desktop control',
    level: 'preview',
    surfaces: ['computer'],
    advertisedNames: ['computer control', 'desktop control'],
    readinessNote:
      'Desktop control outside the browser is planning and readiness inspection in the agent today; actual control runs through a connected host once it certifies the route. Web pages are handled by browser control, which is working.',
  },
];

/** Return the plain user-facing label for a level (rendered in parentheses). */
export function capabilityReadinessUserLabel(level: CapabilityReadinessLevel): string {
  return CAPABILITY_READINESS_USER_LABEL[level];
}

/** Look up a capability by its stable id. */
export function getCapabilityById(id: string): AdvertisedCapability | undefined {
  return CAPABILITY_REGISTRY.find((capability) => capability.id === id);
}

/**
 * Look up a capability by an advertised noun (case-insensitive). Used by the
 * enforcement tests to pin that any advertised capability name resolves to a
 * declared readiness level.
 */
export function getCapabilityByAdvertisedName(name: string): AdvertisedCapability | undefined {
  const needle = name.trim().toLowerCase();
  return CAPABILITY_REGISTRY.find((capability) =>
    capability.advertisedNames.some((advertised) => advertised.toLowerCase() === needle),
  );
}

/** Every capability advertised on a given surface, in registry order. */
export function capabilitiesForSurface(surface: string): readonly AdvertisedCapability[] {
  return CAPABILITY_REGISTRY.filter((capability) => capability.surfaces.includes(surface));
}

/** Inline readiness suffix for a single capability, e.g. " (needs setup)". */
export function capabilityReadinessSuffix(capability: AdvertisedCapability): string {
  return ` (${capabilityReadinessUserLabel(capability.level)})`;
}

/**
 * Render one plain readiness line for a surface, sourced entirely from the
 * registry. Returns an empty string when no capability is advertised there,
 * so a caller can append it unconditionally.
 *
 * Example: "Readiness: Voice controls (needs setup), Spoken output (needs
 * setup), Image input (working), Media generation (needs setup), Telephony
 * (needs setup)."
 */
export function renderCapabilityReadinessLine(surface: string): string {
  const capabilities = capabilitiesForSurface(surface);
  if (capabilities.length === 0) return '';
  const parts = capabilities.map(
    (capability) => `${capability.title}${capabilityReadinessSuffix(capability)}`,
  );
  return `Readiness: ${parts.join(', ')}.`;
}
