import { CONFIG_SCHEMA, isDeclaredSecretBearingConfigKey, type ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';

const paths = new Set(CONFIG_SCHEMA.flatMap(setting => setting.key.split('.').map((_, i, parts) => parts.slice(0, i + 1).join('.'))));
const fields = new Set([...paths].flatMap(path => path.split('.')));
const gatedSurfaces = ['ntfy', 'telegram', 'slack', 'discord', 'homeassistant', 'google-chat', 'signal', 'whatsapp',
  'telephony', 'imessage', 'msteams', 'bluebubbles', 'mattermost', 'matrix'];
paths.add('conversationGate.gatedSurfaces');
for (const index of gatedSurfaces.keys()) paths.add(`conversationGate.gatedSurfaces.${index}`);
fields.add('gatedSurfaces');
for (const field of ['version', 'type', 'capturedAt', 'package', 'name', 'roots', 'workingDirectory', 'homeDirectory', 'config',
  'redaction', 'sentinel', 'redactedConfigPaths', 'diagnostics', 'service', 'auth', 'providers', 'secrets', 'onboarding',
  'managed', 'endpoints', 'log', 'issues', 'advisories', 'daemonEnabled', 'connectedHostDialEnabled', 'platform', 'path',
  'installed', 'running', 'commandPreview', 'suggestedCommands', 'lastAction', 'pidPath', 'lastError', 'id', 'label', 'binding',
  'bindPosture', 'networkFacing', 'reachable', 'host', 'port', 'exists', 'size', 'modifiedAt', 'tail', 'readError', 'userStorePath',
  'userStorePresent', 'bootstrapCredentialPath', 'bootstrapCredentialPresent', 'operatorTokenPath', 'operatorTokenPresent',
  'provider', 'active', 'configured', 'configuredVia', 'models', 'setup', 'userMarker', 'projectMarker']) fields.add(field);
const safeText = new Set(['USD', 'goodvibes-agent.support', 'goodvibes-alerts', ...gatedSurfaces, ...CONFIG_SCHEMA.map(setting => setting.key)]);
export function bundleRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid synthetic System One request.');
  return value as Record<string, unknown>;
}

function deferred() { return Promise.withResolvers<void>(); }

export function startBundleJudgmentFixture(hold = false, uncertainSetup = false) {
  const calls: Record<string, unknown>[] = [];
  const entered = deferred(), release = deferred();
  const networkFetch = globalThis.fetch;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== '/v1/systemone' || request.method !== 'POST') return new Response('', { status: 404 });
    try {
    const body = bundleRecord(await request.json());
    calls.push(body);
    entered.resolve();
    if (hold) await release.promise;
    const state = bundleRecord(body.state);
    const answers = Object.fromEntries(Object.entries(bundleRecord(body.questions)).map(([name, value]) => {
      const question = bundleRecord(value);
      if (name === 'credential') {
        const key = typeof state.key === 'string' ? state.key : '';
        return [name, { type: 'noul', noul: isDeclaredSecretBearingConfigKey(key) ? 0.99 : paths.has(key) ? 0.01 : 0.5 }];
      }
      if (name === 'kind') {
        const field = typeof state.field === 'string' ? state.field : '';
        const criteria = bundleRecord(question.criteria);
        return [name, { type: 'choice', choice: 'other', confidence: fields.has(field) ? 0.99 : 0.5,
          probabilities: Object.fromEntries(Object.keys(criteria).map(option => [option, option === 'other' ? 1 : 0])) }];
      }
      if (name === 'identifying') {
        return [name, { type: 'noul', noul: state.field === 'commerce.currency' && state.sourceKind === 'field' ? 0.01 : 0.5 }];
      }
      if (name === 'lineHasCredential' || name === 'spanIsCredential' || name === 'credentialRemains') {
        const parts = Array.isArray(state.parts) ? state.parts.map(bundleRecord) : [];
        const text = parts.map(part => typeof part.text === 'string' ? part.text : '').join('');
        return [name, { type: 'noul', noul: safeText.has(text) ? 0.01 : 0.5 }];
      }
      if (uncertainSetup && (name === 'family' || name === 'route') && question.type === 'choice') {
        const choices = Object.keys(bundleRecord(question.criteria)), choice = choices[0];
        if (!choice) throw new Error('Invalid setup fixture question.');
        return [name, { type: 'choice', choice, confidence: 0.5,
          probabilities: Object.fromEntries(choices.map(option => [option, 1 / choices.length])) }];
      }
      throw new Error('Unexpected synthetic bundle question.');
    }));
    return Response.json({ model: body.model, answers, usage: { input_tokens: 1, output_tokens: 1 } });
    } catch { return Response.json({ error: 'Invalid synthetic bundle reading.' }, { status: 400 }); }
  } });
  const url = `http://127.0.0.1:${server.port}`;
  return { calls, entered, release, url,
    questionCounts() {
      const counts: Record<string, number> = Object.create(null);
      for (const call of calls) for (const name of Object.keys(bundleRecord(call.questions))) {
        counts[name] = (counts[name] ?? 0) + 1;
      }
      return counts;
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      const previousFetch = globalThis.fetch;
      globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = new Request(input, init);
        return request.url === `${url}/v1/systemone` && request.method === 'POST'
          ? networkFetch(request) : previousFetch(input, init);
      }, { preconnect: previousFetch.preconnect });
      try { return await fn(); } finally { globalThis.fetch = previousFetch; }
    },
    close() { release.resolve(); server.stop(true); } };
}

export async function withBundleJudgmentFixture<T>(config: ConfigManager, run: (withBackend: <U>(fn: () => Promise<U>) => Promise<U>) => Promise<T>): Promise<T> {
  const backend = startBundleJudgmentFixture();
  const key = process.env.TYPESAFE_API_KEY;
  const endpoint = config.get('judgment.endpoint'), keySource = config.get('judgment.keySource');
  config.setDynamic('judgment.endpoint', backend.url); config.setDynamic('judgment.keySource', 'env');
  process.env.TYPESAFE_API_KEY = 'synthetic-bundle-transport-key';
  try { return await backend.run(() => run(backend.run)); }
  finally {
    backend.close();
    config.setDynamic('judgment.endpoint', endpoint); config.setDynamic('judgment.keySource', keySource);
    if (key === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = key;
  }
}

