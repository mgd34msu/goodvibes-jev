import { nativeHostedConversationOwner } from './native-hosted-conversation-composition.js';
/**
 * hosted-session-composition.ts, what this daemon states so it may host
 * conversation loops.
 *
 * The engine is the SDK's (`@goodvibes-jev/engine/sdk/platform/hosted-sessions`):
 * lifecycle, the detach policy, the bounded disk state, the verbs, the
 * lifecycle channel. It is off until a product says how a workspace FLOOR is
 * built, and that is deliberate, the floor's `requestApproval` seam is where a
 * product's trust posture lives, and no default can stand in for a decision
 * about who may write files and run commands in a directory a client named over
 * the wire.
 *
 * This daemon's answer is the gate it already had: the workspace trust
 * question is put in front of every ask a hosted run makes (trust/trust-gated-
 * approvals.ts): an undecided workspace raises the question as an ordinary
 * approval record for whichever surface is attached to answer, a trusted one is
 * exactly as permissive as before, and a restricted one refuses non-read
 * categories without asking. What this file adds is PER-WORKSPACE scope: the
 * daemon's own gate reads `<its cwd>/.goodvibes/<surface>/trust.json`, and a
 * session hosted in another directory has to be gated by that directory's
 * decision, not by the daemon's.
 *
 * Everything else in a floor comes from `createClientRuntimeServices`, the
 * same composition a terminal runs, so a hosted turn's tools, hooks, plugins
 * and model stack are the ones the platform already has, not a second set.
 *
 * ── The exec posture a hosted turn runs under ──────────────────────────────
 *
 * "The same composition a terminal runs" is what BUILDS the exec tool, and it
 * builds it the same way here: the `sandbox.*` config and the `exec-sandbox`
 * gate this daemon already reads produce the same bubblewrap boundary a local
 * exec gets, network, PID, UTS and IPC namespaced, the system read-only, /tmp
 * and $HOME masked, the workspace writable, and `sandbox.egressAllowlist` the
 * one way network comes back, with the self-labelling note on every result.
 *
 * What was NOT the same was the fallback. When no boundary could be applied,
 * the exec tool ran the command on the host and said so, which is right for a
 * terminal (a person asked, a person is reading) and wrong for a turn nobody is
 * watching. A hosted conversational turn reached the whole host that way: the
 * full process table, the owner's /proc, and his tmux session, where it typed.
 *
 * So this daemon states the posture rather than inheriting a default:
 *
 *  - CONVERSATIONAL is what every session created over `sessions.hosted.*`
 *    gets, and it is the posture the engine defaults to. The boundary is
 *    REQUIRED: a command that cannot be contained is refused, naming why, and
 *    running on the host is not a fallback available to it. The owner's
 *    terminal is denied outright, at the exec guard, regardless of boundary.
 *  - WORKSTREAM, a real work chain the owner authorized, which may genuinely
 *    need the machine itself, is a per-spawn grant this composition makes
 *    explicitly. There is no such spawn today, so the function below never
 *    returns it; when there is one, the grant is written HERE, in the daemon's
 *    own composition, where a reader can see which spawns hold it. Nothing on
 *    the wire and nothing in a tool argument can reach it.
 */
import { createShellPathService } from './index.js';
import { createClientRuntimeServices } from '@goodvibes-jev/engine/sdk/platform/runtime/client-services';
import { createRuntimeStore } from '@goodvibes-jev/engine/sdk/platform/runtime/store';
import { createLaunchTolerantProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { DaemonHostedSessionsOptions } from '@goodvibes-jev/engine/sdk/platform/daemon';
import type {
  HostedSessionExecPosture,
  HostedWorkspaceFloor,
} from '@goodvibes-jev/engine/sdk/platform/hosted-sessions';
import { CONVERSATIONAL_DIAGNOSIS_SECTION } from '@goodvibes-jev/engine/sdk/platform/agents';
import { operations } from '@goodvibes-jev/engine/sdk/platform/runtime';
const { WorkspaceTrustManager } = operations;
import { createWorkspaceTrustDecisionAsk, trustGatedApprovalRaiser, type ApprovalRaise } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';
import type { RuntimeServices } from './runtime-services-types.js';

/** The operator policy a session hosted by THIS daemon runs under. */
function hostedSystemPrompt(input: { readonly workspaceRoot: string }): string {
  return [
    [
      'You are a GoodVibes session hosted by the daemon rather than by a terminal.',
      `Your working directory is ${input.workspaceRoot}.`,
      'Someone may be attached and watching this turn, or may have detached and read it later;',
      'write for both. Say what you did and why; never report work you did not do.',
      'Tool permissions are decided by whoever is attached: an ask you raise may take a while to be',
      'answered, and an unanswered one is a refusal, not a reason to find another way round.',
    ].join(' '),
    // The same contract every other conversational turn is held to, from the
    // SDK rather than restated here, a second copy is a copy that drifts.
    CONVERSATIONAL_DIAGNOSIS_SECTION,
  ].join('\n\n');
}

/**
 * What a hosted session's exec tool may do.
 *
 * Every session this daemon hosts is a conversation, so every one of them is
 * contained (see the module header). Stated on the floor rather than left to
 * the engine's default so that the day a workstream spawn exists, the grant is
 * a visible change to THIS function and not an option someone set elsewhere,
 * and it sits beside the trust gate, which is the other statement this daemon
 * makes about how much authority a hosted run carries.
 */
function hostedExecPosture(): HostedSessionExecPosture {
  return 'conversational';
}

/**
 * Build the hosted-session options this daemon passes to `DaemonServer`.
 *
 * `services` is the daemon's own graph: its config manager, event bus, secrets
 * home and approval broker are shared with every floor, so a hosted session
 * reads the same settings, publishes on the same bus and raises asks into the
 * same broker every other surface is watching.
 */
export function createHostedSessionOptions(services: RuntimeServices): DaemonHostedSessionsOptions {
  /**
   * One trust manager per workspace, cached: `load()` is idempotent but a
   * manager per floor keeps the decision file and the in-memory answer for a
   * workspace in one place, so two sessions in one directory cannot end up
   * having been asked the trust question twice.
   */
  const trustByWorkspace = new Map<string, operations.WorkspaceTrustManager>();

  const gateFor = (workspaceRoot: string): ApprovalRaise => {
    const shellPaths = createShellPathService({
      workingDirectory: workspaceRoot,
      homeDirectory: services.homeDirectory,
    });
    let trust = trustByWorkspace.get(workspaceRoot);
    if (!trust) {
      trust = new WorkspaceTrustManager({ shellPaths, surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT });
      trustByWorkspace.set(workspaceRoot, trust);
    }
    const raise: ApprovalRaise = (input) => services.approvalBroker.requestApproval(input);
    return trustGatedApprovalRaiser(
      trust,
      raise,
      // The question names the workspace it is about, which is the whole point
      // of scoping it here: a daemon hosting three sessions in three
      // directories asks three separate questions, each answerable on its own.
      createWorkspaceTrustDecisionAsk({ broker: services.approvalBroker, workingDirectory: workspaceRoot }),
    );
  };

  return {
    nativeConversation: nativeHostedConversationOwner(services.gatewayMethods),
    floorFactory: ({ workspaceRoot }): HostedWorkspaceFloor => {
      const floor = createClientRuntimeServices({
        configManager: services.configManager,
        // The daemon's own bus: a hosted turn's stream events reach the
        // control-plane SSE subscribers through the same path every other
        // runtime event takes, stamped with the hosted session's id.
        runtimeBus: services.runtimeBus,
        // A store of its own. The daemon's runtime store describes the daemon's
        // single local runtime, and a hosted session is not that runtime.
        runtimeStore: createRuntimeStore(),
        featureFlags: services.featureFlags,
        surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT,
        workingDir: workspaceRoot,
        homeDirectory: services.homeDirectory,
        requestApproval: gateFor(workspaceRoot),
        // A workspace with broken or absent provider credentials must degrade,
        // not take the daemon down on a create call.
        providerRegistryFactory: createLaunchTolerantProviderRegistry,
      });
      // Copy the daemon registry's discovery snapshot into this floor. The
      // explicit host preloads its home/surface cache before server admission;
      // it does not launch a LAN scan. Later explicit registry changes reach
      // new floors only; existing floors do not watch the persisted cache.
      const discovered = services.providerRegistry.listDiscoveredServers();
      if (discovered.length > 0) floor.providerRegistry.registerDiscoveredProviders([...discovered]);
      return {
        services: floor,
        // Each workspace floor owns its own contract store and runner.
        contractRunner: floor.contractRunner,
        execPosture: hostedExecPosture,
        dispose: (): void => floor.dispose(),
      };
    },
    systemPrompt: hostedSystemPrompt,
  };
}
