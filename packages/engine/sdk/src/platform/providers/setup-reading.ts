/** Presentation only. This battery never grants routing, credential or payment authority. */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

const context = 'Read only the declared runtime facts for this provider instance. The id is an identity, not evidence of hosting or payment. Auth route names are exact runtime grammar, but an available route need not be the active payment path. Do not infer free access from anonymous auth, readiness, a model list, zero prices, or a local proxy address. Contradictory or insufficient facts cannot support a class. ';
const question = (text: string) => yesNo(context + text, STAKES_BANDS.medium.yesNo);

export const providerSetupReading = defineBattery({
  name: 'providers.setup-presentation',
  version: 1,
  description: 'The mutually exclusive setup/payment class supported by this provider instance’s declared runtime facts, for presentation only.',
  accuracyFloor: 0.9,
  items: {
    api_key: question('Is this a direct provider API accessed with a provider API key or equivalent secret, rather than a cloud account, subscription, operator-managed gateway or local model runtime?'),
    cloud_account: question('Does this instance require a cloud account’s credentials, account-scoped resource key, profile or workload identity? Such a key is cloud-account setup even when auth.mode says api-key or anonymous.'),
    local_runtime: question('Do the facts establish that the models themselves execute locally without a paid provider API key, rather than merely a locally reached proxy/gateway or multi-backend router?'),
    no_key_free: question('Do the facts explicitly establish free hosted model access without a paid API key, subscription or cloud account, distinct from locally executing models and operator-managed gateways?'),
    self_hosted: question('Is this an operator-managed gateway or self-hosted serving endpoint, whose upstream billing cannot be inferred from its local address or optional API-key protection, rather than a direct local model runtime?'),
    subscription: question('Does this instance use a stored subscription/OAuth session or a paid plan/seat for access instead of a raw provider API key? Service OAuth or an unconfigured optional subscription route alone is not proof.'),
  },
  fixtures: [
    { name: 'unlisted gateway', state: { provider: { id: 'lab-next', setup: { description: 'Operator-managed gateway forwards to independently billed upstream providers.', endpointOrigin: 'http://127.0.0.1:9300' }, auth: { mode: 'anonymous', configured: true } } }, expect: { api_key: 'no', cloud_account: 'no', local_runtime: 'no', no_key_free: 'no', self_hosted: 'yes', subscription: 'no' } },
    { name: 'new cloud account', state: { provider: { id: 'new-cloud', setup: { description: 'Uses the cloud account resource key or workload identity; the account pays usage.' }, auth: { mode: 'api-key', configured: true } } }, expect: { api_key: 'no', cloud_account: 'yes', local_runtime: 'no', no_key_free: 'no', self_hosted: 'no', subscription: 'no' } },
    { name: 'local model runtime', state: { provider: { id: 'lab-desktop', setup: { description: 'Runs downloaded models on this machine without provider billing.' }, auth: { mode: 'anonymous', configured: true } } }, expect: { api_key: 'no', cloud_account: 'no', local_runtime: 'yes', no_key_free: 'no', self_hosted: 'no', subscription: 'no' } },
    { name: 'explicit free service', state: { provider: { id: 'public-demo', setup: { description: 'Free hosted inference without a key, account or subscription.' }, auth: { mode: 'none', configured: true } } }, expect: { api_key: 'no', cloud_account: 'no', local_runtime: 'no', no_key_free: 'yes', self_hosted: 'no', subscription: 'no' } },
    { name: 'subscription session', state: { provider: { id: 'plan-adapter', auth: { mode: 'oauth', configured: true, detail: 'Uses a stored paid subscription session instead of a provider API key.' } } }, expect: { api_key: 'no', cloud_account: 'no', local_runtime: 'no', no_key_free: 'no', self_hosted: 'no', subscription: 'yes' } },
    { name: 'direct api key', state: { provider: { id: 'direct-api', auth: { mode: 'api-key', configured: false, detail: 'Requires the direct provider API key.' } } }, expect: { api_key: 'yes', cloud_account: 'no', local_runtime: 'no', no_key_free: 'no', self_hosted: 'no', subscription: 'no' } },
    { name: 'anonymous does not prove free', state: { provider: { id: 'unknown', auth: { mode: 'anonymous', configured: true }, modelCount: 8 } }, expect: { api_key: 'no', cloud_account: 'no', local_runtime: 'no', no_key_free: 'no', self_hosted: 'no', subscription: 'no' } },
    { name: 'contradictory setup', state: { provider: { id: 'mixed', setup: { description: 'This endpoint is exclusively a free hosted service and exclusively a billed cloud-account resource; neither declaration is authoritative.' } } }, expect: { api_key: 'no', cloud_account: 'no', local_runtime: 'no', no_key_free: 'no', self_hosted: 'no', subscription: 'no' } },
  ],
});
