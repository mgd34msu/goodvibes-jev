import { readFileSync } from 'node:fs';
import { writeJsonFileAtomic } from '../../utils/atomic-json-store.js';
import { randomUUID } from 'node:crypto';
import { buildSandboxLaunchPlan, executeSandboxCommand, resolveSandboxCommandPlan, type SandboxCommandResult } from './backend.js';
import { getSandboxConfigSnapshot, listSandboxProfiles, renderSandboxReview, type ConfigManagerLike } from './manager.js';
import type {
  SandboxProfile,
  SandboxSession,
  SandboxSessionArtifact,
  SandboxSessionKind,
} from './types.js';

function createSandboxSessionId(): string {
  return `sandbox_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function inferShared(profile: SandboxProfile): boolean {
  return profile.isolation === 'shared';
}

function inferKind(profile: SandboxProfile): SandboxSessionKind {
  return profile.kind;
}

export class SandboxSessionRegistry {
  private readonly sessions = new Map<string, SandboxSession>();
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  private updateSession(sessionId: string, updater: (session: SandboxSession) => SandboxSession): SandboxSession {
    const existing = this.sessions.get(sessionId);
    if (!existing) {
      throw new Error(`Unknown sandbox session: ${sessionId}`);
    }
    const next = Object.freeze(updater(existing));
    this.sessions.set(sessionId, next);
    return next;
  }

  /** The actual workspace target used to build this registry’s process plans. */
  public getWorkspaceRoot(): string { return this.workspaceRoot; }

  public list(): SandboxSession[] {
    return [...this.sessions.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  public async start(profileId: SandboxProfile['id'], label: string | undefined, configManager: ConfigManagerLike): Promise<SandboxSession> {
    const profile = listSandboxProfiles(configManager).find((entry) => entry.id === profileId);
    if (!profile) {
      throw new Error(`Unknown sandbox profile: ${profileId}`);
    }
    if (inferShared(profile)) {
      const existing = [...this.sessions.values()].find((session) => session.profileId === profileId && session.state === 'running');
      if (existing) return existing;
    }
    const config = getSandboxConfigSnapshot(configManager);
    const launchPlan = buildSandboxLaunchPlan(profile, label?.trim() || profile.label, this.workspaceRoot);
    let state: SandboxSession['state'] = 'running';
    let startupStatus: SandboxSession['startupStatus'] = 'verified';
    let startupDetail = launchPlan.summary;
    const startupProbe = executeSandboxCommand(launchPlan, 'bash', ['-lc', 'printf sandbox-ready'], {
      timeoutMs: 2000,
    });
    if (startupProbe.status !== 0 || !startupProbe.stdout.includes('sandbox-ready')) {
      state = 'failed';
      startupStatus = 'failed';
      startupDetail = (startupProbe.stderr || startupProbe.stdout || 'Sandbox backend startup probe failed.').trim();
    }
    const session: SandboxSession = Object.freeze({
      id: createSandboxSessionId(),
      profileId: profile.id,
      kind: inferKind(profile),
      label: label?.trim() || profile.label,
      shared: inferShared(profile),
      startedAt: Date.now(),
      state,
      backend: config.vmBackend,
      resolvedBackend: launchPlan.backend,
      launchPlan,
      startupStatus,
      startupDetail,
      notes: profile.notes,
    });
    this.sessions.set(session.id, session);
    return session;
  }

  public stop(sessionId: string): SandboxSession | null {
    const existing = this.sessions.get(sessionId);
    if (!existing) return null;
    return this.updateSession(sessionId, (session) => ({
      ...session,
      state: 'stopped',
    }));
  }

  public get(sessionId: string): SandboxSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  public execute(
    sessionId: string,
    command: string,
    args: readonly string[],
    options: {
      readonly cwd?: string | undefined;
      readonly env?: NodeJS.ProcessEnv | undefined;
      readonly inheritHostEnv?: boolean | undefined;
      readonly timeoutMs?: number | undefined;
      readonly input?: string | undefined;
    } = {},
  ): SandboxCommandResult {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`Unknown sandbox session: ${sessionId}`);
    }
    if (!session.launchPlan) {
      throw new Error(`Sandbox session ${sessionId} does not have a launch plan.`);
    }

    const resolvedPlan = resolveSandboxCommandPlan(command, args);
    const result = executeSandboxCommand(session.launchPlan, command, args, options);
    const stdoutPreview = (result.stdout || '').trim().slice(0, 200);
    const stderrPreview = (result.stderr || '').trim().slice(0, 200);
    const nextState: SandboxSession['state'] = result.status === 0
      ? (session.state === 'stopped' ? 'stopped' : 'running')
      : 'failed';

    this.updateSession(sessionId, (current) => ({
      ...current,
      state: nextState,
      lastRunAt: Date.now(),
      lastCommandSummary: resolvedPlan.summary,
      lastExitStatus: result.status,
      lastStdoutPreview: stdoutPreview || undefined,
      lastStderrPreview: stderrPreview || undefined,
      executionCount: (current.executionCount ?? 0) + 1,
    }));

    return result;
  }

  public exportArtifact(sessionId: string, targetPath: string, configManager: ConfigManagerLike): SandboxSessionArtifact {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`Unknown sandbox session: ${sessionId}`);
    }
    const artifact: SandboxSessionArtifact = {
      version: 1,
      exportedAt: Date.now(),
      session,
      reviewText: renderSandboxReview(configManager),
    };
    writeJsonFileAtomic(targetPath, artifact);
    return artifact;
  }

  public inspectArtifact(targetPath: string): SandboxSessionArtifact {
    return JSON.parse(readFileSync(targetPath, 'utf-8')) as SandboxSessionArtifact;
  }
}
