import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerBuiltinCapabilities } from '../../capabilities/builtin-capabilities.ts';
import {
  resetCapabilityIndexForTests,
  resolveCapabilityIndex,
} from '../../capabilities/capability-index.ts';
import { emptyProbeContext, type ProbeContext } from '../../capabilities/capability-probe-runner.ts';
import { buildCapabilitySummaryPrompt } from '../../agent/capability-summary-prompt.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/**
 * Pinned to the owner's actual machine state on the day this broke.
 *
 * He had all three files a gmail-mcp install writes, with granted scopes
 * covering mail and calendar and a live refresh token, and a direct Gmail API
 * send using them had already succeeded. The shipped binary told him email and
 * calendar "aren't currently wired into this build" and to add a Gmail MCP
 * server.
 *
 * Three separate defects produced that sentence, and each gets its own
 * assertion here:
 *   - the capability's only route was the operator method `email.send`, which
 *     the contract carries as invokable:false, so it resolved to `unavailable`
 *     before prerequisites were read;
 *   - the remediation text named an MCP server, which the native connector
 *     replaced;
 *   - the summary prompt rendered the whole thing under "Not wired up in this
 *     build".
 */

/**
 * Text that tells someone to stand up an MCP server for mail or calendar.
 * The owner ruled that out: the native connector replaced it. Matching on the
 * bare word would be wrong, credential paths contain ".gmail-mcp", and saying
 * "no MCP server is involved" is the correct message, not a violation.
 */
const MCP_INSTRUCTION = /(add|install|connect|configure)[^.]{0,60}MCP server/i;

let home = '';

/** Exactly the three files a gmail-mcp install leaves, with the owner's scope set. */
function writeOwnerCredentialLayout(root: string): void {
  const directory = join(root, '.gmail-mcp');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'gcp-oauth.keys.json'),
    JSON.stringify({
      installed: {
        client_id: 'test-client.apps.googleusercontent.com',
        client_secret: 'test-secret',
        token_uri: 'https://oauth2.googleapis.com/token',
        redirect_uris: ['http://localhost'],
      },
    }),
  );
  writeFileSync(
    join(directory, 'google-workspace-credentials.json'),
    JSON.stringify({
      access_token: 'test-access',
      refresh_token: 'test-refresh',
      scope: 'https://mail.google.com/ https://www.googleapis.com/auth/calendar',
      token_type: 'Bearer',
    }),
  );
  writeFileSync(
    join(directory, 'credentials.json'),
    JSON.stringify({
      access_token: 'test-access',
      refresh_token: 'test-refresh',
      scope: 'https://www.googleapis.com/auth/gmail.modify',
      token_type: 'Bearer',
      expiry_date: Date.now() + 3_600_000,
    }),
  );
}

/** The session as it really is once the google tool is registered. */
function ownerContext(overrides: Partial<ProbeContext> = {}): ProbeContext {
  return {
    ...emptyProbeContext(),
    registeredToolNames: new Set(['google', 'browser']),
    // The daemon serves no email or calendar method. This is the shipped
    // reality and the reason the old declaration could never resolve.
    servedOperatorMethodIds: new Set<string>(),
    configValuePresent: () => false,
    ...overrides,
  };
}

describe('capability index against the owner\'s machine state', () => {
  beforeEach(() => {
    home = makeProjectTempDir('owner-state');
    writeOwnerCredentialLayout(home);
    resetCapabilityIndexForTests();
    registerBuiltinCapabilities({ homeDirectory: home, workingDirectory: home });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    resetCapabilityIndexForTests();
  });

  test('email and calendar resolve as ready with credentials present and the connector registered', () => {
    const report = resolveCapabilityIndex(ownerContext(), { homeDirectory: home });

    expect(report.ready).toContain('email.send');
    expect(report.ready).toContain('email.read');
    expect(report.ready).toContain('calendar.read');
    expect(report.unavailable).not.toContain('email.send');
    expect(report.unavailable).not.toContain('calendar.read');
  });

  test('a ready capability names the route the model actually calls', () => {
    const report = resolveCapabilityIndex(ownerContext(), { homeDirectory: home });
    const send = report.capabilities.find((entry) => entry.id === 'email.send');

    expect(send?.state).toBe('ready');
    expect(send?.modelRoute).toContain('google action:"mail.send"');
    expect(send?.invocationKind).toBe('model-tool');
  });

  test('no served operator method is required for email to be usable', () => {
    // The regression: the old declaration's only route was an operator method
    // the daemon does not serve, so this exact context produced 'unavailable'.
    const report = resolveCapabilityIndex(
      ownerContext({ servedOperatorMethodIds: new Set<string>() }),
      { homeDirectory: home },
    );

    expect(report.capabilities.find((entry) => entry.id === 'email.send')?.state).toBe('ready');
  });

  test('the model is never told email is not wired up in this build', () => {
    const report = resolveCapabilityIndex(ownerContext(), { homeDirectory: home });
    const prompt = buildCapabilitySummaryPrompt(report) ?? '';

    expect(prompt).toContain('Send email');
    // The literal sentence the owner was shown, and the section that produced it.
    expect(prompt).not.toMatch(/Not wired up in this build:[\s\S]*Send email/);
    expect(prompt).not.toMatch(MCP_INSTRUCTION);
  });

  test('nothing anywhere tells the owner to add a Gmail MCP server', () => {
    const report = resolveCapabilityIndex(ownerContext(), { homeDirectory: home });
    const text = JSON.stringify(report);

    // The ban is on instructing an install, not on the letters appearing: the
    // credential paths legitimately contain ".gmail-mcp", and the remediation
    // now says an MCP server is NOT involved.
    expect(text).not.toMatch(MCP_INSTRUCTION);
    expect(text).not.toMatch(/setup-google/);
  });

  test('with no credentials at all it reports needs-setup naming the product\'s own step', () => {
    rmSync(join(home, '.gmail-mcp'), { recursive: true, force: true });
    const report = resolveCapabilityIndex(ownerContext(), { homeDirectory: home });
    const send = report.capabilities.find((entry) => entry.id === 'email.send');

    // The route still exists, so this is needs-setup rather than unavailable.
    expect(send?.state).toBe('needs-setup');
    expect(send?.fix).toContain('/google connect');
    expect(send?.fix).not.toMatch(MCP_INSTRUCTION);
  });

  test('credentials present but the connector unregistered is reported as a defect, not a refusal', () => {
    // If the tool ever stops being registered, the index must raise the
    // configured-but-unreported disagreement rather than quietly denying.
    const report = resolveCapabilityIndex(
      ownerContext({ registeredToolNames: new Set(['browser']) }),
      { homeDirectory: home },
    );

    expect(report.disagreements.length).toBeGreaterThan(0);
    const send = report.disagreements.find((entry) => entry.capabilityId === 'email.send');
    expect(send?.fix).toContain('/google adopt');
    expect(send?.fix).not.toMatch(MCP_INSTRUCTION);
  });
});
