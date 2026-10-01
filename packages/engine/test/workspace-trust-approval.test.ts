// Component assertions retained from the pinned daemon trust suite. Its two
// full-composition assertions remain pending the actual daemon services port.
/**
 * Workspace trust, for the process that hosts the runs.
 *
 * The trust decision is written per-workspace by whoever asked the question,
 * and the daemon executes tool calls in that same workspace. Before this seam
 * existed the daemon carried the gate, pointed it at the same trust.json the
 * terminal app writes, and then never loaded it and never consulted it: a
 * hosted run's tool calls reached the background permission gate with no
 * manager at all, which that gate reads as approved. An explicit decision of
 * "restricted" changed nothing about what a daemon-hosted run could do.
 *
 * These tests pin the three answers a hosted run can get, asked, honoured,
 * refused, and that the composition actually hands the manager to the
 * orchestrator, because nothing fails if that one line goes missing again.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionPromptDecision, PermissionPromptRequest } from '../sdk/src/platform/permissions/prompt.js';
import { ApprovalBroker, type RequestSharedApprovalInput } from '../sdk/src/platform/control-plane/approval-broker.js';
import { WorkspaceTrustManager } from '../sdk/src/platform/runtime/workspace-trust.js';
const GOODVIBES_DAEMON_SURFACE_ROOT = 'tui';
import {
  createWorkspaceTrustDecisionAsk,
  trustGatedApprovalRaiser,
  type ApprovalRaiseExtras,
} from '../sdk/src/platform/runtime/workspace-trust-approval.js';

let workspace: string;

function makePaths(root: string) {
  return {
    projectGoodVibesRoot: join(root, '.goodvibes'),
    resolveProjectPath: (...segments: string[]) => join(root, '.goodvibes', ...segments),
  };
}

/** A write-category tool request, the kind an undecided workspace gates. */
function writeRequest(callId = 'call-1'): PermissionPromptRequest {
  return {
    callId,
    tool: 'edit',
    args: { path: 'src/main.ts' },
    category: 'write',
    analysis: {
      classification: 'file-write',
      riskLevel: 'medium',
      summary: 'Edit src/main.ts',
      reasons: ['A hosted run wants to edit a file.'],
    },
  };
}

interface RecordedRaise {
  readonly request: PermissionPromptRequest;
  readonly extras: ApprovalRaiseExtras;
}

/**
 * A stand-in for the approval broker: records every raise and answers by tool
 * name, so a test can tell the trust question apart from the tool ask it gates.
 */
function recordingBroker(answers: { trust?: boolean; tool?: boolean } = {}) {
  const raises: RecordedRaise[] = [];
  const raise = async (
    input: { readonly request: PermissionPromptRequest } & ApprovalRaiseExtras,
  ): Promise<PermissionPromptDecision> => {
    const { request, ...extras } = input;
    raises.push({ request, extras });
    const approved = request.tool === 'workspace-trust'
      ? answers.trust === true
      : answers.tool === true;
    return { approved };
  };
  const trustAsks = () => raises.filter((entry) => entry.request.tool === 'workspace-trust');
  const toolAsks = () => raises.filter((entry) => entry.request.tool !== 'workspace-trust');
  const actual = new ApprovalBroker({ storePath: join(workspace, 'fixture-approvals.json') });
  const approvalBroker = {
    async raiseApproval(input: RequestSharedApprovalInput) {
      const raised = await actual.raiseApproval(input);
      const decision = await raise(input);
      // The fixture scripts an explicit operator choice. Production callbacks
      // cannot derive this record marker from an unattributed boolean.
      await actual.resolveApproval(raised.approval.id, {
        approved: decision.approved,
        disposition: decision.approved ? 'approved' : 'denied',
        actor: 'fixture-owner',
      });
      return raised;
    },
    getApproval: actual.getApproval.bind(actual),
  };
  return { raise, raises, trustAsks, toolAsks, approvalBroker };
}

function buildRaiser(broker: ReturnType<typeof recordingBroker>) {
  const manager = new WorkspaceTrustManager({ shellPaths: makePaths(workspace), surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT });
  const raiser = trustGatedApprovalRaiser(
    manager,
    broker.raise,
    createWorkspaceTrustDecisionAsk({ broker: broker.approvalBroker, workingDirectory: workspace }),
  );
  return { manager, raiser };
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'gv-trust-ask-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('an undecided workspace asks rather than deciding for the user', () => {
  it('raises the trust question through the approval path on the first write', async () => {
    const broker = recordingBroker({ trust: true, tool: true });
    const { raiser } = buildRaiser(broker);

    const decision = await raiser({ request: writeRequest() });

    // Asked, not silently trusted, not silently refused.
    expect(broker.trustAsks()).toHaveLength(1);
    const asked = broker.trustAsks()[0]!;
    expect(asked.request.args).toEqual({ workspace });
    expect(asked.request.analysis.target).toBe(workspace);
    // The question expires rather than blocking a hosted run forever.
    expect(asked.extras.timeoutMs).toBeGreaterThan(0);
    // And, once answered "trusted", the very request that raised it goes through.
    expect(decision.approved).toBe(true);
    expect(broker.toolAsks()).toHaveLength(1);
    expect(broker.toolAsks()[0]!.request.callId).toBe('call-1');
  });

  it('persists the answer, so the second run never sees the question', async () => {
    const first = recordingBroker({ trust: true, tool: true });
    const { raiser } = buildRaiser(first);
    await raiser({ request: writeRequest() });
    expect(first.trustAsks()).toHaveLength(1);

    // A fresh manager over the same workspace: the decision came off disk.
    const second = recordingBroker({ trust: false, tool: true });
    const { raiser: reopened } = buildRaiser(second);
    const decision = await reopened({ request: writeRequest('call-2') });

    expect(second.trustAsks()).toHaveLength(0);
    expect(decision.approved).toBe(true);
    expect(second.toolAsks()).toHaveLength(1);
  });

  it('refuses when the answer is "restricted", and stops asking', async () => {
    const broker = recordingBroker({ trust: false, tool: true });
    const { raiser } = buildRaiser(broker);

    const first = await raiser({ request: writeRequest('call-1') });
    const second = await raiser({ request: writeRequest('call-2') });

    expect(first.approved).toBe(false);
    expect(second.approved).toBe(false);
    // One question, not one per tool call.
    expect(broker.trustAsks()).toHaveLength(1);
    // And the tool ask never reached the broker at all.
    expect(broker.toolAsks()).toHaveLength(0);
  });

  it('lets reads through without raising anything', async () => {
    const broker = recordingBroker({ trust: true, tool: true });
    const { raiser } = buildRaiser(broker);

    const decision = await raiser({
      request: { ...writeRequest(), category: 'read', tool: 'read' },
    });

    expect(decision.approved).toBe(true);
    expect(broker.trustAsks()).toHaveLength(0);
    expect(broker.toolAsks()).toHaveLength(1);
  });
});

describe('a decision already on disk is honoured without a screen', () => {
  it('honours a persisted "trusted" without asking', async () => {
    mkdirSync(join(workspace, '.goodvibes', 'tui'), { recursive: true });
    writeFileSync(
      join(workspace, '.goodvibes', 'tui', 'trust.json'),
      JSON.stringify({ level: 'trusted', decidedAt: new Date().toISOString() }),
    );
    const broker = recordingBroker({ trust: false, tool: true });
    const { raiser } = buildRaiser(broker);

    const decision = await raiser({ request: writeRequest() });

    expect(broker.trustAsks()).toHaveLength(0);
    expect(decision.approved).toBe(true);
  });

  it('honours a persisted "restricted" by refusing without asking', async () => {
    mkdirSync(join(workspace, '.goodvibes', 'tui'), { recursive: true });
    writeFileSync(
      join(workspace, '.goodvibes', 'tui', 'trust.json'),
      JSON.stringify({ level: 'restricted', decidedAt: new Date().toISOString() }),
    );
    const broker = recordingBroker({ trust: true, tool: true });
    const { raiser } = buildRaiser(broker);

    const decision = await raiser({ request: writeRequest() });

    expect(decision.approved).toBe(false);
    expect(broker.raises).toHaveLength(0);
  });
});

describe('the attribution a brokered ask carries survives the gate', () => {
  it('passes routeId and metadata through to the raise', async () => {
    mkdirSync(join(workspace, '.goodvibes', 'tui'), { recursive: true });
    writeFileSync(
      join(workspace, '.goodvibes', 'tui', 'trust.json'),
      JSON.stringify({ level: 'trusted', decidedAt: new Date().toISOString() }),
    );
    const broker = recordingBroker({ tool: true });
    const { raiser } = buildRaiser(broker);

    await raiser({
      request: writeRequest(),
      routeId: 'agent-7',
      metadata: { source: 'background-agent', agentId: 'agent-7' },
    });

    const asked = broker.toolAsks()[0]!;
    expect(asked.extras.routeId).toBe('agent-7');
    expect(asked.extras.metadata).toEqual({ source: 'background-agent', agentId: 'agent-7' });
  });

  it('a workspace whose trust question cannot be answered refuses the run and says so', async () => {
    const raise = async (): Promise<PermissionPromptDecision> => {
      throw new Error('no surface attached');
    };
    const manager = new WorkspaceTrustManager({ shellPaths: makePaths(workspace), surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT });
    const raiser = trustGatedApprovalRaiser(
      manager,
      raise,
      createWorkspaceTrustDecisionAsk({ broker: { async raiseApproval() { throw new Error('no surface attached'); }, getApproval: () => null }, workingDirectory: workspace }),
    );

    await expect(raiser({ request: writeRequest() })).rejects.toThrow('no surface attached');
    // Undecided still: the next run asks again rather than inheriting a
    // decision nobody made.
    expect(manager.isDecided()).toBe(false);
  });
});
