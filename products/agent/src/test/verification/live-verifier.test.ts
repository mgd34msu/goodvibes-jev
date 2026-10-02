import { describe, expect, it } from 'bun:test';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LiveVerificationReport } from '../../verification/live-verifier.ts';
import {
  buildLiveVerificationReport,
  findAgentKnowledgeResponseContamination,
  renderLiveVerificationReportMarkdown,
  sanitizeLiveVerificationReport,
} from '../../verification/live-verifier.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const projectRoot = resolve(join(import.meta.dir, '..', '..', '..'));

interface FakeAgentBinaryOptions {
  readonly statusOutput?: string;
  readonly compatOutput: string;
  readonly compatExitCode: number;
  readonly knowledgeOutput: string;
  readonly knowledgeExitCode: number;
  readonly providersOutput?: string;
  readonly doctorOutput?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function writeFakeAgentBinary(root: string, options: FakeAgentBinaryOptions): string {
  const binaryPath = join(root, 'goodvibes-agent-fake');
  const script = [
    '#!/usr/bin/env bash',
    'set -eu',
    'normalized=()',
    'while (($# > 0)); do',
    '  case "$1" in',
    '    --runtime-url|--runtime)',
    '      shift',
    '      if (($# > 0)); then shift; fi',
    '      ;;',
    '    --runtime-url=*|--runtime=*)',
    '      shift',
    '      ;;',
    '    *)',
    '      normalized+=("$1")',
    '      shift',
    '      ;;',
    '  esac',
    'done',
    'set -- "${normalized[@]}"',
    'case "$*" in',
    '  "--version") printf "%s\\n" "0.0.0"; exit 0 ;;',
    `  "status --json") printf "%s\\n" ${shellQuote(options.statusOutput ?? '{"ok":true}')}; exit 0 ;;`,
    `  "compat --json") printf "%s\\n" ${shellQuote(options.compatOutput)}; exit ${options.compatExitCode} ;;`,
    `  "knowledge status --json") printf "%s\\n" ${shellQuote(options.knowledgeOutput)}; exit ${options.knowledgeExitCode} ;;`,
    `  "providers") printf "%s\\n" ${shellQuote(options.providersOutput ?? 'provider inventory')}; exit 0 ;;`,
    `  "doctor --output text") printf "%s\\n" ${shellQuote(options.doctorOutput ?? 'doctor ok')}; exit 0 ;;`,
    'esac',
    'printf "unexpected command: %s\\n" "$*" >&2',
    'exit 64',
    '',
  ].join('\n');
  writeFileSync(binaryPath, script, 'utf8');
  chmodSync(binaryPath, 0o755);
  return binaryPath;
}

describe('live verification report', () => {
  it('renders summary counts and check rows', () => {
    const report: LiveVerificationReport = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      homeDir: '/home/operator/.goodvibes',
      binaryPath: '/repo/dist/goodvibes-agent',
      connectedHostBaseUrl: 'http://127.0.0.1:3421',
      strict: false,
      counts: { pass: 2, warn: 1, fail: 0, skip: 0 },
      ok: true,
      checks: [
        {
          id: 'ledger',
          title: 'Verification inventory ledger',
          status: 'pass',
          summary: '100% local verification signal.',
        },
        {
          id: 'agent-knowledge-status',
          title: 'Agent Knowledge CLI status command',
          status: 'warn',
          summary: 'Agent Knowledge route is not available.',
          detail: '/api/goodvibes-agent/knowledge/status returned 404',
        },
      ],
    };

    const markdown = renderLiveVerificationReportMarkdown(report);

    expect(markdown).toContain('| pass | 2 |');
    // Raw filesystem paths in header fields are normalized to placeholders by the renderer
    // (defense-in-depth hardening: normalizeRenderedPath in renderLiveVerificationReportMarkdown).
    expect(markdown).toContain('Binary: `[agent-binary]`');
    expect(markdown).toContain('Connected host: `http://127.0.0.1:3421`');
    expect(markdown).not.toContain('daemonBaseUrl');
    expect(markdown).toContain('| Agent Knowledge CLI status command | warn | Agent Knowledge route is not available. |');
    expect(markdown).toContain('/api/goodvibes-agent/knowledge/status');
    expect(markdown).toContain('Result: PASS');
  });

  it('validates every model-visible Agent Knowledge read route during live verification', () => {
    const source = readFileSync(join(projectRoot, 'src/verification/live-verifier.ts'), 'utf8');
    const readRoutes = [
      '/api/goodvibes-agent/knowledge/sources',
      '/api/goodvibes-agent/knowledge/nodes',
      '/api/goodvibes-agent/knowledge/issues',
      '/api/goodvibes-agent/knowledge/map',
      '/api/goodvibes-agent/knowledge/connectors',
    ];

    for (const route of readRoutes) {
      expect(source).toContain(`route: '${route}'`);
    }
    expect(source).toContain('validateAgentKnowledgeJsonRoute');
    expect(source).toContain('for (const check of AGENT_KNOWLEDGE_READ_ROUTE_CHECKS)');
    expect(source).not.toContain('/api/knowledge/sources');
    expect(source).not.toContain('/api/knowledge/connectors');
  });

  it('normalizes Agent Knowledge JSON scope aliases and still detects non-Agent live responses', () => {
    expect(findAgentKnowledgeResponseContamination('{"ok":true,"spaceId":"default"}')).toBeNull();
    expect(findAgentKnowledgeResponseContamination('{"metadata":{"knowledgeSpaceId":"default","namespace":"default"}}')).toBeNull();
    expect(findAgentKnowledgeResponseContamination('spaceId: default')).toBe('default knowledge scope id');
    expect(findAgentKnowledgeResponseContamination('{"node":{"kind":"homeGraphDevice"}}')).toBe('homegraph');
    expect(findAgentKnowledgeResponseContamination('{"ok":true,"spaceId":"goodvibes-agent:default"}')).toBeNull();
  });

  it('sanitizes local paths, tokens, and private addresses before rendering release artifacts', () => {
    const report = sanitizeLiveVerificationReport({
      generatedAt: '2026-01-01T00:00:00.000Z',
      homeDir: '/home/operator/.goodvibes',
      binaryPath: '/workspace/goodvibes-agent/dist/goodvibes-agent',
      connectedHostBaseUrl: 'http://192.168.0.85:3421',
      strict: true,
      counts: { pass: 1, warn: 0, fail: 0, skip: 0 },
      ok: true,
      checks: [{
        id: 'status',
        title: 'Status',
        status: 'pass',
        summary: 'Found /workspace/goodvibes-agent/dist/goodvibes-agent with Bearer abc123',
        detail: '{"token":"secret","path":"/home/operator/.goodvibes/daemon/operator-tokens.json","cwd":"/workspace/goodvibes-agent","host":"192.168.0.85"}',
      }],
    }, {
      homeDir: '/home/operator/.goodvibes',
      userHomeDir: '/home/operator',
      projectRoot: '/workspace/goodvibes-agent',
      binaryPath: '/workspace/goodvibes-agent/dist/goodvibes-agent',
    });

    const rendered = JSON.stringify(report) + '\n' + renderLiveVerificationReportMarkdown(report);

    expect(report.homeDir).toBe('[goodvibes-home]');
    expect(report.binaryPath).toBe('[agent-binary]');
    expect(report.connectedHostBaseUrl).toBe('http://[private-ip]:3421');
    expect(rendered).toContain('[goodvibes-home]');
    expect(rendered).toContain('[agent-binary]');
    expect(rendered).toContain('[project-root]');
    expect(rendered).toContain('[private-ip]');
    expect(rendered).toContain('Bearer [redacted]');
    expect(rendered).toContain('"token":"[redacted]"');
    expect(rendered).not.toContain('/home/operator');
    expect(rendered).not.toContain('/workspace/goodvibes-agent');
    expect(rendered).not.toContain('192.168.0.85');
    expect(rendered).not.toContain('abc123');
    expect(rendered).not.toContain('secret');
  });

  it('renderer strips private IPs and token patterns from header values even without sanitization', () => {
    // D5: renderLiveVerificationReportMarkdown must apply redact() + redactPrivateNetworkAddresses()
    // to header values as defense-in-depth. Local path replacement requires context that the renderer
    // does not have (use sanitizeLiveVerificationReport for full path stripping), but the renderer
    // must at minimum strip private IPs and embedded token/bearer patterns.
    const unsanitized: LiveVerificationReport = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      homeDir: '[goodvibes-home]',   // already a placeholder (normal sanitized case)
      binaryPath: 'token=supersecret', // a token-bearing value must be stripped by the renderer
      connectedHostBaseUrl: 'http://192.168.1.50:3421', // private IP must be stripped
      strict: false,
      counts: { pass: 1, warn: 0, fail: 0, skip: 0 },
      ok: true,
      checks: [{ id: 'test', title: 'Test', status: 'pass', summary: 'ok' }],
    };

    const rendered = renderLiveVerificationReportMarkdown(unsanitized);

    // Private IP must be replaced by [private-ip].
    expect(rendered).not.toContain('192.168.1.50');
    expect(rendered).toContain('[private-ip]');
    // Token pattern must be redacted by the renderer.
    expect(rendered).not.toContain('supersecret');
    // The header lines must still be present.
    expect(rendered).toContain('Home:');
    expect(rendered).toContain('Binary:');
    expect(rendered).toContain('Connected host:');
  });

  it('renderer normalizes raw filesystem paths in header values to sanitized placeholders', () => {
    // Hardening: even when sanitizeLiveVerificationReport is NOT called first,
    // the renderer must not echo a raw filesystem path for homeDir or binaryPath.
    // normalizeRenderedPath in renderLiveVerificationReportMarkdown detects /- or ~-leading
    // values and replaces them with the canonical placeholder.
    const unsanitized: LiveVerificationReport = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      homeDir: '/home/operator/.goodvibes',          // raw path, starts with /
      binaryPath: '/workspace/goodvibes-agent/dist/goodvibes-agent', // raw path, starts with /
      connectedHostBaseUrl: 'http://127.0.0.1:3421',
      strict: false,
      counts: { pass: 1, warn: 0, fail: 0, skip: 0 },
      ok: true,
      checks: [{ id: 'test', title: 'Test', status: 'pass', summary: 'ok' }],
    };

    const rendered = renderLiveVerificationReportMarkdown(unsanitized);

    // Raw paths must not appear in the rendered output.
    expect(rendered).not.toContain('/home/operator');
    expect(rendered).not.toContain('/workspace/goodvibes-agent');
    // Canonical placeholders must be present instead.
    expect(rendered).toContain('[goodvibes-home]');
    expect(rendered).toContain('[agent-binary]');
    // Header lines must still be present.
    expect(rendered).toContain('Home: `[goodvibes-home]`');
    expect(rendered).toContain('Binary: `[agent-binary]`');
  });

  it('redacts raw operator token when it appears outside Bearer or JSON token shapes', () => {
    // This test MUST fail before D1 fix (no literal token replacement) and pass after.
    const token = 'tok_abc123xyz';
    const report = sanitizeLiveVerificationReport({
      generatedAt: '2026-01-01T00:00:00.000Z',
      homeDir: '/home/operator/.goodvibes',
      binaryPath: '/workspace/goodvibes-agent/dist/goodvibes-agent',
      connectedHostBaseUrl: 'http://127.0.0.1:3421',
      strict: false,
      counts: { pass: 0, warn: 0, fail: 1, skip: 0 },
      ok: false,
      checks: [
        {
          id: 'connected-host-status',
          title: 'Connected host status',
          status: 'fail',
          summary: `login failed for token ${token}`,
          detail: `url=http://127.0.0.1:3421/status?access_token=${token}&retry=1`,
        },
      ],
    }, {
      homeDir: '/home/operator/.goodvibes',
      userHomeDir: '/home/operator',
      projectRoot: '/workspace/goodvibes-agent',
      binaryPath: '/workspace/goodvibes-agent/dist/goodvibes-agent',
      tokens: [token],
    });

    const rendered = JSON.stringify(report) + '\n' + renderLiveVerificationReportMarkdown(report);

    // The raw token must not appear in any shape in the release artifact
    expect(rendered).not.toContain(token);
    expect(rendered).not.toContain('tok_abc123xyz');
    // Redaction placeholders must be present instead
    expect(rendered).toContain('[redacted]');
  });

  it('fails warn-only JSON command checks when the JSON contract is broken', async () => {
    const root = makeProjectTempDir('goodvibes-live-verifier');
    try {
      const binaryPath = writeFakeAgentBinary(root, {
        compatOutput: 'not json',
        compatExitCode: 2,
        knowledgeOutput: '{"status":"unavailable"}',
        knowledgeExitCode: 1,
      });

      const report = await buildLiveVerificationReport({
        homeDir: join(root, 'home'),
        binaryPath,
        projectRoot,
      });
      const compatCheck = report.checks.find((check) => check.id === 'cli-compat-json');

      expect(compatCheck?.status).toBe('fail');
      expect(compatCheck?.summary).toBe('Command exited 2 and did not return valid JSON.');
      expect(report.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps nonzero JSON command checks warn-only when output remains parseable', async () => {
    const root = makeProjectTempDir('goodvibes-live-verifier');
    try {
      const binaryPath = writeFakeAgentBinary(root, {
        compatOutput: '{"compatible":false}',
        compatExitCode: 2,
        knowledgeOutput: '{"status":"unavailable"}',
        knowledgeExitCode: 1,
      });

      const report = await buildLiveVerificationReport({
        homeDir: join(root, 'home'),
        binaryPath,
        projectRoot,
      });
      const compatCheck = report.checks.find((check) => check.id === 'cli-compat-json');
      const knowledgeCheck = report.checks.find((check) => check.id === 'cli-agent-knowledge-status');

      expect(compatCheck?.status).toBe('warn');
      expect(compatCheck?.summary).toBe('Command exited 2.');
      expect(knowledgeCheck?.status).toBe('warn');
      expect(report.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('omits local provider and model details from release artifacts', async () => {
    const root = makeProjectTempDir('goodvibes-live-verifier');
    try {
      const binaryPath = writeFakeAgentBinary(root, {
        statusOutput: '{"provider":{"provider":"anthropic","model":"anthropic:configured-model"},"ok":true}',
        compatOutput: '{"compatible":false}',
        compatExitCode: 2,
        knowledgeOutput: '{"status":"unavailable"}',
        knowledgeExitCode: 1,
        providersOutput: 'anthropic setup api-key configured yes via api-key',
        doctorOutput: 'Provider\n  provider anthropic\n  model anthropic:configured-model\nAuth\n  setup credential present',
      });

      const report = await buildLiveVerificationReport({
        homeDir: join(root, 'home'),
        binaryPath,
        projectRoot,
      });
      const statusCheck = report.checks.find((check) => check.id === 'cli-status-json');
      const providersCheck = report.checks.find((check) => check.id === 'cli-providers');
      const doctorCheck = report.checks.find((check) => check.id === 'cli-doctor');
      const rendered = renderLiveVerificationReportMarkdown(report);

      expect(statusCheck?.status).toBe('pass');
      expect(statusCheck?.detail).toBe('Status JSON command completed; provider/model identifiers omitted from release artifact.');
      expect(providersCheck?.status).toBe('pass');
      expect(providersCheck?.detail).toBe('Provider inventory command completed; provider names and credential posture omitted from release artifact.');
      expect(doctorCheck?.status).toBe('pass');
      expect(doctorCheck?.detail).toBe('Doctor command completed without findings; provider/model identifiers and credential posture omitted from release artifact.');
      expect(rendered).not.toContain('anthropic setup api-key configured yes');
      expect(rendered).not.toContain('anthropic:configured-model');
      expect(rendered).not.toContain('setup credential present');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// doctorRiskAdvisoryOnlyCount, advisory-only doctor exits must not block a
// strict release verification; real errors and crashes still must.
// ---------------------------------------------------------------------------

import { doctorRiskAdvisoryOnlyCount } from '../../verification/live-verifier.ts';

describe('doctorRiskAdvisoryOnlyCount', () => {
  const advisoryOutput = [
    'GoodVibes Agent doctor',
    '  provider openai',
    'Warnings',
    '  - [risk:security:auto-approve-enabled] Auto-approve is on: tool calls never prompt.',
    '    cause: behavior.autoApprove is true.',
  ].join('\n');

  it('exit 0 → zero advisories (clean pass)', () => {
    expect(doctorRiskAdvisoryOnlyCount({ exitCode: 0, stdout: advisoryOutput })).toBe(0);
  });

  it('exit 1 with only [risk:*] advisories → advisory count (acceptable)', () => {
    expect(doctorRiskAdvisoryOnlyCount({ exitCode: 1, stdout: advisoryOutput })).toBe(1);
  });

  it('exit 1 with an Errors section → null (real problem, still blocks)', () => {
    const out = `${advisoryOutput}\nErrors\n  - [config:invalid] provider block malformed.`;
    expect(doctorRiskAdvisoryOnlyCount({ exitCode: 1, stdout: out })).toBeNull();
  });

  it('exit 1 with a non-risk finding → null', () => {
    const out = ['Warnings', '  - [config:missing-model] No model configured.'].join('\n');
    expect(doctorRiskAdvisoryOnlyCount({ exitCode: 1, stdout: out })).toBeNull();
  });

  it('exit 1 with no parseable findings (crash-ish output) → null', () => {
    expect(doctorRiskAdvisoryOnlyCount({ exitCode: 1, stdout: 'TypeError: boom' })).toBeNull();
  });

  it('other exit codes → null regardless of output', () => {
    expect(doctorRiskAdvisoryOnlyCount({ exitCode: 2, stdout: advisoryOutput })).toBeNull();
  });
});
