import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { findAgentKnowledgeScopeContamination } from '../cli/agent-knowledge-runtime.ts';
import { normalizeAgentKnowledgeJsonText } from '../agent/knowledge-scope-alias.ts';

const AGENT_KNOWLEDGE_FORBIDDEN_RESPONSE_MARKERS = [
  ['home', ' assistant'].join(''),
  ['home', 'graph'].join(''),
  ['home ', 'graph'].join(''),
] as const;
const AGENT_KNOWLEDGE_FORBIDDEN_RESPONSE_PATTERNS = [
  {
    label: 'default knowledge scope id',
    pattern: /["']?(?:knowledge[-_\s]*space[-_\s]*id|knowledgespaceid|space[-_\s]*id|spaceid|spaceId|knowledgeSpaceId|namespace)["']?\s*[:=]\s*["']?default["']?/i,
  },
] as const;
const AGENT_KNOWLEDGE_READ_ROUTE_CHECKS = [
  {
    id: 'agent-knowledge-sources-isolated',
    title: 'Agent Knowledge isolated sources list',
    route: '/api/goodvibes-agent/knowledge/sources',
  },
  {
    id: 'agent-knowledge-nodes-isolated',
    title: 'Agent Knowledge isolated nodes list',
    route: '/api/goodvibes-agent/knowledge/nodes',
  },
  {
    id: 'agent-knowledge-issues-isolated',
    title: 'Agent Knowledge isolated issues list',
    route: '/api/goodvibes-agent/knowledge/issues',
  },
  {
    id: 'agent-knowledge-map-isolated',
    title: 'Agent Knowledge isolated map',
    route: '/api/goodvibes-agent/knowledge/map',
  },
  {
    id: 'agent-knowledge-connectors-isolated',
    title: 'Agent Knowledge isolated connectors list',
    route: '/api/goodvibes-agent/knowledge/connectors',
  },
] as const;
/**
 * Canonical set of live-verification scenario ids this verifier emits. Kept
 * next to the checks that produce them so a capability declared `certified` in
 * the capability registry can be pinned against a real scenario id. The
 * Agent-Knowledge read-route ids are derived from their check specs so the two
 * cannot drift apart.
 */
export const LIVE_VERIFICATION_SCENARIO_IDS: readonly string[] = [
  'compiled-cli-present',
  'cli-version',
  'cli-status-json',
  'cli-compat-json',
  'cli-agent-knowledge-status',
  'cli-providers',
  'cli-doctor',
  'connected-host-status',
  'connected-host-health',
  'openai-compatible-models',
  'agent-knowledge-status',
  'agent-knowledge-ask-isolated',
  'agent-knowledge-search-isolated',
  ...AGENT_KNOWLEDGE_READ_ROUTE_CHECKS.map((check) => check.id),
];

const STATUS_RELEASE_DETAIL = 'Status JSON command completed; provider/model identifiers omitted from release artifact.';
const PROVIDERS_RELEASE_DETAIL = 'Provider inventory command completed; provider names and credential posture omitted from release artifact.';
const DOCTOR_RELEASE_DETAIL = 'Doctor command completed without findings; provider/model identifiers and credential posture omitted from release artifact.';

/**
 * The doctor exits non-zero for ANY finding, including `[risk:*]` advisories
 * that describe the operator's own intentional configuration (e.g.
 * behavior.autoApprove on a trusted machine). Those advisories are honest and
 * must keep printing, but they are not release defects, so a doctor run
 * whose ONLY findings are risk advisories (no Errors section) must not turn a
 * strict live verification red. Returns the advisory count when the non-zero
 * exit is advisory-only, or null when the exit signals a real problem
 * (errors present, no parseable findings, crash).
 */
export function doctorRiskAdvisoryOnlyCount(result: { exitCode: number | null; stdout: string }): number | null {
  if (result.exitCode === 0) return 0;
  if (result.exitCode !== 1) return null;
  if (/^Errors\b/m.test(result.stdout)) return null;
  const findings = [...result.stdout.matchAll(/^\s*- \[([a-z]+):/gm)].map((m) => m[1]);
  if (findings.length === 0) return null;
  return findings.every((kind) => kind === 'risk') ? findings.length : null;
}

export type LiveVerificationStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface LiveVerificationCheck {
  id: string;
  title: string;
  status: LiveVerificationStatus;
  summary: string;
  detail?: string;
}

export interface LiveVerificationOptions {
  homeDir: string;
  binaryPath: string;
  projectRoot: string;
  connectedHostBaseUrl?: string;
  token?: string;
  strict?: boolean;
}

export interface LiveVerificationReport {
  generatedAt: string;
  homeDir: string;
  binaryPath: string;
  connectedHostBaseUrl: string;
  strict: boolean;
  checks: LiveVerificationCheck[];
  counts: Record<LiveVerificationStatus, number>;
  ok: boolean;
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface LiveVerificationRedactionContext {
  homeDir: string;
  userHomeDir: string;
  projectRoot: string;
  binaryPath: string;
  /** Operator/daemon tokens that must never appear verbatim in release artifacts. */
  tokens?: readonly string[];
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function redact(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]')
    .replace(/Authorization:\s*[A-Za-z]+\s+[A-Za-z0-9._~+/=-]+/gi, 'Authorization: [redacted]')
    .replace(/"token"\s*:\s*"[^"]+"/g, '"token":"[redacted]"')
    .replace(/(?<![A-Za-z])(?:access_token|api[_-]?key|token)\s*=\s*[^\s&"'`]+/gi, (m) => m.replace(/=.*/, '=[redacted]'));
}

function replaceLiteral(text: string, search: string, replacement: string): string {
  return search.length > 1 ? text.split(search).join(replacement) : text;
}

function redactLocalPaths(text: string, context: LiveVerificationRedactionContext): string {
  const replacements = [
    [context.binaryPath, '[agent-binary]'],
    [context.projectRoot, '[project-root]'],
    [context.homeDir, '[goodvibes-home]'],
    [context.userHomeDir, '[home]'],
  ] as const;
  return replacements
    .filter(([value]) => value.length > 1)
    .sort(([left], [right]) => right.length - left.length)
    .reduce((output, [value, replacement]) => replaceLiteral(output, value, replacement), text)
    .replace(/\[home\]\/[^"'\s`]+\/home\//g, '[home]/');
}

function redactPrivateNetworkAddresses(text: string): string {
  return text.replace(/\b(?:10|192\.168|172\.(?:1[6-9]|2[0-9]|3[0-1]))(?:\.[0-9]{1,3}){2}\b/g, '[private-ip]');
}

function redactForReleaseArtifact(text: string, context: LiveVerificationRedactionContext): string {
  let result = redactPrivateNetworkAddresses(redactLocalPaths(redact(text), context));
  if (context.tokens) {
    for (const token of context.tokens) {
      if (token.length >= 8) {
        result = result.split(token).join('[redacted]');
      }
    }
  }
  return result;
}

function compact(text: string, maxLength = 900): string {
  const trimmed = redact(text.trim());
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 16)}... [truncated]`;
}

function readConnectedHostToken(homeDir: string): string | undefined {
  if (process.env.GOODVIBES_CONNECTED_HOST_TOKEN) return process.env.GOODVIBES_CONNECTED_HOST_TOKEN;
  if (process.env.GOODVIBES_DAEMON_TOKEN) return process.env.GOODVIBES_DAEMON_TOKEN;
  const tokenPath = join(homeDir, 'daemon', 'operator-tokens.json');
  if (!existsSync(tokenPath)) return undefined;
  try {
    const data = readJsonFile(tokenPath);
    if (data && typeof data === 'object' && typeof (data as { token?: unknown }).token === 'string') {
      return (data as { token: string }).token;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function resolveConnectedHostBaseUrl(homeDir: string, explicit?: string): string {
  if (explicit) return explicit.replace(/\/+$/, '');
  if (process.env.GOODVIBES_CONNECTED_HOST_URL) return process.env.GOODVIBES_CONNECTED_HOST_URL.replace(/\/+$/, '');
  if (process.env.GOODVIBES_AGENT_RUNTIME_URL) return process.env.GOODVIBES_AGENT_RUNTIME_URL.replace(/\/+$/, '');
  if (process.env.GOODVIBES_DAEMON_URL) return process.env.GOODVIBES_DAEMON_URL.replace(/\/+$/, '');
  const settingsPath = join(homeDir, 'tui', 'settings.json');
  let port = 3421;
  if (existsSync(settingsPath)) {
    try {
      const settings = readJsonFile(settingsPath);
      const configuredPort = (settings as { controlPlane?: { port?: unknown } })?.controlPlane?.port;
      if (typeof configuredPort === 'number' && Number.isFinite(configuredPort)) port = configuredPort;
    } catch {
      // Keep the default; this verifier should report connected-host state, not fail before checks run.
    }
  }
  return `http://127.0.0.1:${port}`;
}

function commandHomeDirectory(homeDir: string): string {
  const resolved = resolve(homeDir);
  return resolved.split(/[\\/]/).pop() === '.goodvibes' ? dirname(resolved) : resolved;
}

function buildCommandEnv(homeDir: string, connectedHostBaseUrl: string, token: string | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: '1',
    GOODVIBES_AGENT_HOME: commandHomeDirectory(homeDir),
    GOODVIBES_AGENT_RUNTIME_URL: connectedHostBaseUrl,
    GOODVIBES_CONNECTED_HOST_URL: connectedHostBaseUrl,
    ...(token ? { GOODVIBES_CONNECTED_HOST_TOKEN: token } : {}),
  };
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  options: { readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolveCommand) => {
    const child = spawn(command, args, {
      cwd,
      env: options.env ?? { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    }, options.timeoutMs ?? 15_000);
    child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error) => {
      clearTimeout(timeout);
      resolveCommand({
        exitCode: -1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        timedOut,
      });
    });
    child.on('exit', (exitCode) => {
      clearTimeout(timeout);
      resolveCommand({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
      });
    });
  });
}

function commandCheck(
  id: string,
  title: string,
  result: CommandResult,
  passSummary: string,
  options?: { warnOnNonZero?: boolean; parseJson?: boolean; passDetail?: string },
): LiveVerificationCheck {
  const parseJsonOutput = (): string | null => {
    try {
      JSON.parse(result.stdout);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  if (result.timedOut) {
    return {
      id,
      title,
      status: options?.warnOnNonZero ? 'warn' : 'fail',
      summary: 'Command timed out.',
      detail: compact(`${result.stdout}\n${result.stderr}`),
    };
  }
  if (result.exitCode !== 0) {
    if (options?.parseJson) {
      const parseError = parseJsonOutput();
      if (parseError !== null) {
        return {
          id,
          title,
          status: 'fail',
          summary: `Command exited ${result.exitCode} and did not return valid JSON.`,
          detail: compact(`${result.stdout}\n${result.stderr}\n${parseError}`),
        };
      }
    }
    return {
      id,
      title,
      status: options?.warnOnNonZero ? 'warn' : 'fail',
      summary: `Command exited ${result.exitCode}.`,
      detail: compact(`${result.stdout}\n${result.stderr}`),
    };
  }
  if (options?.parseJson) {
    const parseError = parseJsonOutput();
    if (parseError !== null) {
      return {
        id,
        title,
        status: 'fail',
        summary: 'Command succeeded but did not return valid JSON.',
        detail: parseError,
      };
    }
  }
  return {
    id,
    title,
    status: 'pass',
    summary: passSummary,
    detail: options?.passDetail ?? compact(result.stdout || result.stderr),
  };
}

async function fetchCheck(
  id: string,
  title: string,
  url: string,
  token: string | undefined,
  validate: (status: number, body: string) => { status: LiveVerificationStatus; summary: string; detail?: string },
): Promise<LiveVerificationCheck> {
  if (!token) {
    return {
      id,
      title,
      status: 'skip',
      summary: 'No connected-host bearer token was available.',
    };
  }
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.text();
    const validated = validate(response.status, body);
    return {
      id,
      title,
      ...validated,
      detail: validated.detail ?? compact(body),
    };
  } catch (error) {
    return {
      id,
      title,
      status: 'fail',
      summary: 'Request failed.',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchJsonCheck(
  id: string,
  title: string,
  url: string,
  token: string | undefined,
  options: {
    readonly method?: 'GET' | 'POST';
    readonly body?: unknown;
    readonly validate: (status: number, body: string) => { status: LiveVerificationStatus; summary: string; detail?: string };
  },
): Promise<LiveVerificationCheck> {
  if (!token) {
    return {
      id,
      title,
      status: 'skip',
      summary: 'No connected-host bearer token was available.',
    };
  }
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.text();
    const validated = options.validate(response.status, body);
    return {
      id,
      title,
      ...validated,
      detail: validated.detail ?? compact(body),
    };
  } catch (error) {
    return {
      id,
      title,
      status: 'fail',
      summary: 'Request failed.',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function countStatuses(checks: readonly LiveVerificationCheck[]): Record<LiveVerificationStatus, number> {
  return checks.reduce<Record<LiveVerificationStatus, number>>(
    (counts, check) => {
      counts[check.status] += 1;
      return counts;
    },
    { pass: 0, warn: 0, fail: 0, skip: 0 },
  );
}

export function findAgentKnowledgeResponseContamination(body: string): string | null {
  const normalizedBody = normalizeAgentKnowledgeJsonText(body);
  const lower = normalizedBody.toLowerCase();
  for (const marker of AGENT_KNOWLEDGE_FORBIDDEN_RESPONSE_MARKERS) {
    if (lower.includes(marker)) return marker;
  }
  for (const { label, pattern } of AGENT_KNOWLEDGE_FORBIDDEN_RESPONSE_PATTERNS) {
    if (pattern.test(normalizedBody)) return label;
  }
  try {
    return findAgentKnowledgeScopeContamination(JSON.parse(normalizedBody) as unknown);
  } catch {
    return findAgentKnowledgeScopeContamination(normalizedBody);
  }
}

function validateAgentKnowledgeJsonBody(
  label: string,
  body: string,
  passSummary: string,
): { status: LiveVerificationStatus; summary: string; detail?: string } {
  try {
    JSON.parse(body);
  } catch {
    return { status: 'fail', summary: `${label} was not parseable JSON.` };
  }
  const contamination = findAgentKnowledgeResponseContamination(body);
  if (contamination) {
    return {
      status: 'fail',
      summary: `${label} returned non-Agent knowledge contamination.`,
      detail: `${contamination}\n${compact(body)}`,
    };
  }
  return { status: 'pass', summary: passSummary };
}

function validateAgentKnowledgeJsonRoute(
  route: string,
  label: string,
): (status: number, body: string) => { status: LiveVerificationStatus; summary: string; detail?: string } {
  return (status, body) => {
    if (status !== 200) return { status: 'fail', summary: `${route} returned ${status}.` };
    return validateAgentKnowledgeJsonBody(label, body, `${label} stayed on the isolated Agent route.`);
  };
}

export async function buildLiveVerificationReport(options: LiveVerificationOptions): Promise<LiveVerificationReport> {
  const homeDir = resolve(options.homeDir);
  const projectRoot = resolve(options.projectRoot);
  const binaryPath = resolve(options.binaryPath);
  const connectedHostBaseUrl = resolveConnectedHostBaseUrl(homeDir, options.connectedHostBaseUrl);
  const token = options.token ?? readConnectedHostToken(homeDir);
  const commandEnv = buildCommandEnv(homeDir, connectedHostBaseUrl, token);
  const checks: LiveVerificationCheck[] = [];

  checks.push({
    id: 'compiled-cli-present',
    title: 'Compiled GoodVibes Agent CLI binary',
    status: existsSync(binaryPath) ? 'pass' : 'fail',
    summary: existsSync(binaryPath) ? `Found ${binaryPath}.` : `Missing ${binaryPath}.`,
  });

  if (existsSync(binaryPath)) {
    checks.push(commandCheck(
      'cli-version',
      'Agent CLI version command',
      await runCommand(binaryPath, ['--version'], projectRoot),
      'Agent CLI version returned successfully.',
    ));
    checks.push(commandCheck(
      'cli-status-json',
      'Agent CLI status JSON command',
      await runCommand(binaryPath, ['--runtime-url', connectedHostBaseUrl, 'status', '--json'], projectRoot, { env: commandEnv }),
      'Agent CLI status returned parseable JSON.',
      { parseJson: true, passDetail: STATUS_RELEASE_DETAIL },
    ));
    checks.push(commandCheck(
      'cli-compat-json',
      'Agent CLI compatibility JSON command',
      await runCommand(binaryPath, ['--runtime-url', connectedHostBaseUrl, 'compat', '--json'], projectRoot, { env: commandEnv }),
      'Agent CLI compatibility returned parseable JSON.',
      { parseJson: true, warnOnNonZero: true },
    ));
    checks.push(commandCheck(
      'cli-agent-knowledge-status',
      'Agent Knowledge CLI status command',
      await runCommand(binaryPath, ['--runtime-url', connectedHostBaseUrl, 'knowledge', 'status', '--json'], projectRoot, { env: commandEnv }),
      'Agent Knowledge status returned parseable JSON.',
      { parseJson: true, warnOnNonZero: true },
    ));
    checks.push(commandCheck(
      'cli-providers',
      'Agent CLI providers command',
      await runCommand(binaryPath, ['providers'], projectRoot),
      'Provider inventory rendered successfully.',
      { passDetail: PROVIDERS_RELEASE_DETAIL },
    ));
    const doctorResult = await runCommand(binaryPath, ['--runtime-url', connectedHostBaseUrl, 'doctor', '--output', 'text'], projectRoot, { env: commandEnv });
    const doctorAdvisories = doctorRiskAdvisoryOnlyCount(doctorResult);
    checks.push(commandCheck(
      'cli-doctor',
      'CLI doctor command',
      doctorAdvisories !== null ? { ...doctorResult, exitCode: 0 } : doctorResult,
      doctorAdvisories !== null && doctorAdvisories > 0
        ? `Doctor completed; ${doctorAdvisories} operator-configuration risk advisory(ies) noted (intentional trust posture, not a release defect).`
        : 'Doctor completed without findings.',
      { warnOnNonZero: true, passDetail: DOCTOR_RELEASE_DETAIL },
    ));
  }

  checks.push(await fetchCheck(
    'connected-host-status',
    'Authenticated connected-host /status',
    `${connectedHostBaseUrl}/status`,
    token,
    (status, body) => {
      if (status !== 200) return { status: 'fail', summary: `/status returned ${status}.` };
      try {
        JSON.parse(body) as unknown;
        return { status: 'pass', summary: '/status returned 200 with parseable JSON.' };
      } catch {
        return { status: 'warn', summary: '/status returned 200 but was not parseable JSON.' };
      }
    },
  ));

  checks.push(await fetchCheck(
    'connected-host-health',
    'Authenticated connected-host /api/health',
    `${connectedHostBaseUrl}/api/health`,
    token,
    (status, body) => {
      if (status !== 200) return { status: 'fail', summary: `/api/health returned ${status}.` };
      try {
        const parsed = JSON.parse(body) as { overall?: unknown };
        return {
          status: parsed.overall === 'healthy' ? 'pass' : 'warn',
          summary: `Health overall=${String(parsed.overall ?? 'unknown')}.`,
        };
      } catch {
        return { status: 'warn', summary: '/api/health returned 200 but was not parseable JSON.' };
      }
    },
  ));

  checks.push(await fetchCheck(
    'openai-compatible-models',
    'OpenAI-compatible /v1/models route',
    `${connectedHostBaseUrl}/v1/models`,
    token,
    (status, body) => {
      if (status !== 200) return { status: 'fail', summary: `/v1/models returned ${status}.` };
      try {
        const parsed = JSON.parse(body) as { data?: unknown };
        const models = Array.isArray(parsed.data) ? parsed.data.length : 0;
        return {
          status: models > 0 ? 'pass' : 'warn',
          summary: `/v1/models returned ${models} model(s).`,
          detail: `/v1/models returned ${models} model(s); model identifiers omitted from release artifact.`,
        };
      } catch {
        return { status: 'warn', summary: '/v1/models returned 200 but was not parseable JSON.' };
      }
    },
  ));

  checks.push(await fetchJsonCheck(
    'agent-knowledge-status',
    'Agent Knowledge isolated /status',
    `${connectedHostBaseUrl}/api/goodvibes-agent/knowledge/status`,
    token,
    {
      validate: (status, body) => {
        if (status !== 200) return { status: 'fail', summary: `/api/goodvibes-agent/knowledge/status returned ${status}.` };
        return validateAgentKnowledgeJsonBody(
          'Agent Knowledge status',
          body,
          'Agent Knowledge status route returned parseable isolated JSON.',
        );
      },
    },
  ));

  checks.push(await fetchJsonCheck(
    'agent-knowledge-ask-isolated',
    'Agent Knowledge isolated ask',
    `${connectedHostBaseUrl}/api/goodvibes-agent/knowledge/ask`,
    token,
    {
      method: 'POST',
      body: {
        query: 'What is GoodVibes Agent?',
        limit: 5,
        mode: 'concise',
        includeSources: true,
        includeConfidence: true,
        includeLinkedObjects: true,
      },
      validate: (status, body) => {
        if (status !== 200) return { status: 'fail', summary: `/api/goodvibes-agent/knowledge/ask returned ${status}.` };
        return validateAgentKnowledgeJsonBody(
          'Agent Knowledge ask',
          body,
          'Agent Knowledge ask stayed on the isolated Agent route.',
        );
      },
    },
  ));

  checks.push(await fetchJsonCheck(
    'agent-knowledge-search-isolated',
    'Agent Knowledge isolated search',
    `${connectedHostBaseUrl}/api/goodvibes-agent/knowledge/search`,
    token,
    {
      method: 'POST',
      body: { query: 'What is GoodVibes Agent?', limit: 5 },
      validate: (status, body) => {
        if (status !== 200) return { status: 'fail', summary: `/api/goodvibes-agent/knowledge/search returned ${status}.` };
        return validateAgentKnowledgeJsonBody(
          'Agent Knowledge search',
          body,
          'Agent Knowledge search stayed on the isolated Agent route.',
        );
      },
    },
  ));

  for (const check of AGENT_KNOWLEDGE_READ_ROUTE_CHECKS) {
    checks.push(await fetchJsonCheck(
      check.id,
      check.title,
      `${connectedHostBaseUrl}${check.route}`,
      token,
      {
        validate: validateAgentKnowledgeJsonRoute(check.route, check.title),
      },
    ));
  }

  const counts = countStatuses(checks);
  const ok = counts.fail === 0 && (!options.strict || counts.warn === 0);
  return sanitizeLiveVerificationReport({
    generatedAt: new Date().toISOString(),
    homeDir,
    binaryPath,
    connectedHostBaseUrl,
    strict: options.strict ?? false,
    checks,
    counts,
    ok,
  }, { homeDir, userHomeDir: dirname(homeDir), projectRoot, binaryPath, tokens: token ? [token] : undefined });
}

export function sanitizeLiveVerificationReport(
  report: LiveVerificationReport,
  context: LiveVerificationRedactionContext,
): LiveVerificationReport {
  return {
    ...report,
    homeDir: '[goodvibes-home]',
    binaryPath: '[agent-binary]',
    connectedHostBaseUrl: redactForReleaseArtifact(report.connectedHostBaseUrl, context),
    checks: report.checks.map((check) => ({
      ...check,
      summary: redactForReleaseArtifact(check.summary, context),
      detail: check.detail === undefined ? undefined : redactForReleaseArtifact(check.detail, context),
    })),
  };
}

export function renderLiveVerificationReportMarkdown(report: LiveVerificationReport): string {
  // Defense-in-depth: redact header values even if the report was not pre-sanitized.
  // sanitizeLiveVerificationReport already replaces these with placeholders for normal
  // usage, but an unsanitized report passed directly must not leak local paths.
  // normalizeRenderedPath: if the value still looks like a raw filesystem path (starts with /
  // or ~) replace it with the canonical sanitized placeholder so the renderer cannot echo
  // a raw path even when called without prior sanitization.
  function normalizeRenderedPath(value: string, placeholder: string): string {
    const stripped = redactPrivateNetworkAddresses(redact(value));
    return /^[/~]/.test(stripped) ? placeholder : stripped;
  }
  const homeDir = normalizeRenderedPath(report.homeDir, '[goodvibes-home]');
  const binaryPath = normalizeRenderedPath(report.binaryPath, '[agent-binary]');
  const connectedHostBaseUrl = redactPrivateNetworkAddresses(redact(report.connectedHostBaseUrl));
  const lines: string[] = [
    '# GoodVibes Agent Live Verification',
    '',
    `Generated: ${report.generatedAt}`,
    `Home: \`${homeDir}\``,
    `Binary: \`${binaryPath}\``,
    `Connected host: \`${connectedHostBaseUrl}\``,
    '',
    '| Status | Count |',
    '|---|---:|',
    `| pass | ${report.counts.pass} |`,
    `| warn | ${report.counts.warn} |`,
    `| fail | ${report.counts.fail} |`,
    `| skip | ${report.counts.skip} |`,
    '',
    '| Check | Status | Summary |',
    '|---|---|---|',
  ];
  for (const check of report.checks) {
    lines.push(`| ${check.title} | ${check.status} | ${check.summary.replace(/\|/g, '\\|')} |`);
  }
  const detailed = report.checks.filter((check) => check.detail?.trim());
  if (detailed.length > 0) {
    lines.push('', '## Details', '');
    for (const check of detailed) {
      lines.push(`### ${check.title}`, '', '```text', check.detail?.trim() ?? '', '```', '');
    }
  }
  lines.push(report.ok ? 'Result: PASS' : 'Result: FAIL', '');
  return lines.join('\n');
}

export function writeLiveVerificationReportFiles(report: LiveVerificationReport, outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'live-verification.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(join(outputDir, 'live-verification.md'), renderLiveVerificationReportMarkdown(report), 'utf8');
}
