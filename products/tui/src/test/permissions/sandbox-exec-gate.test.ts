import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { SandboxAvailability } from '@goodvibes-jev/engine/sdk/platform/tools/exec/sandbox';
import type { PermissionPromptRequest, PermissionPromptDecision } from '@goodvibes-jev/engine/sdk/platform/permissions';
import {
  createSandboxExecAsk,
  extractExecCommands,
  readSandboxAskAnnotation,
  type SandboxExecAskDeps,
} from '../../permissions/sandbox-exec-gate.ts';

let previousPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  const networkCommands = new Set(['curl https://example.com', 'curl https://x.test']);
  previousPort = installJudgmentPort(fakePort((name, _question, state) =>
    noulAnswer(name === 'needsNetwork' && networkCommands.has((state as { command: string }).command) ? 0.99 : 0.01),
  ).port);
});
afterEach(() => { installJudgmentPort(previousPort); });

const AVAILABLE: SandboxAvailability = {
  available: true,
  backend: 'bubblewrap',
  bwrapPath: '/usr/bin/bwrap',
  reason: 'bubblewrap sandbox available; network isolation confirmed',
  networkIsolationGuaranteed: true,
};

const UNAVAILABLE: SandboxAvailability = {
  available: false,
  backend: 'none',
  reason: 'bubblewrap (bwrap) was not found on PATH',
  networkIsolationGuaranteed: false,
};

function execRequest(command: string | { commands: unknown[] }): PermissionPromptRequest {
  const args = typeof command === 'string' ? { command } : command;
  return {
    callId: 'c1',
    tool: 'exec',
    args: args as Record<string, unknown>,
    category: 'execute',
    analysis: { classification: 'shell', riskLevel: 'high', summary: 'run a command', reasons: [] },
  };
}

function deps(overrides: Partial<SandboxExecAskDeps> = {}): SandboxExecAskDeps {
  return {
    isSandboxFeatureEnabled: () => true,
    isSandboxConfigEnabled: () => true,
    readEgressAllowlist: () => [],
    detectAvailability: () => AVAILABLE,
    ...overrides,
  };
}

describe('extractExecCommands', () => {
  it('reads a single command string', () => {
    expect(extractExecCommands(execRequest('ls -la'))).toEqual(['ls -la']);
  });
  it('reads a commands array of {cmd} entries', () => {
    expect(extractExecCommands(execRequest({ commands: [{ cmd: 'echo a' }, { cmd: 'echo b' }] }))).toEqual(['echo a', 'echo b']);
  });
});

describe('createSandboxExecAsk', () => {
  it('waits for the real needs reader before allowing a command', async () => {
    let release!: () => void;
    let began!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { began = resolve; });
    const fixture = fakePort(() => noulAnswer(0.01));
    installJudgmentPort({ ...fixture.port, ask: async request => { began(); await waiting; return fixture.port.ask(request); } });
    let asked = false;
    let settled = false;
    const gate = createSandboxExecAsk(deps(), async () => { asked = true; return { approved: false }; });
    const pending = gate(execRequest('fixture-delayed-safe')).then(result => { settled = true; return result; });
    await started;
    expect(settled).toBe(false);
    expect(asked).toBe(false);
    release();
    expect(await pending).toEqual({ approved: true });
    expect(fixture.requests[0]?.context?.site).toBe('engine.gate.sandbox-needs');
  });

  it('waits for every batch reading and retains uncertain host escalations', async () => {
    let release!: () => void;
    let began!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { began = resolve; });
    const fixture = fakePort((_name, _question, state) =>
      noulAnswer((state as { command: string }).command === 'fixture-delayed-uncertain' ? 0.5 : 0.01));
    installJudgmentPort({ ...fixture.port, ask: async request => {
      if ((request.state as { command: string }).command === 'fixture-delayed-uncertain') { began(); await waiting; }
      return fixture.port.ask(request);
    } });
    let seen: PermissionPromptRequest | undefined;
    const gate = createSandboxExecAsk(deps(), async request => { seen = request; return { approved: false }; });
    const pending = gate(execRequest({ commands: ['fixture-batch-safe', 'fixture-delayed-uncertain'] }));
    await started;
    expect(seen).toBeUndefined();
    release();
    expect(await pending).toEqual({ approved: false });
    const escalations = readSandboxAskAnnotation(seen)?.sandboxEscalations ?? [];
    expect(escalations.some(value => value.includes('wants network'))).toBe(true);
    expect(escalations.some(value => value.includes('privilege'))).toBe(true);
  });

  it('does not fabricate safe needs or approve when the reader fails', async () => {
    installJudgmentPort(fakePort(() => { throw new Error('fixture needs reader unavailable'); }).port);
    let asked = false;
    const gate = createSandboxExecAsk(deps(), async () => { asked = true; return { approved: true }; });
    await expect(gate(execRequest('fixture-reader-failure'))).rejects.toThrow('fixture needs reader unavailable');
    expect(asked).toBe(false);
  });

  it('does not read needs when disabled or for a non-exec request', async () => {
    const fixture = fakePort(() => { throw new Error('must not read'); });
    installJudgmentPort(fixture.port);
    const ask = async (): Promise<PermissionPromptDecision> => ({ approved: false });
    await createSandboxExecAsk(deps({ isSandboxConfigEnabled: () => false }), ask)(execRequest('fixture-disabled'));
    await createSandboxExecAsk(deps(), ask)({ ...execRequest('fixture-non-exec'), tool: 'write', category: 'write' } as PermissionPromptRequest);
    expect(fixture.requests).toHaveLength(0);
  });

  it('passes non-exec requests straight through', async () => {
    let asked = false;
    const ask = async (): Promise<PermissionPromptDecision> => { asked = true; return { approved: false }; };
    const gate = createSandboxExecAsk(deps(), ask);
    const req = { ...execRequest('ls'), tool: 'write', category: 'write' } as PermissionPromptRequest;
    await gate(req);
    expect(asked).toBe(true);
  });

  it('auto-allows a boundary-safe command without prompting when the sandbox is active', async () => {
    let asked = false;
    const ask = async (): Promise<PermissionPromptDecision> => { asked = true; return { approved: false }; };
    const gate = createSandboxExecAsk(deps(), ask);
    const decision = await gate(execRequest('echo hello'));
    expect(decision).toEqual({ approved: true });
    expect(asked).toBe(false);
  });

  it('surfaces a named network escalation as an ask instead of auto-allowing', async () => {
    let seen: PermissionPromptRequest | null = null;
    const ask = async (r: PermissionPromptRequest): Promise<PermissionPromptDecision> => { seen = r; return { approved: false }; };
    const gate = createSandboxExecAsk(deps(), ask);
    await gate(execRequest('curl https://example.com'));
    expect(seen).not.toBeNull();
    const annotation = readSandboxAskAnnotation(seen);
    expect(annotation).not.toBeNull();
    expect(annotation!.sandboxEscalations.some((e) => e.includes('wants network'))).toBe(true);
  });

  it('does not intervene when the feature flag is off (base policy applies)', async () => {
    let seen: PermissionPromptRequest | null = null;
    const ask = async (r: PermissionPromptRequest): Promise<PermissionPromptDecision> => { seen = r; return { approved: false }; };
    const gate = createSandboxExecAsk(deps({ isSandboxFeatureEnabled: () => false }), ask);
    await gate(execRequest('echo hello'));
    expect(seen).not.toBeNull();
    expect(readSandboxAskAnnotation(seen)).toBeNull();
  });

  it('does not auto-allow when the host cannot provide a boundary', async () => {
    let asked = false;
    const ask = async (): Promise<PermissionPromptDecision> => { asked = true; return { approved: false }; };
    const gate = createSandboxExecAsk(deps({ detectAvailability: () => UNAVAILABLE }), ask);
    await gate(execRequest('echo hello'));
    expect(asked).toBe(true);
  });

  it('a batch auto-allows only when every command is boundary-safe', async () => {
    let asked = false;
    const ask = async (r: PermissionPromptRequest): Promise<PermissionPromptDecision> => {
      asked = true;
      const annotation = readSandboxAskAnnotation(r);
      expect(annotation?.sandboxEscalations.some((e) => e.includes('wants network'))).toBe(true);
      return { approved: false };
    };
    const gate = createSandboxExecAsk(deps(), ask);
    // one safe + one network → the whole batch asks with the union of escalations
    await gate(execRequest({ commands: [{ cmd: 'echo ok' }, { cmd: 'curl https://x.test' }] }));
    expect(asked).toBe(true);
  });

  it('memoizes the host probe across asks', async () => {
    let probes = 0;
    const ask = async (): Promise<PermissionPromptDecision> => ({ approved: false });
    const gate = createSandboxExecAsk(deps({ detectAvailability: () => { probes++; return AVAILABLE; } }), ask);
    await gate(execRequest('echo a'));
    await gate(execRequest('echo b'));
    expect(probes).toBe(1);
  });
});
