import { describe, expect, test } from 'bun:test';
import { useRouteAdapterFixture, route, preferredId } from '../helpers/route-adapter-fixture.ts';

useRouteAdapterFixture();

describe("Research, browser and media route adapters", () => {

  test('routes one-off deep research to the research planner', async () => {
    const body = await route('do deep research on the market map and cite sources');

    expect(preferredId(body)).toBe('deep-research-workflow');
    expect(body.preferred).toMatchObject({
      inspectRoute: 'research action:"briefing"',
      userSurface: 'Research workspace',
    });
  });


  test('routes recurring research reports through visible autonomy intake', async () => {
    const body = await route('run a weekly source-backed research report');

    expect(preferredId(body)).toBe('autonomy-intake');
    expect(body.preferred).toMatchObject({
      modelRoute: 'autonomy action:"intake" query:"run a weekly source-backed research report" includeParameters:true',
      requiresConfirmation: true,
    });
  });


  test('sends a request to act on a web page to the browser tool', async () => {
    // Discoverability: a model asking how to open and act on a page must be
    // pointed at the tool that does it, not at a planner that describes it.
    const body = await route('log in to my account on example.com and download the invoice');

    expect(preferredId(body)).toBe('drive-a-browser');
    expect(body.preferred).toMatchObject({
      modelRoute: 'browser action:"navigate" url:"..."',
      inspectRoute: 'browser action:"status"',
    });
  });


  test('sends a request to fill in a form on a site to the browser tool', async () => {
    const body = await route('fill out the contact form on the website and submit it');

    expect(preferredId(body)).toBe('drive-a-browser');
    expect(body.preferred).toMatchObject({ requiresConfirmation: true });
  });


  test('keeps a screen capture request on the desktop-control planner', async () => {
    // Capturing the screen is desktop control, not browsing.
    const body = await route('take a screenshot of the screen');

    expect(preferredId(body)).not.toBe('drive-a-browser');
  });


  test('routes browser-backed research runner wording to runner readiness', async () => {
    const body = await route('check browser-backed research runner readiness');

    expect(preferredId(body)).toBe('research-browser-runner-readiness');
    expect(body.preferred).toMatchObject({
      modelRoute: 'research action:"runner" query:"check browser-backed research runner readiness" includeParameters:true',
      inspectRoute: 'research action:"runner" includeParameters:true',
      requiresConfirmation: false,
    });
  });


  test('routes visual research report rendering to the report workflow contract', async () => {
    const body = await route('render the visual research report in the browser');

    expect(preferredId(body)).toBe('research-visual-report-workflow');
    expect(body.preferred).toMatchObject({
      modelRoute: 'research action:"plan" query:"render the visual research report in the browser" includeParameters:true',
      inspectRoute: 'research action:"reports" query:"visual report" includeParameters:true',
      requiresConfirmation: true,
    });
  });


  test('does not treat generic market risk research as a security policy question', async () => {
    const body = await route('research market risk with citations');

    expect(preferredId(body)).toBe('deep-research-workflow');
  });


  test('routes screenshot and browser-control tasks through the computer planner', async () => {
    const body = await route('take a screenshot of the logged-in browser dashboard');

    expect(preferredId(body)).toBe('browser-control-workflow-plan');
    expect(body.preferred).toMatchObject({
      modelRoute: 'computer action:"plan" query:"take a screenshot of the logged-in browser dashboard" includeParameters:true',
      inspectRoute: 'computer action:"control" includeParameters:true',
      requiresConfirmation: true,
    });
  });


  test('routes image generation through confirmed media artifacts', async () => {
    const body = await route('generate an image of a clean product dashboard');

    expect(preferredId(body)).toBe('media-generation-artifact');
    expect(body.preferred).toMatchObject({
      modelRoute: 'device action:"provider" target:"media" includeParameters:true',
      inspectRoute: 'agent_harness mode:"media_posture" includeParameters:true',
      requiresConfirmation: true,
    });
  });


  test('routes voice workflow requests through voice posture', async () => {
    const body = await route('set up push-to-talk and voice memo transcription');

    expect(preferredId(body)).toBe('voice-workflow-posture');
    expect(body.preferred).toMatchObject({
      modelRoute: 'device action:"voice" query:"set up push-to-talk and voice memo transcription" includeParameters:true',
      inspectRoute: 'device action:"voice" includeParameters:true',
      requiresConfirmation: true,
    });
  });


  test('routes TTS provider setup through provider posture', async () => {
    const body = await route('choose a TTS provider for spoken responses');

    expect(preferredId(body)).toBe('tts-provider-posture');
    expect(body.preferred).toMatchObject({
      modelRoute: 'device action:"provider" target:"tts" includeParameters:true',
      inspectRoute: 'device action:"voice" includeParameters:true',
      requiresConfirmation: true,
    });
  });


  test('keeps plain browser-open requests on the Browser/PWA readiness route', async () => {
    const body = await route('open the browser dashboard');

    expect(preferredId(body)).toBe('browser-cockpit-readiness');
    expect(body.preferred).toMatchObject({
      modelRoute: 'computer action:"browser" includeParameters:true',
      inspectRoute: 'workspace action:"surface" surfaceId:"connected-browser-cockpit" includeParameters:true',
      requiresConfirmation: true,
    });
  });
});
