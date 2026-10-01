/**
 * The capability index: one authoritative answer to "what can this agent
 * actually do right now".
 *
 * This exists because the agent told its owner it could not send email while
 * working Google credentials sat on disk. Every inventory it consulted gave a
 * false negative: a channel list that returned zero rows while reporting two
 * ready channels, an accounts list that was empty because nothing had been
 * registered into it, and operator methods marked unavailable because a daemon
 * route was not served. Each was answering a narrower question than the one
 * being asked, and none of them said so.
 *
 * The rules this module encodes:
 *   - A capability is `ready` only when it has a real invocation route AND
 *     every prerequisite actually resolves. Never because a list was
 *     non-empty, and never because a name or description mentioned it.
 *   - Anything not ready carries a specific reason and a specific fix.
 *   - Resolving a capability performs no effects. Probes read; they never send,
 *     launch, deliver, or spend.
 */

export type CapabilityState =
  /** Invocable right now: route exists and prerequisites resolve. */
  | 'ready'
  /** Real route exists but something concrete is missing, and we know what. */
  | 'needs-setup'
  /** No invocation route exists in this build at all. */
  | 'unavailable';

/**
 * The complete set of checks a capability may declare.
 *
 * Prerequisites are DESCRIPTIONS, not functions. A registrant cannot hand the
 * index arbitrary code to run, so a capability check cannot send a message,
 * open a browser, or spend money by construction, the runner in
 * capability-probe-runner.ts is the only thing that executes, and it only
 * reads. Adding a new kind of check means editing that runner on purpose.
 */
export type CapabilityProbe =
  /** A file exists and is readable. Used for credential and token files. */
  | { readonly kind: 'file-present'; readonly path: string; readonly label: string }
  /** A file exists, parses as JSON, and carries the named keys. */
  | {
    readonly kind: 'json-file-readable';
    readonly path: string;
    readonly label: string;
    readonly requiredKeys?: readonly string[];
  }
  /** A directory exists. */
  | { readonly kind: 'directory-present'; readonly path: string; readonly label: string }
  /** Any one of several paths exists. Credentials live in more than one place. */
  | { readonly kind: 'any-file-present'; readonly paths: readonly string[]; readonly label: string }
  /** A model tool of this name is registered in this session. */
  | { readonly kind: 'model-tool-registered'; readonly toolName: string }
  /** An MCP server of this name is connected and not blocked or quarantined. */
  | { readonly kind: 'mcp-server-connected'; readonly serverName: string }
  /** A specific MCP tool is listed by a connected server. */
  | { readonly kind: 'mcp-tool-available'; readonly qualifiedName: string }
  /** A daemon operator method is served, not merely cataloged. */
  | { readonly kind: 'operator-method-served'; readonly methodId: string }
  /**
   * An installed package can be resolved (a driver or SDK the capability needs).
   *
   * `searchDirectories` exists because a `bun build --compile` executable has no
   * node_modules: module resolution alone can never succeed inside one, so a
   * probe that only tried resolution reported every compiled build as missing
   * the package, including builds carrying it right beside the executable.
   * Each listed directory is checked for the package's own manifest and entry
   * file, which is exactly how the runtime finds it.
   *
   * `requiredFiles` is what keeps that promise literally true. A directory can
   * hold a manifest and an entry file and still be unusable, a half-finished
   * extraction, or an older release's incomplete copy, and the runtime resolver
   * skips exactly those. A probe with a weaker completeness rule than the
   * resolver reports the package "present at X" for a directory the tool will
   * refuse a moment later, which is the disagreement this whole probe exists to
   * remove. Declaring the files lets each registrant state the resolver's rule
   * rather than the probe guessing at it. Defaults to the manifest and entry.
   */
  | {
    readonly kind: 'module-resolvable';
    readonly specifier: string;
    readonly label: string;
    readonly searchDirectories?: readonly string[];
    readonly requiredFiles?: readonly string[];
  }
  /** A configuration key holds a non-empty value. Values are never read out. */
  | { readonly kind: 'config-value-present'; readonly key: string; readonly label: string }
  /**
   * Any one of several probes passes. Used where a capability has genuine
   * alternatives, a credential in the agent's own store OR the same account
   * already connected through another tool on this machine. Marking each
   * alternative `optional` instead would mean none of them could block, so a
   * capability with no credentials at all would report ready.
   */
  | { readonly kind: 'any-of'; readonly probes: readonly CapabilityProbe[]; readonly label: string };

export interface CapabilityPrerequisite {
  readonly id: string;
  /** Plain-language name of what is needed, e.g. "Google OAuth credentials". */
  readonly label: string;
  readonly probe: CapabilityProbe;
  /** Exactly what to do when this is missing. Required: a denial without a fix is the defect. */
  readonly fix: string;
  /**
   * When true, the capability can still be ready without this. Used for
   * alternatives, e.g. either a saved token or a client-secret file.
   */
  readonly optional?: boolean;
}

/** How a capability is actually invoked, once it is ready. */
export interface CapabilityInvocation {
  readonly kind: 'model-tool' | 'mcp-tool-call' | 'operator-method' | 'daemon-route';
  /** The tool the model calls. Must be a registered tool name. */
  readonly toolName: string;
  /** The exact call, ready to use. */
  readonly modelRoute: string;
  /**
   * What must be true for this route to exist at all, checked the same way as
   * prerequisites, so a route can never be advertised without being there.
   */
  readonly availability: CapabilityProbe;
}

/**
 * What a provider registers. The contract other rounds conform to.
 */
export interface CapabilityDeclaration {
  /** Stable dotted id, e.g. "email.send", "calendar.read", "browser.control". */
  readonly id: string;
  readonly title: string;
  /** One plain sentence: what the agent can do, in the user's words. */
  readonly summary: string;
  /** Who registered it, for provenance in the self-check. */
  readonly provider: string;
  /**
   * Invocation routes in preference order. The first whose availability probe
   * passes is the route reported. Empty means the capability is unavailable in
   * this build, which is a legitimate, honest state.
   */
  readonly invocations: readonly CapabilityInvocation[];
  readonly prerequisites: readonly CapabilityPrerequisite[];
  /**
   * Evidence that this capability's underlying service is configured on this
   * machine even when no route is registered for it. The self-check uses this
   * to catch the exact failure that started this work: credentials present,
   * capability silent.
   */
  readonly configurationEvidence?: readonly CapabilityProbe[];
}

export interface ResolvedPrerequisite {
  readonly id: string;
  readonly label: string;
  readonly satisfied: boolean;
  readonly detail: string;
  readonly fix: string | null;
  readonly optional: boolean;
}

export interface ResolvedCapability {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly provider: string;
  readonly state: CapabilityState;
  /** The call to make when ready. Null otherwise. */
  readonly modelRoute: string | null;
  readonly invocationKind: CapabilityInvocation['kind'] | null;
  /** Why it is not ready, in plain language. Null when ready. */
  readonly reason: string | null;
  /** What to do about it. Null when ready. */
  readonly fix: string | null;
  readonly prerequisites: readonly ResolvedPrerequisite[];
}

/**
 * A capability that is not reported as usable while its own service is
 * demonstrably configured on this machine. This is a defect in the index, not
 * a state a user should have to discover by arguing with the agent.
 */
export interface CapabilityDisagreement {
  readonly capabilityId: string;
  readonly title: string;
  readonly reportedState: CapabilityState;
  /** What was found that contradicts the reported state. */
  readonly evidence: readonly string[];
  readonly problem: string;
  readonly fix: string;
}

export interface CapabilityIndexReport {
  readonly resolvedAt: string;
  readonly capabilities: readonly ResolvedCapability[];
  readonly ready: readonly string[];
  readonly needsSetup: readonly string[];
  readonly unavailable: readonly string[];
  /** Configured-but-unreported capabilities. Non-empty means something is wrong here. */
  readonly disagreements: readonly CapabilityDisagreement[];
}
