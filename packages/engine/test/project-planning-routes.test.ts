import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ProjectPlanningRoutes } from '../sdk/src/platform/daemon/http/project-planning-routes.js';
import { ProjectPlanningService } from '../sdk/src/platform/knowledge/index.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';

let previousPort: JudgmentPort | undefined;
beforeEach(() => { previousPort = installJudgmentPort(fakePort(() => noulAnswer(0.99)).port); });
afterEach(() => { installJudgmentPort(previousPort); });

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('project planning routes', () => {
  test('requires admin for writes and allows passive evaluation reads', async () => {
    installJudgmentPort(fakePort(() => noulAnswer(0.01)).port);
    const routes = createRoutes({ admin: false });
    const write = await routes.handle(jsonRequest('/api/projects/planning/state', {
      projectId: 'alpha',
      state: { goal: 'Add feature' },
    }));
    const evaluate = await routes.handle(jsonRequest('/api/projects/planning/evaluate', {
      projectId: 'alpha',
      state: { goal: 'Improve setup' },
    }));

    expect(write?.status).toBe(403);
    expect(evaluate?.status).toBe(200);
    const body = await evaluate!.json() as { readonly readiness: string; readonly gaps: readonly { readonly kind: string }[] };
    expect(body.readiness).toBe('needs-user-input');
    expect(body.gaps.some((gap) => gap.kind === 'ambiguous-language')).toBe(true);
  });

  test('persists state through the daemon route when admin is present', async () => {
    const routes = createRoutes({ admin: true });
    const saved = await routes.handle(jsonRequest('/api/projects/planning/state', {
      projectId: 'alpha',
      state: {
        goal: 'Add planning support',
        scope: 'SDK passive storage',
        tasks: [{ id: 'service', title: 'Build service', verification: ['unit tests'] }],
        verificationGates: [{ id: 'tests', description: 'Tests pass' }],
        executionApproved: true,
      },
    }));
    const loaded = await routes.handle(new Request('http://daemon.local/api/projects/planning/state?projectId=alpha'));

    expect(saved?.status).toBe(200);
    expect(loaded?.status).toBe(200);
    const body = await loaded!.json() as { readonly state: { readonly readiness: string; readonly goal: string }; readonly source: { readonly id: string }; readonly revision: { readonly sourceId: string; readonly generation: string } };
    expect(body.revision.sourceId).toBe(body.source.id);
    expect(body.revision.generation).toMatch(/^[a-f0-9]{64}$/);
    expect(body.state.goal).toBe('Add planning support');
    expect(body.state.readiness).toBe('executable');
  });

  test('exposes shared work-plan task routes with admin write protection', async () => {
    const blockedRoutes = createRoutes({ admin: false });
    const blocked = await blockedRoutes.handle(jsonRequest('/api/projects/planning/work-plan/tasks', {
      projectId: 'alpha',
      task: { title: 'Blocked write' },
    }));
    expect(blocked?.status).toBe(403);

    const routes = createRoutes({ admin: true });
    const created = await routes.handle(jsonRequest('/api/projects/planning/work-plan/tasks?projectId=alpha', {
      task: {
        title: 'Ship shared task model',
        owner: 'sdk',
        status: 'pending',
        contractId: 'ctr-1',
        originSurface: 'tui',
      },
    }));
    expect(created?.status).toBe(200);
    const createdBody = await created!.json() as { readonly task: { readonly taskId: string; readonly status: string } };
    expect(createdBody.task.status).toBe('pending');

    const status = await routes.handle(jsonRequest(
      `/api/projects/planning/work-plan/tasks/${encodeURIComponent(createdBody.task.taskId)}/status?projectId=alpha`,
      { status: 'done', reason: 'Verified' },
    ));
    expect(status?.status).toBe(200);

    const list = await routes.handle(new Request('http://daemon.local/api/projects/planning/work-plan/tasks?projectId=alpha'));
    expect(list?.status).toBe(200);
    const listBody = await list!.json() as {
      readonly counts: { readonly done: number };
      readonly tasks: readonly { readonly title: string; readonly status: string; readonly completedAt?: number }[];
    };
    expect(listBody.counts.done).toBe(1);
    expect(listBody.tasks[0]?.title).toBe('Ship shared task model');
    expect(typeof listBody.tasks[0]?.completedAt).toBe('number');
  });
});

function createRoutes(input: { readonly admin: boolean }): ProjectPlanningRoutes {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-project-planning-routes-'));
  tmpRoots.push(root);
  const service = new ProjectPlanningService(
    new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }),
    { defaultProjectId: 'default-project' },
  );
  return new ProjectPlanningRoutes({
    projectPlanningService: service,
    parseJsonBody: async (req) => await req.json() as Record<string, unknown>,
    parseOptionalJsonBody: async (req) => req.body ? await req.json() as Record<string, unknown> : null,
    requireAdmin: () => input.admin ? null : Response.json({ error: 'admin required' }, { status: 403 }),
  });
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://daemon.local${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}


test('an aborted HTTP planning request cannot publish a late semantic result', async () => {
  const routes = createRoutes({ admin: true });
  const fake = fakePort(() => noulAnswer(0.99));
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  installJudgmentPort({ ...fake.port, async ask(request) { entered(); await gate; return fake.port.ask(request); } });
  const controller = new AbortController();
  const request = new Request(jsonRequest('/api/projects/planning/state', {
    projectId: 'alpha', state: { goal: 'Cap retry delay at 30 seconds', scope: 'Retry helper', executionApproved: true,
      tasks: [{ id: 'retry', title: 'Cap delay', verification: ['Run retry tests'] }] },
  }), { signal: controller.signal });
  const pending = routes.handle(request);
  await started; controller.abort(); release();
  // The existing admin POST path propagates async service rejections.
  await expect(pending).rejects.toThrow();
  const status = await routes.handle(new Request('http://daemon.local/api/projects/planning/status?projectId=alpha'));
  expect(await status!.json()).toMatchObject({ counts: { states: 0, workPlans: 0 } });
});
