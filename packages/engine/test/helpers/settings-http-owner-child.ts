/** Engine-owned SETTINGS host. Products reach private owners only over real HTTP. */
import { join } from 'node:path';
import { ConfigManager } from '../../sdk/src/platform/config/manager.js';
import { PairingTokenManager } from '../../sdk/src/platform/pairing/pairing-token-store.js';
import { UserAuthManager } from '../../sdk/src/platform/security/user-auth.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../../sdk/src/platform/daemon/control-plane.js';
import { DaemonHttpRouter } from '../../sdk/src/platform/daemon/http/router.js';

const root = process.argv[2];
if (!root) throw new Error('Settings fixture requires its owned temporary root');
const loseResponse = process.argv[3] === 'lost-response';
const token = 'synthetic-agent-settings-operator';
const config = new ConfigManager({ configDir: join(root, 'remote-config'), daemonTierPath: join(root, 'remote-settings.json') });
const pairing = new PairingTokenManager(join(root, 'remote-pairing.json'));
const users = new UserAuthManager({ users: [{ username: 'fixture-admin', passwordHash: 'synthetic-unused', roles: ['admin'] }],
  bootstrapFilePath: join(root, 'unused-users.json'), bootstrapCredentialPath: join(root, 'unused-bootstrap.txt') });
const lifetime = {};
const helper = new DaemonControlPlaneHelper({ authToken: () => token, pairingTokens: pairing, userAuth: users,
  settingsLifetime: () => lifetime } as unknown as DaemonControlPlaneContext);
const router = new DaemonHttpRouter({ configManager: config, runtimeStore: null, userAuth: users,
  authToken: () => token, requireAdmin: (req: Request) => helper.requireAdmin(req), requireAuthenticatedSession: () => null,
  extractAuthToken: () => token, describeAuthenticatedPrincipal: () => null, controlPlaneGateway: { recordApiRequest() {} },
  secretsManager: null, swapManager: null,
  settingsAuthority: { settingsLifetime: () => lifetime,
    captureSettingsAdminAuthority: (req: Request) => helper.captureSettingsAdminAuthority(req),
    withSettingsAdminAuthority: helper.withSettingsAdminAuthority.bind(helper) },
} as never);
let captures = 0; let applies = 0;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (new URL(request.url).pathname !== '/config') return new Response(null, { status: 404 });
  if (request.method === 'GET') return Response.json({}); // Discovery only.
  const body = await request.clone().json();
  if (body.settingsPrecondition?.action === 'capture') captures++;
  else if (body.settingsPrecondition?.action === 'apply') applies++;
  else return new Response(null, { status: 400 }); // Never a fixture legacy fallback.
  const response = await router.dispatchApiRoutes(request);
  if (!response) throw new Error('Missing settings fixture route');
  if (loseResponse && body.settingsPrecondition.action === 'apply') {
    // The real effect completed. Close the owned socket before delivering its ack.
    void server.stop(true);
    return new Response(null, { status: 503 });
  }
  return response;
} });
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
emit({ kind: 'ready', baseUrl: `http://127.0.0.1:${server.port}`, token, pid: process.pid,
  settingsPath: config.getDaemonTierPath(), defaultPort: config.get('controlPlane.port') });
let stopped = false;
let lastCommand = 0;
try {
  const decoder = new TextDecoder(); let buffer = '';
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 4096) throw new Error('Oversized settings fixture control');
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      const message: unknown = JSON.parse(line);
      if (!message || typeof message !== 'object' || !('type' in message) || !('id' in message)
        || typeof message.id !== 'number' || !Number.isSafeInteger(message.id) || message.id !== lastCommand + 1 || message.id > 100) throw new Error('Invalid settings fixture control');
      lastCommand = message.id;
      if (message.type === 'set' && Object.keys(message).sort().join(',') === 'id,key,type,value' && 'key' in message && 'value' in message) {
        if (message.key === 'controlPlane.port' && typeof message.value === 'number') config.set(message.key, message.value);
        else if (message.key === 'email.passwordRef' && typeof message.value === 'string' && message.value.length <= 200) config.set(message.key, message.value);
        else throw new Error('Unsupported settings fixture key');
        emit({ kind: 'configured', id: message.id });
      } else if (Object.keys(message).length !== 2) throw new Error('Invalid settings fixture control fields');
      else if (message.type === 'revoke') { pairing.revokeLegacyShared(); emit({ kind: 'revoked', id: message.id }); }
      else if (message.type === 'inspect') emit({ kind: 'inspection', id: message.id, captures, applies });
      else if (message.type === 'stop') { stopped = true; break; }
      else throw new Error('Unknown settings fixture control');
    }
    if (stopped) break;
  }
} catch {
  // Never send exception prose, requests, credentials or store values to diagnostics.
  emit({ kind: 'failure', stage: 'command' });
  throw new Error('Settings fixture control failed');
} finally { await server.stop(true); router.dispose(); }
