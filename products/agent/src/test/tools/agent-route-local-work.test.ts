import { describe, expect, test } from 'bun:test';
import { useRouteAdapterFixture, route, preferredId } from '../helpers/route-adapter-fixture.ts';

useRouteAdapterFixture();

describe("Local work and recovery route adapters", () => {

  test('routes parallel coding work to delegated build posture', async () => {
    const body = await route('fix the failing tests in parallel');

    expect(preferredId(body)).toBe('delegated-build-work');
    expect(body.preferred).toMatchObject({
      modelRoute: 'delegation action:"status" includeParameters:true',
      requiresConfirmation: true,
    });
  });


  test('routes daemon health checks to connected-host diagnostics', async () => {
    const body = await route('check daemon health');

    expect(preferredId(body)).toBe('host-runtime-diagnostics');
    expect(body.preferred).toMatchObject({
      modelRoute: 'host action:"status" includeParameters:true',
      inspectRoute: 'host action:"capabilities" includeParameters:true',
      requiresConfirmation: false,
    });
  });


  test('routes normal settings requests to the first-class settings tool', async () => {
    const body = await route('change the theme setting');

    expect(preferredId(body)).toBe('agent-settings-configuration');
    expect(body.preferred).toMatchObject({
      modelRoute: 'settings action:"list" query:"change the theme setting" includeParameters:true',
      inspectRoute: 'settings action:"list" includeParameters:true',
      requiresConfirmation: true,
    });
  });


  test('routes support bundle export requests to redacted bundle posture first', async () => {
    const body = await route('export a support bundle for diagnostics');

    expect(preferredId(body)).toBe('support-bundle-route');
    expect(body.preferred).toMatchObject({
      modelRoute: 'support action:"status" query:"export a support bundle for diagnostics" includeParameters:true',
      inspectRoute: 'support action:"status" includeParameters:true',
      requiresConfirmation: true,
    });
  });


  test('routes saved session searches to the session catalog', async () => {
    const body = await route('search saved sessions for the onboarding thread');

    expect(preferredId(body)).toBe('saved-session-route');
    expect(body.preferred).toMatchObject({
      modelRoute: 'sessions action:"list" query:"search saved sessions for the onboarding thread" includeParameters:true',
      inspectRoute: 'sessions action:"list" includeParameters:true',
      requiresConfirmation: false,
    });
  });


  test('routes release readiness questions to the audit inventory', async () => {
    const body = await route('show release readiness inventory');

    expect(preferredId(body)).toBe('release-readiness-route');
    expect(body.preferred).toMatchObject({
      modelRoute: 'audit action:"readiness" query:"show release readiness inventory" includeParameters:true',
      inspectRoute: 'audit action:"readiness" includeParameters:true',
      requiresConfirmation: false,
    });
  });


  test('routes release evidence questions to evidence artifacts', async () => {
    const body = await route('inspect release evidence artifact live verification');

    expect(preferredId(body)).toBe('release-evidence-route');
    expect(body.preferred).toMatchObject({
      modelRoute: 'audit action:"evidence" query:"inspect release evidence artifact live verification" includeParameters:true',
      inspectRoute: 'audit action:"evidence" includeParameters:true',
      requiresConfirmation: false,
    });
  });


  test('routes command-shaped background work to local process controls', async () => {
    const body = await route('run pytest -v tests/ in background');

    expect(preferredId(body)).toBe('local-background-process');
    expect(body.preferred).toMatchObject({
      modelRoute: 'execution action:"processes" includeParameters:true',
      inspectRoute: 'execution action:"capabilities"',
      requiresConfirmation: true,
    });
  });


  test('routes interactive terminal and sudo requests to process capability posture first', async () => {
    const body = await route('run claude code with pty=true and handle sudo prompts');

    expect(preferredId(body)).toBe('interactive-process-capability');
    expect(body.preferred).toMatchObject({
      modelRoute: 'execution action:"process_capabilities"',
      inspectRoute: 'setup action:"item" setupItemId:"sudo-execution-posture"',
      requiresConfirmation: true,
    });
  });


  test('does not confuse process documentation wording with stdin process control', async () => {
    const body = await route('write process documentation');

    expect(preferredId(body)).not.toBe('interactive-process-capability');
  });


  test('routes file undo requests to recovery inspection', async () => {
    const body = await route('undo the last file edit');

    expect(preferredId(body)).toBe('local-file-recovery');
    expect(body.preferred).toMatchObject({
      modelRoute: 'execution action:"recovery" includeParameters:true',
      inspectRoute: 'execution action:"history" includeParameters:true',
      requiresConfirmation: true,
    });
  });
});
